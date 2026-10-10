/**
 * Admin SPA tests — the machine enforcement for `public/admin/`.
 *
 * The admin SPA is split into modules that talk to each other through a small
 * number of explicit seams. Two things can break silently when that structure
 * drifts, and neither is caught by any other suite:
 *
 *   1. **The `window.*` contract.** Rendered markup calls handlers with inline
 *      `onclick="name(...)"`, which the browser resolves against `window`. A
 *      handler that is not published there produces no build error, no console
 *      error and no failed request — the button just does nothing. This is the
 *      "page looks fine but clicking does nothing" regression.
 *
 *   2. **The module graph.** A circular import between the shell and a screen
 *      still loads in some browsers and not others; an orphaned module (written
 *      but never imported) is simply dead code that looks alive.
 *
 * Usage: node tests/suites/admin-spa.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync, cpSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "public/admin");
const ENTRY = join(ADMIN, "admin.js");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  // The condition must be a **boolean**, for the same reason as in
  // `architecture.test.mjs`: `check("…", someArray, …)` and
  // `check("…", someString, …)` both read as assertions and assert nothing,
  // because a non-empty array and a non-empty string are truthy. Writing this
  // suite's media section produced three of them in one sitting, which is the
  // argument for the guard being here too.
  //
  // ⚠️ Every suite in this repo has its own `check()`, so this guard is
  // per-suite — a shared assertion helper would be the real fix, and until then
  // a suite that has not been visited since is a suite where the mistake is
  // still silent.
  if (typeof condition !== "boolean") {
    const kind = Array.isArray(condition) ? "array" : condition === null ? "null" : typeof condition;
    throw new TypeError(
      `check("${name}") needs a boolean condition, got ${kind}: ${String(condition).slice(0, 90)}`
    );
  }
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/** Every import specifier in `src`, including bare `import "x"` side effects. */
function importSpecifiers(src) {
  const specs = [];
  // Strip block and line comments so prose examples do not register as imports.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/^\s*import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
    specs.push(m[1]);
  }
  return specs;
}

const jsFiles = walk(ADMIN, [".js"]);
const byPath = new Map(jsFiles.map((f) => [resolve(f), f]));

// ---------------------------------------------------------------------------
section("Module graph is resolvable and acyclic");
// ---------------------------------------------------------------------------

/** Resolve a relative specifier the way a browser would, including the `.js`. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare specifier — none exist today
  const abs = resolve(dirname(fromFile), spec);
  return byPath.has(abs) ? abs : undefined; // undefined = written but missing
}

const unresolved = [];
const graph = new Map();
for (const f of jsFiles) {
  const deps = [];
  for (const spec of importSpecifiers(read(f))) {
    const target = resolveSpecifier(f, spec);
    if (target === undefined) unresolved.push(`${rel(f)} -> ${spec}`);
    else if (target) deps.push(target);
  }
  graph.set(resolve(f), deps);
}

check(
  "every relative import resolves to a file that exists",
  unresolved.length === 0,
  unresolved.length ? `missing targets:\n       ${unresolved.join("\n       ")}` : ""
);

/** Depth-first cycle detection, reporting the actual cycle path. */
const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map([...graph.keys()].map((k) => [k, WHITE]));
const cycles = [];
function visit(node, stack) {
  colour.set(node, GREY);
  for (const dep of graph.get(node) ?? []) {
    if (colour.get(dep) === GREY) {
      const at = stack.indexOf(dep);
      cycles.push([...stack.slice(at), dep].map(rel).join(" → "));
    } else if (colour.get(dep) === WHITE) {
      visit(dep, [...stack, dep]);
    }
  }
  colour.set(node, BLACK);
}
for (const node of graph.keys()) if (colour.get(node) === WHITE) visit(node, [node]);

check(
  "module graph has no import cycles",
  cycles.length === 0,
  cycles.length ? `cycles:\n       ${cycles.join("\n       ")}` : ""
);

/** Reachability from the entry — catches a module nobody imports (dead code). */
const reachable = new Set();
(function mark(node) {
  if (reachable.has(node)) return;
  reachable.add(node);
  for (const dep of graph.get(node) ?? []) mark(dep);
})(resolve(ENTRY));

const orphans = [...graph.keys()].filter((k) => !reachable.has(k)).map(rel);
check(
  "every admin module is reachable from admin.js",
  orphans.length === 0,
  orphans.length ? `orphans (written but never imported): ${orphans.join(", ")}` : ""
);

// ---------------------------------------------------------------------------
section("window.* handler contract");
// ---------------------------------------------------------------------------

/**
 * The names the markup actually calls. Only a bare identifier followed by `(`
 * counts — `onclick="this.querySelector('input').focus()"` is not a window
 * handler and must not be reported as a missing one.
 *
 * Comments are stripped first: the entry point documents the pattern with a
 * literal `onclick="name(...)"` example, which would otherwise be read as a
 * real call to a handler called `name`.
 */
const inlineCalls = new Set();
for (const f of walk(ADMIN, [".js", ".html"])) {
  const code = read(f)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/onclick\s*=\s*["']([A-Za-z_$][\w$]*)\s*\(/g)) {
    inlineCalls.add(m[1]);
  }
}

/** Names published on `window`, from the entry map and any direct assignment. */
const published = new Set();
const entrySrc = read(ENTRY);
const mapBody = entrySrc.match(/const\s+WINDOW_HANDLERS\s*=\s*\{([\s\S]*?)\n\};/);
if (mapBody) {
  for (const line of mapBody[1].split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|:|$)/g)) published.add(m[1]);
  }
}
for (const f of jsFiles) {
  const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) published.add(m[1]);
}
published.delete("");

check(
  "the entry declares a WINDOW_HANDLERS map",
  Boolean(mapBody),
  "admin.js must publish the window.* contract in one visible place"
);

/**
 * The pinned contract: these 18 handlers existed before the module split and
 * must keep existing. Removing one is the "button silently does nothing" bug;
 * this list is what makes that a test failure instead of a support ticket.
 */
