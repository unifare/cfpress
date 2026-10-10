/**
 * Unified admin menu registry (ARCHITECTURE.md §4.4).
 *
 * Two things are worth a dedicated suite, and neither is caught by the theme
 * or plugin suites:
 *
 *   1. **Ownership isolation.** "Disabling a plugin removes only its menus" is
 *      the whole reason `owner_type`/`owner_name` exist. A regression here
 *      looks like a working admin until someone switches a theme and loses a
 *      plugin's menu, or disables a plugin and loses the theme's.
 *   2. **The migrated table is really gone.** `theme_admin_menus` was dropped in
 *      0012. If it comes back — or if the copy-out silently ran on an empty
 *      source — the registry would look fine while the old rows were stranded.
 *
 * Runs the REAL Worker source against the REAL local D1, same as the other
 * integration suites. Usage: node tests/suites/admin-menus.test.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}

async function bundle(entry, tag) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", `test-${tag}.mjs`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

const compileWorker = () => bundle("src/index.ts", "bundle-menus");
const compileMenus = () => bundle("src/platform/admin-menus.ts", "bundle-menus-mod");

// ---------------------------------------------------------------------------
// D1 / R2 / KV stand-ins — same shape as the other integration suites
// ---------------------------------------------------------------------------
function makeD1(sqlite) {
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      const api = {
        bind(...args) { stmt.params = args; return api; },
        async first(col) {
          const row = sqlite.prepare(stmt.sql).get(...stmt.params);
          if (col !== undefined && row) return row[col];
          return row ?? null;
        },
        async all() {
          const rows = sqlite.prepare(stmt.sql).all(...stmt.params);
          return { results: rows, success: true, meta: {} };
        },
        async run() {
          const r = sqlite.prepare(stmt.sql).run(...stmt.params);
          return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return {
        async text() { return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body); },
        body: entry.body, httpEtag: '"test"', writeHttpMetadata() {},
      };
    },
    async put(key, value) { store.set(key, { body: value }); return { key }; },
    async delete(key) { store.delete(key); },
  };
}

function makeEnv(sqlite) {
  const m = new Map();
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } },
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init) {
  return worker.fetch(new Request("http://localhost" + path, init), env, { waitUntil() {}, passThroughOnException() {} });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const THEME = "menusdemo";
const PLUGIN = "notify";

function buildThemeZip() {
  const manifest = {
    name: THEME,
    title: "Menu Demo",
    version: "1.0.0",
    supports: ["blocks"],
    templates: ["index"],
    tables: [
      {
        name: "product",
        label: "Products",
        fields: [
          { key: "name", type: "text", label: "Name" },
          { key: "price", type: "number", label: "Price" },
        ],
        translatable: ["name"],
      },
    ],
    // One table, two menus: a generated list and the theme's own settings page.
    adminMenus: [
      { id: "products", label: "Products", icon: "box", screen: "table-list", args: { table: "product" } },
      { id: "shop-settings", label: "Shop Settings", icon: "settings", screen: "theme-settings" },
    ],
    runtime: "declarative",
  };
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(`<!doctype html><html><head><title>{{page.title}}</title></head><body>MENUSDEMO</body></html>`),
  });
}

function buildPluginZip() {
  // Read the *shipped* plugin manifest when it exists, so the test proves the
  // real one validates and registers rather than a fixture written to match the
  // code. `content/plugins/notify` is the reference plugin; until it lands, fall back to
  // an inline manifest equivalent to the retired `content/plugins/seo` one, so this
  // suite keeps its coverage either way.
  const shipped = join(root, "content", "plugins", PLUGIN, "plugin.json");
  const manifest = existsSync(shipped)
    ? JSON.parse(readFileSync(shipped, "utf8"))
    : {
        name: PLUGIN,
        title: "Notify",
        version: "1.0.0",
        permissions: ["content.read", "settings.read", "settings.write"],
        hooks: ["beforeRender", "html"],
        adminMenus: [
          { id: "notify-settings", label: "Notify Settings", icon: "chart", screen: "plugin-settings", capability: "settings.read" },
        ],
        settings: [
          { key: "title_template", label: "Title template", type: "text", default: "%title% | %site%" },
          { key: "default_description", label: "Default description", type: "textarea", default: "" },
        ],
      };
  return { zip: zipSync({ "plugin.json": strToU8(JSON.stringify(manifest, null, 2)) }), manifest };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dbDir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  const dbf = readdirSync(dbDir).find((x) => x.endsWith(".sqlite"));
  const sqlite = new DatabaseSync(join(dbDir, dbf));

  // Idempotent teardown of this suite's fixtures, run at BOTH ends: up front so
  // a failed previous run cannot change what this one observes, and again at the
  // end so the shared local D1 — the file `wrangler dev` serves — keeps no
  // phantom rows. This suite *uploads* `notify` (the reference plugin in
  // `content/plugins/`), so the plugin is its own fixture and comes back out
  // here; a suite that swept only up front left a disabled Notify and the
  // `menusdemo` theme table sitting in the operator's admin.
  const sweep = () => {
    for (const sql of [
      `DELETE FROM admin_menu_registry WHERE owner_name='${THEME}'`,
      `DELETE FROM admin_menu_registry WHERE owner_type='plugin'`,
      `DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='${THEME}'`,
      `DELETE FROM post_types WHERE declared_by_theme='${THEME}'`,
      `DELETE FROM field_defs WHERE declared_by_theme='${THEME}'`,
      `DELETE FROM theme_routes WHERE declared_by_theme='${THEME}'`,
      `DELETE FROM extension_capabilities WHERE extension_name='${THEME}'`,
      `DELETE FROM extension_versions WHERE extension_name='${THEME}'`,
      `DROP TABLE IF EXISTS theme_${THEME}_product_i18n`,
      `DROP TABLE IF EXISTS theme_${THEME}_product`,
      `DELETE FROM theme_installs WHERE name='${THEME}'`,
      "DELETE FROM sites WHERE id='menusite2'",
      "DELETE FROM settings WHERE site_id='menusite2'",
      "DELETE FROM site_locales WHERE site_id='menusite2'",
      // `notify` is installed by this suite through the upload API.
      "DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name='notify')",
      "DELETE FROM plugin_setting_defs WHERE plugin_name='notify'",
      "DELETE FROM extension_capabilities WHERE extension_type='plugin' AND extension_name='notify'",
      "DELETE FROM extension_versions WHERE extension_name='notify'",
      "DELETE FROM theme_table_defs WHERE owner_type='plugin' AND owner_name='notify'",
      "DROP TABLE IF EXISTS plugin_notify_log_i18n",
      "DROP TABLE IF EXISTS plugin_notify_log",
      "DELETE FROM plugin_installs WHERE name='notify'",
    ]) { try { sqlite.exec(sql); } catch { /* table may not exist yet */ } }
  };
  sweep();

  const worker = (await compileWorker()).default;
  const menus = await compileMenus();
  const env = makeEnv(sqlite);

  // -- 1. schema -----------------------------------------------------------
  console.log("\n1. 0012 landed and retired the old table");
  const tableNames = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin_menu_registry','theme_admin_menus')")
    .all()
    .map((r) => r.name);
  check("admin_menu_registry exists", tableNames.includes("admin_menu_registry"), true);
  check("theme_admin_menus is gone", tableNames.includes("theme_admin_menus"), false);
  const ddl = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='admin_menu_registry'").get().sql;
  checkTruthy(
    "the UNIQUE constraint includes the owner (otherwise two themes collide)",
    ddl.includes("UNIQUE(site_id, owner_type, owner_name, menu_id)")
  );

  // -- 2. row ids ----------------------------------------------------------
  console.log("\n2. Row ids are collision-proof, not just readable");
  // `acme-shop` and `acme_shop` both slug to `acme_shop`. If the id were built
  // from the slug alone these two owners would share a primary key and the
  // second registration would silently overwrite the first.
  const idA = menus.menuRowId("theme", "acme-shop", "default", "main");
  const idB = menus.menuRowId("theme", "acme_shop", "default", "main");
  checkTruthy("two owners whose names slug identically get different ids", idA !== idB);
  check("the id is stable for the same tuple", menus.menuRowId("theme", "acme-shop", "default", "main"), idA);

  // -- 3. ownership isolation (module level) --------------------------------
  console.log("\n3. Clearing one owner leaves the others alone");
  // Two owners of the SAME type, on purpose. Comparing a theme against a plugin
  // only exercises the `owner_type` half of the predicate — a `clearOwnerMenus`
  // that ignored `owner_name` would pass that. The pair below cannot.
  await menus.registerOwnerMenus(env, "default", "theme", "ownerA", [
    { id: "a1", screen: "theme-settings", label: "A1" },
    { id: "a2", screen: "theme-settings", label: "A2" },
  ]);
  await menus.registerOwnerMenus(env, "default", "theme", "ownerC", [
    { id: "c1", screen: "theme-settings", label: "C1" },
  ]);
  await menus.registerOwnerMenus(env, "default", "plugin", "ownerB", [
    { id: "b1", screen: "plugin-settings", label: "B1" },
  ]);
  const before = await menus.listAdminMenus(env, "default", { ownerName: "ownerA" });
  check("owner A has its two menus", before.length, 2);

  await menus.clearOwnerMenus(env, "default", "theme", "ownerC");
  check("clearing theme C leaves theme A intact", (await menus.listAdminMenus(env, "default", { ownerName: "ownerA" })).length, 2);
  check("clearing theme C removed C", (await menus.listAdminMenus(env, "default", { ownerName: "ownerC" })).length, 0);

  await menus.clearOwnerMenus(env, "default", "plugin", "ownerB");
  check("clearing plugin B leaves theme A intact", (await menus.listAdminMenus(env, "default", { ownerName: "ownerA" })).length, 2);
  check("clearing plugin B removed B", (await menus.listAdminMenus(env, "default", { ownerName: "ownerB" })).length, 0);

  // Re-registering is a replace, not an append — otherwise a theme that drops
  // a menu from its manifest would keep the orphan forever.
  await menus.registerOwnerMenus(env, "default", "theme", "ownerA", [
    { id: "a1", screen: "theme-settings", label: "A1 renamed" },
  ]);
  const after = await menus.listAdminMenus(env, "default", { ownerName: "ownerA" });
  check("re-registering replaces rather than appends", after.length, 1);
  check("the surviving row was updated", after[0].label, "A1 renamed");

  // -- 4. ordering ---------------------------------------------------------
  console.log("\n4. Groups are ordered core → theme → plugin");
  await menus.registerOwnerMenus(env, "default", "core", "core", [{ id: "dash", screen: "dashboard", label: "Dash" }]);
  const grouped = await menus.listAdminMenuGroups(env, "default");
  const ownerOrder = grouped.map((g) => g.owner_type);
  const rank = { core: 0, theme: 1, plugin: 2 };
  checkTruthy(
    "owner types are non-decreasing by rank",
    ownerOrder.every((t, i) => i === 0 || rank[ownerOrder[i - 1]] <= rank[t])
  );
  const flat = await menus.listAdminMenus(env, "default");
  checkTruthy("the flat list starts with the core menu", flat[0]?.owner_type === "core");
  check("groups partition the flat list", grouped.reduce((n, g) => n + g.items.length, 0), flat.length);

  // -- 5. capability filter ------------------------------------------------
  console.log("\n5. Capability filtering hides, it does not break");
  await menus.registerOwnerMenus(env, "default", "plugin", "gated", [
    { id: "open", screen: "plugin-settings", label: "Open" },
    { id: "locked", screen: "plugin-settings", label: "Locked", capability: "settings.write" },
  ]);
  const noFilter = await menus.listAdminMenus(env, "default", { ownerName: "gated" });
  check("without a filter both menus are visible", noFilter.length, 2);
  const filtered = await menus.listAdminMenus(env, "default", {
    ownerName: "gated",
    can: (cap) => cap !== "settings.write",
  });
  check("a menu the viewer cannot use is hidden", filtered.length, 1);
  check("the ungated menu survives", filtered[0].menu_id, "open");
  const throwing = await menus.listAdminMenus(env, "default", {
    ownerName: "gated",
    can: () => { throw new Error("capability backend down"); },
  });
  check("a failing capability check hides its menu instead of failing the page", throwing.length, 1);

  await menus.clearOwnerMenus(env, "default", "theme", "ownerA");
  await menus.clearOwnerMenus(env, "default", "core", "core");
  await menus.clearOwnerMenus(env, "default", "plugin", "gated");

  // -- 6. bootstrap + auth -------------------------------------------------
  console.log("\n6. Admin bootstrap & auth");
  await req(worker, env, "/api/v1/auth/me");
  const loginRes = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const loginBody = await loginRes.json();
  checkTruthy("admin can log in", loginBody.user);
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const auth = { Cookie: cookie };

  // -- 7. theme menus go through the registry ------------------------------
  console.log("\n7. A theme's declared menus land in the registry");
  const fd = new FormData();
  fd.append("file", new File([buildThemeZip()], `${THEME}.zip`, { type: "application/zip" }));
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
  check("theme upload accepted", up.status, 201);

  const act = await req(worker, env, `/api/v1/extensions/themes/${THEME}/activate?site=default`, {
    method: "POST", headers: auth,
  });
  const actBody = await act.json();
  check("activation applied both menus", actBody.applied?.adminMenus, 2);

  const themeMenus = await (await req(worker, env, "/api/v1/theme/menus?site=default", { headers: auth })).json();
  check("theme/menus returns the two declared menus", themeMenus.items.length, 2);
  checkTruthy("its rows carry menu_id (the SPA's page key)", themeMenus.items.every((m) => m.menu_id));

  const all = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  const themeGroup = all.groups.find((g) => g.owner_type === "theme" && g.owner_name === THEME);
  checkTruthy("admin-menus groups the theme's menus under its owner", themeGroup);
  check("the group holds both menus", themeGroup?.items.length, 2);
  checkTruthy(
    "the table-list menu kept its args",
    themeGroup?.items.some((m) => m.screen === "table-list" && m.args?.table === "product")
  );

  // The generated table really exists — a menu pointing at nothing would still
  // render a page, just an empty one.
  const genTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='theme_menusdemo_product'")
    .get();
  checkTruthy("the declared table was materialised", genTable);

  // -- 8. plugin menus -----------------------------------------------------
  console.log("\n8. A plugin registers a menu through the same path");
  const { zip, manifest } = buildPluginZip();
  checkTruthy("the shipped SEO plugin declares an admin menu", Array.isArray(manifest.adminMenus) && manifest.adminMenus.length > 0);
  const pfd = new FormData();
  pfd.append("file", new File([zip], `${PLUGIN}.zip`, { type: "application/zip" }));
  const pup = await req(worker, env, "/api/v1/extensions/plugins/upload", { method: "POST", headers: auth, body: pfd });
  check("plugin upload accepted", pup.status, 201);

  const en = await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });
  check("plugin enabled", en.status, 200);
  const withPlugin = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  const pluginGroup = withPlugin.groups.find((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN);
  checkTruthy("the plugin's menu appears", pluginGroup);
  check("with the declared menu id", pluginGroup?.items[0]?.menu_id, manifest.adminMenus[0].id);
  check("and its screen", pluginGroup?.items[0]?.screen, manifest.adminMenus[0].screen);

  // -- 9. disabling removes only that plugin's menus -----------------------
  console.log("\n9. Disabling a plugin removes only its menus");
  await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/disable`, { method: "POST", headers: auth });
  const afterDisable = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  check(
    "the plugin's group is gone",
    afterDisable.groups.some((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN),
    false
  );
  const themeStill = afterDisable.groups.find((g) => g.owner_type === "theme" && g.owner_name === THEME);
  check("the theme's menus are untouched", themeStill?.items.length, 2);

  // -- 10. plugin menus are install-wide -----------------------------------
  console.log("\n10. Plugin menus reach a site that never activated the theme");
  const created = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "menusite2", name: "Menu Site 2" }),
  });
  check("second site created", created.status, 201);
  await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });

  const site2 = await (await req(worker, env, "/api/v1/admin-menus?site=menusite2", { headers: auth })).json();
  checkTruthy(
    "the plugin menu shows on the new site without any extra step",
    site2.groups.some((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN)
  );
  check(
    "the theme's menus do NOT leak to a site that never activated it",
    site2.groups.some((g) => g.owner_type === "theme" && g.owner_name === THEME),
    false
  );

  // -- 11. re-enable restores ----------------------------------------------
  console.log("\n11. Re-enabling restores the menus from the manifest");
  await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/disable`, { method: "POST", headers: auth });
  await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });
  const back = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  checkTruthy(
    "the plugin's menu is back",
    back.groups.some((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN)
  );

  // -- 12. switching the theme back ----------------------------------------
  console.log("\n12. Switching the theme away hides its menus but keeps its table");
  await req(worker, env, "/api/v1/extensions/themes/default/activate?site=default", { method: "POST", headers: auth });
  const switched = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  check(
    "the outgoing theme's menus are gone",
    switched.groups.some((g) => g.owner_type === "theme" && g.owner_name === THEME),
    false
  );
  checkTruthy(
    "its table survives (switching hides data, it never destroys it)",
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='theme_menusdemo_product'").get()
  );
  await req(worker, env, `/api/v1/extensions/themes/${THEME}/activate?site=default`, { method: "POST", headers: auth });
  const restored = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
  checkTruthy(
    "switching back restores its menus",
    restored.groups.some((g) => g.owner_type === "theme" && g.owner_name === THEME)
  );

  // -- cleanup -------------------------------------------------------------
  // Leave the shared local D1 as we found it (see `sweep` above), then put the
  // bundled default theme back on the default site: the suite activated a
  // fixture there, and the front end must not keep rendering it.
  sweep();
  await req(worker, env, "/api/v1/extensions/themes/default/activate?site=default", { method: "POST", headers: auth });

  sqlite.close();

  summary();
  return fail ? 1 : 0;
}

/**
 * The summary every suite must print, in the one format a reader or a script
 * can parse. This suite used to print `${fail ? 1 : 0} failure(s)` *in addition*
 * to the standard line — two summaries in two spellings, which is how a checker
 * greps the wrong one and reads a crash as a pass.
 */
function summary(note) {
  console.log("\n" + "=".repeat(64));
  console.log(`${pass} passed, ${fail} failed${note ? ` (${note})` : ""}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a summary, and it must say it failed.
  // Without this, a suite that throws mid-way leaves no parseable line and
  // "I could not tell" is silently read as "it passed" (AGENTS.md type 6).
  fail++;
  failures.push(`harness threw: ${(e && e.message) || e}`);
  summary("aborted");
  code = 2;
}
process.exit(code);
