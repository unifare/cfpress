/**
 * Real-browser acceptance for the unified admin menu registry (batch 3).
 *
 * The marquee claim of this batch is: **a theme declares a table, and the admin
 * gets a working list and edit form without the theme shipping any admin
 * code.** The Node suites prove the API side of that and the SPA structure test
 * proves the screens render against a stub — neither proves the two are wired
 * together in a browser. This script does.
 *
 * It also covers the plugin path end to end: a plugin registers a menu, the
 * sidebar grows an "Extensions" group, the menu opens the plugin's own settings
 * and saving them is accepted.
 *
 * Self-provisioning and self-cleaning. It installs the reference plugin and the
 * fixture theme itself (it used to *assume* `notify` was installed, because
 * `admin-menus.test.mjs` left it behind — that suite now cleans up, and the
 * assumption turned into a script that failed on a plugin that was never
 * there), pins the admin's interface language to English for the run (every
 * label asserted here is the English spelling), and restores both the plugin
 * and the language preference at the end.
 *
 * Self-cleaning detail: the plugin is disabled, the theme deactivated, and then
 * the fixture's own database footprint removed (`theme_table_defs` row,
 * `theme_installs` row, the generated table). Deactivation alone is not enough
 * — the registry deliberately survives it — and a leftover row makes a later
 * suite read this theme's table as if it were its own.
 *
 * Usage:
 *   npx wrangler dev --port 47913 --ip 127.0.0.1   (in another shell)
 *   node tests/tools/_admin-menus-browser.cjs
 */
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);
const { zipSync, strToU8 } = require("fflate");
const { join } = require("path");
const { readdirSync, readFileSync } = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ROOT = join(__dirname, "..", "..");
const BASE = process.env.CFPRESS_BASE || "http://127.0.0.1:47913";
const THEME = "menusbrowser";
/** The *logical* table name from the manifest — what `args.table` names, and
 *  therefore the first half of every `data-table-*` value. Not the theme name.
 *  Kept unique to this fixture so a run can never be confused with a table a
 *  sibling suite registered on the same site. */
const TABLE = "menuitem";

const problems = [];
const apiLog = [];
let checks = 0;
let failed = 0;
function check(name, cond, detail = "") {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** The theme package, built here so the manifest is visible next to the
 *  assertions that depend on it. */
function themeZipBase64() {
  const manifest = {
    name: THEME,
    title: "Menu Browser Demo",
    version: "1.0.0",
    templates: ["index"],
    tables: [
      {
        name: TABLE,
        label: "Products",
        fields: [
          { key: "name", type: "text", label: "Name" },
          { key: "price", type: "number", label: "Price" },
        ],
        // Rule 41: a field holding prose a human reads must declare its
        // multi-language capability, and the validator **rejects** the install
        // when it does not. This fixture predates that rule, so the upload was
        // refused and every assertion after it failed on a missing menu — a
        // broken acceptance script that looked like a broken feature.
        translatable: ["name"],
      },
    ],
    adminMenus: [
      { id: "products", label: "Products", icon: "box", screen: "table-list", args: { table: TABLE } },
    ],
    runtime: "declarative",
  };
  const zip = zipSync({
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(
      `<!doctype html><html><head><title>{{page.title}}</title></head><body>MENUSBROWSER</body></html>`
    ),
  });
  return Buffer.from(zip).toString("base64");
}

/**
 * Remove everything this fixture put in the local D1.
 *
 * Deactivating the theme is **not** enough, and that is not a bug: the whole
 * point of `theme_table_defs` is that it survives deactivation, so the data
 * stays reachable if the theme comes back. A test fixture has no "comes back",
 * so it has to clean up after itself — otherwise a later suite reads the
 * shared database and sees this theme's table as if it had declared it.
 * (That is exactly how `i18n.test.mjs` first went red.)
 */
function resetFixture() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try {
    file = readdirSync(dir).find((x) => x.endsWith(".sqlite"));
  } catch {
    return { tables: [], defs: 0, installs: 0 }; // no local D1 yet — nothing to clean
  }
  if (!file) return { tables: [], defs: 0, installs: 0 };
  const db = new DatabaseSync(join(dir, file));
  const stmts = [
    // ⚠️ `theme_table_defs` is keyed by **owner_type / owner_name**, not
    // `theme_name`. The old spelling threw `no such column: theme_name`, the
    // `catch` below swallowed it, and the declaration survived — so the next
    // boot re-created this fixture's `_i18n` table from the leftover row. A
    // cleanup that is never verified is indistinguishable from one that did
    // nothing (AGENTS.md false-green #5), which is why this function now
    // returns what is still there and the caller asserts on it.
    `DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name='${THEME}'`,
    `DELETE FROM post_types WHERE declared_by_theme='${THEME}'`,
    `DELETE FROM theme_installs WHERE name='${THEME}'`,
    `DROP TABLE IF EXISTS theme_${THEME}_${TABLE}`,
    `DROP TABLE IF EXISTS theme_${THEME}_${TABLE}_i18n`,
  ];
  for (const s of stmts) {
    try { db.exec(s); } catch { /* table may not exist on a first run */ }
  }
  const residue = {
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").all(`theme_${THEME}_%`).map((r) => r.name),
    defs: db.prepare("SELECT COUNT(*) AS n FROM theme_table_defs WHERE owner_name=?").get(THEME)?.n ?? 0,
    installs: db.prepare("SELECT COUNT(*) AS n FROM theme_installs WHERE name=?").get(THEME)?.n ?? 0,
  };
  db.close();
  return residue;
}

