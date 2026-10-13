/**
 * Reverse-validation for the plugin-page guards (batch 10, rules 49–51).
 *
 * ## What this proves
 *
 * `tests/suites/plugin-pages.test.mjs` asserts that a plugin's declared `adminPages[]`
 * actually becomes a working page: an undeclared `plugin-page:<id>` is refused,
 * the block type set is closed, a `form` write lands in the real table, a
 * `stats` aggregate is numerically correct, and disabling a plugin removes its
 * menus and pages. Every one of those is a check that, unobserved in its red
 * state, is indistinguishable from no check at all — this repo has shipped
 * eleven false greens, and each was a guard nobody had watched fail.
 *
 * So this tool injects one realistic defect per guard, asserts the **named**
 * assertion goes red, restores, and asserts the tree is pristine again.
 *
 * ## The traps this tool inherits (all were real bugs in sibling tools)
 *
 * 1. **Byte count cannot see an equal-length replacement** — the before/after
 *    comparison is a SHA-256 content hash, not a size.
 * 2. **A snapshot from a dirty tree restores a dirty tree** — `assertPristine`
 *    runs before the snapshot *and* after each restore.
 * 3. **A subprocess cannot run in this sandbox** — `spawnSync` is uniformly
 *    `EBUSY`, which makes "the suite never ran" look exactly like "the suite did
 *    not go red". Suites are therefore driven in **Worker threads**, and the
 *    worker's scope is ESM, so it uses `import()` (never `require`).
 * 4. **Anchors are matched against newline-normalised text** — a CRLF file made
 *    three sibling scenarios silently report "anchor 0x" and skip.
 * 5. **The injection must be proven to have landed** — a hash compare after the
 *    write, because an anchor that matched but replaced nothing proves nothing.
 *
 * ## Why it is not in `npm test`
 *
 * It is a tool, not a suite: it mutates the working tree and drives other
 * suites. Same category as `_skeleton-inject.mjs` and `_launcher-inject.mjs`.
 *
 * Usage: node tests/tools/_plugin-pages-inject.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href);
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const normalize = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

const VALIDATION = join(ROOT, "src/extensions/contract/validation.ts");
const MANIFEST = join(ROOT, "src/extensions/contract/manifest.ts");
const FACADE = join(ROOT, "src/extensions/theme/table-facade.ts");
const API = join(ROOT, "src/api.ts");
const MENUS = join(ROOT, "src/extensions/plugin/runtime.ts");
const RENDERER = join(ROOT, "public/admin/js/plugin-page.js");

const SUITE = "tests/suites/plugin-pages.test.mjs";

/**
 * Each scenario names the assertion (a substring of its printed name) that MUST
 * flip. Without `flip`, the tool would prove only "something failed", and a
 * guard that fails for an unrelated reason is still a broken guard.
 */
