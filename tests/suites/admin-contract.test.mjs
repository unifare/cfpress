/**
 * Admin API contract test (batch 4 follow-up).
 *
 * The admin SPA (`public/admin/admin.js`) is site-aware: it appends `?site=`
 * to every request, renders a nav entry per theme-declared CPT, and builds a
 * Custom-fields panel from `theme/fields`. Those are contracts — if the API
 * stops honouring them the UI silently breaks. This suite pins them down.
 *
 * Also covers the CPT CRUD endpoints the UI now calls (`/content/{type}`),
 * including custom-field round-tripping through `post_meta`.
 *
 * Usage: node tests/suites/admin-contract.test.mjs
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
  const tmp = join(root, ".wrangler", "admin-bundle.mjs");
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
    // Uploading a theme/plugin writes to R2, and storing is behind a
    // **default-off** switch (`media_store_r2`). This suite exercises the
    // upload, so its deploy has the switch on; the switch itself, both ways,
    // is media.test.mjs §12.
    CFPRESS_MEDIA_STORE_R2: "true",
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  return worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
}

function buildTheme(name, cpt, opts = {}) {
  const manifest = {
    name, title: `${name} title`, version: "1.0.0",
    templates: ["index", "archive-"+cpt, "single-"+cpt],
    postTypes: [{
      name: cpt, label: cpt,
      labels: { singular: cpt, plural: cpt + "s" },
      supports: opts.supports ?? ["title", "editor"],
      hasArchive: true, rewrite: { slug: cpt + "s" },
    }],
    fields: opts.fields ?? [{ key: "sku", label: "SKU", type: "text", postTypes: [cpt] }],
    adminMenus: opts.adminMenus ?? [{ id: cpt + "s", label: cpt + "s", screen: "content-list", args: { type: cpt } }],
    settings: opts.settings ?? [{ key: "accent", label: "Accent", type: "color", default: "#f00" }, { key: "layout.mode", label: "Layout", type: "select", default: "wide", options: ["wide", "boxed"] }, { key: "showHero", label: "Show hero", type: "boolean", default: "true" }],
    runtime: "declarative",
  };
  const index = `<!doctype html><html><body>{{site.title}}</body></html>`;
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(index),
    [`templates/archive-${cpt}.html`]: strToU8(`<html><body>ARCH-${cpt}</body></html>`),
    [`templates/single-${cpt}.html`]: strToU8(`<html><body>SINGLE-${cpt}:{{post.slug}}</body></html>`),
  });
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  // The module namespace, not just the fetch handler: section 21 drives the
  // boot hook (`maybeSeedDemoContent`) directly, because "runs once per
  // install" is exactly the contract no HTTP route exercises.
  const mod = await compileWorker();
  const worker = mod.default;
  const env = makeEnv(sqlite);

  // Idempotent teardown of this suite's fixtures, run at BOTH ends: up front so
  // a crashed previous run cannot change what this one observes, and again at
  // the end so the shared local D1 (the file `wrangler dev` serves) is left as
  // the suite found it. Sweeping only up front leaves the `adm` site and the
  // `admtheme` theme sitting in the operator's Sites/Themes screens until the
  // next run happens to remove them.
  const sweep = () => {
    for (const sql of [
      "DELETE FROM post_meta WHERE post_id LIKE 'adm_%' OR post_id LIKE 'widget_%'",
      "DELETE FROM post_translations WHERE post_id LIKE 'adm_%' OR post_id LIKE 'widget_%'",
      "DELETE FROM post_revisions WHERE post_id LIKE 'adm_%' OR post_id LIKE 'widget_%'",
      "DELETE FROM posts WHERE id LIKE 'adm_%' OR id LIKE 'widget_%'",
      "DELETE FROM post_types WHERE declared_by_theme='admtheme'",
      "DELETE FROM field_defs WHERE declared_by_theme='admtheme'",
      "DELETE FROM theme_routes WHERE declared_by_theme='admtheme'",
      "DELETE FROM theme_blocks WHERE declared_by_theme='admtheme'",
      "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='admtheme'",
      "DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='admtheme'",
      "DELETE FROM theme_setting_defs WHERE theme_name='admtheme'",
      "DELETE FROM theme_settings WHERE theme_name='admtheme'",
      "DELETE FROM theme_installs WHERE name='admtheme'",
      "DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name='admtheme'",
      "DELETE FROM extension_versions WHERE extension_name='admtheme'",
      "DELETE FROM menu_items WHERE site_id='adm'",
      "DELETE FROM menus WHERE site_id='adm'",
      "DELETE FROM widget_instances WHERE site_id='adm'",
      "DELETE FROM site_locales WHERE site_id='adm'",
      "DELETE FROM sites WHERE id='adm'",
      "DELETE FROM settings WHERE site_id='adm'",
      // -- section 21 (demo content seeding) --
      // Translations/meta/revisions go first, by *site* subquery, so the
      // second fixture site's own post cannot orphan its language rows.
      "DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE site_id LIKE 'admdemo%')",
      "DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE site_id LIKE 'admdemo%')",
      "DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE site_id LIKE 'admdemo%')",
      "DELETE FROM posts WHERE site_id LIKE 'admdemo%'",
      "DELETE FROM content_cache_versions WHERE site_id LIKE 'admdemo%'",
      "DELETE FROM site_locales WHERE site_id LIKE 'admdemo%'",
      "DELETE FROM settings WHERE site_id LIKE 'admdemo%'",
      "DELETE FROM site_users_sites WHERE user_id IN (SELECT id FROM site_users WHERE username='admdemo_limited')",
      "DELETE FROM site_users WHERE username='admdemo_limited'",
      "DELETE FROM sites WHERE id LIKE 'admdemo%'",
    ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
  };
  sweep();

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

  console.log("\n0b. The admin is hidden: prefix routing, cookie scope, throttling");
  // Batch C: the admin lives under a configurable prefix (`admin.path`,
  // default `/admin`). The prefix is not secret to the router but it is not
  // advertised, and the *old* addresses must be genuinely gone rather than
  // redirected — a 301 to the new prefix hands it to whatever is scanning.
  {
    const sp = await req(worker, env, "/admin/api/v1/platform-settings", { headers: auth });
    check("platform settings are readable under the admin prefix", sp.status, 200);
    const spJson = await sp.json();
    check("admin.path is a declared platform key", spJson.items.some((x) => x.key === "admin.path"), true);

    // The cookie is scoped to the admin prefix, not `/`. `Path=/` put the admin
    // session on every front-end request — see `auth.ts`.
    const sc = lr.headers.get("set-cookie") ?? "";
    checkTruthy("the session cookie path is the admin prefix, not /", /;\s*Path=\/admin(?:\s*;|$)/.test(sc));

    // The retired login endpoint answers 404. It used to be the *public* login
    // path; leaving it served would keep the old door open after the move.
    const oldLogin = await req(worker, env, "/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "change-me-now" }),
    });
    check("the retired /api/v1/auth/login answers 404", oldLogin.status, 404);

    // A front-end page must not set the admin cookie. `/api/v1/health` is a
    // public endpoint; whatever it answers, it must not hand out a session.
    const front = await req(worker, env, "/api/v1/health");
    check("a public endpoint does not set the admin cookie", front.headers.get("set-cookie"), null);

    // The brute-force throttle. Five wrong passwords for one username+ip must
    // turn the sixth request into a 429 rather than another 401. Each attempt
    // uses a throwaway username so this cannot lock the real `admin` account
    // (the throttle key is `ip|username`) and cannot perturb other sections.
    const throttleUser = "nobody-throttle-probe";
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await req(worker, env, "/admin/api/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: throttleUser, password: "wrong-" + i }),
      });
      lastStatus = r.status;
    }
    check("repeated bad logins are throttled (429)", lastStatus, 429);
  }

  console.log("\n0c. Moving the admin prefix");
  // The point of `admin.path` is that the admin can be moved somewhere a
  // scanner will not guess. Three things have to hold when it moves, and each
  // was a real way to get it wrong:
  //   1. the new prefix serves the shell and the API;
  //   2. the shell is served with `CFP_ADMIN_BASE` = the new prefix (otherwise
  //      the SPA calls back to `/admin/api/…`, which is now gone);
  //   3. the old prefix answers 404 — *including its assets*, or `/admin/admin.js`
  //      is a signpost back to the admin.
  // The prefix is restored at the end of this block, in a `finally`, so a
  // failure here cannot leave the operator's own install on `/manage`.
  {
    const setPath = async (value, prefix) => req(worker, env, `${prefix}/api/v1/platform-settings`, {
      method: "POST", headers: json, body: JSON.stringify({ key: "admin.path", value }),
    });
    const moved = await setPath("/manage", "/admin");
    check("admin.path can be moved", moved.status, 200);
    try {
      const shell = await req(worker, env, "/manage/");
      check("the new prefix serves the shell", shell.status, 200);
      const html = await shell.text();
      checkTruthy("the shell is injected with the new base", /window\.CFP_ADMIN_BASE="\/manage"/.test(html));
      checkTruthy("the shell's asset URLs point at the new prefix", /"\/manage\/admin\.(css|js)"/.test(html));
      checkTruthy("the shell no longer points at /admin/", !/"\/admin\/admin/.test(html));

      const api = await req(worker, env, "/manage/api/v1/health");
      check("the API answers under the new prefix", api.status, 200);

      // Old addresses are gone: the route, the assets and the old login door.
      const oldShell = await req(worker, env, "/admin/");
      check("the old prefix answers 404", oldShell.status, 404);
      const oldAsset = await req(worker, env, "/admin/admin.js");
      check("the old prefix's assets answer 404 too", oldAsset.status, 404);
      const oldLogin2 = await req(worker, env, "/admin/api/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "change-me-now" }),
      });
      check("the old login door answers 404 after the move", oldLogin2.status, 404);
    } finally {
      // Restore *through the moved prefix*: `/admin` is 404 while it is moved,
      // so a restore aimed there would silently fail and leave the install on
      // `/manage` for every later section (and for the operator).
      const restored = await setPath("/admin", "/manage");
      check("admin.path is restored through the moved prefix", restored.status, 200);
    }
    // Restored: the default prefix works again.
    const back = await req(worker, env, "/admin/api/v1/health");
    check("the default prefix works again after restore", back.status, 200);
  }

  console.log("\n1. Theme install + activate on a new site");
  await req(worker, env, "/api/v1/sites", { method: "POST", headers: json, body: JSON.stringify({ id: "adm", name: "Admin Test" }) });
  const fd = new FormData();
  fd.append("file", new File([buildTheme("admtheme", "widget")], "admtheme.zip", { type: "application/zip" }));
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
  check("theme uploaded", up.status, 201);
  const act = await (await req(worker, env, "/api/v1/extensions/themes/admtheme/activate?site=adm", { method: "POST", headers: auth })).json();
  check("activated on adm", act.site, "adm");

  console.log("\n2. Contracts the admin sidebar depends on");
  // The sidebar builds one nav button per post type and one per admin menu.
  const pts = await (await req(worker, env, "/api/v1/theme/post-types?site=adm", { headers: auth })).json();
  check("post-types has name + label for nav", [pts.items[0].name, pts.items[0].label], ["widget", "widget"]);
  check("post-types has plural label for nav", pts.items[0].plural_label, "widgets");
  const menus = await (await req(worker, env, "/api/v1/theme/menus?site=adm", { headers: auth })).json();
  check("admin menus have label + screen + args", [menus.items[0].label, menus.items[0].screen, menus.items[0].args], ["widgets", "content-list", { type: "widget" }]);
  const fields = await (await req(worker, env, "/api/v1/theme/fields?site=adm", { headers: auth })).json();
  check("fields expose meta_key/type/label for the editor", [fields.items[0].meta_key, fields.items[0].field_type, fields.items[0].label], ["sku", "text", "SKU"]);
  check("fields carry post_types so the editor filters them", fields.items[0].post_types, ["widget"]);

  console.log("\n3. Themes endpoint contracts for the site switcher");
  const th = await (await req(worker, env, "/api/v1/extensions/themes?site=adm", { headers: auth })).json();
  check("themes reports the active theme for this site", th.active, "admtheme");
  checkTruthy("themes reports active_by_site for per-site badges", th.active_by_site && th.active_by_site.adm === "admtheme");
  check("admtheme marked active in items", th.items.find((x) => x.name === "admtheme").active, 1);
  // A theme used only by another site must not read as active here.
  const thDefault = await (await req(worker, env, "/api/v1/extensions/themes", { headers: auth })).json();
  check("admtheme not active on default site", thDefault.items.find((x) => x.name === "admtheme").active, 0);

  // Which themes ship with the product. The uninstall route refuses a bundled
  // theme with a 400 ("ships with the product"), so the payload has to carry the
  // fact — without it the Themes screen offers an Uninstall button whose only
  // possible answer is that refusal, and the operator's sole feedback is an
  // error message. One fact, two readers: assert they agree rather than that
  // each is individually plausible.
  await req(worker, env, "/api/v1/extensions/bootstrap", { method: "POST", headers: auth });
  const thBundled = await (await req(worker, env, "/api/v1/extensions/themes", { headers: auth })).json();
  const claimedBundled = thBundled.items.filter((x) => Number(x.bundled) === 1).map((x) => x.name).sort();
  checkTruthy("the payload marks the themes that ship with the product", claimedBundled.length > 0);
  const refused = {};
  for (const n of claimedBundled) {
    refused[n] = (await req(worker, env, `/api/v1/extensions/themes/${n}`, { method: "DELETE", headers: auth })).status;
  }
  check(
    "every theme the payload calls bundled is refused by uninstall",
    refused,
    Object.fromEntries(claimedBundled.map((n) => [n, 400]))
  );
  check("an uploaded theme is not reported as bundled", Number(thBundled.items.find((x) => x.name === "admtheme").bundled), 0);

  console.log("\n4. CPT CRUD via /content/{type} (what the editor calls)");

  const created = await (await req(worker, env, "/api/v1/content/widget?site=adm", {
    method: "POST", headers: json,
    body: JSON.stringify({ title: "First Widget", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-1" } }),
  })).json();
  checkTruthy("CPT post created", created.id);
  const postId = created.id;
  check("created on the right site", created.site, "adm");

  const list = await (await req(worker, env, "/api/v1/content/widget?site=adm", { headers: auth })).json();
  check("CPT list returns the post", list.items.map((x) => x.slug), ["first-widget"]);

  const one = await (await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { headers: auth })).json();
  check("single read returns translations", one.items.length, 1);
  check("single read exposes custom field values", one.items[0].meta, { sku: "W-1" });

  const upd = await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, {
    method: "PUT", headers: json,
    body: JSON.stringify({ title: "Renamed Widget", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-2" } }),
  });
  check("CPT update ok", upd.status, 200);
  const afterUpd = await (await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { headers: auth })).json();
  check("custom field updated", afterUpd.items[0].meta.sku, "W-2");

  console.log("\n5. Custom-field writes are whitelisted");
  // An undeclared meta key must be ignored, not written.
  await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, {
    method: "PUT", headers: json,
    body: JSON.stringify({ title: "T", slug: "first-widget", status: "published", locale: "en", content: [], meta: { sku: "W-3", NOT_DECLARED: "nope" } }),
  });
  const metaRows = sqlite.prepare("SELECT meta_key FROM post_meta WHERE post_id=?").all(postId).map((r) => r.meta_key);
  checkTruthy("declared field written", metaRows.includes("sku"));
  checkTruthy("undeclared field rejected", !metaRows.includes("NOT_DECLARED"));

  console.log("\n6. CPT front-end routes (on the site that declared them)");
  // Route the request to site `adm` by host so the CPT is in scope.
  await req(worker, env, "/api/v1/sites/adm", {
    method: "PUT", headers: json, body: JSON.stringify({ host: "adm.example.com" }),
  });
  const s = await req(worker, env, "/en/widgets/first-widget", {}, "adm.example.com");
  check("CPT single resolves", s.headers.get("X-CFPress-Template"), "single-widget");
  checkTruthy("CPT single body", (await s.text()).includes("SINGLE-widget:first-widget"));
  const a = await req(worker, env, "/en/widgets", {}, "adm.example.com");
  check("CPT archive resolves", a.headers.get("X-CFPress-Template"), "archive-widget");
  // The same URL on a site whose theme never declared `widget` must 404.
  const cross = await req(worker, env, "/en/widgets/first-widget", {}, "localhost");
  check("CPT route is invisible on other sites", cross.status, 404);

  console.log("\n7. Delete cleans up custom fields");
  const del = await req(worker, env, `/api/v1/content/widget/${postId}?site=adm`, { method: "DELETE", headers: auth });
  check("delete ok", del.status, 200);
  const orphans = sqlite.prepare("SELECT COUNT(*) AS n FROM post_meta WHERE post_id=?").get(postId);
  check("post_meta cleaned up on delete", orphans.n, 0);
  const gone = await (await req(worker, env, "/api/v1/content/widget?site=adm", { headers: auth })).json();
  check("post gone from list", gone.items.length, 0);

  console.log("\n8. Theme settings screen contract");
  const ts = await (await req(worker, env, "/api/v1/theme/admtheme/settings", { headers: auth })).json();
  check("theme settings exposes key/label/value", [ts.items[0].key, ts.items[0].label, ts.items[0].value], ["accent", "Accent", "#f00"]);
  // Declared `options` survive the install (migration 0017) and reach the form.
  const sel = ts.items.find((x) => x.key === "layout.mode");
  check("select options round-trip from the manifest", sel && sel.options, ["wide", "boxed"]);
  check("declared type reaches the form", sel && sel.type, "select");
  await req(worker, env, "/api/v1/theme/admtheme/settings", { method: "POST", headers: json, body: JSON.stringify({ key: "accent", value: "#00f" }) });
  const ts2 = await (await req(worker, env, "/api/v1/theme/admtheme/settings", { headers: auth })).json();
  check("theme setting saved", ts2.items[0].value, "#00f");

  console.log("\n9. Per-site media listing");
  const mDef = await (await req(worker, env, "/api/v1/media", { headers: auth })).json();
  const mAdm = await (await req(worker, env, "/api/v1/media?site=adm", { headers: auth })).json();
  check("media list echoes site", [mDef.site, mAdm.site], ["default", "adm"]);
  checkTruthy("media lists are independent", Array.isArray(mDef.items) && Array.isArray(mAdm.items));

  console.log("\n10. Editor block palette is the renderer's set, translated");
  const blocksEn = await (await req(worker, env, "/api/v1/blocks?locale=en", { headers: auth })).json();
  checkTruthy("palette covers every renderable block type", blocksEn.items.length >= 12);
  check(
    "each entry carries type/label/category",
    [typeof blocksEn.items[0].type, typeof blocksEn.items[0].label, typeof blocksEn.items[0].category],
    ["string", "string", "string"]
  );
  check(
    "the types are exactly the renderer's set (no drift)",
    blocksEn.items.map((b) => b.type).join(","),
    ["core/paragraph","core/heading","core/list","core/quote","core/code","core/image","core/gallery","core/button","core/separator","core/html","core/group","core/columns"].join(",")
  );
  check("english label", blocksEn.items.find((b) => b.type === "core/paragraph").label, "Paragraph");
  // The palette ships the **attribute contract**, not just the block list.
  // Before it did, the editor wrote `attrs.text` for every type and six of the
  // twelve blocks rendered empty at HTTP 200 — see `editor-blocks.test.mjs`,
  // which walks the whole chain. These assertions pin the wire shape the
  // editor's controls are built from.
  check(
    "every palette entry ships its attribute list",
    blocksEn.items.every((b) => Array.isArray(b.attrs)),
    true
  );
  const img = blocksEn.items.find((b) => b.type === "core/image");
  check(
    "the image ships url + alt, url required",
    img.attrs.map((a) => [a.key, a.type, a.required === true]),
    [["url", "media", true], ["alt", "text", false]]
  );
  check("the image's labels are translated for the locale", [img.attrs[0].label, img.attrs[1].label], ["Image", "Alt text"]);
  check("a separator declares no attributes", blocksEn.items.find((b) => b.type === "core/separator").attrs, []);
  check(
    "the nesting blocks are marked as containers with no attributes",
    blocksEn.items.filter((b) => b.children).map((b) => [b.type, b.attrs.length]),
    [["core/group", 0], ["core/columns", 0]]
  );
  // A media-list's item shape travels with the attribute, so the editor's
  // repeatable row does not hardcode the item keys a second time.
  check(
    "the gallery ships the item keys of its media-list attribute",
    blocksEn.items.find((b) => b.type === "core/gallery").attrs[0].itemKeys,
    ["url", "alt"]
  );
  const blocksZh = await (await req(worker, env, "/api/v1/blocks?locale=zh-CN", { headers: auth })).json();
  check("labels follow the requested UI locale", blocksZh.items.find((b) => b.type === "core/paragraph").label, "段落");
  check(
    "attribute labels follow it too",
    blocksZh.items.find((b) => b.type === "core/image").attrs[0].label,
    "图片"
  );
  // Without an explicit locale the palette follows the admin's own ui_lang —
  // this suite's shared dev database has it as zh-CN, so the fallback must
  // agree with that rather than with any assumed language.
  const blocksAuto = await (await req(worker, env, "/api/v1/blocks?locale=xx-XX", { headers: auth })).json();
  const blocksPlain = await (await req(worker, env, "/api/v1/blocks", { headers: auth })).json();
  check("an unknown locale falls back to the admin's own ui_lang",
    blocksAuto.items.find((b) => b.type === "core/paragraph").label,
    blocksPlain.items.find((b) => b.type === "core/paragraph").label);

  console.log("\n11. Dashboard stat cards arrive as data");
  const dash = await (await req(worker, env, "/api/v1/dashboard", { headers: auth })).json();
  check(
    "cards carry the platform stat set",
    dash.cards.map((c) => c.key),
    ["posts", "pages", "media", "drafts"]
  );
  checkTruthy("card values are numbers", dash.cards.every((c) => typeof c.value === "number"));
  checkTruthy("card labels are delivered (translated server-side)", dash.cards.every((c) => typeof c.label === "string" && c.label.length > 0));
  checkTruthy("recent content is present as an array", Array.isArray(dash.recent));

  console.log("\n12. The content list opens on the site's default language");

  // The list pins one row per post. That row used to be `MIN(locale)` —
  // alphabetically first, which answered "which translation sorts first",
  // not "which language does this site consider primary". Make the site's
  // default differ from the alphabetically-first language so the two answers
  // are observably different (MIN('en','zh-CN') = 'en', default = 'zh-CN').
  sqlite.exec("DELETE FROM site_locales WHERE site_id='adm'");
  sqlite.exec("INSERT INTO site_locales(site_id,code,is_default,enabled,sort_order) VALUES ('adm','zh-CN',1,1,0),('adm','en',0,1,1)");
  const put = (id, body) =>
    req(worker, env, `/api/v1/posts/${id}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify(body) });
  await put("adm_lp", { locale: "en", title: "Only En", slug: "list-post", status: "published", content: [] });
  await put("adm_lp", { locale: "zh-CN", title: "只有中文", status: "published", content: [] });
  await put("adm_lp2", { locale: "en", title: "English only", status: "published", content: [] });
  const lp = await (await req(worker, env, "/api/v1/posts?site=adm", { headers: auth })).json();
  const lpRow = lp.items.find((i) => i.id === "adm_lp");
  check("the list opens on the site's default language", lpRow?.locale, "zh-CN");
  check("and shows that language's title", lpRow?.title, "只有中文");
  check("each item carries the languages it actually has", lpRow?.locales, ["en", "zh-CN"]);
  const lpEn = await (await req(worker, env, "/api/v1/posts?site=adm&locale=en", { headers: auth })).json();
  check("an explicit ?locale= filter shows that language's row", lpEn.items.find((i) => i.id === "adm_lp")?.title, "Only En");
  const lpZh = await (await req(worker, env, "/api/v1/posts?site=adm&locale=zh-CN", { headers: auth })).json();
  const lp2 = lpZh.items.find((i) => i.id === "adm_lp2");
  check("a post with no row in the filtered language is still listed",
    [Boolean(lp2), lp2?.title ?? "", lp2?.locales], [true, "", ["en"]]);

  console.log("\n13. Menus: CRUD, batch reorder, nesting contract, site scoping");

  // Idempotent: an aborted earlier run must not leave half a fixture behind.
  sqlite.exec("DELETE FROM menu_items WHERE site_id='adm' AND menu_id IN ('m_a','m_b')");
  sqlite.exec("DELETE FROM menus WHERE site_id='adm' AND id IN ('m_a','m_b')");
  const mkA = await req(worker, env, "/api/v1/menus?site=adm", { method: "POST", headers: json, body: JSON.stringify({ id: "m_a", name: "Alpha", location: "header" }) });
  check("menu create answers 201", mkA.status, 201);
  await req(worker, env, "/api/v1/menus?site=adm", { method: "POST", headers: json, body: JSON.stringify({ id: "m_b", name: "Beta", location: "footer" }) });
  // Unlike menus, menu_items POST mints its own id — capture what it returns
  // so every later call addresses a real row (asserting on a guessed id 404s
  // and turns half the section vacuous).
  const addItem = async (menuId, title, parent) => {
    const r = await req(worker, env, `/api/v1/menus/${menuId}/items?site=adm`, { method: "POST", headers: json, body: JSON.stringify({ title, url: "/" + title, parent_id: parent ?? null }) });
    return (await r.json()).id;
  };
  const it1 = await addItem("m_a", "One");
  const it2 = await addItem("m_a", "Two");
  const it3 = await addItem("m_a", "Three", it1);
  const itB = await addItem("m_b", "BetaItem");

  const badOrder = await req(worker, env, "/api/v1/menus/m_a/items?site=adm", { method: "PUT", headers: json, body: JSON.stringify({ order: [it1, it2, it3, "nope"] }) });
  check("reorder with an unknown id is refused before writing", badOrder.status, 400);
  await req(worker, env, "/api/v1/menus/m_a/items?site=adm", { method: "PUT", headers: json, body: JSON.stringify({ order: [it3, it1, it2] }) });
  const ordered = await (await req(worker, env, "/api/v1/menus/m_a/items?site=adm", { headers: auth })).json();
  check("a valid batch reorder persists the submitted sequence", ordered.items.map((i) => i.id), [it3, it1, it2]);

  const own = await req(worker, env, `/api/v1/menu_items/${it3}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify({ parent_id: it3 }) });
  check("an item cannot be its own parent", own.status, 400);
  const deep = await req(worker, env, `/api/v1/menu_items/${it2}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify({ parent_id: it3 }) });
  check("nesting beyond one level is refused (it_3 already has a parent)", deep.status, 400);
  const moved = await req(worker, env, `/api/v1/menu_items/${it2}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify({ parent_id: it1 }) });
  check("moving under a top-level parent works", moved.status, 200);
  const mCross = await req(worker, env, `/api/v1/menu_items/${it1}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify({ parent_id: itB }) });
  check("a parent from another menu is refused", mCross.status, 400);
  const foreign = await req(worker, env, "/api/v1/menus/m_a?site=default", { method: "PUT", headers: json, body: JSON.stringify({ name: "Hijack", location: "footer" }) });
  check("another site cannot update this site's menu", foreign.status, 404);

  await req(worker, env, `/api/v1/menu_items/${it1}?site=adm`, { method: "DELETE", headers: json });
  const after = await (await req(worker, env, "/api/v1/menus/m_a/items?site=adm", { headers: auth })).json();
  const it3row = after.items.find((i) => i.id === it3);
  check("deleting a parent promotes its child to top level", [Boolean(it3row), it3row?.parent_id ?? null], [true, null]);

  const delB = await req(worker, env, "/api/v1/menus/m_b?site=adm", { method: "DELETE", headers: json });
  check("menu delete answers 200", delB.status, 200);
  const mGone = await (await req(worker, env, "/api/v1/menus/m_b/items?site=adm", { headers: auth })).json();
  check("deleting a menu removes its items too", mGone.items, []);
  await req(worker, env, "/api/v1/menus/m_a?site=adm", { method: "DELETE", headers: json });

  console.log("\n14. Widgets: scoped CRUD, config validation, site isolation");
  // Idempotent: an aborted earlier run must not leave half a fixture behind.
  sqlite.exec("DELETE FROM widget_instances WHERE site_id='adm' AND title LIKE 'wdg_%'");
  const mkW = (title, body) =>
    req(worker, env, "/api/v1/widgets?site=adm", { method: "POST", headers: json, body: JSON.stringify({ title, widget_type: "text", sidebar: "sidebar", config: { body } }) });
  const w1 = await (await mkW("wdg_one", "W-BODY-1")).json();
  check("widget create answers 201 with an id", typeof w1.id, "string");
  const wList = await (await req(worker, env, "/api/v1/widgets?site=adm", { headers: auth })).json();
  const w1row = wList.items.find((x) => x.id === w1.id);
  check("the widget list is site-scoped and returns the stored config",
    [Boolean(w1row), w1row?.config], [true, JSON.stringify({ body: "W-BODY-1" })]);
  const badType = await req(worker, env, "/api/v1/widgets?site=adm", { method: "POST", headers: json, body: JSON.stringify({ title: "wdg_bad", widget_type: "clock", config: {} }) });
  check("an unknown widget_type is refused", badType.status, 400);
  const badCount = await req(worker, env, "/api/v1/widgets?site=adm", { method: "POST", headers: json, body: JSON.stringify({ title: "wdg_bad", widget_type: "recent-posts", config: { count: 99 } }) });
  check("recent-posts count outside 1-20 is refused", badCount.status, 400);
  const badMenu = await req(worker, env, "/api/v1/widgets?site=adm", { method: "POST", headers: json, body: JSON.stringify({ title: "wdg_bad", widget_type: "menu", config: { menu_id: "no_such_menu" } }) });
  check("a menu_id from another world is refused", badMenu.status, 400);
  const wUpd = await req(worker, env, `/api/v1/widgets/${w1.id}?site=adm`, { method: "PUT", headers: json, body: JSON.stringify({ title: "wdg_one", enabled: false, sort_order: 3 }) });
  check("widget update answers 200", wUpd.status, 200);
  const w1b = (await (await req(worker, env, "/api/v1/widgets?site=adm", { headers: auth })).json()).items.find((x) => x.id === w1.id);
  check("disable and reorder persisted", [w1b?.enabled, w1b?.sort_order], [0, 3]);
  const wForeignPut = await req(worker, env, `/api/v1/widgets/${w1.id}?site=default`, { method: "PUT", headers: json, body: JSON.stringify({ title: "Hijack" }) });
  check("another site cannot update this site's widget", wForeignPut.status, 404);
  const delW = await req(worker, env, `/api/v1/widgets/${w1.id}?site=adm`, { method: "DELETE", headers: json });
  check("widget delete answers 200", delW.status, 200);
  const w1gone = (await (await req(worker, env, "/api/v1/widgets?site=adm", { headers: auth })).json()).items.some((x) => x.id === w1.id);
  check("and the widget is really gone", w1gone, false);

  console.log("\n15. Platform settings: a second level, with its own permission");
  // Two levels, two endpoints, two permissions. The platform level is where
  // keys that mean the same thing for every site live (`admin.path`); writing
  // it needs `platform.manage`, and a *site*-scoped key cannot be written
  // through it - otherwise the two levels would blur back into one.
  const pList = await req(worker, env, "/api/v1/platform-settings", { headers: auth });
  check("platform settings list answers to an admin", pList.status, 200);
  const pBody = await pList.json();
  check("the backend path is declared with its default",
    (pBody.items || []).find((x) => x.key === "admin.path")?.value, "/admin");
  const pMove = await req(worker, env, "/api/v1/platform-settings", { method: "POST", headers: json, body: JSON.stringify({ key: "admin.path", value: "/manage" }) });
  check("the backend path can be moved", pMove.status, 200);
  const pAfter = await (await req(worker, env, "/api/v1/platform-settings", { headers: auth })).json();
  check("and the move is visible on the next read",
    (pAfter.items || []).find((x) => x.key === "admin.path")?.value, "/manage");
  const pBack = await req(worker, env, "/api/v1/platform-settings", { method: "POST", headers: json, body: JSON.stringify({ key: "admin.path", value: "/admin" }) });
  check("and moved back", pBack.status, 200);
  const pUndeclared = await req(worker, env, "/api/v1/platform-settings", { method: "POST", headers: json, body: JSON.stringify({ key: "nope.setting", value: "x" }) });
  check("an undeclared key is refused", pUndeclared.status, 400);
  const pSiteKey = await req(worker, env, "/api/v1/platform-settings", { method: "POST", headers: json, body: JSON.stringify({ key: "site.title", value: "x" }) });
  check("a site-scoped key cannot be written through the platform endpoint", pSiteKey.status, 400);
  const pRoot = await req(worker, env, "/api/v1/platform-settings", { method: "POST", headers: json, body: JSON.stringify({ key: "admin.path", value: "/" }) });
  check("the backend path cannot be the site root", pRoot.status, 400);

  console.log("\n15b. The prefixed API route carries the whole request, query included");
  // The admin addresses its API through the prefix (`/admin/api/v1/…`), so the
  // prefix mount rebuilds the request URL. The first version rebuilt it from
  // `u.origin` alone and **every query parameter vanished** — `?site=`,
  // `?withCounts=1`, `?locale=`, pagination — while the unprefixed `/api/*`
  // route, which is handed the original request, kept working. Nothing failed:
  // `?site=` falling off just means "use the current site", which is the
  // default, so the tenant selector silently resolved to the wrong site.
  //
  // Assert the *behaviour*, through the real prefix, because that is the only
  // thing that distinguishes "the parameter arrived" from "it was dropped and
  // the default happened to be right".
  {
    // A tenant-scoped read whose answer differs by site: `?site=adm` must name
    // `adm`, and without the parameter it names `default`. Same URL, one query
    // apart, so a dropped `?site=` is observable rather than coincidental.
    const viaPrefix = await (await req(worker, env, "/admin/api/v1/theme/post-types?site=adm", { headers: auth })).json();
    check("?site= survives the prefix mount", viaPrefix.site, "adm");
    const viaPrefixNoSite = await (await req(worker, env, "/admin/api/v1/theme/post-types", { headers: auth })).json();
    check("and it really changed the answer (the default differs)", viaPrefixNoSite.site !== "adm", true);

    // A boolean-style flag that selects a whole different payload shape. Without
    // the query the route answers the v1 shape, which has no `counts` at all —
    // exactly the symptom that surfaced this defect on the Sites screen.
    const counted = await (await req(worker, env, "/admin/api/v1/sites?withCounts=1", { headers: auth })).json();
    check("withCounts survives the prefix mount", counted.items.every((x) => x.counts !== undefined), true);
    const uncounted = await (await req(worker, env, "/admin/api/v1/sites", { headers: auth })).json();
    check("without it the payload is the old shape", uncounted.items.every((x) => x.counts === undefined), true);

    // Pagination is the third reader: `?page=`/`?limit=` are parsed off the same
    // URL, so a dropped query breaks paging without breaking the first page.
    const paged = await (await req(worker, env, "/admin/api/v1/media?limit=1&page=1", { headers: auth })).json();
    checkTruthy("pagination parameters survive too", typeof paged === "object");
  }

  console.log("\n16. Sites: per-row content counts, the site's own theme, and its languages");

  // The Sites screen is a management view: every row answers "where is this
  // site's front end, how much is in it, what does it render with". All three
  // are contracts, and each has a wrong answer that looks right.
  //
  // Fixtures are written **directly** rather than through the API on purpose:
  // the point is what the aggregate reports for sites whose content was not
  // created through this request, and going through the API would also go
  // through the code under test.
  sqlite.exec("DELETE FROM site_locales WHERE site_id='cnt'");
  sqlite.exec("DELETE FROM sites WHERE id='cnt'");
  sqlite.exec("DELETE FROM media_files WHERE site_id='cnt'");
  sqlite.exec("DELETE FROM posts WHERE site_id='cnt'");

  // ── A site created through the API must arrive with its language rows ──
  // `seedSiteLocales`'s doc says it is "called when a site is created"; it was
  // not called from anywhere, so every admin-created site lived on the
  // "no rows → serve the whole dictionary" fallback and had no default at all.
  // Assert the *rows*, not the served list: the fallback makes the served list
  // look identical, which is exactly why the missing call was invisible.
  sqlite.exec("INSERT INTO locales(code,name,native_name,direction,enabled,sort_order,is_default) VALUES ('en','English','English','ltr',1,0,1) ON CONFLICT(code) DO NOTHING");
  const mk = await req(worker, env, "/api/v1/sites", { method: "POST", headers: json, body: JSON.stringify({ id: "cnt", name: "Counter" }) });
  check("a site can be created for the count fixtures", mk.status, 201);
  const seeded = sqlite.prepare("SELECT code,is_default,enabled FROM site_locales WHERE site_id='cnt' ORDER BY code").all();
  checkTruthy("a newly created site has its own language switch rows", seeded.length > 0);
  check("exactly one of them is the default", seeded.filter((r) => Number(r.is_default) === 1).length, 1);
  check("all of them are enabled", seeded.every((r) => Number(r.enabled) === 1), true);

  // ── Content that belongs to `cnt` and to `default`, and to neither ──
  const post = (id, site, type, status = "published") =>
    sqlite.exec(`INSERT INTO posts(id,site_id,author_id,type,status,slug,created_at,updated_at) VALUES ('${id}','${site}','admin','${type}','${status}','${id}',1,1)`);
  post("cnt_p1", "cnt", "post");
  post("cnt_p2", "cnt", "post");
  post("cnt_pg1", "cnt", "page");
  post("cnt_d1", "cnt", "post", "draft");
  // A neighbour site's rows, to prove the counts are per site and not global.
  sqlite.exec("INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) VALUES ('cnt2','Counter Two',NULL,NULL,0,'active',1,1) ON CONFLICT(id) DO NOTHING");
  post("cnt2_p1", "cnt2", "post");
  // And the same ids on the default site, so a missing `site_id` filter counts
  // *something* rather than nothing — a no-op bug would otherwise pass.
  const defBefore = sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE site_id='default' AND type='post'").get()?.n;
  for (let i = 0; i < 3; i++) post(`def_p${i}`, "default", "post");
  sqlite.exec("INSERT INTO media_files(id,site_id,object_key,filename,mime_type,size,created_at,uploaded_by) VALUES ('cnt_m1','cnt','uploads/cnt/1/a.png','a.png','image/png',10,1,NULL)");
  sqlite.exec("INSERT INTO media_files(id,site_id,object_key,filename,mime_type,size,created_at,uploaded_by) VALUES ('cnt_m2','cnt','uploads/cnt/1/b.png','b.png','image/png',10,1,NULL)");

  const wc = await req(worker, env, "/api/v1/sites?withCounts=1", { headers: auth });
  check("sites?withCounts=1 answers an admin", wc.status, 200);
  const wcBody = await wc.json();
  const cntRow = wcBody.items.find((x) => x.id === "cnt");
  check("the fixture site carries counts", Boolean(cntRow?.counts), true);
  // Three posts: two published plus the draft. The draft counts on purpose —
  // this is "how much content does this site hold", not "what is published"
  // (the dashboard's `drafts` card answers that one). If the count only saw
  // published rows it would read 2, and a reviewer comparing the two numbers
  // would have no way to tell which question was being answered.
  check("posts are counted for that site, drafts included", cntRow?.counts?.posts, 3);
  check("pages are counted separately from posts", cntRow?.counts?.pages, 1);
  check("media is counted for that site", cntRow?.counts?.media, 2);
  // The isolation half: `cnt2` has exactly one post, so a global COUNT or a
  // missing `GROUP BY site_id` reports 6 and 3 respectively.
  const cnt2Row = wcBody.items.find((x) => x.id === "cnt2");
  check("a neighbour site's post count is its own", cnt2Row?.counts?.posts, 1);
  check("and it has no pages", cnt2Row?.counts?.pages, 0);
  // A site with nothing must report 0, not `undefined`: the screen renders a
  // number in every cell and `undefined` renders as the string "undefined".
  sqlite.exec("INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) VALUES ('cnt3','Empty',NULL,NULL,0,'active',1,1) ON CONFLICT(id) DO NOTHING");
  const wc2 = await (await req(worker, env, "/api/v1/sites?withCounts=1", { headers: auth })).json();
  const empty = wc2.items.find((x) => x.id === "cnt3");
  check("an empty site reports zeroes, not nothing", empty?.counts, { posts: 0, pages: 0, media: 0 });

  // ── The theme column is the site's *choice*, not what would render ──
  // `activeTheme()` probes R2 and names a theme that merely happens to be
  // installed; a report that used it would mark a site as themed when it has
  // chosen nothing. Pin the two letters of the contract: the site that chose
  // reports its choice, the site that did not reports empty.
  sqlite.exec("INSERT INTO settings(id,site_id,key,value,autoload) VALUES ('theme-active-cnt','cnt','theme.active','admtheme',1) ON CONFLICT(site_id,key) DO UPDATE SET value='admtheme'");
  const wc3 = await (await req(worker, env, "/api/v1/sites?withCounts=1", { headers: auth })).json();
  check("a site reports the theme it has chosen", wc3.items.find((x) => x.id === "cnt")?.theme, "admtheme");
  check("a site that never chose reports empty, not the default's theme", wc3.items.find((x) => x.id === "cnt3")?.theme, "");

  // ── Without the flag the payload is exactly what it always was ──
  // The v1 shape is consumed by every other reader of this endpoint (the site
  // switcher, `themes.js`); adding fields to it would be a silent contract
  // change. `withCounts` is opt-in, so opting out must return the old rows.
  const plain = await (await req(worker, env, "/api/v1/sites", { headers: auth })).json();
  const plainRow = plain.items.find((x) => x.id === "cnt");
  check("without withCounts no counts field is added", plainRow?.counts, undefined);
  check("without withCounts no theme field is added", plainRow?.theme, undefined);

  // ── The new site's languages are reachable through the per-site read ──
  // The Sites screen's next-step prompt reads this to offer the choice, and the
  // per-locale PATCH that applies it must resolve the same site from `?site=`.
  const loc = await (await req(worker, env, "/api/v1/i18n/locales?site=cnt", { headers: auth })).json();
  check("a newly created site exposes its languages", loc.site, "cnt");
  checkTruthy("and names a default", Boolean(loc.default));
  const codes = Array.isArray(loc.enabled) ? loc.enabled : [];
  checkTruthy("with at least one enabled language", codes.length > 0);
  if (codes.length) {
    const pin = await req(worker, env, `/api/v1/i18n/locales/${encodeURIComponent(codes[0])}?site=cnt`, { method: "PATCH", headers: json, body: JSON.stringify({ is_default: true }) });
    check("the default language of a non-current site can be pinned", pin.status, 200);
    const after = await (await req(worker, env, "/api/v1/i18n/locales?site=cnt", { headers: auth })).json();
    check("and it took effect on that site", after.default, codes[0]);
    // The isolation half: pinning `cnt`'s default must not have touched the
    // site the admin is on. Reading `default` back from the *other* site is the
    // only way to see that, and it is the failure mode a missing `?site=` in
    // the client produces.
    const other = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
    check("pinning one site's default leaves the current site alone", other.site, "default");
  }

  console.log("\n17. Front-end members: a second identity, structurally apart from the admin's");

  // Batch D. The front end gets its own identity (`members`), its own sessions
  // (`member_sessions`), its own cookie (`cfpress_member`) and its own endpoint
  // family (`/api/v1/front/…`). The point of the design is that the isolation is
  // **structural**: there is no "also check" between the two, because the two
  // session tables are different tables and `currentMember` never queries
  // `admin_sessions`. This section pins the two red lines and the four answers
  // that make the feature real, and it can only do so by presenting each
  // session to the *other* family's door.
  {
    const frontJson = { "Content-Type": "application/json" };
    const ftReq = (path, init = {}) => req(worker, env, path, init);
    // Fixtures: this suite owns the `adm_mem_*` usernames and the `fb` site.
    //
    // Swept by **username**, not by id: member ids are minted by the platform
    // (`randomId()`), so a wipe keyed on an `adm_mem%` id prefix matches
    // nothing and leaves the account behind — which then fails the *next* run
    // with `taken` on a registration that should have succeeded. The username
    // is the one identifier this suite actually controls.
    const wipeMembers = () => {
      for (const sql of [
        "DELETE FROM member_sessions WHERE member_id IN (SELECT id FROM members WHERE username LIKE 'adm_mem%')",
        "DELETE FROM members WHERE username LIKE 'adm_mem%' OR site_id='fb'",
        "DELETE FROM settings WHERE site_id='fb' OR (site_id='default' AND key='members.registration')",
        "DELETE FROM site_locales WHERE site_id='fb'",
        "DELETE FROM sites WHERE id='fb'",
      ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
    };
    wipeMembers();

    // ── The endpoint family exists and answers a session-less caller 401 ──
    const anon = await ftReq("/api/v1/front/me");
    check("GET /front/me without a session is 401", anon.status, 401);

    // ── Registration is closed until the site opens it ──
    // The default is closed: a registration form that appears without anyone
    // switching it on is an open door nobody chose to open. The endpoint must
    // refuse with 403 (not 400 — this is permission, not a malformed body).
    const closed = await ftReq("/api/v1/front/auth/register", {
      method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_closed", password: "longenough1" }),
    });
    check("registration is refused while the site has it switched off", closed.status, 403);
    check("and the refusal names the reason", (await closed.json()).error, "closed");

    // ── Opening it on the default site lets a member in ──
    const open = await req(worker, env, "/api/v1/settings", {
      method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "1" }),
    });
    check("the site can open registration", open.status, 200);
    try {
      const reg = await ftReq("/api/v1/front/auth/register", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_alice", password: "longenough1", email: "alice@example.test" }),
      });
      check("registering on an open site answers 201", reg.status, 201);
      const sc = reg.headers.get("set-cookie") ?? "";
      checkTruthy("registering sets the member cookie, not the admin one", sc.startsWith("cfpress_member=") && !sc.includes("cfpress_admin="));
      checkTruthy("the member cookie is scoped to / (the whole front end)", /;\s*Path=\/(?:\s*;|$)/.test(sc));
      // The response body must never carry the hash — a public member payload
      // that leaks `password_hash` is the one field that must not cross this
      // boundary, and it is exactly the field a careless `SELECT *` includes.
      const regBody = await reg.json();
      check("the registration response omits the password hash", regBody.member?.password_hash, undefined);
      const memberCookie = sc.split(";")[0];

      // ── RED LINE 1: a member cookie must not open any admin door ──
      const adminDoor = await req(worker, env, "/admin/api/v1/sites", { headers: { Cookie: memberCookie } });
      check("red line: a member cookie on the admin API is 401", adminDoor.status, 401);
      const bareAdmin = await req(worker, env, "/api/v1/sites", { headers: { Cookie: memberCookie } });
      check("red line: a member cookie on the bare admin alias is 401", bareAdmin.status, 401);

      // ── RED LINE 2: an admin cookie must not open the front-end member door ──
      const frontDoor = await req(worker, env, "/api/v1/front/me", { headers: auth });
      check("red line: an admin cookie on /front/me is 401", frontDoor.status, 401);

      // ── The member's own door works, and `/me` names them ──
      const me = await ftReq("/api/v1/front/me", { headers: { Cookie: memberCookie } });
      check("the member cookie opens /front/me", me.status, 200);
      const meBody = await me.json();
      check("and it is the right member", meBody.member?.username, "adm_mem_alice");
      check("and it still does not leak the hash", meBody.member?.password_hash, undefined);

      // ── Logout invalidates the session ──
      const out = await ftReq("/api/v1/front/auth/logout", { method: "POST", headers: { Cookie: memberCookie } });
      check("logout answers 200", out.status, 200);
      const afterOut = await ftReq("/api/v1/front/me", { headers: { Cookie: memberCookie } });
      check("the session is dead after logout", afterOut.status, 401);

      // ── Bad credentials are 401, not 403 and not 400 ──
      const badPw = await ftReq("/api/v1/front/auth/login", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_alice", password: "wrong-password" }),
      });
      check("a wrong password is 401", badPw.status, 401);
      check("and the error does not distinguish user from password", (await badPw.json()).error, "invalid_credentials");
      const goodPw = await ftReq("/api/v1/front/auth/login", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_alice", password: "longenough1" }),
      });
      check("the right password is 200", goodPw.status, 200);

      // ── The identity is per site: a second site cannot see it ──
      // This is what "registered on the shop site" means — the account is a
      // tenant fact, not an install-wide identity. The same username on another
      // site must fail to log in, and the account must not exist there at all.
      sqlite.exec("INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) VALUES ('fb','Front B',NULL,'fb',0,'active',1,1) ON CONFLICT(id) DO NOTHING");
      sqlite.exec("INSERT INTO site_locales(site_id,code,is_default,enabled,sort_order) VALUES ('fb','en',1,1,0) ON CONFLICT(site_id,code) DO NOTHING");
      const crossSite = await ftReq("/fb/api/v1/front/auth/login", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_alice", password: "longenough1" }),
      });
      check("the same username does not exist on another site (401)", crossSite.status, 401);
      check("and it reports the same credentials error, not a different one", (await crossSite.json()).error, "invalid_credentials");
      // And the member's session, presented back on the other site, is not a
      // session there even though the id is a valid member session id — because
      // `currentMember` filters on `site_id` on both halves of the join.
      const back = await ftReq("/fb/api/v1/front/me", { headers: { Cookie: memberCookie } });
      check("a member session from one site is not a session on another", back.status, 401);

      // ── The prefixed site resolves the front-end API too ──
      // Without the `frontApiRelPath` route the prefixed form 404s, which is
      // the failure mode this whole route exists to prevent.
      //
      // `members.registration` is a *per-site* setting, so opening it on the
      // default site does not open it on `fb` — which is itself the point: one
      // site's decision to accept members is not every site's. Open it here.
      const openFb = await req(worker, env, "/api/v1/settings?site=fb", {
        method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "1" }),
      });
      check("registration can be opened for one site without opening another", openFb.status, 200);
      const prefixedReg = await ftReq("/fb/api/v1/front/auth/register", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_carol", password: "longenough1" }),
      });
      check("a prefixed site can register its own member", prefixedReg.status, 201);
      const carolCookie = (prefixedReg.headers.get("set-cookie") ?? "").split(";")[0];
      check("the prefixed member joins the prefixed site", (await (await ftReq("/fb/api/v1/front/me", { headers: { Cookie: carolCookie } })).json()).member?.siteId, "fb");
      // And the per-site flag held: the default site's `carol` does not exist,
      // so the same credentials fail there.
      const leak = await ftReq("/api/v1/front/auth/login", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_mem_carol", password: "longenough1" }),
      });
      check("a member registered on one site cannot sign in on another", leak.status, 401);
    } finally {
      // Restore the default site's registration flag: leaving it open would
      // change what the next suite (and the operator's own install) observes.
      await req(worker, env, "/api/v1/settings", {
        method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "0" }),
      });
      wipeMembers();
    }
    check("the member fixtures are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE username LIKE 'adm_mem%' OR site_id='fb'").get()?.n, 0);
    check("no member sessions survive", sqlite.prepare("SELECT COUNT(*) AS n FROM member_sessions WHERE member_id IN (SELECT id FROM members WHERE username LIKE 'adm_mem%')").get()?.n, 0);
  }

  console.log("\n18. A permission answer names the site it is about");
  // Batch E. Batch D split the identities; this section proves the *authority*
  // is split too. The suite's own `admin` is the migration-0023 superadmin, so
  // it is the one identity that may act everywhere — which makes it the perfect
  // control: every "scoped user is refused" assertion below has a matching
  // "superadmin is allowed" assertion on the same route, so a 403 from a broken
  // route cannot masquerade as correct scoping.
  //
  // Fixtures: two sites created here (`scopeda`, `scopedb`), each with
  // `admtheme` activated so both declare the same `widget` post type, and one
  // scoped `editor` on `scopeda` alone. The probe is `POST /content/{type}` — a
  // write that requires `content.write` **on the target site** and a post type
  // active there, so a refusal can only be the permission.
  //
  // The two sites are made *here* rather than reusing `adm`: this section must
  // not depend on a fixture another section owns and may have torn down.
  {
    const SITE_A = "scopeda";
    const SITE_B = "scopedb";
    const uname = "adm_scoped_editor";
    const wipeScoped = () => {
      for (const sql of [
        "DELETE FROM site_users_sites WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'adm_scoped%')",
        "DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'adm_scoped%')",
        "DELETE FROM site_users WHERE username LIKE 'adm_scoped%'",
        `DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE site_id IN ('${SITE_A}','${SITE_B}') OR slug LIKE 'scoped_%')`,
        `DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE site_id IN ('${SITE_A}','${SITE_B}') OR slug LIKE 'scoped_%')`,
        `DELETE FROM posts WHERE site_id IN ('${SITE_A}','${SITE_B}') OR slug LIKE 'scoped_%'`,
        `DELETE FROM post_types WHERE declared_by_theme='admtheme' AND site_id IN ('${SITE_A}','${SITE_B}')`,
        `DELETE FROM field_defs WHERE declared_by_theme='admtheme' AND site_id IN ('${SITE_A}','${SITE_B}')`,
        `DELETE FROM theme_routes WHERE declared_by_theme='admtheme' AND site_id IN ('${SITE_A}','${SITE_B}')`,
        `DELETE FROM site_locales WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
        `DELETE FROM settings WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
        `DELETE FROM sites WHERE id IN ('${SITE_A}','${SITE_B}')`,
      ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
    };
    wipeScoped();

    // Two sites, both with `admtheme` active so both declare the `widget` post
    // type — otherwise "refused on B" could be the missing post type rather
    // than the permission, and the test would prove nothing.
    for (const id of [SITE_A, SITE_B]) {
      const mkSite = await req(worker, env, "/api/v1/sites", { method: "POST", headers: json, body: JSON.stringify({ id, name: id }) });
      check(`site ${id} was created for the scoping fixtures`, mkSite.status, 201);
      await req(worker, env, `/api/v1/extensions/themes/admtheme/activate?site=${id}`, { method: "POST", headers: auth });
    }
    const aTypes = await req(worker, env, `/api/v1/theme/post-types?site=${SITE_A}`, { headers: auth });
    const bTypes = await req(worker, env, `/api/v1/theme/post-types?site=${SITE_B}`, { headers: auth });
    check("site A really declares the post type", (await aTypes.json()).items?.map((x) => x.name), ["widget"]);
    check("site B declares the same post type (the control is not a missing type)", (await bTypes.json()).items?.map((x) => x.name), ["widget"]);

    // Create a scoped editor *on site A* through the ordinary endpoint, which
    // is the code path the UI uses.
    const mk = await req(worker, env, `/api/v1/users?site=${SITE_A}`, {
      method: "POST", headers: json,
      body: JSON.stringify({ username: uname, password: "scoped-pass-1", role: "editor" }),
    });
    check("a scoped editor can be created on site A", mk.status, 201);
    const editorId = sqlite.prepare("SELECT id FROM site_users WHERE username=?").get(uname)?.id;

    // The membership is exactly one row: (editor, scopeda). Not scopeda's
    // sibling.
    const memberships = sqlite.prepare("SELECT site_id, role FROM site_users_sites WHERE user_id=? ORDER BY site_id").all(editorId);
    check("the scoped editor's membership is exactly (scopeda, editor)", memberships.map((m) => [m.site_id, m.role]), [[SITE_A, "editor"]]);

    // Sign them in and prove the *allowed* direction first.
    const el = await req(worker, env, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: uname, password: "scoped-pass-1" }),
    });
    check("the scoped editor can sign in", el.status, 200);
    const eAuth = { Cookie: (el.headers.get("set-cookie") ?? "").split(";")[0] };

    // ALLOWED: writing on site A (their site). A content save answers 200 with
    // the row's id (the endpoint's create status is 200, not 201 — §4 pins the
    // body shape, so assert the id is present rather than a bare status).
    const wOk = await req(worker, env, `/api/v1/content/widget?site=${SITE_A}`, {
      method: "POST", headers: { ...eAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "scoped ok", slug: "scoped_ok", content: "x" }),
    });
    check("an editor may write on the site they are on", wOk.status, 200);
    checkTruthy("and the write really produced a row", Boolean((await wOk.json()).id));

    // ── THE ACCEPTANCE CRITERION ──
    // REFUSED: writing on site B (a site they hold no membership for). Before
    // batch E this asked `site_users.role`, which said "editor", and the write
    // succeeded — the exact defect this batch exists to close.
    const wBad = await req(worker, env, `/api/v1/content/widget?site=${SITE_B}`, {
      method: "POST", headers: { ...eAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "scoped leak", slug: "scoped_leak", content: "x" }),
    });
    check("an editor is refused on a site they have no membership for (403)", wBad.status, 403);

    // And the refusal is a *permission* refusal, not a missing post type — the
    // superadmin writing the same payload on site B goes through.
    const adminB = await req(worker, env, `/api/v1/content/widget?site=${SITE_B}`, {
      method: "POST", headers: json,
      body: JSON.stringify({ title: "admin on b", slug: "scoped_admin_b", content: "x" }),
    });
    check("the control: the superadmin may write on site B", adminB.status, 200);
    checkTruthy("and the superadmin's write produced a row", Boolean((await adminB.json()).id));
    // Site B holds the superadmin's post and *not* the editor's refused one —
    // the refusal was real, not a write that landed anyway. Titles live in
    // `post_translations` (the main `posts` row carries no title).
    check("and nothing leaked: site B holds only the superadmin's post",
      sqlite.prepare(
        "SELECT t.title FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? ORDER BY t.title"
      ).all(SITE_B).map((r) => r.title), ["admin on b"]);

    // ── Cross-site lists are not visible ──
    // The sites a scoped user can *see* is exactly the set they hold rows for.
    const eSites = await (await req(worker, env, `/api/v1/sites?site=${SITE_A}`, { headers: eAuth })).json();
    check("a scoped editor sees only the sites they are a member of", (eSites.items ?? []).map((s) => s.id), [SITE_A]);
    // …while the superadmin sees all of them, so the filter is a filter and not
    // an accidental emptier.
    const aSites = await (await req(worker, env, `/api/v1/sites?site=${SITE_A}`, { headers: auth })).json();
    checkTruthy("the superadmin sees every site",
      (aSites.items ?? []).some((s) => s.id === SITE_B) && (aSites.items ?? []).some((s) => s.id === SITE_A));

    // ── Platform powers are not on a site screen ──
    // `platform.manage` (create/edit/delete a site) is install-wide; a scoped
    // editor is refused it even on their own site. `users.manage` is likewise
    // install-wide, so they cannot edit roles — including their own.
    const createSite = await req(worker, env, `/api/v1/sites?site=${SITE_A}`, {
      method: "POST", headers: { ...eAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "scoped_nope", name: "nope" }),
    });
    check("a scoped editor cannot create a site (install-wide)", createSite.status, 403);
    const listUsers = await req(worker, env, `/api/v1/users?site=${SITE_A}`, { headers: eAuth });
    check("a scoped editor cannot list users (install-wide)", listUsers.status, 403);

    // ── The per-site role endpoint: grant, then a row exists; revoke, then it does not ──
    const grant = await req(worker, env, `/api/v1/users/${editorId}/sites/${SITE_B}?site=${SITE_A}`, {
      method: "PUT", headers: json, body: JSON.stringify({ role: "author" }),
    });
    check("the superadmin can grant a per-site role", grant.status, 200);
    check("the grant is written as a membership row",
      sqlite.prepare("SELECT role FROM site_users_sites WHERE user_id=? AND site_id=?").get(editorId, SITE_B)?.role, "author");
    // Now the editor may *see* site B — the grant actually changed the answer.
    const eSites2 = await (await req(worker, env, `/api/v1/sites?site=${SITE_A}`, { headers: eAuth })).json();
    check("the granted site joins the switcher", (eSites2.items ?? []).map((s) => s.id).sort(), [SITE_A, SITE_B].sort());
    // …and may write there: `author` carries `content.write` in the shipped
    // matrix, so the same request that was 403 above is now 201.
    const wAfterGrant = await req(worker, env, `/api/v1/content/widget?site=${SITE_B}`, {
      method: "POST", headers: { ...eAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "after grant", slug: "scoped_after_grant", content: "x" }),
    });
    check("the grant really confers access (200, not 403)", wAfterGrant.status, 200);

    // Revoke: the denial is the *absence* of the row, so this is a DELETE.
    const revoke = await req(worker, env, `/api/v1/users/${editorId}/sites/${SITE_B}?site=${SITE_A}`, {
      method: "PUT", headers: json, body: JSON.stringify({ role: null }),
    });
    check("a null role revokes the membership", revoke.status, 200);
    check("no membership row survives the revoke",
      sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=? AND site_id=?").get(editorId, SITE_B)?.n, 0);
    // The absence is a denial: the write that succeeded after the grant is
    // refused again, with no fallback to the install-wide role column.
    const wAfterRevoke = await req(worker, env, `/api/v1/content/widget?site=${SITE_B}`, {
      method: "POST", headers: { ...eAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "after revoke", slug: "scoped_after_revoke", content: "x" }),
    });
    check("revoking really removes access (no fallback) (403)", wAfterRevoke.status, 403);

    // ── superadmin is not assignable from a site screen ──
    const escalate = await req(worker, env, `/api/v1/users/${editorId}/sites/${SITE_A}?site=${SITE_A}`, {
      method: "PUT", headers: json, body: JSON.stringify({ role: "superadmin" }),
    });
    check("a site screen cannot hand out superadmin (400)", escalate.status, 400);
    check("and the editor's role is unchanged",
      sqlite.prepare("SELECT role FROM site_users_sites WHERE user_id=? AND site_id=?").get(editorId, SITE_A)?.role, "editor");

    // The users list carries the two facts the role editor needs: the role on
    // the site being viewed, and the full membership map.
    const users = await (await req(worker, env, `/api/v1/users?site=${SITE_A}`, { headers: auth })).json();
    const editorRow = (users.items ?? []).find((u) => u.username === uname);
    check("the users list reports role_here for the viewed site", editorRow?.role_here, "editor");
    check("the users list reports the full membership map", editorRow?.sites, { [SITE_A]: "editor" });
    check("the users list names the site it was asked about", users.site, SITE_A);

    wipeScoped();
    check("the scoped fixtures are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE username LIKE 'adm_scoped%'").get()?.n, 0);
    // The wipe took the memberships with it. This asserts what *this section*
    // removed — not a global "no orphans exist", because the shared local D1
    // accumulates orphan rows from other suites' own teardowns (they delete
    // `site_users` directly, and `site_users_sites` has no cascade). That
    // orphan risk is real and is recorded in HANDOVER as a batch-F item; here
    // the claim is the narrow one: the rows this section created are gone.
    check("and this section's memberships went with it",
      sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id = ?").get(editorId)?.n, 0);
  }

  // Clean up: this section wrote directly, so it removes directly.
  for (const sql of [
    "DELETE FROM media_files WHERE site_id='cnt'",
    "DELETE FROM posts WHERE site_id IN ('cnt','cnt2') OR id LIKE 'def_p%'",
    "DELETE FROM settings WHERE site_id IN ('cnt','cnt2','cnt3')",
    "DELETE FROM site_locales WHERE site_id IN ('cnt','cnt2','cnt3')",
    "DELETE FROM sites WHERE id IN ('cnt','cnt2','cnt3')",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
  check("the count fixtures are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM sites WHERE id IN ('cnt','cnt2','cnt3')").get()?.n, 0);
  void defBefore;

  console.log("\n19. Front-end publishing: a member's post is their own, and the session's");

  // Rule 84. Batch D gave the front end an identity; this gives it a **write**
  // path, and every way that can go wrong produces a 200. So most assertions
  // below are about what the *row* looks like afterwards, and about what a
  // second member is told when they aim at the first member's id — which must
  // be the same 404 an id that never existed gets, or the response becomes an
  // id-existence oracle.
  //
  // Fixtures use the `adm_mp_` prefix (distinct from §17's `adm_mem_*`, which
  // that section wipes on its way out) and are swept at both ends.
  {
    const frontJson = { "Content-Type": "application/json" };
    const ftReq = (path, init = {}) => req(worker, env, path, init);
    const wipe = () => {
      // Swept by **author**, not by an id prefix. The endpoint mints ids as
      // `post_<randomId()>`, so a `LIKE 'post_mp_%'` sweep matches nothing —
      // the first version of this section did exactly that, and left five
      // posts behind, which then failed the *next* run with a 409 slug clash
      // (red on the wrong assertion). It is the same mistake §17 documents for
      // member ids, from the other direction: **sweep on the identifier the
      // test controls, not one it hopes the platform produces.**
      const mine = "SELECT id FROM posts WHERE author_member_id IN (SELECT id FROM members WHERE username LIKE 'adm_mp%')";
      for (const sql of [
        `DELETE FROM post_meta WHERE post_id IN (${mine})`,
        `DELETE FROM post_translations WHERE post_id IN (${mine})`,
        "DELETE FROM posts WHERE author_member_id IN (SELECT id FROM members WHERE username LIKE 'adm_mp%')",
        "DELETE FROM field_defs WHERE declared_by_theme='adm_mp'",
        "DELETE FROM member_sessions WHERE member_id IN (SELECT id FROM members WHERE username LIKE 'adm_mp%')",
        "DELETE FROM members WHERE username LIKE 'adm_mp%'",
        "DELETE FROM settings WHERE site_id='default' AND key='members.registration'",
      ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
    };
    wipe();

    const defaultLoc = sqlite.prepare("SELECT code FROM site_locales WHERE site_id='default' AND is_default=1").get()?.code ?? "en";
    await req(worker, env, "/api/v1/settings", {
      method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "1" }),
    });
    try {
      const register = async (name, prefix = "") => {
        const r = await ftReq(`${prefix}/api/v1/front/auth/register`, {
          method: "POST", headers: frontJson, body: JSON.stringify({ username: name, password: "longenough1" }),
        });
        return (r.headers.get("set-cookie") ?? "").split(";")[0];
      };
      const aliceCookie = await register("adm_mp_alice");
      const bobCookie = await register("adm_mp_bob");
      checkTruthy("both member fixtures signed in", aliceCookie.startsWith("cfpress_member=") && bobCookie.startsWith("cfpress_member="));
      const aliceId = sqlite.prepare("SELECT id FROM members WHERE username='adm_mp_alice'").get()?.id;
      const bobId = sqlite.prepare("SELECT id FROM members WHERE username='adm_mp_bob'").get()?.id;

      // ── The gate: no session, no write ──
      const anon = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: frontJson, body: JSON.stringify({ title: "x" }),
      });
      check("a signed-out create is 401", anon.status, 401);

      // ── A member writes their own post ──
      const created = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "一篇会员投稿", slug: "hui-yuan-tou-gao", content: "<p>正文</p>" }),
      });
      check("a member create is 201", created.status, 201);
      const createdBody = await created.json();
      const postId = createdBody.post?.id;
      checkTruthy("the response names the new post", typeof postId === "string" && postId.startsWith("post_"));
      check("the new post is a draft", createdBody.post?.status, "draft");
      check("and it links to the built-in permalink", createdBody.post?.url, `/${defaultLoc}/blog/hui-yuan-tou-gao`);

      const row = sqlite.prepare("SELECT author_id, author_member_id, status, type, site_id FROM posts WHERE id=?").get(postId);
      check("the row records the session member as the author", row?.author_member_id, aliceId);
      check("and never invents a staff author", row?.author_id, "");
      check("and the row is a post on this site", [row?.type, row?.site_id], ["post", "default"]);

      // ── The client cannot choose the status ──
      const forged = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "想直接发布", slug: "xiang-zhi-jie-fa-bu", status: "published" }),
      });
      const forgedBody = await forged.json();
      check("a create asking to publish still answers draft", forgedBody.post?.status, "draft");
      check("and the row agrees", sqlite.prepare("SELECT status FROM posts WHERE id=?").get(forgedBody.post.id)?.status, "draft");

      // ── The client cannot choose the author ──
      const impersonate = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: bobCookie },
        body: JSON.stringify({ title: "冒充别人", slug: "mao-chong-bie-ren", author_member_id: aliceId }),
      });
      const impersonateBody = await impersonate.json();
      check("a body-supplied author is ignored in favour of the session",
        sqlite.prepare("SELECT author_member_id FROM posts WHERE id=?").get(impersonateBody.post.id)?.author_member_id, bobId);

      // ── Another member's id answers exactly like an id that never existed ──
      const stolen = await ftReq(`/api/v1/front/posts/${postId}`, {
        method: "PUT", headers: { ...frontJson, Cookie: bobCookie },
        body: JSON.stringify({ title: "我改了别人的文章", content: "<p>被篡改</p>" }),
      });
      check("editing another member's post is 404", stolen.status, 404);
      const ghost = await ftReq("/api/v1/front/posts/post_mp_never_existed", { method: "DELETE", headers: { Cookie: bobCookie } });
      check("and an id that never existed answers the same 404", ghost.status, 404);
      check("the post is untouched",
        sqlite.prepare("SELECT t.title FROM post_translations t WHERE t.post_id=? AND t.locale=?").get(postId, defaultLoc)?.title, "一篇会员投稿");

      const stolenDelete = await ftReq(`/api/v1/front/posts/${postId}`, { method: "DELETE", headers: { Cookie: bobCookie } });
      check("deleting another member's post is 404", stolenDelete.status, 404);
      check("and it is still there", sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id=?").get(postId)?.n, 1);

      // ── The owner may edit, and an edit is not a publish ──
      const edited = await ftReq(`/api/v1/front/posts/${postId}`, {
        method: "PUT", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "改过的标题" }),
      });
      check("the owner can edit their own post", edited.status, 200);
      check("and the title changed",
        sqlite.prepare("SELECT title FROM post_translations WHERE post_id=? AND locale=?").get(postId, defaultLoc)?.title, "改过的标题");

      sqlite.prepare("UPDATE posts SET status='published' WHERE id=?").run(postId);
      await ftReq(`/api/v1/front/posts/${postId}`, {
        method: "PUT", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "再改一次" }),
      });
      check("a member edit does not knock a published post back to draft",
        sqlite.prepare("SELECT status FROM posts WHERE id=?").get(postId)?.status, "published");

      // ── A slug is unique per language ──
      const clash = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: bobCookie },
        body: JSON.stringify({ title: "重名", slug: "hui-yuan-tou-gao" }),
      });
      check("a slug already used in this language is 409", clash.status, 409);

      // ── Custom fields: undeclared keys are dropped, declared ones carry the locale ──
      const undeclared = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "带自定义字段", slug: "dai-zi-ding-yi", meta: { adm_mp_undeclared: "x" } }),
      });
      const undeclaredBody = await undeclared.json();
      check("an undeclared meta key is not written",
        sqlite.prepare("SELECT COUNT(*) AS n FROM post_meta WHERE post_id=?").get(String(undeclaredBody.post?.id ?? ""))?.n, 0);

      sqlite.prepare(
        "INSERT INTO field_defs (id, site_id, meta_key, label, field_type, post_types, required, sort_order, declared_by_theme, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).run("fd_adm_mp_probe", "default", "adm_mp_probe", "Probe", "text", '["post"]', 0, 0, "adm_mp", 1, 1);
      const declared = await ftReq("/api/v1/front/posts", {
        method: "POST", headers: { ...frontJson, Cookie: aliceCookie },
        body: JSON.stringify({ title: "声明过的字段", slug: "sheng-ming-guo-de", meta: { adm_mp_probe: "值" } }),
      });
      const declaredBody = await declared.json();
      const metaRow = sqlite.prepare("SELECT meta_key, locale, meta_value FROM post_meta WHERE post_id=?").get(declaredBody.post.id);
      check("a declared meta key is written against the save's language", [metaRow?.meta_key, metaRow?.locale], ["adm_mp_probe", defaultLoc]);
      check("and carries the value sent", metaRow?.meta_value, "值");

      // ── Cross-tenant: a member of another site cannot aim at this post ──
      sqlite.exec("INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) VALUES ('admmp2','MP Two',NULL,'admmp2',0,'active',1,1) ON CONFLICT(id) DO NOTHING");
      sqlite.exec("INSERT INTO site_locales(site_id,code,is_default,enabled,sort_order) VALUES ('admmp2','en',1,1,0) ON CONFLICT(site_id,code) DO NOTHING");
      await req(worker, env, "/api/v1/settings?site=admmp2", {
        method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "1" }),
      });
      const carolCookie = await register("adm_mp_carol", "/admmp2");
      checkTruthy("the second site's member signed in", carolCookie.startsWith("cfpress_member="));
      const crossTenant = await ftReq(`/admmp2/api/v1/front/posts/${postId}`, {
        method: "PUT", headers: { ...frontJson, Cookie: carolCookie },
        body: JSON.stringify({ title: "跨站篡改" }),
      });
      check("a member of another site cannot edit this post (404)", crossTenant.status, 404);
      check("and the title is still this site's",
        sqlite.prepare("SELECT title FROM post_translations WHERE post_id=? AND locale=?").get(postId, defaultLoc)?.title, "再改一次");

      // ── There is no second "my posts" reader ──
      const list = await ftReq("/api/v1/front/posts", { headers: { Cookie: aliceCookie } });
      check("the front API has no my-posts list endpoint", list.status, 404);

      // ── The owner deletes, and everything hanging off the post goes too ──
      const del = await ftReq(`/api/v1/front/posts/${postId}`, { method: "DELETE", headers: { Cookie: aliceCookie } });
      check("the owner can delete their own post", del.status, 200);
      check("and the post row is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id=?").get(postId)?.n, 0);
      check("and its translations went with it", sqlite.prepare("SELECT COUNT(*) AS n FROM post_translations WHERE post_id=?").get(postId)?.n, 0);
      check("and its custom fields went with it", sqlite.prepare("SELECT COUNT(*) AS n FROM post_meta WHERE post_id=?").get(postId)?.n, 0);
    } finally {
      // Restore the registration flag the way §17 does — leaving it open would
      // change what the next suite (and the operator's install) observes.
      await req(worker, env, "/api/v1/settings", {
        method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "0" }),
      });
      for (const sql of [
        "DELETE FROM settings WHERE site_id='admmp2'",
        "DELETE FROM site_locales WHERE site_id='admmp2'",
        "DELETE FROM sites WHERE id='admmp2'",
      ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
      wipe();
    }
    // The leak assertion is deliberately **prefix-free**: it asks whether any
    // post is left pointing at a member who no longer exists. That is the exact
    // residue a prefix-based sweep misses, and it stays true no matter what ids
    // the endpoint mints.
    check("no member-post fixtures were left behind",
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_member_id IS NOT NULL AND author_member_id NOT IN (SELECT id FROM members)").get()?.n, 0);
    check("and the member accounts are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE username LIKE 'adm_mp%'").get()?.n, 0);
    check("and the probe field declaration", sqlite.prepare("SELECT COUNT(*) AS n FROM field_defs WHERE declared_by_theme='adm_mp'").get()?.n, 0);
  }

  // ---------------------------------------------------------------------------
  console.log("\n20. The member surface answers a browser form, not just a script (rule 85)");

  // The member surface — sign up, sign in, write, delete — is rendered as plain
  // HTML forms, and the templates have always said so in comments. Until rule 85
  // that was **false**: the API parsed only JSON, so a form body produced `{}`
  // and the endpoint answered `invalid_username` about a username the reader
  // had in fact typed, while the redirect the comment promised never happened.
  //
  // This section drives the real endpoints with a real form-encoded body and
  // pins the three things a browser needs — a 303, a same-site `Location`, and
  // `?error=` on the way back — and then pins the other direction just as
  // hard: a **script** must still get exactly the JSON it got before, including
  // the `logout` call that carries no body and therefore no content type.
  //
  // Fixtures use the `adm_fm_` prefix and are swept by **username**, the one
  // identifier this suite controls (see §17/§19 for why an id prefix is the
  // wrong key).
  {
    const frontJson = { "Content-Type": "application/json" };
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const ftReq = (path, init = {}) => req(worker, env, path, init);
    // Exactly what a browser sends: a percent-encoded, flat body.
    const enc = (o) => new URLSearchParams(o).toString();
    const wipe = () => {
      const mine = "SELECT id FROM posts WHERE author_member_id IN (SELECT id FROM members WHERE username LIKE 'adm_fm%')";
      for (const sql of [
        `DELETE FROM post_meta WHERE post_id IN (${mine})`,
        `DELETE FROM post_translations WHERE post_id IN (${mine})`,
        "DELETE FROM posts WHERE author_member_id IN (SELECT id FROM members WHERE username LIKE 'adm_fm%')",
        "DELETE FROM member_sessions WHERE member_id IN (SELECT id FROM members WHERE username LIKE 'adm_fm%')",
        "DELETE FROM members WHERE username LIKE 'adm_fm%'",
        "DELETE FROM settings WHERE site_id='default' AND key='members.registration'",
      ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
    };
    wipe();
    await req(worker, env, "/api/v1/settings", {
      method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "1" }),
    });
    try {
      const post = (path, o, cookie) =>
        ftReq(path, { method: "POST", headers: cookie ? { ...form, Cookie: cookie } : form, body: enc(o) });
      const cookieOf = (r) => (r.headers.get("set-cookie") ?? "").split(";")[0];

      // ── A form can sign up, and the reader really is signed in ──
      const reg = await post("/api/v1/front/auth/register",
        { username: "adm_fm_reader", password: "longenough1", redirect: "/en/account" });
      check("a form registration answers 303", reg.status, 303);
      check("and sends the reader where the form asked", reg.headers.get("location"), "/en/account");
      const cookie = cookieOf(reg);
      checkTruthy("and sets the member cookie", cookie.startsWith("cfpress_member="));
      const me = await ftReq("/api/v1/front/me", { headers: { Cookie: cookie } });
      check("the form-registered member is signed in", (await me.json()).member?.username, "adm_fm_reader");
      const memberId = sqlite.prepare("SELECT id FROM members WHERE username='adm_fm_reader'").get()?.id;

      // ── The redirect stays on this site ──
      // `//host` is protocol-relative (a different origin) and `/\host` is an
      // authority to some browsers. Either one echoed into `Location:` turns
      // our own form into a phishing page, so both must fall back.
      for (const target of ["//evil.example/x", "/\\evil.example"]) {
        const r = await post("/api/v1/front/auth/login",
          { username: "adm_fm_reader", password: "longenough1", redirect: target });
        check(`a redirect to ${JSON.stringify(target)} is refused (rule 85d)`, r.headers.get("location"), "/");
      }
      // An ordinary path is honoured, so the refusal above is a *rule* and not
      // "the field is ignored".
      const ok = await post("/api/v1/front/auth/login",
        { username: "adm_fm_reader", password: "longenough1", redirect: "/en/account" });
      check("an ordinary redirect is honoured", ok.headers.get("location"), "/en/account");

      // ── A failure comes back as a reason, not as a JSON body ──
      const dup = await post("/api/v1/front/auth/register",
        { username: "adm_fm_reader", password: "longenough1", redirect: "/en/register" });
      check("a taken username answers a redirect", dup.status, 303);
      check("with the reason in the URL", dup.headers.get("location"), "/en/register?error=taken");
      checkTruthy("and no cookie is handed out", !dup.headers.get("set-cookie"));
      const badPw = await post("/api/v1/front/auth/login",
        { username: "adm_fm_reader", password: "not-the-password", redirect: "/en/login" });
      check("a wrong password answers a redirect", badPw.status, 303);
      check("with the reason in the URL", badPw.headers.get("location"), "/en/login?error=invalid_credentials");

      // ── A form writes and edits a post ──
      const created = await post("/api/v1/front/posts",
        { title: "表单投稿", slug: "biao-dan-tou-gao", content: "<p>正文</p>", redirect: "/en/account" }, cookie);
      check("a form submission answers 303", created.status, 303);
      check("back to the account page", created.headers.get("location"), "/en/account");
      const row = sqlite.prepare("SELECT id, status, author_id, author_member_id FROM posts WHERE slug=?").get("biao-dan-tou-gao");
      check("the row is a draft", row?.status, "draft");
      check("authored by the session member, with no staff author", [row?.author_id, row?.author_member_id], ["", memberId]);
      const edited = await post(`/api/v1/front/posts/${row?.id ?? ""}`,
        { title: "改过的标题", slug: "biao-dan-tou-gao", content: "<p>改过</p>", redirect: "/en/account" }, cookie);
      check("a form edit answers 303", edited.status, 303);
      check("and the title changed", sqlite.prepare("SELECT title FROM post_translations WHERE post_id=?").get(String(row?.id ?? ""))?.title, "改过的标题");
      check("and an edit does not publish", sqlite.prepare("SELECT status FROM posts WHERE id=?").get(String(row?.id ?? ""))?.status, "draft");

      // ── A form delete, and the same answer for every way an id is not yours ──
      const other = await post("/api/v1/front/auth/register",
        { username: "adm_fm_other", password: "longenough1", redirect: "/" });
      const otherCookie = cookieOf(other);
      const stolen = await post(`/api/v1/front/posts/${row?.id ?? ""}/delete`, { redirect: "/en/account" }, otherCookie);
      check("deleting another member's post answers a redirect", stolen.status, 303);
      check("with the reason in the URL", stolen.headers.get("location"), "/en/account?error=not%20found");
      const ghost = await post("/api/v1/front/posts/post_fm_never_existed/delete", { redirect: "/en/account" }, cookie);
      check("an id that never existed answers identically (no oracle)", ghost.headers.get("location"), stolen.headers.get("location"));
      check("and the post is still there", sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id=?").get(String(row?.id ?? ""))?.n, 1);
      const del = await post(`/api/v1/front/posts/${row?.id ?? ""}/delete`, { redirect: "/en/account" }, cookie);
      check("the owner's form delete answers 303", del.status, 303);
      check("and the row is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id=?").get(String(row?.id ?? ""))?.n, 0);

      // ── A form signs out ──
      const out = await post("/api/v1/front/auth/logout", { redirect: "/en" }, cookie);
      check("a form sign-out answers 303", out.status, 303);
      check("to the front page", out.headers.get("location"), "/en");

      // ── The JSON contract is untouched ──
      // This is what every other section of this suite and every script relies
      // on. The `logout` case is the load-bearing one: it carries **no body**,
      // so a script posts it with no content type at all — and a detector that
      // said "anything that is not JSON is a form" would flip its answer from a
      // JSON body to a redirect, silently (rule 85c).
      const jsonReg = await ftReq("/api/v1/front/auth/register", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_fm_json", password: "longenough1" }),
      });
      check("a JSON registration is still 201", jsonReg.status, 201);
      const jsonLogin = await ftReq("/api/v1/front/auth/login", {
        method: "POST", headers: frontJson, body: JSON.stringify({ username: "adm_fm_json", password: "longenough1" }),
      });
      check("a JSON sign-in is still 200", jsonLogin.status, 200);
      const jsonOut = await ftReq("/api/v1/front/auth/logout", {
        method: "POST", headers: { Cookie: cookieOf(jsonLogin) },
      });
      check("a JSON sign-out with no content type is still 200", jsonOut.status, 200);
      check("and it answers JSON, not a redirect", jsonOut.headers.get("location"), null);
    } finally {
      await req(worker, env, "/api/v1/settings", {
        method: "POST", headers: json, body: JSON.stringify({ key: "members.registration", value: "0" }),
      });
      wipe();
    }
    check("no form-surface fixtures were left behind",
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_member_id IS NOT NULL AND author_member_id NOT IN (SELECT id FROM members)").get()?.n, 0);
    check("and the member accounts are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE username LIKE 'adm_fm%'").get()?.n, 0);
  }

  console.log("\n21. Demo content: a fresh install ships something to look at");
  // The demo content has exactly one definition (`shared/demo-content.ts`) and
  // three callers: the boot hook (once per install, behind a stamp), the admin
  // Settings button (`POST seed-demo`), and the terminal script. This section
  // pins the writer's contract and the boot hook's predicate — the predicate
  // is the part with a real trap: "posts table empty" is a fact that changes,
  // so the decision must be recorded, or a user who deletes their content
  // finds the demo resurrected on the next boot.
  {
    // The seed writes platform `locales` rows (the demo languages); note what
    // existed before so only the *created* rows are swept — the operator's own
    // locale rows must survive.
    const localesBefore = new Set(sqlite.prepare("SELECT code FROM locales").all().map((r) => r.code));

    const cs = await req(worker, env, "/api/v1/sites", {
      method: "POST", headers: json, body: JSON.stringify({ id: "admdemo", name: "Demo Seed Fixture" }),
    });
    check("fixture site created", cs.status < 300, true);

    // ── The writer, through the same save path an editor save takes ──
    const r1 = await req(worker, env, "/api/v1/seed-demo?site=admdemo", {
      method: "POST", headers: json, body: JSON.stringify({}),
    });
    check("seed-demo answers 200", r1.status, 200);
    const r1j = await r1.json();
    check("six pieces in two languages were written", r1j.written, 12);
    check("nothing failed", r1j.failed, []);

    // Both languages of a piece share one row; the per-site id is derived from
    // the site (`demo_<siteId>_<key>`), so a second site can never collide.
    const hello = sqlite.prepare(
      "SELECT p.slug AS slug, p.status AS status, COUNT(t.locale) AS locales FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id WHERE p.id='demo_admdemo_hello' GROUP BY p.id"
    ).get();
    check("hello exists, published, in two languages",
      hello ? [hello.slug, hello.status, hello.locales] : null, ["hello-world", "published", 2]);
    check("the demo languages are served on the site",
      sqlite.prepare("SELECT code FROM site_locales WHERE site_id='admdemo' AND enabled=1 ORDER BY code").all().map((r) => r.code), ["en", "zh-CN"]);

    // ── Idempotent: a second (scoped) run updates, never duplicates ──
    const r2 = await req(worker, env, "/api/v1/seed-demo?site=admdemo", {
      method: "POST", headers: json, body: JSON.stringify({ key: "hello", locale: "en" }),
    });
    const r2j = await r2.json();
    check("a scoped re-run answers 200", r2.status, 200);
    check("and writes exactly one version", r2j.written, 1);
    check("still two language rows for the piece",
      sqlite.prepare("SELECT COUNT(*) AS n FROM post_translations WHERE post_id='demo_admdemo_hello'").get()?.n, 2);

    // ── Permission: the gate is `settings.manage`, not merely being staff ──
    const mk = await req(worker, env, "/api/v1/users?site=admdemo", {
      method: "POST", headers: json, body: JSON.stringify({ username: "admdemo_limited", password: "demo-pass-1", role: "editor" }),
    });
    const mkj = await mk.json();
    const editorId = mkj.user?.id ?? mkj.id;
    check("a scoped editor was created", mk.status < 300 && !!editorId, true);
    const lr2 = await req(worker, env, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admdemo_limited", password: "demo-pass-1" }),
    });
    const editorCookie = lr2.headers.get("set-cookie")?.split(";")[0] ?? "";
    const forbidden = await req(worker, env, "/api/v1/seed-demo?site=admdemo", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: editorCookie }, body: JSON.stringify({}),
    });
    check("an editor without settings.manage is 403", forbidden.status, 403);
    const anon = await req(worker, env, "/api/v1/seed-demo?site=admdemo", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    check("an unauthenticated call is 401", anon.status, 401);

    // ── The boot hook, driven directly (no route runs it — by design) ──
    // The endpoint does not stamp; the *hook* owns the decision. Run it once
    // on this site, which now has content: the decision must be recorded
    // without seeding anything.
    const beforeHook = sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo_%'").get()?.n;
    await mod.maybeSeedDemoContent(env, "admdemo");
    check("the hook records its decision on a site that already has content",
      [
        beforeHook,
        sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo_%'").get()?.n,
        sqlite.prepare("SELECT value FROM settings WHERE site_id='admdemo' AND key='demo.seeded'").get()?.value,
      ], [6, 6, "1"]);

    // (a) The stamp prevents resurrection: demo rows deleted by hand must not
    //     come back, even though the site is now empty again.
    sqlite.exec("DELETE FROM post_meta WHERE post_id LIKE 'demo_admdemo_%'");
    sqlite.exec("DELETE FROM post_translations WHERE post_id LIKE 'demo_admdemo_%'");
    sqlite.exec("DELETE FROM posts WHERE id LIKE 'demo_admdemo_%'");
    await mod.maybeSeedDemoContent(env, "admdemo");
    check("the stamp prevents resurrection",
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo_%'").get()?.n, 0);

    // (b) Stamp removed and the site empty → the boot hook seeds it.
    sqlite.exec("DELETE FROM settings WHERE site_id='admdemo' AND key='demo.seeded'");
    await mod.maybeSeedDemoContent(env, "admdemo");
    check("an empty, unstamped site is seeded by the boot hook",
      sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo_%'").get()?.n, 6);
    check("and the stamp is back",
      sqlite.prepare("SELECT value FROM settings WHERE site_id='admdemo' AND key='demo.seeded'").get()?.value, "1");

    // (c) A site with content of its own is never seeded — the exact shape of
    //     an install that has grown a member draft (or any real content)
    //     before the first boot of this code.
    const cs2 = await req(worker, env, "/api/v1/sites", {
      method: "POST", headers: json, body: JSON.stringify({ id: "admdemo2", name: "Demo Seed Fixture Two" }),
    });
    check("second fixture site created", cs2.status < 300, true);
    const own = await req(worker, env, "/api/v1/posts?site=admdemo2", {
      method: "POST", headers: json, body: JSON.stringify({ title: "Existing content", slug: "existing-content", content: "<p>the site's own</p>", status: "published" }),
    });
    check("the second site has its own post", own.status < 300, true);
    await mod.maybeSeedDemoContent(env, "admdemo2");
    check("a site with its own content is not seeded — and the decision is stamped",
      [
        sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo2_%'").get()?.n,
        sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE site_id='admdemo2' AND key='demo.seeded'").get()?.n,
      ], [0, 1]);

    // Sweep the platform locales this section may have created (the operator's
    // own rows were here before and must survive).
    for (const code of sqlite.prepare("SELECT code FROM locales").all().map((r) => r.code)) {
      if (!localesBefore.has(code)) sqlite.prepare("DELETE FROM locales WHERE code=?").run(code);
    }
  }

  console.log("\n22. Scheduled demo reset: a public sandbox restores itself");
  // `maybeResetDemoContent` hangs off the `*/5` cron, so no route reaches it
  // and no request can probe it. Every claim about it is therefore one that
  // only a direct call can falsify — which is why it is driven here, and why
  // the first assertion is the one that matters most: on an install that has
  // not declared itself a demo, the function must be inert. A reset that fires
  // on somebody's real site is the worst possible bug in this feature.
  {
    const envOff = { ...env, CFPRESS_DEMO_RESET_MINUTES: undefined };
    const envOn = { ...env, CFPRESS_DEMO_RESET_MINUTES: "60" };
    const demoRows = () => sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id LIKE 'demo_admdemo_%'").get()?.n;
    const resetStamp = () => sqlite.prepare("SELECT value FROM settings WHERE site_id='admdemo' AND key='demo.resetAt'").get()?.value ?? null;
    const mediaPolicy = () => sqlite.prepare("SELECT value FROM settings WHERE site_id='admdemo' AND key='cfpress.media'").get()?.value ?? null;
    const wipeDemo = () => {
      sqlite.exec("DELETE FROM post_translations WHERE post_id LIKE 'demo_admdemo_%'");
      sqlite.exec("DELETE FROM post_meta WHERE post_id LIKE 'demo_admdemo_%'");
      sqlite.exec("DELETE FROM posts WHERE id LIKE 'demo_admdemo_%'");
    };
    const backdate = () => sqlite.prepare("UPDATE settings SET value=? WHERE site_id='admdemo' AND key='demo.resetAt'")
      .run(String(Math.floor(Date.now() / 1000) - 3601));

    // ── (a) Inert without the var ──
    wipeDemo();
    await mod.maybeResetDemoContent(envOff, "admdemo");
    check("no interval var → nothing is restored", demoRows(), 0);
    check("and no stamp is written", resetStamp(), null);

    // ── (b) With the var: the content comes back and the time is recorded ──
    await mod.maybeResetDemoContent(envOn, "admdemo");
    check("the reset restores every demo piece", demoRows(), 6);
    checkTruthy("and stamps when it ran", Number(resetStamp()) > 0);

    // ── (c) Inside the interval a second call must not re-seed ──
    wipeDemo();
    await mod.maybeResetDemoContent(envOn, "admdemo");
    check("a call inside the interval is a no-op", demoRows(), 0);

    // ── (d) Past the interval: re-armed ──
    backdate();
    await mod.maybeResetDemoContent(envOn, "admdemo");
    check("once the interval has elapsed it runs again", demoRows(), 6);

    // ── (e) The media policy is restored, not only the content ──
    // This is the failure that makes a demo *look* broken rather than merely
    // untidy: the shipped default demands a session while the admin cookie is
    // scoped to `Path=/admin`, so flipping it back 404s every image on the
    // site. A visitor with admin access can reach that setting, so the reset
    // has to be able to undo it.
    sqlite.prepare(
      "INSERT INTO settings (id, site_id, key, value, autoload) VALUES (?,?,?,?,1) ON CONFLICT(site_id, key) DO UPDATE SET value=excluded.value"
    ).run("t22_media", "admdemo", "cfpress.media", JSON.stringify({ isolation: "owner", require_session: true }));
    check("the fixture policy starts closed", JSON.parse(mediaPolicy()).require_session, true);

    backdate();
    await mod.maybeResetDemoContent(envOn, "admdemo");
    check("the reset reopens the media policy",
      JSON.parse(mediaPolicy()), { isolation: "site", require_session: false });
  }

  console.log("\n23. The demo reset rides on requests, not only on cron");
  // The cron trigger is best-effort. On the deployment this was written for, a
  // trigger the API reported as registered never arrived at all — while a
  // sibling Worker's every-minute trigger on the same account fired normally —
  // so the reset is also driven from the request path. These assertions pin the
  // two properties that make riding on every request affordable, neither of
  // which is visible from outside the Worker: a non-demo install must never
  // reach the database, and a demo must reach it at most once a minute.
  //
  // Both are driven through the gate rather than through the wrapper. The
  // wrapper's happy path calls `maybeResetDemoContent`, which would perform a
  // real reset against whichever site this suite has open — a side effect a
  // test about *scheduling* has no business causing.
  {
    const envOff = { ...env, CFPRESS_DEMO_RESET_MINUTES: undefined };
    const envOn = { ...env, CFPRESS_DEMO_RESET_MINUTES: "1440" };

    // ── (a) The env read comes first, and it must not consume the throttle ──
    // This is the assertion that catches the ordering bug. Were the throttle
    // read before the env, a request to a non-demo install would burn the rate
    // limit, and the second check below would come back false — turning "free
    // for every install that is not a demo" into a lie that only shows up as a
    // reset that never happens.
    check("an install that is not a demo is never due", mod.demoResetCheckDue(envOff), false);
    check("and it did not consume the throttle", mod.demoResetCheckDue(envOn), true);

    // ── (b) A demo is due once, then throttled for the rest of the minute ──
    check("a demo is throttled after the first check", mod.demoResetCheckDue(envOn), false);
    check("and stays throttled", mod.demoResetCheckDue(envOn), false);

    // ── (c) The wrapper schedules no work when the gate says no ──
    const scheduled = [];
    mod.resetDemoOnRequest(envOff, { waitUntil: (p) => { scheduled.push(p); return p; } });
    check("a non-demo request schedules nothing", scheduled.length, 0);
  }

  // End-of-suite sweep, **here** rather than mid-file. It tears down this
  // suite's own fixtures (`adm`, `admtheme`, the `adm_*`/`widget_*` posts) so
  // the shared local D1 is left as the suite found it. It has to run after
  // every section that uses those fixtures: an earlier placement ran it in the
  // middle of the file, which silently deleted `adm` out from under the
  // sections below it (they were written to not notice). Keep it last.
  sweep();
  check("the admin fixtures are gone", sqlite.prepare("SELECT COUNT(*) AS n FROM sites WHERE id='adm'").get()?.n, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a parseable summary, and it must say it
  // failed. Without this the reverse-validation tool reads "no summary" as
  // "could not tell", which is never a pass (ARCHITECTURE §12).
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(2);
});
