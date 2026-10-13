CREATE TABLE IF NOT EXISTS menus (
id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,location TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS menu_items (
id TEXT PRIMARY KEY,menu_id TEXT NOT NULL,parent_id TEXT,title TEXT NOT NULL,url TEXT NOT NULL,target TEXT,sort_order INTEGER NOT NULL DEFAULT 0,locale TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_menu_items_menu ON menu_items(menu_id,sort_order);
CREATE TABLE IF NOT EXISTS seo_meta (
id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,locale TEXT NOT NULL,title TEXT,description TEXT,canonical TEXT,robots TEXT,og_image TEXT,
UNIQUE(entity_type,entity_id,locale));
INSERT OR IGNORE INTO settings (id,site_id,key,value,autoload) VALUES
('seo-title','default','seo.titleTemplate','%title% | %site%',1),
('seo-desc','default','seo.description','',1),
('seo-robots','default','seo.robots','index,follow',1),
('theme-active','default','theme.active','default',1);
INSERT OR IGNORE INTO menus (id,name,location,created_at,updated_at)
VALUES ('primary','Primary','header',strftime('%s','now'),strftime('%s','now'));
