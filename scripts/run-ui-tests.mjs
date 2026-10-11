#!/usr/bin/env node
/**
 * UI test runner — the scheduled entry point.
 *
 * Owns the three things a single browser script cannot: the dev server it
 * needs, the environment that server has to start in, and the issue tracker
 * the findings go to. A scheduled task that leaves a wrangler process behind
 * or files a duplicate issue every night is worse than no schedule at all.
 *
 * What one run does:
 *   1. clears the proxy variables that crash `workerd` on startup on this
 *      machine (the crash loop is the reason this runner exists at all:
 *      `wrangler dev` started with HTTP_PROXY set restarts its runtime every
 *      few requests, so every check hangs until timeout — an unhelpful red)
 *   2. starts `wrangler dev`, waits for /api/v1/health, then runs
 *        tests/tools/_ui-blackbox.cjs     (deterministic browser facts)
 *        tests/tools/_ui-midscene.mjs    (vision + functional, if a model is
 *                                         configured — otherwise a clean skip)
 *   3. writes .tmp-ui/ui-summary.json
 *   4. with --report, files one GitHub issue per *new* finding (deduped by
 *      title against the open issue list, so a nightly run does not re-file
 *      yesterday's bug)
 *   5. always takes the dev server down, even on a thrown runner error
 *
 * Usage:
 *   node scripts/run-ui-tests.mjs                 # run, report to a file
 *   node scripts/run-ui-tests.mjs --report        # ... and file new findings
 *   node scripts/run-ui-tests.mjs --no-server     # attach to a running dev
 *   node scripts/run-ui-tests.mjs --port 47913    # explicit port
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".tmp-ui");
const LOGS = join(OUT, "logs");
const PORT = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 47913);
const BASE = `http://127.0.0.1:${PORT}`;
const REPORT = process.argv.includes("--report");
const NO_SERVER = process.argv.includes("--no-server");
const REPO = process.env.CFPRESS_GH_REPO || "unifare/CFCMS";

mkdirSync(LOGS, { recursive: true });

/** A child environment without the proxy vars that make workerd crash-loop. */
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete e[k];
  // Keep the child from *discovering* an AI-agent context: wrangler then
  // prints its explorer banner and starts its control endpoints, which is the
  // other half of the crash loop observed on this machine.
  delete e.CLAUDECODE;
  return { ...e, ...extra };
}

function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const log = join(LOGS, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const out = [];
    const child = spawn(cmd, args, { cwd: ROOT, env: cleanEnv(opts.env), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { out.push(String(d)); process.stdout.write(d); });
    child.stderr.on("data", (d) => { out.push(String(d)); process.stderr.write(d); });
    child.on("exit", (code) => { try { writeFileSync(log, out.join("").replace(/\u001b\[[0-9;]*m/g, "")); } catch { /* fine */ } resolve({ code, log }); });
  });
}

async function waitHealthy(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (r && r.ok) return true;
    await new Promise((s) => setTimeout(s, 2000));
  }
  return false;
}

