/**
 * Admin SPA — shell: render loop, page chrome and navigation actions.
 *
 * This module owns `render()`, and therefore the *only* thing that knows how a
 * page name maps to a screen. It deliberately does **not** import any screen:
 * screens register themselves through `setScreenTable()` (called once by the
 * entry point), which is what keeps the module graph acyclic — screens import
 * the shell, the shell imports none of them.
 *
 * The login screen is injected the same way, by `auth.js`, for the same reason.
 */
import { app, loadContext, state, stopAutosave } from "./state.js";
import { header, rememberGroups, sidebar } from "./nav.js";
import { closeMenus, esc, setTheme, toast } from "../ui.js";
import { t, setUiLocale } from "./i18n.js";

let screens = new Map();
let loginScreen = null;
let hashEditor = null;

/** Wire the page-name → screen table. Called once from the entry point. */
export function setScreenTable(table) {
  screens = new Map(Object.entries(table));
}

/** Inject the screen shown when there is no session. Called once by auth.js. */
export function setLoginScreen(fn) {
  loginScreen = fn;
}

/**
 * Inject the editor's "open a new item" / "open an existing item" functions.
 * Called once from the entry point, for the same reason `setScreenTable` is:
 * the shell must not import a screen, or the module graph gains a cycle.
 *
 * They are needed because the editor is not a page of its own — the content
 * list renders it when `state.editing` is set — yet a URL that points at an
 * item being edited has to be restorable, or refreshing mid-edit silently
 * drops the user back to the list.
 */
export function setHashEditor(fns) {
  hashEditor = fns;
}

/**
 * `state.page` and the URL hash are two spellings of the same thing.
 *
 * The admin is a single-page app, and without this the URL never changed: a
 * refresh, a bookmark, or a link pasted to a colleague always landed on the
 * dashboard, and the browser's Back button left the admin entirely instead of
 * returning to the previous screen.
 *
 * Only the fragment is used — no History API — so the SPA stays servable from
 * any static host and needs no server-side route for a page name.
 *
 * The page-name grammar (`cpt:news`, `table-edit:product:<slug>`, …) keeps its
 * readable shape: `:` becomes a path separator and each segment is encoded on
 * its own, so `cpt:news` is `#/cpt/news`, not `#/cpt%3Anews`. Encoding per
 * segment — rather than encoding the whole name — is also what makes the
 * round-trip exact: a segment that itself contains `/`, `?` or `:` is
 * percent-encoded and comes back unchanged.
 *
 * The editor's target rides along as a query on the fragment
 * (`#/posts?edit=post_abc`, `#/posts?new=1`), because it is state *about* the
 * page, not a page: a path segment there would be indistinguishable from
 * another page-name segment when the hash is read back.
 */
export const pageToHash = (page, editing) => {
  const base = "#/" + String(page).split(":").map(encodeURIComponent).join("/");
  if (!editing) return base;
  return base + (editing.id ? "?edit=" + encodeURIComponent(editing.id) : "?new=1");
};

