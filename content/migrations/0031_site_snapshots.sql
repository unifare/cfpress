-- Migration 0031: Point-in-time site snapshots for backup and rollback
CREATE TABLE IF NOT EXISTS site_snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_snapshots_site ON site_snapshots(site_id, created_at DESC);
