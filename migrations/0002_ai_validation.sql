-- Reservar las referencias de documentos aprobados y bajo revisión.
CREATE TABLE IF NOT EXISTS receipt_claims (
  claim_key TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES receipts(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipts_processed_at ON receipts(processed_at);