/** The inverse of `pageToHash`. Returns null when there is no page in the hash. */
export const hashToPage = (hash) => {
  const raw = String(hash || "").replace(/^#\/?/, "");
  if (!raw) return null;
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  const page = path.split("/").filter(Boolean).map(decodeURIComponent).join(":");
  if (!page) return null;
  const params = new URLSearchParams(query);
  return { page, edit: params.has("new") ? "new" : params.get("edit") };
};

/** The content type a content page edits (`cpt:news` → `news`). */
const typeFromPage = (page) => (page.startsWith("cpt:") ? page.slice(4) : page);

/**
 * Write `state.page` (+ the editor's target) into the URL.
 *
 * Called from `render()`, which is the single funnel every navigation path goes
 * through — `go()`, `switchSite()`, `newContent()`, `editContent()` all end
 * there — so no caller has to remember to update the URL, and none can forget.
 */
function syncHash() {
  if (typeof location === "undefined") return;
  const want = pageToHash(state.page, state.editing);
  if (location.hash === want) return;
  location.hash = want;
}

/**
 * Navigate to whatever the URL says. Called once at boot, and on `hashchange`
 * (Back / Forward / a hand-edited hash).
 *
 * An empty hash is not an error: it means "no page chosen yet", and the app
 * keeps its default and writes that page into the URL.
 */
export async function applyHash() {
  const parsed = typeof location === "undefined" ? null : hashToPage(location.hash);
  if (!parsed) { await render(); return false; }
  state.page = parsed.page;
  state.editing = null;
  stopAutosave();
  if (parsed.edit && hashEditor) {
    try {
      if (parsed.edit === "new") hashEditor.create(typeFromPage(parsed.page));
      else await hashEditor.edit(typeFromPage(parsed.page), parsed.edit);
    } catch {
      // A stale link to a deleted item must not leave a blank page: fall back
      // to the list, which is where the user can see that it is gone.
      state.editing = null;
      await render();
    }
    return true;
  }
  await render();
  return true;
}

// Back / Forward. The echo of our own `location.hash` write lands here too, so
// compare against what `syncHash` would produce and ignore a no-op — a flag
// would race the event, and the comparison cannot.
window.addEventListener("hashchange", () => {
  if (typeof location === "undefined") return;
  if (location.hash === pageToHash(state.page, state.editing)) return;
  applyHash();
});

export function closeDrawer() {
  document.querySelector(".layout")?.classList.remove("drawer-open");
  const scrim = document.querySelector(".scrim");
  if (scrim) scrim.hidden = true;
}

export function toggleGroup(id) {
  if (state.openGroups.has(id)) state.openGroups.delete(id);
  else state.openGroups.add(id);
  rememberGroups();
  render();
}

export function toggleSidebar() {
  // On mobile the collapsed rail is meaningless — toggle the drawer instead.
  if (window.matchMedia("(max-width: 1023px)").matches) {
    document.querySelector(".layout")?.classList.toggle("drawer-open");
    const scrim = document.querySelector(".scrim");
    if (scrim) scrim.hidden = !scrim.hidden;
    return;
  }
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("cfpress.admin.sidebar", state.sidebarCollapsed ? "1" : "0");
  document.querySelector(".layout")?.classList.toggle("collapsed", state.sidebarCollapsed);
}

export async function go(p) {
  state.page = p;
  state.editing = null;
  // Leaving the editor through the sidebar is still leaving the editor. Without
  // this the autosave interval survived navigation and kept POSTing while the
  // user was on another screen.
  stopAutosave();
  closeDrawer();
  closeMenus();
  await render();
}

export async function switchSite(id) {
  state.site = id;
  state.editing = null;
  stopAutosave();
  closeMenus();
  await loadContext();
  await render();
  const name = state.sites.find((s) => s.id === id)?.name || id;
  toast(t("core.msg.switchedTo", "Switched to {name}").replace("{name}", name));
}

/** Global click delegation for nav / theme / language / actions rendered as data attrs. */
document.addEventListener("click", (e) => {
  const themeBtn = e.target.closest("[data-theme]");
  if (themeBtn) {
    setTheme(themeBtn.dataset.theme);
    closeMenus();
    render();
    return;
  }
  // Interface language. Labels are translated server-side (menu labels) and
  // client-side (everything else), so a switch must refresh BOTH the
  // dictionary and the cached menu context before re-rendering — otherwise
  // the sidebar keeps the previous language until the next full load.
  const langBtn = e.target.closest("[data-ui-locale]");
  if (langBtn) {
    closeMenus();
    // `awaitWrap` renders in a `finally`, so the menu closes and the header
    // repaints whichever way this goes. A refusal has to be visible: a tick
    // that stays put with nothing on screen is what "the language switch does
    // nothing" looks like, and it is indistinguishable from a stale render.
    const code = langBtn.dataset.uiLocale;
    awaitWrap(
      setUiLocale(code)
        .then(() => loadContext())
        .catch((err) =>
          toast(t("core.msg.uiLocaleFailed", "Could not switch to {code}: {why}", { code, why: err.message }), "error")
        )
    );
    return;
  }
  const siteBtn = e.target.closest("[data-switch-site]");
  if (siteBtn) { switchSite(siteBtn.dataset.switchSite); return; }
  // Open the site's front end in a new window. The URL must respect the site's
  // path prefix (a shop mounted at /shop serves its front end at /shop/<locale>),
  // which is why it is built here rather than hardcoded to `/<locale>`.
  const view = e.target.closest("[data-view-site]");
  if (view) {
    const prefix = String(view.dataset.viewSitePrefix || "");
    window.open(`${prefix}/${state.defaultLocale}`, "_blank", "noopener");
    return;
  }
  const nav = e.target.closest("[data-nav]");
  if (nav) { go(nav.dataset.nav); return; }
});

async function awaitWrap(p) {
  try { await p; } finally { await render(); }
}

/** Cmd/Ctrl+K focuses search. */
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    go("search");
  }
});

