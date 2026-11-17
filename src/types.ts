export type Bindings = {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  AI: { run(model: string, inputs: unknown): Promise<unknown> };
  TURNSTILE_SECRET_KEY?: string;
  DEV_BYPASS_TURNSTILE?: string;
};
export type ReceiptStatus = 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED';