const SCENARIOS = [
  {
    label: "a plugin-page menu may name a page that was never declared (rule 50)",
    file: VALIDATION,
    // ⚠️ `before` is a one-element array holding ONE multi-line string. The
    // sibling tools' arrays of per-line strings were a trap: `apply()` uses
    // `before[0]` only, so a scenario written as several array elements would
    // match the first line alone and replace a fragment — here that produced
    // `spec is not defined`, a crash reported as "no summary", i.e. as a broken
    // *runner* rather than a broken scenario.
    before: [
      "      if (!declaredPages.has(pageId)) {\n" +
      "        // An id that resolves to nothing opens a screen with nothing to render:\n" +
      "        // the sidebar entry looks correct and the page behind it is blank, which\n" +
      "        // reads as a load failure rather than a manifest typo.\n" +
      "        fail(\n" +
      "          `adminMenu ${id}: opens plugin page \"${pageId}\", which is not in adminPages[]` +\n" +
      "          (declaredPages.size ? ` (declared: ${[...declaredPages].join(\", \")})` : \" (none declared)\")\n" +
      "        );\n" +
      "      }\n",
    ],
    after: ["      /* rule 50 check removed: the menu may name any page id */\n"],
    runs: [[SUITE, "an undeclared plugin-page target is rejected"]],
    alsoAccept: ["the error names the missing page id", "the error lists what was declared"],
  },
  {
    label: "an unknown page block type is admitted (rule 49)",
    file: MANIFEST,
    before: ['export const ALLOWED_PAGE_BLOCKS = ["table", "stats", "form"] as const;'],
    after: ['export const ALLOWED_PAGE_BLOCKS = ["table", "stats", "form", "gallery"] as const;'],
    runs: [[SUITE, "an unknown block type is rejected"]],
    alsoAccept: ["the error lists the allowed types"],
  },
  {
    label: "an unknown stats aggregate is admitted (rule 49)",
    file: MANIFEST,
    before: ['export const ALLOWED_AGGREGATES = ["count", "sum"] as const;'],
    after: ['export const ALLOWED_AGGREGATES = ["count", "sum", "median"] as const;'],
    runs: [[SUITE, "an unknown aggregate is rejected"]],
    alsoAccept: ["the error lists the allowed aggregates"],
  },
  {
    label: "a block may read a table the plugin never declared",
    file: VALIDATION,
    before: [
      "      if (!declaredTables.has(source)) {\n" +
      "        fail(`adminPage ${id}: block \"${type}\" reads table \"${source}\", which is not declared in tables[]`);\n" +
      "      }\n",
    ],
    after: ["      /* source-table check removed: a block may read any table */\n"],
    runs: [[SUITE, "a block reading an undeclared table is rejected"]],
  },
  {
    label: "a plugin's declared tables are never materialised on enable",
    file: MENUS,
    before: [
      "    try {\n" +
      "      await registerPluginTables(env, plugin.name, plugin.manifest ?? {});\n" +
      "    } catch {\n" +
      "      // Same reasoning: a table that cannot be created must not 500 the request\n" +
      "      // that happened to boot the runtime. The next boot retries.\n" +
      "    }\n",
    ],
    after: ["    /* table sync disabled by injection */\n"],
    runs: [[SUITE, "enabling the plugin created its declared table"]],
    // With the table missing, the suite's own `catch` fires when a later
    // `sqlite.prepare` hits the absent table, and it prints `... (aborted)`.
    // That is still a readable verdict (the harness keys on the summary line,
    // not on the marker), so the named assertion below is the one to watch.
    alsoAccept: ["the form write is accepted", "count returns the row count"],
  },
  {
    label: "the stats aggregate ignores the caller's status filter",
    file: FACADE,
    before: [
      "  const where = [\"m.site_id = ?\"];\n" +
      "  const binds: unknown[] = [def.site_id];\n" +
      "  if (opts.status) {\n" +
      "    where.push(\"m.status = ?\");\n" +
      "    binds.push(String(opts.status));\n" +
      "  }\n",
    ],
    after: [
      "  const where = [\"m.site_id = ?\"];\n" +
      "  const binds: unknown[] = [def.site_id];\n",
    ],
    runs: [[SUITE, "count over the same empty selection is 0"]],
    alsoAccept: ["sum over no rows is null, not zero"],
  },
  {
    label: "a stats sum is allowed on a non-numeric column",
    file: FACADE,
    before: [
      "    const spec = def.fields.find((f) => String(f.key) === field);\n" +
      "    if (spec && String(spec.type ?? \"text\") !== \"number\") return null;\n",
    ],
    after: ["    /* numeric-check removed: any declared column may be summed */\n"],
    runs: [[SUITE, "summing a non-numeric column is refused"]],
  },
  {
    label: "the table write path no longer derives a slug for a form block",
    file: API,
    before: [
      "        const withSlug = body?.slug || method === \"PUT\" ? body : { ...body, slug: deriveSlug(def, body) };\n" +
      "        const row = await tableSave(env, def, withSlug, locale);\n",
    ],
    after: ["        const row = await tableSave(env, def, body, locale);\n"],
    runs: [[SUITE, "the form write is accepted"]],
    alsoAccept: ["exactly one row landed in the plugin's table"],
  },
  {
    label: "disabling a plugin leaves its menus behind",
    file: API,
    before: [
      "    if(pm[2]===\"disable\"){\n" +
      "      // Drop this plugin's menus — and only this plugin's. The registry is\n" +
      "      // keyed by owner so that disabling one extension cannot disturb a theme\n" +
      "      // or a different plugin. Re-enabling re-registers them from the manifest\n" +
      "      // in `loadEnabledPlugins`, so nothing is lost by deleting here.\n" +
      "      await clearPluginMenus(env,pm[1]);\n" +
      "    }\n",
    ],
    after: ["    /* menu clearing removed by injection */\n"],
    runs: [[SUITE, "its menu is gone from the registry"]],
  },
  {
    label: "the renderer reads the field declarations from the wrong key",
    file: RENDERER,
    before: [
      "function sourceFields(data) {\n" +
      "  if (Array.isArray(data?.def?.fields)) return data.def.fields;\n" +
      "  if (Array.isArray(data?.fields)) return data.fields;\n" +
      "  return [];\n" +
      "}",
    ],
    after: [
      "function sourceFields(data) {\n" +
      "  if (Array.isArray(data?.fields)) return data.fields;\n" +
      "  return [];\n" +
      "}",
    ],
    // Section 9 of the suite renders the real module against the real payload
    // shape, so this defect now has an observed-red guard *inside the suite this
    // tool drives*. Before that section existed the renderer's field path was
    // covered by nothing at all: the defect shipped once, at HTTP 200, drawing
    // "the table declares no such fields" for every block.
    runs: [[SUITE, "a table block draws a header per declared column"]],
    alsoAccept: [
      "and the second column too",
      "a row value reaches its cell",
      "no block claims the table declares no such fields",
      "a form block draws a control per declared field",
    ],
  },
];

