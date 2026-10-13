-- CFPress v0.8.0: multi-language, four layers (ARCHITECTURE.md §2)
--
--   L0  platform switch   locales (dictionary) + site_locales (per-site switch)
--   L1  content language  posts.lang_group + a real slug uniqueness constraint
--   L2  UI language       site_users.ui_lang + i18n_overrides (DB override pack)
--   L3  theme business    generated per theme; see src/extensions/theme/tables.ts
--
-- Why L0 is two tables and not one: `locales` answers "which language packs are
-- installed on this machine", `site_locales` answers "which of them does *this
-- site* expose". On a multi-site install a Chinese site and an English site
-- share one dictionary but advertise different language sets.
--
-- Idempotency: every statement must survive being replayed. `ALTER TABLE ADD
-- COLUMN` has no IF NOT EXISTS in SQLite, so those rely on the runner tolerating
-- `duplicate column name` (see tests/_apply-migrations.mjs). Everything else is
-- IF NOT EXISTS / INSERT OR IGNORE / a guarded UPDATE.

-- ---------------------------------------------------------------------------
-- L0-1  locales: the platform language dictionary
-- ---------------------------------------------------------------------------
-- native_name is what the language switcher prints: "简体中文", not
-- "Simplified Chinese". The latter is meaningless to a Chinese reader, and the
-- whole point of a switcher is to be readable by the person who needs it.
ALTER TABLE locales ADD COLUMN native_name TEXT;
ALTER TABLE locales ADD COLUMN direction TEXT NOT NULL DEFAULT 'ltr';
ALTER TABLE locales ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE locales ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Backfill the native name from the English name so the switcher is never
-- empty. Only touches rows that have not been given one explicitly.
UPDATE locales SET native_name = name WHERE native_name IS NULL OR native_name = '';

-- ---------------------------------------------------------------------------
-- L0-2  site_locales: which languages a site exposes, and its default
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_locales (
  site_id    TEXT NOT NULL,
  code       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, code)
);

-- Seed from the existing dictionary so this migration does not change
-- behaviour: before it, every site saw every row of `locales`. It now sees the
-- same set, but explicitly, and can be narrowed from the admin.
INSERT OR IGNORE INTO site_locales(site_id, code, is_default, enabled, sort_order)
SELECT s.id, l.code, l.is_default, l.enabled, l.sort_order
FROM sites s CROSS JOIN locales l
WHERE l.enabled = 1;

-- A site with no default would silently render every unprefixed URL in
-- whatever locale happens to sort first. Pin it explicitly.
UPDATE site_locales SET is_default = 1
WHERE enabled = 1
  AND NOT EXISTS (
    SELECT 1 FROM site_locales x WHERE x.site_id = site_locales.site_id AND x.is_default = 1
  )
  AND code = (SELECT MIN(code) FROM site_locales y WHERE y.site_id = site_locales.site_id AND y.enabled = 1);

-- ---------------------------------------------------------------------------
-- L1  posts: translation groups + a real slug uniqueness constraint
-- ---------------------------------------------------------------------------
-- Each language version of a piece of content is its own `posts` row sharing a
-- `lang_group`. Independent rows (rather than one row with title_en/title_zh)
-- are what make "English is live, Japanese is still being written" possible.
ALTER TABLE posts ADD COLUMN lang_group TEXT;

-- Every pre-existing post becomes its own group of one.
UPDATE posts SET lang_group = id WHERE lang_group IS NULL OR lang_group = '';

-- Before this migration the schema had NO uniqueness on slug at all — only a
-- plain index — and `savePost` did no conflict check, so two posts could share
-- a slug and the front end would silently serve whichever `LIMIT 1` returned.
-- That means the index below is not "tightening an existing rule", it is the
-- first time the rule exists, and a database that has been running with the old
-- schema may genuinely contain duplicates. Creating a UNIQUE index over them
-- aborts the migration, so de-duplicate first.
--
-- The keeper is the lowest rowid in each (site_id, type, slug) group; the rest
-- get a suffix derived from their rowid. rowid is unique, so the suffixed slug
-- is unique too, and the suffix is stable across replays — after one run the
-- table has no duplicates, so the WHERE clause matches nothing.
UPDATE posts SET slug = slug || '-dup' || rowid
WHERE rowid NOT IN (SELECT MIN(rowid) FROM posts GROUP BY site_id, type, slug);

-- The unique index is deliberately (site_id, type, slug) and NOT
-- (site_id, type, slug, locale): slugs are stored on the shared `posts` row,
-- not per translation, so they must be unique across languages. That is what
-- makes unprefixed URLs unambiguous — with a per-language uniqueness rule two
-- translations could both claim `/about`, and which one you got would depend on
-- the visitor's locale. Whoever claims the slug first keeps it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_site_type_slug ON posts(site_id, type, slug);

-- ---------------------------------------------------------------------------
-- L2  UI language (per admin user) and the database override pack
-- ---------------------------------------------------------------------------
-- UI language is NOT content language. A Chinese site owner managing a
-- purely-English site is a completely ordinary configuration; collapsing the
-- two would make it unrepresentable.
ALTER TABLE site_users ADD COLUMN ui_lang TEXT;

-- Highest-priority layer of the four-layer UI dictionary (core pack -> plugin
-- pack -> theme pack -> database override). Stored per site so one install can
-- reword the admin differently for different brands.
CREATE TABLE IF NOT EXISTS i18n_overrides (
  site_id    TEXT NOT NULL,
  locale     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, locale, key)
);
CREATE INDEX IF NOT EXISTS idx_i18n_overrides_site_locale ON i18n_overrides(site_id, locale);

-- ---------------------------------------------------------------------------
-- L3  registry of theme-owned business tables (ARCHITECTURE.md §2.5.2)
-- ---------------------------------------------------------------------------
-- The generated table name is `theme_{theme}_{table}`, derived from the
-- manifest. Deriving it on every access would mean loading the manifest of
-- whichever theme is active *now*, which is exactly wrong: a theme's data must
-- stay reachable after the theme is switched away, because switching themes
-- hides data rather than deleting it (§3.4). Recording the mapping when the
-- declaration is first materialised makes the name a durable fact.
--
-- `i18n_table` is NULL while the site serves a single language, and holds the
-- `…_i18n` name once a second language is enabled. The row is never deleted
-- when the site goes back to one language: the translation table keeps its
-- rows, it just stops being consulted. Dropping it would destroy translations
-- that the site owner never asked to lose.
CREATE TABLE IF NOT EXISTS theme_table_defs (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  theme_name    TEXT NOT NULL,
  logical_name  TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  i18n_table    TEXT,
  translatable  TEXT NOT NULL DEFAULT '[]',
  fields_json   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(site_id, theme_name, logical_name)
);
CREATE INDEX IF NOT EXISTS idx_theme_table_defs_site ON theme_table_defs(site_id, theme_name);
