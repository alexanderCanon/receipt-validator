-- Manual decisions are one-time and immutable; keep an audit trail.
CREATE TABLE IF NOT EXISTS receipt_reviews (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  action TEXT NOT NULL CHECK (action IN ('APPROVED','REJECTED')),
  previous_status TEXT NOT NULL,
  previous_reason TEXT,
  note TEXT NOT NULL,
  previous_extraction_json TEXT,
  reviewed_extraction_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_receipt_reviews_created ON receipt_reviews(created_at);
