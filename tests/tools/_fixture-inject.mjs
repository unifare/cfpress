/**
 * Reverse-validation for tests/suites/theme-fixture.test.mjs.
 *
 * Usage:
 *   node tests/tools/_fixture-inject.mjs inject <scenario>   # mutate themes/fixture
 *   node tests/tools/_fixture-inject.mjs restore             # byte-exact rollback
 *   node tests/tools/_fixture-inject.mjs list
 *
 * Not wired into `npm test` — it is a *tool*, run by hand when the fixture suite
 * itself changes, the same way you would re-inject a defect to check a guard.
 * See `tests/fixtures/_extension-rules.mjs` for the other half of that idea.
 *
 * This is the successor to `_eshop-inject.mjs`, carried across when the four
 * showcase themes were retired. The scenarios are not decoration: each one is
 * the *only* proof that a named assertion in the suite can go red. Dropping the
 * theme without porting the tool would have silently deleted that proof.
 *
 * ## Four mistakes this file exists to not repeat
 *
 * 1. **A byte-count guard cannot see a same-length mutation.** The first
 *    version asserted `before !== after` in *length*; `"/items/"` -> `"/blog/"`
 *    is not the same length, but the general case is: an equal-length edit is
 *    reported as "changed nothing" for a mutation that landed — a false
 *    negative in the very tool meant to prevent false negatives. Compare a
 *    **content hash**.
 *
 * 2. **`git checkout -- <path>` cannot restore a file git has never seen.**
 *    A brand-new theme directory is untracked, so `git checkout` is a silent
 *    no-op: every scenario stacks on the previous one and the suite accumulates
 *    failures from defects that were supposedly undone. Snapshot and copy back.
 *
 * 3. **A snapshot taken while the tree was already dirty preserves the dirt.**
 *    `assertPristine` rejects both a dirty snapshot and a restore that did not
 *    clean up, in both directions.
 *
 * 4. **A token count over raw source is fooled by a comment.** `assertPristine`
 *    counts `{{/section}}` to check that every child closes its sections. A
 *    `{{/section}}` written inside a `{{! ... }}` comment is not a closer —
 *    the engine strips comments before parsing — so counting raw text lets a
 *    comment *mask* an unclosed section. This is the eleventh false green
 *    recorded in AGENTS.md; the count here strips comments first.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEME_DIR = join(root, "content", "themes", "fixture");
const SNAP = join(root, ".wrangler", "fixture-snapshot");

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function read(rel) { return readFileSync(join(THEME_DIR, rel), "utf8"); }
function write(rel, text) { writeFileSync(join(THEME_DIR, rel), text); }

/** Strip `{{! ... }}` comments the way the engine does before parsing. */
export const stripComments = (src) => src.replace(/\{\{![\s\S]*?\}\}/g, "");

/**
 * `mutate` runs the same substitution the mutation will, so the guard can
 * verify the *content* changed even when the length does not. `minMatches`
 * asserts the mutation hit every instance it intended to: a scoped defect that
 * exists twice and is injected once leaves the other instance green — the
 * fixture-drift lesson again, one level down.
 */
function mutate(rel, re, to, minMatches = 1) {
  const before = read(rel);
  const hits = (before.match(new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g"))) ?? []).length;
  if (hits < minMatches) {
    throw new Error(`${rel}: pattern ${re} matched ${hits} time(s), expected >= ${minMatches}`);
  }
  const after = before.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), to);
  if (after === before) throw new Error(`${rel}: pattern ${re} matched nothing`);
  write(rel, after);
  return { rel, before: hash(before), after: hash(read(rel)) };
}

function mutateJson(rel, fn) {
  const before = read(rel);
  const doc = JSON.parse(before);
  const changed = fn(doc);
  if (!changed) throw new Error(`${rel}: JSON mutation was a no-op`);
  write(rel, JSON.stringify(doc, null, 2) + "\n");
  return { rel, before: hash(before), after: hash(read(rel)) };
}

