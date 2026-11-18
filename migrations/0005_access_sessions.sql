CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0
);
