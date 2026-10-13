/**
 * Admin SPA — navigation model, sidebar and header.
 *
 * Pure markup builders: they read `state` and return HTML strings. The render
 * loop that mounts them lives in `shell.js`, so nothing here calls `render()`
 * and the dependency graph stays one-directional (shell → nav → state).
 *
 * Every static string goes through `t()` with the English source as fallback,
 * so a missing dictionary entry degrades to the exact text that used to be
 * hard-coded here. Extension-declared menu labels are NOT translated here —
 * the admin-menus API already returns them translated (or verbatim) — which
 * is why `extensionItems` below uses the label as-is.
 */
import { state } from "./state.js";
import { icon } from "../icons.js";
import { attr, esc, themePref } from "../ui.js";
import { t, currentLocale, UI_LANGUAGES } from "./i18n.js";

/**
 * A theme may declare both a custom post type (`theme/post-types`) and an admin
 * menu pointing at that same type's list screen (`theme/menus`), e.g. the
 * `storefront` theme ships `product` + `{ screen: "content-list",
 * args: { type: "product" } }`. The CPT already occupies a Content slot and
 * opens the very same screen, so rendering the menu too would show "Products"
 * twice. Drop any content-list menu that a CPT entry already covers; keep every
 * other menu (custom panels, settings screens, table screens, …).
 *
 * Applies to plugin menus as well: a plugin that adds a post type and a menu
 * for it has the same double-entry problem.
 */
function isRedundantThemeMenu(menu, postTypes) {
  if (menu.screen !== "content-list") return false;
  const type = menu.args?.type;
  if (!type) return false;
  if (type === "posts" || type === "pages") return true; // core screens
  return postTypes.some((pt) => pt.name === type);
}

/** One sidebar entry per declared menu, regardless of which owner declared it. */
function extensionItems(menus, postTypes) {
  return menus
    .filter((m) => !isRedundantThemeMenu(m, postTypes))
    .map((m) => ({
      key: `menu:${m.menu_id}`,
      title: String(m.label || m.menu_id),
      icon: "sparkles",
      active: state.page === `menu:${m.menu_id}`,
    }));
}

/**
 * The built-in sidebar model, before any customization. Every group carries a
 * stable `id` — the key the site-level menu customization addresses groups by.
 * `showHidden`-style filtering does NOT happen here; this is the raw universe
 * the menu editor edits and `applyMenuCustom` transforms.
 */
export function baseGroups() {
  const core = (name) => state.page === name;
  const cptItems = state.postTypes.map((pt) => ({
    key: `cpt:${pt.name}`,
    title: String(pt.plural_label || pt.label || pt.name),
    icon: "layers",
    active: state.page === `cpt:${pt.name}`,
  }));
  const themeItems = extensionItems(state.themeMenus, state.postTypes);
  // Plugin menus get their own group rather than being mixed into "From theme":
  // a plugin is install-wide while a theme is per site, and an admin debugging
  // "where did this menu come from" should be able to tell them apart at a
  // glance.
  const pluginItems = extensionItems(state.pluginMenus, state.postTypes);

  return [
    {
      id: "general",
      label: t("core.nav.general", "General"),
      items: [
        { key: "dashboard", title: t("core.nav.dashboard", "Dashboard"), icon: "layout-dashboard", active: core("dashboard") },
        { key: "search", title: t("core.nav.search", "Search"), icon: "search", active: core("search") },
        { key: "activity", title: t("core.nav.activity", "Activity"), icon: "activity", active: core("activity") },
      ],
    },
    {
      id: "content",
      label: t("core.nav.content", "Content"),
      items: [
        { key: "posts", title: t("core.nav.posts", "Posts"), icon: "file-text", active: core("posts") },
        { key: "pages", title: t("core.nav.pages", "Pages"), icon: "files", active: core("pages") },
        { key: "media", title: t("core.nav.media", "Media"), icon: "image", active: core("media") },
        ...cptItems,
      ],
    },
    ...(themeItems.length
      ? [{ id: "from-theme", label: t("core.nav.fromTheme", "From theme"), items: themeItems }]
      : []),
    ...(pluginItems.length
      ? [{ id: "extensions", label: t("core.nav.extensions", "Extensions"), items: pluginItems }]
      : []),
    {
      id: "appearance",
      label: t("core.nav.appearance", "Appearance"),
      items: [
        { key: "appearance", title: t("core.nav.themes", "Themes"), icon: "palette", active: core("appearance") },
        { key: "menus", title: t("core.nav.menus", "Menus"), icon: "menu", active: core("menus") },
        { key: "widgets", title: t("core.nav.widgets", "Widgets"), icon: "package", active: core("widgets") },
      ],
    },
    {
      id: "system",
      label: t("core.nav.system", "System"),
      items: [
        { key: "plugins", title: t("core.nav.plugins", "Plugins"), icon: "puzzle", active: core("plugins") },
        { key: "languages", title: t("core.nav.languages", "Languages"), icon: "languages", active: core("languages") },
        { key: "sites", title: t("core.nav.sites", "Sites"), icon: "landmark", active: core("sites") },
        { key: "users", title: t("core.nav.users", "Users"), icon: "users", active: core("users") },
      ],
    },
    {
      id: "tools",
      label: t("core.nav.tools", "Tools"),
      items: [
        { key: "seo", title: t("core.nav.seo", "SEO"), icon: "chart", active: core("seo") },
        { key: "urls", title: t("core.nav.urls", "URL Manager"), icon: "route", active: core("urls") },
        { key: "settings", title: t("core.nav.settings", "Settings"), icon: "settings", active: core("settings") },
        { key: "features", title: t("core.nav.features", "Features"), icon: "sliders-horizontal", active: core("features") },
      ],
    },
  ];
}