const EXPECTED_HANDLERS = [
  "toggleMenu", "closeMenus", "toggleGroup", "toggleSidebar", "go", "switchSite",
  "newContent", "editContent", "addBlock", "saveContent", "showRevisions", "deleteContent",
  "installExtension", "pluginSettings", "doLogin", "logout", "setThemeForTest",
];
const missingHandlers = EXPECTED_HANDLERS.filter((n) => !published.has(n));
check(
  `all ${EXPECTED_HANDLERS.length} pre-split window handlers are still published`,
  missingHandlers.length === 0,
  missingHandlers.length ? `no longer published: ${missingHandlers.join(", ")}` : ""
);

const missingForMarkup = [...inlineCalls].filter((n) => !published.has(n));
check(
  "every handler called from inline markup is published on window",
  missingForMarkup.length === 0,
  missingForMarkup.length
    ? `markup calls these but nothing publishes them: ${missingForMarkup.join(", ")}`
    : ""
);

check(
  "inline markup calls at least one handler (the check is not vacuous)",
  inlineCalls.size > 0,
  "no onclick=\"name(\" found anywhere — the scan or the markup changed"
);

// ---------------------------------------------------------------------------
section("Entry point stays thin (ratchet)");
// ---------------------------------------------------------------------------

/**
 * The split is the whole point of this suite: `admin.js` was 1514 lines and
 * every screen lived in it. If a screen grows back into the entry, the module
 * structure is decorative. The threshold is deliberately generous — it catches
 * a screen being pasted back in, not normal wiring edits.
 */
const entryLines = entrySrc.split("\n").length;
check(
  "admin.js is wiring only (< 120 lines)",
  entryLines < 120,
  `admin.js is ${entryLines} lines — a screen has probably moved back into it`
);

const screenDefsInEntry = [...entrySrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(dashboard|contentList|editor|media|resources|urls|settings|seo|sites|users|search|menus|widgets|themes|plugins|themeMenuScreen)\b/gm)];
check(
  "admin.js defines no screens",
  screenDefsInEntry.length === 0,
  screenDefsInEntry.length ? `found: ${screenDefsInEntry.map((m) => m[1]).join(", ")}` : ""
);

const screenFiles = walk(join(ADMIN, "js/screens"), [".js"]);
check(
  "screens are split into one module per screen (>= 15 files)",
  screenFiles.length >= 15,
  `found ${screenFiles.length} files under js/screens/`
);

// ---------------------------------------------------------------------------
section("Icon names referenced in code all exist");
// ---------------------------------------------------------------------------
//
// `icon("sliders")` used to be a silent near-miss: `icons.js` falls back to the
// `info` glyph for an unknown name, so a typo renders a *plausible* icon with
// no error anywhere — not a missing box, not a console warning, just the wrong
// picture. That is the same failure shape as the rest of this repo's
// "declared but never consumed" family, and it is invisible to every other
// check here (the module graph resolves, the screen renders, the entry stays
// thin).
//
// So: parse every literal `icon("name")` call site and require the name to be
// a key in the `PATHS` table. Prose mentions are stripped first — a comment
// saying `icon("x")` is documentation, not a call.

const iconsSrc = read(join(ADMIN, "icons.js"));
const iconNames = new Set(
  [...iconsSrc.matchAll(/^\s*"([a-z0-9-]+)":\s*'</gm)].map((m) => m[1])
);
check(
  "the icon table was parsed (non-vacuity)",
  iconNames.size > 30,
  `parsed ${iconNames.size} icon names from icons.js`
);

/** Strip comments so a documentation example is not read as a call. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const iconRefs = new Map(); // name -> [files]
for (const file of [...walk(join(ADMIN, "js"), [".js"]), join(ADMIN, "icons.js")]) {
  const src = stripComments(read(file));
  for (const m of src.matchAll(/\bicon\(\s*"([^"]+)"\s*[,)]/g)) {
    if (!iconRefs.has(m[1])) iconRefs.set(m[1], []);
    iconRefs.get(m[1]).push(rel(file));
  }
}
check(
  "icon() call sites were found (non-vacuity)",
  iconRefs.size > 10,
  `found ${iconRefs.size} distinct icon names across the admin`
);

const unknownIcons = [...iconRefs.entries()].filter(([name]) => !iconNames.has(name));
check(
  "every icon(\"...\") name is defined in the icon table",
  unknownIcons.length === 0,
  unknownIcons
    .map(([name, files]) => `icon("${name}") is not in PATHS — used in ${[...new Set(files)].join(", ")}`)
    .join("\n       ")
);

// `hasIcon()` is exported for callers that need to check before rendering; if
// nothing ever calls it, it is a vestigial export. Record it rather than assert
// on it, so the helper is not deleted as dead code while this suite relies on
// the same knowledge.
check(
  "icons.js exposes hasIcon() for callers that must check first",
  /export\s+const\s+hasIcon\s*=/.test(iconsSrc)
);

// ---------------------------------------------------------------------------
section("Entry point boots against a DOM stub");
// ---------------------------------------------------------------------------

/**
 * A real import, not a text scan. Node will not treat `public/admin/*.js` as
 * ESM without a `type: module` boundary, so the tree is copied to a temp dir
 * with one — which also keeps the check from depending on the repo's own
 * package.json.
 *
 * The stubs are deliberately minimal: enough for module bodies and the boot
 * sequence to run, so a top-level `ReferenceError` or a broken registration is
 * caught here rather than in a browser.
 */
function makeEl(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => makeEl("div"),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(node) { return node; },
    closest: () => null,
    focus() {},
  };
}

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e)));

