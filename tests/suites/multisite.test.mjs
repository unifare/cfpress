/**
 * Multi-site integration test (batch 4).
 *
 * Proves that one CFPress install can host several sites from one Worker +
 * one database, and that *nothing* leaks between them:
 *
 *   host routing            -> shop.example.com resolves to site `shop`
 *   path-prefix routing     -> /de/... with prefix `/de` resolves to site `de`
 *   default fallthrough     -> an unknown host lands on the default site
 *   content isolation       -> a post on `shop` is invisible on `default`
 *   settings isolation      -> site.title differs per site
 *   theme isolation         -> each site has its own active theme + CPTs
 *   menu isolation          -> per-site navigation
 *   cache isolation         -> bumping `shop` does not invalidate `default`
 *   site CRUD               -> create / update / delete, default is protected
 *
 * Usage: node tests/suites/multisite.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { assetsStub } from "../fixtures/_assets-stub.mjs";
import { snapshotCapabilities, restoreCapabilities } from "../fixtures/_capability-snapshot.mjs";

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

// ---------------------------------------------------------------------------
// Harness (mirrors theme-integration.test.mjs)
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "multisite-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

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
    async put(key, value) {
      let body = value;
      if (value && typeof value.arrayBuffer === "function") body = new Uint8Array(await value.arrayBuffer());
      else if (value && typeof value.getReader === "function") {
        const chunks = []; const reader = value.getReader();
        for (;;) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total); let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        body = merged;
      }
      store.set(key, { body });
      return { key };
    },
    async delete(key) { store.delete(key); },
    _dump: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  // Every KV *write* is recorded. The content-cache version used to be
  // mirrored into KV on every bump, and re-written once a day per site on
  // every miss (the mirror carried a 24h TTL). D1 is the source of truth and
  // nothing reads the mirror, so section 9 asserts `_kvWrites` stays empty.
  //
  // Recording writes rather than objects is deliberate: a stale write with the
  // same value would leave `_dump().length` unchanged and the check would pass
  // vacuously. Writes are counted, not inferred.
  const kvWrites = [];
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    // Uploading a theme/plugin writes to R2, and storing is behind a
    // **default-off** switch (`media_store_r2`). This suite exercises the
    // upload, so its deploy has the switch on; the switch itself, both ways,
    // is media.test.mjs §12.
    CFPRESS_MEDIA_STORE_R2: "true",
    CACHE: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kvWrites.push(k); kv.set(k, v); },
      async delete(k) { kvWrites.push(k); kv.delete(k); },
    },
    ASSETS: assetsStub(),
    _kv: kv,
    _kvWrites: kvWrites,
  };
}

/** Fire a request against a specific host (drives site resolution). */
async function req(worker, env, path, init = {}, host = "localhost") {
  const request = new Request(`http://${host}${path}`, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

/** A theme that declares one CPT so we can prove theme isolation per site. */
function buildThemeZip(name, cpt) {
  const manifest = {
    name, title: `${name} theme`, version: "1.0.0",
    templates: ["index", "archive-" + cpt, "single-" + cpt],
    postTypes: [{
      name: cpt, label: cpt, labels: { singular: cpt, plural: cpt + "s" },
      supports: ["title", "editor"], hasArchive: true, rewrite: { slug: cpt + "s" },
    }],
    fields: [{ key: "tagline", label: "Tagline", type: "text", postTypes: [cpt] }],
    runtime: "declarative",
  };
  const index = `<!doctype html><html><head><title>{{site.title}}</title></head><body>`
    + `<h1 class="site-title">{{site.title}}</h1><p class="theme">THEME-${name.toUpperCase()}</p>`
    // Renders the site's navigation, so the suite can assert that one tenant's
    // menu items never show up in another tenant's page.
    + `<nav class="nav">{{menu.primary_html}}</nav>`
    + `<ul>{{#each posts as p}}<li><a href="{{p.url}}">{{p.title}}</a></li>{{/each}}</ul></body></html>`;
  const archive = `<!doctype html><html><body><h1>ARCHIVE-${cpt.toUpperCase()}</h1>`
    + `{{#each posts as p}}<article data-slug="{{p.slug}}">{{p.title}}</article>{{/each}}</body></html>`;
  const single = `<!doctype html><html><body><h1>SINGLE-${cpt.toUpperCase()}</h1>`
    + `<span class="slug">{{post.slug}}</span><span class="title">{{post.title}}</span></body></html>`;
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(index),
    [`templates/archive-${cpt}.html`]: strToU8(archive),
    [`templates/single-${cpt}.html`]: strToU8(single),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) {
    console.error("Local D1 not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) {
    console.error("Local D1 sqlite file not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  const sqlitePath = join(d1Dir, files[0]);
  console.log(`Using local D1: ${sqlitePath}\n`);

  const sqlite = new DatabaseSync(sqlitePath);
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // Idempotent teardown of this suite's fixtures, run at BOTH ends: up front so
  // a crashed previous run cannot change what this one observes, and again at
  // the end so the shared local D1 — the file `wrangler dev` serves — keeps no
  // phantom rows on the Sites/Themes screens. Sweeping only up front is what
  // left `shoptheme`/`detheme` and the `shop`/`de` sites behind.
  //
  // Activating `detheme` on the *default* site rewrites the site-wide
  // `theme.active`, `theme_routes` and `admin_menu_registry` rows
  // clear-then-insert, so snapshot them and put them back — otherwise the
  // operator's own front-end routes and admin menu vanish after a test run.
  const prevActive = sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='theme.active'").get()?.value ?? null;
  const sweep = () => {
    for (const sql of [
      "DELETE FROM post_meta WHERE post_id LIKE 'ms_%'",
      "DELETE FROM post_revisions WHERE post_id LIKE 'ms_%'",
      "DELETE FROM post_translations WHERE post_id LIKE 'ms_%'",
      "DELETE FROM posts WHERE id LIKE 'ms_%'",
      "DELETE FROM post_types WHERE declared_by_theme IN ('shoptheme','detheme','realestate')",
      "DELETE FROM taxonomies WHERE declared_by_theme IN ('shoptheme','detheme','realestate')",
      "DELETE FROM field_defs WHERE declared_by_theme IN ('shoptheme','detheme','realestate')",
      "DELETE FROM theme_routes WHERE declared_by_theme IN ('shoptheme','detheme','realestate')",
      "DELETE FROM theme_blocks WHERE declared_by_theme IN ('shoptheme','detheme','realestate')",
      "DELETE FROM admin_menu_registry WHERE owner_name IN ('shoptheme','detheme')",
      "DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name IN ('shoptheme','detheme')",
      "DELETE FROM theme_settings WHERE theme_name IN ('shoptheme','detheme')",
      "DELETE FROM theme_setting_defs WHERE theme_name IN ('shoptheme','detheme')",
      "DELETE FROM theme_installs WHERE name IN ('shoptheme','detheme')",
      "DELETE FROM extension_capabilities WHERE extension_name IN ('shoptheme','detheme')",
      "DELETE FROM extension_versions WHERE extension_name IN ('shoptheme','detheme')",
      "DELETE FROM menus WHERE site_id IN ('shop','de')",
      "DELETE FROM menu_items WHERE site_id IN ('shop','de')",
      "DELETE FROM widget_instances WHERE site_id IN ('shop','de')",
      "DELETE FROM site_locales WHERE site_id IN ('shop','de')",
      "DELETE FROM settings WHERE site_id IN ('shop','de')",
      "DELETE FROM content_cache_versions WHERE id IN ('content_version_shop','content_version_de')",
      // The throwaway site's registry rows too, so an aborted run cannot leave
      // them for the next one (the delete purges them, but it may not have run).
      "DELETE FROM admin_menu_registry WHERE site_id='tmp'",
      "DELETE FROM theme_table_defs WHERE site_id='tmp'",
      "DELETE FROM sites WHERE id IN ('shop','de','tmp')",
    ]) {
      try { sqlite.exec(sql); } catch { /* table may not exist yet */ }
    }
    try {
      if (prevActive !== null) {
        sqlite.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES('setting-theme-active','default','theme.active',?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value").run(prevActive);
      } else {
        sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='theme.active'");
      }
    } catch { /* table may not exist yet */ }
  };
  sweep();
  // Capture the default site's capability rows (field_defs / post_types /
  // theme_routes / theme_blocks / admin_menu_registry) and the derived
  // `theme_installs.active` column *after* the sweep, so the teardown restores
  // the operator's real theme rather than this suite's fixtures. Activating
  // `detheme` on `default` clear-then-inserts all of them.
  const caps = snapshotCapabilities(sqlite);

  // -- 0. auth -------------------------------------------------------------
  console.log("0. Admin bootstrap & auth");
  await req(worker, env, "/api/v1/health");
  await req(worker, env, "/api/v1/auth/me");
  const loginRes = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  checkTruthy("session cookie issued", cookie.startsWith("cfpress_admin="));
  const auth = { Cookie: cookie };

  // -- 1. sites registry ---------------------------------------------------
  console.log("\n1. Sites registry (create / list / update)");
  const list0 = await (await req(worker, env, "/api/v1/sites", { headers: auth })).json();
  checkTruthy("default site present", list0.items.some((s) => s.id === "default" && s.is_default === 1));

  const c1 = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "shop", name: "Shop", host: "shop.example.com" }),
  });
  check("site create status", c1.status, 201);

  const c2 = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "de", name: "Deutsch", path_prefix: "/de", host: "de.example.com" }),
  });
  check("site create with prefix", c2.status, 201);

  const dup = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "shop", name: "Dup" }),
  });
  check("duplicate site id rejected", dup.status, 400);

  const badId = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "Bad Id!", name: "Bad" }),
  });
  check("invalid site id rejected", badId.status, 400);

  const list1 = await (await req(worker, env, "/api/v1/sites", { headers: auth })).json();
  // Other suites may leave their own sites behind in the shared local DB, so
  // assert on the sites this suite created rather than a global count.
  checkTruthy("all three sites registered", ["default", "shop", "de"].every((id) => list1.items.some((s) => s.id === id)));
  check("host normalised", list1.items.find((s) => s.id === "shop").host, "shop.example.com");
  check("prefix normalised", list1.items.find((s) => s.id === "de").path_prefix, "/de");

  // -- 1b. install + activate a theme on every site ------------------------
  // Rendering assertions further down need real templates in R2, and R2 is
  // in-memory for this run, so themes must be uploaded here.
  console.log("\n1b. Per-site theme install & activation");
  for (const [themeName, cpt] of [["shoptheme", "product"], ["detheme", "article"]]) {
    const zip = buildThemeZip(themeName, cpt);
    const fd = new FormData();
    fd.append("file", new File([zip], `${themeName}.zip`, { type: "application/zip" }));
    const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    check(`${themeName} uploaded`, up.status, 201);
  }

  // Give the default site a theme too: `detheme` is reused as a generic
  // "default" theme, but it must not carry its `article` CPT onto default.
  const actDefault = await (await req(worker, env, "/api/v1/extensions/themes/detheme/activate", { method: "POST", headers: auth })).json();
  check("default theme activated on default", actDefault.ok, true);
  check("default activation scoped to default", actDefault.site, "default");

  const actShop = await (await req(worker, env, "/api/v1/extensions/themes/shoptheme/activate?site=shop", { method: "POST", headers: auth })).json();
  check("shop theme activated on shop", actShop.ok, true);
  check("shop applied its CPT", actShop.applied.postTypes, 1);
  check("activation echoes site", actShop.site, "shop");

  const actDe = await (await req(worker, env, "/api/v1/extensions/themes/detheme/activate?site=de", { method: "POST", headers: auth })).json();
  check("de theme activated on de", actDe.ok, true);

  // -- 2. host routing -----------------------------------------------------
  console.log("\n2. Host-based routing");
  const shopHome = await req(worker, env, "/en", {}, "shop.example.com");
  check("shop host resolves to site shop", shopHome.headers.get("X-CFPress-Site"), "shop");

  const wwwShop = await req(worker, env, "/en", {}, "www.shop.example.com");
  check("www. prefix and case are normalised", wwwShop.headers.get("X-CFPress-Site"), "shop");

  // The port value is arbitrary -- this asserts it gets stripped before host
  // matching. Kept in step with the launcher's default so a grep for the real
  // dev port does not turn up a fixture that looks like a config value.
  const withPort = await req(worker, env, "/en", {}, "shop.example.com:47913");
  check("port is stripped for host matching", withPort.headers.get("X-CFPress-Site"), "shop");

  // Two sites bound to two different hosts, on one fixture: this is the shape
  // the local test domains use (`cfpress.test` / `shop.cfpress.test` /
  // `de.cfpress.test`), and it is what "multi-site isolation" means at the
  // routing layer — the same URL path answers as a different site depending on
  // the host alone.
  const deHost = await req(worker, env, "/", {}, "de.example.com");
  check("a second host resolves to its own site", deHost.headers.get("X-CFPress-Site"), "de");
  // And the precedence is pinned, because it is the one thing a reader of
  // `resolveSite()` gets wrong: a path prefix is the more specific answer, so
  // it wins over a host that names another site.
  const prefixOverHost = await req(worker, env, "/de/", {}, "shop.example.com");
  check("a path prefix beats a host that names another site",
    prefixOverHost.headers.get("X-CFPress-Site"), "de");
  const unknownHost = await req(worker, env, "/", {}, "nobody.example.com");
  check("an unknown host falls back to the default site",
    unknownHost.headers.get("X-CFPress-Site"), "default");

  const unknown = await req(worker, env, "/en", {}, "nope.example.com");
  check("unknown host falls back to default", unknown.headers.get("X-CFPress-Site"), "default");

  // -- 3. path-prefix routing ---------------------------------------------
  console.log("\n3. Path-prefix routing");
  const deHome = await req(worker, env, "/de/en", {}, "any.example.com");
  check("prefix /de resolves to site de", deHome.headers.get("X-CFPress-Site"), "de");

  const enHome = await req(worker, env, "/en", {}, "any.example.com");
  check("path without prefix stays default", enHome.headers.get("X-CFPress-Site"), "default");

  // -- 4. content isolation -----------------------------------------------
  console.log("\n4. Content isolation between sites");
  const nowSecs = Math.floor(Date.now() / 1000);
  const mkPost = (id, siteId, slug, title) => {
    env.DB.prepare("INSERT INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, siteId, "user_admin", "post", slug, "published", nowSecs, nowSecs).run();
    env.DB.prepare("INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind("tr_" + id, id, "en", title, "", "", nowSecs, nowSecs).run();
  };
  mkPost("ms_default", "default", "default-post", "Default Site Post");
  mkPost("ms_shop", "shop", "shop-post", "Shop Site Post");

  const defHome = await (await req(worker, env, "/en", {}, "localhost")).text();
  checkTruthy("default site shows its own post", defHome.includes("Default Site Post"));
  checkTruthy("default site hides shop's post", !defHome.includes("Shop Site Post"));

  const shpHome = await (await req(worker, env, "/en", {}, "shop.example.com")).text();
  checkTruthy("shop site shows its own post", shpHome.includes("Shop Site Post"));
  checkTruthy("shop site hides default's post", !shpHome.includes("Default Site Post"));

  // Admin API is site-scoped too. The database also contains legacy fixtures
  // from other suites, so assert on membership rather than an exact list.
  const defPosts = await (await req(worker, env, "/api/v1/posts", { headers: auth })).json();
  checkTruthy("admin posts default-site scoped",
    defPosts.items.some((p) => p.slug === "default-post") &&
    !defPosts.items.some((p) => p.slug === "shop-post"));
  check("admin response echoes site", defPosts.site, "default");
  const shopPosts = await (await req(worker, env, "/api/v1/posts?site=shop", { headers: auth })).json();
  check("admin posts shop-scoped", shopPosts.items.map((p) => p.slug), ["shop-post"]);

  // -- 5. settings isolation ----------------------------------------------
  console.log("\n5. Per-site settings");
  // ⚠️ The default site is real — this suite runs against the shared local D1 —
  // so the operator's title is saved before the test writes over it and put
  // back at the end of the section. 9b does the same; leaving either
  // unrestored is how a test value ended up on the operator's front page.
  const titleBefore = (await (await req(worker, env, "/api/v1/settings", { headers: auth })).json())
    .items?.find((x) => x.key === "site.title")?.value ?? "";
  await req(worker, env, "/api/v1/settings", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "site.title", value: "My Shop" }),
  });
  await req(worker, env, "/api/v1/settings?site=shop", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "site.title", value: "Shop Title" }),
  });

  const defTitle = await req(worker, env, "/en", {}, "localhost");
  const defHtml = await defTitle.text();
  checkTruthy("default site title not overwritten", defHtml.includes("My Shop"));
  const shopTitle = await req(worker, env, "/en", {}, "shop.example.com");
  const shopHtml = await shopTitle.text();
  checkTruthy("shop site title is its own", shopHtml.includes("Shop Title"));
  checkTruthy("shop site does not show default title", !shopHtml.includes("My Shop"));

  const sDef = await (await req(worker, env, "/api/v1/settings", { headers: auth })).json();
  const sShop = await (await req(worker, env, "/api/v1/settings?site=shop", { headers: auth })).json();
  check("settings scoped to default", sDef.items.find((x) => x.key === "site.title").value, "My Shop");
  check("settings scoped to shop", sShop.items.find((x) => x.key === "site.title").value, "Shop Title");

  if (titleBefore) {
    await req(worker, env, "/api/v1/settings", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "site.title", value: titleBefore }),
    });
  }

  // -- 6. theme isolation --------------------------------------------------
  console.log("\n6. Per-site theme + CPT isolation");
  const ptShop = await (await req(worker, env, "/api/v1/theme/post-types?site=shop", { headers: auth })).json();
  const ptDe = await (await req(worker, env, "/api/v1/theme/post-types?site=de", { headers: auth })).json();
  const ptDefault = await (await req(worker, env, "/api/v1/theme/post-types", { headers: auth })).json();
  check("shop has product CPT only", ptShop.items.map((x) => x.name), ["product"]);
  check("de has article CPT only", ptDe.items.map((x) => x.name), ["article"]);
  // `default` runs the same theme package as `de`, so it declares `article`
  // too — that is correct. What must never happen is shop's `product`
  // leaking into another site.
  checkTruthy("shop's CPT never leaks into default",
    !ptDefault.items.some((x) => x.name === "product"));
  checkTruthy("shop's CPT never leaks into de",
    !ptDe.items.some((x) => x.name === "product"));

  const shopPage = await (await req(worker, env, "/en", {}, "shop.example.com")).text();
  checkTruthy("shop renders its own theme", shopPage.includes("THEME-SHOPTHEME"));
  checkTruthy("shop does not render de's theme", !shopPage.includes("THEME-DETHEME"));

  const dePage = await (await req(worker, env, "/de/en", {}, "any.example.com")).text();
  checkTruthy("de renders its own theme", dePage.includes("THEME-DETHEME"));

  // -- 7. CPT front-end routing per site ----------------------------------
  console.log("\n7. Theme route dispatch per site");
  mkPost("ms_prod", "shop", "widget", "Widget Product");
  env.DB.prepare("UPDATE posts SET type='product' WHERE id='ms_prod'").run();

  const single = await req(worker, env, "/en/products/widget", {}, "shop.example.com");
  const singleHtml = await single.text();
  check("CPT single uses single-product template", single.headers.get("X-CFPress-Template"), "single-product");
  checkTruthy("CPT single renders slug", singleHtml.includes("widget"));
  checkTruthy("CPT single renders title", singleHtml.includes("Widget Product"));

  const archive = await req(worker, env, "/en/products", {}, "shop.example.com");
  const archiveHtml = await archive.text();
  check("CPT archive uses archive-product", archive.headers.get("X-CFPress-Template"), "archive-product");
  checkTruthy("CPT archive lists the product", archiveHtml.includes("Widget Product"));

  // A CPT slug must not resolve on a site whose theme does not declare it.
  const crossSite = await req(worker, env, "/en/products/widget", {}, "localhost");
  check("CPT invisible on a site that never declared it", crossSite.status, 404);

  // -- 8. menu isolation ---------------------------------------------------
  console.log("\n8. Per-site navigation");
  // Both sites get a menu with the *same id*, which is the interesting case:
  // the primary key is (site_id, id), so this must not collide.
  const mDef = await req(worker, env, "/api/v1/menus", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "primary", name: "Default Primary", location: "header" }),
  });
  check("default menu created", mDef.status, 201);
  const mShop = await req(worker, env, "/api/v1/menus?site=shop", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "primary", name: "Shop Primary", location: "header" }),
  });
  check("same menu id allowed on another site", mShop.status, 201);

  await req(worker, env, "/api/v1/menus/primary/items?site=shop", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Shop Nav", url: "/shop-nav" }),
  });
  const shopMenus = await (await req(worker, env, "/api/v1/menus?site=shop", { headers: auth })).json();
  const defMenus = await (await req(worker, env, "/api/v1/menus", { headers: auth })).json();
  check("shop menu carries shop's name", shopMenus.items.find((m) => m.id === "primary").name, "Shop Primary");
  check("default menu carries default's name", defMenus.items.find((m) => m.id === "primary").name, "Default Primary");
  const shopItems = await (await req(worker, env, "/api/v1/menus/primary/items?site=shop", { headers: auth })).json();
  check("shop menu items scoped", shopItems.items.map((i) => i.title), ["Shop Nav"]);
  const defItems = await (await req(worker, env, "/api/v1/menus/primary/items", { headers: auth })).json();
  checkTruthy("default menu items not polluted by shop",
    !defItems.items.some((i) => i.title === "Shop Nav"));

  // The API was clean while the *rendered page* leaked: `menu.primary` came from
  // a query that filtered on `menu_id` alone, and `menu_id` is only unique per
  // site — so the shop's nav item rendered inside the default site's page at
  // HTTP 200. An API-level assertion cannot see that layer; the rendered page
  // must be asserted too, in both directions.
  // ⚠️ Cache-bust both fetches: earlier sections already rendered `/en` for each
  // site, and a cached page predates the menu item this section creates — the
  // positive control would read yesterday's render and report the nav as empty.
  const bust = `navcheck=${Date.now()}`;
  const navHome = await req(worker, env, `/en?${bust}`);
  const defNav = (await navHome.text()).match(/<nav class="nav">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  check("default's rendered nav has no shop item", defNav.includes("Shop Nav"), false);
  check("default's rendered nav is otherwise empty (non-vacuity)", defNav.trim(), "");
  // Resolve shop by **host** (as a real request would): the `X-CFPress-Site`
  // header is only honoured on the theme-api paths, not on page renders.
  const shopNavHome = await req(worker, env, `/en?${bust}`, {}, "shop.example.com");
  const shopNav = (await shopNavHome.text()).match(/<nav class="nav">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  checkTruthy("shop's rendered nav does carry its own item", shopNav.includes("Shop Nav"));

  // -- 9. cache isolation --------------------------------------------------
  console.log("\n9. Cache generation isolation");
  const { cacheVersion, bumpContentCache } = await importCache();
  env._kvWrites.length = 0;
  const vDefaultBefore = await cacheVersion(env, "default");
  await bumpContentCache(env, "shop");
  const vDefaultAfter = await cacheVersion(env, "default");
  const vShop = await cacheVersion(env, "shop");
  check("default cache version untouched by shop bump", vDefaultAfter, vDefaultBefore);
  checkTruthy("shop cache version advanced", Number(vShop) > 1);
  checkTruthy("cache keys are namespaced by site",
    (await cacheKeyFor(env, "/en", "shop")).includes(":shop:") &&
    (await cacheKeyFor(env, "/en", "default")).includes(":default:"));

  // Version bookkeeping must not touch KV at all. Two reads of the same site
  // are the important case: the old code re-`put` the version whenever the KV
  // entry was missing, so a *read* was a write — including one scheduled write
  // per site per day, forever, because of its 24h TTL.
  check("cacheVersion does not write to KV (first read)", env._kvWrites.length, 0);
  await cacheVersion(env, "default");
  await cacheVersion(env, "default");
  check("cacheVersion does not write to KV on repeated reads", env._kvWrites.length, 0);
  await bumpContentCache(env, "default");
  check("bumpContentCache does not write to KV", env._kvWrites.length, 0);
  check("no KV write was recorded for any site", [...new Set(env._kvWrites)], []);

  // -- 9b. SEO endpoints are site-scoped ----------------------------------
  //
  // Regression test for a real bug: `/sitemap.xml` and `/robots.txt` were
  // routed *before* site resolution, and called `locales(env)` / `siteInfo(env)`
  // without a `siteId`. On a multi-site install every host therefore served the
  // default site's sitemap — silently, with a 200.
  //
  // The fix moved both routes after `resolveSite()` and made `siteId` a
  // required argument, so this can no longer compile if it regresses.
  console.log("\n9b. SEO endpoints are site-scoped");

  // Give each site a distinct title so the robots output is distinguishable.
  // ⚠️ The default site is a *real* site here — this suite runs against the
  // shared local D1 — so whatever it had is saved and put back, otherwise the
  // operator\x27s site title is silently replaced by a test value.
  const seoTitleBefore = (await (await req(worker, env, "/api/v1/settings", { headers: auth })).json())
    .items?.find((x) => x.key === "site.title")?.value ?? "";
  await req(worker, env, "/api/v1/settings", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "site.title", value: "Default Title" }),
  });
  await req(worker, env, "/api/v1/settings?site=shop", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "site.title", value: "Shop Title" }),
  });

  const smDefault = await req(worker, env, "/sitemap.xml", {}, "localhost");
  check("sitemap served on the default host", smDefault.status, 200);
  const smShopHost = await req(worker, env, "/sitemap.xml", {}, "shop.example.com");
  check("sitemap served on the shop host", smShopHost.status, 200);

  // The discriminating assertion: section 4 published `default-post` on the
  // default site and `shop-post` on shop. A sitemap that ignores `site_id`
  // lists BOTH on every host, so asserting on these two slugs is what actually
  // catches the bug — asserting merely that the XML is well-formed would not
  // (an earlier, weaker version of this test passed against the broken code).
  const defaultXml = await smDefault.text();
  const shopXml = await smShopHost.text();
  checkTruthy("sitemap XML is well-formed", shopXml.startsWith("<?xml") && shopXml.includes("</urlset>"));
  checkTruthy("default sitemap lists its own post", defaultXml.includes("/default-post"));
  checkTruthy("default sitemap does NOT list the shop's post", !defaultXml.includes("/shop-post"));
  checkTruthy("shop sitemap lists its own post", shopXml.includes("/shop-post"));
  checkTruthy("shop sitemap does NOT list the default site's post", !shopXml.includes("/default-post"));

  // A path-prefix site must resolve too, and its own path must be stripped
  // before matching the route.
  const smDe = await req(worker, env, "/de/sitemap.xml", {}, "localhost");
  check("prefix site reaches its own sitemap", smDe.status, 200);

  // robots.txt now reads the *site's* title, which is where the missing siteId
  // used to be invisible.
  const rbDefault = await req(worker, env, "/robots.txt", {}, "localhost");
  const rbShop = await req(worker, env, "/robots.txt", {}, "shop.example.com");
  check("robots served on default host", rbDefault.status, 200);
  check("robots served on shop host", rbShop.status, 200);
  checkTruthy("robots declares the sitemap", (await rbDefault.text()).includes("Sitemap: "));

  // -- 9c. the RSS feed is site-scoped and well-formed ---------------------
  //
  // Same class of bug as 9b, and a worse one to ship: a feed is polled
  // unattended by a subscriber's reader, so a feed that quietly serves another
  // site's posts is never noticed — unlike a page, nobody is looking at it.
  console.log("\n9c. The RSS feed is site-scoped");
  const fdDefault = await req(worker, env, "/feed.xml", {}, "localhost");
  const fdShop = await req(worker, env, "/feed.xml", {}, "shop.example.com");
  check("feed served on the default host", fdDefault.status, 200);
  check("feed served on the shop host", fdShop.status, 200);
  checkTruthy("feed uses the RSS content type", (fdDefault.headers.get("content-type") || "").includes("application/rss+xml"));
  const fdDefaultXml = await fdDefault.text();
  const fdShopXml = await fdShop.text();
  checkTruthy("feed is well-formed", fdDefaultXml.startsWith("<?xml") && fdDefaultXml.includes("</rss>"));
  checkTruthy("feed declares its own url", fdDefaultXml.includes("<atom:link href="));
  checkTruthy("guid is a permalink", fdDefaultXml.includes('isPermaLink="true"'));
  checkTruthy("feed carries the site's own title", fdDefaultXml.includes("Default Title"));
  // Put the operator's site title back — see the save in 9b above. The default
  // site is real; leaving a test value here is how "Default Title" ended up on
  // the operator's front page.
  await req(worker, env, "/api/v1/settings", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "site.title", value: seoTitleBefore }),
  });
  // The discriminating pair, exactly as in 9b: a feed that ignores `site_id`
  // lists BOTH slugs on every host.
  checkTruthy("default feed lists its own post", fdDefaultXml.includes("/default-post"));
  checkTruthy("default feed does NOT list the shop's post", !fdDefaultXml.includes("/shop-post"));
  checkTruthy("shop feed lists its own post", fdShopXml.includes("/shop-post"));
  checkTruthy("shop feed does NOT list the default site's post", !fdShopXml.includes("/default-post"));
  // `/rss.xml` is an alias — readers and humans both guess at this name.
  check("the /rss.xml alias answers too", (await req(worker, env, "/rss.xml", {}, "localhost")).status, 200);
  check("feed reaches a path-prefix site", (await req(worker, env, "/de/feed.xml", {}, "localhost")).status, 200);

  // -- 10. site delete protection -----------------------------------------
  console.log("\n10. Site delete protection");
  const delDefault = await req(worker, env, "/api/v1/sites/default", { method: "DELETE", headers: auth });
  check("default site cannot be deleted", delDefault.status, 400);

  await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "tmp", name: "Temp" }),
  });
  // Give the throwaway site per-site **registry** rows before deleting it, so
  // the delete has something to prove. A site's admin menus and its
  // generated-table mappings are not content: leaving them behind shows up as a
  // menu in the admin that cannot be opened, and a table declared for a site
  // nobody can see. Which tables a delete purges is declared in
  // `contract/schema.ts` (`onSiteDelete`), not decided here.
  sqlite.prepare(
    "INSERT INTO admin_menu_registry (id,site_id,owner_type,owner_name,menu_id,label,icon,screen,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run("amr_tmp", "tmp", "theme", "default", "tmp-menu", "Tmp", "file", "dashboard", 0, 0);
  sqlite.prepare(
    "INSERT INTO theme_table_defs (id,site_id,owner_type,owner_name,logical_name,table_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run("ttd_tmp", "tmp", "theme", "default", "listing", "theme_default_listing", 0, 0);

  const delTmp = await req(worker, env, "/api/v1/sites/tmp", { method: "DELETE", headers: auth });
  check("non-default site deletes ok", delTmp.status, 200);
  const after = await (await req(worker, env, "/api/v1/sites", { headers: auth })).json();
  check("tmp site gone", after.items.some((s) => s.id === "tmp"), false);
  check("deleting a site purges its admin-menu rows",
    sqlite.prepare("SELECT COUNT(*) AS n FROM admin_menu_registry WHERE site_id='tmp'").get()?.n, 0);
  check("deleting a site purges its generated-table mappings",
    sqlite.prepare("SELECT COUNT(*) AS n FROM theme_table_defs WHERE site_id='tmp'").get()?.n, 0);
  check("deleting a site purges its settings",
    sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE site_id='tmp'").get()?.n, 0);

  const upd = await req(worker, env, "/api/v1/sites/shop", {
    method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Shop Renamed" }),
  });
  check("site update ok", upd.status, 200);
  const afterUpd = await (await req(worker, env, "/api/v1/sites", { headers: auth })).json();
  check("site rename persisted", afterUpd.items.find((s) => s.id === "shop").name, "Shop Renamed");
  check("host preserved on partial update", afterUpd.items.find((s) => s.id === "shop").host, "shop.example.com");

  // Leave the shared local D1 as we found it: drop this run's fixtures, then put
  // back the capability rows the activations above rewrote (see `caps`).
  sweep();
  restoreCapabilities(sqlite, caps);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

async function importCache() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/shared/cache.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "cache.mjs");
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

async function cacheKeyFor(env, path, siteId) {
  const { cacheKey } = await importCache();
  return cacheKey(env, path, siteId);
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