/**
 * Apply the site-level menu customization to a freshly built group model.
 *
 * PURE on purpose: the sidebar and the menu editor must consume the same
 * definition (one answer, one place — the same principle as `groupOf()`).
 * `custom` is the server-validated blob from `admin-menus/custom`:
 *
 *   items:  { [key]: { label?: {<locale>: text}, order?: int,
 *                     group?: groupId, hidden?: bool } }
 *   groups: { [id]:  { label?: {<locale>: text}, order?: int } }
 *
 * Resolution for a label: override[locale] → override.en → built-in label.
 * Renames sit ON TOP of the server-side label_key translation — they are a
 * site's own customization, not a second translation dictionary.
 * Ordering: explicit integer orders win (ascending); siblings without an
 * order keep their built-in relative sequence after the ordered ones
 * (stable sort). Items may move to another existing group via `group`;
 * a move targeting a group that does not exist is not appliable and is
 * dropped, never invented.
 */
export function applyMenuCustom(groups, custom, locale) {
  const oc = custom && typeof custom === "object" ? custom : {};
  const itemsC = oc.items && typeof oc.items === "object" && !Array.isArray(oc.items) ? oc.items : {};
  const groupsC = oc.groups && typeof oc.groups === "object" && !Array.isArray(oc.groups) ? oc.groups : {};
  const lang = typeof locale === "string" && locale ? locale : "en";

  const pick = (o, fallback) => {
    if (!o || !o.label) return fallback;
    const byLocale = o.label;
    if (typeof byLocale[lang] === "string" && byLocale[lang]) return byLocale[lang];
    if (typeof byLocale.en === "string" && byLocale.en) return byLocale.en;
    return fallback;
  };

  // 1. Rename items + retarget their group (into a map keyed by group id).
  //    A move targeting a group that does not exist in the base model is
  //    IGNORED — the item stays where it was. Dropping the item entirely
  //    would make it vanish from every sidebar, which is never the intent.
  const byGroup = new Map();
  for (const g of groups) {
    for (const it of g.items) {
      const o = itemsC[it.key] || {};
      const wanted = typeof o.group === "string" && o.group ? o.group : null;
      const target = wanted && groups.some((x) => x.id === wanted) ? wanted : g.id;
      const next = { ...it, title: pick(o, it.title), siteHidden: o.hidden === true };
      if (!byGroup.has(target)) byGroup.set(target, []);
      byGroup.get(target).push(next);
    }
  }

  // 2. Rebuild the group list: only groups that ended up with items, labels
  //    resolved the same way as item labels.
  const ordered = groups
    .filter((g) => byGroup.has(g.id))
    .map((g) => ({ ...g, label: pick(groupsC[g.id], g.label), items: byGroup.get(g.id) }));

  // 3. Order groups, then items within each group. Explicit orders first,
  //    unordered siblings keep their built-in sequence after them.
  const orderOf = (map, id) => {
    const o = map[id] && map[id].order;
    return Number.isInteger(o) ? o : null;
  };
  ordered.sort((a, b) => {
    const ao = orderOf(groupsC, a.id), bo = orderOf(groupsC, b.id);
    if (ao !== null && bo !== null) return ao - bo;
    if (ao !== null) return -1;
    if (bo !== null) return 1;
    return 0; // stable sort keeps the built-in order
  });
  for (const g of ordered) {
    g.items.sort((a, b) => {
      const ao = orderOf(itemsC, a.key), bo = orderOf(itemsC, b.key);
      if (ao !== null && bo !== null) return ao - bo;
      if (ao !== null) return -1;
      if (bo !== null) return 1;
      return 0;
    });
  }
  return ordered;
}

