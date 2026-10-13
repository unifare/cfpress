/**
 * Schema scope guard: does every real table have an answer for tenant and
 * language? (§10 rules 41–44)
 *
 * ## What this proves, and why it is not a source-level check
 *
 * The classification lives in `contract/schema.ts`. This guard does **not**
 * read it and call it correct — that would prove nothing. It opens the **actual
 * SQLite file** the Worker uses, walks `PRAGMA table_info` for every table, and
 * checks each one against the declaration. A table that exists in the database
 * but was never classified fails; a table declared tenant-scoped without a real
 * `site_id` column fails; a sidecar table with a `site_id` column fails
 * (that would be a schema change someone made while believing it was needed).
 *
 * The distinction matters because the failure mode is silent. Reading the
 * declaration only tells you what someone *believed*; reading the database
 * tells you what is *there*. `media_files` is the worked example: it was
 * declared with `site_id`, inserted with `site_id`, and disabled for two
 * batches because migration 0003 never created the column — a mismatch no
 * amount of reading the TypeScript would reveal.
 *
 * ## Why it runs against migrations, not the live dev database
 *
 * `.wrangler/` is a local artifact: absent on CI, stale on a fresh checkout,
 * and mutated by every test suite. A guard that only passes on a machine with a
 * warm dev database is not a guard. So this applies the `migrations/*.sql`
 * stream to a **throwaway SQLite file in a temp directory**, then walks that.
 * Same schema the Worker gets, deterministic, and safe to run anywhere.
 *
 * Usage: node tests/tools/_schema-scope.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  DERIVED_TENANT_TABLES,
  isGeneratedBusinessTable,
  isI18nTable,
  LOCALE_COLUMN,
  PLATFORM_SCHEMA,
  RUNTIME_TABLES,
  TENANT_COLUMN,
} from "../../src/extensions/contract/schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href);

/**
 * A D1-shaped shim over the real SQLite file.
 *
 * Deliberately minimal — only the methods `syncOwnerTables` actually calls — so
 * the guard drives the **real** DDL generator rather than re-declaring the
 * shape of a generated table in the test. A test that spells out
 * `id TEXT PRIMARY KEY, site_id TEXT NOT NULL, …` would agree with itself
 * forever while the generator drifted away from it.
 */
function d1(db) {
  /** Positional `?` binding, as D1 uses. */
  const bindArgs = (sql, args) => {
    let i = 0;
    return sql.replace(/\?/g, () => {
      const v = args[i++];
      if (v === null || v === undefined) return "NULL";
      if (typeof v === "number") return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    });
  };
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { db.exec(bindArgs(sql, args)); return { success: true }; },
        async first() { return db.prepare(bindArgs(sql, args)).get() ?? null; },
        async all() { return { results: db.prepare(bindArgs(sql, args)).all() }; },
      };
      return api;
    },
  };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function section(t) { console.log(`\n${t}`); }

/**
 * Emit the summary line, and exit non-zero on failure.
 *
 * ⚠️ Every path out of this file must call this — including the crash path.
 * The sixth false-green (AGENTS.md) was a suite whose summary lived at the end
 * of `main()`, so a throw anywhere above it produced *no output at all* while
 * the reader saw "nothing failed". `aborted` is passed when an exception
 * unwound past the end of the walk, and counts as one extra failure so the
 * exit code cannot be zero on a crash.
 */
function summary(tag = "", extraFailures = 0) {
  const total = fail + extraFailures;
  console.log(`\n${pass} passed, ${total} failed${tag}`);
  if (failures.length) console.log(`failed: ${failures.join(", ")}`);
  process.exit(total > 0 ? 1 : 0);
}

process.on("uncaughtException", (e) => {
  console.error("\nSUITE ERROR:", (e && e.stack) || e);
  summary(" (aborted)", 1);
});
process.on("unhandledRejection", (e) => {
  console.error("\nSUITE ERROR (unhandled rejection):", (e && e.stack) || e);
  summary(" (aborted)", 1);
});

/**
 * Bundle `tables.ts` so the real generator can be called from Node.
 *
 * The source uses extensionless TS imports (`../../shared/types`), which Node's
 * ESM resolver rejects. esbuild is already a dev dependency and is how every
 * other suite reaches Worker source, so this stays consistent with the repo.
 */