let bootError = null;
let winStub = null;
let tmpDir = null;
let modules = null;
let contentEl = null;
let routeTable = null;
/** Every URL the SPA handed to `fetch`, in order — the base section reads it. */
let requestedUrls = null;
try {
  tmpDir = mkdtempSync(join(tmpdir(), "cfpress-admin-"));
  cpSync(ADMIN, tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');

  const appEl = makeEl("div");
  // Persistent, so a test can read back what a screen wrote into it.
  contentEl = makeEl("div");
  // Per-path payloads for the sections below that need real data (the editor
  // reads a single item). Anything not listed falls through to the empty-state
  // shape every screen already handles. Declared outside the `try` so the
  // render sections below can add routes.
  routeTable = new Map();
  requestedUrls = [];
  // One row, shaped so the list screens' row builders actually run (see the
  // fetch stub below). Fields are deliberately over-supplied: a screen reads
  // whichever ones it needs, and `undefined` is what a real sparse row looks
  // like anyway.
  const probeItem = {
    id: "probe", name: "Probe", title: "Probe", label: "Probe", slug: "probe",
    key: "probe", url: "/probe", path: "/probe", href: "/probe", target: "",
    locale: "en", code: "en", status: "published", type: "post", value: "probe",
    enabled: 1, active: 1, bundled: 0, sort_order: 0, parent_id: null,
    menu_id: "probe", location: "header", meta_key: "probe", field_type: "text",
    count: 0, host: null, path_prefix: null, is_default: 0, widget_type: "text",
    sidebar: "sidebar", config: "{}", content: "[]", excerpt: "",
    version: "1.0.0", description: "", icon: "file", screen: "probe",
    capability: "", created_at: 0, updated_at: 0, installed_at: 0,
    meta: {}, attrs: {}, query: {}, resolve: {}, post_types: [], supports: [],
    templates: [], capabilities: [], permissions: [], hooks: [], pages: [],
    locales: ["en"], groups: [], items: [], routes: [], blocks: [], fields: [],
    menu_locations: [], sidebars: [], settings: [], channels: [], adminMenus: [],
  };
  const store = new Map();
  winStub = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {}, scrollY: 0 };

  // ⚠️ The real shell is served by `serveAdminIndex`, which injects the admin
  // prefix as `window.CFP_ADMIN_BASE` — the SPA builds every API URL and asset
  // URL from it (there is no hard-coded `/admin` left, on purpose). The harness
  // is the fake shell, so it has to provide the same global; without it the SPA
  // falls back to `/admin` and every stubbed route below answers from the
  // default branch, which is how this suite went red the moment the base
  // landed. A *different* base here (see the base section) proves the SPA
  // actually reads it rather than the fallback.
  const TEST_ADMIN_BASE = "/admin";

  globalThis.window = winStub;
  winStub.CFP_ADMIN_BASE = TEST_ADMIN_BASE;
  globalThis.document = {
    documentElement: makeEl("html"),
    body: makeEl("body"),
    querySelector: (sel) => (sel === "#app" ? appEl : sel === "#content" ? contentEl : makeEl("div")),
    // Real browsers have it and a screen that reaches for it is not wrong — the
    // stub was. `menus` wires drag-and-drop through it, which only runs once a
    // menu exists, so the omission stayed invisible while the stub answered
    // every list with an empty one.
    getElementById: (id) => (id === "app" ? appEl : id === "content" ? contentEl : makeEl("div")),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.fetch = async (url, init) => {
    let path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    // The SPA now prefixes every API call with `CFP_ADMIN_BASE`, so the route
    // table (keyed by `/api/v1/...`) only matches after the base is stripped.
    // Recording the raw URLs lets the base section assert on what was requested.
    requestedUrls.push(String(url));
    if (path.startsWith(TEST_ADMIN_BASE + "/")) path = path.slice(TEST_ADMIN_BASE.length);
    if (routeTable.has(path)) {
      // A route may pin a status (`{ __status: 400, error: … }`) so a caller's
      // *failure* path is reachable from here. Without it every route answers
      // 200, and "the refusal is loud and changes nothing" cannot be observed
      // at all — the stub would be the reason the guard is vacuous.
      const body = routeTable.get(path);
      const status = Number(body && body.__status) || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }
    if (init && String(init.method || "GET").toUpperCase() !== "GET") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    // ⚠️ The default GET payload is deliberately **not** the empty-state shape.
    // A screen's row-building code only runs when the list has a row, so an
    // empty stub silently skips it — which is exactly how a screen that used an
    // identifier it never imported (`attr`, in the menus screen) rendered "fine"
    // here and threw in the browser the moment a menu existed. One generously
    // shaped item makes every list loop execute; a screen that cannot render it
    // is a genuine defect, not missing data.
    // Order matters: `probeItem` carries its own empty `items: []`, so it is
    // spread *first* and the one-row list written after it. Spreading last would
    // silently restore the empty-state shape this whole change exists to avoid.
    return { ok: true, status: 200, json: async () => ({ user: null, ...probeItem, items: [probeItem] }) };
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.location = { origin: "http://localhost" };
  globalThis.CSS = { escape: (s) => String(s) };

  await import(pathToFileURL(join(tmpDir, "admin.js")).href);
  // Let the boot IIFE settle so a rejection surfaces here.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  modules = {
    state: await import(pathToFileURL(join(tmpDir, "js/state.js")).href),
    shell: await import(pathToFileURL(join(tmpDir, "js/shell.js")).href),
    screens: await import(pathToFileURL(join(tmpDir, "js/screens/index.js")).href),
    // The editor is not in `SCREENS` (the content list delegates to it), so it
    // has to be reached directly to be rendered at all — see the last section.
    editor: await import(pathToFileURL(join(tmpDir, "js/screens/editor.js")).href),
    tableForm: await import(pathToFileURL(join(tmpDir, "js/table-form.js")).href),
    mediaScreen: await import(pathToFileURL(join(tmpDir, "js/screens/media.js")).href),
  };
} catch (e) {
  bootError = e;
}

check(
  "the entry point imports and boots without throwing",
  bootError === null,
  bootError ? String(bootError && bootError.stack ? bootError.stack.split("\n").slice(0, 4).join("\n       ") : bootError) : ""
);

check(
  "booting raises no unhandled rejection",
  unhandled.length === 0,
  unhandled.join("\n       ")
);

if (winStub) {
  const missingAtRuntime = EXPECTED_HANDLERS.filter((n) => typeof winStub[n] !== "function");
  check(
    "all window handlers are actually callable after boot",
    missingAtRuntime.length === 0,
    missingAtRuntime.length ? `not a function on window: ${missingAtRuntime.join(", ")}` : ""
  );
}

// ---------------------------------------------------------------------------
section("Every screen renders against the stub");
// ---------------------------------------------------------------------------

/**
 * Importing a module only proves its exports exist. A typo *inside* a screen
 * body — a helper that was never imported, a renamed variable — survives the
 * import and only shows up when that screen is opened. So every registered
 * page is actually rendered here, through the real shell dispatch.
 *
 * `fetch` returns `{ ok: true, json: { items: [] } }`, which is the empty-state
 * shape every screen already handles, so a throw here means a genuine defect
 * rather than missing data.
 */
if (modules && !bootError) {
  const { state } = modules.state;
  const { render } = modules.shell;
  const { SCREENS } = modules.screens;

  state.user = { username: "admin", role: "admin" };
  state.sites = [{ id: "default", name: "Default Site", is_default: 1 }];
  state.site = "default";

  const pages = [
    ...Object.keys(SCREENS),
    "cpt:news",        // dynamic prefix → content list
    "menu:anything",   // dynamic prefix → theme menu screen
  ];

  const renderErrors = [];
  for (const page of pages) {
    state.page = page;
    state.editing = null;
    contentEl.innerHTML = "";
    try {
      await render();
    } catch (e) {
      renderErrors.push(`${page}: threw ${e.message}`);
      continue;
    }
    // The shell catches a screen's exception and swaps in an error panel, so
    // `render()` resolving is *not* proof the screen worked. Read what was
    // actually written instead — this is the difference between a check and a
    // decoration.
    if (contentEl.innerHTML.includes("Something went wrong")) {
      // Carry the screen's own message into the failure. "rendered the error
      // panel" alone sends you back to the browser to find out *why*; the
      // message is already on the page.
      const msg = contentEl.innerHTML.match(/<p class="muted">([\s\S]*?)<\/p>/)?.[1] ?? "";
      renderErrors.push(`${page}: rendered the error panel${msg ? ` — ${msg}` : ""}`);
    }
    if (!contentEl.innerHTML) {
      renderErrors.push(`${page}: rendered nothing`);
    }
  }

  check(
    `all ${pages.length} registered pages render real content`,
    renderErrors.length === 0,
    renderErrors.join("\n       ")
  );

  state.page = "dashboard";
  await render();
  const shellHtml = modules.state.app.innerHTML;
  check(
    "the shell renders the sidebar, header and content mount",
    shellHtml.includes('class="sidebar"') && shellHtml.includes('id="app-header"') && shellHtml.includes('id="content"'),
    "the rendered shell markup is missing one of sidebar / header / content"
  );

  // -------------------------------------------------------------------------
  section("The URL is the page: hash routing");
  // -------------------------------------------------------------------------
  //
  // The admin is a single-page app, so without this the URL never changed: a
  // refresh, a bookmark or a link pasted to a colleague always landed on the
  // dashboard, and Back left the admin entirely instead of returning to the
  // previous screen. `pageToHash` / `hashToPage` are the two directions of one
  // mapping, and the round-trip is what makes a deep link survive.

  const { pageToHash, hashToPage } = modules.shell;

  // Every page grammar, including the two whose segments carry characters a
  // naive join mangles: a table slug with a slash, and one that is *already*
  // percent-encoded (encoding the whole page name would double-encode it).
  const PAGES = [
    // Every registered screen, so a new one that cannot round-trip is caught
    // here rather than in a bookmark that lands on the dashboard.
    ...Object.keys(SCREENS),
    "cpt:news",
    "menu:main",
    "table:product",
    "table-new:product",
    "table-edit:product:hello",
    "table-edit:product:a%2Fb",
    "plugin-page:probe",
  ];
  const badRound = PAGES.filter((p) => hashToPage(pageToHash(p, null))?.page !== p);
  check("every page name round-trips through the URL", badRound.length === 0, `failed: ${badRound.join(", ")}`);
  check("a colon becomes a path separator, not an escape",
    pageToHash("cpt:news", null) === "#/cpt/news", pageToHash("cpt:news", null));
  check("a segment containing a slash survives the round-trip",
    hashToPage(pageToHash("table-edit:product:a%2Fb", null))?.page === "table-edit:product:a%2Fb",
    hashToPage(pageToHash("table-edit:product:a%2Fb", null))?.page);

  // The editor is state *about* a page, not a page of its own — the content
  // list renders it — so its target rides along as a query on the fragment.
  check("editing an item names it in the URL",
    pageToHash("posts", { id: "post_1" }) === "#/posts?edit=post_1", pageToHash("posts", { id: "post_1" }));
  check("a new item says so", pageToHash("posts", { id: null }) === "#/posts?new=1", pageToHash("posts", { id: null }));
  const roundTrip = hashToPage("#/posts?edit=post_1");
  check("the editor target survives the round-trip",
    roundTrip?.page === "posts" && roundTrip?.edit === "post_1", JSON.stringify(roundTrip));
  check("an empty hash means 'no page chosen', not a crash", hashToPage("") === null);

  // The live app, both directions: navigating writes the URL, the URL navigates.
  const live = modules.state.state;
  live.page = "dashboard";
  live.editing = null;
  await modules.shell.go("widgets");
  check("navigating writes the page into the URL", globalThis.location.hash === "#/widgets", globalThis.location.hash);

  globalThis.location.hash = "#/menus";
  await modules.shell.applyHash();
  check("the URL navigates (boot / Back / a hand-edited hash)", live.page === "menus", live.page);
  check("and the screen it names is what rendered",
    contentEl.innerHTML.includes('id="menu-items-body"'), contentEl.innerHTML.slice(0, 120));

  globalThis.location.hash = "#/posts?edit=post_1";
  await modules.shell.applyHash();
  check("a deep link into the editor restores the item being edited",
    live.page === "posts" && live.editing?.id === "post_1",
    `${live.page} / ${live.editing?.id}`);

  // The editor's language-version bar loads asynchronously and re-renders when
  // it lands. Flush it here: left pending, it fires during the next section and
  // paints an *editing* editor over that section's new-item render.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

  // Leave the shared state where the sections below expect it.
  globalThis.location.hash = "";
  live.page = "dashboard";
  live.editing = null;

  // -------------------------------------------------------------------------
  section("The content editor renders, for a new item and an existing one");
  // -------------------------------------------------------------------------
  //
  // The editor is the one screen the loop above never touches: it is not in
  // `SCREENS` (the content list delegates to it when `state.editing` is set),
  // so everything about it was verified only in a browser — which is how three
  // silent defects lived there: the schedule was dropped on save, the autosave
  // interval survived navigation, and the locale control let you rewrite a
  // row's language.

  state.user = { username: "admin", role: "admin" };
  state.sites = [{ id: "default", name: "Default Site", is_default: 1 }];
  state.site = "default";
  state.locales = ["en", "zh-CN"];
  state.defaultLocale = "en";

  // A row with a schedule and a language, so the round trip has something to
  // round-trip.
  routeTable.set("/api/v1/posts/p1", {
    items: [{
      id: "p1", slug: "scheduled-post", slug_own: "scheduled-post", title: "Scheduled",
      excerpt: "x", locale: "zh-CN", status: "scheduled", content: "[]", meta: {},
      publish_at: 1790000000,
    }],
  });

  // `newContent` / `editContent` call `render()` without awaiting it (they are
  // called from click handlers, where nobody is waiting), so a test has to let
  // the render chain settle before reading the markup back. Same flush the boot
  // above uses.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  state.page = "posts";
  state.editing = null;
  contentEl.innerHTML = "";
  await modules.editor.newContent("posts");
  await settle();
  const newHtml = contentEl.innerHTML;
  check("a new item renders the editor",
    newHtml.includes('id="title"') && newHtml.includes('id="blocks"'), newHtml.slice(0, 160));
  check("and its locale picker is editable, because the choice is real",
    /<select id="locale"(?![^>]*disabled)/.test(newHtml),
    newHtml.match(/<select id="locale"[^>]*>/)?.[0] || "no locale select");
  check("a new item shows no schedule", /<input id="publishAt"[^>]*value=""/.test(newHtml),
    newHtml.match(/<input id="publishAt"[^>]*>/)?.[0] || "no publishAt input");
  modules.state.stopAutosave();

  contentEl.innerHTML = "";
  // Surfaced rather than swallowed: an exception here means the screen never
  // rendered, and every assertion below would then be reading the *list* markup
  // and reporting "no such control" — which points at the markup instead of at
  // the throw.
  let editError = null;
  try { await modules.editor.editContent("posts", "p1"); } catch (e) { editError = e; }
  await settle();
  check("loading an existing item does not throw", editError === null, editError ? editError.message : "");
  const editHtml = contentEl.innerHTML;
  check("the editor rendered, not the content list", editHtml.includes('id="blocks"'), editHtml.slice(0, 220));

  // The schedule survives the round trip. It used to render empty, so saving an
  // already-scheduled post sent `publish_at: null` and silently cancelled it.
  const publishAt = editHtml.match(/<input id="publishAt"[^>]*value="([^"]*)"/)?.[1];
  check("an existing item shows its schedule", publishAt === modules.tableForm.toLocalInput(1790000000),
    `rendered value=${JSON.stringify(publishAt)}`);
  check("and it is a real value, not an empty string", Boolean(publishAt));

  // The locale of an existing row is a fact, not a field: an editable select
  // would ask the API to move this version into another language, which is not
  // what "switch language" means — the version bar creates a sibling instead.
  check("an existing item's locale is not editable",
    /<select id="locale"[^>]*disabled/.test(editHtml),
    editHtml.match(/<select id="locale"[^>]*>/)?.[0] || "no locale select");

  // The autosave interval starts for an existing item and navigation stops it.
  // It used to be cleared in only two of the editor's exit paths, so leaving
  // through the sidebar left it POSTing while the user was on another screen.
  check("editing an existing item starts the autosave interval",
    state.autosaveTimer !== null && state.autosaveTimer !== undefined);
  await modules.shell.go("dashboard");
  check("and navigating away stops it", state.autosaveTimer === null);

  // -------------------------------------------------------------------------
  section("Switching a language version loads that language's row");
  // -------------------------------------------------------------------------
  //
  // Shared-row shape: one `posts` id carrying a translation row per language,
  // so `GET posts/{id}` returns *both* languages' content in one response.
  // The version bar used to answer a click on `zh-CN` by only relabelling
  // `state.editing.locale` — the title and the blocks stayed in the previous
  // language under the new language's name, and saving from that screen would
  // overwrite the other language with the wrong content. A 200 that destroys
  // data, and nothing on screen to say so.
  // The block area renders attribute controls from the server-declared
  // contract (`GET /api/v1/blocks`); without it a block is a bare container
  // and the body text appears nowhere in the markup — the stub must ship the
  // contract or the assertion below would be about a placeholder.
  routeTable.set("/api/v1/blocks", {
    items: [{ type: "core/paragraph", label: "Paragraph", attrs: [{ key: "text", type: "text", label: "Text" }] }],
  });
  routeTable.set("/api/v1/posts/p1", {
    items: [
      { id: "p1", slug: "two-languages", slug_own: null, locale: "en", title: "Two languages, one row",
        excerpt: "", status: "published", content: JSON.stringify([{ type: "core/paragraph", attrs: { text: "English body" } }]), meta: {} },
      { id: "p1", slug: "two-languages", slug_own: "liang-zhong-yu-yan", locale: "zh-CN", title: "两种语言，同一行",
        excerpt: "", status: "published", content: JSON.stringify([{ type: "core/paragraph", attrs: { text: "中文正文" } }]), meta: {} },
    ],
  });
  routeTable.set("/api/v1/i18n/translations", {
    versions: [
      { locale: "en", exists: 1, post_id: "p1" },
      { locale: "zh-CN", exists: 1, post_id: "p1" },
    ],
  });

  state.page = "posts";
  contentEl.innerHTML = "";
  await modules.editor.editContent("posts", "p1");
  await settle();
  check("opening a post unqualified opens the default language's row",
    state.editing?.locale === "en" && contentEl.innerHTML.includes('value="Two languages, one row"'),
    `locale=${state.editing?.locale}`);
  check("the version bar lists both languages",
    contentEl.innerHTML.includes('data-lang-version="zh-CN"'), contentEl.innerHTML.slice(0, 200));

  await modules.editor.switchVersion("zh-CN", true, "p1");
  await settle();
  check("switching versions loads the requested language's row, not a relabel",
    state.editing?.locale === "zh-CN" && contentEl.innerHTML.includes('value="两种语言，同一行"'),
    `locale=${state.editing?.locale}`);
  check("and the blocks come from that language's row",
    // `state.blocks` is what the editor renders *and* what saveContent sends,
    // so it is the load-bearing copy. (The harness's `querySelector("#blocks")`
    // returns a detached element, so the drawn markup is not readable back
    // from contentEl — the state is the honest assertion here.)
    JSON.stringify(state.blocks ?? []).includes("中文正文")
      && !JSON.stringify(state.blocks ?? []).includes("English body"),
    `blocks=${JSON.stringify(state.blocks).slice(0, 160)}`);
  check("and the bar marks the language now being edited",
    /<button class="btn primary[^"]*"[^>]*data-lang-version="zh-CN"/.test(contentEl.innerHTML),
    "no primary chip for zh-CN");
  await modules.state.stopAutosave();

  // The content list answers "does this post have a Chinese version yet" on
  // the row itself, with a badge per language version — it used to show one
  // locale badge and leave version discovery to opening every post.
  state.editing = null;
  routeTable.set("/api/v1/posts", {
    items: [
      { id: "p1", slug: "two-languages", locale: "en", title: "Two languages, one row",
        status: "published", locales: ["en", "zh-CN"], updated_at: 1790000000 },
      { id: "p2", slug: "en-only", locale: "en", title: "English only",
        status: "draft", locales: ["en"], updated_at: 1790000000 },
    ],
  });
  contentEl.innerHTML = "";
  await render();
  const listHtml = contentEl.innerHTML;
  check("the list shows a badge per language version the post has",
    listHtml.includes('<span class="badge primary">en</span> <span class="badge outline">zh-CN</span>')
      && listHtml.includes('<span class="badge primary">en</span></td>'),
    listHtml.match(/<td>(<span[^>]*>[^<]*<\/span>)+<\/td>/)?.[0] || "no locale cell");
  check("the list offers a language filter",
    listHtml.includes('id="contentLocale"') && listHtml.includes('value="zh-CN"'),
    "no contentLocale select");

  // -------------------------------------------------------------------------
  section("The media library screen: paging, filtering and tiles");
  // -------------------------------------------------------------------------
  //
  // The library screen was showing the first page of the list endpoint and
  // nothing else, so a library of 60 files looked like a library of 50. The
  // endpoint had supported `page` / `q` / `type` all along. The arithmetic and
  // the query string live in exported helpers so they are checkable here.

  const { mediaQuery, mediaPageInfo, mediaTileHtml, mediaGridHtml, mediaBodyHtml } = modules.mediaScreen;

  check("the query string asks for a page and a size", mediaQuery({}) === "page=1&limit=24", mediaQuery({}));
  check("and encodes the search and the MIME prefix",
    mediaQuery({ q: "a b", type: "image/", page: 3 }) === "page=3&limit=24&q=a%20b&type=image%2F",
    mediaQuery({ q: "a b", type: "image/", page: 3 }));
  check("a nonsense page falls back to the first", mediaQuery({ page: "x" }) === "page=1&limit=24", mediaQuery({ page: "x" }));

  const firstPage = mediaPageInfo({ page: 1, limit: 24, total: 50 });
  check("paging arithmetic knows there is more",
    JSON.stringify([firstPage.pages, firstPage.hasMore]) === "[3,true]",
    JSON.stringify([firstPage.pages, firstPage.hasMore]));
  check("and knows when it is done", mediaPageInfo({ page: 3, limit: 24, total: 50 }).hasMore === false);
  // A payload with nothing in it must not produce NaN, because `NaN < total` is
  // false and the "load more" button would simply never appear.
  const emptyPage = mediaPageInfo({});
  check("an empty payload yields real numbers",
    JSON.stringify([emptyPage.page, emptyPage.limit, emptyPage.total, emptyPage.hasMore]) === "[1,24,0,false]",
    JSON.stringify(emptyPage));

  const row = { id: "mf_9", object_key: "uploads/default/2026/10/shot.png", filename: "shot.png", mime_type: "image/png", size: 2048, alt_text: "A shot" };
  const tile = mediaTileHtml(row);
  check("a tile shows the image through the shared URL builder",
    tile.includes('src="/media/uploads%2Fdefault%2F2026%2F10%2Fshot.png"'), tile.slice(0, 160));
  check("and carries its alt text", tile.includes('value="A shot"'));
  check("and its id, for the delegated actions", tile.includes('data-media-alt="mf_9"') && tile.includes("data-media-del="));
  // `mediaItem()` refuses a row it cannot name, so a junk row produces no tile
  // rather than a broken one with an empty `src`.
  check("a row with no object key renders nothing", mediaTileHtml({ id: "x" }) === "", mediaTileHtml({ id: "x" }));
  check("an empty library renders the empty state",
    mediaGridHtml([]).includes("No media uploaded yet."), mediaGridHtml([]));
  check("and the footer reports the totals", mediaBodyHtml([row], { total: 50, hasMore: true }).includes("Showing 1 of 50"));

  // The screen itself: toolbar, drop zone, upload control, empty state.
  // This section is about the *empty* library, so it pins an empty list
  // explicitly — the stub's default is now one row (see the fetch stub).
  routeTable.set("/api/v1/media", { items: [] });
  contentEl.innerHTML = "";
  await modules.screens.SCREENS.media(contentEl);
  const mediaHtml = contentEl.innerHTML;
  check("the media screen renders its search and filter",
    mediaHtml.includes('id="media-q"') && mediaHtml.includes('id="media-type"'), mediaHtml.slice(0, 200));
  check("a drop zone and an upload control", mediaHtml.includes('id="media-drop"') && mediaHtml.includes('id="upload"'));
  check("and says the library is empty", mediaHtml.includes('class="empty"'));

  // -------------------------------------------------------------------------
  section("The themes screen reports which sites actually use a theme");
  // -------------------------------------------------------------------------
  //
  // `GET extensions/themes` reports usage as a **response-level** map
  // (`active_by_site`), not as a field on each item. The screen read
  // `x.active_by_site` — always `undefined` — so every theme that was not
  // active *here* claimed "Not in use", and its Uninstall button carried an
  // empty site list. The pre-emptive "still active on X" dialog was therefore
  // dead code, and the click went straight to the endpoint's 409: the operator
  // was told `still active on: acct` by a screen that had just said the theme
  // was unused. The payload carried the fact the whole time — the consumer
  // looked for it in the wrong place, which no other check here can see.

  state.user = { username: "admin", role: "admin" };
  state.sites = [{ id: "default", name: "Default Site", is_default: 1 }, { id: "acct", name: "Acct Test" }];
  state.site = "default";
  state.page = "appearance";
  state.editing = null;

  routeTable.set("/api/v1/extensions/themes", {
    items: [
      { name: "accttheme", title: "Acct Theme", version: "1.0.0", active: 0, bundled: 0 },
      { name: "shoptheme", title: "Shop Theme", version: "1.0.0", active: 1, bundled: 0 },
      // Bundled *and* not active here: the only reason this card has no
      // Uninstall is the bundled rule. (`default` is the sole bundled theme
      // since `journal` was removed from the product, so the case has to be
      // built by making the site's active theme a different one.)
      { name: "default", title: "MOBAI", version: "1.0.0", active: 0, bundled: 1 },
    ],
    active: "shoptheme",
    active_by_site: { default: "shoptheme", acct: "accttheme" },
    site: "default",
  });
  // The active theme's capability summary reads four endpoints; empty lists are
  // the shape every one of them already handles.
  for (const p of ["post-types", "routes", "fields", "blocks"]) routeTable.set(`/api/v1/theme/${p}`, { items: [] });

  contentEl.innerHTML = "";
  await render();
  const themeHtml = contentEl.innerHTML;
  check(
    "the themes screen rendered the installed themes",
    themeHtml.includes("Acct Theme") && themeHtml.includes("MOBAI") && themeHtml.includes("Shop Theme"),
    themeHtml.slice(0, 200)
  );
  check(
    "a theme another site uses names that site",
    themeHtml.includes("Also used by: acct"),
    themeHtml.match(/Also used by[^<]*/)?.[0] ?? "the card claims no other site uses it"
  );
  check(
    "and its uninstall button carries the site, so the click can explain itself",
    themeHtml.includes('data-theme-del-sites="acct"'),
    themeHtml.match(/data-theme-del-sites="[^"]*"/)?.[0] ?? "no uninstall button rendered"
  );
  check(
    "the theme active on this site offers no uninstall at all",
    !/data-theme-del="shoptheme"/.test(themeHtml),
    "the active theme rendered an uninstall button"
  );
  // A bundled theme has no package to remove: the route answers 400 for every
  // attempt, so the button must not be there in the first place.
  check(
    "a bundled theme says so instead of offering an uninstall",
    themeHtml.includes("Ships with CFPress") && !/data-theme-del="default"/.test(themeHtml),
    themeHtml.match(/data-theme-del="[^"]*"/g)?.join(", ") ?? "no uninstall buttons at all"
  );
}

