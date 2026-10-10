/**
 * Real-browser acceptance for the Sites screen (batch 28).
 *
 * `admin-spa.test.mjs` renders the screen from a *stubbed* payload and
 * `admin-contract.test.mjs` calls the API directly. Neither can show the thing
 * an operator sees: that a real `GET sites?withCounts=1` travels over the wire
 * and lands in the table as numbers, that each row's preview link points at
 * **that** site's front end, and that the theme badge navigates with the right
 * site as context.
 *
 * That gap is not hypothetical here. This script is what found the query-string
 * defect: the prefixed API mount rebuilt its URL without `u.search`, so every
 * query parameter vanished for admin requests — the count column rendered empty
 * against a live server while the whole unit suite stayed green, because those
 * tests build their requests at the prefixed path themselves.
 *
 * Self-cleaning: it creates one path-prefixed fixture site with a post, a page
 * and a chosen theme, and deletes all of it before exiting.
 *
 * Not part of `npm test` — it needs a running dev server (default :47913).
 *
 * Usage: node tests/tools/_sites-screen-browser.cjs
 */
const { readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const ADMIN = process.env.CFP_ADMIN || "/admin";
const SITE = "acc_sites";
const PREFIX = "/acc-sites";

function loadPlaywright() {
  // `playwright-core` lives in the managed Node workspace; `require.resolve`
  // from that directory works regardless of where this script is run from.
  const roots = [
    process.env.NODE_PATH,
    join(process.env.USERPROFILE || "", ".workbuddy-ai", "binaries", "node", "workspace", "node_modules"),
  ].filter(Boolean);
  for (const r of roots) {
    try { return require(join(r, "playwright-core")); } catch { /* try the next */ }
  }
  try { return require("playwright-core"); } catch { return null; }
}

function findChromium() {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
    join(process.env.USERPROFILE || "", ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-win64", "chrome-win", "chrome-linux", "chrome-mac"]) {
        const exe = join(root, d, sub, sub === "chrome-mac" ? "Chromium.app/Contents/MacOS/Chromium" : (sub.startsWith("chrome-win") ? "chrome.exe" : "chrome"));
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) { console.error("playwright-core not found."); process.exit(2); }
const exe = findChromium();
if (!exe) { console.error("No chromium found in the playwright cache."); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
};

// CommonJS has no top-level `await`, so the whole flow lives in one async
// function. `main()` is invoked at the bottom of the file.
async function main() {
const { chromium } = pw;
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const apiCalls = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.pathname.includes("/api/")) apiCalls.push(u.pathname + u.search);
});
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// ── Sign in ────────────────────────────────────────────────────────────────
await page.goto(`${BASE}${ADMIN}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#u", { timeout: 15000 });
await page.fill("#u", "admin");
await page.fill("#p", "change-me-now");
await page.click("#signin");
await page.waitForFunction(() => {
  const a = document.querySelector("#app");
  return a && a.textContent && a.textContent.length > 40 && !a.querySelector("#signin");
}, { timeout: 15000 }).catch(() => {});

// ── Create the fixture site through the API (so `seedSiteLocales` runs) ────
// Creating it via the API rather than by hand is deliberate: the language-row
// seed is part of what this batch fixed, and a hand-written row would hide it.
const created = await page.evaluate(async ({ base, id, prefix }) => {
  const r = await fetch(base + "/api/v1/sites", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name: "Acceptance Site", path_prefix: prefix }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { base: ADMIN, id: SITE, prefix: PREFIX });
check("the fixture site is created through the API", created.status === 201 || created.status === 400,
  `status=${created.status} body=${JSON.stringify(created.body)}`);

// Give it content and a chosen theme so every column has something to show.
await page.evaluate(async ({ base, id }) => {
  const post = async (slug, type, status) => fetch(base + `/api/v1/content/${type}?site=${id}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: slug, slug, status, locale: "en", content: [] }),
  });
  await post("acc-post-1", "post", "published");
  await post("acc-page-1", "page", "published");
  await fetch(base + "/api/v1/extensions/themes/default/activate?site=" + id, { method: "POST", credentials: "include" });
}, { base: ADMIN, id: SITE });

