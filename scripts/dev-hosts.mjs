#!/usr/bin/env node
/**
 * dev-hosts — bind the local test domains to the dev server's sites by
 * managing a **marker block** in the system hosts file.
 *
 * ## Why a tool, and why it is this careful
 *
 * The hosts file is a system file owned by the operator. Two things can go
 * wrong and both are irreversible from inside the tool: clobbering entries the
 * operator added by hand, and leaving a half-written file behind when the
 * process dies mid-write. So this tool is built around four rules:
 *
 *   1. **It only ever edits inside a marker block** it owns. Anything outside
 *      `# >>> cfpress-dev begin` / `# <<< cfpress-dev end` is byte-preserved.
 *   2. **It backs up before the first write of a run**, and verifies the backup
 *      by reading it back — a backup that was never written is worth nothing
 *      (AGENTS.md, false-green #5).
 *   3. **It is idempotent**: running it twice produces the same file, never a
 *      duplicated block.
 *   4. **It refuses to be silent about permissions.** Writing the hosts file
 *      needs an elevated shell; the tool says so, prints the exact command to
 *      re-run, and exits 3 ("refused by a precondition") instead of pretending.
 *
 * ## Where the domains come from
 *
 * The **single source is the database**: every site with a `host` column value
 * (see `scripts/seed-sites.mjs`, which seeds the local test sites). This tool
 * never carries its own list of domains — a second list is a list that drifts.
 *
 * ## Usage
 *
 *   node scripts/dev-hosts.mjs list            # domains from the DB + current block
 *   node scripts/dev-hosts.mjs add [--dry-run] # write/refresh the marker block
 *   node scripts/dev-hosts.mjs remove          # remove the marker block
 *   node scripts/dev-hosts.mjs verify          # DNS + HTTP check, per domain
 *
 * Exit codes: 0 ok, 1 failed, 2 usage, 3 needs an elevated shell.
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import dns from "node:dns/promises";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.CFP_PORT || "47913";

const HOSTS_PATH =
  process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";

const BEGIN =
  "# >>> cfpress-dev begin (managed by scripts/dev-hosts.mjs — do not edit between these lines)";
const END = "# <<< cfpress-dev end";

const BEGIN_RE = /^#\s*>>>?\s*cfpress-dev begin/i;
const END_RE = /^#\s*<<<??\s*cfpress-dev end/i;

/** The dev server's port; the hosts file maps names to addresses, not ports. */

function openDb() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try {
    file = readdirSync(dir).find((x) => x.endsWith(".sqlite") && x !== "metadata.sqlite");
  } catch {
    return null;
  }
  return file ? new DatabaseSync(join(dir, file)) : null;
}

/**
 * The domains to bind, straight from the sites table. One host per site; a
 * site without a `host` is not bound (it is reached by path prefix or as the
 * fallback), and that is stated rather than guessed.
 */
function hostBoundSites() {
  const db = openDb();
  if (!db) return { error: "local D1 not found — run: npx wrangler d1 migrations apply cfpress --local" };
  try {
    const rows = db.prepare("SELECT id, host FROM sites WHERE host IS NOT NULL AND host <> '' ORDER BY rowid").all();
    const seen = new Set();
    const sites = [];
    for (const r of rows) {
      const host = String(r.host).toLowerCase();
      if (seen.has(host)) continue;
      seen.add(host);
      sites.push({ id: r.id, host });
    }
    return { sites };
  } finally {
    db.close();
  }
}

/** Split the hosts content into (before, block|[], after) by the markers. */
function splitBlock(content) {
  const lines = content.split(/\r?\n/);
  const before = [];
  const block = [];
  const after = [];
  let state = "before";
  for (const line of lines) {
    if (state === "before" && BEGIN_RE.test(line)) { state = "block"; continue; }
    if (state === "block" && END_RE.test(line)) { state = "after"; continue; }
    (state === "before" ? before : state === "block" ? block : after).push(line);
  }
  // An unterminated block (a hand-truncated file) must not silently swallow the
  // rest of the file, so anything after a `begin` with no `end` is an error.
  if (state === "block") return { error: "marker block is unterminated — the `end` line is missing" };
  return { before, block, after };
}

