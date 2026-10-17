/**
 * End-to-end integration test for the theme system.
 *
 * Runs the REAL Worker source (compiled from TypeScript) against the REAL
 * local D1 database and a real R2 replacement, driving the full chain:
 *
 *   upload theme ZIP -> validate manifest -> activate -> apply capabilities
 *     -> resolve template (hierarchy) -> render (engine) -> HTTP response
 *
 * Usage: node tests/suites/theme-integration.test.mjs
 * Requires: `wrangler d1 migrations apply cfpress --local` to have been run.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
// Compile the Worker sources into one ESM bundle
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const tmp = join(root, ".wrangler", "test-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, code);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

// ---------------------------------------------------------------------------
// A D1-shaped adapter over node:sqlite
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
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

// ---------------------------------------------------------------------------
// A minimal in-memory R2
// ---------------------------------------------------------------------------
function makeR2() {
  const store = new Map();
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return {
        async text() { return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body); },
        body: entry.body,
        httpEtag: '"test"',
        writeHttpMetadata() {},
      };
    },
    async put(key, value, opts) {
      let body = value;
      if (value && typeof value.arrayBuffer === "function") body = new Uint8Array(await value.arrayBuffer());
      else if (value && typeof value.getReader === "function") {
        const chunks = [];
        const reader = value.getReader();
        for (;;) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
        body = merged;
      }
      store.set(key, { body, opts });
      return { key };
    },
    async delete(key) { store.delete(key); },
    // Real R2 bindings list by prefix; the theme uninstall walks this to delete
    // every version's files. A stub without it would turn "uninstall" into a
    // 500 that reads like a product bug rather than a harness gap.
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      const page = keys.slice(start, start + 1000);
      const truncated = start + 1000 < keys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
    _dump: () => [...store.keys()],
  };
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------
function makeEnv(sqlite) {
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: (() => {
      const m = new Map();
      return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
    })(),
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init) {
  const request = new Request("http://localhost" + path, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

// ---------------------------------------------------------------------------
// Theme package builder
// ---------------------------------------------------------------------------
function buildThemeZip(name) {
  const manifest = {
    name,
    title: "Real Estate",
    version: "1.0.0",
    supports: ["blocks", "menus"],
    templates: ["base", "index", "archive-property", "single-property", "archive-listing", "single-listing", "404"],
    parts: ["header", "footer"],
    postTypes: [{
      name: "property", label: "Property",
      labels: { singular: "Property", plural: "Properties" },
      supports: ["title", "editor"], hasArchive: true, rewrite: { slug: "properties" },
    }],
    taxonomies: [{ name: "city", label: "City", postTypes: ["property"], hierarchical: true }],
    fields: [
      { key: "price", label: "Price", type: "number", postTypes: ["property"], required: true },
      { key: "area", label: "Area", type: "number", postTypes: ["property"] },
    ],
    // A theme-owned table (L3). `translatable` names the fields that move into
    // `{table}_i18n` once the site serves a second language; while it serves
    // one they are ordinary main-table columns, which is why the fixture below
    // can write a row once and read it back in both places.
    tables: [{
      name: "listing",
      label: "Listing",
      translatable: ["title"],
      fields: [
        { key: "title", label: "Title", type: "text", required: true },
        { key: "price", label: "Price", type: "number" },
      ],
    }],
    routes: [
      { path: "/properties", template: "archive-property", query: { type: "property", limit: 12, as: "properties" } },
      { path: "/properties/:slug", template: "single-property", resolve: { type: "property", by: "slug" } },
      // Routes that read a theme-owned table instead of the post store.
      { path: "/shop", template: "archive-listing", resolve: { table: "listing" } },
      { path: "/shop/:slug", template: "single-listing", resolve: { table: "listing", by: "slug" } },
    ],
    adminMenus: [
      { id: "properties", label: "Properties", screen: "content-list", args: { type: "property" } },
      { id: "listings", label: "Listings", screen: "table-list", args: { table: "listing" } },
      { id: "theme-options", label: "Theme Options", screen: "theme-settings" },
    ],
    // Block names are plain identifiers, not namespaced paths: the platform
    // reserves `core/` for its own built-ins (`src/rendering/blocks.ts`), and a
    // declared block becomes a row keyed by `name` alone. A slash here is
    // rejected by the manifest validator before install.
    blocks: [{ name: "property-card", title: "Property Card", template: "parts/card" }],
    settings: [
      { key: "accent", label: "Accent colour", type: "color", default: "#0b5fff" },
      { key: "currency", label: "Currency", type: "text", default: "¥" },
    ],
    capabilities: ["content.read", "content.write", "routes.register"],
    // `capabilities` above is the theme-API surface a theme exposes to its own
    // templates (`themeCapabilities()`). `permissions` is the separate
    // install-time grant list the installer writes into
    // `extension_capabilities` — and it is what makes an uninstall's cleanup
    // observable: without it the throwaway theme has no grants to leak, and the
    // assertion below would pass on a build that never deletes them.
    permissions: ["content.read", "content.write", "routes.register"],
    runtime: "declarative",
  };

  const base = `<!doctype html><html lang="{{site.locale}}"><head><meta charset="utf-8"><title>{{page.title}} | {{site.title}}</title></head><body><header>CFPRESS-THEME-ACTIVE</header><main>{{@section "content"}}</main><footer>end</footer></body></html>`;

  // Demonstrates: inheritance, loops, conditionals, custom fields, helpers.
  const archive = `{{@extends "base"}}{{@section "content"}}
<h1>Properties</h1>
{{#if properties}}
<ul class="listing">
{{#each properties as p}}
  <li data-slug="{{p.slug}}">
    <a href="/{{locale}}/properties/{{p.slug}}">{{p.title}}</a>
    {{#if p.meta.price}}<span class="price">{{number(p.meta.price)}}</span>{{/if}}
    {{#if p.meta.area}}<span class="area">{{p.meta.area}} m2</span>{{/if}}
  </li>
{{/each}}
</ul>
{{else}}
<p class="empty">No properties found.</p>
{{/if}}
<p class="count">Total: {{len(properties)}}</p>
{{/section}}`;

  const single = `{{@extends "base"}}{{@section "content"}}
{{#if post}}
<article data-slug="{{post.slug}}">
  <h1>{{post.title}}</h1>
  {{#if post.meta.price}}<p class="price">{{number(post.meta.price)}}</p>{{/if}}
  <div class="body">{{{post.html}}}</div>
</article>
{{else}}
<h1>Property not found</h1>
{{/if}}
{{/section}}`;

  const notFound = `<!doctype html><html><head><title>Not Found</title></head><body><h1>404 — custom template</h1></body></html>`;

  // These two render a theme-owned table. Note the item link uses `{{p.url}}`,
  // which the router builds from the *route's own path* — a route exists
  // because the theme owns that URL space, so a hard-coded `/blog/<slug>` would
  // send every visitor of `/shop` to a 404.
  const archiveListing = `{{@extends "base"}}{{@section "content"}}
<h1>Shop</h1>
{{#if posts}}
<ul class="shop">
{{#each posts as p}}<li data-slug="{{p.slug}}"><a href="{{p.url}}">{{p.title}}</a></li>{{/each}}
</ul>
{{else}}<p class="empty">Nothing for sale.</p>{{/if}}
<p class="count">Total: {{len(posts)}}</p>
{{/section}}`;

  const singleListing = `{{@extends "base"}}{{@section "content"}}
{{#if post}}<article data-slug="{{post.slug}}"><h1>{{post.title}}</h1><p class="price">{{number(post.price)}}</p></article>
{{else}}<h1>Listing not found</h1>{{/if}}
{{/section}}`;

  const index = `{{@extends "base"}}{{@section "content"}}
<h1>Welcome</h1>
{{#each posts as post}}<article><a href="{{post.url}}">{{post.title}}</a></article>{{/each}}
{{/section}}`;

  const files = {
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/base.html": strToU8(base),
    "templates/index.html": strToU8(index),
    "templates/archive-property.html": strToU8(archive),
    "templates/single-property.html": strToU8(single),
    "templates/archive-listing.html": strToU8(archiveListing),
    "templates/single-listing.html": strToU8(singleListing),
    "templates/404.html": strToU8(notFound),
  };
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dbFile = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  // Wrangler stores local D1 in a sqlite file inside that directory.
  let sqlitePath = null;
  if (existsSync(dbFile)) {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dbFile).filter((f) => f.endsWith(".sqlite"));
    if (files.length) sqlitePath = join(dbFile, files[0]);
  }
  if (!sqlitePath) {
    console.error("Local D1 database not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  console.log(`Using local D1: ${sqlitePath}\n`);

  const sqlite = new DatabaseSync(sqlitePath);
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // Idempotent teardown of this suite's fixtures, run at BOTH ends: up front so
  // a crashed previous run cannot change what this one observes, and again at
  // the end so the shared local D1 — the file `wrangler dev` serves — keeps no
  // phantom rows. Sweeping only up front is what left `realestate`, `prop_1` and
  // the generated `theme_realestate_listing` table behind, i.e. a phantom theme
  // on the operator's Themes screen.
  const CLEANUP = [
    "DELETE FROM post_meta WHERE post_id='prop_1'",
    "DELETE FROM post_translations WHERE post_id='prop_1'",
    "DELETE FROM posts WHERE id='prop_1'",
    "DELETE FROM theme_installs WHERE name='realestate'",
    "DELETE FROM extension_versions WHERE extension_name='realestate'",
    "DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name='realestate'",
    "DELETE FROM post_types WHERE declared_by_theme='realestate'",
    "DELETE FROM taxonomies WHERE declared_by_theme='realestate'",
    "DELETE FROM field_defs WHERE declared_by_theme='realestate'",
    "DELETE FROM theme_routes WHERE declared_by_theme='realestate'",
    "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='realestate'",
    "DELETE FROM theme_blocks WHERE declared_by_theme='realestate'",
    "DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='realestate'",
    "DELETE FROM theme_setting_defs WHERE theme_name='realestate'",
    "DELETE FROM theme_settings WHERE theme_name='realestate'",
    // `theme_table_defs` deliberately survives theme deactivation (§3.4 — the
    // rows must stay reachable after a switch), so nothing removes this fixture
    // for us. Leaving it behind pollutes the shared local D1 that the other
    // suites read: a site-level "which tables exist" listing picks it up.
    "DROP TABLE IF EXISTS theme_realestate_listing_i18n",
    "DROP TABLE IF EXISTS theme_realestate_listing",
    // §9's throwaway theme. The uninstall removes it for real, but an aborted
    // run must not hand the next suite a theme that is half-there — that is the
    // exact "uninstall leaked" state the section is about.
    "DELETE FROM theme_installs WHERE name='uninstallme'",
    "DELETE FROM extension_versions WHERE extension_name='uninstallme'",
    "DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name='uninstallme'",
    "DELETE FROM post_types WHERE declared_by_theme='uninstallme'",
    "DELETE FROM taxonomies WHERE declared_by_theme='uninstallme'",
    "DELETE FROM field_defs WHERE declared_by_theme='uninstallme'",
    "DELETE FROM theme_routes WHERE declared_by_theme='uninstallme'",
    "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='uninstallme'",
    "DELETE FROM theme_blocks WHERE declared_by_theme='uninstallme'",
    "DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='uninstallme'",
    "DELETE FROM theme_setting_defs WHERE theme_name='uninstallme'",
    "DELETE FROM theme_settings WHERE theme_name='uninstallme'",
    "DROP TABLE IF EXISTS theme_uninstallme_listing_i18n",
    "DROP TABLE IF EXISTS theme_uninstallme_listing",
    // §11's throwaway site: the menu determinism section runs on its own site
    // so leftover header menus on `default` (user data, or another suite's
    // fixture) cannot change which menu wins the ORDER BY.
    "DELETE FROM menu_items WHERE site_id='menutest'",
    "DELETE FROM menus WHERE site_id='menutest'",
    "DELETE FROM theme_routes WHERE site_id='menutest'",
    "DELETE FROM site_locales WHERE site_id='menutest'",
    "DELETE FROM settings WHERE site_id='menutest'",
    "DELETE FROM posts WHERE site_id='menutest'",
    "DELETE FROM sites WHERE id='menutest'",
    // §12's throwaway site: the widget rendering section runs on its own site
    // so neither user widgets on `default` nor another suite's fixtures can
    // blur what should and should not appear.
    "DELETE FROM widget_instances WHERE site_id='widgetest'",
    "DELETE FROM menu_items WHERE site_id='widgetest'",
    "DELETE FROM menus WHERE site_id='widgetest'",
    "DELETE FROM post_meta WHERE post_id='wtest_post'",
    "DELETE FROM post_translations WHERE post_id='wtest_post'",
    "DELETE FROM posts WHERE id='wtest_post'",
    "DELETE FROM theme_routes WHERE site_id='widgetest'",
    "DELETE FROM site_locales WHERE site_id='widgetest'",
    "DELETE FROM settings WHERE site_id='widgetest'",
    "DELETE FROM posts WHERE site_id='widgetest'",
    "DELETE FROM sites WHERE id='widgetest'",
    // The §12 cross-site leak probe plants one marker widget on `default`;
    // an aborted run must not leave it in the user's real sidebar.
    "DELETE FROM widget_instances WHERE title='wtest_default_leak'",
  ];
  const sweep = () => { for (const sql of CLEANUP) { try { sqlite.exec(sql); } catch { /* table may not exist yet */ } } };
  sweep();
  // Capture the site-wide capability rows (field_defs / post_types / theme_routes
  // / admin_menu_registry / theme_installs.active) *after* the sweep, so the
  // teardown restores the operator's real theme rather than this suite's
  // fixtures. Activating `realestate` on the default site rewrites them, and the
  // throwaway `menutest`/`widgetest` sites each get their own copy.
  const caps = snapshotCapabilities(sqlite);

  // -- 1. bootstrap + login ------------------------------------------------
  console.log("1. Admin bootstrap & auth");
  await req(worker, env, "/api/v1/health");
  await req(worker, env, "/api/v1/auth/me"); // triggers bootstrapAdmin

  const loginRes = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const loginBody = await loginRes.json();
  checkTruthy("admin can log in", loginBody.user);
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  checkTruthy("session cookie issued", cookie.startsWith("cfpress_admin="));

  const authHeaders = { Cookie: cookie };

  // -- 2. install the theme ------------------------------------------------
  console.log("\n2. Theme install (ZIP upload)");
  const zip = buildThemeZip("realestate");
  const fd = new FormData();
  fd.append("file", new File([zip], "realestate.zip", { type: "application/zip" }));
  const upRes = await req(worker, env, "/api/v1/extensions/themes/upload", {
    method: "POST", headers: authHeaders, body: fd,
  });
  const upBody = await upRes.json();
  if (upRes.status !== 201) console.log("       upload response:", JSON.stringify(upBody));
  check("upload accepted", upRes.status, 201);
  check("theme name parsed", upBody.name, "realestate");
  checkTruthy("files stored", upBody.files >= 5);

  // Verify R2 actually holds the unpacked templates.
  const r2Keys = env.MEDIA._dump();
  checkTruthy("base.html stored in R2", r2Keys.some((k) => k.endsWith("templates/base.html")));
  checkTruthy("archive-property.html stored", r2Keys.some((k) => k.endsWith("templates/archive-property.html")));

  // -- 3. activate: capabilities materialise -------------------------------
  console.log("\n3. Theme activation -> business capabilities applied");
  const actRes = await req(worker, env, "/api/v1/extensions/themes/realestate/activate", {
    method: "POST", headers: authHeaders,
  });
  const actBody = await actRes.json();
  check("activation ok", actBody.ok, true);
  check("post types applied", actBody.applied.postTypes, 1);
  check("taxonomies applied", actBody.applied.taxonomies, 1);
  check("fields applied", actBody.applied.fields, 2);
  check("routes applied", actBody.applied.routes, 4);
  check("admin menus applied", actBody.applied.adminMenus, 3);
  check("theme-owned table applied", actBody.applied.tables, 1);
  check("blocks applied", actBody.applied.blocks, 1);
  check("settings applied", actBody.applied.settings, 2);

  const ptRes = await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders });
  const ptBody = await ptRes.json();
  check("CPT readable via API", ptBody.items.map((x) => x.name), ["property"]);
  check("CPT rewrite slug", ptBody.items[0].rewrite_slug, "properties");
  check("CPT supports parsed", ptBody.items[0].supports, ["title", "editor"]);

  const menuRes = await req(worker, env, "/api/v1/theme/menus", { headers: authHeaders });
  const menuBody = await menuRes.json();
  check("admin menus readable", menuBody.items.map((x) => x.menu_id).sort(), ["listings", "properties", "theme-options"]);
  check("admin menu args parsed", menuBody.items.find((x) => x.menu_id === "properties").args, { type: "property" });
  check("generated table menu names its table", menuBody.items.find((x) => x.menu_id === "listings").args, { table: "listing" });

  // -- 4. create CPT content + custom fields -------------------------------
  console.log("\n4. Custom post type content + custom fields");
  const nowSecs = Math.floor(Date.now() / 1000);
  env.DB.prepare("INSERT INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind("prop_1", "default", "user_admin", "property", "sea-view-villa", "published", nowSecs, nowSecs).run();
  env.DB.prepare("INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind("pt_1", "prop_1", "en", "Sea View Villa", "A lovely villa", JSON.stringify([{ type: "core/paragraph", attrs: { text: "Three bedrooms by the sea." } }]), nowSecs, nowSecs).run();
  await env.DB.prepare("INSERT INTO post_meta(post_id,meta_key,meta_value,updated_at) VALUES(?,?,?,?)")
    .bind("prop_1", "price", "4800000", nowSecs).run();
  await env.DB.prepare("INSERT INTO post_meta(post_id,meta_key,meta_value,updated_at) VALUES(?,?,?,?)")
    .bind("prop_1", "area", "186", nowSecs).run();

  // -- 5. template hierarchy + rendering -----------------------------------
  console.log("\n5. Template hierarchy resolution & rendering");

  // Home -> index.html
  const homeRes = await req(worker, env, "/en");
  const homeHtml = await homeRes.text();
  check("home uses theme (not fallback)", homeRes.headers.get("X-CFPress-Template"), "index");
  checkTruthy("home rendered theme header", homeHtml.includes("CFPRESS-THEME-ACTIVE"));

  // 404 -> 404.html
  const nfRes = await req(worker, env, "/en/does-not-exist");
  const nfHtml = await nfRes.text();
  check("404 status", nfRes.status, 404);
  check("404 uses custom template", nfRes.headers.get("X-CFPress-Template"), "404");
  checkTruthy("404 content", nfHtml.includes("404 — custom template"));

  // -- 5b. locale-prefix routing -------------------------------------------
  // Regression: the front-end router used to require a 2-letter first segment
  // and hand everything else to the asset layer. That made the site's own root
  // URL (`/`) unreachable — it was served by a leftover static placeholder
  // instead of the theme, which looks exactly like "the theme is broken".
  // A path without a locale must resolve against the site's default locale.
  console.log("\n5b. Locale-prefix routing (prefixed and unprefixed)");

  // Root path must reach the theme, not the asset layer.
  const rootRes = await req(worker, env, "/");
  check("unprefixed / renders a theme template", rootRes.headers.get("X-CFPress-Template"), "index");
  checkTruthy(
    "unprefixed / is not the static placeholder",
    !(await rootRes.text()).includes("Open Admin")
  );

  // The same routes must resolve identically with and without the prefix.
  for (const [bare, prefixed] of [
    ["/does-not-exist", "/en/does-not-exist"],
  ]) {
    const a = await req(worker, env, bare);
    const b = await req(worker, env, prefixed);
    check(`unprefixed ${bare} matches prefixed`, a.headers.get("X-CFPress-Template"), b.headers.get("X-CFPress-Template"));
    check(`unprefixed ${bare} status matches`, a.status, b.status);
  }

  // A non-locale first segment must NOT be swallowed as a locale. `/admin` is
  // the admin SPA: it belongs to the asset layer, and must never be rendered
  // through the theme (which is what happened when the locale parser was the
  // only thing standing between the SPA and the theme router).
  const adminRes = await req(worker, env, "/admin/admin.css");
  checkTruthy(
    "admin assets are not rendered by the theme",
    adminRes.headers.get("X-CFPress-Template") === null
  );

  // -- 5c. theme routes: declared template, table-backed routes, misses ------
  //
  // This section is as much about "a declaration means something" as about
  // routing. Three things were validated and then ignored:
  //   * `routes[].resolve.table` — checked against `tables[]` at install and
  //     never read, so a table-backed route silently listed nothing;
  //   * `routes[].template` — the architecture test even asserts the name is
  //     one of the theme's `templates[]`, yet the renderer picked the template
  //     purely from `kind`/`postType`;
  //   * the "route matched but found nothing" branch, which could never fire:
  //     `kind` only became "single" *after* a row had been found, so a miss
  //     answered with the archive listing and HTTP 200.
  console.log("\n5c. Theme routes: declared template, table-backed routes, misses");

  // Write a row through the admin API — the same facade the public route reads
  // through. If the two ever disagreed about what "listing" means, this is the
  // assertion that would catch it.
  const rowRes = await req(worker, env, "/api/v1/theme-tables/listing", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "oak-desk", title: "Oak Desk", price: 1200 }),
  });
  const rowBody = await rowRes.json();
  check("row saved through the admin facade", rowRes.status, 201);
  check("saved row carries the declared field", rowBody.row?.title, "Oak Desk");

  // The listing route. `X-CFPress-Template` is the proof that the route's own
  // `template` was used: with no post type to derive from, the hierarchy can
  // only ever reach `archive` then `index` — neither of which is shipped here.
  const shopRes = await req(worker, env, "/en/shop");
  const shopHtml = await shopRes.text();
  check("table route uses the declared template, not the hierarchy",
    shopRes.headers.get("X-CFPress-Template"), "archive-listing");
  check("table route status", shopRes.status, 200);
  checkTruthy("table route lists the row", shopHtml.includes("Oak Desk"));
  checkTruthy("table route counts rows with a helper", shopHtml.includes("Total: 1"));
  checkTruthy("row link is built from the route path, not /blog/",
    shopHtml.includes('href="/en/shop/oak-desk"'));

  // The single route, through the same table.
  const oneRes = await req(worker, env, "/en/shop/oak-desk");
  const oneHtml = await oneRes.text();
  check("table single uses the declared template", oneRes.headers.get("X-CFPress-Template"), "single-listing");
  checkTruthy("table single renders the row", oneHtml.includes("Oak Desk"));
  checkTruthy("table single formats the numeric field", oneHtml.includes("1,200"));

  // A miss is a 404, not the archive with a 200.
  const missRes = await req(worker, env, "/en/shop/no-such-listing");
  const missHtml = await missRes.text();
  check("a route that resolves one row 404s on a miss", missRes.status, 404);
  check("miss renders the 404 template", missRes.headers.get("X-CFPress-Template"), "404");
  checkTruthy("miss body is the 404 page", missHtml.includes("404 — custom template"));

  // The post-backed routes must still behave, and their item links must also
  // come from their own path.
  const propRes = await req(worker, env, "/en/properties/sea-view-villa");
  check("post-backed route still resolves", propRes.headers.get("X-CFPress-Template"), "single-property");
  const propMiss = await req(worker, env, "/en/properties/no-such-property");
  check("post-backed route 404s on a miss", propMiss.status, 404);

  const listRes = await req(worker, env, "/en/properties");
  const listHtml = await listRes.text();
  check("post-backed listing uses its declared template", listRes.headers.get("X-CFPress-Template"), "archive-property");
  checkTruthy("post-backed listing renders its rows", listHtml.includes("Sea View Villa"));

  // -- 6. engine features inside a real rendered page ----------------------
  console.log("\n6. Engine features in production rendering");
  // Drive the real uploaded R2 templates through the real engine with a
  // realistic scope, so loops / custom fields / helpers are all exercised.
  const { renderTemplateSource } = await importEngine();
  const archiveSrc = await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/archive-property.html")).text();
  const loaded = {
    base: await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/base.html")).text(),
  };
  const scope = {
    site: { title: "CFPress", locale: "en" },
    page: { title: "Properties" },
    locale: "en",
    properties: [
      { slug: "sea-view-villa", title: "Sea View Villa", meta: { price: "4800000", area: "186" } },
      { slug: "city-loft", title: "City Loft", meta: { price: "2200000", area: "94" } },
    ],
  };
  const archiveHtml = await renderTemplateSource(archiveSrc, scope, {
    loadTemplate: async (n) => loaded[n] ?? null,
  });
  checkTruthy("archive renders inherited layout", archiveHtml.includes("CFPRESS-THEME-ACTIVE"));
  checkTruthy("archive loops both properties", archiveHtml.includes("Sea View Villa") && archiveHtml.includes("City Loft"));
  checkTruthy("archive formats number helper", archiveHtml.includes("4,800,000"));
  checkTruthy("archive renders area field", archiveHtml.includes("186 m2"));
  checkTruthy("archive renders count helper", archiveHtml.includes("Total: 2"));

  // Empty-state branch
  const emptyHtml = await renderTemplateSource(archiveSrc, { ...scope, properties: [] }, {
    loadTemplate: async (n) => loaded[n] ?? null,
  });
  checkTruthy("archive empty branch", emptyHtml.includes("No properties found."));
  checkTruthy("archive empty count is zero", emptyHtml.includes("Total: 0"));

  // Single template with custom fields
  const singleSrc = await (await env.MEDIA.get("extensions/themes/realestate/1.0.0/files/templates/single-property.html")).text();
  const singleHtml = await renderTemplateSource(singleSrc, {
    site: { title: "CFPress", locale: "en" },
    locale: "en",
    post: { slug: "sea-view-villa", title: "Sea View Villa", meta: { price: "4800000" }, html: "<p>Three bedrooms by the sea.</p>" },
  }, { loadTemplate: async (n) => loaded[n] ?? null });
  checkTruthy("single renders post title", singleHtml.includes("Sea View Villa"));
  checkTruthy("single formats price", singleHtml.includes("4,800,000"));
  checkTruthy("single outputs raw html block", singleHtml.includes("<p>Three bedrooms by the sea.</p>"));

  // -- 7. theme switching preserves data -----------------------------------
  console.log("\n7. Theme switch preserves business data");
  await req(worker, env, "/api/v1/extensions/themes/default/activate", { method: "POST", headers: authHeaders });
  const ptAfter = await (await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders })).json();
  check("CPT hidden after switch", ptAfter.items.length, 0);

  const propRow = await env.DB.prepare("SELECT id FROM posts WHERE id='prop_1'").first();
  checkTruthy("property content preserved (not deleted)", propRow);

  const metaRow = await env.DB.prepare("SELECT meta_value FROM post_meta WHERE post_id='prop_1' AND meta_key='price'").first();
  check("custom field value preserved", metaRow?.meta_value, "4800000");

  // Switch back -> declarations return
  const back = await (await req(worker, env, "/api/v1/extensions/themes/realestate/activate", { method: "POST", headers: authHeaders })).json();
  check("capabilities restored on re-activate", back.applied.postTypes, 1);
  const ptBack = await (await req(worker, env, "/api/v1/theme/post-types", { headers: authHeaders })).json();
  check("CPT visible again", ptBack.items.length, 1);

  // -- 8. missing theme.active setting must not degrade to __fallback__ -----
  // Regression: `activeTheme` used to fall back to the literal string
  // "default" when a site had no `theme.active` row. Because the bundled
  // "default" theme has no R2 files, every page then rendered the bare
  // __fallback__ shell — indistinguishable from a broken theme package.
  // A missing setting must resolve to a theme that is actually installed.
  console.log("\n8. Absent theme.active resolves to a renderable theme");
  const keepSetting = await env.DB.prepare(
    "SELECT value FROM settings WHERE site_id='default' AND key='theme.active'"
  ).first();
  await env.DB.prepare(
    "DELETE FROM settings WHERE site_id='default' AND key='theme.active'"
  ).run();

  const noSettingRes = await req(worker, env, "/en", { headers: authHeaders });
  const noSettingTpl = noSettingRes.headers.get("X-CFPress-Template");
  checkTruthy(
    "no theme.active setting still renders a real template",
    noSettingTpl && noSettingTpl !== "__fallback__" && noSettingTpl !== "__none__"
  );

  // Restore whatever the database had before this check ran.
  if (keepSetting?.value) {
    await env.DB.prepare(
      "INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) " +
      "ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value"
    ).bind("theme-active-default", "default", "theme.active", String(keepSetting.value)).run();
  }

  // -- 9. Uninstall --------------------------------------------------------
  console.log("\n9. Theme uninstall");
  // Uninstalling is the only way a theme leaves the registry, so the assertions
  // below are the contract: *everything* keyed by the theme goes — files,
  // registry row, generated tables and their mapping, capability grants, admin
  // menus, setting definitions and saved values — and a theme a site is still
  // rendering cannot go at all.
  //
  // The throwaway theme is **activated** first, on purpose. A theme that was
  // only uploaded owns nothing, so an "is X gone?" assertion about it passes
  // whatever the uninstall does — which is how three missing cleanup steps
  // stayed invisible here.
  const up2 = await req(worker, env, "/api/v1/extensions/themes/upload", {
    method: "POST", headers: authHeaders,
    body: (() => {
      const fd = new FormData();
      fd.append("file", new File([buildThemeZip("uninstallme")], "uninstallme.zip", { type: "application/zip" }));
      return fd;
    })(),
  });
  check("throwaway theme uploaded", up2.status, 201);
  const ownKeys = env.MEDIA._dump().filter((k) => k.includes("extensions/themes/uninstallme/"));
  checkTruthy("its files are in R2", ownKeys.length >= 5, ownKeys.length);

  const countFor = (sql) => sqlite.prepare(sql).get()?.n;

  const act2 = await req(worker, env, "/api/v1/extensions/themes/uninstallme/activate", { method: "POST", headers: authHeaders });
  const act2Body = await act2.json();
  check("throwaway theme activated", act2Body.ok, true);
  check("activation registered its admin menus", act2Body.applied.adminMenus, 3);
  check("activation registered its setting definitions", act2Body.applied.settings, 2);

  // Confirm each face is non-empty *before* asserting it is empty afterwards.
  // An unguarded "0 == 0" would pass on a build that never wrote the row.
  const menuSql = "SELECT COUNT(*) AS n FROM admin_menu_registry WHERE owner_type='theme' AND owner_name='uninstallme'";
  const defSql = "SELECT COUNT(*) AS n FROM theme_setting_defs WHERE theme_name='uninstallme'";
  const valSql = "SELECT COUNT(*) AS n FROM theme_settings WHERE theme_name='uninstallme'";
  const capSql = "SELECT COUNT(*) AS n FROM extension_capabilities WHERE extension_type='theme' AND extension_name='uninstallme'";
  const mapSql = "SELECT COUNT(*) AS n FROM theme_table_defs WHERE owner_type='theme' AND owner_name='uninstallme'";
  const tblSql = "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='theme_uninstallme_listing'";
  checkTruthy("activation left admin menus to clean", countFor(menuSql) > 0, countFor(menuSql));
  checkTruthy("activation left setting definitions to clean", countFor(defSql) > 0, countFor(defSql));
  checkTruthy("install left capability grants to clean", countFor(capSql) > 0, countFor(capSql));
  checkTruthy("activation left a table mapping to clean", countFor(mapSql) > 0, countFor(mapSql));
  checkTruthy("activation created its generated table", countFor(tblSql) > 0, countFor(tblSql));
  // A saved value is the half of the settings pair a definition alone would not
  // catch. The theme-settings endpoint is the only writer, so drive it.
  const saveSet = await req(worker, env, "/api/v1/theme/uninstallme/settings", {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "accent", value: "#123456" }),
  });
  check("a theme setting value saved", saveSet.status, 200);
  checkTruthy("there is a saved value to clean", countFor(valSql) > 0, countFor(valSql));

  // A theme a site is rendering still cannot go, and the 409 names the site.
  check("uninstalling a theme in use is refused",
    (await req(worker, env, "/api/v1/extensions/themes/uninstallme", { method: "DELETE", headers: authHeaders })).status, 409);

  // The operator's way out: a **forced** uninstall deactivates the theme on
  // every site that renders it (they fall back to the bundled default, which
  // rule 66 keeps renderable everywhere) and then removes it. The refusal
  // above stays the authority for the unforced call — force is an explicit
  // confirmation, not a default.
  const forced = await req(worker, env, "/api/v1/extensions/themes/uninstallme?force=1", { method: "DELETE", headers: authHeaders });
  check("a forced uninstall is accepted while the theme is in use", forced.status, 200);
  check("and the occupying site falls back to the bundled default",
    sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='theme.active'").get()?.value, "default");
  check("and the theme is really gone",
    (await (await req(worker, env, "/api/v1/extensions/themes", { headers: authHeaders })).json()).items.some((x) => x.name === "uninstallme"), false);

  // Re-upload and re-activate so the section below can prove the *unforced*
  // path's cleanup against the same leftover faces (menus, settings, tables).
  // The activation is idempotent upsert, so this rebuilds exactly the state
  // the first activation left.
  const up3 = await req(worker, env, "/api/v1/extensions/themes/upload", {
    method: "POST", headers: authHeaders,
    body: (() => {
      const fd = new FormData();
      fd.append("file", new File([buildThemeZip("uninstallme")], "uninstallme.zip", { type: "application/zip" }));
      return fd;
    })(),
  });
  check("throwaway theme re-uploaded for the unforced path", up3.status, 201);
  const reAct = await req(worker, env, "/api/v1/extensions/themes/uninstallme/activate", { method: "POST", headers: authHeaders });
  check("and re-activated", (await reAct.json()).ok, true);

  // Make it unused *without* going through deactivation. Deactivation clears the
  // owner's admin menus itself, so switching the site away first would erase the
  // very rows this section exists to prove the uninstall removes. A missing
  // `theme.active` row is a real state — an activation interrupted before it
  // wrote the setting leaves exactly this — and the menus are still there.
  sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='theme.active'");
  checkTruthy("the leftover menus survived the theme becoming inactive", countFor(menuSql) > 0, countFor(menuSql));

  const delRes = await req(worker, env, "/api/v1/extensions/themes/uninstallme", { method: "DELETE", headers: authHeaders });
  const delBody = await delRes.json();
  check("uninstall accepted", delRes.status, 200);
  check("it reports the files it removed", delBody.files, ownKeys.length);
  const afterList = await (await req(worker, env, "/api/v1/extensions/themes", { headers: authHeaders })).json();
  check("registry row gone", (afterList.items || []).some((x) => x.name === "uninstallme"), false);
  check("its R2 files are gone",
    env.MEDIA._dump().filter((k) => k.includes("extensions/themes/uninstallme/")).length, 0);
  check("its generated table is gone", countFor(tblSql), 0);
  check("its table mapping is gone", countFor(mapSql), 0);
  check("its admin menus are gone", countFor(menuSql), 0);
  check("its setting definitions are gone", countFor(defSql), 0);
  check("its saved setting values are gone", countFor(valSql), 0);
  check("its capability grants are gone", countFor(capSql), 0);
  check("uninstalling it again is a 404",
    (await req(worker, env, "/api/v1/extensions/themes/uninstallme", { method: "DELETE", headers: authHeaders })).status, 404);

  // The theme this site is rendering cannot be uninstalled, and the 409 names
  // the site so the operator knows what to switch first. `uninstallme` was
  // activated over realestate above, so put realestate back first.
  await req(worker, env, "/api/v1/extensions/themes/realestate/activate", { method: "POST", headers: authHeaders });
  const activeRes = await req(worker, env, "/api/v1/extensions/themes/realestate", { method: "DELETE", headers: authHeaders });
  const activeBody = await activeRes.json();
  check("uninstalling the active theme is refused", activeRes.status, 409);
  checkTruthy("and the refusal names the site", String(activeBody.error || "").includes("still active on"));

  // §7 left realestate active; restore the default theme this suite started on,
  // so a later suite reads the state it expects.
  await req(worker, env, "/api/v1/extensions/themes/default/activate", { method: "POST", headers: authHeaders });

  // -- 10. Bundled themes render from assets, not R2 ------------------------
  console.log("\n10. A wiped R2 still renders the bundled theme");
  // This is the "no more patching" contract: bundled themes ship through the
  // Worker's ASSETS binding (public/themes, synced by
  // scripts/sync-bundled-themes.mjs), so a database wipe — or any state where
  // R2 holds zero theme files — must still render the homepage through the
  // real theme templates instead of the __fallback__ shell. Historically the
  // fallback only lived in R2, and every wipe produced __fallback__ until
  // someone hand-uploaded 13 objects; a fake ASSETS stub (200 for everything)
  // made that regression untestable, which is why this suite now serves real
  // files from disk.
  const wipedEnv = { ...env, MEDIA: makeR2() };
  checkTruthy("R2 starts empty for this section", wipedEnv.MEDIA._dump().length === 0);
  const wipedRes = await req(worker, wipedEnv, "/", { headers: authHeaders });
  const wipedTpl = wipedRes.headers.get("X-CFPress-Template");
  // The default theme declares `home` as its front-page template (the template
  // hierarchy prefers it over `index`), so a real resolution says "home" — the
  // fallback shell would say "__fallback__".
  check("empty MEDIA still resolves the active theme's template", wipedTpl, "home");
  checkTruthy("and it is not the fallback shell", wipedTpl && wipedTpl !== "__fallback__" && wipedTpl !== "__none__");
  const wipedBody = await wipedRes.text();
  checkTruthy("the body looks like theme markup, not the shell",
    wipedBody.includes("<html") && !wipedBody.includes("__fallback__"));

  // The other half of the contract: the bundled names are product-owned, so
  // they cannot be displaced by an upload or removed by an uninstall.
  const guardFd = new FormData();
  guardFd.append("file", new File([buildThemeZip("default")], "default.zip", { type: "application/zip" }));
  const guardRes = await req(worker, env, "/api/v1/extensions/themes/upload", {
    method: "POST", headers: authHeaders, body: guardFd,
  });
  const guardBody = await guardRes.json();
  check("uploading over a bundled name is refused", guardRes.status, 400);
  checkTruthy("and the refusal says why", String(guardBody.error || "").includes("ships with the product"));
  const unRes = await req(worker, env, "/api/v1/extensions/themes/default", { method: "DELETE", headers: authHeaders });
  const unBody = await unRes.json();
  check("uninstalling a bundled theme is refused", unRes.status, 400);
  checkTruthy("and the refusal says why", String(unBody.error || "").includes("ships with the product"));
  // The refused uninstall must not have removed the install row either —
  // a 400 that still mutated state would be worse than a 500.
  check("the bundled theme is still installed",
    sqlite.prepare("SELECT COUNT(*) AS n FROM theme_installs WHERE name='default'").get()?.n, 1);

  console.log("\n11. Menu locations resolve deterministically (rule 73)");
  // Two header menus on one site used to be a coin flip: `LIMIT 1` without
  // ORDER BY returned whichever row SQLite felt like, so the nav could change
  // between requests. The contract now: the location set comes from the
  // active theme's manifest (header + footer for the bundled default), and
  // each location renders exactly one menu — the lexicographically smallest
  // id wins, every time. The section runs on a throwaway site so neither the
  // user's real menus nor another suite's fixtures can skew the winner.
  const mkSite = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "menutest", name: "Menu Test", path_prefix: "/menutest" }),
  });
  check("throwaway site created", mkSite.status, 201);
  const actDef = await req(worker, env, "/api/v1/extensions/themes/default/activate?site=menutest", { method: "POST", headers: authHeaders });
  checkTruthy("bundled default theme activates on the throwaway site", actDef.status === 200);
  const locsRes = await req(worker, env, "/api/v1/theme/menu-locations?site=menutest", { headers: authHeaders });
  const locs = await locsRes.json();
  check("the manifest's menu locations are served to the admin",
    (locs.items || []).map((l) => l.id), ["header", "footer"]);
  for (const [id, name, location] of [["menu_aaa", "AAA", "header"], ["menu_zzz", "ZZZ", "header"], ["menu_foot", "Foot", "footer"]]) {
    const r = await req(worker, env, "/api/v1/menus?site=menutest", {
      method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, location }),
    });
    checkTruthy(`menu ${id} created`, r.status === 201);
  }
  for (const [menuId, id, title] of [["menu_aaa", "mi_a", "AAA-LINK"], ["menu_zzz", "mi_z", "ZZZ-LINK"], ["menu_foot", "mi_f", "FOOT-LINK"]]) {
    const r = await req(worker, env, `/api/v1/menus/${menuId}/items?site=menutest`, {
      method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id, title, url: `/${title.toLowerCase()}` }),
    });
    checkTruthy(`item ${id} created`, r.status === 201);
  }
  const rAll = await req(worker, env, `/api/v1/menus/menu_aaa/items?site=menutest`, {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "mi_all", title: "ALL-LANG-LINK", url: "/all-link", locale: "" }),
  });
  checkTruthy("item with locale='' created", rAll.status === 201);
  const navRes = await req(worker, env, "/menutest/", { headers: authHeaders });
  const navBody = await navRes.text();
  check("of two header menus the deterministic winner renders", navBody.includes("AAA-LINK"), true);
  check("item with locale='' renders on the page", navBody.includes("ALL-LANG-LINK"), true);
  check("the loser does not render", navBody.includes("ZZZ-LINK"), false);
  check("the declared footer location renders its menu", navBody.includes("FOOT-LINK"), true);
  // Second render must be byte-identical on the nav — the whole point of 73.
  const navRes2 = await req(worker, env, "/menutest/", { headers: authHeaders });
  const navBody2 = await navRes2.text();
  check("a second render picks the same menu (no coin flip)",
    navBody2.includes("AAA-LINK") && !navBody2.includes("ZZZ-LINK"), true);
  // Multi-language menu filtering: locale-specific items only show in their own language
  await req(worker, env, `/api/v1/menus/menu_aaa/items?site=menutest`, {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "mi_en", title: "EN-ONLY-LINK", url: "/en-link", locale: "en" }),
  });
  await req(worker, env, `/api/v1/menus/menu_aaa/items?site=menutest`, {
    method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "mi_zh", title: "ZH-ONLY-LINK", url: "/zh-link", locale: "zh-CN" }),
  });
  const navEn = await (await req(worker, env, "/menutest/en", { headers: authHeaders })).text();
  check("en page includes EN-ONLY-LINK", navEn.includes("EN-ONLY-LINK"), true);
  check("en page does not include ZH-ONLY-LINK", navEn.includes("ZH-ONLY-LINK"), false);
  const navZh = await (await req(worker, env, "/menutest/zh-CN", { headers: authHeaders })).text();
  check("zh-CN page includes ZH-ONLY-LINK", navZh.includes("ZH-ONLY-LINK"), true);
  check("zh-CN page does not include EN-ONLY-LINK", navZh.includes("EN-ONLY-LINK"), false);

  // Prism theme parity: prism theme must also render header and footer menus cleanly
  const actPrism = await req(worker, env, "/api/v1/extensions/themes/prism/activate?site=menutest", { method: "POST", headers: authHeaders });
  checkTruthy("bundled prism theme activates on throwaway site", actPrism.status === 200);
  const prismNavRes = await req(worker, env, "/menutest/en", { headers: authHeaders });
  const prismNavBody = await prismNavRes.text();
  check("prism theme renders header menu items", prismNavBody.includes("AAA-LINK"), true);
  check("prism theme renders footer menu items", prismNavBody.includes("FOOT-LINK"), true);
  check("prism theme renders locale-specific menu items", prismNavBody.includes("EN-ONLY-LINK"), true);

  // Cleanup: remove the throwaway site so the shared local D1 stays clean.
  await req(worker, env, "/api/v1/sites/menutest", { method: "DELETE", headers: authHeaders });
  for (const sql of [
    "DELETE FROM menu_items WHERE site_id='menutest'",
    "DELETE FROM menus WHERE site_id='menutest'",
    "DELETE FROM theme_routes WHERE site_id='menutest'",
    "DELETE FROM site_locales WHERE site_id='menutest'",
    "DELETE FROM settings WHERE site_id='menutest'",
    "DELETE FROM posts WHERE site_id='menutest'",
  ]) { try { sqlite.exec(sql); } catch { /* table may not exist */ } }

  console.log("\n12. Widgets render site-scoped, per locale, disabled hidden (rule 74)");
  // Widgets went install-wide → per-site in 0020 because the only read path
  // that existed had no tenant filter. The contract, end to end on a real
  // render: every declared widget type shows up, a disabled widget does not,
  // another site's widget never leaks in, and a locale-pinned widget renders
  // only on its own language's pages.
  const jh = { ...authHeaders, "Content-Type": "application/json" };
  const wMkSite = await req(worker, env, "/api/v1/sites", {
    method: "POST", headers: jh,
    body: JSON.stringify({ id: "widgetest", name: "Widget Test", path_prefix: "/widgetest" }),
  });
  check("throwaway site created", wMkSite.status, 201);
  checkTruthy("bundled default theme activates on the throwaway site",
    (await req(worker, env, "/api/v1/extensions/themes/default/activate?site=widgetest", { method: "POST", headers: authHeaders })).status === 200);
  // One published post so the recent-posts widget has something to list.
  const wMkPost = await req(worker, env, "/api/v1/posts/wtest_post?site=widgetest", {
    method: "PUT", headers: jh,
    body: JSON.stringify({ locale: "en", title: "WPost", slug: "wpost", status: "published", content: [] }),
  });
  check("fixture post created", wMkPost.status === 200 || wMkPost.status === 201, true);
  // A menu for the menu widget.
  await req(worker, env, "/api/v1/menus?site=widgetest", {
    method: "POST", headers: jh, body: JSON.stringify({ id: "menu_wtest", name: "WT", location: "footer" }),
  });
  await req(worker, env, "/api/v1/menus/menu_wtest/items?site=widgetest", {
    method: "POST", headers: jh, body: JSON.stringify({ title: "WIDGET-MENU-LINK", url: "/wt" }),
  });
  await req(worker, env, "/api/v1/menus/menu_wtest/items?site=widgetest", {
    method: "POST", headers: jh, body: JSON.stringify({ title: "WIDGET-ALL-LANG-LINK", url: "/wt-all", locale: "" }),
  });
  const wMkWidget = (title, body2) => req(worker, env, "/api/v1/widgets?site=widgetest", {
    method: "POST", headers: jh, body: JSON.stringify(body2),
  }).then(async (r) => ({ status: r.status, id: (await r.json()).id, title }));
  const wText = await wMkWidget("wtest_text", { title: "wtest_text", widget_type: "text", sidebar: "sidebar", config: { body: "WIDGET-TEXT-BODY" } });
  const wHtml = await wMkWidget("wtest_html", { title: "wtest_html", widget_type: "html", sidebar: "sidebar", config: { body: "<b>WIDGET-HTML-BOLD</b>" } });
  const wRecent = await wMkWidget("wtest_recent", { title: "wtest_recent", widget_type: "recent-posts", sidebar: "sidebar", config: { count: 5 } });
  const wMenu = await wMkWidget("wtest_menu", { title: "wtest_menu", widget_type: "menu", sidebar: "footer", config: { menu_id: "menu_wtest" } });
  const wOff = await wMkWidget("wtest_off", { title: "wtest_off", widget_type: "text", sidebar: "sidebar", enabled: false, config: { body: "DISABLED-WIDGET-BODY" } });
  check("all five fixture widgets created", [wText.status, wHtml.status, wRecent.status, wMenu.status, wOff.status].every((s) => s === 201), true);
  // A locale-pinned widget: assert against whatever language the page actually
  // renders in (the site has no declared locales, so don't guess).
  const wProbe = await req(worker, env, "/widgetest/", { headers: authHeaders });
  const wProbeBody = await wProbe.text();
  const pageLocale = (wProbeBody.match(/<html lang="([^"]+)"/) || [])[1] || "en";
  const otherLocale = pageLocale === "en" ? "zh-CN" : "en";
  const wLoc = await wMkWidget("wtest_loc", { title: "wtest_loc", widget_type: "text", sidebar: "sidebar", locale: pageLocale, config: { body: "PAGE-LOCALE-WIDGET" } });
  const wForeign = await wMkWidget("wtest_foreign", { title: "wtest_foreign", widget_type: "text", sidebar: "sidebar", locale: otherLocale, config: { body: "OTHER-LOCALE-WIDGET" } });
  check("locale-pinned widgets created", [wLoc.status, wForeign.status].every((s) => s === 201), true);
  // The leak probe: a widget on the DEFAULT site must never reach this render.
  const leakRes = await req(worker, env, "/api/v1/widgets?site=default", {
    method: "POST", headers: jh,
    body: JSON.stringify({ title: "wtest_default_leak", widget_type: "text", sidebar: "sidebar", config: { body: "DEFAULT-SITE-WIDGET" } }),
  });
  check("leak-probe widget created on the default site", leakRes.status, 201);

  const res = await req(worker, env, "/widgetest/", { headers: authHeaders });
  const body = await res.text();
  check("text widget renders its escaped body", body.includes("WIDGET-TEXT-BODY"), true);
  check("html widget renders raw markup", body.includes("<b>WIDGET-HTML-BOLD</b>"), true);
  check("recent-posts widget lists the site's post with a frontend URL", body.includes("/blog/wpost"), true);
  check("menu widget renders its menu's items", body.includes("WIDGET-MENU-LINK"), true);
  check("menu widget renders item with locale=''", body.includes("WIDGET-ALL-LANG-LINK"), true);
  check("the page-locale widget renders", body.includes("PAGE-LOCALE-WIDGET"), true);
  check("a disabled widget does not render", body.includes("DISABLED-WIDGET-BODY"), false);
  check("a widget pinned to the other locale does not render", body.includes("OTHER-LOCALE-WIDGET"), false);
  check("another site's widget never leaks in", body.includes("DEFAULT-SITE-WIDGET"), false);
  // The probe page was fetched before the last three widgets existed; fetch
  // once more so the assertions above describe the final state, not a stale one.
  const body2 = await (await req(worker, env, "/widgetest/", { headers: authHeaders })).text();
  check("a second render is consistent", body2.includes("PAGE-LOCALE-WIDGET") && !body2.includes("DEFAULT-SITE-WIDGET"), true);

  // 13. Visual Canvas & Widget Types API
  const typesRes = await (await req(worker, env, "/api/v1/widgets/types", { headers: authHeaders })).json();
  check("widget types catalog returned", Array.isArray(typesRes.items) && typesRes.items.length >= 4, true);
  check("core widget type 'text' present in types catalog", typesRes.items.some((x) => x.type === "text" || x.type === "core.text"), true);

  // Canvas preview requires admin session
  const unauthPreview = await req(worker, env, "/admin/preview?path=/widgetest/&site=widgetest");
  check("unauthenticated canvas preview is rejected", unauthPreview.status, 401);

  // Authenticated canvas preview renders with interactive slot anchors & bridge
  const canvasRes = await req(worker, env, "/admin/preview?path=/widgetest/&site=widgetest", { headers: authHeaders });
  check("authenticated canvas preview status", canvasRes.status, 200);
  const canvasHtml = await canvasRes.text();
  checkTruthy("canvas preview injects base href tag", canvasHtml.includes('<base href="/">'));
  checkTruthy("canvas preview contains slot data attributes", canvasHtml.includes('data-slot='));
  checkTruthy("canvas preview contains widget data attributes", canvasHtml.includes('data-widget='));
  checkTruthy("canvas preview injects bridge script", canvasHtml.includes('frame:ready'));

  // Cleanup: the throwaway site and the leak probe leave nothing behind.
  await req(worker, env, "/api/v1/sites/widgetest", { method: "DELETE", headers: authHeaders });
  const leakList = await (await req(worker, env, "/api/v1/widgets?site=default", { headers: authHeaders })).json();
  for (const w of (leakList.items || []).filter((x) => x.title === "wtest_default_leak")) {
    await req(worker, env, `/api/v1/widgets/${w.id}?site=default`, { method: "DELETE", headers: authHeaders });
  }
  // Leave the shared local D1 as we found it: drop this run's fixtures, then put
  // back the capability rows the activations above rewrote (see `caps`).
  sweep();
  restoreCapabilities(sqlite, caps);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

async function importEngine() {
  const esbuild = require("esbuild");
  const src = readFileSync(join(root, "src/rendering/template-engine.ts"), "utf8");
  const out = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "es2022" });
  const tmp = join(root, ".wrangler", "engine.mjs");
  writeFileSync(tmp, out.code);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
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