/**
 * The sidebar model. `showHidden` is for the menu-configuration screen, which
 * must list *everything*; the sidebar itself drops items the user hid (their
 * own choice, UI-level only) and items hidden site-wide. Permissions are
 * enforced per endpoint, never here.
 *
 * `dashboard` is always shown: it is the "get out" surface, and a sidebar the
 * user can empty entirely reads as a broken install.
 */
export function navGroups(showHidden = false) {
  const hidden = state.hiddenMenus;
  const model = applyMenuCustom(baseGroups(), state.menuCustom, currentLocale());
  return model
    .map((g) => ({
      ...g,
      items: showHidden
        ? g.items
        : g.items.filter((it) => it.key === "dashboard" || (!it.siteHidden && !hidden.has(it.key))),
    }))
    .filter((g) => g.items.length > 0);
}

/** Persist which collapsible groups are expanded. */
export function rememberGroups() {
  localStorage.setItem("cfpress.admin.groups", JSON.stringify([...state.openGroups]));
}

function navItem(item) {
  const badge = item.badge ? `<span class="nav-badge">${esc(item.badge)}</span>` : "";
  return `<button class="nav-item${item.active ? " active" : ""}" data-nav="${attr(item.key)}" title="${attr(item.title)}">
    <span class="nav-icon">${icon(item.icon)}</span>
    <span class="sidebar-text">${esc(item.title)}</span>${badge}
  </button>`;
}

export function sidebar() {
  const site = state.sites.find((s) => s.id === state.site);
  const siteOptions = state.sites
    .map((s) => `<button class="menu-item" data-switch-site="${attr(s.id)}">${icon(s.id === state.site ? "check" : "globe")}<span>${esc(s.name)}</span></button>`)
    .join("");

  const groups = navGroups().map((g) => `
    <div class="nav-group">
      <div class="nav-group-label">${esc(g.label)}</div>
      ${g.items.map(navItem).join("")}
    </div>`).join("");

  return `<aside class="sidebar">
    <div class="sidebar-header">
      <button class="team-switcher" onclick="toggleMenu('site-menu')">
        <span class="team-logo">${icon("layers")}</span>
        <span class="team-meta">
          <span class="team-name">${esc(site?.name || "CFPress")}</span>
          <span class="team-plan">Cloudflare-native CMS</span>
        </span>
        <span class="nav-chevron">${icon("chevron-down")}</span>
      </button>
      <div class="dropdown">
        <div class="menu left" id="site-menu" hidden style="width:100%">
          <div class="menu-label">${esc(t("core.action.switchSite", "Switch site"))}</div>
          ${siteOptions || `<div class="menu-label">${esc(t("core.nav.sites", "Sites"))}</div>`}
          <div class="menu-sep"></div>
          <button class="menu-item" data-nav="sites">${icon("landmark")}<span>${esc(t("core.action.manageSites", "Manage sites"))}</span></button>
        </div>
      </div>
    </div>
    <div class="sidebar-content">${groups}</div>
    <div class="sidebar-footer">
      <button class="nav-item" data-nav="settings" title="${attr(t("core.nav.settings", "Settings"))}">
        <span class="nav-icon">${icon("settings")}</span><span class="sidebar-text">${esc(t("core.nav.settings", "Settings"))}</span>
      </button>
    </div>
  </aside>`;
}

const THEME_LABEL = {
  light: () => t("core.theme.light", "Light"),
  dark: () => t("core.theme.dark", "Dark"),
  system: () => t("core.theme.system", "System"),
};
const THEME_ICON = { light: "sun", dark: "moon", system: "monitor" };

