-- 0029: Add declared_by_theme to terms for theme-preset tags and taxonomy terms.
ALTER TABLE terms ADD COLUMN declared_by_theme TEXT;
CREATE INDEX IF NOT EXISTS idx_terms_theme ON terms(site_id, declared_by_theme);
