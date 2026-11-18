import { Hono } from 'hono';
import type { Bindings } from './types';
import type { ExtractedReceipt } from './validation';
import { decideReceipt, guatemalaToday, normalizeClaim } from './validation';
import { verifyDestinationAccount, normalizeAccount } from './accounts';
import { sameOrigin } from './auth';
import { clearAdminCookie, createAdminCookie, validAdminBearer, validAdminCookie, validAdminToken } from './admin-auth';

const admin = new Hono<{ Bindings: Bindings }>();
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const statusFilter = new Set(['APPROVED','REJECTED','REVIEW_REQUIRED','PROCESSING','PENDING_ANALYSIS']);
const reviewFields = ['bank','reference','amount','currency','transactionDate','transactionTime',
  'operationType','destinationAccount','recipientName','senderName'] as const;

type StoredReceipt = { id:string; status:string; reason:string|null; r2_key:string; mime_type:string;
  extracted_json:string|null; created_at:string; processed_at:string|null; retry_count:number };

admin.use('*', async (c, next) => {
  c.header('Cache-Control','no-store');
  c.header('X-Content-Type-Options','nosniff');
  await next();
});
admin.post('/login', async (c) => {
  if (!sameOrigin(c.req.raw)) return c.json({message:'Origen inválido'},403);
  const body = await c.req.json().catch(()=>null);
  const credential = body && typeof body === 'object' && 'token' in body ? body.token : null;
  if (typeof credential !== 'string' || !await validAdminToken(credential,c.env)) {
    return c.json({message:'Credencial administrativa inválida'},401);
  }
  c.header('Set-Cookie',await createAdminCookie(c.env));
  return c.json({authenticated:true});
});
admin.post('/logout', async (c)=>{
  if (!sameOrigin(c.req.raw)) return c.json({message:'Origen inválido'},403);
  c.header('Set-Cookie',clearAdminCookie());
  return c.json({authenticated:false});
});
admin.get('/session', async (c) => c.json({authenticated:await validAdminCookie(c.req.raw,c.env)}));

admin.use('/receipts/*', async (c,next)=>{
  if (!await validAdminCookie(c.req.raw,c.env) && !await validAdminBearer(c.req.raw,c.env)) {
    return c.json({message:'Acceso administrativo requerido'},401);
  }
  await next();
});
admin.use('/receipts', async (c,next)=>{
  if (!await validAdminCookie(c.req.raw,c.env) && !await validAdminBearer(c.req.raw,c.env)) {
    return c.json({message:'Acceso administrativo requerido'},401);
  }
  await next();
});

admin.get('/receipts', async (c)=>{
  const status = c.req.query('status') || 'REVIEW_REQUIRED';
  if (status !== 'ALL' && !statusFilter.has(status)) return c.json({message:'Estado inválido'},400);
  const limit = 30;
  const cursor = c.req.query('before') || '';
  // Fixed-size cursor: timestamp plus UUID (no arbitrary SQL).
  const hasCursor = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\|[a-f0-9-]{36}$/i.test(cursor);
  if (cursor && !hasCursor) return c.json({message:'Cursor inválido'},400);
  const [beforeDate,beforeId] = hasCursor ? cursor.split('|') : ['', ''];
  const clause = status === 'ALL' ? '' : 'AND status = ?';
  const sql = `SELECT id,status,reason,mime_type,created_at,processed_at,retry_count,
    json_extract(extracted_json,'$.bank') AS bank,
    json_extract(extracted_json,'$.amount') AS amount,
    json_extract(extracted_json,'$.currency') AS currency,
    json_extract(extracted_json,'$.reference') AS reference
    FROM receipts WHERE 1=1 ${clause}
    AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC,id DESC LIMIT ?`;
  const params: (string | number)[] = [];
  if (status !== 'ALL') params.push(status);
  params.push(beforeDate,beforeDate,beforeDate,beforeId,limit+1);
  const result = await c.env.DB.prepare(sql).bind(...params).all();
  const rows = result.results.slice(0,limit) as Array<Record<string,unknown>>;
  const last = rows.at(-1);
  return c.json({items:rows,nextCursor:result.results.length>limit && last ?
    `${last.created_at}|${last.id}` : null});
});

