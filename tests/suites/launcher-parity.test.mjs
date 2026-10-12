/**
 * The launcher's own contract, checked rather than asserted in a comment.
 *
 * `scripts/cfpress.sh` and `scripts/cfpress.ps1` claim to be "two ways in, one
 * set of actions". A claim like that decays the moment someone adds an action to
 * one file and forgets the other — and the failure is silent, because a missing
 * action only shows up when somebody on the other OS needs it.
 *
 * So this suite parses both scripts and compares:
 *
 *   1. the action names each one dispatches (the command-mode surface)
 *   2. the menu numbers each one handles (the interactive surface)
 *   3. the test-suite table, name -> file, in both
 *   4. that every suite in the table exists on disk
 *   5. that the suite list matches `package.json`'s `test` chain
 *   6. that both refuse to deploy on unresolved placeholders
 *
 * The comparison is by *parsed structure*, not by substring. That distinction is
 * the whole point of AGENTS.md's guard-failure record: a check that greps for
 * `deploy` in both files passes even when one of them is missing the placeholder
 * guard entirely. Here the PowerShell branch labels and the shell `case` labels
 * are extracted as sets and compared as sets.
 *
 * Not in `npm test`'s fast path? It is — it is cheap (no Worker, no D1) and the
 * thing it guards is the entry point everyone touches first.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SH = join(ROOT, "scripts", "cfpress.sh");
const PS1 = join(ROOT, "scripts", "cfpress.ps1");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function checkEmpty(name, offenders) {
  check(name, offenders.length === 0, offenders.join(", "));
}

/**
 * The suite's summary line is unconditional, including on a throw. AGENTS.md's
 * sixth false green: a suite that dies before printing `N passed, M failed`
 * reads as "no failure" to any script that greps for a failure report.
 */
function summary(tag, aborted = false) {
  const line = `${passed} passed, ${failed} failed`;
  // The launcher's own parser anchors on `^N passed, M failed`, so the tag must
  // come *after* that phrase — never before it, and never inside it.
  console.log(`\n${line}${aborted ? " (aborted)" : ""}`);
}

process.on("uncaughtException", (e) => {
  failed++;
  failures.push(`uncaught: ${e && e.message}`);
  try {
    console.log(`  FAIL uncaught exception: ${e && e.stack}`);
  } catch {
    /* nothing else we can do */
  }
  summary("launcher-parity", true);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  failed++;
  failures.push(`unhandled: ${e && e.message}`);
  try {
    console.log(`  FAIL unhandled rejection: ${e && e.stack}`);
  } catch {
    /* nothing else we can do */
  }
  summary("launcher-parity", true);
  process.exit(1);
});

// --- extraction --------------------------------------------------------------

/**
 * Shell command-mode labels: the `foo)` arms of the dispatch `case`.
 *
 * Anchored on the `case "$action" in` block so the menu's `case "$choice" in`
 * arms (which are numbers) cannot be mistaken for actions. The arm lines are
 * matched loosely on indentation because a multi-line arm (`deploy)`) has its
 * body on following lines — only lines that open an arm are collected.
 */
function shActions(src) {
  const start = src.indexOf('case "$action" in');
  if (start === -1) return null;
  const end = src.indexOf("\n  esac", start);
  if (end === -1) return null;
  const out = new Set();
  for (const line of src.slice(start, end).split("\n")) {
    const arm = line.match(/^\s+([A-Za-z0-9_:\-|]+)\)(?:\s|$)/);
    if (!arm) continue;
    if (arm[1] === "*") continue;
    for (const label of arm[1].split("|")) out.add(label.trim());
  }
  return out;
}

/** Shell menu numbers: the `N)` arms of the `case "$choice" in` block. */
function shMenuNumbers(src) {
  const start = src.indexOf('case "$choice" in');
  if (start === -1) return null;
  const end = src.indexOf("\n  esac", start);
  if (end === -1) return null;
  const out = new Set();
  for (const line of src.slice(start, end).split("\n")) {
    const arm = line.match(/^\s+(\d+)\)/);
    if (arm) out.add(arm[1]);
  }
  return out;
}

/**
 * Strip comments so a check cannot be satisfied (or broken) by prose.
 *
 * This matters concretely: the PowerShell file's comment explaining *why* it
 * avoids `$ErrorActionPreference = 'Stop'` contains that exact string, so a
 * naive regex reports the script as using it. Prose is not code.
 */
