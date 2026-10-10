/**
 * Admin SPA — shared state and API helpers.
 *
 * Leaf module: the only thing it imports is the dictionary (`i18n.js`), which
 * is itself a leaf — so nothing here can take part in an import cycle. Keep it
 * that way.
 */
import { t } from "./i18n.js";

/** Mount point for the whole SPA. */
export const app = document.querySelector("#app");

/** All mutable UI state. Screens read it; navigation writes `page` / `editing`. */
export const state = {
  user: null,
  page: "dashboard",
  editing: null,
  type: "post",
  blocks: [],
  autosaveTimer: null,
  site: "default",
  sites: [],
  /** Locale codes this site serves, default first. Drives the editor's locale picker. */
  locales: [],
  /** The site's default locale. Falls back to `"en"` only when nothing loaded. */
  defaultLocale: "en",
  /** The open content's translation group, when the site serves >1 language. */
  translations: null,
  themeMenus: [],
  /** Menus contributed by enabled plugins. Install-wide, so they show on every site. */
  pluginMenus: [],
  /**
   * Installed plugins with their manifests, as the API returns them.
   *
   * A plugin's `adminPages[]` and `channels[]` are what the plugin-declared
   * screens render from, so this is the page declarations' single source of
   * truth in the SPA — the same list the Plugins screen shows. Kept here rather
   * than fetched per screen so a disabled plugin stops offering its pages and
   * its channels in the same breath as the enable toggle.
   */
  plugins: [],
  /** The unified menu list (theme + plugin + core) the API returned. */
  adminMenus: [],
  /** The same rows grouped by owner, for the sidebar's section headings. */
  menuGroups: [],
  /** Navigation keys the user hid from the sidebar (menu configuration).
   *  A Set so `navGroups` can filter without re-parsing on every render. */
  hiddenMenus: new Set(),
  /** Site-level menu customization (renames, ordering, grouping, site-wide
   *  hiding) — one JSON blob per site, applied by nav.js applyMenuCustom. */
  menuCustom: { items: {}, groups: {} },
  /** Whether the signed-in user may edit the site-level menu (settings.manage).
   *  Echoed by the server on GET admin-menus/custom so the SPA never guesses. */
  menuCanManage: false,
  postTypes: [],
  fields: [],
  // The editor's insert palette, delivered by `GET /api/v1/blocks` from the
  // renderer's own `CORE_BLOCKS` set. Never re-listed in the SPA.
  blockTypes: [],
  sidebarCollapsed: localStorage.getItem("cfpress.admin.sidebar") === "1",
  openGroups: new Set(JSON.parse(localStorage.getItem("cfpress.admin.groups") || "[]")),
};

/**
 * The admin prefix, as injected by the server into the shell
 * (`<script>window.CFP_ADMIN_BASE="/admin"</script>`, see `serveAdminIndex`).
 *
 * The prefix is configurable (`admin.path`), so **nothing in the SPA may
 * hard-code it** — a hard-coded `/admin` works until an operator moves the
 * admin and then loads a blank page against a prefix that does not exist.
 * `api()` and the shell's asset URLs are built from this one value.
 *
 * The fallback (`"/admin"`) only applies if the shell was somehow loaded
 * without the injection; it matches the default prefix rather than guessing.
 */
export const adminBase =
  (typeof window !== "undefined" && window.CFP_ADMIN_BASE) || "/admin";

