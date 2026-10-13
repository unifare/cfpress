/**
 * Drive every scenario in `_fixture-inject.mjs` and report, per scenario, which
 * named assertion went red — then restore and confirm the suite is green again.
 *
 * ## Why this exists as a script and not a `for` loop in a shell
 *
 * This sandbox cannot spawn a child process: `spawnSync` fails with `EBUSY`
 * because the managed node binary is locked (the same reason `npm test` reports
 * SKIP here). A driver that shells out to `node tests/suites/theme-fixture.test.mjs`
 * therefore cannot run at all — and "cannot run" would look like "no failures"
 * if the driver's own error handling were sloppy.
 *
 * So both halves are imported into *one* process. The suite reads the theme
 * from disk on every run, and the injector mutates the theme on disk, so the
 * loop is faithful: it is the same bytes a `node` invocation would see.
 *
 * ## What it proves
 *
 * Three things per scenario, all of which have failed before in this repo:
 *
 *   1. the injection **landed** (the injector throws otherwise, on a hash);
 *   2. the suite **went red**, and this prints *which* assertion — because
 *      "red somewhere" and "red at the right assertion" need opposite fixes;
 *   3. the restore **worked** (the suite is green again on the next iteration).
 *
 * A scenario that never reddens is reported as DEAD. A run with **no summary**
 * is reported as a failure too: a summary-less run is a crashed run, and this
 * repo has twice mistaken "grep matched nothing" for "no failures".
 *
 * Usage: node tests/tools/_fixture-inject-verify.mjs
 * Not part of `npm test` — it is a tool, like the injector it drives.
 */
import { SCENARIOS, snapshot, restore } from "./_fixture-inject.mjs";

const realLog = console.log;
const realError = console.error;
let captured = [];
let capturing = false;
console.log = (...args) => { if (capturing) captured.push(args.join(" ")); else realLog(...args); };
console.error = (...args) => { if (capturing) captured.push(args.join(" ")); else realError(...args); };

// The suite ends with `process.exit(code)`, which would take this driver down.
// Trap it so a run returns a code instead of terminating the process.
const realExit = process.exit;
let exitCode = 0;
class ExitSignal extends Error { constructor(code) { super("exit " + code); this.code = code; } }
process.exit = (code) => { exitCode = code; throw new ExitSignal(code); };
/** The driver's own exit: bypasses the trap, which exists for the suite alone. */
const die = (code) => { process.exit = realExit; realExit(code); };

// ESM caches by resolved URL. A strictly increasing counter guarantees each run
// is a distinct module instance, so the suite really executes every time. Using
// `Date.now()` was a bug: two runs inside one millisecond share a URL, the
// second is a cache hit, and the driver silently measures the *previous* run's
// output — the "assertion describes the last run's artifact" failure mode.
let runSeq = 0;

async function suiteOnce() {
  captured = [];
  capturing = true;
  exitCode = 0;
  try {
    // ⚠️ `../suites/`, not `./`: the suite lives under `tests/suites/` since
    // the repository was regrouped (`a604c63`), and this import was left
    // pointing at `tests/tools/`. It therefore threw ERR_MODULE_NOT_FOUND on
    // every run, which `suiteOnce` reports as `summary: "<threw>"` — and the
    // driver then refused to continue with "baseline is already red". A broken
    // *harness* reads as a broken tree, so the whole 10-scenario
    // reverse-validation of the theme fixture had been silently unrunnable.
    await import(`../suites/theme-fixture.test.mjs?run=${++runSeq}`);
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      capturing = false;
      return { failed: [`harness threw: ${(e && e.message) || e}`], summary: "<threw>", code: 2 };
    }
  }
  capturing = false;
  const failed = captured.filter((l) => l.includes("FAIL ")).map((l) => l.slice(l.indexOf("FAIL ") + 5).split("\n")[0].trim());
  // The suite prints its summary as `\n${pass} passed, ${fail} failed`, so the
  // captured line starts with a newline — `^` would anchor before it and never
  // match. Keep the newline out of the pattern.
  const summary = captured.map((l) => l.trim()).find((l) => /^\d+ passed, \d+ failed/.test(l)) ?? null;
  return { failed, summary, code: exitCode };
}

// NOTE: `process.exit` stays trapped for the whole run. Restoring it before the
// loop (which an earlier version did) means the very first suite run calls the
// real `process.exit(0)` and silently terminates the driver — no output, exit
// 0, indistinguishable from success. The trap is removed only on the final line.
const baseline = await suiteOnce();
if (baseline.summary === null) {
  realLog("baseline produced NO SUMMARY — that is a crashed run, not a pass.");
  realLog(captured.slice(-10).join("\n"));
  die(1);
}
realLog(`baseline: ${baseline.summary}`);
if (baseline.code !== 0) {
  realLog("baseline is already red — fix the tree before running this tool.");
  die(1);
}

const rows = [];
for (const name of Object.keys(SCENARIOS)) {
  try { snapshot(); } catch (e) {
    realLog(`cannot snapshot before "${name}": ${e.message}`);
    die(1);
  }
  let injectError = null;
  try { SCENARIOS[name](); } catch (e) { injectError = e.message; }

  const red = injectError ? null : await suiteOnce();

  restore();
  const back = await suiteOnce();

  rows.push({
    name,
    injected: injectError === null,
    injectError,
    red: red ? red.failed : [],
    summary: red ? red.summary : null,
    restored: back.code === 0 && back.summary !== null,
  });
}

realLog("");
realLog("scenario".padEnd(34) + "red  restored  assertion(s) that went red");
for (const r of rows) {
  if (!r.injected) { realLog(r.name.padEnd(34) + "—    —         INJECTION FAILED: " + r.injectError); continue; }
  if (r.summary === null) { realLog(r.name.padEnd(34) + "—    " + String(r.restored).padEnd(10) + "RUN ABORTED (no summary)"); continue; }
  realLog(r.name.padEnd(34) + String(r.red.length).padEnd(5) + String(r.restored).padEnd(10) + (r.red.join(" | ") || "—"));
}

const dead = rows.filter((r) => r.injected && r.red.length === 0);
const aborted = rows.filter((r) => r.injected && r.summary === null);
const notInjected = rows.filter((r) => !r.injected);
const brokenRestore = rows.filter((r) => !r.restored);
realLog("");
realLog(
  `${rows.length} scenarios; ${dead.length} never reddened; ` +
  `${aborted.length} aborted; ${notInjected.length} failed to inject; ${brokenRestore.length} failed to restore.`
);
if (dead.length) realLog("DEAD SCENARIOS: " + dead.map((r) => r.name).join(", "));
if (aborted.length) realLog("ABORTED: " + aborted.map((r) => r.name).join(", "));
if (notInjected.length) realLog("NOT INJECTED: " + notInjected.map((r) => r.name).join(", "));
if (brokenRestore.length) realLog("BROKEN RESTORE: " + brokenRestore.map((r) => r.name).join(", "));
die(dead.length || aborted.length || notInjected.length || brokenRestore.length ? 1 : 0);