admin.get('/receipts/:id', async (c)=>{
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({message:'ID inválido'},400);
  const result = await c.env.DB.prepare(`SELECT id,status,reason,mime_type,created_at,
     processed_at,retry_count,original_filename,extracted_json,anomalies_json
     FROM receipts WHERE id=?`).bind(id).first();
  if (!result) return c.json({message:'No encontrado'},404);
  const reviews = await c.env.DB.prepare(`SELECT id,action,previous_status,previous_reason,note,created_at
    FROM receipt_reviews WHERE receipt_id=? ORDER BY created_at DESC`).bind(id).all();
  return c.json({receipt:{...result,
    extracted:result.extracted_json ? JSON.parse(String(result.extracted_json)) : null,
    extracted_json:undefined, anomalies_json:undefined},reviews:reviews.results});
});

admin.get('/receipts/:id/image', async (c)=>{
  const id=c.req.param('id');
  if (!UUID.test(id)) return c.json({message:'ID inválido'},400);
  const row = await c.env.DB.prepare('SELECT r2_key,mime_type FROM receipts WHERE id=?')
    .bind(id).first<{r2_key:string;mime_type:string}>();
  if (!row) return c.json({message:'No encontrado'},404);
  if (!['image/jpeg','image/png','image/webp'].includes(row.mime_type)) return c.json({message:'Formato no permitido'},415);
  const image = await c.env.RECEIPTS.get(row.r2_key);
  if (!image) return c.json({message:'Archivo no disponible'},404);
  return new Response(image.body, {headers:{
    'Content-Type':row.mime_type,
    'Content-Disposition':'inline; filename="receipt"',
    'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; sandbox",
  }});
});

