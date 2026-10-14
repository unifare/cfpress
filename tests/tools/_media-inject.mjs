/**
 * Reverse-validation for the media isolation guards (AGENTS.md rule 60).
 *
 * ## What this proves
 *
 * `tests/suites/media.test.mjs` and the "media read path" section of
 * `architecture.test.mjs` now assert that `media_files`' two axes — tenant and
 * owner — are enforced on **both** doors. A guard that has never been seen to
 * fail is indistinguishable from no guard at all, and this repo has shipped
 * thirteen of those.
 *
 * The specific trap here is that **three independent gates all answer 404**.
 * An assertion that reads only the status passes with any one of them still
 * standing, so a deleted gate hides behind its neighbours. The suite therefore
 * opens the gates one at a time and asserts on the moment each is the only one
 * left; this tool injects the removal of each and checks that *that* named
 * assertion — not merely "something failed" — is the one that flips.
 *
 * ## Harness discipline (each point was a real false-negative somewhere)
 *
 * - Before/after comparison is a **content hash**; equal-length replacements
 *   are invisible to a size check.
 * - `assertPristine()` runs before the snapshot *and* after every restore.
 * - The suite runs in a **Worker thread** (`spawnSync` is EBUSY in this
 *   sandbox), and the suite's own stubbed `process.exit` is the **only**
 *   completion trigger — `import()` resolving is not the suite finishing.
 * - An anchor appearing 0× or 2× means the scenario is **not executed** and is
 *   reported as a problem, not silently skipped.
 *
 * Usage: node tests/tools/_media-inject.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const normalize = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

const POLICY = join(ROOT, "src/platform/media-policy.ts");
const API = join(ROOT, "src/api.ts");
const INDEX = join(ROOT, "src/index.ts");
const MEDIA_SUITE = "tests/suites/media.test.mjs";
const ARCH_SUITE = "tests/suites/architecture.test.mjs";

/**
 * One scenario per guard. `runs` pins the **named** assertion that must flip —
 * a guard failing for an unrelated reason is still a broken guard.
 */
const SCENARIOS = [
  {
    label: "the tenant check stops checking the tenant",
    file: POLICY,
    before: ['  return typeof key === "string" && siteId.length > 0 && key.startsWith(`uploads/${siteId}/`);\n'],
    after: ['  return typeof key === "string";\n'],
    runs: [[MEDIA_SUITE, "another site's host still refuses the key, with every other gate open"]],
  },
  {
    label: "the read path drops the session requirement",
    file: POLICY,
    before: ['  if (p.requireSession && !userId) return { allow: false, reason: "session" };\n'],
    after: [""],
    runs: [[MEDIA_SUITE, "with owner isolation off, an anonymous read is still refused"]],
  },
  {
    label: "the read path drops the owner check",
    file: POLICY,
    before: ['  if (row.uploaded_by !== userId) return { allow: false, reason: "owner" };\n'],
    after: [""],
    runs: [[MEDIA_SUITE, "the admin does NOT read the editor's file"]],
  },
  {
    label: "the list stops narrowing to the owner",
    file: POLICY,
    before: ['  return { sql: " AND (uploaded_by IS NULL OR uploaded_by = ?)", binds: [userId] };\n'],
    after: ['  return { sql: "", binds: [] };\n'],
    runs: [[MEDIA_SUITE, "the admin's library excludes the editor's files"]],
  },
  {
    label: "an upload stops recording who uploaded it",
    file: API,
    before: ['String(form.get("title") ?? file.name), userId, now()).run();'],
    after: ['String(form.get("title") ?? file.name), null, now()).run();'],
    runs: [[MEDIA_SUITE, "row carries the uploader (not NULL)"]],
  },
  {
    label: "delete removes the row but leaves the bytes in R2",
    file: API,
    before: ["    if (key) await mediaStoreDelete(env, key);\n"],
    after: ["    if (key) { /* injected: object left behind */ }\n"],
    runs: [[MEDIA_SUITE, "and so is the object"]],
  },
  {
    // The original defect, put back: a media branch matched above site
    // resolution. Only the structural guard can see it, because with the
    // correct branch still in place every behaviour test stays green.
    label: "the /media/ branch is matched again above site resolution",
    file: INDEX,
    // Anchored on the reset line that opens the request. It used to be
    // `resetSiteListMemo(env);` alone; batch C added `resetAdminPathMemo(env)`
    // on the same line, so the anchor now carries both — an anchor that no
    // longer matches makes the scenario *unexecuted*, which the runner reports
    // as a problem rather than a pass (see the runner's "anchor appears 0x").
    before: [" resetSiteListMemo(env);resetAdminPathMemo(env);\n"],
    after: [' resetSiteListMemo(env);resetAdminPathMemo(env);\n if(u.pathname.startsWith("/media/"))return media(env,request,u.pathname,resolved.siteId);\n'],
    runs: [[ARCH_SUITE, "the /media/ branch is matched after the site is resolved"]],
  },
];

const WATCHED = [...new Set(SCENARIOS.map((s) => s.file))];
function hashAll() {
  const out = {};
  for (const f of WATCHED) out[rel(f)] = existsSync(f) ? sha(normalize(readFileSync(f, "utf8"))) : "<absent>";
  return out;
}
function assertPristine(pristine, when) {
  const now = hashAll();
  const diffs = Object.keys(now).filter((k) => now[k] !== pristine[k]);
  if (diffs.length) {
    console.error(`\n✗ TREE NOT PRISTINE (${when}):`);
    for (const d of diffs) console.error(`    ${d}: ${pristine[d]} -> ${now[d]}`);
    console.error("  Restore the tree and re-run before trusting any result below.");
    process.exit(1);
  }
}

