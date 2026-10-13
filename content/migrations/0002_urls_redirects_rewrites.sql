-- CFPress v0.2.0: URL management tables
CREATE TABLE IF NOT EXISTS redirects (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 301,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_redirects_source ON redirects(source);

CREATE TABLE IF NOT EXISTS rewrites (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rewrites_from ON rewrites(from_path);