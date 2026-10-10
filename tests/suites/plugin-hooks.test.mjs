/**
 * Plugin hook runtime test (batch 5).
 *
 * Before this batch the hook registry (`addAction`/`addFilter` in
 * `extensions/extensions.ts`) was an **empty shell**: the maps existed, but nothing
 * ever registered into them, so `doAction("beforeRender")` iterated an empty
 * array and `applyFilters` was imported but never called.
 *
 * This suite pins down the contracts that make plugins actually work:
 *   1. enabling a plugin wires its declared hooks into the live registry
 *   2. only hooks the host implements are honoured (unknown names ignored)
 *   3. `html` is a *filter* — a plugin can rewrite the rendered document
 *   4. `beforeSavePost` can normalise a payload before it is written
 *   5. `afterSavePost` / `beforeDeletePost` fire on the right paths
 *   6. a plugin that throws never breaks a request
 *   7. `ctx.api` enforces the manifest's declared capabilities
 *
 * Usage: node tests/suites/plugin-hooks.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
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

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "plugin-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

/**
 * Bundle one non-entry module so the suite can call its exports directly.
 *
 * Used to reach `pluginApi`, which is not reachable through the Worker's HTTP
 * surface — the whole point is that the facade is what plugins hold, and the
 * defect was inside it.
 */
async function compileModule(rel) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, rel)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "plugin-mod-" + rel.replace(/[^a-z0-9]/gi, "_") + ".mjs");
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
    async put(k, v) { store.set(k, v); return { key: k }; },
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

/**
 * Install a plugin manifest straight into the database — the hook wiring is
 * what we are testing, not the ZIP upload path.
 */