export function header() {
  const current = themePref();
  const themeItems = ["light", "dark", "system"]
    .map((th) => `<button class="menu-item theme-opt${current === th ? " active" : ""}" data-theme="${th}">
        ${icon(THEME_ICON[th])}<span>${THEME_LABEL[th]()}</span><span class="check">${icon("check")}</span>
      </button>`)
    .join("");

  const uiNow = currentLocale();
  const langItems = UI_LANGUAGES
    .map(([code, name]) => `<button class="menu-item${uiNow === code ? " active" : ""}" data-ui-locale="${attr(code)}">
        ${icon("languages")}<span>${esc(name)}</span><span class="check">${icon("check")}</span>
      </button>`)
    .join("");

  return `<header class="header" id="app-header">
    <button class="icon-btn" onclick="toggleSidebar()" aria-label="Toggle navigation">${icon("panel-left")}</button>
    <button class="header-search" onclick="go('search')">
      ${icon("search")}<span>${esc(t("core.msg.searchPlaceholder", "Search…"))}</span><kbd>⌘K</kbd>
    </button>
    <div class="header-actions">
      <button class="icon-btn" data-view-site="1" data-view-site-prefix="${attr(state.sites.find((s) => s.id === state.site)?.path_prefix || "")}"
        title="${attr(t("core.action.viewSite", "View site"))}" aria-label="${attr(t("core.action.viewSite", "View site"))}">${icon("external")}</button>
      <div class="dropdown">
        <button class="icon-btn" onclick="toggleMenu('theme-menu')" aria-label="${attr(t("core.action.theme", "Theme"))}">${icon(THEME_ICON[current])}</button>
        <div class="menu right" id="theme-menu" hidden>
          <div class="menu-label">${esc(t("core.action.theme", "Theme"))}</div>${themeItems}
        </div>
      </div>
      <div class="dropdown">
        <button class="icon-btn" onclick="toggleMenu('lang-menu')" aria-label="${attr(t("core.nav.languages", "Languages"))}">${icon("languages")}</button>
        <div class="menu right" id="lang-menu" hidden>
          <div class="menu-label">${esc(t("core.nav.languages", "Languages"))}</div>${langItems}
        </div>
      </div>
      <div class="dropdown">
        <button class="icon-btn has-dot" onclick="toggleMenu('notif-menu')" aria-label="${attr(t("core.msg.notifications", "Notifications"))}">
          ${icon("bell")}<span class="notif-dot"></span>
        </button>
        <div class="menu right" id="notif-menu" hidden style="min-width:18rem">
          <div class="menu-label">${esc(t("core.msg.notifications", "Notifications"))}</div>
          <div class="menu-sep"></div>
          <div class="menu-label" style="white-space:normal;line-height:1.5">
            ${esc(t("core.msg.notifHint", "Autosave is on for drafts you open in the editor. Revisions are kept per locale."))}
          </div>
        </div>
      </div>
      <div class="dropdown">
        <button class="icon-btn" onclick="toggleMenu('user-menu')" aria-label="Account">${icon("user")}</button>
        <div class="menu right" id="user-menu" hidden>
          <div class="menu-label">
            <div style="color:var(--foreground);font-weight:600">${esc(state.user?.username || "—")}</div>
            <div>${esc(state.user?.role || "")}</div>
          </div>
          <div class="menu-sep"></div>
          <button class="menu-item" data-nav="account">${icon("user")}<span>${esc(t("core.action.accountSettings", "Account settings"))}</span></button>
          <button class="menu-item" data-nav="menu-config">${icon("menu")}<span>${esc(t("core.action.configureMenu", "Configure menu"))}</span></button>
          <div class="menu-sep"></div>
          <button class="menu-item" data-nav="users">${icon("users")}<span>${esc(t("core.action.manageUsers", "Manage users"))}</span></button>
          <button class="menu-item" data-nav="settings">${icon("settings")}<span>${esc(t("core.action.siteSettings", "Site settings"))}</span></button>
          <div class="menu-sep"></div>
          <button class="menu-item danger" data-action="logout">${icon("log-out")}<span>${esc(t("core.action.logout", "Log out"))}</span></button>
        </div>
      </div>
    </div>
  </header>`;
}
