/**
 * Reverse-validation for tests/suites/launcher-parity.test.mjs.
 *
 * A parity check that cannot go red is decoration. This tool injects one
 * violation at a time, runs the suite, asserts a *named* assertion fails, then
 * restores the file and asserts the hash came back.
 *
 * Three rules learned the hard way (AGENTS.md, "反向验证工具自身的三个铁律"):
 *   1. compare content hashes, never byte counts — `/shop/` -> `/blog/` is the
 *      same length and an equal-length replacement is invisible to a length guard
 *   2. assert the injection actually changed the bytes; "2 -> 2" is not evidence
 *   3. never use `git checkout` to restore — it cannot restore an untracked file
 *      and it fails silently. Snapshot the bytes here, and verify the restore.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SH = join(ROOT, "scripts", "cfpress.sh");
const PS1 = join(ROOT, "scripts", "cfpress.ps1");
const GA = join(ROOT, ".gitattributes");
const SUITE_REL = "tests/suites/launcher-parity.test.mjs";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

/**
 * Scenarios. Each names the file, an exact anchor, the replacement, and the
 * assertion text that must go red.
 */
const SCENARIOS = [
  {
    label: "a required action removed from the shell dispatch",
    file: SH,
    // `doctor` is on the required list; deleting its arm must make the
    // coverage assertion fail. (Adding an extra action does *not* — the check
    // is "the required set is covered", not "the dispatch has no extras".)
    before: "    doctor)           act_doctor ;;\n",
    after: "",
    expect: "every required action is dispatched by .sh",
  },
  {
    label: "a menu number renamed in the shell",
    file: SH,
    before: "      6) act_audit ;;",
    after: "      61) act_audit ;;",
    expect: "no menu number is offered only by",
  },
  {
    label: "a suite dropped from the powershell table",
    file: PS1,
    // Anchor on a row that exists in both tables and appears exactly once in
    // each. This used to be `theme-aurora`; when that theme was retired the row
    // was deleted from both launchers, and an anchor that matches nothing makes
    // the scenario **skip silently** — the "skipped is not passed" trap.
    before: "    'theme-fixture'      = 'tests/suites/theme-fixture.test.mjs'\n",
    after: "",
    expect: "no suite name is listed only by .sh",
  },
  {
    label: "a suite pointed at the wrong file in the powershell table",
    file: PS1,
    before: "'multisite'          = 'tests/suites/multisite.test.mjs'",
    after: "'multisite'          = 'tests/suites/i18n.test.mjs'",
    expect: "both suite tables agree on the file for each name",
  },
  {
    label: "the powershell deploy guard unwired from the deploy path",
    file: PS1,
    // Remove the guard call from Invoke-Deploy *and* from Invoke-DeployFull, so
    // the only surviving mentions are the definition itself. Removing just one
    // call site leaves the other satisfying the check — which is precisely what
    // the first version of this scenario exposed.
    //
    // ⚠️ The anchor carries a tail (`Assert-Deps` + the config step) because the
    // `if (-not $Force) { … }` block itself appears in both deploy functions and
    // would otherwise match twice. When `Invoke-Deploy` gained the
    // `Invoke-EnsureConfig` step, the old tail (`Write-Head 'wrangler deploy'`
    // immediately after `Assert-Deps`) stopped existing and this scenario would
    // have reported "anchor appears 0x" — a skipped scenario, not a failing one.
    before: "    if (-not $Force) {\n        if (-not (Test-DeployPrecheck)) { return 3 }\n    }\n    Assert-Deps\n    $rc = Invoke-EnsureConfig\n    if ($rc -ne 0) { return $rc }\n    Write-Head 'sync bundled themes",
    after: "    Assert-Deps\n    $rc = Invoke-EnsureConfig\n    if ($rc -ne 0) { return $rc }\n    Write-Head 'sync bundled themes",
    extra: (text) =>
      text.replace(
        "    if (-not $Force) {\n        if (-not (Test-DeployPrecheck)) { return 3 }\n    }\n    $rc = Invoke-MigrateRemote",
        "    $rc = Invoke-MigrateRemote"
      ),
    expect: "the powershell deploys through the guard (Invoke-Deploy)",
  },
  {
    label: "the BOM stripped from the powershell script",
    file: PS1,
    bomStrip: true,
    expect: "scripts/cfpress.ps1 starts with a UTF-8 BOM",
  },
  {
    label: "ErrorActionPreference switched back to Stop",
    file: PS1,
    before: "$ErrorActionPreference = 'Continue'",
    after: "$ErrorActionPreference = 'Stop'",
    expect: "scripts/cfpress.ps1 does not use ErrorActionPreference 'Stop'",
  },
  {
    label: "the shell stops treating a missing summary as failure",
    file: SH,
    before: "FAILED (no summary line — suite aborted or crashed)",
    after: "skipped",
    expect: "the shell treats a missing summary as failure",
  },
  {
    // The defect that was actually in the file: `wrangler deploy` with no `-c`,
    // so menu 7 deployed the committed template — the one with REPLACE_WITH_*
    // placeholders — instead of the generated config. It deploys "successfully"
    // and binds the Worker to a database that does not exist.
    label: "the shell deploys without pointing at the generated config",
    file: SH,
    before: 'npx --no-install wrangler deploy -c "$CONFIG"',
    after: "npx --no-install wrangler deploy",
    expect: "every wrangler command in .sh is pointed at the generated config",
  },
  {
    // A stale generated config is used silently, which is the failure mode this
    // whole design removes: the commands keep working, against last week's ids.
    label: "the shell stops regenerating the config before dev",
    file: SH,
    before: '  ensure_config || return $?\n  head1 "wrangler dev',
    after: '  head1 "wrangler dev',
    expect: "the shell regenerates the config before every action that reads it",
  },
  {
    label: "a menu number removed from the powershell menu",
    file: PS1,
    before: "            '^9$' { $null = Invoke-Doctor }\n",
    after: "",
    expect: "no menu number is offered only by .sh",
  },
  {
    label: "the shell menu prompt sent back to stdout",
    file: SH,
    before: "  printf '%s' \"$prompt\" >&2",
    after: "  printf '%s' \"$prompt\"",
    expect: "the shell prints the menu prompt to stderr, not stdout",
  },
  {
    label: "the shell menu loop no longer stops at end-of-input",
    file: SH,
    before: '      dim "  (end of input — leaving the menu)"\n      return 0\n',
    after: "      :\n",
    expect: "the shell menu ends on end-of-input instead of looping",
  },
  {
    label: "the powershell EOF guard removed (the 9.7 MB spin)",
    file: PS1,
    before: "    if ([Console]::IsInputRedirected -and -not [Console]::In.Peek()) { return $null }\n",
    after: "",
    expect: "the powershell detects redirected-empty stdin before calling Read-Host",
  },
  {
    label: "the powershell menu loop no longer stops at end-of-input",
    file: PS1,
    before: "        if ($null -eq $choice) {\n",
    after: "        if ($false) {\n",
    expect: "the powershell menu ends on end-of-input instead of looping",
  },
  {
    label: ".sh unpinned from LF (a CRLF checkout would break `sh`)",
    file: GA,
    before: "*.sh            text eol=lf",
    after: "*.sh            text",
    expect: ".gitattributes pins *.sh to eol=lf",
  },
  {
    label: "working-tree-encoding reintroduced (breaks `git add` on Git for Windows)",
    file: GA,
    // add a live line, not a comment, so the check cannot be satisfied by prose
    before: "*.ps1           text eol=crlf",
    after: "*.ps1           text eol=crlf working-tree-encoding=UTF-8-BOM",
    expect: ".gitattributes does not use working-tree-encoding",
  },
  {
    // The converse of "every suite in the table is in `npm test`": a suite that
    // exists on disk but appears in **none** of the four registries. This is the
    // observation-surface hole that let `plugin-channels.test.mjs` hide — all
    // three original assertions checked "a table entry exists elsewhere", so an
    // orphan file satisfied every one of them. Section 5b scans the real disk
    // listing instead.
    label: "a test suite exists on disk but is in no registry (orphan suite)",
    createFile: join(ROOT, "tests", "suites", "orphan-probe.test.mjs"),
    createBody: "process.exit(0);\n",
    expect: "every `tests/**/*.test.mjs` on disk is in the launcher table",
  },
];

