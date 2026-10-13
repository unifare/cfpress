/**
 * Shared plumbing for the generators (`make-theme`, `make-plugin`,
 * `make-table`). ARCHITECTURE.md §5.5.
 *
 * Deliberately tiny and dependency-free: a scaffold that needs a build step to
 * run is a scaffold nobody runs. Everything here is argument parsing, name
 * checking and file writing — the interesting part of each generator is the
 * *content* it emits, which stays next to the assertions that check it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A problem the user can fix, as opposed to a bug in the generator.
 *
 * Thrown rather than `process.exit`-ed so `main()` can be called as a function.
 * That matters beyond tidiness: this repo's test environment cannot spawn a
 * child process at all (the sandbox locks the node binary, the same reason
 * `tests/run-all.mjs` reports SKIP here), so a generator that can only be
 * exercised by running it as a command is a generator whose output is untested.
 * `tests/suites/scaffold.test.mjs` therefore imports `main()` and the content builders
 * directly.
 */
export class CliError extends Error {}

/**
 * True when this module is the process entry point rather than an import.
 *
 * The standard guard, extracted so each generator's last line is one line and
 * cannot be got subtly wrong (comparing `process.argv[1]` as a string breaks on
 * Windows path separators and on symlinks).
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return !!entry && pathToFileURL(entry).href === metaUrl;
}

/**
 * Names that may become a directory, an R2 key and part of a generated table
 * name. This is the same shape `contract/manifest.ts` enforces on
 * `manifest.name`, checked here so the failure arrives before anything is
 * written rather than at upload time.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;

export function assertName(name, kind) {
  if (!NAME_RE.test(String(name || ""))) {
    throw new CliError(
      `invalid ${kind} name "${name}": use lowercase letters, digits, "-" or "_", ` +
        `start with a letter or digit, 2-64 characters (e.g. "my-shop")`
    );
  }
  return name;
}

/** `my-shop` → `My Shop`. Used for the default `title`. */
export function titleCase(name) {
  return String(name)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * `--flag value` and `--flag=value` both work; bare `--flag` becomes `true`.
 * Positional arguments come back in `_`. No dependencies, no surprises.
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

/**
 * Write a file tree, refusing to clobber unless `force`.
 *
 * The refusal is the important half: a generator that silently overwrites is a
 * generator you cannot re-run after editing the output, which is exactly when
 * you would want to.
 */
export function writeTree(root, files, { force = false } = {}) {
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    if (existsSync(abs) && !force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return { written, skipped };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * Print what happened. Both generators end with the same three lines, because
 * the useful thing to know is never "it worked" — it is where the files are and
 * what to do next.
 */
export function report(kind, name, root, { written, skipped }, nextSteps, io = console) {
  io.log(`\n${kind} "${name}" → ${root}\n`);
  for (const f of written) io.log(`  + ${f}`);
  for (const f of skipped) io.log(`  = ${f} (exists, left alone — pass --force to overwrite)`);
  io.log("");
  for (const line of nextSteps) io.log(`  ${line}`);
  io.log("");
}