const SCENARIOS = {
  // A child that leaves a section unclosed: the engine reads it as a layout
  // slot and renders an empty <main> at HTTP 200. Must redden BOTH
  // "every child closes every section it opens" (the textual check, which needs
  // its own proof because a decoy comment can satisfied it — see mistake 4)
  // AND "all 11 declared templates render a full shell" (the structural check).
  "unclosed-section": () => mutate("templates/single.html", /\{\{\/section\}\}/, ""),

  // The decoy variant, which is the *regression test for mistake 4*: the real
  // closer is removed, but a `{{/section}}` is left inside a comment. A raw
  // text count sees 1 open / 1 close and stays green while the engine throws.
  // Must redden "every child closes every section it opens".
  "unclosed-section-comment-decoy": () =>
    mutate("templates/single.html", /\{\{\/section\}\}/, "{{! decoy {{/section}} }}"),

  // The listing route loses its scope name, so the `items` collection the
  // archive template iterates is declared nowhere. Must redden
  // "the listing route names its scope".
  //
  // `minMatches` is 1, not 2: the eshop theme had two routes sharing the shop
  // scope, this fixture has one. Carrying the old count across would make the
  // scenario throw on "matched 1 time(s), expected >= 2" — a scenario that can
  // never run is a scenario that proves nothing.
  "route-scope": () => mutate("theme.json", /"as":\s*"items"/, '"as": "rows"', 1),

  // The item route forgets which column identifies a single object, so a miss
  // stops being distinguishable from a hit. Must redden
  // "the item route resolves the table by slug".
  "resolve-by": () => mutate("theme.json", /"by":\s*"slug"/, '"by": "id"'),

  // A field the templates render stops being translatable — the two halves of
  // the declaration disagree, and the validator rejects the prose field.
  // Must redden "validateManifest accepts the theme".
  translatable: () => mutate("theme.json", /"translatable":\s*\[[^\]]*\]/, '"translatable": ["price"]'),

  // The link points at a path no route serves: the classic "renders 200, points
  // at a 404" defect. Same *intent* as the eshop `link-path` scenario.
  // Must redden "archive links to the route's own path".
  "link-path": () => mutate("templates/archive-item.html", /\/\{\{locale\}\}\/items\//, "/{{locale}}/blog/"),

  // A declared template ships no file. Must redden
  // "every declared template exists" (and the architecture rule).
  "missing-template-file": () => {
    const rel = "templates/single-item.html";
    if (!existsSync(join(THEME_DIR, rel))) throw new Error(`${rel} already absent`);
    renameSync(join(THEME_DIR, rel), join(THEME_DIR, rel + ".hidden"));
    return { rel, before: hash(read(rel + ".hidden")), after: "-" };
  },

  // A locale is declared but ships no pack, so the key-prefix rule would be
  // enforced against an empty set — the second recorded false-green mode.
  // Must redden "every declared locale ships a pack".
  "missing-lang-pack": () => {
    const rel = "langs/zh-CN.json";
    if (!existsSync(join(THEME_DIR, rel))) throw new Error(`${rel} already absent`);
    renameSync(join(THEME_DIR, rel), join(THEME_DIR, rel + ".hidden"));
    return { rel, before: hash(read(rel + ".hidden")), after: "-" };
  },

  // A menu label escapes the owner's key namespace (rule 11), so the entry
  // would silently stay untranslated. Must redden
  // "validateManifest accepts the theme".
  "label-key-namespace": () =>
    mutate("theme.json", /"label_key":\s*"theme\.fixture\.menu\.items"/, '"label_key": "theme.other.menu.items"'),

  // A route resolves a table the manifest never declares. Must redden
  // "validateManifest accepts the theme".
  "undeclared-route-table": () =>
    mutate("theme.json", /"resolve":\s*\{\s*"table":\s*"item"\s*\}/, '"resolve": { "table": "widget" }'),
};

const [, , action, scenario] = process.argv;

function snapshot() {
  rmSync(SNAP, { recursive: true, force: true });
  if (existsSync(SNAP)) throw new Error(`could not clear ${SNAP}`);
  mkdirSync(dirname(SNAP), { recursive: true });
  cpSync(THEME_DIR, SNAP, { recursive: true });
  const probe = join(SNAP, "theme.json");
  if (!existsSync(probe)) throw new Error("snapshot did not copy theme.json");
  assertPristine(SNAP, "refusing to snapshot");
}

/**
 * A snapshot taken while the tree was already dirty faithfully preserves the
 * dirt — every "restore" then restores the corruption, and the suite keeps
 * failing on a defect that no scenario introduced. So the snapshot is checked
 * against the properties the suite asserts, and a dirty tree is rejected
 * instead of enshrined.
 */