// --- run a suite in a worker thread -----------------------------------------
// spawnSync is EBUSY in this sandbox, which would make every scenario report
// "no summary while injected" — i.e. disguise "could not run" as "did not go
// red". A worker thread runs the suite inside this process instead.
function runSuite(relPath) {
  return new Promise((resolvePromise) => {
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      // The suite's own process.exit must be the ONLY completion trigger.
      // import() resolves when the module body ends, which is *before*
      // main()'s first await returns — so an additional ".then(done)" call
      // terminates the worker mid-run and the suite reads as "no summary",
      // i.e. as "did not go red". A slow suite (esbuild compile) loses that
      // race deterministically; see the long note in _skeleton-inject.mjs.
      let reported = false;
      const done = (code) => {
        if (reported) return;
        reported = true;
        parentPort.postMessage({ out, code: code == null ? 0 : code });
      };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\nTHREW: " + (e && e.stack); done(1); });
    `;
    const w = new Worker(
      `const { parentPort } = require("node:worker_threads");\n${entry}`,
      { eval: true }
    );
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(v);
    };
    const timer = setTimeout(() => {
      finish({ out: out_so_far, code: 124, timedOut: true });
    }, 120000);
    let out_so_far = "";
    w.on("message", (m) => { out_so_far = m.out || out_so_far; finish(m); });
    w.on("error", (e) => finish({ out: String(e && e.stack), code: 1 }));
    w.on("exit", (c) => finish({ out: out_so_far, code: c == null ? 0 : c }));
  });
}

/** A run with no summary line is a FAILED run, never a pass. */
function parse(text) {
  const m = text.match(/^(\d+) passed, (\d+) failed(\s*\(aborted\))?/m);
  if (!m) return { aborted: true, passed: 0, failed: 0, names: [] };
  // Assertion names may carry a ` — detail` suffix and a parenthetical; match
  // on the stable prefix so `expect` can be written without the detail.
  const names = [...text.matchAll(/^\s+FAIL (.+)$/gm)].map((x) =>
    x[1].split(" — ")[0].trim()
  );
  return {
    aborted: !!m[3],
    passed: Number(m[1]),
    failed: Number(m[2]) + (m[3] ? 1 : 0),
    names,
  };
}

async function main() {
  // Any `createFile` scenario leaves a probe behind if this tool is killed
  // mid-run (an abort, a timeout). The probe is by design an unregistered
  // suite, so a leftover one makes the *next* run's baseline red for a reason
  // that has nothing to do with the guard under test — "the tool poisoned its
  // own pre-condition". Clear them before snapshotting, and say so.
  for (const sc of SCENARIOS) {
    if (sc.createFile && existsSync(sc.createFile)) {
      console.log(`clearing stale probe from a previous run: ${sc.createFile}`);
      rmSync(sc.createFile, { force: true });
      if (existsSync(sc.createFile)) {
        console.log(`  could not remove it (EBUSY?) — restore the tree by hand and re-run`);
        process.exit(1);
      }
    }
  }

  // Snapshot before doing anything, and prove the tree is clean first. Every
  // file any scenario can touch must be in here — a scenario targeting a file
  // that was not snapshotted would restore from `pristine.get(target)`
  // returning undefined and write the string "undefined" over the file.
  const WATCHED = [SH, PS1, GA];
  for (const p of WATCHED) {
    if (!existsSync(p)) {
      console.log(`missing watched file: ${p}`);
      process.exit(1);
    }
  }
  const pristine = new Map(WATCHED.map((p) => [p, readFileSync(p)]));
  const pristineHash = new Map([...pristine].map(([k, v]) => [k, sha(k)]));

  const baseline = parse((await runSuite(SUITE_REL)).out);
  if (baseline.failed !== 0 || baseline.aborted) {
    console.log(`baseline is not green: ${baseline.passed} passed, ${baseline.failed} failed`);
    console.log("fix the suite before reverse-validating it.");
    process.exit(1);
  }
  console.log(`baseline: ${baseline.passed} passed, 0 failed\n`);

  let problems = 0;

  for (const [i, sc] of SCENARIOS.entries()) {
    const target = sc.file;
    const originalBytes = pristine.get(target);

    let mutated;
    if (sc.createFile) {
      // A scenario whose defect *is* a file's existence. Nothing to mutate, but
      // the "did the injection land" rule still applies: the file must not have
      // pre-existed, or the scenario would be reading the previous run's state.
      if (existsSync(sc.createFile)) {
        console.log(`SKIP ${i + 1}. ${sc.label} — ${sc.createFile} already exists (stale tree)`);
        problems++;
        continue;
      }
    } else if (sc.bomStrip) {
      mutated = originalBytes[0] === 0xef ? originalBytes.subarray(3) : originalBytes;
      if (mutated === originalBytes) {
        console.log(`SKIP ${i + 1}. ${sc.label} — already had no BOM`);
        continue;
      }
    } else {
      const text = originalBytes.toString("utf8");
      if (!text.includes(sc.before)) {
        console.log(`SKIP ${i + 1}. ${sc.label} — anchor not found (harness is stale)`);
        problems++;
        continue;
      }
      let next = text.replace(sc.before, sc.after);
      // Some defects need two edits (unwiring a guard that has two call sites).
      if (sc.extra) next = sc.extra(next);
      mutated = Buffer.from(next, "utf8");
    }

    // Rule 2: prove the injection changed the bytes.
    const beforeHash = sc.createFile ? "<absent>" : sha(target);
    if (sc.createFile) {
      writeFileSync(sc.createFile, sc.createBody);
      if (!existsSync(sc.createFile)) {
        console.log(`SKIP ${i + 1}. ${sc.label} — could not create ${sc.createFile}`);
        problems++;
        continue;
      }
    } else {
      writeFileSync(target, mutated);
    }
    const afterHash = sc.createFile ? "<created>" : sha(target);
    if (!sc.createFile && beforeHash === afterHash) {
      console.log(`SKIP ${i + 1}. ${sc.label} — injection changed nothing (${beforeHash})`);
      problems++;
      writeFileSync(target, originalBytes);
      continue;
    }

    const verdict = parse((await runSuite(SUITE_REL)).out);
    // `expect` is a prefix: assertions carry parentheticals and detail suffixes
    // that the scenario should not have to reproduce verbatim.
    const hit = verdict.names.some((n) => n.startsWith(sc.expect));
    const wentRed = verdict.aborted || verdict.failed > 0;

    // Rule 3: restore, then verify the restore by hash (and by absence).
    if (sc.createFile) {
      rmSync(sc.createFile, { force: true });
    } else {
      writeFileSync(target, originalBytes);
    }
    const restored = sc.createFile
      ? !existsSync(sc.createFile)
      : sha(target) === pristineHash.get(target);

    const status = hit && restored ? "ok  " : "BAD ";
    if (!hit || !restored) problems++;
    console.log(
      `${status}${i + 1}. ${sc.label}\n` +
      `      injected ${beforeHash} -> ${afterHash}, restored=${restored}\n` +
      `      expected "${sc.expect}"\n` +
      `      got: ${verdict.aborted ? "ABORTED (no summary)" : `${verdict.failed} failed`}` +
      `${verdict.names.length ? ` [${verdict.names.join(" | ")}]` : ""}` +
      `${wentRed && !hit ? "  <- went red, but not where expected" : ""}`
    );
  }

  // Final cleanliness assertion: every watched file is byte-identical again.
  for (const [p, bytes] of pristine) {
    const now = readFileSync(p);
    if (!now.equals(bytes)) {
      console.log(`\nDIRTY: ${p} was not restored`);
      problems++;
    }
  }

  console.log(
    `\n${problems === 0 ? "ok" : "PROBLEMS"}: ${SCENARIOS.length} scenarios, ${problems} problem(s)`
  );
  if (problems === 0) {
    console.log("Every guard under test was observed to fail on its own defect.");
  }
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
