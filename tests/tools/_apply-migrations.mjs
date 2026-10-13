/**
 * Local D1 migration runner.
 *
 * `wrangler d1 migrations apply` is the canonical path, but this script exists
 * so tests (and CI without wrangler) can bring the local sqlite file up to date
 * deterministically. It is comment-aware — a naive split on `;` breaks on
 * semicolons inside SQL comments.
 *
 * Usage: node tests/tools/_apply-migrations.mjs [--reset-latest]
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");

/** Split SQL into statements, ignoring `;` inside comments and string literals. */
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; buf += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) {
        if (next === quote) { buf += next; i += 2; continue; }
        quote = null;
      }
      i++;
      continue;
    }
    if (c === "-" && next === "-") { inLine = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; buf += c; i++; continue; }
    if (c === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i++; continue; }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Statements that fail harmlessly when re-applied.
 *
 * `theme_admin_menus` is in the "no such table" alternation because 0012 drops
 * it: if a database is ever brought up by applying only the tail of the
 * migration set, the copy-out statement must not abort the run. The data it
 * would have copied is, in that case, already absent.
 */
const BENIGN = /duplicate column name|already exists|no such table: (menus_new|menu_items_new|menus_v2|theme_admin_menus)/i;

export function applyMigrations(db, dir) {
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const report = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const stmts = splitStatements(sql);
    let ok = 0, skipped = 0;
    const errors = [];
    for (const s of stmts) {
      try { db.exec(s); ok++; }
      catch (e) {
        const m = String((e && e.message) || "");
        if (BENIGN.test(m)) { skipped++; continue; }
        errors.push({ message: m, sql: s.slice(0, 130).replace(/\s+/g, " ") });
      }
    }
    report.push({ file: f, ok, skipped, errors });
  }
  return report;
}

function findLocalD1() {
  const dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.endsWith(".sqlite"));
  return f.length ? join(dir, f[0]) : null;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dbPath = findLocalD1();
  if (!dbPath) {
    console.error("Local D1 not found. Run: npx wrangler d1 migrations apply cfpress --local");
    process.exit(2);
  }
  console.log("Database: " + dbPath);
  const db = new DatabaseSync(dbPath);
  const report = applyMigrations(db, join(root, "content", "migrations"));
  let bad = 0;
  for (const r of report) {
    const tail = r.errors.length ? `  ERRORS: ${r.errors.length}` : "";
    console.log(`${r.file}: ${r.ok} applied, ${r.skipped} already-present${tail}`);
    for (const e of r.errors) { bad++; console.log(`   ! ${e.message}\n     ${e.sql}`); }
  }
  // Sanity: the tables the runtime depends on.
  const must = ["sites", "menus", "menu_items", "media_files", "content_cache_versions", "post_types", "field_defs", "post_meta", "locales", "site_locales", "i18n_overrides", "admin_menu_registry"];
  for (const t of must) {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!r) { console.log(`MISSING TABLE: ${t}`); bad++; }
  }
  // 0012 retires the old table; a leftover copy would mean the drop never ran.
  const retired = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='theme_admin_menus'").get();
  if (retired) { console.log("STALE TABLE: theme_admin_menus still present (0012 did not drop it)"); bad++; }
  const menuCols = db.prepare("PRAGMA table_info(menus)").all().map((c) => c.name);
  console.log("menus columns: " + menuCols.join(","));
  console.log("menus pk: " + db.prepare("PRAGMA table_info(menus)").all().filter((c) => c.pk).map((c) => c.name).join(","));
  db.close();
  process.exit(bad ? 1 : 0);
}