function assertPristine(dir, prefix) {
  const manifestText = readFileSync(join(dir, "theme.json"), "utf8");
  const problems = [];
  const manifest = JSON.parse(manifestText);
  const scopes = manifest.routes.filter((r) => r.query && r.query.as).map((r) => r.query.as);
  if (!scopes.includes("items")) problems.push('no route declares query.as "items"');
  const byVals = manifest.routes.filter((r) => r.resolve && r.resolve.by).map((r) => r.resolve.by);
  if (!byVals.every((b) => b === "slug")) problems.push("some route resolves by something other than slug");
  const translatables = JSON.stringify(manifest.tables.map((t) => t.translatable));
  if (!translatables.includes('"name"') || !translatables.includes('"blurb"')) {
    problems.push("a table lost its translatable prose fields");
  }
  for (const m of manifest.adminMenus ?? []) {
    if (m.label_key && !m.label_key.startsWith("theme.fixture.")) {
      problems.push(`menu ${m.id}: label_key escaped the owner namespace (${m.label_key})`);
    }
  }
  if (manifest.routes.some((r) => r.resolve && r.resolve.table && r.resolve.table !== "item")) {
    problems.push("a route resolves a table the manifest does not declare");
  }
  // Every child must close every section it opens; a layout legitimately has an
  // unclosed slot, so only files that `@extends` are checked. Comments are
  // stripped first (mistake 4): the engine does not parse them as syntax, so a
  // decoy `{{/section}}` inside one must not count as a closer.
  for (const f of manifest.templates) {
    const p = join(dir, "templates", `${f}.html`);
    if (!existsSync(p)) { problems.push(`${f}.html missing`); continue; }
    const src = stripComments(readFileSync(p, "utf8"));
    if (!/\{\{@extends/.test(src)) continue;
    const opens = (src.match(/\{\{@section\s/g) ?? []).length;
    const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;
    if (opens !== closes) problems.push(`${f}.html ${opens} open / ${closes} closed`);
  }
  if (problems.length) {
    throw new Error(`${prefix}: themes/fixture/ is not pristine — ${problems.join("; ")}. ` +
      "Fix the tree, confirm `node tests/suites/theme-fixture.test.mjs` is green, then re-run.");
  }
}

function restore() {
  if (!existsSync(SNAP)) throw new Error("no snapshot to restore from");
  rmSync(THEME_DIR, { recursive: true, force: true });
  if (existsSync(THEME_DIR)) throw new Error(`could not clear ${THEME_DIR}`);
  cpSync(SNAP, THEME_DIR, { recursive: true });
  // Prove it: the restored theme.json must hash to what we snapshotted.
  const want = readFileSync(join(SNAP, "theme.json"), "utf8");
  const got = readFileSync(join(THEME_DIR, "theme.json"), "utf8");
  if (hash(want) !== hash(got)) throw new Error("restore did not reproduce theme.json");
  for (const s of ["templates/single-item.html.hidden", "langs/zh-CN.json.hidden"]) {
    if (existsSync(join(THEME_DIR, s))) throw new Error(`stray ${s} survived the restore`);
  }
  // A restore that cannot prove it restored is not a restore.
  assertPristine(THEME_DIR, "restore produced a non-pristine tree");
  console.log(`restored themes/fixture/ from snapshot (theme.json ${hash(got)})`);
}

// -- CLI, importable ----------------------------------------------------------
//
// The tool doubles as a library so a driver can run every scenario **in one
// process**. That is not a convenience: this sandbox cannot spawn a child
// process at all (`spawnSync` -> `EBUSY`, the same reason `npm test` reports
// SKIP here), so a driver that shells out to `node tests/tools/_fixture-inject.mjs`
// simply cannot run. Same design as `scripts/make-*.mjs`: `main(argv, io)` plus
// an `isMain()` guard, so importing the module has no side effects.

export function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export function main(argv, io = console) {
  const [action, scenario] = argv;
  if (action === "list") {
    io.log(Object.keys(SCENARIOS).join("\n"));
    return 0;
  }
  if (action === "restore") { restore(); return 0; }
  if (action !== "inject" || !SCENARIOS[scenario]) {
    io.error(`usage: node tests/tools/_fixture-inject.mjs inject <${Object.keys(SCENARIOS).join("|")}>`);
    io.error("       node tests/tools/_fixture-inject.mjs restore | list");
    return 2;
  }
  snapshot();
  const r = SCENARIOS[scenario]();
  // Compare hashes, not lengths. A same-length edit is exactly what mistake (1)
  // was, and it is the mutation this guard would otherwise wave through.
  if (r.before === r.after) {
    throw new Error(`injection "${scenario}" changed nothing (hash ${r.before} -> ${r.after})`);
  }
  io.log(`injected ${scenario} into ${r.rel}`);
  io.log(`  hash ${r.before} -> ${r.after}`);
  return 0;
}

export { SCENARIOS, snapshot, restore, assertPristine, read, write, THEME_DIR };

if (isMain()) {
  try {
    process.exit(main(process.argv.slice(2), console));
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
}