/** Every file any scenario may touch, hashed before and after. */
const WATCHED = [...new Set([VALIDATION, MANIFEST, FACADE, API, MENUS, RENDERER])];

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

/**
 * Run a suite in a Worker thread and return its parsed verdict.
 *
 * A missing summary line is reported as `aborted` — never as "0 failed" — so a
 * suite that crashed mid-way cannot be read as a pass (false-green type 6).
 */
function runSuite(relPath, expectRed) {
  return new Promise((resolve) => {
    const entry = `
      const { parentPort } = require("node:worker_threads");
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      // Completion is the suite's own process.exit and nothing else.
      // import() resolving means the module *body* ended, not that main()
      // finished — adding a ".then(done)" here terminated the worker mid-run
      // and made the suite read as "no summary", which the harness treats as
      // "did not go red". See the long note in _skeleton-inject.mjs.
      let reported = false;
      const done = (code) => {
        if (reported) return;
        reported = true;
        parentPort.postMessage({ out, code: code == null ? 0 : code });
      };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\nWORKER IMPORT ERROR: " + ((e && e.stack) || e); done(1); });
    `;
    // The parent is ESM; `eval:true` workers created from it have their own
    // scope, so the `require` above is the worker's own — never the parent's.
    // `EXPECT_RED` tells `plugin-pages.test.mjs` which assertions the harness
    // expects to fail, so "an unrelated guard went red" is caught too.
    const env = { ...process.env, EXPECT_RED: expectRed ?? "" };
    const w = new Worker(entry, { eval: true, env });
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { w.terminate(); } catch { /* already gone */ }
      resolve(verdict);
    };
    w.on("message", (m) => finish(parseVerdict(m.out, m.code)));
    w.on("error", (e) => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: `WORKER ERROR: ${(e && e.stack) || e}`, err: "worker error",
    }));
    w.on("exit", () => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker exited without reporting",
    }));
    setTimeout(() => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker timed out",
    }), 180_000).unref?.();
  });
}

