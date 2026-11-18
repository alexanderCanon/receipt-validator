import { Hono } from 'hono';
import type { Bindings } from './types';
import { MAX_FILE_BYTES, detectImageMime, extensionForMime, hexSha256 } from './file-validation';
import { extractReceipt } from './extraction';
import { sameOrigin, sessionActive, login, logout, expiredCookie } from './auth';
import { validAdminBearer, validAdminCookie } from './admin-auth';
import admin from './admin-review';
import { verifyDestinationAccount } from './accounts';
import { decideReceipt, guatemalaToday, normalizeClaim } from './validation';
import type { Decision, ExtractedReceipt } from './validation';

const app = new Hono<{ Bindings: Bindings }>();

app.route('/api/admin',admin);

app.get('/api/health', (c) => c.json({ status: 'ok', phase: 'ai-document-validation' }));

async function verifyTurnstile(
  token: string | undefined,
  env: Bindings,
  requestUrl: string,
  ip: string | undefined,
): Promise<boolean> {
  const url = new URL(requestUrl);
  if (env.DEV_BYPASS_TURNSTILE === 'true' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(7000),
    });
    const result = await response.json<{ success: boolean }>();
    return response.ok && result.success === true;
  } catch {
    return false;
  }
}

app.post('/api/auth/login', async (c) => {
  if (!sameOrigin(c.req.raw)) return c.json({ message: 'Origen no autorizado.' }, 403);
  const body = await c.req.json<{ pin?: unknown }>().catch(() => null);
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const result = await login(body?.pin, ip, c.env);
  if (!result.ok) {
    const messages: Record<number, string> = {
      400: 'El código debe contener 6 dígitos.',
      401: 'Código de acceso incorrecto.',
      429: 'Demasiados intentos. Prueba en 15 minutos.',
      503: 'El acceso aún no está configurado.',
    };
    return c.json({ message: messages[result.status] }, result.status);
  }
  c.header('Set-Cookie', result.cookie);
  c.header('Cache-Control', 'no-store');
  return c.json({ authenticated: true });
});
app.get('/api/auth/session', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ authenticated: await sessionActive(c.req.raw, c.env.DB) });
});
app.post('/api/auth/logout', async (c) => {
  if (!sameOrigin(c.req.raw)) return c.json({ message: 'Origen no autorizado.' }, 403);
  await logout(c.req.raw, c.env.DB);
  c.header('Set-Cookie', expiredCookie());
  return c.json({ authenticated: false });
});

