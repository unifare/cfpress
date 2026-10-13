-- 0015: notification send ledger.
--
-- Two jobs, one table, because they are the same fact recorded twice:
--
--   1. `dedupKey` — the contract promises "the same key is sent once". That
--      promise needs somewhere to remember what has been sent, or it is a
--      documented feature that does nothing. Notification code is where
--      duplicates actually happen: a retry, two concurrent requests, a hook
--      that fires more than once per event.
--
--   2. The plugin-page `table`/`stats` blocks read "the send log". Without a
--      table behind them, a plugin's declared page would render an empty list
--      forever and look like a failed load.
--
-- ## Why this is a platform table and not a plugin table
--
-- It is written by the host, not declared by a plugin: the host performs every
-- send, so it is the only party that knows a send happened. A plugin-owned
-- table would mean each plugin recording its own sends, which is the same
-- bookkeeping implemented once per plugin and diverging immediately.
--
-- Tenant-scoped (`site_id`) like every other content table: a notification is
-- about one site's event, and the dedup key must not collide across sites.
-- Deliberately NOT per-locale: a notification has one body, and the language
-- it is written in is the caller's choice, not a dimension of the record.

CREATE TABLE IF NOT EXISTS notification_log (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  channel     TEXT NOT NULL,
  -- The idempotency key the caller supplied, or NULL when it supplied none.
  dedup_key   TEXT,
  title       TEXT,
  content     TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  ok          INTEGER NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL
);

-- The dedup lookup: "has this (site, plugin, channel, key) been sent already?"
-- Partial, because rows with no `dedup_key` are not deduplicated and should not
-- take space in the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_dedup
  ON notification_log(site_id, plugin_name, channel, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- The admin listing reads one plugin's recent sends, newest first.
CREATE INDEX IF NOT EXISTS idx_notification_log_recent
  ON notification_log(site_id, plugin_name, created_at DESC);
