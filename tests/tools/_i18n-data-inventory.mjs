/**
 * Inventory: every data-bearing declaration class in shipped extensions.
 *
 * The question this answers is precise: rule 41 forces multi-language
 * capability onto `tables[].fields[]`. Which *other* classes hold data a human
 * reads, and does each one have a language dimension? Run:
 *
 *   node tests/tools/_i18n-data-inventory.mjs
 *
 * A TOOL, not a suite.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".json")) out.push(p);
  }
  return out;
}

const rows = [];
for (const f of [...walk(join(ROOT, "content", "themes")), ...walk(join(ROOT, "content", "plugins"))]) {
  if (!/[\\/](theme|plugin)\.json$/.test(f)) continue;
  let m;
  try { m = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
  const rel = relative(ROOT, f);
  for (const t of m.tables ?? []) {
    const tr = (t.translatable ?? []).length;
    rows.push([rel, "tables[]", t.name, `${(t.fields ?? []).length} fields, ${tr} translatable`, "rule 41 ✓"]);
  }
  for (const s of m.settings ?? []) {
    rows.push([rel, "settings[]", s.key, `type=${s.type ?? "text"}`, "NO language dimension"]);
  }
  for (const fld of m.fields ?? []) {
    rows.push([rel, "fields[] (post custom)", fld.key, `type=${fld.type}`, "NO language dimension"]);
  }
  for (const tx of m.taxonomies ?? []) {
    rows.push([rel, "taxonomies[]", tx.name, "declared", "NO language dimension"]);
  }
  for (const pt of m.postTypes ?? []) {
    rows.push([rel, "postTypes[]", pt.name ?? "?", "declared", "content-language via posts.lang_group"]);
  }
}

const byKind = new Map();
for (const r of rows) byKind.set(r[1], (byKind.get(r[1]) ?? 0) + 1);

console.log("Data-bearing declaration classes in shipped extensions\n");
let width = 0;
for (const r of rows) width = Math.max(width, r[0].length);
for (const r of rows) console.log(`  ${r[0].padEnd(width)}  ${r[1].padEnd(24)} ${r[2].padEnd(14)} ${r[3].padEnd(26)} ${r[4]}`);

console.log("\nTotals by class:");
for (const [k, v] of byKind) console.log(`  ${k}: ${v}`);

const uncovered = rows.filter((r) => r[4] === "NO language dimension");
console.log(`\n${uncovered.length} declaration(s) with no language dimension.`);