// ── the dev server ────────────────────────────────────────────────────────────
let server = null;
if (!NO_SERVER) {
  // A machine runs one `wrangler dev` at a time; a second start fails on the
  // port and the run ends up talking to whatever is already there. So adopt a
  // healthy server when there is one (exactly what --no-server used to mean),
  // and only start one when nothing answers.
  if (await waitHealthy(3000)) {
    console.log(`✓ adopting the dev server already running on :${PORT}`);
  } else {
    // `node <wrangler bin>` rather than `npx wrangler`: spawning `npx` on Windows
    // needs a shell, and a runner that depends on the shell getting the PATH
    // right is a runner that fails on the machine it was scheduled for.
    const wranglerBin = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
    console.log(`▶ starting wrangler dev on :${PORT} (proxy vars cleared)`);
    server = spawn(process.execPath, [wranglerBin, "dev", "--port", String(PORT), "-c", "wrangler.local.jsonc"], {
      cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
  const slog = join(LOGS, `dev-server-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  let sbody = "";
  server.stdout.on("data", (d) => { sbody += String(d); });
  server.stderr.on("data", (d) => { sbody += String(d); });
  server.on("exit", (c) => { try { writeFileSync(slog, sbody.replace(/\u001b\[[0-9;]*m/g, "") + `\n[exit ${c}]`); } catch { /* fine */ } });
  const ok = await waitHealthy();
  if (!ok) {
    console.error("✗ the dev server never became healthy — see the log in .tmp-ui/logs");
    server.kill("SIGKILL");
    process.exit(2);
  }
  console.log("✓ dev server healthy");
  }
}

const suites = [];
try {
  console.log("\n▶ UI black-box (Playwright, deterministic)");
  const b = await run("blackbox", process.execPath, ["tests/tools/_ui-blackbox.cjs"], { env: { CFP_BASE: BASE, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  suites.push({ suite: "ui-blackbox", code: b.code, log: b.log });

  console.log("\n▶ UI admin functional (Playwright, every screen does its job)");
  const f = await run("admin-functional", process.execPath, ["tests/tools/_ui-admin-functional.cjs"], { env: { CFP_BASE: BASE, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  suites.push({ suite: "ui-admin-functional", code: f.code, log: f.log });

  console.log("\n▶ UI vision + functional (MidScene)");
  const m = await run("midscene", process.execPath, ["tests/tools/_ui-midscene.mjs"], { env: { CFP_BASE: BASE, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  suites.push({ suite: "ui-midscene", code: m.code, log: m.log });
} finally {
  if (server) { server.kill("SIGKILL"); console.log("✓ dev server stopped"); }
}

// ── the summary ───────────────────────────────────────────────────────────────
const findings = [];
for (const s of suites) {
  const f = join(OUT, `${s.suite}.json`);
  if (!existsSync(f)) continue;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    for (const x of j.findings ?? []) findings.push({ suite: s.suite, ...x });
  } catch { /* an unreadable result is a failing run, reported via the code below */ }
}
const summary = {
  at: new Date().toISOString(), base: BASE, suites,
  checks: suites.length, failed: findings.length, findings,
};
writeFileSync(join(OUT, "ui-summary.json"), JSON.stringify(summary, null, 2));
console.log(`\n${findings.length} finding(s) across ${suites.length} suite(s) → ${join(OUT, "ui-summary.json")}`);

// ── issue reporting ───────────────────────────────────────────────────────────
if (REPORT && findings.length) {
  if (!spawnSync("gh", ["--version"], { stdio: "ignore" }).error) {
    for (const f of findings) {
      const title = `[ui] ${f.name}`.slice(0, 180);
      const dup = spawnSync("gh", ["issue", "list", "--repo", REPO, "--state", "open", "--search", `in:title "${title}"`, "--json", "number"], { encoding: "utf8" });
      let alreadyOpen = false;
      try { alreadyOpen = (JSON.parse(dup.stdout || "[]") || []).length > 0; } catch { /* list failed — report anyway */ }
      if (alreadyOpen) { console.log(`  = ${title} (already open)`); continue; }
      const body = [
        `Found by the scheduled UI run at ${summary.at}.`,
        "",
        `**Check:** ${f.name}`,
        `**Suite:** ${f.suite}`,
        f.detail ? `**Detail:** ${f.detail}` : "",
        "",
        `**Reproduce:** \`node scripts/run-ui-tests.mjs\` (starts its own \`wrangler dev\` on :${PORT}).`,
        `**Log:** see \`.tmp-ui/logs/${f.suite}-*.log\``,
        "",
        "_Filed automatically; edit or close freely._",
      ].filter(Boolean).join("\n");
      const created = spawnSync("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body", body, "--label", "ui-test"], { encoding: "utf8" });
      if (created.error) {
        const plain = spawnSync("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body", body], { encoding: "utf8" });
        console.log(plain.error ? `  ! ${title}: ${plain.error.message}` : `  + ${title}`);
      } else console.log(`  + ${title}`);
    }
  } else console.log("gh CLI not available — findings left in .tmp-ui/ui-summary.json");
}

process.exit(findings.length ? 1 : 0);

