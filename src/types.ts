export type Bindings = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  TURNSTILE_SECRET_KEY?: string;
  DEV_BYPASS_TURNSTILE?: string;
};

export type UploadedReceipt = {
  id: string;
  status: 'PENDING_ANALYSIS';
  message: string;
};
