-- 0016: Per-language slugs.
--
-- Before this migration a post had ONE slug (`posts.slug`) shared by every
-- language version, so a Chinese article and its English translation were
-- reachable only as /zh-CN/blog/hello and /en/blog/hello. The slug moves into
-- the translation row so each language can have its own URL:
--
--   posts.slug               stays. It is the post's identity and the
--                            *default-language* slug (the repo's i18n
--                            invariant: the main table holds default-language
--                            values). Columns are only ever added, never
--                            dropped.
--   post_translations.slug   NEW. This locale's own slug. NULL means "follow
--                            the main table", so every lookup reads
--                            COALESCE(t.slug, p.slug).
--
-- Deliberately NO backfill: NULL everywhere reproduces today's behaviour
-- exactly (every existing URL keeps resolving), and a backfilled snapshot
-- would silently diverge from the main table the moment the default slug
-- changed. A locale gets its own slug only when an editor gives it one.
ALTER TABLE post_translations ADD COLUMN slug TEXT;

-- The global UNIQUE(site_id, type, slug) enforced "one slug per site+type"
-- across ALL languages, which is precisely what per-language slugs replace:
-- /en/blog/hello and /zh-CN/blog/hello must be able to coexist. Uniqueness
-- remains a *rule*, but scoped to a language (per-locale COALESCE checks on
-- every write path) instead of a storage-level blanket. The index stays —
-- as a plain index, because every lookup still filters on it.
DROP INDEX IF EXISTS idx_posts_site_type_slug;
CREATE INDEX IF NOT EXISTS idx_posts_site_type_slug ON posts(site_id, type, slug);
