-- 0014: extension-owned tables become owner-agnostic (plugins get their own tables).
--
-- Batch 4 shipped theme-owned tables and recorded the debt: "only plugin-owned
-- tables remain". `theme_table_defs` could not hold them, because its columns
-- say `theme_name` and its unique key says `(site_id, theme_name, logical_name)`
-- — a plugin has no theme, so there was nowhere to put it.
--
-- ## Why this table is rebuilt rather than altered
--
-- SQLite's `ALTER TABLE` can add a column but cannot add or change a UNIQUE
-- constraint, and cannot add a composite primary key. This table needs both
-- (`owner_type` in the key, and `theme_name` renamed to `owner_name`). The
-- documented workaround is the one used here: create the new shape, copy, drop,
-- rename.
--
-- ## What did NOT change (each of these is load-bearing)
--
--   `id`          the surrogate key. `refreshThemeTableI18n()` updates by it and
--                 `hydrate()` reads it. A version of this migration that put the
--                 composite key *in place of* `id` breaks both — and it also
--                 drops `site_id`, so the same theme on two sites collides and
--                 the whole `INSERT … SELECT` aborts. Both were reproduced
--                 against a real SQLite before this file was written.
--   `site_id`     `listThemeTableDefs(env, siteId)` filters on it. An extension's
--                 data is per site, exactly like every other tenant-scoped table.
--
-- ## Generated physical names
--
-- `{owner_type}_{owner_name}_{logical}` — `theme_foo_bar` / `plugin_foo_bar`.
-- The prefix is what keeps a theme and a plugin of the same name from colliding:
-- without it, theme `notify` and plugin `notify` both want `notify_log`. The
-- theme prefix is unchanged, so every name generated before this migration
-- stays valid and no theme table is renamed.

CREATE TABLE theme_table_defs_new (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  owner_type    TEXT NOT NULL,          -- 'theme' | 'plugin'
  owner_name    TEXT NOT NULL,          -- the theme or plugin name
  logical_name  TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  i18n_table    TEXT,
  translatable  TEXT NOT NULL DEFAULT '[]',
  fields_json   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(site_id, owner_type, owner_name, logical_name)
);

-- Every existing row is a theme: plugins had no way to register before now.
INSERT INTO theme_table_defs_new(
  id, site_id, owner_type, owner_name, logical_name,
  table_name, i18n_table, translatable, fields_json, created_at, updated_at
)
SELECT
  id, site_id, 'theme', theme_name, logical_name,
  table_name, i18n_table, translatable, fields_json, created_at, updated_at
FROM theme_table_defs;

DROP TABLE theme_table_defs;
ALTER TABLE theme_table_defs_new RENAME TO theme_table_defs;

CREATE INDEX IF NOT EXISTS idx_theme_table_defs_site
  ON theme_table_defs(site_id, owner_type, owner_name);
-- Backfill the index the old table had under its old name, so a query that
-- still says "one theme's tables" is served by an index rather than a scan.
CREATE INDEX IF NOT EXISTS idx_theme_table_defs_owner
  ON theme_table_defs(site_id, owner_type, owner_name, logical_name);
