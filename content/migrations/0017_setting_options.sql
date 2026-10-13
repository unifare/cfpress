-- 0017: Declared setting options.
--
-- A `settings[]` entry could declare `type: "select"` and an `options` array
-- at install time, and the validator accepted both — but only type/label/
-- default were persisted, so the declared choices were silently dropped and
-- the admin rendered a select with nothing in it. Both definition tables gain
-- an `options` column (JSON array of scalars, NULL = not a choice field).
ALTER TABLE theme_setting_defs ADD COLUMN options TEXT;
ALTER TABLE plugin_setting_defs ADD COLUMN options TEXT;
