/**
 * Generate `wrangler.local.jsonc` from `wrangler.jsonc` + `wrangler.ids.json`.
 *
 * ## Why this exists
 *
 * Two files describe the same deployment:
 *
 *   wrangler.jsonc        committed, `REPLACE_WITH_*` placeholders, reviewed
 *   wrangler.local.jsonc  gitignored, real ids, **the one every command runs**
 *
 * So the reviewed file is not the one that ships, and the shipped file is not
 * reviewed. They were kept in step by hand, and hand-keeping failed exactly as
 * you would expect: batch 11 added the feature-switch `vars` block to
 * `wrangler.jsonc` only, and the deployed Worker had no `vars` at all for two
 * batches. `tests/tools/_config-parity.mjs` now catches that after the fact —
 * this script removes the possibility.
 *
 * ## The shape
 *
 * One source of truth (the template), one small file of values (the ids), and a
 * derived artifact that is never edited by hand. `renderLocalConfig()` is a
 * pure function of (template text, ids object) so the guard can recompute it
 * and compare, rather than re-describing the derivation — a second description
 * would be the same bug one level up.
 *
 * The substitution is **textual**, not a JSON round-trip: re-serialising would
 * discard every comment, and the comments are the documentation for the file
 * that actually deploys.
 *
 * ## Usage
 *
 *   node scripts/make-local-config.mjs            write if changed, else no-op
 *   node scripts/make-local-config.mjs --check    exit 1 if the file is stale
 *   node scripts/make-local-config.mjs --print    write the result to stdout
 *
 * Exit codes: 0 ok · 1 stale (--check only) · 2 missing/unusable input.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_PATH = join(ROOT, "wrangler.jsonc");
export const IDS_PATH = join(ROOT, "wrangler.ids.json");
export const LOCAL_PATH = join(ROOT, "wrangler.local.jsonc");

/** Every `REPLACE_WITH_*` name in a template, sorted and de-duplicated. */
export function placeholdersIn(src) {
  return [...new Set(src.match(/REPLACE_WITH_[A-Z0-9_]*/g) ?? [])].sort();
}

/**
 * Read the ids file. Keys are placeholder names verbatim, so adding a
 * placeholder to the template needs one line here and no code change. Keys
 * starting with `$` are comments (the file is JSON, and JSON has no comments).
 */
export function readIds(path = IDS_PATH) {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const ids = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("$")) continue;
    ids[k] = v;
  }
  return ids;
}

const HEADER = [
  "// GENERATED FILE — do not edit.",
  "//",
  "// Produced by `node scripts/make-local-config.mjs` from `wrangler.jsonc`",
  "// (committed, placeholders) plus `wrangler.ids.json` (gitignored, real ids).",
  "// Edit those two; a hand edit here is discarded the next time anything runs,",
  "// and `tests/tools/_config-parity.mjs` will call it out before that.",
  "//",
  "// Every wrangler command in this repository runs against THIS file:",
  "//     npx wrangler dev    -c wrangler.local.jsonc",
  "//     npx wrangler deploy -c wrangler.local.jsonc",
  "// The committed template keeps its placeholders so a public clone never",
  "// publishes account-scoped resource ids.",
  "",
].join("\n");

/**
 * The whole derivation, as a pure function.
 *
 * Throws (never silently substitutes) when the template and the ids file
 * disagree in either direction — a placeholder with no value, or a value whose
 * placeholder was renamed away. Both are the "declared but never consumed"
 * family, and both are invisible in a deploy that otherwise looks fine.
 */
export function renderLocalConfig(templateSrc, ids) {
  const wanted = placeholdersIn(templateSrc);
  const missing = wanted.filter((p) => !(p in ids));
  if (missing.length) {
    throw new Error(
      `wrangler.ids.json is missing a value for:\n` +
        missing.map((p) => `    ${p}`).join("\n")
    );
  }
  const stale = Object.keys(ids).filter((k) => !wanted.includes(k));
  if (stale.length) {
    throw new Error(
      `wrangler.ids.json has a value for a placeholder that no longer exists:\n` +
        stale.map((k) => `    ${k}`).join("\n") +
        `\n(rename it, or delete the line — a stale id is a value nothing reads)`
    );
  }
  let out = templateSrc;
  for (const p of wanted) out = out.split(p).join(String(ids[p]));
  return HEADER + out;
}

// --- CLI --------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const mode = process.argv[2] ?? "";
  const rel = (p) => relative(ROOT, p).split("\\").join("/");

  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`make-local-config: ${rel(TEMPLATE_PATH)} not found — run from the project root`);
    process.exit(2);
  }
  const ids = readIds();
  if (!ids) {
    console.error(`make-local-config: ${rel(IDS_PATH)} not found.`);
    console.error("");
    console.error("  It maps each placeholder in the committed template to this");
    console.error("  account's real resource id. Create the resources, then write:");
    console.error("");
    console.error("    {");
    console.error('      "REPLACE_WITH_D1_DATABASE_ID": "<from: npx wrangler d1 create cfpress>"');
    console.error('      "REPLACE_WITH_KV_NAMESPACE_ID": "<from: npx wrangler kv namespace create CACHE>"');
    console.error("    }");
    console.error("");
    console.error("  It is gitignored on purpose: these ids are account-scoped and");
    console.error("  this repository is public.");
    process.exit(2);
  }

  let rendered;
  try {
    rendered = renderLocalConfig(readFileSync(TEMPLATE_PATH, "utf8"), ids);
  } catch (e) {
    console.error(`make-local-config: ${e.message}`);
    process.exit(2);
  }

  if (mode === "--print") {
    process.stdout.write(rendered);
    process.exit(0);
  }

  const current = existsSync(LOCAL_PATH) ? readFileSync(LOCAL_PATH, "utf8") : null;
  if (current === rendered) {
    if (mode === "--check") {
      console.log(`${rel(LOCAL_PATH)} is up to date`);
    } else {
      console.log(`make-local-config: ${rel(LOCAL_PATH)} already up to date`);
    }
    process.exit(0);
  }

  if (mode === "--check") {
    console.error(`${rel(LOCAL_PATH)} is STALE — run: node scripts/make-local-config.mjs`);
    process.exit(1);
  }

  writeFileSync(LOCAL_PATH, rendered);
  console.log(
    current === null
      ? `make-local-config: wrote ${rel(LOCAL_PATH)}`
      : `make-local-config: updated ${rel(LOCAL_PATH)}`
  );
}