admin.post('/receipts/:id/review', async (c)=>{
  if (!sameOrigin(c.req.raw)) return c.json({message:'Origen inválido'},403);
  const id=c.req.param('id');
  if (!UUID.test(id)) return c.json({message:'ID inválido'},400);
  const body: unknown=await c.req.json().catch(()=>null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({message:'Solicitud inválida'},400);
  const data=body as Record<string,unknown>;
  if (data.action!=='APPROVED' && data.action!=='REJECTED') return c.json({message:'Decisión inválida'},400);
  if (typeof data.note!=='string' || data.note.trim().length<5 || data.note.length>1000)
    return c.json({message:'Ingresa una justificación de 5 a 1000 caracteres'},400);
  const row = await c.env.DB.prepare(`SELECT id,status,reason,r2_key,mime_type,extracted_json,created_at,processed_at,retry_count
    FROM receipts WHERE id=?`).bind(id).first<StoredReceipt>();
  if (!row) return c.json({message:'No encontrado'},404);
  if (row.status!=='REVIEW_REQUIRED') return c.json({message:'Solo se pueden resolver casos pendientes de revisión'},409);
  const reviewId=crypto.randomUUID();
  let extraction: ExtractedReceipt|null = null;
  let claim:string|null=null;
  if (data.action==='APPROVED') {
    if (!data.fields || typeof data.fields!=='object' || Array.isArray(data.fields)) return c.json({message:'Campos requeridos'},400);
    const fields=data.fields as Record<string,unknown>;
    if (Object.keys(fields).some(k=>!reviewFields.includes(k as typeof reviewFields[number]))) return c.json({message:'Campo no permitido'},400);
    if (!row.extracted_json) return c.json({message:'Se requiere extracción previa para aprobar'},422);
    const original=JSON.parse(row.extracted_json) as ExtractedReceipt;
    const next={...original};
    for (const key of reviewFields) {
      if (!(key in fields)) continue;
      const value=fields[key];
      if (key==='amount') {
        if (typeof value!=='number'||!Number.isFinite(value)||value<=0) return c.json({message:'Monto inválido'},400);
        next.amount=value;
      } else {
        if (value!==null && (typeof value!=='string'||value.length>160)) return c.json({message:'Campo inválido: '+key},400);
        (next as unknown as Record<string,unknown>)[key]=value;
      }
    }
    if (!['BANK_TRANSFER','CASH_DEPOSIT','CHECK_DEPOSIT','UNKNOWN'].includes(next.operationType)) {
      return c.json({message:'Tipo de operación inválido'},400);
    }
    if (next.currency !== null && !['GTQ','USD'].includes(next.currency)) {
      return c.json({message:'Moneda inválida'},400);
    }
    next.destinationAccount=normalizeAccount(next.destinationAccount);
    // Anomalies are human-reviewed; objective rules still apply (date, cheque, account, amount).
    const guarded={...next,suspectedTampering:false,anomalies:[]};
    let verdict=decideReceipt(guarded,guatemalaToday(new Date()));
    verdict=await verifyDestinationAccount(c.env.DB,guarded,verdict);
    if (verdict.status!=='APPROVED') return c.json({
      message:'La aprobación manual no puede omitir las reglas obligatorias',reason:verdict.reason
    },422);
    claim=normalizeClaim(next);
    if (!claim) return c.json({message:'Banco o referencia ilegibles'},422);
    extraction=next;
  }
  try {
    const note=data.note.trim();
    if (data.action==='APPROVED' && claim && extraction) {
      // D1 batch: reserve the reference and change status atomically. Never release
      // another receipt's claim; collision aborts the complete transaction.
      const statements=[
        c.env.DB.prepare(`DELETE FROM receipt_claims WHERE receipt_id=? AND
          EXISTS(SELECT 1 FROM receipts WHERE id=? AND status='REVIEW_REQUIRED')`).bind(id,id),
        c.env.DB.prepare(`INSERT INTO receipt_claims (claim_key,receipt_id)
          SELECT ?,? WHERE EXISTS(SELECT 1 FROM receipts WHERE id=? AND status='REVIEW_REQUIRED')`).bind(claim,id,id),
        c.env.DB.prepare(`UPDATE receipts SET status='APPROVED',reason='MANUAL_APPROVED',
          extracted_json=?,processed_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='REVIEW_REQUIRED'`).bind(JSON.stringify(extraction),id),
        c.env.DB.prepare(`INSERT OR IGNORE INTO receipt_reviews
          (id,receipt_id,action,previous_status,previous_reason,note,previous_extraction_json,reviewed_extraction_json)
          SELECT ?,?,'APPROVED',?,?,?, ?,? FROM receipts
          WHERE id=? AND status='APPROVED' AND reason='MANUAL_APPROVED'`)
          .bind(reviewId,id,row.status,row.reason,note,row.extracted_json,JSON.stringify(extraction),id),
      ];
      const outcomes=await c.env.DB.batch(statements);
      if (outcomes[2].meta.changes!==1) return c.json({message:'Ya se resolvió esta revisión'},409);
    } else {
      const results=await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE receipts SET status='REJECTED',reason='MANUAL_REJECTED',
          processed_at=CURRENT_TIMESTAMP WHERE id=? AND status='REVIEW_REQUIRED'`).bind(id),
        c.env.DB.prepare(`DELETE FROM receipt_claims WHERE receipt_id=? AND
          EXISTS(SELECT 1 FROM receipts WHERE id=? AND status='REJECTED' AND reason='MANUAL_REJECTED')`).bind(id,id),
        c.env.DB.prepare(`INSERT OR IGNORE INTO receipt_reviews
          (id,receipt_id,action,previous_status,previous_reason,note,previous_extraction_json)
          SELECT ?,?,'REJECTED',?,?,?,? FROM receipts
          WHERE id=? AND status='REJECTED' AND reason='MANUAL_REJECTED'`)
          .bind(reviewId,id,row.status,row.reason,note,row.extracted_json,id),
      ]);
      if(results[0].meta.changes!==1) return c.json({message:'Ya se resolvió esta revisión'},409);
    }
  } catch (err) {
    console.error('Admin review transaction failed',err instanceof Error ? err.message : 'unknown');
    return c.json({message:'Conflicto de referencia o error al registrar la revisión'},409);
  }
  return c.json({id,status:data.action,reason:data.action==='APPROVED'?'MANUAL_APPROVED':'MANUAL_REJECTED'});
});

export default admin;
