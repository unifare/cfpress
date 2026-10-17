-- 0028: Multi-language support for taxonomy terms (locale + lang_group).
--
-- Taxonomy terms (tags and categories) need to support multiple languages so that
-- a Chinese post can be tagged with Chinese tags and an English post with English
-- tags, with cross-language siblings tied by `lang_group`.
--
-- Legacy terms are preserved with locale='' (meaning all languages / neutral)
-- and lang_group=id.
CREATE TABLE terms_locale (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  taxonomy TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_id TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT '',
  lang_group TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(site_id, taxonomy, locale, slug)
);

INSERT INTO terms_locale(id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, created_at, updated_at)
  SELECT id, site_id, taxonomy, slug, name, description, parent_id, count, '', id, created_at, updated_at FROM terms;

DROP TABLE terms;
ALTER TABLE terms_locale RENAME TO terms;

CREATE INDEX IF NOT EXISTS idx_terms_taxonomy ON terms(site_id, taxonomy, locale);
CREATE INDEX IF NOT EXISTS idx_terms_lang_group ON terms(site_id, lang_group);
