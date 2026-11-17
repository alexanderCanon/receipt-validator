import { Hono } from 'hono';
import type { Bindings } from './types';
import { MAX_FILE_BYTES, detectImageMime, extensionForMime, hexSha256 } from './file-validation';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ status: 'ok', phase: 'storage-and-exact-duplicates' }));

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

app.post('/api/receipts', async (c) => {
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

  return c.json({ id, status: 'PENDING_ANALYSIS', message: 'Comprobante recibido y almacenado; todavía no ha sido validado.' }, 201);
});

app.get('/api/receipts/:id', async (c) => {
  // Deliberadamente no hay consulta pública por ID: el identificador no autentica al titular.
  return c.json({ message: 'La consulta se habilitará con autenticación en la siguiente fase.' }, 501);
});

app.onError((err, c) => {
  console.error('Unhandled error', err);
  return c.json({ status: 'ERROR', reason: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' }, 500);
});

export default app;
