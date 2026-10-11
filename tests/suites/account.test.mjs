/**
 * Account self-service + admin menu i18n/prefs (batch 5).
 *
 * Covers:
 *   1. POST /api/v1/auth/password   — change own password (current-password
 *      gate, minimum length, old credential stops working)
 *   2. POST /api/v1/auth/username   — change own username (format, uniqueness,
 *      current-password gate, auth/me reflects it)
 *   3. admin-menus/prefs            — per-user hidden-sidebar set (round trip,
 *      dedupe, non-array refusal)
 *   4. admin-menus label_key        — a theme-declared menu label translates
 *      through the UI dictionary when the interface language has a pack entry,
 *      and stays verbatim when it does not
 *
 * Everything runs against the REAL worker bundle and the REAL local D1, like
 * the other suites. The suite creates its own user (`acct-test-*`) and its own
 * site/theme (`acct`/`accttheme`) and cleans them up first — it never touches
 * the `admin` account, because every other suite and the browser verification
 * log in with it.
 *
 * Usage: node tests/suites/account.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
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

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "account-bundle.mjs");
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

/** A minimal theme whose admin menu carries a `label_key` + zh-CN pack. */
function buildTheme() {
  const manifest = {
    name: "accttheme", title: "Acct Theme", version: "1.0.0",
    templates: ["index"],
    adminMenus: [
      { id: "things", label: "Things", label_key: "theme.accttheme.menu.things", screen: "content-list", args: { type: "acctthing" } },
      { id: "plain", label: "Plain", screen: "content-list", args: { type: "acctthing" } },
    ],
    postTypes: [{
      name: "acctthing", label: "acctthing",
      labels: { singular: "acctthing", plural: "acctthings" },
      supports: ["title"], hasArchive: true, rewrite: { slug: "acctthings" },
    }],
    runtime: "declarative",
  };
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8("<!doctype html><html><body>acct</body></html>"),
    "langs/zh-CN.json": strToU8(JSON.stringify({ "theme.accttheme.menu.things": "物品" })),
    "langs/en.json": strToU8(JSON.stringify({ "theme.accttheme.menu.things": "Things" })),
  });
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // -- idempotent cleanup of OUR OWN rows only -----------------------------
  // Runs at BOTH ends. Up front so a crashed previous run cannot change what
  // this one observes; again at the end so the shared local D1 — the very
  // sqlite file `wrangler dev` serves (see AGENTS.md) — is left exactly as this
  // suite found it. A suite that sweeps only up front leaves its theme and site
  // in the operator's admin UI until the *next* run happens to remove them,
  // which is what put phantom entries on the Themes and Sites screens.
  const sweep = () => {
    for (const sql of [
      "DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'acct-test%')",
      "DELETE FROM admin_activity WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'acct-test%')",
      "DELETE FROM site_users_sites WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'acct-test%')",
      "DELETE FROM site_users WHERE username LIKE 'acct-test%'",
      "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='accttheme'",
      "DELETE FROM post_types WHERE declared_by_theme='accttheme'",
      "DELETE FROM field_defs WHERE declared_by_theme='accttheme'",
      "DELETE FROM theme_routes WHERE declared_by_theme='accttheme'",
      "DELETE FROM theme_blocks WHERE declared_by_theme='accttheme'",
      "DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='accttheme'",
      "DELETE FROM theme_settings WHERE theme_name='accttheme'",
      "DELETE FROM theme_setting_defs WHERE theme_name='accttheme'",
      "DELETE FROM theme_installs WHERE name='accttheme'",
      "DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name='accttheme'",
      "DELETE FROM extension_versions WHERE extension_name='accttheme'",
      "DELETE FROM menu_items WHERE site_id='acct'",
      "DELETE FROM menus WHERE site_id='acct'",
      "DELETE FROM widget_instances WHERE site_id='acct'",
      "DELETE FROM site_locales WHERE site_id='acct'",
      "DELETE FROM settings WHERE site_id='acct'",
      "DELETE FROM sites WHERE id='acct'",
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

  console.log("1. setup: admin creates the test user, a site and a labelled theme");
  const admin = await login("admin", "change-me-now");
  checkTruthy("admin logged in", admin.cookie.startsWith("cfpress_admin="));

  const mk = await req(worker, env, "/api/v1/users", {
    method: "POST", headers: admin.json,
    body: JSON.stringify({ username: "acct-test-user", password: "acct-test-original-1", role: "author" }),
  });
  check("test user created", mk.status, 201);

  await req(worker, env, "/api/v1/sites", { method: "POST", headers: admin.json, body: JSON.stringify({ id: "acct", name: "Acct Test" }) });
  const fd = new FormData();
  fd.append("file", new File([buildTheme()], "accttheme.zip", { type: "application/zip" }));
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: admin.auth, body: fd });
  check("theme uploaded", up.status, 201);
  const act = await req(worker, env, "/api/v1/extensions/themes/accttheme/activate?site=acct", { method: "POST", headers: admin.auth });
  check("theme activated", act.status, 200);

  const u = await login("acct-test-user", "acct-test-original-1");
  checkTruthy("test user logged in", u.cookie.startsWith("cfpress_admin="));

  console.log("\n2. change password — the current-password gate holds");
  let r = await req(worker, env, "/api/v1/auth/password", {
    method: "POST", headers: u.json,
    body: JSON.stringify({ current_password: "wrong-current-pw", new_password: "acct-test-newpass-9" }),
  });
  check("wrong current password -> 403 wrong_current", [r.status, (await bodyOf(r)).error], [403, "wrong_current"]);

  r = await req(worker, env, "/api/v1/auth/password", {
    method: "POST", headers: u.json,
    body: JSON.stringify({ current_password: "acct-test-original-1", new_password: "short7" }),
  });
  check("7-char new password -> 400 weak", [r.status, (await bodyOf(r)).error], [400, "weak"]);

  r = await req(worker, env, "/api/v1/auth/password", {
    method: "POST", headers: u.json,
    body: JSON.stringify({ current_password: "acct-test-original-1", new_password: "acct-test-newpass-9" }),
  });
  check("correct change -> 200", r.status, 200);

  const oldLogin = await login("acct-test-user", "acct-test-original-1");
  check("old password no longer logs in", oldLogin.status, 401);
  const newLogin = await login("acct-test-user", "acct-test-newpass-9");
  check("new password logs in", newLogin.status, 200);

  console.log("\n3. change username — format, uniqueness, gate");
  r = await req(worker, env, "/api/v1/auth/username", {
    method: "POST", headers: newLogin.json,
    body: JSON.stringify({ username: "admin", current_password: "acct-test-newpass-9" }),
  });
  check("existing username -> 409 taken", [r.status, (await bodyOf(r)).error], [409, "taken"]);

  r = await req(worker, env, "/api/v1/auth/username", {
    method: "POST", headers: newLogin.json,
    body: JSON.stringify({ username: "has space!", current_password: "acct-test-newpass-9" }),
  });
  check("invalid username -> 400", r.status, 400);

  r = await req(worker, env, "/api/v1/auth/username", {
    method: "POST", headers: newLogin.json,
    body: JSON.stringify({ username: "acct-test-user-2", current_password: "wrong-pw" }),
  });
  check("wrong current password -> 403", [r.status, (await bodyOf(r)).error], [403, "wrong_current"]);

  r = await req(worker, env, "/api/v1/auth/username", {
    method: "POST", headers: newLogin.json,
    body: JSON.stringify({ username: "acct-test-user-2", current_password: "acct-test-newpass-9" }),
  });
  check("rename -> 200 with new username", [r.status, (await bodyOf(r)).username], [200, "acct-test-user-2"]);

  const me = await bodyOf(await req(worker, env, "/api/v1/auth/me", { headers: newLogin.auth }));
  check("auth/me reflects the new username", me.user?.username, "acct-test-user-2");
  const oldName = await login("acct-test-user", "acct-test-newpass-9");
  check("old username no longer logs in", oldName.status, 401);

  console.log("\n4. menu prefs — per-user hidden sidebar set");
  r = await req(worker, env, "/api/v1/admin-menus/prefs", { headers: newLogin.auth });
  check("prefs default to empty", (await bodyOf(r)).hidden, []);

  r = await req(worker, env, "/api/v1/admin-menus/prefs", {
    method: "PUT", headers: newLogin.json, body: JSON.stringify({ hidden: "widgets" }),
  });
  check("non-array hidden -> 400", r.status, 400);

  r = await req(worker, env, "/api/v1/admin-menus/prefs", {
    method: "PUT", headers: newLogin.json, body: JSON.stringify({ hidden: ["widgets", "urls", "widgets"] }),
  });
  check("prefs saved with duplicates removed", (await bodyOf(r)).hidden, ["widgets", "urls"]);

  r = await req(worker, env, "/api/v1/admin-menus/prefs", { headers: newLogin.auth });
  check("prefs round-trip", (await bodyOf(r)).hidden, ["widgets", "urls"]);

  const adminPrefs = await bodyOf(await req(worker, env, "/api/v1/admin-menus/prefs", { headers: admin.auth }));
  check("prefs are per-user (admin unaffected)", adminPrefs.hidden, []);

  console.log("\n5. admin-menus label_key — translated through the UI dictionary");
  // Switch the test user's interface language to zh-CN. The menu that declared
  // a label_key must come back translated; the one without a key stays as-is.
  await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: newLogin.json, body: JSON.stringify({ locale: "zh-CN" }),
  });
  let menus = await bodyOf(await req(worker, env, "/api/v1/admin-menus?site=acct", { headers: newLogin.auth }));
  let keyed = (menus.items || []).find((m) => m.menu_id === "things");
  let plain = (menus.items || []).find((m) => m.menu_id === "plain");
  check("zh-CN: label_key menu label is translated", keyed?.label, "物品");
  check("zh-CN: declared label_key rides along", keyed?.label_key, "theme.accttheme.menu.things");
  check("zh-CN: menu without a key keeps its literal label", plain?.label, "Plain");
  check("zh-CN: response names the resolved ui locale", menus.ui_locale, "zh-CN");

  await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: newLogin.json, body: JSON.stringify({ locale: "en" }),
  });
  menus = await bodyOf(await req(worker, env, "/api/v1/admin-menus?site=acct", { headers: newLogin.auth }));
  keyed = (menus.items || []).find((m) => m.menu_id === "things");
  check("en: label resolves through the en pack", keyed?.label, "Things");

  // A label_key whose translation nobody ships must fall back to the literal
  // label, not to an empty string or the raw key.
  const noPack = await bodyOf(await req(worker, env, "/api/v1/admin-menus?site=acct", { headers: admin.auth }));
  const plainAdmin = (noPack.items || []).find((m) => m.menu_id === "plain");
  check("fallback: literal label survives untranslated keys", plainAdmin?.label, "Plain");

  console.log("\ncleanup");
  sweep();

  summary();
  process.exit(fail ? 1 : 0);
}

/** The summary is printed even when main() throws — a suite that dies halfway
 *  must never be mistaken for a suite that passed (the sixth false-green). */
function summary(note) {
  const suffix = note ? ` (${note})` : "";
  console.log(`\n${pass} passed, ${fail} failed${suffix}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

try {
  await main();
} catch (e) {
  fail++; failures.push(`harness threw: ${(e && e.message) || e}`);
  console.error(e);
  summary("aborted");
  process.exit(2);
}
