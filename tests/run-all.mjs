/**
 * Run every test suite in sequence and report a single verdict.
 *
 * The suites share one local D1 database and one in-memory R2 each, so running
 * them in order is itself a regression test for cross-suite state leakage.
 *
 * Usage: node tests/run-all.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const suites = [
  ["migrations", "tools/_apply-migrations.mjs"],
  // Architecture first: it is fast, needs no database, and a failure here means
  // the shape of the code is wrong — which makes every later failure suspect.
  ["architecture rules", "suites/architecture.test.mjs"],
  // Schema scope: like the architecture rules it needs no shared database (it
  // builds a throwaway SQLite from the migration stream), and it answers the
  // question the rules only assert — "does every real table have a tenant and
  // a language answer?" Run it right after the rules so a shape error and a
  // scope error are reported next to each other.
  ["schema scope (tenant+lang)", "tools/_schema-scope.mjs"],
  // Manifest validation is next: like the architecture suite it needs no
  // database, and it guards what a *user uploads* — the shipped themes are
  // already covered by the architecture rules above.
  ["manifest validation", "suites/manifest-validation.test.mjs"],
  // The admin SPA split is checked here too: like the two above it needs no
  // database, and it guards *structure* (module graph, window.* contract) —
  // a broken split would make the admin UI silently unusable.
  ["admin spa structure", "suites/admin-spa.test.mjs"],
  ["template engine (unit)", "suites/template-engine.test.mjs"],
  ["theme integration (e2e)", "suites/theme-integration.test.mjs"],
  ["multi-site", "suites/multisite.test.mjs"],
  // Multi-language runs after multi-site: both write per-site locale switches
  // and the i18n suite asserts on a site it configures itself.
  ["multi-language (L0-L3)", "suites/i18n.test.mjs"],
  ["admin contract", "suites/admin-contract.test.mjs"],
  // Deleting a staff identity (batch F, rule 80): the `site_users` row and its
  // `site_users_sites` memberships are one thing and must die together — nothing
  // cascades, so the platform function that owns the identity has to do it.
  // Runs right after the admin contract, next to the other auth-shaped suite.
  ["user delete (identity + memberships)", "suites/user-delete.test.mjs"],
  // The multi-site isolation matrix (MS stories): three sites, one deleted
  // mid-suite, per-site members, cross-site revision reads, the scheduler.
  // Runs next to the other multi-site suite so the shared-fixture order holds.
  ["multi-site isolation matrix", "suites/multisite-isolation-matrix.test.mjs"],
  // Media access: the tenant and owner axes of `media_files`, checked on both
  // doors (the public `/media/<key>` read path and the admin API) so the two
  // cannot drift apart again.
  ["media access", "suites/media.test.mjs"],
  // The one media control, and the loop it closes with the renderer: library
  // row → picker item → block attribute → real renderer markup.
  ["media picker", "suites/media-picker.test.mjs"],
  // The block attribute contract, walked end to end: declaration → the control
  // the editor draws → the key it writes → the markup the real renderer
  // produces. Six of twelve block types used to render empty at HTTP 200.
  ["editor blocks", "suites/editor-blocks.test.mjs"],
  ["plugin hooks", "suites/plugin-hooks.test.mjs"],
  // The channel runtime: webhook delivery + the claim-before-send dedup ledger.
  // It was missing from all four registries (npm test, this list, and both
  // launchers) while still existing and passing — see the coverage guard in
  // `launcher-parity.test.mjs`.
  ["plugin channels (notify)", "suites/plugin-channels.test.mjs"],
  // Plugin-declared admin pages run right after plugin hooks: both drive the
  // real Worker against a plugin install, and this one adds the page renderer —
  // the only suite that reads markup back out of a response.
  ["plugin pages (declare -> render)", "suites/plugin-pages.test.mjs"],
  ["theme sandbox (L3)", "suites/theme-worker.test.mjs"],
  ["locale urls", "suites/locale-url.test.mjs"],
  ["fixture theme", "suites/theme-fixture.test.mjs"],
  ["default theme", "suites/theme-default.test.mjs"],
  // The launcher parity check is pure text analysis over scripts/cfpress.sh and
  // scripts/cfpress.ps1 — no Worker, no database. It guards the promise those
  // two files make to each other ("one set of actions"), which decays silently
  // otherwise: a missing action only surfaces when someone on the other OS
  // needs it.
  ["launcher parity (sh <-> ps1)", "suites/launcher-parity.test.mjs"],
];

const results = [];
for (const [label, file] of suites) {
  process.stdout.write(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}\n`);
  const r = spawnSync(process.execPath, [join(__dirname, file)], { encoding: "utf8" });

  // A runner that cannot execute the suite is not the same as a suite that
  // failed. Some sandboxes lock the node binary (`EBUSY`), which would
  // otherwise report every suite red and hide the real state. Surface it
  // distinctly so a genuine failure stays legible.
  if (r.error) {
    console.log(`SKIPPED — could not start the suite: ${r.error.code || r.error.message}`);
    console.log(`          (run it directly: node tests/${file})`);
    results.push({ label, status: "skip", summary: "runner could not spawn" });
    continue;
  }

  const out = (r.stdout || "") + (r.stderr || "");
  // Print only the meaningful lines; node's SQLite warning is noise.
  for (const line of out.split("\n")) {
    if (/ExperimentalWarning|trace-warnings/.test(line)) continue;
    if (!line.trim()) continue;
    console.log(line);
  }
  const m = out.match(/(\d+) passed, (\d+) failed/);
  results.push({ label, status: r.status, summary: m ? `${m[1]} passed, ${m[2]} failed` : "(no summary)" });
  if (r.status !== 0) {
    console.log(`\n>>> ${label} FAILED (exit ${r.status})`);
  }
}

console.log(`\n${"=".repeat(64)}\nSUMMARY\n${"=".repeat(64)}`);
let bad = 0;
let skipped = 0;
for (const r of results) {
  if (r.status === "skip") {
    skipped++;
    console.log(`  SKIP  ${r.label.padEnd(28)} ${r.summary}`);
    continue;
  }
  const mark = r.status === 0 ? "PASS" : "FAIL";
  if (r.status !== 0) bad++;
  console.log(`  ${mark}  ${r.label.padEnd(28)} ${r.summary}`);
}

if (bad) console.log(`\n${bad} suite(s) failed.`);
else if (skipped) console.log(`\nNo failures, but ${skipped} suite(s) could not be started by this runner.`);
else console.log("\nAll suites passed.");
process.exit(bad ? 1 : 0);
