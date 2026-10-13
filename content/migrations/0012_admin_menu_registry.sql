-- CFPress v0.8.0: unified admin menu registry (ARCHITECTURE.md §4.4)
--
-- Before this migration there was exactly one place a theme could register an
-- admin menu (`theme_admin_menus`) and nowhere a *plugin* could. That asymmetry
-- was not a design choice, it was the shape of the first implementation: themes
-- happened to need menus first. It also meant the two extension kinds could
-- never share a rendering path, because one of them had no rows to render.
--
-- `admin_menu_registry` gives every menu an owner (`owner_type` + `owner_name`).
-- That single fact buys three things:
--
--   * a plugin can register a menu through the same code path a theme uses
--   * disabling a plugin deletes *its* menus and nobody else's
--   * the admin API can filter by capability and hand the SPA a flat list,
--     instead of the SPA knowing which extension kind produced each item
--
-- Idempotency: migrations are replayed from 0001 on every run, and 0008
-- recreates `theme_admin_menus` with IF NOT EXISTS. So on a replay the copy
-- below reads an empty table (the real rows already live in the registry),
-- `INSERT OR IGNORE` adds nothing, and the drop is a no-op. The only statement
-- that can fail is the copy, if a database somehow lacks the old table — which
-- is harmless, because that also means there is nothing left to copy.

-- ---------------------------------------------------------------------------
-- The registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_menu_registry (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL,
  owner_type     TEXT NOT NULL,      -- 'theme' | 'plugin' | 'core'
  owner_name     TEXT NOT NULL,      -- 'eshop' | 'seo'
  menu_id        TEXT NOT NULL,
  label          TEXT NOT NULL,
  icon           TEXT,
  screen         TEXT NOT NULL,
  args_json      TEXT NOT NULL DEFAULT '{}',
  capability     TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(site_id, owner_type, owner_name, menu_id)
);

-- The admin API asks "everything this site should show, in order" on every
-- boot of the SPA. That is exactly this index.
CREATE INDEX IF NOT EXISTS idx_admin_menu_registry_site
  ON admin_menu_registry(site_id, owner_type, sort_order);

-- Disabling an extension clears its menus by (owner_type, owner_name) — the
-- same lookup `clearThemeCapabilities` / `clearPluginMenus` perform.
CREATE INDEX IF NOT EXISTS idx_admin_menu_registry_owner
  ON admin_menu_registry(site_id, owner_type, owner_name);

-- ---------------------------------------------------------------------------
-- Move existing theme menus across, then retire the old table
-- ---------------------------------------------------------------------------
-- `id` is carried over verbatim. It was built by `scopedId("tam", siteId, id)`
-- and stays unique here, so a re-run of any code that still remembers an old
-- id keeps working. New owners get their own prefix (see
-- src/platform/admin-menus.ts) precisely so this stays true.
--
-- `capability` has no source column: the old table never recorded one. NULL
-- means "no capability required", which is what those rows effectively were.
INSERT OR IGNORE INTO admin_menu_registry(
  id, site_id, owner_type, owner_name, menu_id, label, icon, screen,
  args_json, capability, sort_order, enabled, created_at, updated_at
)
SELECT
  id, site_id, 'theme', declared_by_theme, menu_id, label, icon, screen,
  args_json, NULL, sort_order, 1, created_at, updated_at
FROM theme_admin_menus
WHERE declared_by_theme IS NOT NULL AND declared_by_theme <> '';

-- Two tables storing the same thing is a bug waiting to happen; the old one
-- has no reader left after this batch.
DROP TABLE IF EXISTS theme_admin_menus;
