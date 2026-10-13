/**
 * Guard: a suite must leave the shared local D1 exactly as it found it.
 *
 * ## Why this exists
 *
 * The suites run against the *same* sqlite file `wrangler dev` serves (see
 * AGENTS.md), so anything a suite leaves behind is visible in the admin UI of
 * the local site: a phantom theme on the Themes screen, a phantom site on the
 * Sites screen, stray posts on the content list. For a long time every suite
 * cleaned up only *up front* ("clear anything a previous run left behind"),
 * which made the residue permanent between runs — the operator saw the junk
 * after every `npm test` until the *next* run happened to remove it.
 *
 * The suites that leaked were fixed. But a fix is not a guard: the next suite
 * someone adds will leak again, and nothing would say so — and a cleanup step
 * that nobody checks is exactly the kind of human discipline this repo keeps
 * getting bitten by (§12). This tool is the guard.
 *
 * ## What it checks
 *
 * Snapshot the shared D1 → run the suite in a worker thread → snapshot again.
 * The suite must (a) print a clean summary and (b) have added **no row** to any
 * table that surfaces in the admin. Rows are compared by **full content**, not
 * by name: a leaked row carries a fresh `installed_at`, so it is caught even
 * when a same-named leftover was already present — the case a name-only diff
 * would silently pass.
 *
 * A suite that *removes* rows is reported as a warning rather than a failure:
 * a clean baseline should net to zero, but a database that already held
 * leftovers from an older run will show them as removals when the suite sweeps
 * them, and that is not the suite's fault. The baseline junk count is printed
 * up front so a dirty start is visible instead of silently weakening the run.
 *
 * ## Why it is not in `npm test`
 *
 * It is a tool, not a suite: it runs the suites (worker threads, ~10–30 s
 * each). Same category as `_skeleton-inject.mjs`.
 *
 * ⚠️ Reverse-validate it whenever you touch it: comment out one suite's
 * teardown and confirm this tool names that suite and the row it leaked.
 *
 * ⚠️ Stop `wrangler dev` first: it holds the sqlite file, and the guard's
 * snapshots then fail with "database is locked".
 *
 * Usage:
 *   node tests/tools/_residue-guard.mjs                 # every suite that touches the shared D1
 *   node tests/tools/_residue-guard.mjs account i18n    # a subset, by suite name
 */
import { existsSync, readdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The suites that open the shared local D1. Kept as an explicit list (not a
 * glob) because a suite that stops touching the database would otherwise be
 * "verified" for free — and a suite that *starts* touching it must be added
 * here deliberately. `tests/suites/launcher-parity.test.mjs` enforces that
 * every name below exists on disk.
 */
const SHARED_D1_SUITES = [
  "account",
  "admin-contract",
  "admin-menus",
  "features",
  "i18n",
  "locale-url",
  "media",
  "menu-custom",
  "multisite",
  "plugin-channels",
  "plugin-hooks",
  "plugin-pages",
  "theme-integration",
  "theme-worker",
];

/**
 * Tables whose *added* rows mean a phantom entry somewhere in the admin, or
 * content the operator never created. Everything else is either audit history
 * (which is expected to grow) or internal bookkeeping.
 */
const WATCHED = new Set([
  "sites", "locales", "site_locales", "settings",
  "menus", "menu_items",
  "posts", "post_meta", "post_translations", "post_revisions",
  "post_types", "taxonomies", "terms", "term_relationships", "field_defs",
  "theme_installs", "theme_routes", "theme_blocks", "theme_table_defs",
  "theme_settings", "theme_setting_defs",
  "extension_capabilities", "extension_versions",
  "plugin_installs", "plugin_settings", "plugin_setting_defs",
  "admin_menu_registry", "widget_instances",
  "i18n_overrides", "redirects", "rewrites", "media_files", "seo_meta", "shortcodes",
  "site_users",
]);

/**
 * Deliberately not watched, and why — so the omission is a decision, not an
 * oversight:
 *   admin_activity, admin_sessions  — audit history; every login grows them.
 *   content_cache_versions          — internal cache epochs, never shown.
 *   post_autosaves, scheduled_posts — transient editor state.
 *   sqlite_sequence, _cf_*          — SQLite / miniflare internals.
 */
const IGNORED = new Set([
  "admin_activity", "admin_sessions", "content_cache_versions",
  "post_autosaves", "scheduled_posts", "sqlite_sequence",
]);

const isIgnored = (t) => IGNORED.has(t) || t.startsWith("_cf_") || t.startsWith("sqlite_");

/**
 * Tables that *look* generated (`<prefix>_<owner>_<logical>`) but are part of
 * the platform schema. Without this list a plain `theme\_%\_%` LIKE would call
 * `plugin_setting_defs` a generated table — two underscores is not evidence.
 * The generated ones are `theme_<theme>_<table>` / `plugin_<plugin>_<table>`
 * from a manifest, so anything *not* listed here and matching the shape is a
 * manifest-owned table that must not survive an uninstall.
 */
const STATIC_PREFIXED = new Set([
  "theme_installs", "theme_routes", "theme_blocks", "theme_table_defs",
  "theme_settings", "theme_setting_defs", "theme_admin_menus",
  "plugin_installs", "plugin_settings", "plugin_setting_defs",
]);
const looksGenerated = (t) =>
  !STATIC_PREFIXED.has(t) &&
  (/^theme_.+_.+$/.test(t) || /^plugin_.+_.+$/.test(t));

/** SQLite may still hold the worker's connection briefly; retry the open. */
function withRetry(fn, attempts = 20) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      const locked = String((e && e.message) || "").includes("locked");
      if (!locked || i >= attempts - 1) throw e;
      // Busy-wait: this is a test tool, and `Atomics.wait` needs a SharedArrayBuffer.
      const until = Date.now() + 250;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function findDb() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.endsWith(".sqlite"));
  return f.length ? join(dir, f[0]) : null;
}

