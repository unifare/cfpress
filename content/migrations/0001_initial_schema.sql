-- CFPress v0.1.0: core content schema
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  autoload INTEGER NOT NULL DEFAULT 1,
  UNIQUE(site_id, key)
);

CREATE TABLE IF NOT EXISTS locales (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'post',
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);

CREATE TABLE IF NOT EXISTS post_translations (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  content TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(post_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_post_translations_post ON post_translations(post_id);
CREATE INDEX IF NOT EXISTS idx_post_translations_locale ON post_translations(locale);

INSERT OR IGNORE INTO settings (id, site_id, key, value, autoload)
VALUES
  ('setting-site-title', 'default', 'site.title', 'CFPress', 1),
  ('setting-site-description', 'default', 'site.description', 'Cloudflare-native publishing platform', 1),
  ('setting-default-locale', 'default', 'i18n.defaultLocale', 'en', 1);

INSERT OR IGNORE INTO locales (code, name, is_default)
VALUES
  ('en', 'English', 1);