function eolOf(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function buildBlock(sites) {
  return [
    BEGIN,
    ...sites.map((s) => `127.0.0.1 ${s.host}`),
    END,
  ];
}

/**
 * Back up the hosts file **and verify the backup** by reading it back. Returns
 * the backup path. The primary location is next to the hosts file (that is
 * where an operator looks first); without elevation that directory is not
 * writable, so the backup falls back to the temp dir and says so.
 */
function backup(hostsPath, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidates = [
    `${hostsPath}.cfpress-${stamp}.bak`,
    join(tmpdir(), `hosts.cfpress-${stamp}.bak`),
  ];
  let lastError = null;
  for (const path of candidates) {
    try {
      writeFileSync(path, content);
      // Verify by reading back: a backup that cannot be read is a backup that
      // does not exist, and finding that out *after* the write is too late.
      const back = readFileSync(path);
      if (back.length !== content.length) {
        return { error: `backup ${path} wrote ${back.length} bytes but the source is ${content.length}` };
      }
      return { path };
    } catch (e) {
      lastError = e;
    }
  }
  return { error: `could not write a backup anywhere: ${lastError?.message ?? lastError}` };
}

function writeHosts(path, content) {
  try {
    writeFileSync(path, content);
    return { ok: true };
  } catch (e) {
    const code = e?.code || "";
    if (/EACCES|EPERM/.test(code)) {
      return {
        error:
          `the hosts file is not writable from this shell (${code}).\n` +
          `  Re-run elevated, from the repo root, in PowerShell:\n` +
          `    Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\\dev-hosts.ps1','add'\n` +
          `  The backup this run already made is untouched; nothing was written.`,
      };
    }
    return { error: `${code || "error"}: ${e?.message ?? e}` };
  }
}

function cmdList() {
  const { sites, error } = hostBoundSites();
  if (error) { console.error(error); return 2; }
  console.log(`sites with a host binding (from the local D1): ${sites.length}`);
  for (const s of sites) console.log(`  ${s.host.padEnd(28)} -> site ${s.id}`);
  if (!sites.length) console.log("  (none — run: npm run seed:sites)");

  if (!existsSync(HOSTS_PATH)) { console.error(`\nhosts file not found: ${HOSTS_PATH}`); return 1; }
  const content = readFileSync(HOSTS_PATH, "utf8");
  const parsed = splitBlock(content);
  if (parsed.error) { console.error(`\n${parsed.error}`); return 1; }
  console.log(`\nmarker block in ${HOSTS_PATH}: ${parsed.block.length ? `${parsed.block.length} line(s)` : "absent"}`);
  for (const l of parsed.block) console.log(`  ${l}`);
  return 0;
}

function cmdAdd(dryRun) {
  const { sites, error } = hostBoundSites();
  if (error) { console.error(error); return 2; }
  if (!sites.length) {
    console.error("no site has a host binding — run: npm run seed:sites");
    return 1;
  }
  if (!existsSync(HOSTS_PATH)) { console.error(`hosts file not found: ${HOSTS_PATH}`); return 1; }
  const content = readFileSync(HOSTS_PATH, "utf8");
  const parsed = splitBlock(content);
  if (parsed.error) { console.error(parsed.error); return 1; }
  const eol = eolOf(content);

  const before = parsed.before.join(eol);
  const after = parsed.after.join(eol);
  const block = buildBlock(sites).join(eol);
  // Rebuild with an explicit trailing newline so the file always ends cleanly.
  const next = [before, block, after].filter((s) => s.length).join(eol) + eol;

  if (next === content + (content.endsWith("\n") ? "" : eol)) {
    console.log("already up to date — nothing to write.");
    return 0;
  }

  console.log(`would write ${next.length} bytes to ${HOSTS_PATH} (was ${content.length})`);
  console.log(`  domains: ${sites.map((s) => s.host).join(", ")}`);
  if (dryRun) { console.log("\ndry run — nothing written."); return 0; }

  // Back up BEFORE the first write of this run, and verify the backup.
  const bak = backup(HOSTS_PATH, content);
  if (bak.error) { console.error(`aborted before writing: ${bak.error}`); return 1; }
  console.log(`backup: ${bak.path} (verified ${content.length} bytes)`);

  const w = writeHosts(HOSTS_PATH, next);
  if (w.error) { console.error(`\n${w.error}`); return 3; }

  // Verify the write: the block must contain exactly the domains we asked for.
  // ⚠️ `splitBlock` counts only the lines *between* the markers (the markers
  // themselves are consumed), so the right expectation is `sites.length` — not
  // `sites.length + 2`. The first draft expected +2 and reported a write that
  // had landed perfectly as a failure.
  const check = splitBlock(readFileSync(HOSTS_PATH, "utf8"));
  if (check.error) { console.error(check.error); return 1; }
  const expectedLines = sites.map((s) => `127.0.0.1 ${s.host}`);
  const landed = check.block.join(eol);
  const matches = expectedLines.every((l) => landed.includes(l)) &&
                  landed.split(eol).filter(Boolean).length === expectedLines.length;
  if (!matches) {
    console.error(`write did not land as expected (block has ${check.block.length} line(s))`);
    console.error(`restore from: ${bak.path}`);
    return 1;
  }
  console.log(`written: ${sites.length} domain(s) inside the marker block.`);
  console.log(`verify now:  node scripts/dev-hosts.mjs verify`);
  return 0;
}

function cmdRemove(dryRun) {
  if (!existsSync(HOSTS_PATH)) { console.error(`hosts file not found: ${HOSTS_PATH}`); return 1; }
  const content = readFileSync(HOSTS_PATH, "utf8");
  const parsed = splitBlock(content);
  if (parsed.error) { console.error(parsed.error); return 1; }
  if (!parsed.block.length) { console.log("no marker block present — nothing to remove."); return 0; }
  const eol = eolOf(content);
  const next = [parsed.before.join(eol), parsed.after.join(eol)].filter((s) => s.length).join(eol) + eol;
  console.log(`would remove ${parsed.block.length} line(s) from ${HOSTS_PATH}`);
  if (dryRun) { console.log("\ndry run — nothing written."); return 0; }

  const bak = backup(HOSTS_PATH, content);
  if (bak.error) { console.error(`aborted before writing: ${bak.error}`); return 1; }
  console.log(`backup: ${bak.path} (verified ${content.length} bytes)`);

  const w = writeHosts(HOSTS_PATH, next);
  if (w.error) { console.error(`\n${w.error}`); return 3; }
  console.log("marker block removed. Everything outside it is untouched.");
  return 0;
}

async function cmdVerify() {
  const { sites, error } = hostBoundSites();
  if (error) { console.error(error); return 2; }
  if (!sites.length) { console.error("no site has a host binding — run: npm run seed:sites"); return 1; }

  let bad = 0;
  for (const s of sites) {
    // 1. Does the OS resolve the name to 127.0.0.1? (reads the hosts file)
    let ip = null;
    try { ip = (await dns.lookup(s.host)).address; } catch { /* unresolved */ }
    if (ip !== "127.0.0.1") {
      console.log(`  FAIL ${s.host.padEnd(28)} DNS -> ${ip ?? "unresolved"} (expected 127.0.0.1)`);
      bad++;
      continue;
    }
    // 2. Does the dev server answer *as that site*? `X-CFPress-Site` is the
    //    router's own answer, so this checks the mapping end to end.
    //    The domain goes in the **URL**, not in a hand-set `Host` header: a
    //    real visitor resolves the name and connects, and `fetch` is free to
    //    rewrite a manually supplied Host — the first verify run reported
    //    every domain as the default site for exactly that reason.
    let siteId = null, status = 0;
    try {
      const res = await fetch(`http://${s.host}:${PORT}/`);
      status = res.status;
      siteId = res.headers.get("x-cfpress-site");
    } catch (e) {
      console.log(`  FAIL ${s.host.padEnd(28)} dev server unreachable on :${PORT} (${e.message})`);
      bad++;
      continue;
    }
    const ok = siteId === s.id;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${s.host.padEnd(28)} -> site ${siteId ?? "?"} (HTTP ${status})${ok ? "" : ` expected ${s.id}`}`);
  }
  console.log(`\n${sites.length - bad}/${sites.length} domain(s) bound correctly.`);
  return bad ? 1 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run");

let code = 2;
switch (cmd) {
  case "list": code = cmdList(); break;
  case "add": code = cmdAdd(dryRun); break;
  case "remove": code = cmdRemove(dryRun); break;
  case "verify": code = await cmdVerify(); break;
  case undefined: console.error("usage: node scripts/dev-hosts.mjs <list|add|remove|verify> [--dry-run]"); break;
  default: console.error(`unknown command: ${cmd}\nusage: node scripts/dev-hosts.mjs <list|add|remove|verify> [--dry-run]`); break;
}
process.exit(code);
