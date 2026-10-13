-- CFPress v0.7.0: roles, plugin settings, scheduling, cache metadata and search
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(role, permission)
);
CREATE TABLE IF NOT EXISTS plugin_setting_defs (
  plugin_name TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  default_value TEXT,
  PRIMARY KEY(plugin_name,key)
);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  post_id TEXT PRIMARY KEY,
  publish_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(publish_at, processed_at);
CREATE TABLE IF NOT EXISTS content_cache_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO content_cache_versions(id,version,updated_at) VALUES('default',1,strftime('%s','now'));

INSERT OR IGNORE INTO role_permissions(role,permission) VALUES
('admin','site.manage'),('admin','content.write'),('admin','content.publish'),('admin','media.write'),('admin','extensions.manage'),('admin','users.manage'),('admin','settings.manage'),
('editor','content.write'),('editor','content.publish'),('editor','media.write'),
('author','content.write'),('author','content.publish');
