-- 0026_api_keys.sql: Machine-to-Machine API Keys for external AI Agents and integrations
-- Platform-global table: keys are provisioned across the install with optional site/scope constraints.

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,               -- e.g. ak_xxxx
  user_id TEXT NOT NULL,             -- Bound staff account
  name TEXT NOT NULL,                -- User-provided label, e.g. "Cursor AI Agent"
  key_prefix TEXT NOT NULL,          -- Identifiable prefix, e.g. "cfp_live_ab12"
  key_hash TEXT NOT NULL,            -- SHA-256 hex of the secret token
  scopes TEXT NOT NULL DEFAULT '["*"]', -- JSON array of capability names, or ["*"]
  sites TEXT NOT NULL DEFAULT '["*"]',  -- JSON array of allowed site IDs, or ["*"]
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  expires_at INTEGER,                -- Unix timestamp, NULL = never
  last_used_at INTEGER,             -- Unix timestamp
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