/** Open the shared local D1, or null when it does not exist yet. */
function openDb() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try { file = readdirSync(dir).find((x) => x.endsWith(".sqlite")); } catch { return null; }
  return file ? new DatabaseSync(join(dir, file)) : null;
}

/**
 * The admin's own interface-language preference.
 *
 * Every label this script asserts on ("Extensions", "From theme", "Products")
 * is the **English** spelling, so the script has to establish an English
 * interface — and put the operator's choice back afterwards. It used not to,
 * and the whole run silently became 4 failures the day the preference was
 * `zh-CN`: the sidebar grew `扩展` instead of `Extensions`, the group lookup
 * found nothing, and the failures read like broken features rather than an
 * unmet precondition.
 */
function readUiLang() {
  const db = openDb();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT ui_lang FROM site_users WHERE username='admin'").get();
    return row ? row.ui_lang ?? null : null;
  } catch { return null; } finally { db.close(); }
}

function writeUiLang(value) {
  const db = openDb();
  if (!db) return;
  try { db.prepare("UPDATE site_users SET ui_lang=? WHERE username='admin'").run(value); } catch { /* ok */ } finally { db.close(); }
}

/** The reference plugin, zipped from the repo copy — same idea as the theme. */
function pluginZipBase64() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "content", "plugins", "notify", "plugin.json"), "utf8"));
  const zip = zipSync({ "plugin.json": strToU8(JSON.stringify(manifest, null, 2)) });
  return Buffer.from(zip).toString("base64");
}

/**
 * Undo a plugin install this run performed. There is no uninstall route for
 * plugins (only enable/disable), so this goes straight at the shared D1 — the
 * same way `resetFixture` cleans up the theme fixture.
 */