function stripShComments(src) {
  // Remove whole-line `#` comments only; `#` inside a string is left alone
  // because the launcher's own output contains `#` in the deploy hint.
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

function stripPsComments(src) {
  // Drop the leading block comment and whole-line `#` comments.
  let out = src.replace(/<#[\s\S]*?#>/, "");
  out = out
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  return out;
}

/**
 * PowerShell command-mode labels: the string keys of the dispatch `switch`.
 *
 * Anchored on `switch ($Name)` so the menu's `switch -Regex ($choice...)` arms
 * (which are regexes like `'^1$'`) are not swept in.
 */
function psActions(src) {
  const m = src.match(/switch \(\$Name\) \{([\s\S]*?)\n    \}/);
  if (!m) return null;
  const out = new Set();
  for (const line of m[1].split("\n")) {
    const arm = line.match(/^\s{8}'([^']+)'\s*\{/);
    if (arm) out.add(arm[1]);
  }
  return out;
}

/** PowerShell menu numbers: the `'^N$'` arms of the menu switch. */
function psMenuNumbers(src) {
  const m = src.match(/switch -Regex \(\$choice\.Trim\(\)\) \{([\s\S]*?)\n        \}/);
  if (!m) return null;
  const out = new Set();
  for (const line of m[1].split("\n")) {
    const arm = line.match(/^\s{12}'\^(\d+)\$'/);
    if (arm) out.add(arm[1]);
  }
  return out;
}

/** PowerShell suite table: `'name' = 'tests/file.mjs'` inside $Script:Suites. */
function psSuites(src) {
  const m = src.match(/\$Script:Suites = \[ordered\]@\{([\s\S]*?)\n\}/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split("\n")) {
    const row = line.match(/^\s*'([^']+)'\s*=\s*'([^']+)'/);
    if (row) map.set(row[1], row[2]);
  }
  return map;
}

/** Shell suite table: the `name|tests/file` lines of SUITES. */
function shSuites(src) {
  const m = src.match(/SUITES="([\s\S]*?)"\n/);
  if (!m) return null;
  const map = new Map();
  for (const line of m[1].split("\n")) {
    const row = line.match(/^\s*([A-Za-z0-9_\-]+)\|(.+?)\s*$/);
    if (row) map.set(row[1], row[2]);
  }
  return map;
}

// --- run ---------------------------------------------------------------------

console.log("launcher parity (scripts/cfpress.sh <-> scripts/cfpress.ps1)\n");

const sh = readFileSync(SH, "utf8");
const ps = readFileSync(PS1, "utf8");

// 0. both files exist and are non-empty
check("scripts/cfpress.sh exists and is non-empty", sh.length > 1000, `${sh.length} bytes`);
check("scripts/cfpress.ps1 exists and is non-empty", ps.length > 1000, `${ps.length} bytes`);

// 1. extraction produced non-empty sets — an empty set makes every later
//    comparison vacuously true (AGENTS.md: "a check over an empty set is a
//    check that does not run").
const shAct = shActions(sh);
const psAct = psActions(ps);
const shMenu = shMenuNumbers(sh);
const psMenu = psMenuNumbers(ps);
const shSuite = shSuites(sh);
const psSuite = psSuites(ps);

check("parsed the shell dispatch table", !!shAct && shAct.size > 8, shAct ? `${shAct.size} actions` : "not found");
check("parsed the powershell dispatch table", !!psAct && psAct.size > 8, psAct ? `${psAct.size} actions` : "not found");
check("parsed the shell menu numbers", !!shMenu && shMenu.size > 5, shMenu ? `${shMenu.size} entries` : "not found");
check("parsed the powershell menu numbers", !!psMenu && psMenu.size > 5, psMenu ? `${psMenu.size} entries` : "not found");
check("parsed the shell suite table", !!shSuite && shSuite.size > 10, shSuite ? `${shSuite.size} suites` : "not found");
check("parsed the powershell suite table", !!psSuite && psSuite.size > 10, psSuite ? `${psSuite.size} suites` : "not found");

// Bail early rather than cascade if parsing failed — a null set would make the
// next comparisons throw, and a thrown suite prints no summary.
if (!shAct || !psAct || !shMenu || !psMenu || !shSuite || !psSuite) {
  summary("launcher-parity", true);
  process.exit(1);
}

// 2. menu numbers identical
{
  const onlySh = [...shMenu].filter((n) => !psMenu.has(n));
  const onlyPs = [...psMenu].filter((n) => !shMenu.has(n));
  // Name the *offender*, not the reference: "numbers only .sh offers" reads
  // correctly what "missing from .sh" got backwards.
  checkEmpty("no menu number is offered only by .sh", onlySh);
  checkEmpty("no menu number is offered only by .ps1", onlyPs);
}

// 3. The primitive names behind the menu must match. The shell uses
//    `act_xxx`, PowerShell uses `Invoke-Xxx`; compare the normalised tails so a
//    `3` that runs `act_theme_deploy` in one and something else in the other is
//    caught.
function normName(s) {
  return s
    .replace(/^(act_|invoke-)/i, "")
    .replace(/_/g, "")
    .toLowerCase();
}
{
  // Both extractors take the *first* action call in each arm, because 3/7/8 are
  // multi-line arms in both files (`3) theme=...; act_theme_deploy ...` and
  // `'^3$' { $t = Read-...; $null = Invoke-ThemeDeploy $t }`). Matching only the
  // first line — or only up to the first `}` — silently drops those three and
  // makes the comparison look like a mismatch in the scripts.
  const shPrim = new Set();
  const start = sh.indexOf('case "$choice" in');
  const end = sh.indexOf("\n  esac", start);
  const body = sh.slice(start, end);
  for (const chunk of body.split(";;")) {
    const num = chunk.match(/(?:^|\n)\s+(\d+)\)/);
    if (!num) continue;
    const call = chunk.match(/act_[a-z_]+/);
    if (call) shPrim.add(`${num[1]}:${normName(call[0])}`);
  }

  const psPrim = new Set();
  const psBody = ps.slice(ps.indexOf("switch -Regex ($choice.Trim()) {"));
  const psEnd = psBody.indexOf("\n        }");
  let lastNum = null;
  for (const line of psBody.slice(0, psEnd).split("\n")) {
    const arm = line.match(/^\s{12}'\^(\d+)\$'\s*\{/);
    if (arm) {
      lastNum = arm[1];
      // `'^3$' { $t = ... }` is one line; take a call from it if present.
      const inline = line.match(/Invoke-[A-Za-z]+/);
      if (inline) psPrim.add(`${lastNum}:${normName(inline[0])}`);
      continue;
    }
    // A non-numbered arm (`'^v$'`, `'^t2\s+...'`) ends the numbered section;
    // its body must not be attributed to the last number seen.
    if (/^\s{12}'/.test(line)) { lastNum = null; continue; }
    if (lastNum) {
      const call = line.match(/Invoke-[A-Za-z]+/);
      if (call) psPrim.add(`${lastNum}:${normName(call[0])}`);
    }
  }

  const onlySh = [...shPrim].filter((x) => !psPrim.has(x));
  const onlyPs = [...psPrim].filter((x) => !shPrim.has(x));
  checkEmpty("menu number -> action mapping matches (from .sh)", onlySh);
  checkEmpty("menu number -> action mapping matches (from .ps1)", onlyPs);
  check("the menu mapping table is non-trivial", shPrim.size >= 5, `${shPrim.size} mapped numbers`);
  check(
    "the menu mapping covers numbers 1-9",
    [...Array(9).keys()].every((i) => shPrim.has(`${i + 1}:`) || [...shPrim].some((k) => k.startsWith(`${i + 1}:`))),
    [...shPrim].sort().join(" ")
  );
}

// 4. suite tables identical, name -> file
{
  const onlySh = [...shSuite.keys()].filter((k) => !psSuite.has(k));
  const onlyPs = [...psSuite.keys()].filter((k) => !shSuite.has(k));
  checkEmpty("no suite name is listed only by .sh", onlySh);
  checkEmpty("no suite name is listed only by .ps1", onlyPs);

  const mismatched = [];
  for (const [name, file] of shSuite) {
    if (psSuite.has(name) && psSuite.get(name) !== file) {
      mismatched.push(`${name}: sh=${file} ps1=${psSuite.get(name)}`);
    }
  }
  checkEmpty("both suite tables agree on the file for each name", mismatched);
}

// 5. every suite file exists on disk
{
  const missing = [];
  for (const [name, file] of shSuite) {
    if (!existsSync(join(ROOT, file))) missing.push(`${name} -> ${file}`);
  }
  checkEmpty("every suite file in the table exists on disk", missing);
}

// 5b. the converse — every suite on disk is in the table.
//     Without this arrow, a suite that is missing from *all* the registries is
//     invisible: section 6 compares the table against `npm test`, and if a file
//     is absent from both, that comparison happily passes. `plugin-channels`
//     sat in exactly that hole — it existed, ran green, and was listed by
//     neither the launcher nor `npm test`.
//
//     The scan is recursive over `tests/`: suites live in `tests/suites/`, but a
//     future suite dropped at the root would be just as invisible, so the walk
//     does not assume the layout.
//
//     Only `*.test.mjs` is required to be registered. The `_`-prefixed tools in
//     `tests/tools/` (`_schema-scope.mjs`, `_*-inject.mjs`, …) are exempt: they
//     are tooling run by hand or by a dedicated entry, and `_schema-scope` is in
//     the chain while the injectors deliberately are not.
{
  const suitesOnDisk = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".test.mjs")) suitesOnDisk.push(child);
    }
  };
  walk("tests");
  const inTable = new Set(shSuite.values());
  const unregistered = suitesOnDisk.filter((f) => !inTable.has(f));
  checkEmpty("every `tests/**/*.test.mjs` on disk is in the launcher table", unregistered);
  check(
    "the disk scan found the suites (the check is not vacuous)",
    suitesOnDisk.length > 10,
    `${suitesOnDisk.length} suite files on disk`
  );

  // 5c. every suite's crash path prints a summary.
  //
  // AGENTS.md's sixth false green: a suite that dies before printing
  // `N passed, M failed` leaves nothing for a script to read, and "no summary"
  // is silently read as "no failure" — the reader cannot tell "green" from
  // "crashed". The rule has been in prose since batch 4, yet by batch 24
  // **eight** suites had drifted out of it: their `catch` exited with a code
  // and printed no summary, so an injected defect that crashed a suite
  // surfaced as `no summary (aborted)` — i.e. as a broken *tool*, not a caught
  // defect. A convention with no mechanism is a convention that decays, so this
  // asserts it mechanically: from a suite's LAST crash handler to the end of
  // the file, the text must contain the summary (a `summary()`/`finish()`
  // call, or the `passed, … failed` phrase). Recording an error and still
  // reporting — `catch { bootError = e }` then assert — is allowed, because the
  // run does self-report.
  {
    // A crash construct. Anchored to the start of a line on purpose: this
    // guard's own source contains these strings as *data*, and an unanchored
    // search finds itself, then checks the wrong block.
    const CRASH = /^[ \t]*(?:\} catch\b|main\(\)\.catch\(|process\.on\("(?:uncaughtException|unhandledRejection)")/m;
    const SUMMARY = /\b(?:summary|finish|report)\s*\(|passed,[^\n]*failed/;
    const offenders = [];
    for (const rel of suitesOnDisk) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const re = new RegExp(CRASH.source, "gm");
      let m;
      let last = -1;
      while ((m = re.exec(src)) !== null) {
        last = m.index;
        re.lastIndex = m.index + 1;
      }
      if (last < 0) {
        offenders.push(`${rel} (no crash handler at all)`);
        continue;
      }
      if (!SUMMARY.test(src.slice(last))) {
        offenders.push(`${rel} (no summary after its last crash handler)`);
      }
    }
    checkEmpty("every suite's crash path prints a summary (AGENTS.md type 6)", offenders);
    check(
      "the crash-path scan saw the suites (the check is not vacuous)",
      suitesOnDisk.length > 20,
      `${suitesOnDisk.length} suites scanned`
    );
  }

  // 5d. a suite's database reads are null-safe.
  //
  // The sibling of 5c, and the reason 5c is not enough. A suite that reads a
  // row which is **not there** and immediately takes a property off it does not
  // fail — it throws: `sqlite.prepare(...).get(...).title` is `TypeError:
  // Cannot read properties of undefined (reading 'title')`. 5c then makes it
  // print `(aborted)`, which is honest and still useless to the
  // reverse-validation tool: the tool looks for the **named assertion** among
  // the failures, and an abort has no failures at all, so a caught defect is
  // reported as `no summary while injected` — a broken tool, not a caught
  // defect. That is exactly what happened twice in one batch, both times in a
  // fixture whose setup the injected defect itself had broken, so the row the
  // assertion wanted never existed.
  //
  // The fix is `?.` on the result, and `String(x ?? "")` on a *bind* — binding
  // `undefined` throws `Provided value cannot be bound to SQLite parameter 1`.
  // The rule is stated as "a database read is never dereferenced without `?.`"
  // rather than "…unless the query is a COUNT", because the coarse rule is one
  // line and the fine one wants a SQL parser; `.get()?.n` on a COUNT is exactly
  // as correct, and uniform code is code a reader can check at a glance.
  //
  // Scoped to `sqlite.prepare(…)`: a `Map.get(k).push(…)` is a different method
  // on a different object, and flagging it would be a guard that fails correct
  // code — which is a guard that gets switched off.
  {
    // Read *code*, not prose. This block's own explanation names the defect
    // shape (`` `sqlite.prepare(...).get(...).title` ``) as an example, and the
    // first run of this guard fired on exactly those two comment lines — the
    // same self-reference 5c documents. Blanking comments keeps every line
    // number in place (the newlines survive), which matters: an offender list
    // that points at the wrong line is a list people learn to ignore.
    const blankComments = (s) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent);
    // One level of nested parens, which is what a `String(x ?? "")` bind needs.
    const GET = /\.get\((?:[^()]|\([^()]*\))*\)\s*\.(?!\?)/g;
    const offenders = [];
    for (const rel of suitesOnDisk) {
      const src = blankComments(readFileSync(join(ROOT, rel), "utf8"));
      let m;
      GET.lastIndex = 0;
      while ((m = GET.exec(src)) !== null) {
        // Only a *database* read: the enclosing statement (back to the last
        // `;`) must contain `.prepare(`. The window bounds the backward look.
        const stmt = src.slice(Math.max(0, m.index - 600), m.index).split(";").pop();
        if (!/\.prepare\(/.test(stmt)) continue;
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    checkEmpty("every suite's database read is null-safe (?. on the result)", offenders);
    check(
      "the null-safe scan saw the reads (the check is not vacuous)",
      suitesOnDisk.some((f) => /\.prepare\(/.test(readFileSync(join(ROOT, f), "utf8"))),
      "no suite contains a `.prepare(` call"
    );
  }
}

// 6. the table covers package.json's `test` chain — otherwise the launcher and
//    `npm test` disagree about what "all the tests" means, and the launcher
//    quietly runs a subset.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const chain = pkg.scripts.test || "";
  const inChain = new Set();
  for (const m of chain.matchAll(/node\s+(tests\/[^\s&]+)/g)) inChain.add(m[1]);
  const missingFromLauncher = [...inChain].filter((f) => ![...shSuite.values()].includes(f));
  const missingFromChain = [...shSuite.values()].filter((f) => !inChain.has(f));
  checkEmpty("every suite in `npm test` is in the launcher table", missingFromLauncher);
  checkEmpty("every suite in the launcher table is in `npm test`", missingFromChain);
  check("the parsed test chain is non-empty", inChain.size > 10, `${inChain.size} suites in chain`);
}

// 7. command-mode action coverage: the nouns a user will type must exist in
//    both. The PowerShell file additionally accepts `-h`/`--help`/`-v`/`--version`
//    (PowerShell-style) while the shell accepts the same plus `help`/`version`;
//    compare only the shared, meaningful verbs.
{
  const required = [
    "dev",
    "test",
    "deploy",
    "doctor",
    "install",
    "version",
    "make",
    "audit",
    "typecheck",
    "theme",
    "seed",
  ];
  checkEmpty("every required action is dispatched by .sh", required.filter((a) => !shAct.has(a)));
  checkEmpty("every required action is dispatched by .ps1", required.filter((a) => !psAct.has(a)));
}

// 8. the deploy guard exists in both. This is a structural check, and it has to
//    be written carefully: an earlier version asked only whether
//    `Test-DeployPrecheck` appeared *somewhere* outside its own definition, and
//    the surviving call in `Invoke-DeployFull` kept it green after the call in
//    `Invoke-Deploy` had been deleted. So each function body is extracted
//    individually and asked directly.
{
  // --- shell: guard defined, and called from both deploy entry points ---
  const shBody = (name) => {
    const i = sh.indexOf(`\n${name}() {`);
    if (i === -1) return null;
    const j = sh.indexOf("\n}\n", i);
    return j === -1 ? null : sh.slice(i, j);
  };
  const shDeploy = shBody("act_deploy");
  const shDeployFull = shBody("act_deploy_full");
  check("the shell defines the placeholder guard", /placeholders_found\(\)\s*\{/.test(sh));
  check("the shell defines deploy_precheck", /deploy_precheck\(\)\s*\{/.test(sh));
  check("the shell defines act_deploy", !!shDeploy);
  check("the shell defines act_deploy_full", !!shDeployFull);
  check(
    "the shell deploys through the guard (act_deploy)",
    !!shDeploy && /deploy_precheck/.test(shDeploy),
    "the guard exists but act_deploy does not consult it"
  );
  check(
    "the shell deploys through the guard (act_deploy_full)",
    !!shDeployFull && /deploy_precheck/.test(shDeployFull),
    "the guard exists but act_deploy_full does not consult it"
  );
  check("the shell exits 3 when it refuses", /return 3/.test(sh));

  // --- powershell: same, per function body ---
  const psBody = (name) => {
    const i = ps.indexOf(`function ${name} {`);
    if (i === -1) return null;
    // walk braces so a nested `}` does not truncate the body
    let depth = 0;
    for (let j = ps.indexOf("{", i); j < ps.length; j++) {
      if (ps[j] === "{") depth++;
      else if (ps[j] === "}") {
        depth--;
        if (depth === 0) return ps.slice(i, j + 1);
      }
    }
    return null;
  };
  const psDeploy = psBody("Invoke-Deploy");
  const psDeployFull = psBody("Invoke-DeployFull");
  check("the powershell defines the placeholder reader", /function Get-Placeholders/.test(ps));
  check("the powershell defines Test-DeployPrecheck", /function Test-DeployPrecheck/.test(ps));
  check("the powershell defines Invoke-Deploy", !!psDeploy);
  check("the powershell defines Invoke-DeployFull", !!psDeployFull);
  check(
    "the powershell deploys through the guard (Invoke-Deploy)",
    !!psDeploy && /Test-DeployPrecheck/.test(psDeploy),
    "the guard exists but Invoke-Deploy does not consult it"
  );
  check(
    "the powershell deploys through the guard (Invoke-DeployFull)",
    !!psDeployFull && /Test-DeployPrecheck/.test(psDeployFull),
    "the guard exists but Invoke-DeployFull does not consult it"
  );
  check("the powershell exits 3 when it refuses", /return 3/.test(ps));
}

// 8b. Every wrangler command must be pointed at the *generated* config, and the
//     generator must run first.
//
//     This is the rule the launcher used to break: `act_deploy` ran
//     `wrangler deploy` with no `-c` at all, so menu 7 deployed the committed
//     template — the file that carries REPLACE_WITH_* placeholders — and the
//     refusal message told the operator to paste their real ids into it, which
//     is tracked by git. A leak on the next commit, and a deploy config free to
//     drift from the one everything else used.
//
//     Scanned as *lines*, and matched on the **invocation** rather than on the
//     subcommand alone. Two things would otherwise trip it: the refusal message
//     legitimately contains `npx wrangler d1 create` (advice, not a command),
//     and each action prints a progress line like `head1 "wrangler deploy"`.
//     Both launchers invoke wrangler only through `npx` / `Invoke-Npx` — that is
//     deliberate on Windows, where the bare `wrangler` shim is a `.ps1` that
//     cannot be spawned — so anchoring on the wrapper is the precise test.
{
  const shCmd = /\bnpx\b[^\n]*\bwrangler\s+(?:dev\b|deploy\b|d1\s+migrations\s+apply\b)/;
  const psCmd = /\bInvoke-Npx\b[^\n]*\bwrangler\s+(?:dev\b|deploy\b|d1\s+migrations\s+apply\b)/;
  const offenders = (src, re, configRef) =>
    src
      .split("\n")
      .filter((l) => re.test(l))
      .filter((l) => !l.includes(configRef))
      .map((l) => l.trim());

  const shBad = offenders(stripShComments(sh), shCmd, '-c "$CONFIG"');
  const psBad = offenders(stripPsComments(ps), psCmd, '-c $ConfigFile');
  checkEmpty("every wrangler command in .sh is pointed at the generated config", shBad);
  checkEmpty("every wrangler command in .ps1 is pointed at the generated config", psBad);
  // Non-vacuity: a rename of the wrapper, or a switch to `wrangler.toml`, would
  // silently empty the scan — and an empty scan passes. The shell has four
  // config-dependent commands (dev, deploy, and the two migration applies).
  const shCommands = stripShComments(sh).split("\n").filter((l) => shCmd.test(l)).length;
  const psCommands = stripPsComments(ps).split("\n").filter((l) => psCmd.test(l)).length;
  check(
    "the wrangler-command scan actually found commands (non-vacuity)",
    shCommands >= 4 && psCommands >= 4,
    `${shCommands} in .sh, ${psCommands} in .ps1`
  );

  // The generator has to run before anything that consumes its output, or a
  // stale file is used silently — which is the whole failure this design exists
  // to remove.
  const shNeedsConfig = ["act_dev", "act_migrate_local", "act_migrate_remote", "act_deploy"];
  const shMissing = shNeedsConfig.filter((fn) => {
    const i = sh.indexOf(`\n${fn}() {`);
    if (i === -1) return true;
    const j = sh.indexOf("\n}\n", i);
    return j === -1 || !/ensure_config/.test(sh.slice(i, j));
  });
  checkEmpty("the shell regenerates the config before every action that reads it", shMissing);

  const psNeedsConfig = ["Invoke-Dev", "Invoke-MigrateLocal", "Invoke-MigrateRemote", "Invoke-Deploy"];
  const psMissing = psNeedsConfig.filter((fn) => {
    const i = ps.indexOf(`function ${fn} {`);
    if (i === -1) return true;
    let depth = 0;
    for (let j = ps.indexOf("{", i); j < ps.length; j++) {
      if (ps[j] === "{") depth++;
      else if (ps[j] === "}") {
        depth--;
        if (depth === 0) return !/Invoke-EnsureConfig/.test(ps.slice(i, j + 1));
      }
    }
    return true;
  });
  checkEmpty("the powershell regenerates the config before every action that reads it", psMissing);
}

// 9. Both must treat "no summary line" as failure, which is the rule they are
//    named after in AGENTS.md.
{
  check(
    "the shell treats a missing summary as failure",
    /no summary line/.test(sh) && /FAILED \(no summary line/.test(sh)
  );
  check(
    "the powershell treats a missing summary as failure",
    /no summary line/.test(ps) && /FAILED \(no summary line/.test(ps)
  );
}

// 10. The PowerShell file must carry a UTF-8 BOM. Without it Windows PowerShell
//     5.1 reads the file as ANSI/GBK, and every Chinese label in the menu turns
//     into mojibake at parse time — a defect that cannot be seen on PowerShell 7
//     or in a text editor.
{
  const raw = readFileSync(PS1);
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  check("scripts/cfpress.ps1 starts with a UTF-8 BOM (PS 5.1 reads non-BOM as ANSI)", bom);
}

// 11. Not `$ErrorActionPreference = 'Stop'`. In PS 5.1 that turns any native
//     stderr line into a terminating error; every suite here prints a node
//     ExperimentalWarning to stderr, so the launcher would die on the first one.
//     Checked against comment-stripped source, because the file explains this
//     rule in prose and the prose contains the very string being banned.
{
  const stopDecl = /\$ErrorActionPreference\s*=\s*['"]Stop['"]/.test(stripPsComments(ps));
  check("scripts/cfpress.ps1 does not use ErrorActionPreference 'Stop'", !stopDecl);
  const contDecl = /\$ErrorActionPreference\s*=\s*['"]Continue['"]/.test(stripPsComments(ps));
  check("scripts/cfpress.ps1 sets ErrorActionPreference to 'Continue' explicitly", contDecl);
}

// 12. The menu prompt must be printed on stderr, never stdout. Callers use
//     `choice=$(menu_read ...)`; a prompt written to stdout is captured into
//     the answer, so every choice arrives as "  > 9" and no menu arm matches.
//     The symptom is a menu that accepts nothing while looking fine.
{
  const shMenuFn = (() => {
    const i = sh.indexOf("menu_read() {");
    if (i === -1) return null;
    const j = sh.indexOf("\n}", i);
    return j === -1 ? null : sh.slice(i, j);
  })();
  check("the shell defines menu_read", !!shMenuFn);
  check(
    "the shell prints the menu prompt to stderr, not stdout",
    !!shMenuFn && /\$prompt"\s*>&2/.test(shMenuFn.replace(/\n\s*/g, " ")),
    "prompt goes to stdout and will be captured into the answer"
  );

  // The same class of bug in the PowerShell version: Read-Host writes the
  // prompt to the host, not the pipeline, so it is safe by construction — but
  // assert that it uses Read-Host rather than Write-Host + Read-*.
  check(
    "the powershell reads menu input via Read-Host",
    /function Read-MenuInput[\s\S]{0,400}Read-Host/.test(ps)
  );
}

// 13. The menu loop must terminate when input runs out, rather than spinning on
//     an empty choice. `printf 'a\nq\n' | cfpress.sh` is how a check drives it,
//     and a loop that treats EOF as "ask again" hangs the caller.
//
//     This bit the PowerShell version concretely: Read-Host reads the console,
//     so with no console it returns nothing, and the pre-fix loop wrote menu
//     frames forever — a 9.7 MB log in under a minute. The guard must detect
//     end-of-input *before* calling Read-Host, because after the fact there is
//     nothing to distinguish "no console" from "user pressed Enter".
{
  check(
    "the shell menu ends on end-of-input instead of looping",
    /end of input/.test(sh) && /return 0/.test(sh.slice(sh.indexOf("menu_loop()"))),
    "EOF would spin forever"
  );
  check(
    "the powershell menu ends on end-of-input instead of looping",
    /end of input/.test(ps) && /if \(\$null -eq \$choice\)/.test(ps),
    "EOF would spin forever"
  );
  check(
    "the powershell detects redirected-empty stdin before calling Read-Host",
    /\[Console\]::IsInputRedirected\s*-and\s*-not\s*\[Console\]::In\.Peek\(\)/.test(ps),
    "without this, Read-Host returns nothing and the loop cannot tell why"
  );
  check(
    "the powershell menu survives a host with no RawUI",
    /if \(-not \$Host\.UI\.RawUI\) \{ return \$null \}/.test(ps)
  );
}

// 14. Line endings are load-bearing for these two files, and `core.autocrlf`
//     (the Windows default, true here) would otherwise rewrite them on checkout.
//
//     - A `.sh` checked out with CRLF dies under `sh`: every line ends in `\r`,
//       so the shebang becomes `sh\r` and arguments arrive mangled. The classic
//       symptom is `\r: command not found`.
//     - A `.ps1` is happier with CRLF on Windows, and its BOM must survive.
//
//     `.gitattributes` pins both. Without it the behaviour depends on each
//     developer's git config, which is exactly the kind of thing that works on
//     the machine it was written on.
{
  const gaPath = join(ROOT, ".gitattributes");
  check(".gitattributes exists", existsSync(gaPath));
  if (existsSync(gaPath)) {
    const ga = readFileSync(gaPath, "utf8");

    // Parse the live attribute lines rather than spawning `git check-attr`:
    // this sandbox cannot reliably spawn child processes, and a check that
    // reports "could not ask git" as a failure is really reporting on the
    // harness. Comments are stripped for the same reason as elsewhere — the
    // file *explains* the encoding attribute it must not use.
    const live = ga
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && l.trim())
      .join("\n");

    check(
      ".gitattributes pins *.sh to eol=lf",
      /^\*\.sh\s+.*\beol=lf\b/m.test(live),
      "a CRLF checkout makes `sh scripts/cfpress.sh` die on '\\r: command not found'"
    );
    check(
      ".gitattributes pins *.ps1 to eol=crlf",
      /^\*\.ps1\s+.*\beol=crlf\b/m.test(live)
    );
    check(
      ".gitattributes pins the script-format extensions to LF",
      ["mjs", "cjs", "json", "sql"].every((ext) =>
        new RegExp(`^\\*\\.${ext}\\s+.*\\beol=lf\\b`, "m").test(live)
      )
    );

    // `working-tree-encoding=UTF-8-BOM` looks like the right way to pin the BOM,
    // but Git for Windows ships an iconv that does not know that encoding, and
    // `git add` then fails outright:
    //     error: failed to encode '…' from UTF-8-BOM to UTF-8
    // An attribute that breaks `git add` on the target platform is worse than
    // no attribute, so the BOM is asserted in this suite instead.
    check(
      ".gitattributes does not use working-tree-encoding (Git for Windows iconv cannot convert it)",
      !/working-tree-encoding/.test(live),
      "this makes `git add` fail with 'failed to encode … from UTF-8-BOM to UTF-8'"
    );
  }

  // The BOM is therefore the writer's responsibility and must be checked here.
  const rawBytes = readFileSync(PS1);
  check(
    "scripts/cfpress.ps1 really carries its BOM on disk (the gitattributes fallback relies on this)",
    rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf
  );
}

summary("launcher-parity");
process.exit(failed === 0 ? 0 : 1);
