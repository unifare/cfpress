/**
 * Multi-language contract test — the eight assertions of ARCHITECTURE.md §5.4①.
 *
 *   - a monolingual site gets **no** `_i18n` table
 *   - enabling a second language creates it
 *   - single-language reads ignore the `locale` argument
 *   - a missing translation falls back to the site default (never empty, never an error)
 *   - an explicitly prefixed `/en/x` that does not exist returns 404, with no fallback
 *   - an unprefixed `/x` that does not exist tries the site's other languages
 *   - a non-translatable field (`price`) is identical in every language
 *   - a translatable field (`name`) differs per language
 *
 * The last two are the point of the whole design: they prove the
 * `translatable` split actually decides which data is language-dependent. A
 * `price` that differs per language is a shop that charges 20% less in English.
 *
 * Usage: node tests/suites/i18n.test.mjs
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

const THEME = "eshoptheme";
const MAIN_TABLE = `theme_${THEME}_product`;
const I18N_TABLE = `${MAIN_TABLE}_i18n`;

// ---------------------------------------------------------------------------
// Harness (mirrors multisite.test.mjs)
// ---------------------------------------------------------------------------
async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "i18n-bundle.mjs");
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
  return {
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    ASSETS: assetsStub(),
    _kv: kv,
  };
}

async function req(worker, env, path, init = {}, host = "localhost") {
  const request = new Request(`http://${host}${path}`, init);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch(request, env, ctx);
}

/**
 * A theme that declares one business table with both kinds of field.
 *
 * `price` and `sku` are language-independent; `name` and `description` are
 * translatable. That split is the thing under test.
 *
 * `sku` is declared `number` rather than `text` on purpose. Under rule 41 every
 * `text`/`longtext` field is *prose* and therefore **must** be translatable —
 * a `text` sku would be rejected at install. A SKU is an identifier, so like a
 * price it must round-trip unchanged: `number` is the language-neutral type that
 * says so. `text` would have made this fixture a counter-example to the rule it
 * is supposed to exercise.
 */
