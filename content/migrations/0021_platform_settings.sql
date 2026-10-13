-- Platform-level settings: keys that belong to the *install*, not to a site.
--
-- `settings` is site-scoped (UNIQUE(site_id, key)) and `deleteSite()` purges it
-- per site, which is correct for `site.title` and wrong for the backend's own
-- path: a deleted site must not be able to take the admin's configuration with
-- it, and two sites must not be able to disagree about where the admin lives.
--
-- This table is the "platform" half of the two-level settings model. The site
-- half stays in `settings`; the read ladder (site value -> platform value ->
-- declared default, per key, by declaration) is defined **once** in
-- `src/platform/settings.ts`, which is also the only writer.
--
-- Every key is declared in `SETTING_DEFS` with its scope. An undeclared key is
-- rejected on write and flagged by `tests/tools/_setting-keys.mjs` - a settings
-- key nothing declares is a settings key nothing can reason about.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  autoload INTEGER NOT NULL DEFAULT 1
);