// ---------------------------------------------------------------------------
section("The interface language has exactly one writer, and it repaints both viewers");
// ---------------------------------------------------------------------------
//
// One server fact, two client-side readers that refresh on different paths:
//
//   * the header switcher ticks from `currentLocale()` — module state in
//     `js/i18n.js`, set only by `setMessages()`, i.e. by `loadMessages()`;
//   * the Languages screen re-reads `GET i18n/ui-locale` from the server.
//
// The screen used to POST the preference itself and re-render without
// reloading the dictionary, so after saving, the panel said `zh-CN` while the
// top dropdown still ticked `en` — until a full page reload, which is why it
// survived every earlier check here. The defect is a *second writer*, so the
// guard is a scan for one, plus a runtime check that the one writer moves the
// tick without a reload.

const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE"];
const localeWriters = [];
for (const f of jsFiles) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(/i18n\/ui-locale/g)) {
    // The options object follows the path in both shapes — the raw `fetch` and
    // the `api()` wrapper — so a short window after the match sees the verb.
    const verb = src.slice(m.index, m.index + 160).match(/method:\s*"([A-Z]+)"/);
    if (verb && WRITE_VERBS.includes(verb[1])) localeWriters.push(rel(f));
  }
}
check(
  "only js/i18n.js writes the interface-language preference",
  localeWriters.length > 0 && localeWriters.every((f) => f === "public/admin/js/i18n.js"),
  localeWriters.length
    ? `writers found: ${[...new Set(localeWriters)].join(", ")} — a second writer leaves the header tick stale`
    : "no writer found anywhere: the scan is broken, not the code"
);

