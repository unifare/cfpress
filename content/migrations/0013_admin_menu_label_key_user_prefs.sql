-- 0013: admin menu translation keys + per-user menu preferences.
--
-- `admin_menu_registry.label_key` — the declared dictionary key a menu label
-- translates through at read time (§2.4 layer stack). Nullable: a menu without
-- a key simply renders its literal label in every language.
--
-- `site_users.menu_prefs` — a JSON array of navigation keys the user hid from
-- the sidebar ("menu configuration"). UI-level only: capability filtering in
-- the API is untouched, so hiding a menu never grants or revokes access.
-- Per-user rather than per-site for the same reason `ui_lang` is: two admins
-- on one site may want different sidebars. NULL means "show everything".

ALTER TABLE admin_menu_registry ADD COLUMN label_key TEXT;
ALTER TABLE site_users ADD COLUMN menu_prefs TEXT;
