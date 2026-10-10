/**
 * Site-level admin menu customization (batch 5).
 *
 * Covers:
 *   1. GET/PUT/DELETE /api/v1/admin-menus/custom — the per-site JSON blob
 *      (item label overrides per UI locale, item ordering, cross-group moves,
 *      site-wide hiding; the same for groups)
 *   2. Permission split — GET is for every signed-in user, PUT/DELETE need
 *      settings.manage (an author gets 403; can_manage echoes the check)
 *   3. Validation — structural violations are 400s with a message, unknown
 *      fields are stripped, limits are enforced
 *   4. Per-site isolation — ?site= scopes the blob
 *   5. `applyMenuCustom` (nav.js) — the pure function both the sidebar and
 *      the editor consume: rename resolution (locale → en → built-in),
 *      stable ordering, cross-group moves, drops to nonexistent groups,
 *      siteHidden flags, group label/order overrides
 *
 * Runs against the REAL worker bundle and the REAL local D1. The suite cleans
 * only its own rows (settings key admin.menu.custom, `mtest-*` user) and never
 * touches the admin account's own data beyond logging in.
 *
 * Usage: node tests/suites/menu-custom.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
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
function summary(tag = "") {
  // Always exit explicitly. Relying on the event loop draining means a harness
  // that runs this suite in a worker thread (see tests/tools/_residue-guard.mjs)
  // never sees a completion signal, and reads "I could not tell" as a failure —
  // the same "no summary" trap AGENTS.md warns about, one layer out.
  console.log(`\n${pass} passed, ${fail} failed${tag}`);
  process.exit(fail ? 1 : 0);
}

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "menu-custom-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function makeD1(sqlite) {
  return {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async first(c) { const r = sqlite.prepare(st.sql).get(...st.params); return c !== undefined && r ? r[c] : (r ?? null); },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
        async run() { const r = sqlite.prepare(st.sql).run(...st.params); return { success: true, meta: { changes: r.changes } }; },
      };
      return api;
    },
    async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(k) {
      if (!store.has(k)) return null;
      const e = store.get(k);
      return { async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: e, httpEtag: '"x"', writeHttpMetadata() {} };
    },
    async put(k, v) {
      let b = v;
      if (v && typeof v.arrayBuffer === "function") b = new Uint8Array(await v.arrayBuffer());
      else if (v && typeof v.getReader === "function") {
        const ch = []; const rd = v.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; ch.push(value); }
        const t = ch.reduce((n, c) => n + c.length, 0); const m = new Uint8Array(t);
        let o = 0; for (const c of ch) { m.set(c, o); o += c.length; }
        b = m;
      }
      store.set(k, b);
      return { key: k };
    },
    async delete(k) { store.delete(k); },
    _dump: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite), MEDIA: makeR2(),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  return worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
}

const BLOB = {
  items: {
    posts: { label: { en: "Blog", "zh-CN": "博客" } },
    search: { order: 0 },
    widgets: { group: "content", hidden: true },
    urls: { hidden: true },
  },
  groups: { content: { label: { en: "Content area", "zh-CN": "内容区" } }, system: { order: -1 } },
};

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // -- idempotent cleanup of OUR OWN rows only -----------------------------
  // Runs at BOTH ends (see the sibling suites): up front so a crashed previous
  // run cannot change what this one observes, and again at the end so the
  // shared local D1 — the file `wrangler dev` serves — keeps no phantom user
  // rows. Sweeping only up front left the `mtest-author` account behind.
  const sweep = () => {
    for (const sql of [
      "DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'mtest-%')",
      "DELETE FROM admin_activity WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'mtest-%')",
      "DELETE FROM site_users WHERE username LIKE 'mtest-%'",
      "DELETE FROM settings WHERE key='admin.menu.custom' AND site_id IN ('default','mtest-other')",
    ]) { try { sqlite.exec(sql); } catch { /* table may not exist yet */ } }
  };
  sweep();

  const login = async (username, password) => {
    const r = await req(worker, env, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { status: r.status, cookie, auth: { Cookie: cookie }, json: { Cookie: cookie, "Content-Type": "application/json" } };
  };
  const bodyOf = async (r) => await r.json().catch(() => ({}));

  console.log("1. setup");
  const admin = await login("admin", "change-me-now");
  checkTruthy("admin logged in", admin.cookie.startsWith("cfpress_admin="));
  await req(worker, env, "/api/v1/users", {
    method: "POST", headers: admin.json,
    body: JSON.stringify({ username: "mtest-author", password: "mtest-password-1", role: "author" }),
  });
  const author = await login("mtest-author", "mtest-password-1");
  checkTruthy("author logged in", author.cookie.startsWith("cfpress_admin="));

  console.log("\n2. GET default — empty blob, can_manage true for admin");
  let r = await req(worker, env, "/api/v1/admin-menus/custom", { headers: admin.auth });
  let d = await bodyOf(r);
  check("GET default: items/groups empty, can_manage true", [r.status, d.items, d.groups, d.can_manage], [200, {}, {}, true]);

  console.log("\n3. PUT — the full blob round-trips");
  r = await req(worker, env, "/api/v1/admin-menus/custom", {
    method: "PUT", headers: admin.json, body: JSON.stringify(BLOB),
  });
  d = await bodyOf(r);
  check("PUT: 200 with normalized echo", [r.status, d.ok, d.items.posts.label["zh-CN"], d.groups.system.order], [200, true, "博客", -1]);
  d = await bodyOf(await req(worker, env, "/api/v1/admin-menus/custom", { headers: admin.auth }));
  check("GET reflects the blob", [d.items.posts.label.en, d.items.widgets.group, d.items.urls.hidden, d.groups.content.label["zh-CN"]], ["Blog", "content", true, "内容区"]);

  console.log("\n4. permission split — author reads, cannot write");
  d = await bodyOf(await req(worker, env, "/api/v1/admin-menus/custom", { headers: author.auth }));
  check("author GET: same blob, can_manage false", [d.items.posts?.label?.en, d.can_manage], ["Blog", false]);
  r = await req(worker, env, "/api/v1/admin-menus/custom", { method: "PUT", headers: author.json, body: JSON.stringify(BLOB) });
  check("author PUT -> 403", r.status, 403);
  r = await req(worker, env, "/api/v1/admin-menus/custom", { method: "DELETE", headers: author.auth });
  check("author DELETE -> 403", r.status, 403);

  console.log("\n5. validation — structural violations are 400s, junk is stripped");
  const bad = async (name, body, expect = 400) => {
    const rr = await req(worker, env, "/api/v1/admin-menus/custom", { method: "PUT", headers: admin.json, body: JSON.stringify(body) });
    check(name, rr.status, expect);
  };
  await bad("body must be an object", "nope");
  await bad("items must be an object", { items: ["posts"] });
  await bad("groups must be an object", { groups: 5 });
  await bad("bad item key (space)", { items: { "has space": { hidden: true } } });
  await bad("bad group id (uppercase)", { groups: { "Bad": { order: 1 } } });
  await bad("bad item group id", { items: { posts: { group: "NOPE" } } });
  await bad("label value must be a string", { items: { posts: { label: { en: 3 } } } });
  await bad("order must be an integer", { items: { posts: { order: 1.5 } } });
  await bad("hidden must be a boolean", { items: { posts: { hidden: "yes" } } });
  await bad("too many item overrides", { items: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`item-${i}`, { order: i }])) });

  r = await req(worker, env, "/api/v1/admin-menus/custom", {
    method: "PUT", headers: admin.json,
    body: JSON.stringify({ items: { posts: { label: { en: "Blog" }, hacker: "x", extra: [1] } } }),
  });
  d = await bodyOf(r);
  check("unknown fields stripped, known kept", [r.status, Object.keys(d.items.posts)], [200, ["label"]]);

  console.log("\n6. per-site isolation");
  r = await req(worker, env, "/api/v1/admin-menus/custom?site=mtest-other", {
    method: "PUT", headers: admin.json, body: JSON.stringify({ items: { posts: { label: { en: "Other" } } } }),
  });
  check("PUT on ?site=mtest-other: 201/200", r.status === 200 || r.status === 201, true);
  d = await bodyOf(await req(worker, env, "/api/v1/admin-menus/custom?site=mtest-other", { headers: admin.auth }));
  check("other site has its own blob", d.items.posts?.label?.en, "Other");
  d = await bodyOf(await req(worker, env, "/api/v1/admin-menus/custom", { headers: admin.auth }));
  check("default site unaffected", d.items.posts?.label?.en, "Blog");
  await req(worker, env, "/api/v1/admin-menus/custom?site=mtest-other", { method: "DELETE", headers: admin.auth });

  console.log("\n7. DELETE — reset to defaults");
  r = await req(worker, env, "/api/v1/admin-menus/custom", { method: "DELETE", headers: admin.auth });
  d = await bodyOf(r);
  check("DELETE: 200, empty blob", [r.status, d.items, d.groups], [200, {}, {}]);
  d = await bodyOf(await req(worker, env, "/api/v1/admin-menus/custom", { headers: admin.auth }));
  check("GET after DELETE: empty again", [d.items, d.groups], [{}, {}]);

  console.log("\n8. applyMenuCustom — the pure function (imported for real)");
  await testApplyMenuCustom();

  // Leave the shared local D1 as we found it (see `sweep` above).
  sweep();

  summary();
}

