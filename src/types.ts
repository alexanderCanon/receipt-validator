export type Bindings = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  AI: { run(model: string, inputs: unknown): Promise<unknown> };
  TURNSTILE_SECRET_KEY?: string;
  DEV_BYPASS_TURNSTILE?: string;
  ADMIN_REPROCESS_TOKEN?: string;
  ACCESS_PIN?: string;
  AUTH_PEPPER?: string;
};
export type ReceiptStatus = 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED';
