-- 0030: Add template column to posts table for page and custom post template selection.
--
-- Pages can specify 'none' / '' (default: no theme preset HTML, rendering only raw content)
-- or a specific theme template name ('default', 'page', etc.).

ALTER TABLE posts ADD COLUMN template TEXT;
