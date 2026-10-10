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
  const worker = (await compileWorker()).default;
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

  // Leave the shared local D1 as we found it (see `sweep` above).
  sweep();

  // Leave the shared local D1 as we found it (see `sweep` above).
  sweep();

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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  process.exit(2);
});