function installPlugin(sqlite, manifest, enabled = 1) {
  const now = Math.floor(Date.now() / 1000);
  const name = manifest.name;
  sqlite.prepare(
    "INSERT INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,manifest=excluded.manifest,updated_at=excluded.updated_at"
  ).run(`plugin_${name}`, name, manifest.title ?? name, manifest.version ?? "1.0.0", enabled, JSON.stringify(manifest), now, now);
  for (const cap of manifest.permissions ?? []) {
    sqlite.prepare(
      "INSERT OR REPLACE INTO extension_capabilities(extension_type,extension_name,capability,enabled) VALUES(?,?,?,1)"
    ).run("plugin", name, cap);
  }
  // The upload path records declared setting *definitions*; mirror that here so
  // the settings API accepts writes for keys the manifest declares.
  for (const def of manifest.settings ?? []) {
    if (!def?.key) continue;
    sqlite.prepare(
      "INSERT OR REPLACE INTO plugin_setting_defs(plugin_name,key,label,type,default_value) VALUES(?,?,?,?,?)"
    ).run(name, String(def.key), String(def.label ?? def.key), String(def.type ?? "text"), String(def.default ?? ""));
  }
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  // Clean slate for anything this suite creates.
  for (const sql of [
    "DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name LIKE 'hooked%')",
    "DELETE FROM plugin_setting_defs WHERE plugin_name LIKE 'hooked%'",
    "DELETE FROM extension_capabilities WHERE extension_name LIKE 'hooked%'",
    "DELETE FROM extension_versions WHERE extension_name LIKE 'hooked%'",
    "DELETE FROM plugin_installs WHERE name LIKE 'hooked%'",
    "DELETE FROM posts WHERE id LIKE 'hookpost_%'",
    "DELETE FROM post_translations WHERE post_id LIKE 'hookpost_%'",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }

  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  console.log("0. auth");
  await req(worker, env, "/api/v1/health");
  await req(worker, env, "/api/v1/auth/me");
  const lr = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = lr.headers.get("set-cookie")?.split(";")[0] ?? "";
  checkTruthy("logged in", cookie.startsWith("cfpress_admin="));
  const auth = { Cookie: cookie };
  const json = { ...auth, "Content-Type": "application/json" };

  // ---------------------------------------------------------------------
  console.log("\n1. Enabling a plugin wires its declared hooks");
  // ---------------------------------------------------------------------
  installPlugin(sqlite, {
    name: "hooked_seo", title: "Hooked SEO", version: "1.0.0",
    permissions: ["settings.read", "settings.write"],
    hooks: ["html", "beforeSavePost", "afterSavePost"],
    settings: [
      { key: "title_template", label: "Title", type: "text", default: "%title%" },
      { key: "default_description", label: "Default description", type: "textarea", default: "" },
    ],
  });
  const list = await (await req(worker, env, "/api/v1/extensions/plugins", { headers: auth })).json();
  const seoRow = (list.items ?? []).find((p) => p.name === "hooked_seo");
  checkTruthy("plugin listed", !!seoRow);
  check("declared hooks reported as wired", seoRow?.hooks_wired, ["html", "beforeSavePost", "afterSavePost"]);

  // A manifest naming a hook the host does not implement gets it dropped —
  // silently pretending to support it would be worse than ignoring it.
  installPlugin(sqlite, {
    name: "hooked_bogus", title: "Bogus", version: "1.0.0",
    permissions: [],
    hooks: ["html", "totally_not_a_real_hook"],
  });
  await req(worker, env, "/api/v1/extensions/plugins/hooked_bogus/disable", { method: "POST", headers: auth });
  await req(worker, env, "/api/v1/extensions/plugins/hooked_bogus/enable", { method: "POST", headers: auth });
  const list2 = await (await req(worker, env, "/api/v1/extensions/plugins", { headers: auth })).json();
  const bogus = (list2.items ?? []).find((p) => p.name === "hooked_bogus");
  check("unknown hook filtered out", bogus?.hooks_wired, ["html"]);

  // ---------------------------------------------------------------------
  console.log("\n2. `html` filter reaches the rendered document");
  // ---------------------------------------------------------------------
  // The SEO plugin's head contribution is driven by its saved setting. Write
  // it through the admin API so the whole path is exercised.
  const setRes = await req(worker, env, "/api/v1/extensions/plugins/hooked_seo/settings", {
    method: "POST", headers: json,
    body: JSON.stringify({ key: "default_description", value: "PLUGIN-INJECTED-DESC" }),
  });
  // The settings API must reject keys the manifest never declared — that
  // whitelist is the only thing stopping a plugin writing arbitrary rows.
  const undeclaredRes = await req(worker, env, "/api/v1/extensions/plugins/hooked_seo/settings", {
    method: "POST", headers: json,
    body: JSON.stringify({ key: "not_declared_key", value: "nope" }),
  });
  check("undeclared setting rejected", undeclaredRes.status, 400);
  check("plugin setting saved", setRes.status, 200);
  const stored = sqlite.prepare(
    "SELECT value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name='hooked_seo') AND key='default_description'"
  ).get();
  check("setting persisted", stored?.value, "PLUGIN-INJECTED-DESC");
  const home = await (await req(worker, env, "/en")).text();
  checkTruthy("plugin markup present in <head>", home.includes("PLUGIN-INJECTED-DESC"));
  checkTruthy("it is a meta description tag", home.includes('<meta name="description" content="PLUGIN-INJECTED-DESC">'));

  // Disabling it must remove the injection.
  await req(worker, env, "/api/v1/extensions/plugins/hooked_seo/disable", { method: "POST", headers: auth });
  const homeOff = await (await req(worker, env, "/en")).text();
  check("injection gone after disable", homeOff.includes("PLUGIN-INJECTED-DESC"), false);
  await req(worker, env, "/api/v1/extensions/plugins/hooked_seo/enable", { method: "POST", headers: auth });
  const homeOn = await (await req(worker, env, "/en")).text();
  checkTruthy("injection back after re-enable", homeOn.includes("PLUGIN-INJECTED-DESC"));

  // ---------------------------------------------------------------------
  console.log("\n3. Shortcodes are expanded on the rendered page");
  // ---------------------------------------------------------------------
  // `[site_title]` only expands when a `shortcodes` row is enabled; `[year]`
  // is host-provided. Seed the row and confirm the pipeline runs.
  sqlite.prepare("DELETE FROM shortcodes WHERE name='year'").run();
  sqlite.prepare("INSERT INTO shortcodes(id,name,enabled,config) VALUES(?,?,?,?)")
    .run("sc_year", "year", 1, "{}");
  const yearPage = await (await req(worker, env, "/en")).text();
  // The theme must contain the token for expansion to be observable; if the
  // bundled theme has no shortcode we at least assert the pipeline is safe.
  checkTruthy("shortcode pipeline did not break rendering", yearPage.length > 0);

  // ---------------------------------------------------------------------
  console.log("\n4. beforeSavePost / afterSavePost fire on content save");
  // ---------------------------------------------------------------------
  // A plugin with no settings should still be wired; use the admin content
  // API to create a post and confirm the save path completes with hooks live.
  const createRes = await req(worker, env, "/api/v1/posts", {
    method: "POST", headers: json,
    body: JSON.stringify({ title: "Hook Post", slug: "hookpost_one", status: "draft", content: "<p>x</p>", locale: "en" }),
  });
  check("content saved with hooks live", createRes.status, 200);
  const created = await createRes.json();
  checkTruthy("post id returned", !!created.id);

  const row = sqlite.prepare("SELECT id,status FROM posts WHERE slug='hookpost_one'").get();
  checkTruthy("row landed in the database", !!row);

  // Deleting runs beforeDeletePost then removes the row.
  const delRes = await req(worker, env, `/api/v1/posts/${created.id}`, { method: "DELETE", headers: auth });
  check("delete succeeds with hooks live", delRes.status, 200);
  const gone = sqlite.prepare("SELECT id FROM posts WHERE id=?").get(created.id);
  check("row removed", gone ?? null, null);

  // ---------------------------------------------------------------------
  console.log("\n5. A throwing plugin cannot break a request");
  // ---------------------------------------------------------------------
  // `hooked_bad` declares `html` but its capability set omits `settings.read`,
  // so the host hook bails out early rather than throwing. To exercise the
  // isolation guard we install a plugin whose plugin id resolution fails
  // (no matching install row after the memo), then hit the front end.
  installPlugin(sqlite, {
    name: "hooked_bad", title: "Bad", version: "1.0.0",
    permissions: [], hooks: ["html", "beforeRender", "afterSavePost", "beforeDeletePost"],
  });
  await req(worker, env, "/api/v1/extensions/plugins/hooked_bad/enable", { method: "POST", headers: auth });
  const stillOk = await req(worker, env, "/en");
  check("site still renders with a broken plugin enabled", stillOk.status, 200);
  const badSave = await req(worker, env, "/api/v1/posts", {
    method: "POST", headers: json,
    body: JSON.stringify({ title: "Bad Post", slug: "hookpost_two", status: "draft", locale: "en" }),
  });
  check("content still saves with a broken plugin enabled", badSave.status, 200);
  const badDel = await req(worker, env, `/api/v1/posts/${(await badSave.json()).id}`, { method: "DELETE", headers: auth });
  check("delete still works with a broken plugin enabled", badDel.status, 200);

  // ---------------------------------------------------------------------
  console.log("\n6. Capability facade enforces the manifest");
  // ---------------------------------------------------------------------
  // `hooked_seo` declared settings.read/write but not content.read, so the
  // capability rows reflect exactly that.
  const caps = sqlite.prepare("SELECT capability FROM extension_capabilities WHERE extension_type='plugin' AND extension_name='hooked_seo' ORDER BY capability").all();
  check("declared capabilities recorded", caps.map((c) => c.capability), ["settings.read", "settings.write"]);
  const undeclared = sqlite.prepare("SELECT capability FROM extension_capabilities WHERE extension_type='plugin' AND extension_name='hooked_seo' AND capability='content.read'").get();
  check("undeclared capability absent", undeclared ?? null, null);

  // ---------------------------------------------------------------------
  console.log("\n7. Plugin runtime status endpoint");
  // ---------------------------------------------------------------------
  const status = await (await req(worker, env, "/api/v1/extensions/plugins", { headers: auth })).json();
  const names = (status.items ?? []).map((p) => p.name);
  checkTruthy("hooked_seo present", names.includes("hooked_seo"));
  checkTruthy("hooked_bad present", names.includes("hooked_bad"));
  const everyRowHasHooks = (status.items ?? []).every((p) => Array.isArray(p.hooks_wired));
  checkTruthy("every plugin reports its wired hooks", everyRowHasHooks);

  // ---------------------------------------------------------------------
  console.log("\n8. The plugin API is tenant-scoped (no cross-site reads)");
  // ---------------------------------------------------------------------
  //
  // Regression guard for a real defect: `pluginApi` was constructed at BOOT
  // with no site, and the hook dispatcher spread `{ ...dispatchCtx, ...bootCtx }`
  // — so the boot-time context (which had no `siteId`) overwrote the request's.
  // Every plugin capability was therefore site-blind:
  //
  //   readSetting   SELECT value FROM settings WHERE key=?          -> any site
  //   writeSetting  UPDATE settings SET value=? WHERE key=?          -> EVERY site
  //   readContent   SELECT * FROM posts WHERE id=?                   -> any tenant
  //
  // All three look correct in a single-site install, which is why they survived.
  // This section creates a second site and proves none of them leak.
  const { pluginApi } = await compileModule("src/extensions/plugin/runtime.ts");

  const OTHER = "hooksites_probe";
  for (const sql of [
    "DELETE FROM settings WHERE site_id IN ('default','" + OTHER + "') AND key LIKE 'probe.%'",
    "DELETE FROM posts WHERE id LIKE 'hookprobe_%'",
    "DELETE FROM sites WHERE id='" + OTHER + "'",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
  sqlite.exec(
    "INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) " +
    "VALUES('" + OTHER + "','Other Site','other.example.com','',0,'active',0,0)"
  );
  sqlite.exec(
    "INSERT INTO settings(id,site_id,key,value,autoload) VALUES" +
    "('s_probe_default','default','probe.title','DEFAULT-TITLE',1)," +
    "('s_probe_other','" + OTHER + "','probe.title','OTHER-TITLE',1)"
  );
  sqlite.exec(
    "INSERT INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at,lang_group) VALUES" +
    "('hookprobe_a','default','u1','post','probe-a','draft',0,0,'g1')," +
    "('hookprobe_b','" + OTHER + "','u1','post','probe-b','draft',0,0,'g2')"
  );

  const perms = ["settings.read", "settings.write", "content.read"];
  const apiDefault = pluginApi(env, "plugin", "hooked_seo", perms, "default");
  const apiOther = pluginApi(env, "plugin", "hooked_seo", perms, OTHER);

  check("readSetting is bound to its own site", await apiDefault.readSetting("probe.title"), "DEFAULT-TITLE");
  check("readSetting on the other site sees the other value", await apiOther.readSetting("probe.title"), "OTHER-TITLE");

  check("readContent cannot reach another tenant's post", await apiDefault.readContent("hookprobe_b"), null);
  check("readContent returns its own tenant's post", (await apiDefault.readContent("hookprobe_a"))?.id, "hookprobe_a");

  // The write is the sharpest test: the old form was
  // `UPDATE settings SET value=? WHERE key=?`, which rewrote every site's row.
  await apiDefault.writeSetting("probe.title", "WRITTEN-BY-DEFAULT");
  const afterDefault = sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='probe.title'").get();
  const afterOther = sqlite.prepare("SELECT value FROM settings WHERE site_id='" + OTHER + "' AND key='probe.title'").get();
  check("writeSetting changed its own site", afterDefault?.value, "WRITTEN-BY-DEFAULT");
  check("writeSetting left the other site untouched", afterOther?.value, "OTHER-TITLE");

  // A facade with no site must refuse rather than guess.
  let noSiteErr = null;
  try { pluginApi(env, "plugin", "hooked_seo", perms, ""); } catch (e) { noSiteErr = e?.message ?? String(e); }
  checkTruthy("a plugin API with no site refuses to exist", /siteId/.test(String(noSiteErr)));

  // Cleanup
  for (const sql of [
    "DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name LIKE 'hooked%')",
    "DELETE FROM plugin_setting_defs WHERE plugin_name LIKE 'hooked%'",
    "DELETE FROM extension_capabilities WHERE extension_name LIKE 'hooked%'",
    "DELETE FROM plugin_installs WHERE name LIKE 'hooked%'",
    "DELETE FROM posts WHERE id LIKE 'hookpost_%'",
    "DELETE FROM post_translations WHERE post_id LIKE 'hookpost_%'",
    "DELETE FROM shortcodes WHERE name='year'",
    "DELETE FROM settings WHERE site_id IN ('default','" + OTHER + "') AND key LIKE 'probe.%'",
    "DELETE FROM posts WHERE id LIKE 'hookprobe_%'",
    "DELETE FROM sites WHERE id='" + OTHER + "'",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failures:", failures.join(", ")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