function buildEshopZip() {
  const manifest = {
    name: THEME,
    title: "EShop theme",
    version: "1.0.0",
    templates: ["index", "page", "single", "archive", "404"],
    tables: [
      {
        name: "product",
        label: "Product",
        translatable: ["name", "description"],
        fields: [
          { key: "price", type: "number", label: "Price" },
          { key: "sku", type: "number", label: "SKU" },
          { key: "name", type: "text", label: "Name" },
          { key: "description", type: "longtext", label: "Description" },
        ],
      },
    ],
    runtime: "declarative",
  };
  const tpl = (body) => strToU8(`<!doctype html><html><head><title>{{page.title}}</title></head><body>${body}</body></html>`);
  return zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": tpl(`<h1>ESHOP-INDEX</h1><span class="locale">{{locale}}</span>`),
    "templates/page.html": tpl(`<h1 class="page-title">{{page.title}}</h1><span class="locale">{{locale}}</span>`),
    "templates/single.html": tpl(`<h1 class="single-title">{{post.title}}</h1>`),
    "templates/archive.html": tpl(`<h1>ESHOP-ARCHIVE</h1>`),
    "templates/404.html": tpl(`<h1>ESHOP-404</h1><span class="locale">{{locale}}</span>`),
    "langs/en.json": strToU8(JSON.stringify({ "theme.eshoptheme.title": "Shop" })),
    "langs/zh-CN.json": strToU8(JSON.stringify({ "theme.eshoptheme.title": "商店" })),
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
    console.error("Local D1 sqlite file not found.");
    process.exit(2);
  }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const env = makeEnv(sqlite);
  const worker = (await compileWorker()).default;

  const tableNames = () =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

  // -- idempotent cleanup -------------------------------------------------
  // Runs before anything else and covers every id prefix this suite can leave
  // behind, including the generated tables themselves — a leftover `_i18n`
  // table would make the "monolingual creates no _i18n table" assertion pass
  // for the wrong reason on the next run.
  const previousActive = sqlite.prepare("SELECT value FROM settings WHERE site_id='default' AND key='theme.active'").get()?.value ?? null;
  // Activating the suite's test theme below runs clear-then-insert over
  // several SITE-WIDE tables (theme_routes, admin_menu_registry). The harness
  // has no R2, so the real theme's manifest cannot be replayed afterwards —
  // snapshot what activation will destroy and put it back at the end.
  const previousRoutes = sqlite.prepare("SELECT * FROM theme_routes WHERE site_id='default'").all();
  const previousMenus = sqlite.prepare("SELECT * FROM admin_menu_registry WHERE site_id IN ('default','*')").all();
  // Same pattern for the language state: the lifecycle tests below need a
  // KNOWN locale set (en, then en+zh-CN), but a human may have added jp or fr
  // through the Languages screen. Snapshot, normalize, restore.
  const previousSiteLocales = sqlite.prepare("SELECT * FROM site_locales WHERE site_id='default'").all();
  const previousLocales = sqlite.prepare("SELECT * FROM locales").all();
  // The admin's *own* interface-language preference is a person's setting, not
  // suite state. Normalizing it below is unavoidable (the assertions read
  // English), but leaving it NULL means whoever was using this shared dev
  // database opens their admin in English afterwards and has no idea why — the
  // same side effect the browser acceptance script used to have. Snapshot it
  // with the rest of the state this suite touches and put it back at the end.
  const previousUiLangs = sqlite.prepare("SELECT id, ui_lang FROM site_users").all();
  sqlite.exec(`DROP TABLE IF EXISTS ${I18N_TABLE}`);
  sqlite.exec(`DROP TABLE IF EXISTS ${MAIN_TABLE}`);
  sqlite.exec(`DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_installs WHERE name='${THEME}'`);
  sqlite.exec(`DELETE FROM extension_versions WHERE extension_name='${THEME}'`);
  sqlite.exec("DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE slug LIKE 'i18n-%')");
  sqlite.exec("DELETE FROM posts WHERE slug LIKE 'i18n-%'");
  sqlite.exec("DELETE FROM scheduled_posts WHERE post_id NOT IN (SELECT id FROM posts)");
  // The i18n lifecycle below assumes the default site's locale set is exactly
  // what THIS suite manages (en, then en+zh-CN). Humans may have added other
  // languages through the admin (they live in this shared dev database), so
  // normalize first — every non-en row, not just codes we happen to know.
  sqlite.exec("DELETE FROM site_locales WHERE site_id='default' AND code <> 'en'");
  // Deleting the other rows can leave the site with NO default row (a human
  // may have made zh-CN the default before this run). Re-pin en as the default
  // so both this suite and whatever runs after it see a known state.
  sqlite.exec("UPDATE site_locales SET is_default=1, enabled=1, sort_order=0 WHERE site_id='default' AND code='en'");
  sqlite.exec("DELETE FROM locales WHERE code <> 'en'");
  sqlite.exec("DELETE FROM i18n_overrides WHERE site_id='default' AND key LIKE 'core.%'");
  // Reset the *preference*, never the account. This used to be
  // `DELETE FROM site_users WHERE ui_lang IS NOT NULL AND ui_lang <> 'en'`,
  // which is destructive on a database every suite shares: a run that left a
  // non-en preference behind (a failing section 7b does exactly that) deleted
  // `admin` — and `bootstrapAdmin` only fires on an *empty* table, so the
  // account never came back. Every later suite then crashed inside its login
  // helper with `undefined.split`, which the injection harness reports as
  // "no summary (aborted)" — a clean red translated into an unreadable one,
  // and a poisoned database for everything after it. NULL is the same clean
  // state (it resolves to the site default) without the collateral damage.
  sqlite.exec("UPDATE site_users SET ui_lang=NULL WHERE ui_lang IS NOT NULL AND ui_lang <> 'en'");
  sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='i18n.defaultLocale'");
  // `ui_locale_follow_site` lives in the same settings table (section 7b writes
  // it). Deleting by *prefix* rather than by the exact key is deliberate: a run
  // that crashed after turning it on would otherwise leave the next run
  // asserting against a menu narrowed by the previous one — a clean failure
  // translated into a confusing one (AGENTS.md, the third false-green note).
  // `cfpress.features` is the operator's own switch row, not a fixture: the
  // delete below (and this suite's writes to it) would otherwise reset every
  // feature they turned on. Snapshot it first and put it back in the teardown.
  const prevFeatureRows = sqlite.prepare("SELECT * FROM settings WHERE site_id='default' AND key LIKE 'cfpress.features%'").all();
  sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key LIKE 'cfpress.features%'");
  // Content created below through the editor API gets a random id and a
  // title-derived slug, so the `slug LIKE 'i18n-%'` sweeps above cannot see it.
  // Snapshot the surviving ids here; the teardown at the end deletes the
  // complement, which is what stops this suite leaving stray posts/pages on the
  // shared dev database (they showed up on the operator's content list).
  const postsBefore = sqlite.prepare("SELECT id FROM posts").all().map((r) => r.id);
  // Activating the test theme below rewrites the default site's capability rows
  // (field_defs / theme_routes / admin_menu_registry) and the derived
  // `theme_installs.active` column. Capture them now, after the sweep above, so
  // the teardown can restore the operator's real theme instead of leaving the
  // fixture's rows (or an "active" badge on nothing).
  const caps = snapshotCapabilities(sqlite);

  console.log("\n0. Admin bootstrap & auth");
  const loginRes = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  // Assert the status *before* reading the cookie. A missing session cookie
  // used to throw `undefined.split` right here, which ended the run before its
  // summary — and the injection harness reports a missing summary as "aborted",
  // i.e. the crash hid the very failure the suite exists to report. (AGENTS.md
  // §12: a suite that throws under injection has no summary, and no summary is
  // not a pass.) Reading the cookie defensively turns the same situation into a
  // clean red on this line plus a readable cascade.
  check("login", loginRes.status, 200);
  const cookie = String((loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")] ?? [])[0] ?? "").split(";")[0];
  const auth = { cookie, "Content-Type": "application/json" };

  // -- 1. L0: a fresh site is monolingual ---------------------------------
  console.log("\n1. L0 — site switch");
  const before = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("default locale is the site's own", before.default, "en");
  check("one language enabled", before.enabled.length, 1);
  check("not multilingual", before.multilingual, false);
  checkTruthy("core packs are offered for the interface", before.core_locales.includes("zh-CN"));

  // The bundled languages must also be offered **for the site**, not merely
  // known to the interface switcher. The Languages screen lists the `locales`
  // table, and a fresh install seeds that with `en` alone — so without
  // `core_entries` the panel titled "Platform dictionary — not enabled here"
  // was empty on every new deployment and the admin had to hand-type `zh-CN`
  // into the dialog, while the platform shipped a complete Chinese pack the
  // whole time. `core_locales` had shipped with no consumer at all, which is
  // exactly the "declared, never read" shape this suite exists to catch.
  const coreEntries = Array.isArray(before.core_entries) ? before.core_entries : [];
  const zhEntry = coreEntries.find((e) => e && e.code === "zh-CN");
  checkTruthy("bundled languages ship as rows for the Languages screen", !!zhEntry);
  check("with the name its own readers use", zhEntry && zhEntry.native_name, "简体中文");
  check("and the English name the admin list shows", zhEntry && zhEntry.name, "Simplified Chinese");
  // Two views of one list (`CORE_PACKS` vs `CORE_PACK_LOCALES`). Adding a pack
  // to one and not the other is invisible until someone wonders why the
  // switcher offers a language the Languages screen cannot.
  check(
    "core_entries and core_locales describe the same set",
    coreEntries.map((e) => e.code).sort(),
    [...before.core_locales].sort()
  );

  // -- 2. install + activate a theme that declares a business table --------
  console.log("\n2. Theme-owned table, monolingual");
  const form = new FormData();
  form.append("name", THEME);
  form.append("file", new Blob([buildEshopZip()], { type: "application/zip" }), `${THEME}.zip`);
  const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: { cookie }, body: form });
  check("theme uploads", up.status, 201);
  const act = await (await req(worker, env, `/api/v1/extensions/themes/${THEME}/activate`, { method: "POST", headers: auth })).json();
  check("theme activates", act.ok, true);
  check("declared table was generated", act.applied?.tables, 1);

  const names1 = tableNames();
  checkTruthy("main table exists", names1.includes(MAIN_TABLE));
  // ← the load-bearing assertion of the whole "platform switch" requirement
  check("no _i18n table while monolingual", names1.includes(I18N_TABLE), false);

  const tt1 = await (await req(worker, env, "/api/v1/theme-tables", { headers: auth })).json();
  // Scope to *this* theme's declarations. `theme-tables` is site-wide on
  // purpose (the registry survives deactivation, by design), so a sibling
  // suite that registers a table on the same site would otherwise show up
  // here — the assertion would then be measuring the D1's history instead of
  // this suite's behaviour. Filtering by theme keeps it just as strong (a
  // duplicate row for the same theme still fails) without the coupling.
  const mine = tt1.items.filter((d) => d.owner_type === "theme" && d.owner_name === THEME);
  check("table is registered", mine.map((d) => d.logical_name), ["product"]);
  check("registered without a translation table", mine[0].i18n_table, null);

  // Single-language write and read.
  const saved1 = await (await req(worker, env, "/api/v1/theme-tables/product", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "solo", price: 99, sku: "SOLO-1", name: "Solo", description: "Only one language" }),
  })).json();
  check("single-language save", saved1.ok, true);
  check("value stored", saved1.row.name, "Solo");
  const read1 = await (await req(worker, env, "/api/v1/theme-tables/product/solo?locale=zh-CN", { headers: auth })).json();
  // `zh-CN` is not even enabled yet; a single-language read ignores `locale`
  // entirely rather than returning nothing.
  check("single-language read ignores locale", read1.row.name, "Solo");
  check("non-translatable field round-trips", read1.row.price, 99);

  // -- 3. enabling a second language creates the translation table --------
  console.log("\n3. Enabling a second language");
  const en = await (await req(worker, env, "/api/v1/i18n/locales", {
    method: "POST", headers: auth,
    body: JSON.stringify({ code: "zh-CN", name: "Simplified Chinese", native_name: "简体中文" }),
  })).json();
  check("locale enabled", en.ok, true);
  // Same scoping reason as `table is registered` above: the switch walks
  // *every* table the site knows about, so this is a site-wide list and a
  // sibling suite's leftover declaration would appear in it. Filtering to our
  // own table keeps the assertion exactly as strong — it still fails if the
  // mechanism does not run, or runs twice for the same table — while making the
  // result independent of which suite ran before this one.
  check("the switch created the translation table",
    en.created_i18n_tables.filter((t) => t === I18N_TABLE), [I18N_TABLE]);

  checkTruthy("translation table now exists", tableNames().includes(I18N_TABLE));

  const after = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("site is multilingual now", after.multilingual, true);
  check("default unchanged by the new language", after.default, "en");
  check("both languages listed", after.enabled, ["en", "zh-CN"]);

  // -- 4. translatable vs non-translatable -------------------------------
  console.log("\n4. translatable decides what is language-dependent");
  await req(worker, env, "/api/v1/theme-tables/product?locale=en", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "iphone-15", price: 299, sku: "IP15", name: "iPhone 15", description: "A phone" }),
  });
  await req(worker, env, "/api/v1/theme-tables/product?locale=zh-CN", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "iphone-15", price: 299, sku: "IP15", name: "iPhone 15（中文）", description: "一部手机" }),
  });

  const enRow = await (await req(worker, env, "/api/v1/theme-tables/product/iphone-15?locale=en", { headers: auth })).json();
  const zhRow = await (await req(worker, env, "/api/v1/theme-tables/product/iphone-15?locale=zh-CN", { headers: auth })).json();

  check("same row, not two products", enRow.row.id, zhRow.row.id);
  // ← the two assertions this whole design exists for
  check("price is identical in both languages", zhRow.row.price, enRow.row.price);
  check("price is the declared value", enRow.row.price, 299);
  check("name differs per language", zhRow.row.name, "iPhone 15（中文）");
  check("english name is its own", enRow.row.name, "iPhone 15");
  check("description differs per language", zhRow.row.description, "一部手机");
  check("sku (non-translatable) is shared", zhRow.row.sku, enRow.row.sku);

  // -- 5. fallback: missing translation → site default, never empty -------
  console.log("\n5. Missing translation falls back");
  await req(worker, env, "/api/v1/theme-tables/product?locale=en", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "only-english", price: 10, name: "English only" }),
  });
  const fb = await (await req(worker, env, "/api/v1/theme-tables/product/only-english?locale=zh-CN", { headers: auth })).json();
  check("falls back to the site default language", fb.row.name, "English only");
  checkTruthy("row is not empty", !!fb.row.id);
  const listZh = await (await req(worker, env, "/api/v1/theme-tables/product?locale=zh-CN", { headers: auth })).json();
  check("listing does not error on untranslated rows", listZh.items.length, 3);

  // -- 6. URL semantics: explicit prefix 404s, unprefixed falls through ----
  console.log("\n6. URL semantics");
  await req(worker, env, "/api/v1/pages", {
    method: "POST", headers: auth,
    body: JSON.stringify({ slug: "i18n-zh-only", title: "只有中文", locale: "zh-CN", status: "published", content: "[]" }),
  });
  const zhPage = await req(worker, env, "/zh-CN/i18n-zh-only");
  check("explicit zh-CN finds the page", zhPage.status, 200);
  const enPage = await req(worker, env, "/en/i18n-zh-only");
  check("explicit /en/ misses → 404, no fallback", enPage.status, 404);
  const barePage = await req(worker, env, "/i18n-zh-only");
  check("unprefixed path falls through to another language", barePage.status, 200);

  // -- 7. UI language is independent of content language -------------------
  console.log("\n7. Interface language ≠ content language");
  const off = await (await req(worker, env, "/api/v1/i18n/locales/zh-CN", { method: "DELETE", headers: auth })).json();
  check("zh-CN disabled for the site", off.enabled, ["en"]);
  const afterOff = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("site is monolingual again", afterOff.multilingual, false);
  check("translation table is kept, not dropped", tableNames().includes(I18N_TABLE), true);

  // The site serves English only, yet its owner may still want a Chinese admin.
  const uiSet = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "zh-CN" }),
  })).json();
  check("admin interface language accepts a language the site does not serve", uiSet.locale, "zh-CN");
  const uiGet = await (await req(worker, env, "/api/v1/i18n/ui-locale", { headers: auth })).json();
  check("preference persists", uiGet.locale, "zh-CN");
  check("and is reported as a personal preference", uiGet.user_preference, "zh-CN");
  const badUi = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "xx-YY" }),
  })).json();
  checkTruthy("a completely unknown language is refused", badUi.error);

  // Adding a UI language is a DATA operation: registering a locale in the
  // platform dictionary (what the Languages screen does) makes it switchable
  // without any code change. Keys without a translation degrade to the
  // English fallback in the SPA (`t()` carries the English source). This is
  // the regression for "adding ja/fr must not require touching core-pack.ts".
  // The pure dictionary endpoint is used so the site's content languages stay
  // untouched (§9 counts entries per enabled locale).
  const fr = await (await req(worker, env, "/api/v1/i18n/dictionary", {
    method: "POST", headers: auth,
    body: JSON.stringify({ code: "fr", name: "French", native_name: "Français" }),
  })).json();
  check("registering a language in the platform dictionary works", fr.ok, true);
  const frUi = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "fr" }),
  })).json();
  check("a dictionary locale without a bundled pack is a UI language now", frUi.locale, "fr");
  const frMsgs = await (await req(worker, env, "/api/v1/i18n/messages?locale=fr", { headers: auth })).json();
  const frEntry = (Array.isArray(frMsgs.ui_locales) ? frMsgs.ui_locales : []).find((l) => l && l.code === "fr");
  check("ui_locales ships the data-driven language with its native name", frEntry && frEntry.name, "Français");
  const frReset = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "en" }),
  })).json();
  check("switch back to en after the fr probe", frReset.locale, "en");

  // -- 7b. the opt-in that ties the menu to the site ----------------------
  // Section 7 just asserted the *default*: disabling a site language does not
  // take it out of the admin's language menu. `ui_locale_follow_site` is the
  // operator's opt-in for the opposite behaviour — and because the switcher
  // list and the validation set are one definition, turning it on must narrow
  // both at once. A filter in the SPA would leave the server accepting a
  // language the menu no longer shows, so the refusal is asserted, not just
  // the shorter menu.
  console.log("\n7b. ui_locale_follow_site narrows the menu to the site");
  const swOff = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  checkTruthy("off by default: the menu still offers zh-CN", swOff.ui_locales.includes("zh-CN"));

  await req(worker, env, "/api/v1/features", {
    method: "POST", headers: auth,
    body: JSON.stringify({ key: "ui_locale_follow_site", value: true }),
  });
  const swOn = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  check("on: the menu lists the site's languages only", swOn.ui_locales, ["en"]);
  const msgsOn = await (await req(worker, env, "/api/v1/i18n/messages", { headers: auth })).json();
  check("the switcher list follows the same definition", (msgsOn.ui_locales ?? []).map((l) => l.code), ["en"]);
  const refusedUi = await (await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "zh-CN" }),
  })).json();
  checkTruthy("and the server refuses what the menu no longer offers", refusedUi.error);
  // Leave it inherited (off) for everything that runs after this suite.
  await req(worker, env, "/api/v1/features", {
    method: "POST", headers: auth,
    body: JSON.stringify({ key: "ui_locale_follow_site", value: null }),
  });
  // And put the preference back regardless of how the assertions above went.
  // When the switch is *not* honoured (the injected defect), the POST above
  // succeeds instead of being refused and leaves `ui_lang='zh-CN'` behind — the
  // exact state that used to make the next run's cleanup delete `admin`. This
  // line is what makes the section safe to fail.
  await req(worker, env, "/api/v1/i18n/ui-locale", {
    method: "POST", headers: auth, body: JSON.stringify({ locale: "en" }),
  });
  const swBack = await (await req(worker, env, "/api/v1/i18n/locales", { headers: auth })).json();
  checkTruthy("resetting to inherited restores the full menu", swBack.ui_locales.includes("zh-CN"));

  // -- 8. L2 dictionary stack --------------------------------------------
  console.log("\n8. L2 dictionary layers");
  const zhMsgs = await (await req(worker, env, "/api/v1/i18n/messages?locale=zh-CN", { headers: auth })).json();
  check("core pack translates", zhMsgs.messages["core.nav.dashboard"], "仪表盘");
  check("theme pack is layered on top", zhMsgs.messages["theme.eshoptheme.title"], "商店");
  const enMsgs = await (await req(worker, env, "/api/v1/i18n/messages?locale=en", { headers: auth })).json();
  check("english core pack", enMsgs.messages["core.nav.dashboard"], "Dashboard");
  check("english theme pack", enMsgs.messages["theme.eshoptheme.title"], "Shop");

  await req(worker, env, "/api/v1/i18n/overrides", {
    method: "POST", headers: auth,
    body: JSON.stringify({ locale: "en", key: "core.action.save", value: "Save it now" }),
  });
  const overridden = await (await req(worker, env, "/api/v1/i18n/messages?locale=en", { headers: auth })).json();
  check("DB override wins over the core pack", overridden.messages["core.action.save"], "Save it now");
  const unnamespaced = await (await req(worker, env, "/api/v1/i18n/overrides", {
    method: "POST", headers: auth,
    body: JSON.stringify({ locale: "en", key: "nav.home", value: "Home" }),
  })).json();
  checkTruthy("an unnamespaced override key is refused", unnamespaced.error);

  // -- 9. translation groups (L1) ----------------------------------------
  console.log("\n9. Content translation groups");
  // Re-enable zh-CN so the group can hold both versions.
  await req(worker, env, "/api/v1/i18n/locales", {
    method: "POST", headers: auth, body: JSON.stringify({ code: "zh-CN", name: "Simplified Chinese", native_name: "简体中文" }),
  });
  const srcId = String(sqlite.prepare("SELECT id FROM posts WHERE slug='i18n-zh-only' AND site_id='default'").get().id);
  const group0 = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(srcId), { headers: auth })).json();
  // One entry per *enabled locale*, not per existing row: the editor's language
  // bar has to offer the versions that do not exist yet — that is the `＋`.
  check("one entry per enabled locale", group0.versions.map((v) => v.locale).sort(), ["en", "zh-CN"]);
  check("the zh-CN version exists", group0.versions.find((v) => v.locale === "zh-CN").exists, true);
  check("the en version does not exist yet", group0.versions.find((v) => v.locale === "en").exists, false);

  const made = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: srcId, locale: "en", mode: "copy" }),
  })).json();
  check("translation created", made.locale, "en");
  checkTruthy("new post got its own id", made.id !== srcId);
  const dup = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: srcId, locale: "en", mode: "blank" }),
  })).json();
  checkTruthy("creating the same locale twice is refused", dup.error);

  const group1 = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(srcId), { headers: auth })).json();
  check("both versions now exist", group1.versions.filter((v) => v.exists).map((v) => v.locale).sort(), ["en", "zh-CN"]);
  check("they share one group", group1.group, group0.group);
  check("copied translation starts as a draft", group1.versions.find((v) => v.locale === "en").status, "draft");
  // Slugs are per language (migration 0016): the new version follows the
  // source slug because /en/blog/x and /zh-CN/blog/x may share a segment.
  // Uniqueness is enforced per locale on the write paths, not globally.
  checkTruthy("copied translation follows the source slug", group1.versions.find((v) => v.locale === "en").slug === "i18n-zh-only");

  // -- 9b. a self-naming group survives a NULL lang_group -----------------
  // `lang_group` is nullable. A row that has none identifies its group by its
  // own id — and *both* sides of the lookup have to use that same rule. Matching
  // `lang_group = ?` on its own excluded the very row whose id named the group,
  // so the group looked empty: the editor reported the language as missing and
  // offered to create a duplicate of a version that already existed. Any row
  // written before the migration, or by an import that omits the column, lands
  // exactly here.
  console.log("\n9b. A row with no lang_group is still in its own group");
  const soloTs = Math.floor(Date.now() / 1000);
  const soloId = `i18n-solo-${soloTs}`;
  const anyUser = String(sqlite.prepare("SELECT id FROM site_users LIMIT 1").get()?.id ?? "u1");
  sqlite
    .prepare("INSERT INTO posts(id,site_id,author_id,type,slug,status,lang_group,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(soloId, "default", anyUser, "post", "i18n-solo", "draft", null, soloTs, soloTs);
  sqlite
    .prepare("INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(`pt-${soloId}`, soloId, "zh-CN", "Solo", "", "[]", soloTs, soloTs);

  const solo = await (await req(worker, env, "/api/v1/i18n/translations?id=" + encodeURIComponent(soloId), { headers: auth })).json();
  check("a row with no lang_group names its own group", solo.group, soloId);
  const selfEntry = (solo.versions ?? []).find((v) => v.locale === "zh-CN");
  check("that row is found inside its own group", selfEntry?.exists, true);
  check("its own id comes back as the version's post", selfEntry?.post_id, soloId);
  const dupSelf = await (await req(worker, env, "/api/v1/i18n/translations", {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: soloId, locale: "zh-CN", mode: "blank" }),
  })).json();
  checkTruthy("a second zh-CN version of it is refused", dupSelf.error);

  // -- restore ------------------------------------------------------------
  // Leave the default site's theme as this suite found it, so the suite is
  // order-independent with respect to the rest of the chain.
  //
  // KNOWN GAP: activating eshoptheme above also cleared the previous theme's
  // rows in admin_menu_registry (clear-then-insert), and they cannot be
  // re-inserted here — the previous theme's manifest lives in R2, which this
  // harness does not have. The setting row below makes the FRONT END render
  // the right theme again; the ADMIN menu rows are re-declared by whoever
  // needs them (the browser acceptance script re-activates eshop on boot).
  // Restore the exact locale state this suite found (a human's jp/fr, the
  // default language choice) instead of guessing what "clean" means.
  sqlite.exec("DELETE FROM site_locales WHERE site_id='default'");
  const insSiteLocale = sqlite.prepare(
    "INSERT INTO site_locales (site_id,code,is_default,enabled,sort_order) VALUES (?,?,?,?,?)"
  );
  for (const l of previousSiteLocales) insSiteLocale.run(l.site_id, l.code, l.is_default, l.enabled, l.sort_order);
  sqlite.exec("DELETE FROM locales");
  const insLocale = sqlite.prepare(
    "INSERT INTO locales (code,name,is_default,native_name,direction,enabled,sort_order) VALUES (?,?,?,?,?,?,?)"
  );
  for (const l of previousLocales) {
    insLocale.run(l.code, l.name, l.is_default ?? 0, l.native_name ?? null, l.direction ?? "ltr", l.enabled ?? 1, l.sort_order ?? 0);
  }
  sqlite.exec("DELETE FROM i18n_overrides WHERE site_id='default' AND key='core.action.save'");
  // Put the operator's interface language back. Only rows that existed at the
  // start are touched — a user created during the run keeps whatever it has.
  const setUiLang = sqlite.prepare("UPDATE site_users SET ui_lang=? WHERE id=?");
  for (const u of previousUiLangs) setUiLang.run(u.ui_lang ?? null, u.id);
  if (previousActive) {
    sqlite.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value")
      .run("setting-theme-active", "default", "theme.active", previousActive);
  }
  // Restore the front-end routes and admin menu rows that activating
  // eshoptheme destroyed (the activate flow clear-then-inserts both tables).
  // Without this the real theme's front-end URLs 404 and its admin menu rows
  // are gone until something re-declares them.
  sqlite.exec("DELETE FROM theme_routes WHERE site_id='default'");
  const insRoute = sqlite.prepare(
    "INSERT INTO theme_routes (id,site_id,path,template,query_json,resolve_json,sort_order,declared_by_theme,created_at,updated_at,title) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const r of previousRoutes) {
    insRoute.run(r.id, r.site_id, r.path, r.template, r.query_json ?? "{}", r.resolve_json ?? null,
      r.sort_order ?? 0, r.declared_by_theme ?? null, r.created_at, r.updated_at, r.title ?? null);
  }
  sqlite.exec("DELETE FROM admin_menu_registry WHERE site_id IN ('default','*')");
  const insMenu = sqlite.prepare(
    "INSERT INTO admin_menu_registry (id,site_id,owner_type,owner_name,menu_id,label,icon,screen,args_json,capability,sort_order,enabled,created_at,updated_at,label_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const m of previousMenus) {
    insMenu.run(m.id, m.site_id, m.owner_type, m.owner_name, m.menu_id, m.label, m.icon ?? null,
      m.screen, m.args_json ?? "{}", m.capability ?? null, m.sort_order ?? 0, m.enabled ?? 1,
      m.created_at, m.updated_at, m.label_key ?? null);
  }

  // -- teardown: leave the shared dev D1 as we found it ---------------------
  // The start block above only removes the *previous* run's copy of the test
  // theme; without this second pass the theme, its generated tables and every
  // post created below stay behind — a phantom theme on the Themes screen and
  // stray entries on the content list until the next run happens to sweep them.
  sqlite.exec(`DROP TABLE IF EXISTS ${I18N_TABLE}`);
  sqlite.exec(`DROP TABLE IF EXISTS ${MAIN_TABLE}`);
  sqlite.exec(`DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_settings WHERE theme_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_setting_defs WHERE theme_name='${THEME}'`);
  sqlite.exec(`DELETE FROM theme_installs WHERE name='${THEME}'`);
  sqlite.exec(`DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name='${THEME}'`);
  sqlite.exec(`DELETE FROM extension_versions WHERE extension_name='${THEME}'`);
  {
    // Delete the posts this run created, by id-complement against the snapshot
    // (children first, so nothing is orphaned). The empty-snapshot case needs its
    // own branch: `WHERE id NOT IN (NULL)` is UNKNOWN in SQL, not TRUE, so it
    // deletes *nothing* — a silent no-op that looks exactly like a working sweep.
    const children = ["post_meta", "post_revisions", "post_translations"];
    if (postsBefore.length) {
      const ph = postsBefore.map(() => "?").join(",");
      const survivors = `SELECT id FROM posts WHERE id IN (${ph})`;
      for (const child of children) {
        sqlite.prepare(`DELETE FROM ${child} WHERE post_id NOT IN (${survivors})`).run(...postsBefore);
      }
      sqlite.prepare(`DELETE FROM posts WHERE id NOT IN (${ph})`).run(...postsBefore);
    } else {
      for (const child of children) sqlite.exec(`DELETE FROM ${child}`);
      sqlite.exec("DELETE FROM posts");
    }
    sqlite.exec("DELETE FROM scheduled_posts WHERE post_id NOT IN (SELECT id FROM posts)");
  }
  // Put the operator's feature switches and the default theme's capability rows
  // back (see the snapshots above). Without this the editor loses its custom
  // fields, the front-end routes 404 and the Themes screen shows the wrong theme
  // as active — silently, until something re-activates the theme by hand.
  sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key LIKE 'cfpress.features%'");
  for (const r of prevFeatureRows) {
    const keys = Object.keys(r);
    try {
      sqlite.prepare(`INSERT INTO settings (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => r[k]));
    } catch { /* ok */ }
  }
  restoreCapabilities(sqlite, caps);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  // The `${pass} passed, ${fail} failed` line above is the only summary. This
  // suite used to also print `${fail ? 1 : 0} failure(s)` — two summaries in two
  // spellings, which is how a grep-based checker reads the wrong one and misses
  // a failure (AGENTS.md "false green" type 6).
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
