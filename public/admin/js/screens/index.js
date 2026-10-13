/**
 * Screen registry — the page-name → screen table the shell dispatches through.
 *
 * This is the only module that imports every screen, and nothing imports it
 * except the entry point. Two names are special and handled by the shell
 * itself: `cpt:<type>` and `menu:<id>`.
 */
import dashboard from "./dashboard.js";
import { contentList } from "./content-list.js";
import media from "./media.js";
import resources from "./resources.js";
import urls from "./urls.js";
import settings from "./settings.js";
import features from "./features.js";
import seo from "./seo.js";
import sites from "./sites.js";
import users from "./users.js";
import search from "./search.js";
import menus from "./menus.js";
import widgets from "./widgets.js";
import themes from "./themes.js";
import plugins from "./plugins.js";
import languages from "./languages.js";
import themeMenuScreen from "./theme-menu.js";
import account from "./account.js";
import menuConfig from "./menu-config.js";
import { tableListScreen } from "./table-list.js";
import { tableEditScreen } from "./table-edit.js";
import { pluginPageScreen } from "./plugin-page.js";

export const SCREENS = {
  dashboard,
  search,
  activity: (c) => resources(c, "activity", "Activity"),
  posts: (c) => contentList(c, "posts"),
  pages: (c) => contentList(c, "pages"),
  media,
  appearance: themes,
  menus,
  widgets,
  plugins,
  languages,
  sites,
  users,
  account,
  "menu-config": menuConfig,
  seo,
  urls,
  settings,
  features,

  // Targets of the dynamic `cpt:` / `menu:` / `table:` prefixes, resolved by
  // the shell. `table-list` and `table-edit` are also registered directly so
  // the structure test renders them; reached without a table they show an
  // explanatory panel rather than an empty grid.
  "content-list": contentList,
  "theme-menu": themeMenuScreen,
  "table-list": tableListScreen,
  "table-edit": tableEditScreen,
  // The target of the dynamic `plugin-page:<id>` prefix, resolved by the
  // shell. Registered directly as well so the structure test renders it;
  // reached without an id it shows an explanatory panel.
  "plugin-page": pluginPageScreen,
};
