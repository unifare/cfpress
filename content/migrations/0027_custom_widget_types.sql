-- 0027_custom_widget_types.sql: User-defined custom widget types.
--
-- Allows site administrators to declare reusable custom widgets with
-- HTML/Handlebars templates and field JSON schemas, matching dotnetcms
-- feature parity.
--
-- Site-scoped: each site manages its own custom widget definitions.

CREATE TABLE IF NOT EXISTS custom_widget_types (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT 'puzzle',
  template TEXT NOT NULL DEFAULT '',
  schema_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, type)
);

CREATE INDEX IF NOT EXISTS idx_custom_widget_types_site ON custom_widget_types(site_id);
