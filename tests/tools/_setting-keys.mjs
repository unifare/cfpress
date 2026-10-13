/**
 * Guard: every settings key the source reads or writes is **declared**.
 *
 * `SETTING_DEFS` (`src/platform/settings.ts`) is the single authority for a
 * settings key's scope — `platform` (install-wide) or `site` (per site) — its
 * default, and whether it is sensitive. A key that is read or written but not
 * declared has no answer to "which level does this live at": it gets written
 * into the wrong table, it survives (or does not survive) a site deletion for
 * no reason, and nothing can give it a default.
 *
 * ## What counts as a hit
 *
 * A line that touches the `settings` table (not `plugin_settings` /
 * `theme_settings` / `platform_settings` — those have their own declarations)
 * and carries a literal key: `key='theme.active'`, `key IN ('a','b')`, or a
 * bound `key=?` on a line whose surroundings name a literal. Placeholder-only
 * statements (`key=?`) are skipped — they cannot name a key.
 *
 * ## Why this is a guard and not a lint
 *
 * The facade (`getSetting` / `setSetting`) already refuses an undeclared key at
 * runtime. But `src/api.ts` still has a dozen *direct* reads of the settings
 * table that predate the facade, and those bypass it. This tool is what makes
 * "the key is at least declared" true for every one of them, and it is what
 * turns the next undeclared key into a red test instead of a surprise.
 *
 * Usage: node tests/tools/_setting-keys.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTING_DEFS } from "../../src/platform/setting-defs.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECLARED = new Set(SETTING_DEFS.map((d) => d.key));

/** Lines that touch the `settings` table itself (not a sibling `_settings`). */
const SETTINGS_TABLE = /(?:FROM|INTO|UPDATE)\s+settings\b/;
/** Any sibling table that is *not* the site-scoped settings table. */
const OTHER_SETTINGS = /\b(?:plugin_settings|theme_settings|platform_settings)\b/;
/** A literal key: `key='x'`, `key="x"`, `key IN ('a','b')`, `key IN ("a","b")`. */
const KEY_LITERAL = /\bkey\s*(?:=|IN)\s*\(?\s*["']([^"']+)["']/gi;

/**
 * Strip comments only - **not** string literals.
 *
 * The keys this guard looks for live *inside* SQL string literals
 * (`"... WHERE key='theme.active'"`), so stripping strings would strip the
 * evidence and turn the guard into a vacuous pass that always says "0 hits".
 * Comments still have to go: a mention of `key='x'` in a `//` comment is advice,
 * not a query.
 */
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, file).split(/[\\/]/).join("/");
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (!SETTINGS_TABLE.test(line) || OTHER_SETTINGS.test(line)) return;
    if (line.includes("key=?") || line.includes("key = ?")) return; // placeholder only
    let m;
    const re = new RegExp(KEY_LITERAL.source, "gi");
    while ((m = re.exec(line))) {
      // ⚠️ group 1 — an earlier draft read `m[2]` from a regex with one group,
      // which is always undefined, so every match was skipped and the guard
      // reported "0 hits" while being a no-op.
      const key = m[1];
      if (!key) continue;
      if (DECLARED.has(key)) continue;
      hits.push(`${rel}:${i + 1}  [${key}]  ${line.trim().slice(0, 110)}`);
    }
  });
}

console.log("Setting-key guard: every settings key read or written is declared in SETTING_DEFS\n");
if (!hits.length) {
  console.log(`  (none — ${DECLARED.size} key(s) declared)`);
} else {
  console.log(`  ${DECLARED.size} key(s) declared. Undeclared keys found:`);
  for (const h of hits) console.log(`  ${h}`);
}

if (hits.length) {
  console.log("\nAdd the key to SETTING_DEFS with its scope (platform | site), type and default.");
  console.log("A settings key without a declaration has no answer to 'which level does it live at'.");
  process.exit(1);
}
console.log("Every settings key is declared.");
