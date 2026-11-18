-- The allowlist starts empty and requires explicit administrator provisioning.
-- Restrict D1 administration to authorized operators.
CREATE TABLE IF NOT EXISTS allowed_bank_accounts (
  account_number TEXT PRIMARY KEY,
  bank_name TEXT NOT NULL,
  label TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_allowed_bank_accounts_active ON allowed_bank_accounts(is_active);
