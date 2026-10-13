-- 0020: A site dimension for sidebar widgets (widget_instances).
--
-- `widget_instances` was install-wide: no site_id, no locale, and the one
-- read path that existed (`GET /widgets`) did `SELECT * … ORDER BY sidebar`
-- with no tenant filter at all. On a multi-site install every site's sidebar
-- showed every site's widgets — the exact leak §10 rule 6 forbids for menus
-- (see the comment on `menusForLocation`: a shop's nav item on the default
-- site's front page). Widgets are placement content, which is per-site by
-- definition, so the table is rebuilt with `site_id` and a `locale` column
-- (same shape as `menu_items`: a widget with locale='' renders in every
-- language, a widget with a locale renders only on that language's pages —
-- language-specific sidebars, no silent cross-language fallback).
--
-- Legacy rows land at site_id='default': before this migration there was
-- only one real site anyway, and 0009 made the same choice for every table
-- it backfilled. SQLite cannot add a NOT NULL column with a computed default
-- per row, so the table is rebuilt.
CREATE TABLE widget_instances_site (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  sidebar TEXT NOT NULL,
  widget_type TEXT NOT NULL,
  title TEXT,
  config TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  locale TEXT NOT NULL DEFAULT ''
);
INSERT INTO widget_instances_site(id, site_id, sidebar, widget_type, title, config, sort_order, enabled, locale)
  SELECT id, 'default', sidebar, widget_type, title, config, sort_order, enabled, '' FROM widget_instances;
DROP TABLE widget_instances;
ALTER TABLE widget_instances_site RENAME TO widget_instances;
CREATE INDEX IF NOT EXISTS idx_widget_instances_site ON widget_instances(site_id, sidebar, sort_order);