/** Run a suite in a Worker thread; the suite's own process.exit is the only trigger. */
function runSuite(relPath) {
  return new Promise((resolve) => {
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      let reported = false;
      const done = (code) => {
        if (reported) return;
        reported = true;
        parentPort.postMessage({ out, code: code == null ? 0 : code });
      };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\n[suite threw before process.exit] " + ((e && e.stack) || e) + "\\n"; done(1); });
    `;
    let settled = false;
    const w = new Worker(`const { parentPort } = require("node:worker_threads");\n${entry}`, { eval: true });
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { w.terminate(); } catch { /* already gone */ }
      resolve(verdict);
    };
    w.on("message", (m) => finish(parseVerdict(m.out, m.code)));
    w.on("error", (e) => finish({ passed: null, failed: null, aborted: true, text: `WORKER ERROR: ${(e && e.stack) || e}`, err: "worker error" }));
    w.on("exit", () => finish({ passed: null, failed: null, aborted: true, text: "", err: "worker exited without reporting" }));
    setTimeout(() => finish({ passed: null, failed: null, aborted: true, text: "", err: "worker timed out" }), 180_000).unref?.();
  });
}

/** A missing summary is never a pass. */
function parseVerdict(text, code) {
  const m = text.match(/(\d+) passed, (\d+) failed/);
  if (!m) return { passed: null, failed: null, aborted: true, text, code, err: "no summary" };
  return { passed: Number(m[1]), failed: Number(m[2]), aborted: /\(aborted\)/.test(text), text, code, err: null };
}

const apply = (file, before, after) => {
  const src = normalize(readFileSync(file, "utf8"));
  const hits = src.split(before).length - 1;
  if (hits !== 1) {
    throw new Error(`injection anchor appears ${hits} time(s) in ${rel(file)} (need exactly 1): ${JSON.stringify(before.slice(0, 70))}`);
  }
  writeFileSync(file, src.replace(before, after));
};

const problems = [];

async function main() {
  console.log("Snapshotting the pristine tree...");
  const pristine = hashAll();
  assertPristine(pristine, "pre-flight");
  console.log(`  ${WATCHED.length} watched files.`);

  let ran = 0;
  for (const sc of SCENARIOS) {
    console.log(`\n${"=".repeat(64)}\nScenario: ${sc.label}\n${"=".repeat(64)}`);

    const beforeSrc = normalize(readFileSync(sc.file, "utf8"));
    const anchorHits = beforeSrc.split(sc.before[0]).length - 1;
    if (anchorHits !== 1) {
      console.log(`  FAIL anchor appears ${anchorHits}x (need 1) — scenario not executed`);
      console.log(`       anchor: ${JSON.stringify(sc.before[0].slice(0, 90))}`);
      problems.push(`${sc.label}: anchor appears ${anchorHits}x (need 1)`);
      continue;
    }

    const preHash = sha(beforeSrc);
    apply(sc.file, sc.before[0], sc.after[0]);
    const postHash = sha(normalize(readFileSync(sc.file, "utf8")));
    if (postHash === preHash) {
      problems.push(`${sc.label}: injection produced no change (hash unchanged)`);
      console.log("  FAIL injection did not land — nothing was proved");
      writeFileSync(sc.file, beforeSrc);
      assertPristine(pristine, `after no-op injection of "${sc.label}"`);
      continue;
    }
    console.log(`  injected ${rel(sc.file)}: ${preHash} -> ${postHash}`);

    let allFlipped = true;
    for (const [suite, expectRed] of sc.runs) {
      const res = await runSuite(suite);
      if (res.aborted) {
        problems.push(`${sc.label}: ${suite} produced no summary (aborted) while injected`);
        console.log("  FAIL no summary while injected — cannot read the result");
        allFlipped = false;
        continue;
      }
      const hit = res.text.includes(`FAIL ${expectRed}`) || res.text.includes(`- ${expectRed}`);
      console.log(`  ${hit ? "ok  " : "FAIL"} ${suite}: "${expectRed}" ${hit ? "went red" : "did NOT go red"} (${res.passed}p/${res.failed}f)`);
      if (!hit) {
        const failedBlock = (res.text.match(/FAIL [^\n]*/g) ?? []).slice(0, 3);
        problems.push(`${sc.label}: expected assertion never went red — ${failedBlock.join(" | ") || "nothing failed"}`);
        allFlipped = false;
      }
    }

    writeFileSync(sc.file, beforeSrc);
    assertPristine(pristine, `after restoring "${sc.label}"`);
    console.log(`  restored (${sha(normalize(readFileSync(sc.file, "utf8")))})  ${allFlipped ? "✓ scenario valid" : "✗ scenario INVALID"}`);
    ran++;
  }

  console.log(`\n${"=".repeat(64)}`);
  for (const suite of [MEDIA_SUITE, ARCH_SUITE]) {
    const final = await runSuite(suite);
    console.log(`post-restore: ${suite} ${final.passed}p/${final.failed}f`);
    if (final.aborted) problems.push(`${suite} produced no readable verdict after restore`);
    else if (final.failed) problems.push(`${suite} not green after restore (${final.failed} failed)`);
  }
  assertPristine(pristine, "final");

  console.log(`\n${ran} scenario(s) executed, ${problems.length} problem(s)`);
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("Every guard under test was observed to fail on its own defect.");
}

main().catch((e) => {
  console.error("\nTOOL ERROR:", (e && e.stack) || e);
  process.exit(1);
});
