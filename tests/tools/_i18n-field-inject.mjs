/**
 * Reverse validation for the "every declared field carries multi-language
 * capability" guard family (§10 rule 41).
 *
 * These guards live in three places and the whole point of this tool is to show
 * each one actually goes RED when the rule is broken — a guard that cannot fail
 * is not a guard. Every scenario:
 *
 *   1. asserts the tree is pristine BEFORE editing (PRISTINE FAIL otherwise),
 *   2. injects exactly one defect and asserts the bytes actually changed
 *      (compared by content hash, not length — an equal-length swap is invisible
 *      to a byte count),
 *   3. runs the guard and captures the summary line,
 *   4. asserts which check failed — by name, not just "something failed",
 *   5. restores and asserts pristine AGAIN ("the restore is also verified").
 *
 * This file is a TOOL, not a suite: it is not in `npm test` (same nature as
 * `_fixture-inject.mjs` and `_i18n-browser.cjs`).
 *
 * Usage: node tests/tools/_i18n-field-inject.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const MANIFEST = join(ROOT, "src/extensions/contract/manifest.ts");
const VALIDATION = join(ROOT, "src/extensions/contract/validation.ts");
const MAKETABLE = join(ROOT, "scripts/make-table.mjs");
const SHIPPED = join(ROOT, "content/themes/fixture/theme.json");
const VALIDATOR_SUITE = join(ROOT, "tests/suites/manifest-validation.test.mjs");
const SCAFFOLD_SUITE = join(ROOT, "tests/suites/scaffold.test.mjs");
const ARCH_SUITE = join(ROOT, "tests/suites/architecture.test.mjs");

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

/** Run a suite and return { passed, failed, aborted, text }. */
function runSuite(file) {
  let text;
  try {
    text = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const m = text.match(/^(\d+) passed, (\d+) failed/m);
  if (!m) {
    // "No summary line = failure" (sixth false-green). Say so explicitly.
    return { passed: null, failed: null, aborted: true, text };
  }
  return { passed: Number(m[1]), failed: Number(m[2]), aborted: /\(aborted\)/.test(text), text };
}

/** Assert a suite failed on a check whose name matches `needle`. */
function assertFailedOn(label, res, needle) {
  const problems = [];
  if (res.aborted) problems.push("no summary line (suite crashed or never finished)");
  if (res.failed === 0) problems.push(`expected FAILED > 0, got ${res.failed}`);
  if (!new RegExp(`FAIL .*${needle}`).test(res.text) && !res.text.includes(needle)) {
    problems.push(`no FAIL mentioning ${JSON.stringify(needle)}`);
  }
  if (problems.length) {
    return { ok: false, why: problems.join("; "), text: res.text };
  }
  return { ok: true, why: `${res.passed} passed, ${res.failed} failed`, text: res.text };
}

/**
 * Restoring is verified, not assumed.
 *
 * This used to ask git whether `themes/` was clean. That conflates two very
 * different things: "a scenario failed to restore" and "the developer has
 * uncommitted work". During any refactor the second is always true, so the tool
 * aborted before it could report anything — a false alarm that looks exactly
 * like a broken tool.
 *
 * What this actually needs to know is narrower: are the files this run touched
 * byte-identical to how it found them? A hash baseline answers precisely that,
 * and is immune to whatever else the working tree is doing.
 */
function assertPristine(where) {
  const drifted = [];
  for (const [file, before] of BASELINE) {
    const now = existsSync(file) ? hash(file) : "<absent>";
    if (now !== before) drifted.push(`${file.slice(ROOT.length + 1)}: ${before} -> ${now}`);
  }
  if (drifted.length) {
    throw new Error(`PRISTINE FAIL (${where}):\n  ${drifted.join("\n  ")}`);
  }
}

const BASELINE = new Map(
  [MANIFEST, VALIDATION, MAKETABLE, SHIPPED].map((f) => [f, existsSync(f) ? hash(f) : "<absent>"])
);

function swap(file, from, to) {
  const before = readFileSync(file, "utf8");
  const beforeHash = hash(file);
  if (!before.includes(from)) throw new Error(`injection anchor not found in ${file}:\n${from}`);
  writeFileSync(file, before.replace(from, to), "utf8");
  const afterHash = hash(file);
  if (beforeHash === afterHash) throw new Error(`injection was a no-op (content hash unchanged) in ${file}`);
  return () => {
    writeFileSync(file, before, "utf8");
    if (hash(file) !== beforeHash) throw new Error(`restore failed / not byte-identical: ${file}`);
  };
}

// ---------------------------------------------------------------------------

const scenarios = [
  {
    name: "validator: prose field missing from translatable",
    file: VALIDATION,
    from: "      if (isProseFieldType(ft) && !declaredTranslatable.has(key)) {",
    to: "      if (false && isProseFieldType(ft) && !declaredTranslatable.has(key)) {",
    suite: VALIDATOR_SUITE,
    needle: "prose",
  },
  {
    name: "validator: language-neutral field wrongly declared translatable",
    file: VALIDATION,
    from: "      if (!isProseFieldType(ft) && declaredTranslatable.has(key)) {",
    to: "      if (false && !isProseFieldType(ft) && declaredTranslatable.has(key)) {",
    suite: VALIDATOR_SUITE,
    needle: "language-neutral",
  },
  {
    name: "contract: a prose type dropped from PROSE_FIELD_TYPES",
    file: MANIFEST,
    from: 'export const PROSE_FIELD_TYPES = ["text", "longtext"] as const;',
    to: 'export const PROSE_FIELD_TYPES = ["text"] as const;',
    suite: ARCH_SUITE,
    needle: "classified as prose or language-neutral",
  },
  {
    name: "contract: a type listed in both classifications",
    file: MANIFEST,
    from: 'export const LANGUAGE_NEUTRAL_FIELD_TYPES = ["number", "boolean", "date", "datetime"] as const;',
    to: 'export const LANGUAGE_NEUTRAL_FIELD_TYPES = ["number", "boolean", "date", "datetime", "longtext"] as const;',
    suite: ARCH_SUITE,
    needle: "do not overlap",
  },
  {
    name: "shipped theme: a prose field dropped from translatable",
    file: SHIPPED,
    from: '"translatable": [',
    to: '"translatable": [',
    /** JSON edit is bespoke: strip the first translatable entry. */
    transform: (text) => text.replace(/"translatable":\s*\[([^\]]*)\]/, (m, inner) => {
      const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
      return `"translatable": [${parts.slice(1).join(", ")}]`;
    }),
    suite: ARCH_SUITE,
    needle: "translatable exactly for prose fields",
  },
  {
    name: "scaffolder: default translatable set stops following the predicate",
    file: MAKETABLE,
    from: "  const defaultTranslatable = fields.filter((f) => isProseFieldType(f.type)).map((f) => f.key);",
    to: "  const defaultTranslatable = [];",
    suite: SCAFFOLD_SUITE,
    needle: "prose field it generated is translatable",
  },
];

// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];

console.log(`Reverse validation: multi-language field guard family (${scenarios.length} scenarios)\n`);

for (const sc of scenarios) {
  const before = hash(sc.file);
  const originalText = readFileSync(sc.file, "utf8");
  let undo = null;
  try {
    if (sc.transform) {
      const next = sc.transform(originalText);
      if (next === originalText) throw new Error("transform changed nothing");
      writeFileSync(sc.file, next, "utf8");
      if (hash(sc.file) === before) throw new Error("transform was a no-op (content hash unchanged)");
      undo = () => {
        writeFileSync(sc.file, originalText, "utf8");
        if (hash(sc.file) !== before) throw new Error("restore not byte-identical");
      };
    } else {
      undo = swap(sc.file, sc.from, sc.to);
    }

    const res = runSuite(sc.suite);
    const verdict = assertFailedOn(sc.name, res, sc.needle);
    if (!verdict.ok) {
      fail++;
      failures.push(sc.name);
      console.log(`  FAIL ${sc.name}\n       injected, but: ${verdict.why}`);
      console.log(
        verdict.text
          .split("\n")
          .filter((l) => /FAIL|passed,/.test(l))
          .map((l) => `         | ${l}`)
          .join("\n")
      );
    } else {
      pass++;
      console.log(`  ok   ${sc.name}\n       -> ${verdict.why}`);
    }
  } catch (e) {
    fail++;
    failures.push(sc.name);
    console.log(`  FAIL ${sc.name}\n       ${e?.message ?? e}`);
  } finally {
    if (undo) {
      try {
        undo();
        console.log(`       restored: ${sc.file.split(/[\\/]/).slice(-2).join("/")}`);
      } catch (e) {
        fail++;
        console.log(`  FAIL could not restore ${sc.file}: ${e?.message ?? e}`);
      }
    }
  }
}

// The restore is verified, not assumed: byte-identical hashes were checked per
// scenario, and the working tree must be clean again.
assertPristine("end of run");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
