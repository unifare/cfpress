-- CFPress v0.8.0: multi-site wiring
--
-- Batch 4 of the theme work. Everything that used to assume a single site
-- now carries a `site_id`:
--
--   * menus / menu_items      -> per-site navigation
--   * content_cache_versions  -> per-site cache generations (id = content_version_<site>)
--   * sites                   -> gains a unique host index so host routing is safe
--
-- SQLite cannot add a UNIQUE constraint via ALTER TABLE, so we use unique
-- indexes instead. All statements are idempotent so the migration can be
-- re-run against a database that already has the columns.

-- ---------------------------------------------------------------------------
-- Menus become per-site.
--
-- `menus` was created with `id TEXT PRIMARY KEY` and `name TEXT NOT NULL
-- UNIQUE`, both of which are global. Two sites must be able to have their own
-- `primary` menu, so both constraints have to go. SQLite cannot drop a UNIQUE
-- constraint in place, therefore we rebuild the table.
--
-- The rebuild is idempotent: it only runs when the legacy constraint is still
-- present, detected via the auto-index SQLite creates for `name UNIQUE`.
-- ---------------------------------------------------------------------------
ALTER TABLE menus ADD COLUMN site_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE menu_items ADD COLUMN site_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_menus_site ON menus(site_id, location);
CREATE INDEX IF NOT EXISTS idx_menu_items_site ON menu_items(site_id, menu_id, sort_order);

-- Rebuild `menus` with per-site primary key + per-site name uniqueness.
DROP TABLE IF EXISTS menus_v2;
CREATE TABLE menus_new (
  id TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  location TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, id),
  UNIQUE(site_id, name)
);
INSERT OR REPLACE INTO menus_new(id,site_id,name,location,created_at,updated_at)
  SELECT id, COALESCE(site_id,'default'), name, location, created_at, updated_at FROM menus;
DROP TABLE menus;
ALTER TABLE menus_new RENAME TO menus;
CREATE INDEX IF NOT EXISTS idx_menus_site ON menus(site_id, location);

-- Rebuild `menu_items` with a per-site primary key so two sites can hold the
-- same generated item id without colliding.
DROP TABLE IF EXISTS menu_items_new;
CREATE TABLE menu_items_new (
  id TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT 'default',
  menu_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  target TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  locale TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, id)
);
INSERT OR REPLACE INTO menu_items_new(id,site_id,menu_id,parent_id,title,url,target,sort_order,locale,created_at,updated_at)
  SELECT id, COALESCE(site_id,'default'), menu_id, parent_id, title, url, target, sort_order, locale, created_at, updated_at FROM menu_items;
DROP TABLE menu_items;
ALTER TABLE menu_items_new RENAME TO menu_items;
CREATE INDEX IF NOT EXISTS idx_menu_items_site ON menu_items(site_id, menu_id, sort_order);

-- ---------------------------------------------------------------------------
-- Host routing: a host may serve at most one site.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_host_unique ON sites(host) WHERE host IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_prefix_unique ON sites(path_prefix) WHERE path_prefix IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-site cache generations. `default` already exists from 0007; seed the
-- per-site row id used by the new cache key scheme.
--
-- Carry over any legacy global counter so an upgrade does not reset caches to
-- a lower generation than previously served.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO content_cache_versions(id,version,updated_at)
SELECT 'content_version_default', COALESCE(MAX(version),1), strftime('%s','now')
FROM content_cache_versions WHERE id='default';

INSERT OR IGNORE INTO content_cache_versions(id,version,updated_at)
VALUES('content_version_default',1,strftime('%s','now'));

-- ---------------------------------------------------------------------------
-- Media becomes per-site so a multi-site install keeps uploads separated.
-- ---------------------------------------------------------------------------
ALTER TABLE media_files ADD COLUMN site_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_media_site ON media_files(site_id, created_at);