// ── Open the Sites screen ──────────────────────────────────────────────────
await page.evaluate(() => { location.hash = "#/sites"; });
await page.waitForSelector("table.table tbody tr", { timeout: 15000 }).catch(() => {});
await page.waitForFunction((id) => !!document.querySelector(`[data-site-theme="${id}"], code`), { timeout: 8000 }).catch(() => {});

const rows = await page.evaluate(() =>
  [...document.querySelectorAll("table.table tbody tr")].map((tr) => ({
    id: tr.querySelector("code")?.textContent?.trim() || "",
    cells: [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()),
    preview: tr.querySelector("a[href]")?.getAttribute("href") || "",
    theme: tr.querySelector("[data-site-theme]")?.textContent?.trim() || "",
  }))
);
check("the Sites screen rendered at least one row", rows.length > 0, `rows=${rows.length}`);

// 1. The counts, in one request.
const countCalls = apiCalls.filter((p) => /sites\?[^/]*withCounts/.test(p));
check("the screen asked for the counts in one request", countCalls.length === 1, `calls: ${JSON.stringify(countCalls)}`);
check("every row shows a real count triple", rows.length > 0 && rows.every((r) => /\d+\s*\S*\s*·\s*\d+/.test(r.cells.join(" "))),
  `rows: ${JSON.stringify(rows.map((r) => [r.id, r.cells]))}`);
check("no row renders a literal undefined", !rows.some((r) => /undefined/.test(r.cells.join(" "))), "");

// 2. The preview link, per site.
const sitesResp = await page.evaluate(async (base) => (await fetch(base + "/api/v1/sites", { credentials: "include" })).json(), ADMIN);
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
const mismatched = (sitesResp.items || []).filter((s) => {
  const row = byId[s.id];
  if (!row) return false;
  if (s.path_prefix) return !row.preview.startsWith(s.path_prefix + "/");
  if (s.host) return !row.preview.startsWith(`https://${s.host}/`);
  return !row.preview.startsWith("/") || row.preview.startsWith("//");
});
check("every preview link comes from that site's own prefix or host", mismatched.length === 0,
  `wrong: ${JSON.stringify(mismatched.map((s) => [s.id, byId[s.id] && byId[s.id].preview, s.path_prefix, s.host]))}`);
const fx = rows.find((r) => r.id === SITE);
check("the path-prefixed fixture previews inside its prefix", !fx || fx.preview.startsWith(PREFIX + "/"), `href=${fx && fx.preview}`);

// 3. The theme badge and where it navigates.
const themed = rows.find((r) => r.theme);
check("at least one row shows a theme badge", Boolean(themed), `badges: ${JSON.stringify(rows.map((r) => [r.id, r.theme]))}`);
if (themed) {
  await page.click(`[data-site-theme="${themed.id}"]`);
  await page.waitForFunction(() => (location.hash || "").includes("themes"), { timeout: 15000 }).catch(() => {});
  check("clicking the badge opens the Themes screen", (await page.evaluate(() => location.hash)).includes("themes"), "");
}

const realErrors = consoleErrors.filter((t) => !/401 \(Unauthorized\)/.test(t));
check("no uncaught page/console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

// ── Clean up ───────────────────────────────────────────────────────────────
// Deleting the site purges its registry rows; the content rows stay by policy
// (a site delete never destroys an author's work), so they are removed here.
await page.evaluate(async ({ base, id }) => {
  const list = await (await fetch(base + `/api/v1/content/post?site=${id}`, { credentials: "include" })).json();
  for (const p of list.items || []) await fetch(base + `/api/v1/content/post/${p.id}?site=${id}`, { method: "DELETE", credentials: "include" });
  const pl = await (await fetch(base + `/api/v1/content/page?site=${id}`, { credentials: "include" })).json();
  for (const p of pl.items || []) await fetch(base + `/api/v1/content/page/${p.id}?site=${id}`, { method: "DELETE", credentials: "include" });
  await fetch(base + `/api/v1/sites/${id}`, { method: "DELETE", credentials: "include" });
}, { base: ADMIN, id: SITE });

const gone = await page.evaluate(async ({ base, id }) => {
  const j = await (await fetch(base + "/api/v1/sites", { credentials: "include" })).json();
  return (j.items || []).some((s) => s.id === id);
}, { base: ADMIN, id: SITE });
check("the fixture site is cleaned up", gone === false, `still present: ${gone}`);

await browser.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
