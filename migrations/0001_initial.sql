CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  original_filename TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_ANALYSIS'
    CHECK (status IN ('PENDING_ANALYSIS','PROCESSING','APPROVED','REJECTED','REVIEW_REQUIRED')),
  reason TEXT,
  extracted_json TEXT,
  anomalies_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_status_created ON receipts(status, created_at);