const i18nSrc = stripComments(read(join(ADMIN, "js/i18n.js")));
check(
  "and that one writer reloads the dictionary itself",
  /export async function setUiLocale[\s\S]*?await loadMessages\(\)/.test(i18nSrc),
  "setUiLocale() must end with `await loadMessages()` — a caller cannot be trusted to remember it, and forgetting it is the original bug"
);

// ---------------------------------------------------------------------------
section("The admin prefix is injected, never hard-coded");
// ---------------------------------------------------------------------------
//
// The admin can be moved (`admin.path`), and when it is, every absolute URL in
// the SPA points at a prefix that no longer exists — the SPA loads and then
// 404s on its own assets and API. The server injects the prefix into the shell
// as `window.CFP_ADMIN_BASE` and the SPA builds every URL from it, so the
// prefix lives in exactly one place per request.
//
// Two ways this regresses, and both are silent (the page renders, the network
// tab shows 404s a developer may not look at):
//
//   1. a module hard-codes `/api/v1/…` or `"/admin/…"` again;
//   2. the shell (`index.html`) drops the literal `/admin/` that
//      `serveAdminIndex` rewrites — the rewrite then has nothing to anchor on
//      and a moved admin keeps the old asset URLs.
//
// So the guard is a source scan for (1) plus a check that the shell still
// carries the anchors (2), and a runtime check that what the SPA *actually
// requested* came out prefixed.