export async function api(path, opts = {}) {
  const res = await fetch(adminBase + "/api/v1/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/**
 * Append the current site so the API scopes the request.
 *
 * ⚠️ The path must not already contain a query. `scoped("media&page=1")` used to
 * produce `media&page=1?site=default`, which matches no route and answers 404 —
 * and in the media picker that 404 was swallowed into an empty list, so the
 * search box looked like it had found nothing. Two call sites had it. The check
 * is three lines and the symptom is unrecognisable from the outside, which is
 * exactly when a check earns its place.
 */
export function scoped(path) {
  if (path.includes("&") && !path.includes("?")) {
    throw new Error(`scoped() got a query string, not a path: ${JSON.stringify(path)}`);
  }
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "site=" + encodeURIComponent(state.site);
}

/**
 * Stop the editor's autosave interval.
 *
 * One definition, in the shared leaf, because the timer is a **single
 * platform-wide** one: the editor starts it and navigation has to stop it.
 * It used to be cleared in only two of the editor's exit paths (`Back` and a
 * successful save), so leaving the editor through the sidebar — which goes
 * through `shell.go()` — left the interval running: it kept POSTing an
 * autosave every ten seconds while the user was looking at a different screen.
 * Nothing failed; the writes were just invisible.
 */
export function stopAutosave() {
  clearInterval(state.autosaveTimer);
  state.autosaveTimer = null;
}

/** Path for a content list, which may be a theme-declared custom post type. */
export function contentPath(type) {
  return ["posts", "pages"].includes(type) ? type : "content/" + type;
}

/**
 * Look up a post type's human labels.
 *
 * The two built-in types are named by the dictionary; a theme-declared type
 * keeps the labels its manifest shipped, because those are the theme author's
 * words and not the platform's to translate.
 */
export function postTypeInfo(type) {
  if (type === "posts") return { singular: t("core.content.post", "Post"), plural: t("core.content.posts", "Posts") };
  if (type === "pages") return { singular: t("core.content.page", "Page"), plural: t("core.content.pages", "Pages") };
  const pt = state.postTypes.find((p) => p.name === type);
  const singular = String(pt?.singular_label || pt?.label || type);
  const plural = String(pt?.plural_label || pt?.label || type);
  return { singular, plural };
}

/** Load the site list and the active theme's declared menus + CPTs + fields. */
export async function loadContext() {
  try { state.sites = (await api("sites")).items ?? []; } catch { state.sites = [{ id: "default", name: "Default Site" }]; }
  if (!state.sites.some((s) => s.id === state.site)) state.site = state.sites[0]?.id ?? "default";
  try { state.postTypes = (await api(scoped("theme/post-types"))).items ?? []; } catch { state.postTypes = []; }
  // One request for every declared menu, whatever its owner. The API has
  // already filtered out what this user may not see, so the SPA never has to
  // know which extension kind produced a row.
  try {
    const d = await api(scoped("admin-menus"));
    state.menuGroups = Array.isArray(d.groups) ? d.groups : [];
    state.adminMenus = Array.isArray(d.items) ? d.items : [];
  } catch {
    state.menuGroups = [];
    state.adminMenus = [];
  }
  // The user's own hidden-sidebar set. Fetched with the menu context on
  // purpose: a language switch re-runs loadContext(), and the sidebar must
  // re-render with both the translated labels AND the same hidden set.
  try {
    const p = await api("admin-menus/prefs");
    state.hiddenMenus = new Set(Array.isArray(p.hidden) ? p.hidden : []);
  } catch {
    state.hiddenMenus = new Set();
  }
  // The site-level menu customization (shared by every admin of this site).
  // Scoped to the site like the menus themselves; refetched by the same
  // language-switch / site-switch path so renames follow the UI locale.
  try {
    const cc = await api(scoped("admin-menus/custom"));
    state.menuCustom = {
      items: cc.items && typeof cc.items === "object" ? cc.items : {},
      groups: cc.groups && typeof cc.groups === "object" ? cc.groups : {},
    };
    state.menuCanManage = cc.can_manage === true;
  } catch {
    state.menuCustom = { items: {}, groups: {} };
    state.menuCanManage = false;
  }
  state.themeMenus = state.adminMenus.filter((m) => m.owner_type === "theme");
  state.pluginMenus = state.adminMenus.filter((m) => m.owner_type === "plugin");
  // Installed plugins with their declarations. The plugin-page screen and the
  // channel settings form render from this; the API parses the manifest, so
  // adminPages[] / channels[] arrive as real arrays.
  try {
    const d = await api("extensions/plugins");
    state.plugins = Array.isArray(d.items) ? d.items : [];
  } catch { state.plugins = []; }
  try { state.fields = (await api(scoped("theme/fields"))).items ?? []; } catch { state.fields = []; }
  try { state.blockTypes = (await api("blocks")).items ?? []; } catch { state.blockTypes = []; }
  // The languages this site serves. The editor needs them to offer a locale
  // picker and a language-version bar, and to know which locale a new piece of
  // content should start in.
  try {
    const d = await api("i18n/locales");
    const enabled = Array.isArray(d.enabled) ? d.enabled : [];
    state.locales = enabled;
    state.defaultLocale = d.default || enabled[0] || "en";
  } catch {
    state.locales = [];
    state.defaultLocale = "en";
  }
}
