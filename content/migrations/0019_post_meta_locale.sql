-- 0019: A language dimension for custom fields (post_meta).
--
-- `post_meta` was `PRIMARY KEY(post_id, meta_key)` with no locale column, so a
-- value was shared by every language of a post. For a field holding prose that
-- is a defect, not a convenience: a Chinese site's category chip read "Design"
-- because the only stored value was the English one. Rule 41 says every field
-- carrying data has a language dimension; this table was the last one faking
-- its way around that with "derived from the post".
--
-- The shape follows `menu_items` (an in-place `locale` column), not the
-- `{table}_i18n` sidecar, because post_meta is a derived key→value store hung
-- off a post, not a main content table: one row per (post, key, language).
--
-- SQLite cannot alter a primary key, so the table is rebuilt. Legacy rows keep
-- every value and land at locale='' — deliberately NOT backfilled to the site
-- default. '' reads as "written before the dimension existed", and the read
-- ladder (own locale → site default → '' → anything) reproduces today's
-- behaviour exactly for data nobody has re-saved, while a per-language save
-- immediately gives that language its own value.
CREATE TABLE post_meta_locale (
  post_id TEXT NOT NULL,
  meta_key TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT '',
  meta_value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(post_id, meta_key, locale)
);
INSERT INTO post_meta_locale(post_id, meta_key, locale, meta_value, updated_at)
  SELECT post_id, meta_key, '', meta_value, updated_at FROM post_meta;
DROP TABLE post_meta;
ALTER TABLE post_meta_locale RENAME TO post_meta;