async function testApplyMenuCustom() {
  // The scratch dir is **unique per run**, and leftovers are swept best-effort.
  //
  // A single fixed name made one bad run poison every later one: on Windows the
  // directory cannot always be removed while the module copied out of it is
  // still mapped, and the old pre-clean treated that leftover as *this* run's
  // failure — so the suite aborted at section 8 with 24 assertions instead of
  // 40, for a reason that had nothing to do with what it tests. A leftover is
  // now swept if it can be and ignored if it cannot; only a directory this run
  // could not remove for a non-lock reason is a failure.
  for (const d of readdirSync(join(root, ".wrangler")).filter((f) => f.startsWith("menu-custom-spa-tmp"))) {
    try { rmSync(join(root, ".wrangler", d), { recursive: true, force: true }); } catch { /* still mapped */ }
  }
  const tmp = join(root, ".wrangler", `menu-custom-spa-tmp-${process.pid}`);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fresh name */ }
  // Copy only `js/state.js` and `js/nav.js` plus their transitive imports —
  // five files — rather than the whole admin tree. The full tree is ~40 files,
  // and this sandbox's safe-delete shim refuses a cleanup that removes more than
  // 50 files in one turn: the scratch dir then survived, and the *next* run
  // failed on the leftover (24 assertions instead of 40) for a reason that had
  // nothing to do with what the section tests. A new import in any of these
  // modules surfaces as MODULE_NOT_FOUND here, which is a loud, correct failure.
  for (const f of ["icons.js", "ui.js", "js/i18n.js", "js/state.js", "js/nav.js"]) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true });
    copyFileSync(join(root, "public/admin", f), join(tmp, f));
  }
  writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');

  // Minimal DOM stubs: state.js touches document/localStorage at import time,
  // nav.js only at call time.
  globalThis.document = {
    querySelector: () => ({ innerHTML: "" }),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    documentElement: { style: { setProperty() {} }, dataset: {} },
    body: { classList: { add() {}, remove() {} } },
  };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };

  try {
    const stateMod = await import(pathToFileURL(join(tmp, "js/state.js")).href);
    const nav = await import(pathToFileURL(join(tmp, "js/nav.js")).href);
    const { state } = stateMod;
    state.themeMenus = []; state.pluginMenus = []; state.postTypes = [];
    state.hiddenMenus = new Set(); state.menuCustom = { items: {}, groups: {} };

    const base = nav.baseGroups();
    check("base group ids", base.map((g) => g.id), ["general", "content", "appearance", "system", "tools"]);

    const custom = {
      items: {
        posts: { label: { en: "Blog", "zh-CN": "博客" } },
        search: { order: 0 },
        widgets: { group: "content", hidden: true },
        urls: { hidden: true },
        activity: { group: "nope" }, // target group does not exist -> ignored, stays put
      },
      groups: { system: { label: { en: "System X", "zh-CN": "系统X" }, order: -1 } },
    };
    const en = nav.applyMenuCustom(base, custom, "en");
    const zh = nav.applyMenuCustom(base, custom, "zh-CN");

    check("group order: system (order -1) first", en[0].id, "system");
    check("group label override en", en[0].label, "System X");
    check("group label override zh-CN", zh[0].label, "系统X");
    check("unordered groups keep built-in relative order", en.slice(1).map((g) => g.id), ["general", "content", "appearance", "tools"]);

    const gen = en.find((g) => g.id === "general");
    check("item order: search (order 0) first in its group", gen.items[0].key, "search");
    check("move to nonexistent group dropped (activity stays)", gen.items.map((it) => it.key), ["search", "dashboard", "activity"]);

    const content = en.find((g) => g.id === "content");
    check("cross-group move: widgets now in content", content.items.some((it) => it.key === "widgets"), true);
    const appearance = en.find((g) => g.id === "appearance");
    check("cross-group move: widgets left appearance", !appearance.items.some((it) => it.key === "widgets"), true);
    check("siteHidden flag set", content.items.find((it) => it.key === "widgets").siteHidden, true);

    check("item rename en", content.items.find((it) => it.key === "posts").title, "Blog");
    check("item rename zh-CN", zh.find((g) => g.id === "content").items.find((it) => it.key === "posts").title, "博客");
    check("unrenamed item keeps built-in label", content.items.find((it) => it.key === "pages").title, "Pages");

    // Sidebar filter semantics (navGroups): siteHidden + user-hidden are dropped
    // unless showHidden; dashboard survives both.
    state.menuCustom = custom;
    if (process.env.MENU_DEBUG) {
      console.log("  DEBUG custom.items:", JSON.stringify(custom.items));
      console.log("  DEBUG applied:", JSON.stringify(nav.applyMenuCustom(nav.baseGroups(), custom, "en").map((g) => [g.id, g.items.map((it) => [it.key, it.siteHidden])])));
      console.log("  DEBUG visible:", JSON.stringify(nav.navGroups(false).flatMap((g) => g.items.map((it) => it.key))));
    }
    const visible = nav.navGroups(false).flatMap((g) => g.items.map((it) => it.key));
    const all = nav.navGroups(true).flatMap((g) => g.items.map((it) => it.key));
    check("navGroups: siteHidden item filtered from the sidebar", !visible.includes("widgets") && !visible.includes("urls"), true);
    check("navGroups: dashboard always visible", visible.includes("dashboard"), true);
    check("navGroups(true): editor sees everything", all.includes("widgets") && all.includes("urls"), true);
  } finally {
    // Verify the cleanup (AGENTS.md false-green #5), but only *this* run's own
    // failure counts: a Windows file lock is environmental, and treating it as a
    // defect is what turned one locked directory into a permanently failing
    // suite.
    let err = null;
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { err = e; }
    if (existsSync(tmp)) {
      const code = String((err && (err.code || err.message)) || "");
      // `SAFE_DELETE_*` is this sandbox's bulk-delete shim, not a defect in the
      // suite: the same environmental class as a Windows file lock.
      if (/EBUSY|EPERM|ENOTEMPTY|SAFE_DELETE/.test(code)) {
        console.log("  note: scratch dir survived an environment limit — the next run sweeps it");
      } else {
        console.log(`  FAIL scratch dir not cleaned (${code || "no error reported"})`);
        fail++;
      }
    }
  }
}

main().catch((e) => { console.error("SUITE ERROR:", e && e.stack || e); fail++; summary(" (aborted)"); });