app.post('/api/receipts', async (c) => {
  // Authentication is enforced server-side BEFORE upload, R2, D1, and Workers AI.
  if (!sameOrigin(c.req.raw)) return c.json({ message: 'Origen no autorizado.' }, 403);
  if (!await sessionActive(c.req.raw, c.env.DB)) {
    return c.json({ reason: 'AUTH_REQUIRED', message: 'Ingresa tu código para validar comprobantes.' }, 401);
  }

  const declaredLength = Number(c.req.header('content-length') || 0);
  if (declaredLength > MAX_FILE_BYTES + 100_000) {
    return c.json({ status: 'REJECTED', reason: 'FILE_TOO_LARGE', message: 'Máximo 5 MB por imagen.' }, 413);
  }
  if (!(c.req.header('content-type') || '').startsWith('multipart/form-data')) {
    return c.json({ status: 'REJECTED', reason: 'INVALID_REQUEST', message: 'Se requiere multipart/form-data.' }, 415);
  }

  // La protección antifraude/antibots ocurre ANTES de leer, almacenar o procesar la imagen.
  let form: FormData;
  try { form = await c.req.raw.formData(); }
  catch { return c.json({ status: 'REJECTED', reason: 'INVALID_FORM', message: 'Formulario inválido.' }, 400); }

  const token = form.get('cf-turnstile-response');
  const authorized = await verifyTurnstile(
    typeof token === 'string' ? token : undefined,
    c.env,
    c.req.url,
    c.req.header('cf-connecting-ip'),
  );
  if (!authorized) return c.json({ status: 'REJECTED', reason: 'TURNSTILE_REQUIRED', message: 'Verificación de seguridad no superada.' }, 403);

  const file = form.get('receipt');
  if (!(file instanceof File)) return c.json({ status: 'REJECTED', reason: 'MISSING_FILE', message: 'Adjunta una imagen.' }, 400);
  if (file.size === 0 || file.size > MAX_FILE_BYTES) return c.json({ status: 'REJECTED', reason: 'INVALID_SIZE', message: 'La imagen debe pesar entre 1 byte y 5 MB.' }, 413);
  const fileData = await file.arrayBuffer();
  const bytes = new Uint8Array(fileData);
  const mime = detectImageMime(bytes);
  if (!mime) return c.json({ status: 'REJECTED', reason: 'UNSUPPORTED_FILE', message: 'Solo se admiten JPEG, PNG o WebP válidos.' }, 415);

  const sha256 = hexSha256(await crypto.subtle.digest('SHA-256', fileData));
  const existing = await c.env.DB.prepare('SELECT id, status FROM receipts WHERE sha256 = ?')
    .bind(sha256).first<{ id: string; status: string }>();
  if (existing) return c.json({
    status: 'REJECTED', reason: 'DUPLICATE_FILE',
    message: 'Este archivo ya fue subido anteriormente.',
  }, 409);

  const id = crypto.randomUUID();
  const today = new Date();
  const folder = `${today.getUTCFullYear()}/${String(today.getUTCMonth() + 1).padStart(2, '0')}/${String(today.getUTCDate()).padStart(2, '0')}`;
  const key = `receipts/${folder}/${id}.${extensionForMime(mime)}`;
  await c.env.RECEIPTS.put(key, fileData, { httpMetadata: { contentType: mime } });

  try {
    await c.env.DB.prepare(`INSERT INTO receipts
      (id, r2_key, sha256, mime_type, size_bytes, original_filename, status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING_ANALYSIS')`)
      .bind(id, key, sha256, mime, file.size, file.name.slice(0, 160)).run();
  } catch (err) {
    await c.env.RECEIPTS.delete(key).catch(() => {});
    const race = await c.env.DB.prepare('SELECT id FROM receipts WHERE sha256 = ?').bind(sha256).first();
    if (race) return c.json({ status: 'REJECTED', reason: 'DUPLICATE_FILE', message: 'Este archivo ya fue subido anteriormente.' }, 409);
    console.error('Persist error', err);
    return c.json({ status: 'ERROR', reason: 'STORAGE_FAILURE', message: 'No fue posible registrar el comprobante.' }, 500);
  }

  let extracted: ExtractedReceipt | null = null;
  let decision: Decision;
  try {
    extracted = await extractReceipt(c.env, bytes, mime);
    decision = decideReceipt(extracted, guatemalaToday(new Date()));
    decision = await verifyDestinationAccount(c.env.DB, extracted, decision);
  } catch (error) {
    console.error('AI extraction failed', error instanceof Error ? error.message : 'unknown');
    decision = { status: 'REVIEW_REQUIRED', reason: 'AI_EXTRACTION_FAILED' };
  }

  const claim = extracted && decision.status !== 'REJECTED' ? normalizeClaim(extracted) : null;
  const persist = (d: Decision) => c.env.DB.prepare(`UPDATE receipts SET
    status = ?, reason = ?, extracted_json = ?, anomalies_json = ?, processed_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(d.status, d.reason,
      extracted ? JSON.stringify(extracted) : null,
      extracted ? JSON.stringify(extracted.anomalies) : null, id);
  try {
    if (claim) {
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO receipt_claims (claim_key, receipt_id) VALUES (?, ?)').bind(claim, id),
        persist(decision),
      ]);
    } else {
      await persist(decision).run();
    }
  } catch (error) {
    if (claim) {
      const existingClaim = await c.env.DB.prepare('SELECT receipt_id FROM receipt_claims WHERE claim_key = ?')
        .bind(claim).first();
      if (existingClaim) {
        decision = { status: 'REJECTED', reason: 'DUPLICATE_RECEIPT' };
        await persist(decision).run();
      } else {
        console.error('Claim transaction failed', error);
        return c.json({ id, status: 'ERROR', reason: 'PERSISTENCE_FAILED', message: 'No se pudo finalizar la validación.' }, 500);
      }
    } else {
      console.error('Validation persist failed', error);
      return c.json({ id, status: 'ERROR', reason: 'PERSISTENCE_FAILED', message: 'No se pudo finalizar la validación.' }, 500);
    }
  }

  const messages: Record<string, string> = {
    DOCUMENT_CHECKS_PASSED: 'El comprobante superó las verificaciones documentales. No confirma la recepción bancaria.',
    CHECK_DEPOSIT: 'No se aceptan depósitos por cheque.',
    EXPIRED_RECEIPT: 'El comprobante tiene más de dos días de antigüedad.',
    DUPLICATE_RECEIPT: 'Este comprobante ya fue utilizado o está pendiente de revisión.',
    DESTINATION_ACCOUNT_UNREADABLE: 'No se pudo verificar el número completo de cuenta destino. Requiere revisión.',
    DESTINATION_ACCOUNT_NOT_ALLOWED: 'La cuenta destino no está autorizada para recibir depósitos.',
    NO_ALLOWED_ACCOUNTS_CONFIGURED: 'Aún no hay cuentas destino autorizadas configuradas. Requiere revisión.',
    POSSIBLE_TAMPERING: 'El comprobante requiere revisión por posibles anomalías.',
    UNREADABLE_DATE: 'La fecha no se pudo verificar. Se requiere revisión.',
    FUTURE_DATE: 'La fecha del comprobante es futura. Se requiere revisión.',
    MISSING_REQUIRED_FIELDS: 'Faltan campos obligatorios. Se requiere revisión.',
    UNKNOWN_OPERATION: 'No fue posible clasificar la operación. Se requiere revisión.',
    AI_EXTRACTION_FAILED: 'No fue posible analizar el comprobante automáticamente. Se requiere revisión.',
    AI_OUTPUT_UNVERIFIED: 'La extracción automática requiere confirmación manual.',
  };
  const httpStatus = decision.status === 'APPROVED' ? 201 : decision.status === 'REJECTED' ? 422 : 202;
  return c.json({ id, status: decision.status, reason: decision.reason,
    message: messages[decision.reason] ?? 'Comprobante procesado.',
    receipt: extracted ? {
      bank: extracted.bank, operationType: extracted.operationType, reference: extracted.reference,
      amount: extracted.amount, currency: extracted.currency, transactionDate: extracted.transactionDate,
      destinationAccount: extracted.destinationAccount, recipientName: extracted.recipientName,
    } : null,
  }, httpStatus);
});

app.get('/api/receipts/:id', async (c) => {
  // Deliberadamente no hay consulta pública por ID: el identificador no autentica al titular.
  return c.json({ message: 'La consulta se habilitará con autenticación en la siguiente fase.' }, 501);
});


app.post('/api/admin/receipts/:id/reprocess', async (c) => {
  if (!await validAdminBearer(c.req.raw,c.env) &&
      !(sameOrigin(c.req.raw) && await validAdminCookie(c.req.raw,c.env))) {
    return c.json({ message: 'No autorizado.' }, 401);
  }
  const id = c.req.param('id');
  if (!/^[a-f0-9-]{36}$/i.test(id)) return c.json({ message: 'ID inválido.' }, 400);
  const row = await c.env.DB.prepare(`SELECT id, r2_key, mime_type, status, reason, retry_count
    FROM receipts WHERE id = ?`).bind(id).first<{
      id: string; r2_key: string; mime_type: string; status: string; reason: string | null; retry_count: number
    }>();
  if (!row) return c.json({ message: 'No existe el comprobante.' }, 404);
  if (row.status !== 'REVIEW_REQUIRED' ||
      !['AI_EXTRACTION_FAILED', 'AI_OUTPUT_UNVERIFIED'].includes(row.reason ?? '')) {
    return c.json({ message: 'El comprobante no es elegible para reprocesamiento.' }, 409);
  }
  if (row.retry_count >= 2) return c.json({ message: 'Límite de reprocesamientos alcanzado.' }, 429);
  const lock = await c.env.DB.prepare(`UPDATE receipts SET retry_count = retry_count + 1, status = 'PROCESSING'
    WHERE id = ? AND status = 'REVIEW_REQUIRED'
    AND reason IN ('AI_EXTRACTION_FAILED', 'AI_OUTPUT_UNVERIFIED') AND retry_count < 2`)
    .bind(id).run();
  if (lock.meta.changes !== 1) return c.json({ message: 'Solicitud ya está en proceso.' }, 409);
  let extracted: ExtractedReceipt | null = null;
  let decision: Decision = { status: 'REVIEW_REQUIRED', reason: 'AI_EXTRACTION_FAILED' };
  try {
    const obj = await c.env.RECEIPTS.get(row.r2_key);
    if (!obj) throw new Error('R2 original not found');
    const bytes = new Uint8Array(await obj.arrayBuffer());
    extracted = await extractReceipt(c.env, bytes, row.mime_type);
    decision = decideReceipt(extracted, guatemalaToday(new Date()));
    decision = await verifyDestinationAccount(c.env.DB, extracted, decision);
  } catch (err) {
    console.error('AI reprocess failed', err instanceof Error ? err.message : 'unknown');
  }
  const persist = (status: Decision) => c.env.DB.prepare(`UPDATE receipts SET
    status = ?, reason = ?, extracted_json = ?, anomalies_json = ?, processed_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(status.status, status.reason,
      extracted ? JSON.stringify(extracted) : null,
      extracted ? JSON.stringify(extracted.anomalies) : null, id);
  const claim = extracted && decision.status !== 'REJECTED' ? normalizeClaim(extracted) : null;
  try {
    if (claim) {
      const existing = await c.env.DB.prepare('SELECT receipt_id FROM receipt_claims WHERE claim_key = ?')
        .bind(claim).first<{receipt_id:string}>();
      if (existing?.receipt_id === id) {
        // Reprocessing the original receipt must not reject its own reserved reference.
        await persist(decision).run();
      } else if (existing) {
        decision = { status: 'REJECTED', reason: 'DUPLICATE_RECEIPT' };
        await persist(decision).run();
      } else {
        try {
          await c.env.DB.batch([
            c.env.DB.prepare('INSERT INTO receipt_claims (claim_key, receipt_id) VALUES (?, ?)').bind(claim,id),
            persist(decision),
          ]);
        } catch {
          const owner = await c.env.DB.prepare('SELECT receipt_id FROM receipt_claims WHERE claim_key = ?')
            .bind(claim).first<{receipt_id:string}>();
          if (owner?.receipt_id === id) {
            await persist(decision).run();
          } else if (owner) {
            decision = { status: 'REJECTED', reason: 'DUPLICATE_RECEIPT' };
            await persist(decision).run();
          } else {
            throw new Error('Failed to persist receipt claim');
          }
        }
      }
    } else {
      await persist(decision).run();
    }
  } catch (err) {
    console.error('AI reprocess persist failed', err instanceof Error ? err.message : 'unknown');
    await c.env.DB.prepare(`UPDATE receipts SET status = 'REVIEW_REQUIRED', reason = 'AI_EXTRACTION_FAILED'
      WHERE id = ? AND status = 'PROCESSING'`).bind(id).run();
    return c.json({ message: 'Error al persistir el resultado.' }, 500);
  }
  return c.json({ id, status: decision.status, reason: decision.reason,
    message: 'Reprocesamiento finalizado.', receipt: extracted ? {
      bank: extracted.bank, reference: extracted.reference, amount: extracted.amount,
      operationType: extracted.operationType, transactionDate: extracted.transactionDate,
      destinationAccount: extracted.destinationAccount, recipientName: extracted.recipientName,
    } : null,
  });
});

app.onError((err, c) => {
  console.error('Unhandled error', err);
  return c.json({ status: 'ERROR', reason: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' }, 500);
});

export default app;