/** The base the harness injected — the value the SPA must build URLs from. */
const baseCheck = [];
for (const f of jsFiles) {
  const src = stripComments(read(f));
  // A *bare* absolute URL: a string literal that begins `/api/v1`, `/api/` or
  // `/admin/` and is NOT the right-hand side of a concatenation. Correct code
  // always looks like `adminBase + "/api/v1/…"` (or a template), so the literal
  // is preceded by `+`; a bare one is passed straight to `fetch`/`api`. Comments
  // are already stripped, so surviving prose mentioning `/api/v1` is out.
  for (const m of src.matchAll(/(\S)(\s*)(["'`])(\/(?:api\/v1|api|admin)\/[^"'`]*)\3/g)) {
    const prev = m[1];
    if (prev === "+" || prev === "$" || prev === "{") continue; // concatenated / interpolated
    baseCheck.push(`${rel(f)}: ${m[4]}`);
  }
}
check(
  "no SPA module hard-codes an API or admin asset URL",
  baseCheck.length === 0,
  baseCheck.length
    ? `bare absolute URLs (build them from \`adminBase\` instead): ${baseCheck.join(", ")}`
    : ""
);

const shellSrc = read(join(ADMIN, "index.html"));
// The three anchors `serveAdminIndex` rewrites. If the shell stops containing
// them the rewrite is a no-op and a moved admin serves a shell pointing at
// `/admin/…` — the exact bug the injection exists to prevent.
const shellAnchors = (shellSrc.match(/["']\/admin\//g) || []).length;
check(
  "the shell still carries the /admin/ asset anchors the injection rewrites",
  shellAnchors >= 3,
  `found ${shellAnchors} quoted "/admin/…" anchors in index.html — serveAdminIndex expects at least the favicon, the stylesheet and the entry module`
);

// `state.js` and `i18n.js` are the two modules that talk to the network; both
// must derive the base from the global. One reads it as an exported const, the
// other inline (i18n.js is a leaf and cannot import state.js without a cycle),
// which is why this asserts the *global read*, not the import.
check(
  "state.js derives the API base from window.CFP_ADMIN_BASE",
  /window\.CFP_ADMIN_BASE/.test(stripComments(read(join(ADMIN, "js/state.js")))),
  "state.js must read window.CFP_ADMIN_BASE — a fallback constant alone re-hardcodes the prefix"
);
check(
  "i18n.js derives its API base from window.CFP_ADMIN_BASE too",
  /window\.CFP_ADMIN_BASE/.test(i18nSrc),
  "i18n.js is a leaf (cannot import state.js) so it reads the global directly — see the comment there"
);

if (modules && !bootError) {
  // Everything the SPA fetched during boot must have gone out under the
  // injected base. This is the runtime half of the two checks above: a scan
  // proves the source has no bare literal, this proves the requests are
  // prefixed. "Unprefixed" means it starts at `/api/…` (the base itself is
  // `/admin`, so a correct API URL starts with `/admin/`).
  const bare = requestedUrls.filter((u) => {
    const p = String(u).replace(/^https?:\/\/[^/]+/, "");
    return p.startsWith("/api/");
  });
  check(
    "every request the SPA made carried the injected base",
    requestedUrls.length > 0 && bare.length === 0,
    bare.length
      ? `unprefixed requests: ${[...new Set(bare)].slice(0, 5).join(", ")}`
      : "no requests were recorded — the stub is not seeing the SPA's traffic, so this proves nothing"
  );
}

if (modules && !bootError) {
  const i18n = await import(pathToFileURL(join(tmpDir, "js/i18n.js")).href);
  const { state } = modules.state;
  const { render } = modules.shell;

  state.user = { username: "admin", role: "admin" };
  state.sites = [{ id: "default", name: "Default Site", is_default: 1 }];
  state.site = "default";
  state.page = "dashboard";
  state.editing = null;

  /** The language the header dropdown currently ticks. */
  const tick = () => modules.state.app.innerHTML.match(/class="menu-item active"\s+data-ui-locale="([^"]+)"/)?.[1] ?? null;

  routeTable.set("/api/v1/i18n/messages", { locale: "en", messages: { "core.nav.dashboard": "Dashboard" } });
  await i18n.loadMessages();
  await render();
  check("the header ticks the dictionary's language to begin with", tick() === "en", `tick=${JSON.stringify(tick())}`);

  // The write path the Languages screen's Save button now takes.
  routeTable.set("/api/v1/i18n/messages", { locale: "zh-CN", messages: { "core.nav.dashboard": "仪表盘" } });
  await i18n.setUiLocale("zh-CN");
  await render();
  check(
    "saving a new interface language moves the header tick with no reload",
    tick() === "zh-CN",
    `tick=${JSON.stringify(tick())} after saving zh-CN — the two viewers disagree`
  );
  check("and the dictionary really switched with it", i18n.currentLocale() === "zh-CN", `locale=${JSON.stringify(i18n.currentLocale())}`);

  // A refused switch must be loud and must change nothing. The server answers
  // 400 for a locale with no pack; the messages route deliberately keeps
  // serving the old locale, because that is what a refused preference means —
  // the server's answer is unchanged, so nothing about this session should be.
  routeTable.set("/api/v1/i18n/ui-locale", { __status: 400, error: 'no interface pack for "xx"', available: ["en", "zh-CN"] });
  let refusal = null;
  try { await i18n.setUiLocale("xx"); } catch (e) { refusal = e; }
  check(
    "a refused interface language rejects instead of reporting success",
    refusal !== null && /no interface pack/.test(refusal.message),
    refusal ? `message=${JSON.stringify(refusal.message)}` : "resolved with no error — the caller's error path is unreachable"
  );
  await render();
  check("and leaves the interface language where it was", tick() === "zh-CN", `tick=${JSON.stringify(tick())}`);
  routeTable.delete("/api/v1/i18n/ui-locale");
}

if (tmpDir) {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir — fine */ }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  console.log(
    "\nThese guard the admin SPA's structure, not its styling. See docs/ARCHITECTURE.md §7.2."
  );
}
// One summary line only. The suite used to print `${failed ? "1" : "0"} failure(s)`
// *in addition* to the standard line — two summaries in two spellings, which is
// how a checker greps the wrong one and reads a crash as a pass (AGENTS.md
// "false green" type 6). The standard `${pass} passed, ${fail} failed` line is
// printed above and is the only one a script is allowed to parse.
process.exit(failed ? 1 : 0);
