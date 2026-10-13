-- CFPress v0.6.0 packages, revisions and autosaves
CREATE TABLE IF NOT EXISTS extension_versions (
  id TEXT PRIMARY KEY,
  extension_type TEXT NOT NULL,
  extension_name TEXT NOT NULL,
  version TEXT NOT NULL,
  package_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  manifest TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  UNIQUE(extension_type, extension_name, version)
);
CREATE INDEX IF NOT EXISTS idx_extension_versions_name ON extension_versions(extension_type, extension_name, installed_at DESC);

CREATE TABLE IF NOT EXISTS post_revisions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT,
  version INTEGER NOT NULL,
  title TEXT,
  excerpt TEXT,
  content TEXT,
  locale TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_revisions_post ON post_revisions(post_id, locale, version DESC);

CREATE TABLE IF NOT EXISTS post_autosaves (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  content TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(post_id,user_id,locale)
);

CREATE TABLE IF NOT EXISTS extension_capabilities (
  extension_type TEXT NOT NULL,
  extension_name TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(extension_type,extension_name,capability)
);