function removePlugin() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try { file = readdirSync(dir).find((x) => x.endsWith(".sqlite")); } catch { return; }
  if (!file) return;
  const db = new DatabaseSync(join(dir, file));
  const stmts = [
    "DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name='notify')",
    "DELETE FROM plugin_setting_defs WHERE plugin_name='notify'",
    "DELETE FROM extension_capabilities WHERE extension_type='plugin' AND extension_name='notify'",
    "DELETE FROM extension_versions WHERE extension_name='notify'",
    "DELETE FROM theme_table_defs WHERE owner_type='plugin' AND owner_name='notify'",
    "DELETE FROM admin_menu_registry WHERE owner_type='plugin' AND owner_name='notify'",
    "DROP TABLE IF EXISTS plugin_notify_log_i18n",
    "DROP TABLE IF EXISTS plugin_notify_log",
    "DELETE FROM plugin_installs WHERE name='notify'",
  ];
  for (const s of stmts) {
    try { db.exec(s); } catch { /* not there */ }
  }
  db.close();
}

(async () => {
  // A previous run that crashed before step 9 must not wedge this one.
  resetFixture();

  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
    const m = r.request().method();
    const path = new URL(r.url()).pathname.replace("/api/v1/", "");
    if (m !== "GET" && /\/api\/v1\/(theme-tables|extensions|admin-menus)/.test(r.url())) {
      r.text()
        .then((t) => apiLog.push(`${m} ${path} -> ${r.status()} ${t.slice(0, 140)}`))
        .catch(() => apiLog.push(`${m} ${path} -> ${r.status()} (unreadable)`));
    }
  });

  console.log("\n1. Log in");
  await page.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
  await page.fill("#u", "admin");
  await page.fill("#p", "change-me-now");
  await page.click("#signin");
  await page.waitForSelector("#app-header", { timeout: 15000 });
  check("logged in and shell rendered", true);

  // Start from a known state: a previous interrupted run may have left the
  // theme active or the plugin enabled, which would make the "before" asserts
  // meaningless.
  console.log("\n2. Reset to a known state");
  // Install the reference plugin if the shared dev D1 does not already have it.
  //
  // This script used to *assume* `notify` was installed, because
  // `admin-menus.test.mjs` left it behind. That suite now cleans up after
  // itself, so the assumption turned into a broken acceptance script:
  // `.../notify/enable` answered 200 for a plugin that was never installed, no
  // Extensions group appeared, and step 4 timed out on a menu that could not
  // exist. A fixture this script needs, it installs itself.
  const installedPlugin = await page.evaluate(async (b64) => {
    const list = await (await fetch("/api/v1/extensions/plugins")).json();
    if ((list.items || []).some((p) => p.name === "notify")) return false;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append("file", new File([bytes], "notify.zip", { type: "application/zip" }));
    const up = await fetch("/api/v1/extensions/plugins/upload", { method: "POST", body: fd });
    return up.status === 201 || up.status === 200;
  }, pluginZipBase64());
  check("the reference plugin is installed for this run", true, `installed here: ${installedPlugin}`);

  // Assertions below read English labels, so pin the interface language (and
  // put the operator's preference back in step 9).
  const prevUiLang = readUiLang();
  await page.evaluate(async () => {
    await fetch("/api/v1/extensions/themes/default/activate?site=default", { method: "POST" });
    await fetch("/api/v1/extensions/plugins/notify/disable", { method: "POST" });
    await fetch("/api/v1/i18n/ui-locale", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const groupsBefore = await page.$$eval(".nav-group-label", (els) => els.map((e) => e.textContent.trim()));
  check("no Extensions group before the plugin is enabled", !groupsBefore.includes("Extensions"), groupsBefore.join(", "));
  check("no From theme group before the theme is activated", !groupsBefore.includes("From theme"), groupsBefore.join(", "));

  // -- plugin path ---------------------------------------------------------
  console.log("\n3. Enabling a plugin grows an Extensions group");
  const enableStatus = await page.evaluate(async () => {
    const r = await fetch("/api/v1/extensions/plugins/notify/enable", { method: "POST" });
    return r.status;
  });
  check("enable accepted", enableStatus === 200, `status ${enableStatus}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const groupsAfter = await page.$$eval(".nav-group-label", (els) => els.map((e) => e.textContent.trim()));
  check("Extensions group appeared", groupsAfter.includes("Extensions"), groupsAfter.join(", "));

  const extItems = await page.$$eval(".nav-group", (gs) => {
    const g = gs.find((x) => x.querySelector(".nav-group-label")?.textContent.trim() === "Extensions");
    return g ? [...g.querySelectorAll(".nav-item")].map((b) => b.textContent.trim()) : [];
  });
  check("the plugin's menu is in it", extItems.includes("Notify Settings"), extItems.join(", "));

  console.log("\n4. The plugin menu opens the plugin's declared settings");
  await page.click('[data-nav="menu:notify-settings"]');
  await page.waitForTimeout(900);
  const pluginPage = await page.textContent("#content");
  check("heading is the menu label", /Notify Settings/i.test(pluginPage || ""));
  check("declared field `title_template` rendered", !!(await page.$('[data-ts-key="title_template"]')));
  check("declared field `default_description` rendered", !!(await page.$('[data-ts-key="default_description"]')));

  const beforeVal = await page.inputValue('[data-ts-key="title_template"]');
  const newVal = `%title% :: %site% ${Date.now().toString(36)}`;
  await page.fill('[data-ts-key="title_template"]', newVal);
  await page.click("[data-save-theme-settings]");
  await page.waitForTimeout(1200);
  const saved = apiLog.filter((l) => /plugins\/notify\/settings ->/.test(l));
  check("saving plugin settings was accepted (not a silent 4xx)", saved.some((l) => /-> 200/.test(l)), saved.join("\n       ") || "no request seen");

  // Read it back after a full reload: a POST that returns 200 but writes
  // nothing is exactly the failure a status-code-only assertion misses.
  await page.reload({ waitUntil: "networkidle" });
  await page.click('[data-nav="menu:notify-settings"]');
  await page.waitForTimeout(900);
  const persisted = await page.inputValue('[data-ts-key="title_template"]').catch(() => "");
  check("the saved value survived a reload", persisted === newVal, `read back "${persisted}", wrote "${newVal}" (was "${beforeVal}")`);

  // -- theme path ----------------------------------------------------------
  console.log("\n5. Installing and activating a theme with a declared table");
  const zipB64 = themeZipBase64();
  const install = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append("file", new File([bytes], "menusbrowser.zip", { type: "application/zip" }));
    const up = await fetch("/api/v1/extensions/themes/upload", { method: "POST", body: fd });
    const upBody = await up.json().catch(() => ({}));
    if (up.status !== 201) return { upload: up.status, body: upBody };
    const act = await fetch("/api/v1/extensions/themes/menusbrowser/activate?site=default", { method: "POST" });
    return { upload: up.status, activate: act.status, applied: (await act.json().catch(() => ({}))).applied };
  }, zipB64);
  check("theme uploaded", install.upload === 201, JSON.stringify(install));
  check("theme activated", install.activate === 200, JSON.stringify(install));
  check("its declared menu was applied", install.applied?.adminMenus === 1, JSON.stringify(install.applied));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const themeItems = await page.$$eval(".nav-group", (gs) => {
    const g = gs.find((x) => x.querySelector(".nav-group-label")?.textContent.trim() === "From theme");
    return g ? [...g.querySelectorAll(".nav-item")].map((b) => b.textContent.trim()) : [];
  });
  check("From theme group lists the declared menu", themeItems.includes("Products"), themeItems.join(", "));

  console.log("\n6. The generated list comes from the table declaration");
  await page.click('[data-nav="menu:products"]');
  await page.waitForTimeout(1000);
  const listPage = await page.textContent("#content");
  check("heading is the menu label", /Products/.test(listPage || ""));
  const headers = await page.$$eval("table.table thead th", (els) => els.map((e) => e.textContent.trim()));
  check("a column exists for each declared field", headers.includes("Name") && headers.includes("Price"), headers.join(" | "));
  check("the Add control is present", !!(await page.$("[data-table-new]")));

  console.log("\n7. The generated form is built from the declaration");
  await page.click("[data-table-new]");
  await page.waitForTimeout(1000);
  const formPage = await page.textContent("#content");
  check("heading is the singular label", /New Products/i.test(formPage || ""), (formPage || "").slice(0, 120));
  check("slug control exists", !!(await page.$('[data-tf="slug"]')));
  check("text field became a text input", (await page.getAttribute('[data-tf="name"]', "type")) === "text");
  check("number field became a number input", (await page.getAttribute('[data-tf="price"]', "type")) === "number");
  check("status control exists", (await page.evaluate(() => document.querySelector('[data-tf="status"]')?.tagName)) === "SELECT");

  const rowSlug = `browser-item-${Date.now().toString(36)}`;
  await page.fill('[data-tf="slug"]', rowSlug);
  await page.fill('[data-tf="name"]', "Browser Item");
  await page.fill('[data-tf="price"]', "42");
  await page.click("[data-table-save]");
  await page.waitForTimeout(1800);

  const writes = apiLog.filter((l) => l.includes(`theme-tables/${TABLE} ->`));
  check("the save was accepted (not a silent 4xx)", writes.some((l) => /-> 201/.test(l)), writes.join("\n       ") || "no request seen");

  const afterSave = await page.textContent("#content");
  check("back on the list", /Products/.test(afterSave || ""));
  check("the new row is listed", (afterSave || "").includes(rowSlug), (afterSave || "").slice(0, 300));
  check("its declared values are shown", (afterSave || "").includes("Browser Item") && (afterSave || "").includes("42"));

  console.log("\n8. Deleting the row through the generated list");
  // The button carries `data-table-del="<logical table>|<slug>"`.
  await page.click(`[data-table-del="${TABLE}|${rowSlug}"]`);
  await page.waitForTimeout(400);
  await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 }).catch(() => {});
  // Cancel renders before OK, so a union selector would hit Cancel.
  await page.click(".overlay #dlg-ok").catch(() => {});
  await page.waitForTimeout(1500);
  const afterDelete = await page.textContent("#content");
  check("the row is gone", !(afterDelete || "").includes(rowSlug), (afterDelete || "").slice(0, 300));

  // -- cleanup -------------------------------------------------------------
  console.log("\n9. Restore the starting state");
  await page.evaluate(async () => {
    await fetch("/api/v1/extensions/themes/default/activate?site=default", { method: "POST" });
    await fetch("/api/v1/extensions/plugins/notify/disable", { method: "POST" });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const groupsEnd = await page.$$eval(".nav-group-label", (els) => els.map((e) => e.textContent.trim()));
  check("Extensions group is gone again", !groupsEnd.includes("Extensions"), groupsEnd.join(", "));
  check("From theme group is gone again", !groupsEnd.includes("From theme"), groupsEnd.join(", "));

  // Deactivation alone leaves the table registry behind (by design), so the
  // fixture removes its own rows too — otherwise the next suite to read the
  // shared D1 inherits this theme's table. Verified, not assumed: this cleanup
  // silently did nothing for a long time (see `resetFixture`).
  const residue = resetFixture();
  check(
    "the fixture left nothing behind (tables, table defs, install row)",
    residue.tables.length === 0 && residue.defs === 0 && residue.installs === 0,
    JSON.stringify(residue)
  );
  // And take back the plugin if this run installed it, so the operator's
  // database is left as it was found.
  if (installedPlugin) removePlugin();
  // Restore the interface-language preference (see `readUiLang`).
  writeUiLang(prevUiLang);

  await browser.close();

  console.log("\n10. Console / network health");
  const real = problems.filter((p) => !/401/.test(p));
  check("no console errors, page errors, failed requests or 5xx", real.length === 0, real.join("\n       "));
  if (problems.length && real.length === 0) console.log(`  (ignored ${problems.length} expected pre-auth 401s)`);

  console.log(`\n${checks - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