/** Add a shadow to the sticky header once the page scrolls. */
function wireHeaderShadow() {
  const h = document.querySelector("#app-header");
  if (!h) return;
  const onScroll = () => h.classList.toggle("scrolled", window.scrollY > 10);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

function breadcrumb(parts) {
  return `<nav class="breadcrumb">${parts
    .map((p, i) => {
      const isLast = i === parts.length - 1;
      const crumb = isLast ? `<span class="cur">${esc(p.label)}</span>` : `<span>${esc(p.label)}</span>`;
      return (i ? `<span class="sep">/</span>` : "") + crumb;
    })
    .join("")}</nav>`;
}

/** Page header: optional breadcrumb + title + subtitle + actions. */
export function pageHead({ title, sub = "", actions = "", crumbs = null }) {
  return `${crumbs ? breadcrumb(crumbs) : ""}
  <div class="top">
    <div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

/**
 * Resolve a page name to a screen. Five prefixes are dynamic:
 * `cpt:<name>` (a theme-declared post type), `menu:<id>` (a declared admin
 * menu), the two table pages — `table:<table>` for the list and
 * `table-edit:<table>[:<slug>]` / `table-new:<table>` for the form — and
 * `plugin-page:<id>` (a plugin-declared page, ARCHITECTURE.md §5.3).
 *
 * The table pages use three distinct prefixes rather than one prefix plus an
 * optional segment. An earlier version used `table:<table>[:<slug>]`, which
 * made "the list" and "a new row" the *same* page name when the slug was
 * absent — so the Add button navigated to the list it was already on and
 * nothing happened. Three prefixes cannot collide that way, and the absence of
 * a slug no longer has to mean two different things.
 */
async function renderScreen(c, page) {
  if (page.startsWith("cpt:")) return screens.get("content-list")(c, page.slice(4));
  if (page.startsWith("menu:")) return screens.get("theme-menu")(c, page.slice(5));
  if (page.startsWith("table-new:")) {
    return screens.get("table-edit")(c, page.slice("table-new:".length) || null, null);
  }
  if (page.startsWith("table-edit:")) {
    const rest = page.slice("table-edit:".length);
    const at = rest.indexOf(":");
    const table = at === -1 ? rest : rest.slice(0, at);
    // The slug was percent-encoded when the page name was built, because a
    // slug may contain anything a URL path segment may contain.
    const slug = at === -1 ? null : decodeURIComponent(rest.slice(at + 1));
    return screens.get("table-edit")(c, table || null, slug || null);
  }
  if (page.startsWith("table:")) {
    return screens.get("table-list")(c, page.slice("table:".length) || null);
  }
  if (page.startsWith("plugin-page:")) {
    // A plugin-declared admin page. The id is the manifest's own `adminPages[].id`,
    // validated at install time to exist — so a page that cannot be found here
    // means the plugin was disabled after its menu was written, not a bad link.
    return screens.get("plugin-page")(c, page.slice("plugin-page:".length) || null);
  }
  const screen = screens.get(page);
  if (!screen) {
    c.innerHTML = `<div class="panel">${esc(page)} ${esc(t("core.msg.notAScreen", "is not a screen."))}</div>`;
    return;
  }
  return screen(c);
}

export async function render() {
  if (!state.user) return loginScreen ? loginScreen() : undefined;
  // The URL is a rendering of "where am I", so it is written here rather than
  // by each navigation path — see `syncHash`.
  syncHash();

  app.innerHTML = `<div class="layout${state.sidebarCollapsed ? " collapsed" : ""}">
    ${sidebar()}
    <div class="main">
      ${header()}
      <div class="page" id="content"></div>
    </div>
    <div class="scrim" hidden onclick="toggleSidebar()"></div>
  </div>`;
  wireHeaderShadow();

  const c = document.querySelector("#content");
  try {
    await renderScreen(c, state.page);
  } catch (e) {
    c.innerHTML = `<div class="panel"><div class="top" style="margin-bottom:.5rem"><h1 style="font-size:1.125rem">${esc(t("core.msg.wentWrong", "Something went wrong"))}</h1></div><p class="muted">${esc(e.message)}</p></div>`;
  }
}
