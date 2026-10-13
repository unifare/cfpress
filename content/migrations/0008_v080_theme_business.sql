-- CFPress v0.8.0: theme business capabilities + multi-site registry
--
-- Themes stop being "just templates". A theme may now declare custom post
-- types, taxonomies, custom fields, routes, admin menus, blocks and settings.
-- Everything the theme declares is recorded here so the runtime can honour it.
--
-- Design note: business data is *owned* by the theme that declared it, but is
-- never deleted when a theme is deactivated. Switching themes hides the data
-- rather than destroying it - WordPress loses data here, we do not.

-- ---------------------------------------------------------------------------
-- Multi-site registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT,
  path_prefix TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_host ON sites(host);
INSERT OR IGNORE INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at)
VALUES('default','Default Site',NULL,NULL,1,'active',strftime('%s','now'),strftime('%s','now'));

-- ---------------------------------------------------------------------------
-- Theme-declared custom post types
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_types (
  name TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT 'default',
  label TEXT NOT NULL,
  singular_label TEXT,
  plural_label TEXT,
  supports TEXT NOT NULL DEFAULT '[]',
  has_archive INTEGER NOT NULL DEFAULT 0,
  rewrite_slug TEXT,
  declared_by_theme TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, name)
);
CREATE INDEX IF NOT EXISTS idx_post_types_theme ON post_types(declared_by_theme);

-- ---------------------------------------------------------------------------
-- Taxonomy definitions and terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS taxonomies (
  name TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT 'default',
  label TEXT NOT NULL,
  post_types TEXT NOT NULL DEFAULT '[]',
  hierarchical INTEGER NOT NULL DEFAULT 0,
  declared_by_theme TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, name)
);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  taxonomy TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_id TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, taxonomy, slug)
);
CREATE INDEX IF NOT EXISTS idx_terms_taxonomy ON terms(site_id, taxonomy);

CREATE TABLE IF NOT EXISTS term_relationships (
  term_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  PRIMARY KEY(term_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_term_rel_post ON term_relationships(post_id);

-- ---------------------------------------------------------------------------
-- Custom fields (theme-declared schema + per-post values)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_defs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  meta_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  post_types TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  declared_by_theme TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, meta_key)
);

CREATE TABLE IF NOT EXISTS post_meta (
  post_id TEXT NOT NULL,
  meta_key TEXT NOT NULL,
  meta_value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(post_id, meta_key)
);
CREATE INDEX IF NOT EXISTS idx_post_meta_key ON post_meta(meta_key);

-- ---------------------------------------------------------------------------
-- Theme-declared front-end routes and admin menus
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theme_routes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  path TEXT NOT NULL,
  template TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  resolve_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  declared_by_theme TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, path)
);
CREATE INDEX IF NOT EXISTS idx_theme_routes_site ON theme_routes(site_id, sort_order);

CREATE TABLE IF NOT EXISTS theme_admin_menus (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  menu_id TEXT NOT NULL,
  label TEXT NOT NULL,
  icon TEXT,
  screen TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  declared_by_theme TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, menu_id)
);

-- ---------------------------------------------------------------------------
-- Theme settings (same declarative pattern as plugin settings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theme_setting_defs (
  theme_name TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  default_value TEXT,
  PRIMARY KEY(theme_name, key)
);

CREATE TABLE IF NOT EXISTS theme_settings (
  theme_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(theme_name, key)
);

-- ---------------------------------------------------------------------------
-- Theme-declared blocks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theme_blocks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  title TEXT,
  template TEXT,
  declared_by_theme TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, name)
);

-- ---------------------------------------------------------------------------
-- Track which theme declared each post type so switching themes can hide
-- rather than delete business data.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_site_type ON posts(site_id, type, status);
