/**
 * Reverse-validation for the multilingual/URL guards (AGENTS.md rules 56-59).
 *
 * ## What this proves
 *
 * `architecture.test.mjs` now carries four guards for the i18n/URL layer: the
 * locale-segment matcher defined once (56), no hardcoded locale fallbacks
 * outside `platform/i18n/` (57), every posts⋈translations slug filter
 * COALESCE'd (58), and site-scoped SEO endpoints (59). A guard that has never
 * been seen to fail is indistinguishable from no guard at all.
 *
 * So this tool injects one realistic defect per guard, asserts the **named**
 * assertion goes red — not merely "some test failed" — then restores and
 * asserts the tree is pristine again.
 *
 * ## Harness discipline (each point below was a real false-negative somewhere)
 *
 * - Before/after comparison is a **content hash**, not a byte count
 *   (equal-length replacements are invisible to a size check).
 * - `assertPristine()` runs **before** the snapshot *and* **after** every
 *   restore — a snapshot taken from a dirty tree restores a dirty tree.
 * - The suite runs in a **Worker thread** (`spawnSync` is EBUSY in this
 *   sandbox), and the suite's own stubbed `process.exit` is the **only**
 *   completion trigger — `import()` resolving is *not* the suite finishing,
 *   and treating it as such terminated slow suites early, which read as
 *   "no summary" i.e. as a broken guard rather than a broken harness.
 * - Anchors are newline-normalised before matching, and a scenario whose
 *   anchor appears 0x or 2x is **not executed** — it is a failure.
 *
 * Usage: node tests/tools/_locale-url-inject.mjs
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

const FRONTEND = join(ROOT, "src/platform/frontend.ts");
const API = join(ROOT, "src/api.ts");
const INDEX = join(ROOT, "src/index.ts");
const SEO = join(ROOT, "src/platform/seo.ts");
const ARCH = "tests/suites/architecture.test.mjs";

/**
 * One scenario per guard. `runs` pins the *named* assertion that must flip —
 * a guard failing for an unrelated reason is still a broken guard.
 */
const SCENARIOS = [
  {
    label: "a slug lookup drops the COALESCE and matches the main table only (rule 58)",
    file: FRONTEND,
    before: ["AND COALESCE(t.slug,p.slug)=? AND t.locale=?"],
    after: ["AND p.slug=? AND t.locale=?"],
    runs: [[ARCH, "every posts⋈translations slug filter is COALESCE'd (rule 58)"]],
  },
  {
    label: "a search route falls back to a hardcoded locale (rule 57)",
    file: API,
    before: ["const q=String(url.searchParams.get(\"q\")||\"\").trim(); const locale=await resolveContentLocale(env,siteId,url.searchParams.get(\"locale\"));"],
    after: ["const q=String(url.searchParams.get(\"q\")||\"\").trim(); const locale=await resolveContentLocale(env,siteId,url.searchParams.get(\"locale\"))||\"en\";"],
    runs: [[ARCH, "no hardcoded locale fallbacks outside platform/i18n (rule 57)"]],
  },
  {
    label: "a second locale-segment matcher appears in the router (rule 56)",
    file: INDEX,
    before: ["const u=new URL(request.url);"],
    after: ["const u=new URL(request.url);\nconst LOCALE_SEG_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;"],
    runs: [[ARCH, "the locale-segment matcher lives only in platform/i18n (rule 56)"]],
  },
  {
    label: "the feed loses its siteId parameter (rule 59)",
    file: SEO,
    before: ["export async function feed(env:Env,request:Request,siteId:string,locale?:string){"],
    after: ["export async function feed(env:Env,request:Request,locale?:string){"],
    runs: [[ARCH, "every exported seo.ts function takes siteId (rule 59)"]],
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
    setTimeout(() => finish({ passed: null, failed: null, aborted: true, text: "", err: "worker timed out" }), 120_000).unref?.();
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

// ---------------------------------------------------------------------------
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
      ran = ran; // not executed; counted below as a problem
      console.log(`  (recorded as a problem)`);
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
  const final = await runSuite(ARCH);
  console.log(`post-restore: architecture ${final.passed}p/${final.failed}f`);
  if (final.aborted) problems.push("architecture produced no readable verdict after restore");
  else if (final.failed) problems.push(`architecture not green after restore (${final.failed} failed)`);
  assertPristine(pristine, "final");

  console.log(`\n${ran} scenario(s) executed, ${problems.length} problem(s)`);
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("Every guard under test was observed to fail on its own defect.");
}

const problems = [];

main().catch((e) => {
  console.error("\nTOOL ERROR:", (e && e.stack) || e);
  process.exit(1);
});