/**
 * Columns that legitimately change without the row being "new".
 *
 * `updated_at` is re-stamped on every boot by `seedBundledExtensions`, which
 * upserts the bundled theme row. `created_at`/`installed_at` are re-stamped
 * whenever `applyThemeCapabilities` clear-then-inserts a theme's declared
 * capabilities — the id (`field_default_category`) is stable, only the stamp
 * moves. Comparing either would report the *default* theme as a leak on almost
 * every suite, which is exactly the false positive that makes a guard get
 * switched off. Identity is untouched, so a genuine leak (a different id/name)
 * is still caught.
 */
const VOLATILE = new Set(["updated_at", "created_at", "installed_at"]);
const canon = (row) => JSON.stringify(
  Object.keys(row).filter((k) => !VOLATILE.has(k)).sort().map((k) => [k, row[k]])
);

/** Open, read every table into `Map<table, Set<rowJson>>`, close. */
function snapshot(dbPath) {
  return withRetry(() => {
    const db = new DatabaseSync(dbPath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const out = new Map();
      for (const t of tables) {
        if (isIgnored(t)) continue;
        let rows;
        try { rows = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { continue; }
        out.set(t, new Set(rows.map(canon)));
      }
      return out;
    } finally {
      db.close();
    }
  });
}

/**
 * Rows the **app itself** materialises the first time it boots, so "added" does
 * not mean "leaked".
 *
 * `ensureThemeCapabilities` / `seedBundledExtensions` run on every request and
 * (re)create the bundled theme's registry row, its declared capabilities
 * (`field_defs`, `theme_routes`, …) and the `example` plugin row. Whichever
 * suite boots first in a run therefore *always* adds them — that is the app
 * working, not a suite leaking.
 *
 * Only the *added* direction is excused: a suite that **removes** one of these
 * rows has broken the operator's install (their custom fields vanish, the front
 * end 404s), and that stays a finding.
 */
const BUNDLED = "default";
const BUNDLED_PLUGIN = "example";
const CAPABILITY_TABLES = new Set(["field_defs", "post_types", "taxonomies", "theme_routes", "theme_blocks"]);
function isAppMaterialised(table, rowJson) {
  let r;
  try { r = Object.fromEntries(JSON.parse(rowJson)); } catch { return false; }
  if (table === "theme_installs") return r.name === BUNDLED;
  if (table === "plugin_installs") return r.name === BUNDLED_PLUGIN;
  if (table === "settings") return r.key === "theme.active" && r.value === BUNDLED;
  if (CAPABILITY_TABLES.has(table)) return r.declared_by_theme === BUNDLED;
  if (table === "admin_menu_registry") return r.owner_name === BUNDLED;
  return false;
}

/**
 * Rows the admin would show that were not there before. A *table* that did not
 * exist before counts as an addition in its own right (a generated theme/plugin
 * table is exactly the kind of thing that survives an uninstall).
 */
function diff(before, after) {
  const added = [];
  for (const [t, rows] of after) {
    const prev = before.get(t);
    if (!prev) { added.push(`${t}: new table (${rows.size} row(s))`); continue; }
    for (const r of rows) if (!prev.has(r) && !isAppMaterialised(t, r)) added.push(`${t}: ${r}`);
  }
  const removed = [];
  for (const [t, rows] of before) {
    const now = after.get(t);
    if (!now) { removed.push(`${t}: table dropped (had ${rows.size} row(s))`); continue; }
    for (const r of rows) if (!now.has(r)) removed.push(`${t}: ${r}`);
  }
  return { added, removed };
}

/** How much junk the shared D1 already holds (a dirty start weakens the run). */
function baselineJunk(dbPath) {
  return withRetry(() => {
    const db = new DatabaseSync(dbPath);
    try {
      const junk = [];
      const one = (sql, label) => {
        try {
          const rows = db.prepare(sql).all();
          if (rows.length) junk.push(`${label}: ${rows.map((r) => Object.values(r)[0]).join(", ")}`);
        } catch { /* table may not exist yet */ }
      };
      one("SELECT name FROM theme_installs WHERE name <> 'default'", "extra themes");
      one("SELECT name FROM plugin_installs WHERE name <> 'example'", "extra plugins");
      one("SELECT id FROM sites WHERE id <> 'default'", "extra sites");
      one("SELECT id FROM posts", "posts");
      const extra = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((r) => r.name).filter(looksGenerated);
      if (extra.length) junk.push(`generated tables: ${extra.join(", ")}`);
      return junk;
    } finally {
      db.close();
    }
  });
}

/** Run a suite in a worker thread (spawnSync is EBUSY in this sandbox). */
function runSuite(relPath) {
  return new Promise((resolve) => {
    // `import()` resolving is NOT the suite finishing: the module body completes
    // while `main()` is still awaiting. Only the suite's own `process.exit` (the
    // `done` stub) counts. See `_skeleton-inject.mjs` for the full story — this
    // is the same harness, and it must not drift from it.
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      let reported = false;
      const done = (code) => { if (reported) return; reported = true; parentPort.postMessage({ out, code: code == null ? 0 : code }); };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\n[suite threw before process.exit] " + ((e && e.stack) || e) + "\\n"; done(1); });
    `;
    let settled = false;
    const w = new Worker(`const { parentPort } = require("node:worker_threads");\n${entry}`, { eval: true });
    const finish = (v) => { if (settled) return; settled = true; try { w.terminate(); } catch { /* gone */ } resolve(v); };
    w.on("message", (m) => finish({ text: m.out, code: m.code }));
    w.on("error", (e) => finish({ text: `WORKER ERROR: ${(e && e.stack) || e}`, code: 1 }));
    w.on("exit", () => finish({ text: "", code: 1, err: "worker exited without reporting" }));
    setTimeout(() => finish({ text: "", code: 1, err: "worker timed out" }), 180_000).unref?.();
  });
}

/** A suite with no summary line is "I could not tell", which is never a pass. */
function parseVerdict(text, code) {
  const m = text.match(/(\d+) passed, (\d+) failed/);
  if (!m) return { ok: false, why: "no summary line (aborted or crashed)" };
  if (Number(m[2]) !== 0 || code !== 0) return { ok: false, why: `${m[1]} passed, ${m[2]} failed` };
  return { ok: true, why: `${m[1]} passed, 0 failed` };
}

const short = (s) => (s.length > 220 ? s.slice(0, 220) + "…" : s);

const argNames = process.argv.slice(2);
const suites = argNames.length ? argNames : SHARED_D1_SUITES;

const dbPath = findDb();
if (!dbPath) {
  console.error("Local D1 not found. Run: npx wrangler dev once (or: npx wrangler d1 migrations apply cfpress --local)");
  process.exit(2);
}
console.log(`Residue guard — shared local D1: ${dbPath}`);
console.log(`Suites: ${suites.join(", ")}\n`);

const startJunk = baselineJunk(dbPath);
if (startJunk.length) {
  console.log("!! the shared D1 is NOT clean before this run:");
  for (const j of startJunk) console.log(`     ${j}`);
  console.log("   (removals below may be this suite sweeping older leftovers)\n");
} else {
  console.log("baseline is clean (only the bundled theme/plugin and the default site)\n");
}

let failed = 0;
const leaks = [];

for (const name of suites) {
  const relPath = `tests/suites/${name}.test.mjs`;
  if (!existsSync(join(ROOT, relPath))) {
    console.log(`${name.padEnd(20)} SKIP (no such suite: ${relPath})`);
    failed++;
    continue;
  }
  const before = snapshot(dbPath);
  const res = await runSuite(relPath);
  const verdict = parseVerdict(res.text, res.code);
  const after = snapshot(dbPath);
  const { added, removed } = diff(before, after);

  if (!verdict.ok) {
    console.log(`${name.padEnd(20)} FAILED — ${verdict.why}`);
    failed++;
  }
  if (added.length) {
    console.log(`${name.padEnd(20)} LEAKED ${added.length} row(s) into the shared D1:`);
    for (const a of added.slice(0, 8)) console.log(`      + ${short(a)}`);
    if (added.length > 8) console.log(`      … and ${added.length - 8} more`);
    leaks.push(name);
    failed++;
  }
  if (removed.length) {
    console.log(`${name.padEnd(20)} WARN removed ${removed.length} pre-existing row(s) (restore, don't just delete):`);
    for (const r of removed.slice(0, 5)) console.log(`      - ${short(r)}`);
  }
  if (verdict.ok && !added.length) {
    console.log(`${name.padEnd(20)} ok   ${verdict.why}${removed.length ? " (with removals above)" : ", DB unchanged"}`);
  }
}

console.log("");
if (failed === 0) {
  console.log(`All ${suites.length} suite(s) left the shared D1 as they found it.`);
  process.exit(0);
}
console.log(`${failed} problem(s) across ${suites.length} suite(s)${leaks.length ? ` — leaked: ${leaks.join(", ")}` : ""}.`);
console.log("A suite must sweep its own fixtures at BOTH ends; see tests/suites/media.test.mjs for the shape.");
process.exit(1);
