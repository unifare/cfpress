/**
 * sync-bundled-themes.mjs — copy the **bundled** themes into `public/themes/`.
 *
 * WHY THIS EXISTS (the "no patching" decision, 2026-10):
 *
 * Bundled themes (see `src/shared/bundled.ts`, `BUNDLED_THEMES`) are shipped
 * with the product and read at runtime through the Worker's ASSETS binding —
 * the same pipeline that serves `public/admin/`. `wrangler deploy` uploads
 * everything under `public/` automatically, so a database wipe followed by a
 * plain `wrangler deploy` (or migrations + deploy) renders the homepage with
 * no manual "upload 13 R2 objects one by one" step. R2 is left for themes the
 * user uploads and builds themselves.
 *
 * The assets root is `public/`, but theme sources live in `content/themes/`
 * (content = things that get LOADED; src = code). For every **bundled** theme
 * those two trees must agree byte for byte, and the agreement is produced here,
 * mechanically, before every deploy (`predeploy` in package.json) and before
 * dev serves them. The architecture test pins the mapping, so drift — a
 * template edited in `content/` but never synced, or a stale file left in
 * `public/` — fails the suite instead of quietly serving old markup.
 *
 * ⚠️ **Only `BUNDLED_THEMES` is copied, and that is a security boundary, not a
 * convenience.** This script used to mirror the whole of `content/themes/`,
 * which put the *test fixture theme* into `public/themes/` and therefore onto
 * the public internet: `https://<worker>/themes/fixture/theme.json` answered
 * 200 while `architecture.test.mjs` carried a comment calling the fixture "not
 * shipped as a product theme". The suite could not see it, because it asserted
 * the two trees matched — it had pinned the leak as correctness. Deriving the
 * copy set from the one definition of "bundled" is what closes it: a directory
 * under `content/themes/` that is not in that list is read by the suites and
 * never uploaded. The architecture test now asserts both halves (the tree holds
 * *exactly* the bundled files, and this script reads `BUNDLED_THEMES`).
 *
 * `public/themes` is therefore COMMITTED: CI and other machines get a correct
 * checkout without running this script first, and any hand edit is visible as
 * a normal diff.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./_scaffold.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE_ROOT = resolve(HERE, "..", "content", "themes");
export const TARGET_ROOT = resolve(HERE, "..", "public", "themes");
/** The single definition of what ships. Parsed, never re-typed. */
export const BUNDLED_SRC = resolve(HERE, "..", "src", "shared", "bundled.ts");

// `src/shared/bundled.ts` cannot be imported: it uses extensionless relative
// imports that Node's native TS stripping cannot resolve — the same reason
// `architecture.test.mjs` and `_schema-scope.mjs` parse their sources instead.
// The parse lives *here* and the suite imports this function, so there is one
// place to keep correct instead of two copies that can drift apart.
const BUNDLED_LIST_RE = /export const BUNDLED_THEMES(?::\s*readonly string\[\])?\s*=\s*\[([\s\S]*?)\]\s*(?:as const)?;/;

/** Pure half: pull the quoted names out of a `bundled.ts` source string. */
export function parseBundledThemeNames(src) {
  const m = String(src).match(BUNDLED_LIST_RE);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/** Read the bundled names from their one definition. */
export function readBundledThemeNames(srcPath = BUNDLED_SRC) {
  return parseBundledThemeNames(readFileSync(srcPath, "utf8"));
}

/**
 * Walk a directory and return every file path relative to `root`, sorted.
 * Directories without a single file yield nothing (an empty theme dir is not
 * an error here — the architecture test is the one that demands a theme.json).
 */
export function listThemeFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(root, abs).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

/**
 * Pure decision half of the sync: given the source root, target root and the
 * file list (as source-relative paths), return the planned copies. Unsafe
 * paths — absolute, escaping the root, containing `..` — throw, because a
 * path like that here would mean we are about to write outside `public/`.
 *
 * Kept side-effect free (no fs, no process) so a test can import it and pin
 * the plan without touching the disk, the same reason the generators keep
 * their content builders pure (`scripts/_scaffold.mjs` header).
 */
export function copyPlan(sourceRoot, targetRoot, relPaths) {
  const plan = [];
  for (const rel of relPaths) {
    if (typeof rel !== "string" || rel.length === 0) {
      throw new Error(`unsafe theme file path: ${JSON.stringify(rel)}`);
    }
    const norm = rel.split("\\").join("/");
    if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
      throw new Error(`unsafe theme file path (absolute): ${norm}`);
    }
    const parts = norm.split("/");
    if (parts.some((p) => p === ".." || p.length === 0)) {
      throw new Error(`unsafe theme file path (escapes source root): ${norm}`);
    }
    plan.push({ from: join(sourceRoot, ...parts), to: join(targetRoot, ...parts), rel: norm });
  }
  return plan;
}

/**
 * One full sync: copy **the bundled themes** over `public/themes` in place,
 * then retire files the copy set no longer contains. NOT wipe-then-copy: a
 * crash **between** the wipe and the copies once left `public/themes` EMPTY —
 * and every page then falls back to the minimal shell with no error anywhere
 * (seen live: a trash-shim timeout killed the rmSync and the next dev boot
 * rendered 191-byte stubs for the whole site). Copying in place means every
 * interrupted state is a valid tree — at worst a superset of the old one —
 * and the stale-file retirement runs LAST, where a failure is cosmetic (an
 * old file left behind, visible to git and to the architecture suite), never
 * an outage.
 *
 * Every early exit throws rather than warning: shipping *nothing* renders
 * `__fallback__` in production, and shipping *too much* leaks a test fixture,
 * so neither is a state worth continuing from.
 */
export function syncBundledThemes(sourceRoot = SOURCE_ROOT, targetRoot = TARGET_ROOT, names = readBundledThemeNames()) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`bundled theme source missing: ${sourceRoot} (expected content/themes/)`);
  }
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`BUNDLED_THEMES is empty or unparseable in ${BUNDLED_SRC} — refusing to wipe ${targetRoot}`);
  }
  const nameless = names.filter((n) => !existsSync(join(sourceRoot, n, "theme.json")));
  if (nameless.length) {
    throw new Error(`bundled theme(s) with no theme.json under ${sourceRoot}: ${nameless.join(", ")}`);
  }
  // Source-relative paths, one directory per bundled theme. Anything under
  // content/themes/ that is not bundled (the test fixture) is deliberately
  // left behind — see the security note in the header.
  const files = names.flatMap((n) => listThemeFiles(join(sourceRoot, n)).map((f) => `${n}/${f}`));
  if (files.length === 0) {
    throw new Error(`no theme files found under ${sourceRoot} — refusing to wipe ${targetRoot} for nothing`);
  }
  const plan = copyPlan(sourceRoot, targetRoot, files);
  for (const { from, to } of plan) {
    cpSync(from, to);
  }
  // Stale files are retired only after every replacement is already on disk.
  // A stale leftover can only ever be a file that WAS bundled and stopped
  // being — never the test fixture, which the copy set above never contained.
  const keep = new Set(plan.map((p) => p.rel));
  for (const rel of listThemeFiles(targetRoot)) {
    if (!keep.has(rel)) rmSync(join(targetRoot, ...rel.split("/")), { force: true });
  }
  return { count: plan.length, files: plan.map((p) => p.rel), names: [...names] };
}

function main() {
  const { count, names } = syncBundledThemes();
  console.log(`sync-bundled-themes: ${count} file(s) from bundled theme(s) [${names.join(", ")}] -> public/themes (assets pipeline)`);
}

if (isMain(import.meta.url)) main();