async function loadTablesModule() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(ROOT, "src/extensions/theme/tables.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(ROOT, ".wrangler", "schema-scope-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

// ---------------------------------------------------------------------------
section("0. Build a database from the migration stream");
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "cfpress-schema-"));
const dbPath = join(tmp, "schema.sqlite");
let db;
try {
  db = new DatabaseSync(dbPath);
  const files = readdirSync(join(ROOT, "content", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let applied = 0;
  for (const f of files) {
    const sql = readFileSync(join(ROOT, "content", "migrations", f), "utf8");
    // Strip `--` comments so a semicolon inside prose cannot split a statement.
    const stripped = sql.replace(/--[^\n]*/g, "");
    for (const stmt of stripped.split(";")) {
      const s = stmt.trim();
      if (!s) continue;
      try { db.exec(s); applied++; }
      catch (e) {
        // Migration streams are written to tolerate re-application; a failure
        // here means this guard cannot see the real schema, which is a hard
        // error rather than something to skip past.
        console.log(`  FAIL migration ${f} statement failed: ${e.message}`);
        console.log(`       >>> ${s.slice(0, 160)}`);
        fail++; failures.push(`migration ${f}`);
      }
    }
  }
  check("every migration applied", fail === 0, true);
  console.log(`  (${files.length} files, ${applied} statements)`);

  // -- 1b. materialise generated table pairs --------------------------------
  //
  // Generated business tables are created at RUNTIME by `syncOwnerTables`, not
  // by the migration stream — so a migration-only walk sees none of them, and
  // every assertion about their shape would be vacuously true. (That is exactly
  // what the non-vacuity check below caught on the first run.)
  //
  // So drive the real generator against this database. The declaration below is
  // deliberately mixed: prose fields that must be translatable, language-neutral
  // ones that must not be, proving the guard sees both kinds of column.
  section("0b. Materialise generated table pairs through the real generator");

  const { syncOwnerTables } = await loadTablesModule();
  const shim = d1(db);
  // `isMultilingual` reads site_locales; enabling a second language is what
  // makes the generator create the `_i18n` sidecar at all.
  db.exec(`INSERT OR REPLACE INTO sites(id,name,host,is_default,status,created_at,updated_at)
           VALUES('default','Default','',1,'active',0,0)`);
  db.exec(`INSERT OR REPLACE INTO locales(code,name,is_default,enabled,sort_order)
           VALUES('en','English',1,1,0),('zh-CN','Chinese',0,1,1)`);
  db.exec(`INSERT OR REPLACE INTO site_locales(site_id,code,is_default,enabled,sort_order)
           VALUES('default','en',1,1,0),('default','zh-CN',0,1,1)`);

  const probeManifest = {
    name: "scopeprobe",
    tables: [{
      name: "item",
      label: "Item",
      translatable: ["title", "body"],
      fields: [
        { key: "title", type: "text" },
        { key: "body", type: "longtext" },
        { key: "price", type: "number" },
        { key: "active", type: "boolean" },
      ],
    }],
  };
  let syncErr = null;
  let synced = [];
  try {
    synced = await syncOwnerTables({ DB: shim }, "theme", "scopeprobe", probeManifest, "default");
  } catch (e) {
    syncErr = e?.message ?? String(e);
  }
  check("the real table generator ran without error", syncErr, null);
  check("it created the business table", synced.map((r) => r.table), ["theme_scopeprobe_item"]);
  check("it created the i18n sidecar (site serves 2 languages)", synced.map((r) => r.i18nTable), ["theme_scopeprobe_item_i18n"]);

  // A recorded sidecar whose table is gone must be repaired, not trusted.
  //
  // `i18n_table` is deliberately sticky (`COALESCE` keeps the name when a later
  // sync is monolingual, so disabling a language hides the translations rather
  // than re-seeding them). That makes it a claim which can outlive its table —
  // a fixture that drops generated tables, or an operator tidying up by hand —
  // and the facade trusts the column, so the failure surfaces as
  // `no such table: …_i18n` on the first write. That is exactly how this was
  // found (the menu acceptance script's fixture).
  db.exec("DROP TABLE theme_scopeprobe_item_i18n");
  const gone = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='theme_scopeprobe_item_i18n'").get();
  check("the sidecar really is gone before the repair (non-vacuity)", gone.n, 0);

  let repairErr = null;
  try {
    await syncOwnerTables({ DB: shim }, "theme", "scopeprobe", probeManifest, "default");
  } catch (e) {
    repairErr = e?.message ?? String(e);
  }
  check("re-syncing after the sidecar vanished does not throw", repairErr, null);
  const repaired = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='theme_scopeprobe_item_i18n'").get();
  check("and the sidecar the registry names is back", repaired.n, 1);

  // The general invariant, stated once: every recorded sidecar exists. A row
  // naming a table that is not there is the state the facade cannot survive.
  const recorded = db.prepare("SELECT i18n_table FROM theme_table_defs WHERE i18n_table IS NOT NULL").all();
  const missingSidecars = recorded
    .map((r) => r.i18n_table)
    .filter((name) => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n === 0);
  check("every recorded i18n_table exists in the database", missingSidecars, []);
  check("and the check had something to look at (non-vacuity)", recorded.length > 0, true);

  // The same *logical* name under a plugin owner must NOT resolve to the theme's
  // table. This is the whole reason `owner_type` is in the physical prefix, and
  // the assertion is on distinct physical names — a guard that only checked
  // "both sync calls returned without error" would pass while they shared a table.
  let pluginSynced = [];
  let pluginSyncErr = null;
  try {
    pluginSynced = await syncOwnerTables({ DB: shim }, "plugin", "scopeprobe", probeManifest, "default");
  } catch (e) {
    pluginSyncErr = e?.message ?? String(e);
  }
  check("a plugin owner with the same name also syncs", pluginSyncErr, null);
  check("its table is namespaced by owner type", pluginSynced.map((r) => r.table), ["plugin_scopeprobe_item"]);
  check(
    "theme and plugin tables of the same logical name are different tables",
    synced[0].table !== pluginSynced[0].table,
    true
  );
  const registryOwners = db
    .prepare("SELECT owner_type, table_name FROM theme_table_defs ORDER BY owner_type")
    .all()
    .map((r) => `${r.owner_type}:${r.table_name}`);
  check(
    "the registry records both owners separately",
    registryOwners,
    ["plugin:plugin_scopeprobe_item", "theme:theme_scopeprobe_item"]
  );

  // -- 1. walk the real schema ---------------------------------------------
  section("1. Walk every table in the real database");

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  const columnsOf = (t) =>
    db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

  check("the database has tables at all", tables.length > 0, true);
  console.log(`  (${tables.length} tables)`);

  // A generated table cannot be classified by name alone — `theme_installs`
  // matches the prefix but is a platform registry table. `isGeneratedBusinessTable`
  // is the discriminator, and it consults the declaration rather than the name.
  const generated = tables.filter((t) => isGeneratedBusinessTable(t));
  const generatedI18n = tables.filter((t) => isI18nTable(t));

  // Non-vacuity: if the migration stream were ever trimmed to exclude the
  // example theme's tables, every per-table assertion below would go quiet and
  // the suite would report success while checking almost nothing.
  check(
    "the walk actually saw generated tables (non-vacuity)",
    generated.length > 0,
    true
  );
  console.log(`  (${generated.length} generated business tables, ${generatedI18n.length} sidecars)`);

  // -- 2. every table must be classified -----------------------------------
  section("2. Every table is classified (tenant + language)");

  const declared = new Set(PLATFORM_SCHEMA.map((t) => t.table));
  const runtime = new Set(RUNTIME_TABLES);

  const unclassified = tables.filter(
    (t) =>
      !declared.has(t) &&
      !runtime.has(t) &&
      !isGeneratedBusinessTable(t) &&
      !isI18nTable(t)
  );

  check(
    "no table is missing from the schema declaration",
    unclassified,
    []
  );
  if (unclassified.length) {
    console.log(
      `       Add each to PLATFORM_SCHEMA in src/extensions/contract/schema.ts,\n` +
      `       stating whether it is tenant-scoped and how it expresses language.\n` +
      `       A new table with no answer is how multi-site leaks start.`
    );
  }

  // -- 3. the tenant rule holds in the real schema --------------------------
  section("3. Tenant scope matches the real columns");

  const tenantMissing = [];
  for (const t of PLATFORM_SCHEMA) {
    if (t.tenant !== "site") continue;
    if (!tables.includes(t.table)) continue;
    if (!columnsOf(t.table).includes(TENANT_COLUMN)) tenantMissing.push(t.table);
  }
  check(
    "every tenant-scoped table has a site_id column",
    tenantMissing,
    []
  );

  const platformHasSite = [];
  for (const t of PLATFORM_SCHEMA) {
    if (t.tenant !== "platform") continue;
    if (!tables.includes(t.table)) continue;
    if (columnsOf(t.table).includes(TENANT_COLUMN)) platformHasSite.push(t.table);
  }
  check(
    "no platform-global table carries a site_id column",
    platformHasSite,
    []
  );

  // -- 4. the language rule holds in the real schema ------------------------
  section("4. Language scope matches the real columns");

  const localeMissing = [];
  for (const t of PLATFORM_SCHEMA) {
    if (!t.locale || t.locale.kind !== "column") continue;
    if (!tables.includes(t.table)) continue;
    if (!columnsOf(t.table).includes(LOCALE_COLUMN)) localeMissing.push(t.table);
  }
  check(
    "every table declared per-language has a locale column",
    localeMissing,
    []
  );

  // -- 5. generated tables obey the shape rules -----------------------------
  section("5. Generated business tables: site_id required, sidecars exempt");

  const genMissingSite = [];
  for (const t of generated) {
    if (!columnsOf(t).includes(TENANT_COLUMN)) genMissingSite.push(t);
  }
  check(
    "every generated business table has a site_id column",
    genMissingSite,
    []
  );

  // A sidecar has no site_id BY DESIGN (its scope comes from `row_id`), so a
  // sidecar that HAS one is a schema mistake, not a safety improvement —
  // exactly the mistake H1's first fix attempt made in the review.
  const sidecarWithSite = [];
  for (const t of generatedI18n) {
    if (columnsOf(t).includes(TENANT_COLUMN)) sidecarWithSite.push(t);
  }
  check(
    "no _i18n sidecar carries a site_id column (scope is inherited)",
    sidecarWithSite,
    []
  );

  const sidecarNoLocale = [];
  for (const t of generatedI18n) {
    const cols = columnsOf(t);
    if (!cols.includes(LOCALE_COLUMN) || !cols.includes("row_id")) sidecarNoLocale.push(t);
  }
  check(
    "every _i18n sidecar is keyed by (row_id, locale)",
    sidecarNoLocale,
    []
  );

  // -- 6. the declaration has no phantom entries ----------------------------
  section("6. The declaration has no entries for tables that do not exist");

  const phantom = PLATFORM_SCHEMA
    .map((t) => t.table)
    .filter((t) => !tables.includes(t));
  check(
    "every declared table really exists in the schema",
    phantom,
    []
  );

  // -- 7. reasons are mandatory ---------------------------------------------
  section("7. Every classification carries its reason");

  const noNote = PLATFORM_SCHEMA
    .filter((t) => !t.note || String(t.note).trim().length < 10)
    .map((t) => t.table);
  check(
    "every entry explains itself (>=10 chars)",
    noNote,
    []
  );

  // Derived-tenant entries must name the FK they inherit through, or the
  // classification is a guess dressed up as a fact.
  const badDerived = PLATFORM_SCHEMA
    .filter((t) => "derivedTenant" in t && t.derivedTenant)
    .filter((t) => !/→/.test(String(t.derivedTenant)))
    .map((t) => t.table);
  check(
    "every derived-tenant entry names its FK path",
    badDerived,
    []
  );
  check(
    "derived-tenant set is the one the walk expects",
    [...DERIVED_TENANT_TABLES].sort(),
    PLATFORM_SCHEMA.filter((t) => "derivedTenant" in t && t.derivedTenant).map((t) => t.table).sort()
  );
} finally {
  try { db?.close(); } catch { /* already closed */ }
  // Cleanup is verified, not assumed: on Windows `rmSync` can fail with EBUSY
  // and `force:true` swallows it, leaving a stale directory that the next run
  // silently reuses (see AGENTS.md, fifth false-green).
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(tmp)) {
    console.log(`  FAIL could not clean up scratch dir: ${tmp}`);
    fail++; failures.push("scratch cleanup");
  }
}

summary();