function parseVerdict(text, code) {
  const m = text.match(/(\d+) passed, (\d+) failed/);
  if (!m) return { passed: null, failed: null, aborted: true, text, code, err: "no summary" };
  // A suite that hit its own `catch` prints `... failed (aborted)` — that is a
  // *readable* verdict, not a missing one. The earlier version folded the two
  // together and reported "no summary" for a run whose failures were perfectly
  // legible, which made a real guard (the missing table) look like a broken
  // runner. `aborted` therefore means "no parseable summary", full stop; the
  // `(aborted)` marker is kept only as information for the reader.
  return { passed: Number(m[1]), failed: Number(m[2]), aborted: false, selfAborted: /\(aborted\)/.test(text), text, code, err: null };
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
  console.log(`  ${WATCHED.length} watched files; baseline hashes:\n    ` +
    Object.entries(pristine).map(([k, v]) => `${k}=${v}`).join("\n    "));

  const problems = [];
  let ran = 0;

  // Pre-flight: the suite must be green on a clean tree. Without this, every
  // scenario below would "go red" for a reason that predates the injection.
  console.log(`\n${"=".repeat(64)}\nPre-flight: ${SUITE} on the pristine tree\n${"=".repeat(64)}`);
  const baseline = await runSuite(SUITE, "");
  if (baseline.aborted) {
    console.error(`✗ pre-flight produced no summary (${baseline.err}) — cannot trust any scenario`);
    process.exit(1);
  }
  console.log(`  ${baseline.passed} passed, ${baseline.failed} failed${baseline.selfAborted ? " (self-aborted)" : ""}`);
  if (baseline.failed) {
    console.error("✗ the suite is not green before any injection. Fix it first.");
    process.exit(1);
  }

  for (const sc of SCENARIOS) {
    console.log(`\n${"=".repeat(64)}\nScenario: ${sc.label}\n${"=".repeat(64)}`);

    const beforeSrc = normalize(readFileSync(sc.file, "utf8"));
    const anchorHits = beforeSrc.split(sc.before[0]).length - 1;
    if (anchorHits !== 1) {
      problems.push(`${sc.label}: anchor appears ${anchorHits}x (need 1)`);
      console.log(`  FAIL anchor not unique (${anchorHits}) — scenario not executed`);
      console.log(`       anchor: ${JSON.stringify(sc.before[0].slice(0, 90))}`);
      continue;
    }

    const preHash = sha(beforeSrc);
    try {
      apply(sc.file, sc.before[0], sc.after[0]);
    } catch (e) {
      problems.push(`${sc.label}: ${e.message}`);
      console.log(`  FAIL ${e.message}`);
      assertPristine(pristine, `after failed injection of "${sc.label}"`);
      continue;
    }

    const postHash = sha(normalize(readFileSync(sc.file, "utf8")));
    if (postHash === preHash) {
      problems.push(`${sc.label}: injection produced no change in ${rel(sc.file)} (hash unchanged)`);
      console.log(`  FAIL injection did not land (${preHash} == ${postHash}) — nothing was proved`);
      writeFileSync(sc.file, beforeSrc);
      assertPristine(pristine, `after no-op injection of "${sc.label}"`);
      continue;
    }
    console.log(`  injected ${rel(sc.file)}: ${preHash} -> ${postHash}`);

    let allFlipped = true;
    for (const [suite, expectRed] of sc.runs) {
      const res = await runSuite(suite, expectRed ?? "");
      if (res.aborted) {
        problems.push(`${sc.label}: ${suite} produced no summary (aborted) while injected`);
        console.log(`  FAIL ${suite}: no summary while injected — cannot read the result (treated as failure)`);
        allFlipped = false;
        continue;
      }
      const marker = res.selfAborted ? " (suite self-aborted; verdict still readable)" : "";
      if (expectRed === null || expectRed === undefined) {
        const red = res.failed > 0;
        console.log(`  ${red ? "ok  " : "FAIL"} ${suite}: ${res.passed} passed, ${res.failed} failed (expected >0 failures)${marker}`);
        if (!red) { problems.push(`${sc.label}: ${suite} stayed green`); allFlipped = false; }
        continue;
      }
      const hit = res.text.includes(`FAIL ${expectRed}`) || res.text.includes(`- ${expectRed}`);
      const accepted = hit || (sc.alsoAccept ?? []).some((a) => res.text.includes(`FAIL ${a}`) || res.text.includes(`- ${a}`));
      console.log(`  ${hit ? "ok  " : "FAIL"} ${suite}: "${expectRed}" ${hit ? "went red" : "did NOT go red"} (${res.passed}p/${res.failed}f)${marker}`);
      if (!hit) {
        const failedBlock = res.text.match(/FAIL [^\n]*/g) ?? [];
        console.log(`       failing assertions: ${failedBlock.slice(0, 4).join(" | ") || "none"}`);
        console.log(`       (accepted alternates: ${(sc.alsoAccept ?? []).join(", ") || "none"} -> ${accepted ? "one matched" : "none matched"})`);
        problems.push(`${sc.label}: expected assertion never went red`);
        allFlipped = false;
      }
    }

    writeFileSync(sc.file, beforeSrc);
    const restored = sha(normalize(readFileSync(sc.file, "utf8")));
    assertPristine(pristine, `after restoring "${sc.label}"`);
    console.log(`  restored (${restored})  ${allFlipped ? "✓ scenario valid" : "✗ scenario INVALID"}`);
    ran++;
  }

  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(64)}\nPost-restore: the suite must be green again\n${"=".repeat(64)}`);
  const final = await runSuite(SUITE, "");
  console.log(`  ${final.passed}p/${final.failed}f${final.aborted ? " (aborted)" : ""}${final.selfAborted ? " (self-aborted)" : ""}`);
  if (final.aborted) problems.push(`post-restore ${SUITE} produced no readable verdict (${final.err})`);
  else if (final.selfAborted) problems.push(`post-restore ${SUITE} self-aborted on a clean tree`);
  else if (final.failed) problems.push(`post-restore ${SUITE} not green (${final.failed} failed)`);

  const arch = await runSuite("tests/suites/architecture.test.mjs", "");
  console.log(`  architecture ${arch.passed}p/${arch.failed}f${arch.aborted ? " (aborted)" : ""}${arch.selfAborted ? " (self-aborted)" : ""}`);
  if (arch.aborted) problems.push(`post-restore architecture produced no readable verdict (${arch.err})`);
  else if (arch.selfAborted) problems.push(`post-restore architecture self-aborted on a clean tree`);
  else if (arch.failed) problems.push(`post-restore architecture not green (${arch.failed} failed)`);

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
