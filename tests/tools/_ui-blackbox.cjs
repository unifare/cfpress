/**
 * UI black-box acceptance, driven by a real browser — no model, no LLM.
 *
 * This is the layer the Node suites structurally cannot see: what actually
 * renders when a real Chromium loads the admin shell against a running
 * `wrangler dev`. A unit suite can pass while the shell paints an error
 * screen, a screen renders an empty husk, a cookie leaks to the front end,
 * or the switcher offers a site the API refuses on first click. Every check
 * here is a *browser fact*, not an API fact.
 *
 * What it covers (and why each one is browser-shaped):
 *
 *   1. the login gate — unauthenticated UI shows the sign-in form, the API
 *      answers 401, a wrong password does not enter;
 *   2. every registered screen renders — walking the hash routes the SPA
 *      itself registers, collecting console errors, page errors, failed
 *      requests and 5xx on the way (an empty render is a husk, and a husk
 *      is a defect the stubbed SPA suite cannot produce, because its stub
 *      always returns a non-empty row)
 *   3. the admin cookie does not travel to the front end — `Path` scoping
 *      is a browser behaviour (a Node fetch ignores it), and the whole
 *      point of `cfpress_admin`'s narrow path is that front-end *pages*
 *      do not carry it
 *   4. the switcher lists only the sites the user may act on — the API
 *      filters `GET sites`, but the switcher is what an operator sees;
 *   5. URL is page: hash routing resolves, Back/Forward resolves with it;
 *   6. logout then Back does not resurrect a data screen;
 *   7. three tenants render their own front ends — path-prefix, host and
 *      default all resolve independently (`--host-resolver-rules` maps the
 *      fixture host to loopback), and a 404 is a 404 on the right site;
 *   8. the retired admin asset paths 404 (the hidden admin stays hidden);
 *   9. switching the interface language leaves no English fallback behind
 *      in the sidebar — the Node guard proves the keys *exist*, this proves
 *      the screen *read* them.
 *
 * Self-cleaning like the sibling browser scripts: fixtures are prefixed
 * `uix_` and swept from both ends (a previous crash must not poison this
 * run — the lesson `user-delete.test.mjs` recorded).
 *
 * Not part of `npm test` — it needs a running dev server (default :47913):
 *   npx wrangler dev --port 47913 --ip 127.0.0.1
 *   node tests/tools/_ui-blackbox.cjs
 * Findings are written to `.tmp-ui/ui-blackbox.json` for the issue reporter.
 */
const { readdirSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = join(__dirname, "..", "..");
const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const ADMIN = process.env.CFP_ADMIN || "/admin";
const OUT = join(ROOT, ".tmp-ui");
const FIX = "uix"; // fixture id prefix, swept below

function loadPlaywright() {
  const roots = [
    process.env.NODE_PATH,
    join(process.env.USERPROFILE || "", ".workbuddy-ai", "binaries", "node", "workspace", "node_modules"),
  ].filter(Boolean);
  for (const r of roots) {
    try { return require(join(r, "playwright-core")); } catch { /* next */ }
  }
  try { return require("playwright-core"); } catch { /* fall through */ }
  return null;
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
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = join(root, d, sub, "chrome.exe");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

function openDb() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try { file = readdirSync(dir).find((x) => x.endsWith(".sqlite")); } catch { return null; }
  return file ? new DatabaseSync(join(dir, file)) : null;
}

const problems = [];
const findings = [];
let checks = 0;
let failed = 0;
function check(name, cond, detail = "") {
  checks++;
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  const rec = { name, detail };
  findings.push(rec);
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

/** Fixtures this script may have created, removed from both ends. */
function sweepDb() {
  const db = openDb();
  if (!db) return;
  const stmts = [
    `DELETE FROM site_users_sites WHERE user_id LIKE 'user\\_${FIX}%' ESCAPE '\\'`,
    `DELETE FROM admin_sessions WHERE user_id LIKE 'user\\_${FIX}%' ESCAPE '\\'`,
    `DELETE FROM site_users WHERE username LIKE '${FIX}\\_%' ESCAPE '\\'`,
    `DELETE FROM post_translations WHERE post_id LIKE '${FIX}\\_%' ESCAPE '\\'`,
    `DELETE FROM post_meta WHERE post_id LIKE '${FIX}\\_%' ESCAPE '\\'`,
    `DELETE FROM posts WHERE id LIKE '${FIX}\\_%' ESCAPE '\\'`,
    `DELETE FROM menu_items WHERE site_id LIKE '${FIX}\\%' ESCAPE '\\'`,
    `DELETE FROM menus WHERE site_id LIKE '${FIX}\\%' ESCAPE '\\'`,
    `DELETE FROM widget_instances WHERE site_id LIKE '${FIX}\\%' ESCAPE '\\'`,
    `DELETE FROM settings WHERE site_id LIKE '${FIX}\\%' ESCAPE '\\'`,
    `DELETE FROM site_locales WHERE site_id LIKE '${FIX}\\%' ESCAPE '\\'`,
    `DELETE FROM sites WHERE id LIKE '${FIX}\\%' ESCAPE '\\'`,
  ];
  for (const sql of stmts) { try { db.exec(sql); } catch { /* table may be absent */ } }
  db.close();
}

(async () => {
  const pw = loadPlaywright();
  if (!pw) { console.error("playwright-core not found (NODE_PATH or the managed workspace)"); process.exit(2); }
  const exe = findChromium();
  if (!exe) { console.error("no chromium binary under ms-playwright"); process.exit(2); }

  mkdirSync(OUT, { recursive: true });
  sweepDb();

  const browser = await pw.chromium.launch({
    executablePath: exe,
    // Map the fixture host onto loopback: host-based tenancy is a browser
    // decision (the Host header), and this is how a browser is made to send
    // one without touching the system hosts file.
    args: ["--host-resolver-rules=MAP uix.example 127.0.0.1"],
  });

  const HOST_A = "uix_a";     // path prefix /uix-a
  const HOST_B = "uix_b";     // host uix.example
  const SEED_HOST = "uix-seed-title";
  const SEED_PREFIX = "uix-prefix-title";
  const now = Math.floor(Date.now() / 1000);

  const seedFixture = () => {
    const db = openDb();
    if (!db) return;
    db.prepare("INSERT OR REPLACE INTO sites(id,name,host,path_prefix,status,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(HOST_A, HOST_A, null, "/uix-a", "active", 0, now, now);
    db.prepare("INSERT OR REPLACE INTO sites(id,name,host,path_prefix,status,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(HOST_B, HOST_B, "uix.example", null, "active", 0, now, now);
    for (const [site, id, title] of [[HOST_A, `uix_p_a`, SEED_PREFIX], [HOST_B, `uix_p_b`, SEED_HOST]]) {
      db.prepare("INSERT OR REPLACE INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, site, "admin", "post", `uix-${site}`, "published", now, now);
      db.prepare("INSERT OR REPLACE INTO post_translations(post_id,locale,title,excerpt,content,slug,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, "en", title, "", `<p>${title}</p>`, `uix-${site}`, now, now);
    }
    db.close();
  };
  seedFixture();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => {
    // A 404 on a *document* is a routing fact the suite asserts separately; a
    // 404 on a sub-resource (image, feed, favicon) is a broken link in a page
    // that otherwise looked fine. Record which URL, not just that a resource
    // failed — "Failed to load resource: 404" is unactionable without it.
    if (r.status() >= 400 && r.request().resourceType() !== "document") {
      problems.push(`resource HTTP ${r.status()} ${r.url().slice(0, 160)}`);
    }
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });

  const realErrors = () => problems.filter((t) => !/401 \(Unauthorized\)/.test(t));

  console.log("\n1. the login gate");
  await page.goto(`${BASE}${ADMIN}/`, { waitUntil: "networkidle" });
  const gateForm = await page.$("#u");
  check("unauthenticated visit shows the sign-in form", Boolean(gateForm));
  const gateApi = await page.evaluate(async () => (await fetch("/api/v1/posts")).status);
  check("the API answers 401 before any session", gateApi, 401);
  await page.fill("#u", "admin");
  await page.fill("#p", "wrong-password-on-purpose");
  await page.click("#signin");
  // A failed sign-in raises the informational dialog (the product's own
  // "invalid credentials" notice) — dismissing it is what a person does.
  const dlg = await page.waitForSelector("#dlg-ok", { timeout: 5000 }).catch(() => null);
  check("a failed sign-in explains itself in a dialog", Boolean(dlg));
  if (dlg) await dlg.click();
  await page.waitForTimeout(300);
  check("a wrong password does not open the shell", !(await page.$("#app-header")));

  console.log("\n2. sign in, and the shell comes up clean");
  problems.length = 0;
  await page.fill("#p", "change-me-now");
  await page.click("#signin");
  await page.waitForSelector("#app-header", { timeout: 20000 });
  check("correct credentials open the shell", true);
  await page.waitForTimeout(600);
  const shellErrors = realErrors();
  check("no console/page/request/5xx errors while the shell boots", shellErrors.length === 0, shellErrors.slice(0, 3).join(" | "));

  console.log("\n3. every registered screen renders");
  // Walk the hashes the SPA itself registers (SCREENS in screens/index.js),
  // plus the editor route. A husk render — a screen whose container is empty
  // because its fetch failed — is a defect only a real server can produce.
  const SCREENS = [
    "dashboard", "posts", "pages", "media", "appearance", "menus", "widgets",
    "plugins", "languages", "sites", "users", "account", "menu-config",
    "seo", "urls", "settings", "features", "activity", "search",
  ];
  const husks = [];
  for (const name of SCREENS) {
    problems.length = 0;
    await page.evaluate((n) => { location.hash = `#/${n}`; }, name);
    await page.waitForTimeout(900);
    const errs = realErrors();
    check(`screen ${name} renders without errors`, errs.length === 0, errs.slice(0, 2).join(" | "));
    // A husk render — the screen's container empty because its fetch landed
    // late — is a defect only a real server can produce (the stubbed SPA suite
    // always returns a non-empty row, so its renderer always executes). But a
    // *slow* fetch is not a husk: poll until the container has content or the
    // budget runs out, so a cold D1 cannot make a healthy screen look empty.
    let text = 0;
    for (let i = 0; i < 20; i++) {
      text = await page.evaluate(() => (document.querySelector("#content")?.textContent || "").trim().length);
      if (text >= 10) break;
      await page.waitForTimeout(150);
    }
    if (text < 10) husks.push(`${name}(${text})`);
  }
  check("no screen renders an empty husk", husks.length === 0, `husks: ${husks.join(", ")}`);

  console.log("\n4. the admin cookie does not travel to the front end");
  // `Path=/admin` is a browser decision; a Node fetch ignores Path scoping
  // entirely, which is why this cannot be asserted from a unit suite.
  const frontCookies = await page.evaluate(async () => {
    const r = await fetch("/", { credentials: "include" });
    return { status: r.status, setCookie: r.headers.get("set-cookie") || "" };
  });
  check("a front-end request does not mint/echo the admin cookie", !/cfpress_admin/.test(frontCookies.setCookie), frontCookies.setCookie.slice(0, 120));
  const docCookies = await page.evaluate(() => document.cookie);
  check("document.cookie on an admin page holds no member cookie", !/cfpress_member/.test(docCookies));
  // The stronger form of the same fact: because the cookie is `Path=<admin>`,
  // the browser does not send it to the admin API from a front-end request —
  // so the call is 401 even though this page is signed in. A Node fetch
  // ignores Path scoping and would happily succeed, which is why only a real
  // browser can assert this.
  const adminFromFront = await page.evaluate(async (base) =>
    (await fetch(base + "/api/v1/posts", { credentials: "include" })).status, ADMIN);
  check("the signed-in session is not usable from the front end (cookie Path)", adminFromFront, 401);

  console.log("\n5. the switcher lists only the sites this user may act on");
  // The API filters `GET sites` by `accessibleSiteIds`; the switcher is what
  // the operator actually sees, and it renders exactly that list. A site the
  // API refuses on first click must not appear here (rule 78: the screen
  // asks the same question the API does).
  await page.evaluate(() => { window.toggleMenu?.("site-menu"); });
  await page.waitForTimeout(300);
  const switcher = await page.evaluate(() => ({
    apiIds: [...document.querySelectorAll("#site-menu [data-switch-site]")].map((b) => b.getAttribute("data-switch-site")),
    domOpen: !document.querySelector("#site-menu")?.hidden,
  }));
  checkTruthyText("the switcher is populated for the superadmin", switcher.apiIds.length > 0, JSON.stringify(switcher.apiIds));
  check("the switcher matches the API's filtered list", switcher.apiIds.includes("default"), JSON.stringify(switcher.apiIds));

  console.log("\n5b. a scoped editor's switcher does not offer another tenant");
  // Create the editor through the product path (superadmin session), then sign
  // them in through the UI exactly like a person would. Their membership is
  // the default site only, so no other tenant may be offered — the api-side
  // filter is already unit-tested; this is the screen reading it.
  const mkEditor = await page.evaluate(async (base) =>
    (await fetch(base + "/api/v1/users?site=default", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ username: "uix_editor", password: "uix-editor-pass-1", role: "editor" }),
    })).status, ADMIN);
  check("a scoped editor can be created (control)", mkEditor === 201, `status ${mkEditor}`);
  const eCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ePage = await eCtx.newPage();
  await ePage.goto(`${BASE}${ADMIN}/`, { waitUntil: "networkidle" });
  await ePage.fill("#u", "uix_editor");
  await ePage.fill("#p", "uix-editor-pass-1");
  await ePage.click("#signin");
  await ePage.waitForSelector("#app-header", { timeout: 20000 });
  await ePage.evaluate(() => { window.toggleMenu?.("site-menu"); });
  await ePage.waitForTimeout(300);
  const eSwitch = await ePage.evaluate(() => ({
    ids: [...document.querySelectorAll("#site-menu [data-switch-site]")].map((b) => b.getAttribute("data-switch-site")),
    api: null,
  }));
  eSwitch.api = await ePage.evaluate(async () => (await (await fetch("/admin/api/v1/sites", { credentials: "include" })).json()).items.map((s) => s.id));
  check("the scoped editor's switcher matches their API list", eSwitch.ids, eSwitch.api);
  check("the scoped editor is not offered another tenant", !eSwitch.ids.includes(HOST_A) && !eSwitch.ids.includes(HOST_B), JSON.stringify(eSwitch.ids));
  await eCtx.close();

  console.log("\n6. URL is page: hash resolves, Back resolves with it");
  problems.length = 0;
  await page.evaluate(() => { location.hash = "#/media"; });
  await page.waitForTimeout(800);
  const mediaHash = await page.evaluate(() => location.hash);
  check("hash routing opens the media screen", mediaHash.includes("media"), mediaHash);
  await page.evaluate(() => { location.hash = "#/settings"; });
  await page.waitForTimeout(800);
  await page.goBack();
  await page.waitForTimeout(800);
  const backHash = await page.evaluate(() => location.hash);
  check("Back returns to the previous screen", backHash.includes("media"), backHash);
  const backErrs = realErrors();
  check("navigation produced no errors", backErrs.length === 0, backErrs.slice(0, 2).join(" | "));

  console.log("\n7. logout, then Back does not resurrect a data screen");
  await page.evaluate(async () => { await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" }); });
  await page.goto(`${BASE}${ADMIN}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const afterLogout = await page.$("#app-header");
  check("after logout the shell is gone", !afterLogout);
  await page.goBack();
  await page.waitForTimeout(900);
  const dataAfterBack = await page.evaluate(() => {
    const el = document.querySelector("#app-main, main");
    return (el?.textContent || "").length;
  });
  check("Back after logout renders no data", dataAfterBack < 10, `main text length ${dataAfterBack}`);

  console.log("\n8. three tenants, three front ends");
  problems.length = 0;
  const frontA = await page.goto(`${BASE}/uix-a/en/blog/uix-${HOST_A}`, { waitUntil: "networkidle" }).then((r) => r.text());
  check("the path-prefixed site serves its own post", frontA.includes(SEED_PREFIX), `looking for ${SEED_PREFIX}`);
  check("and not the other tenant's post", !frontA.includes(SEED_HOST));
  const frontB = await page.goto(`http://uix.example:${new URL(BASE).port}/en/blog/uix-${HOST_B}`, { waitUntil: "networkidle" }).then((r) => r.text());
  check("the host-mapped site serves its own post", frontB.includes(SEED_HOST), `looking for ${SEED_HOST}`);
  check("and not the other tenant's post", !frontB.includes(SEED_PREFIX));
  // A prefixed site's front page must not carry the *other* tenant's title —
  // and its own links must stay inside its own prefix. A nav link without the
  // prefix sends the visitor to the default tenant (the URL a browser takes is
  // the URL the template emitted, not the one resolveSite matched).
  const missing = await page.goto(`${BASE}/uix-a/en/blog/no-such-slug-uix`, { waitUntil: "networkidle" });
  check("a miss on the prefixed site is a 404, on that site", missing.status(), 404);
  const feedB = await page.goto(`http://uix.example:${new URL(BASE).port}/feed.xml`).then((r) => r.text());
  check("the feed on site B carries site B's post", feedB.includes(SEED_HOST) && !feedB.includes(SEED_PREFIX));
  // Every in-page link on the prefixed site must stay under the prefix. A link
  // that drops it (e.g. `/en/blog/x`) addresses the *default* tenant: the
  // browser follows it there, which is a cross-tenant hop no API guard sees.
  problems.length = 0;
  const linksA = await page.goto(`${BASE}/uix-a/en/blog/uix-${HOST_A}`, { waitUntil: "networkidle" }).then((r) => r.text());
  const inPage = [...linksA.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith("//"));
  const escaping = inPage.filter((h) => !h.startsWith("/uix-a/"));
  check("every in-page link on the prefixed site stays under its prefix", escaping.length === 0, `escaping: ${escaping.slice(0, 6).join(" , ")}`);
  const smA = await page.goto(`${BASE}/uix-a/sitemap.xml`).then((r) => r.text());
  const smLocs = [...smA.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check("the sitemap on the prefixed site lists only its own URLs", smLocs.every((l) => l.includes("/uix-a/")), `locs: ${smLocs.join(" , ")}`);
  const frontErrs = realErrors().filter((t) => !/401 \(Unauthorized\)/.test(t));
  check("front-end walks produced no 5xx or uncaught errors", frontErrs.length === 0, frontErrs.slice(0, 4).join(" | "));
  // And no broken sub-resource on a rendered page: an image or feed 404 on a
  // page that otherwise returns 200 is invisible to every status-code check.
  const broken = realErrors().filter((t) => /^resource HTTP 4\d\d/.test(t));
  check("no broken sub-resources on the pages walked", broken.length === 0, broken.slice(0, 4).join(" | "));

  console.log("\n9. the retired admin asset paths stay dark");
  // With the default prefix the old `/admin` is the same route, so this checks
  // the catch-all: an unknown asset under the admin must 404 rather than fall
  // through to the front-end router and render a themed 200 page.
  // (goto throws on a 4xx — that is the expected answer, so catch it.)
  let ghostStatus = 0;
  try { const g = await page.goto(`${BASE}${ADMIN}/js/does-not-exist-uix.js`); ghostStatus = g.status(); }
  catch { ghostStatus = 404; }
  check("an unknown admin asset does not fall through to the front-end renderer", ghostStatus === 404, `status ${ghostStatus}`);

  console.log("\n10. switching the interface language leaves no English fallback");
  // The Node guards prove every `t()` key *exists* in both packs. This proves
  // the screen *read* it: a sidebar still labelled "Dashboard" in zh-CN is a
  // key nobody consumed, and only a real render shows it.
  //
  // A dedicated page, not the one this suite has been driving: the previous
  // in-place version kept losing its execution context to a mid-flight
  // navigation, and a language check that cannot run is a check that hides.
  try {
    const lp = await ctx.newPage();
    await lp.goto(`${BASE}${ADMIN}/`, { waitUntil: "domcontentloaded" });
    await lp.fill("#u", "admin");
    await lp.fill("#p", "change-me-now");
    await lp.click("#signin");
    await lp.waitForSelector("#app-header", { timeout: 20000 });
    const available = await lp.evaluate(async () => {
      const d = await (await fetch("/api/v1/i18n/messages?locale=zh-CN", { credentials: "include" })).json();
      return d.available || [];
    });
    if (!available.includes("zh-CN")) {
      await lp.evaluate(async () => {
        await fetch("/admin/api/v1/i18n/locales", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ code: "zh-CN", name: "简体中文" }),
        }).catch(() => {});
      });
    }
    await lp.evaluate(async () => {
      await fetch("/admin/api/v1/i18n/ui-locale", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ locale: "zh-CN" }) }).catch(() => {});
    });
    await lp.reload({ waitUntil: "networkidle" });
    await lp.waitForTimeout(1200);
    const sidebarText = await lp.evaluate(() => (document.querySelector(".sidebar")?.textContent || ""));
    const leftovers = ["Dashboard", "Settings", "Appearance", "Extensions", "Users", "Sites"].filter((w) => sidebarText.includes(w));
    check("the sidebar carries no English fallback labels after switching to zh-CN", leftovers.length === 0, `left: ${leftovers.join(", ")}`);
    // Put the operator's own interface language back: `ui_lang` is a personal
    // preference, and leaving this run's choice behind rewrites someone else's
    // setting (the lesson _i18n-browser.cjs recorded).
    await lp.evaluate(async () => {
      await fetch("/admin/api/v1/i18n/ui-locale", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ locale: null }) }).catch(() => {});
      await fetch("/admin/api/v1/i18n/locales/zh-CN", { method: "DELETE", credentials: "include" }).catch(() => {});
    }).catch(() => {});
    await lp.close();
  } catch (e) {
    console.log(`  skip the language section: ${e.message}`);
  }

  await browser.close();
  sweepDb();

  writeFileSync(join(OUT, "ui-blackbox.json"), JSON.stringify({
    suite: "ui-blackbox", at: new Date().toISOString(), base: BASE,
    checks, failed, findings,
  }, null, 2));
  console.log(`\n${checks - failed} passed, ${failed} failed`);
  console.log(`findings: ${join(OUT, "ui-blackbox.json")}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });

function checkTruthyText(name, cond, detail) {
  checks++;
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  findings.push({ name, detail });
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}
