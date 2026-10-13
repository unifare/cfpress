/**
 * Real-browser acceptance for the multi-language admin surfaces.
 *
 * Drives the running `wrangler dev` host with a real Chromium: logs in, opens
 * Languages, enables a second language through the dialog, then opens a post
 * and checks the editor's language-version bar appeared. Collects console
 * errors, page errors, failed requests and 5xx responses.
 *
 * §8 covers the one thing no Node-level check can see: the interface-language
 * switch has two viewers (the header dropdown ticks from module state in
 * `js/i18n.js`, the Languages screen re-reads the server), and the question is
 * whether they still agree *after* a save, with no page reload in between.
 *
 * Usage:
 *   npx wrangler dev --port 47913 --ip 127.0.0.1   (in another shell)
 *   node tests/tools/_i18n-browser.cjs
 */
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);
const { join } = require("path");
const { readdirSync } = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ROOT = join(__dirname, "..", "..");
const BASE = process.env.CFPRESS_BASE || "http://127.0.0.1:47913";

/** Open the shared local D1, or null when it does not exist yet. */
function openDb() {
  const dir = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let file;
  try { file = readdirSync(dir).find((x) => x.endsWith(".sqlite")); } catch { return null; }
  return file ? new DatabaseSync(join(dir, file)) : null;
}

/**
 * The site's language set, snapshotted so it can be put back.
 *
 * This script *enables* zh-CN to exercise the flow, and it used to leave it
 * registered: a leftover language is visible in the Languages screen, and a
 * leftover *enabled* one changes what "the site is now described as
 * multilingual" looks like on the next run — which is exactly how this script
 * went flaky. Snapshot, normalize, restore: the same shape `i18n.test.mjs` uses
 * for the same reason.
 */
function snapshotLanguages() {
  const db = openDb();
  if (!db) return null;
  try {
    return { site: db.prepare("SELECT * FROM site_locales").all(), global: db.prepare("SELECT * FROM locales").all() };
  } finally { db.close(); }
}

function resetLanguages() {
  const db = openDb();
  if (!db) return;
  try {
    db.exec("DELETE FROM site_locales WHERE code <> 'en'");
    db.exec("DELETE FROM locales WHERE code <> 'en'");
    // Re-pin en as the default: deleting the others can leave the site with no
    // default row at all if a previous run had made zh-CN the default.
    db.exec("UPDATE site_locales SET is_default=1, enabled=1, sort_order=0 WHERE site_id='default' AND code='en'");
  } finally { db.close(); }
}

function restoreLanguages(snap) {
  if (!snap) return;
  const db = openDb();
  if (!db) return;
  const put = (table, rows) => {
    for (const r of rows) {
      const k = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map((x) => r[x]));
    }
  };
  try {
    db.exec("DELETE FROM site_locales");
    db.exec("DELETE FROM locales");
    put("site_locales", snap.site);
    put("locales", snap.global);
  } finally { db.close(); }
}

const problems = [];
/** Every write the script performs, with its status — so a silent 4xx cannot
 *  masquerade as a UI bug. */
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

(async () => {
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
    if (m !== "GET" && /\/api\/v1\/(i18n|posts|pages)/.test(r.url())) {
      r.text()
        .then((t) => apiLog.push(`${m} ${new URL(r.url()).pathname.replace("/api/v1/", "")} -> ${r.status()} ${t.slice(0, 160)}`))
        .catch(() => apiLog.push(`${m} ${r.url()} -> ${r.status()} (body unreadable)`));
    }
    if (m === "GET" && /\/api\/v1\/i18n\/translations/.test(r.url())) {
      r.text()
        .then((t) => apiLog.push(`GET i18n/translations -> ${r.status()} ${t.slice(0, 400)}`))
        .catch(() => {});
    }
  });

  console.log("\n1. Log in");
  await page.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
  await page.fill("#u", "admin");
  await page.fill("#p", "change-me-now");
  await page.click("#signin");
  await page.waitForSelector("#app-header", { timeout: 15000 });
  check("logged in and shell rendered", true);

  // `ui_lang` is persisted per user in D1, so it survives a fresh browser: a run
  // that left the interface in another language would make every English
  // assertion below read the wrong text — the feature is fine, the state was not
  // reset. Normalise before asserting anything.
  //
  // Remember what we found, though: the assertions need `en`, but the operator's
  // own preference is not this script's to overwrite. It used to force `en` and
  // leave it there, which silently rewrites a setting that belongs to the person
  // using the browser — the fix for "why did my admin go back to English".
  const originalUiLang = await page.evaluate(async () => {
    const d = await (await fetch("/api/v1/i18n/ui-locale")).json();
    return d.user_preference || d.locale || "en";
  });
  const setUiLocale = (locale) =>
    page.evaluate(async (l) => {
      await fetch("/api/v1/i18n/ui-locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: l }),
      });
    }, locale);
  await setUiLocale("en");
  // Same idea for the site's language set: snapshot it, normalize to en-only so
  // the "enable a second language" transition below is genuine, and put the
  // operator's set back at the end (see `snapshotLanguages`).
  const langSnapshot = snapshotLanguages();
  resetLanguages();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#app-header", { timeout: 15000 });

  console.log("\n2. Languages screen");
  await page.click('[data-nav="languages"]');
  await page.waitForTimeout(800);

  // Make the run repeatable: a previous run may have left a second language
  // enabled, which would make the "starts monolingual" precondition fail for a
  // reason that has nothing to do with this run.
  if (await page.$('[data-lang-disable="zh-CN"]')) {
    await page.click('[data-lang-disable="zh-CN"]');
    await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 }).catch(() => {});
    await page.click(".overlay #dlg-ok").catch(() => {});
    await page.waitForTimeout(1200);
  }

  const h1 = await page.textContent("h1").catch(() => "");
  check("heading is Languages", /Languages/i.test(h1 || ""), `got "${h1}"`);
  const body = await page.textContent("#content");
  check("site languages panel is present", /Site languages/i.test(body || ""));
  check("english is listed", /\ben\b/.test(body || ""));
  check("interface language panel is present", /interface language/i.test(body || ""));
  check("the four layers are explained", /L0/.test(body || "") && /L3/.test(body || ""));

  const multilingualBefore = /More than one is enabled/.test(body || "");
  check("site starts monolingual", !multilingualBefore, "expected the single-language note");

  // The bundled languages must be *offered here*, not merely known to the
  // interface switcher: a fresh install seeds the platform dictionary
  // (`locales`) with `en` alone, so before the screen read `core_entries` this
  // page showed no Chinese anywhere and section 3 had to type `zh-CN` into the
  // dialog by hand. Assert the affordance rather than the code path — the
  // enable control is the same whether the row is sitting in the site table
  // (disabled, from a previous run) or in the "not enabled here" panel.
  check(
    "the bundled Chinese language is offered for this site",
    !!(await page.$('[data-lang-enable="zh-CN"]')),
    (body || "").slice(0, 300)
  );
  check("offered under its own name, not the raw code", /简体中文/.test(body || ""));

  console.log("\n3. Enable a second language through the dialog");
  await page.click('[data-action="add-language"]');
  await page.waitForSelector("#dlg-form", { timeout: 5000 });
  await page.fill('#dlg-form [name="code"]', "zh-CN");
  await page.fill('#dlg-form [name="native_name"]', "简体中文");
  await page.fill('#dlg-form [name="name"]', "Simplified Chinese");
  await page.click("#dlg-ok");
  await page.waitForTimeout(1500);

  const body2 = await page.textContent("#content");
  check("zh-CN now listed for the site", /zh-CN/.test(body2 || ""));
  check("the site is now described as multilingual", /More than one is enabled/.test(body2 || ""), (body2 || "").slice(0, 200));
  check("native name is shown, not just the English one", /简体中文/.test(body2 || ""));

  console.log("\n4. Editor language-version bar");
  // Pick the post to work on through the app's own API rather than guessing:
  // we need one whose translation group is genuinely incomplete, so the
  // "create the missing version" path is exercised. A previous run leaves its
  // result behind (disabling a language keeps content), so a fixed row would
  // stop testing the interesting branch after the first run.
  const target = await page.evaluate(async () => {
    const find = async () => {
      const list = await (await fetch("/api/v1/posts?site=default&limit=50")).json();
      for (const it of list.items ?? []) {
        const g = await (await fetch(`/api/v1/i18n/translations?id=${encodeURIComponent(it.id)}&site=default`)).json();
        const gap = (g.versions ?? []).find((v) => !v.exists);
        if (gap) return { id: it.id, title: it.title, locale: gap.locale, group: g.group };
      }
      return null;
    };
    // Sweep this script's own marker post first. An aborted run leaves it
    // behind (the cleanup is at the end), and without this the *next* run would
    // adopt it as "content that was already there" and never remove it — the
    // same leftover class the suites sweep up front.
    const pre = await (await fetch("/api/v1/posts?site=default&limit=100")).json();
    for (const it of pre.items ?? []) {
      if (it.slug === "i18n-browser-fixture") {
        await fetch(`/api/v1/posts/${encodeURIComponent(it.id)}?site=default`, { method: "DELETE" });
      }
    }

    const found = await find();
    if (found) return { ...found, created: false };
    // The dev database may legitimately be empty — a fresh install, or one just
    // cleaned of test residue. This script is an acceptance test, not a seed, so
    // it makes the single fixture it needs instead of assuming demo content is
    // there: on an empty database the run used to fail with "every post already
    // has all languages — nothing to exercise", which reads like a content
    // problem rather than an unmet precondition. The post is created in `en`
    // only, so the zh-CN version enabled in step 3 is exactly the gap it wants.
    await fetch("/api/v1/posts?site=default", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "I18N Browser Fixture", slug: "i18n-browser-fixture",
        locale: "en", status: "draft", content: "[]",
      }),
    });
    const made = await find();
    return made ? { ...made, created: true } : null;
  });
  check("found a post whose translations are incomplete", !!target, "every post already has all languages — nothing to exercise");

  // Open the list *after* the lookup, so a fixture created just above is in it.
  await page.click('[data-nav="posts"]');
  await page.waitForTimeout(900);

  if (target) {
    console.log(`  [target] ${target.id} (${target.title}) is missing ${target.locale}`);
    await page.click(`[data-edit$="|${target.id}"]`);
    await page.waitForSelector("#blocks", { timeout: 8000 });
    await page.waitForTimeout(900);

    const ed = await page.textContent("#content");
    check("language versions panel rendered", /Language versions/i.test(ed || ""));
    check(`${target.locale} chip offered`, ed.includes(target.locale));
    check("the missing language is called out", /still missing/.test(ed || ""), (ed || "").slice(0, 300));
    check("locale picker is a select, not free text", !!(await page.$("#locale")) && (await page.evaluate(() => document.querySelector("#locale")?.tagName)) === "SELECT");

    // Create the missing version through the bar.
    const chip = await page.$(`[data-lang-version="${target.locale}"]`);
    check("the missing chip is present and marked as missing", !!chip && (await chip.getAttribute("data-version-exists")) === "0");
    if (chip) {
      await chip.click();
      await page.waitForSelector("#dlg-form", { timeout: 5000 });
      await page.click("#dlg-ok");
      await page.waitForTimeout(2000);

      const made = apiLog.filter((l) => l.includes("i18n/translations ->"));
      check("the version request was accepted (not a silent 4xx)", made.some((l) => /-> 201/.test(l)), made.join("\n       ") || "no request seen");

      const after = await page.textContent("#content");
      // Read the picker's value rather than matching the locale anywhere on the
      // page: the chip label itself contains it, so a text match would pass even
      // if the switch never happened.
      const nowLocale = await page.inputValue("#locale").catch(() => "");
      check("the editor switched to the new version", nowLocale === target.locale, `#locale = "${nowLocale}"`);
      check("no language is reported missing any more", !/still missing/.test(after || ""), (after || "").slice(0, 300));

      // Leave the database as we found it. Without this the script accumulates
      // drafts until no post has an incomplete group left to exercise, and the
      // run would start failing for a reason unrelated to the code. Deleting the
      // version we just made also exercises the editor's delete path.
      await page.click('[data-action="delete-content"]');
      await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 });
      await page.click(".overlay #dlg-ok");
      await page.waitForTimeout(1500);
      const removed = apiLog.filter((l) => /^DELETE posts\//.test(l));
      check("the created version was deleted again", removed.some((l) => /-> 200/.test(l)), removed.join("\n       ") || "no DELETE seen");
    }
  }

  console.log("\n5. Clean up the language switch");
  await page.click('[data-nav="languages"]');
  await page.waitForTimeout(800);
  const disable = await page.$('[data-lang-disable="zh-CN"]');
  if (disable) {
    await disable.click();
    await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 }).catch(() => {});
    // `confirmDialog` renders Cancel *before* OK, so a union selector would
    // resolve to Cancel and silently cancel the dialog. Target the id.
    await page.click(".overlay #dlg-ok").catch(() => {});
    await page.waitForTimeout(1200);
    const b3 = await page.textContent("#content");
    check("zh-CN disabled again", /Only one is enabled/.test(b3 || ""), (b3 || "").slice(0, 200));
  } else {
    check("disable control present", false, "no disable button");
  }

  console.log("\n7. The content editor follows the interface language (batch 16 B3)");
  // The editor was the last big screen with no dictionary at all, which is what
  // "the multilingual experience is bad" looked like from the inside. Asserting
  // it in a real browser is the only way to know the labels actually swap — the
  // Node guard proves the keys *exist*, not that a screen reads them.
  const openEditor = async () => {
    await page.evaluate(() => window.go("posts"));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.newContent("posts"));
    await page.waitForSelector("#blocks", { timeout: 15000 });
    return page.locator("#content").innerText();
  };

  await setUiLocale("zh-CN");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#app-header", { timeout: 15000 });
  const zh = await openEditor();
  check("the editor's field labels are translated", /正文/.test(zh) && /标题/.test(zh), zh.slice(0, 220));
  check("the save button is translated", /保存/.test(zh));
  check("the sidebar is translated too", /内容|仪表盘/.test(await page.locator(".sidebar").innerText()));
  check("no English field label is left behind",
    !/\bTitle\b|\bExcerpt\b|\bSlug\b|\bStatus\b|\bPublish at\b/.test(zh), zh.slice(0, 320));

  // ⚠️ The trap this batch fixed: an `<option>` without an explicit `value`
  // takes its *text* as the value, so translating the label would write 草稿
  // into `posts.status`. The identifiers stay lowercase English.
  const statusValues = await page.evaluate(() => [...document.querySelectorAll("#status option")].map((o) => o.value));
  check("status option values stay the stored identifiers",
    statusValues.join(",") === "draft,published,private,scheduled", statusValues.join(","));
  const statusLabels = await page.evaluate(() => [...document.querySelectorAll("#status option")].map((o) => o.textContent.trim()));
  check("while their labels are translated", statusLabels.includes("草稿"), statusLabels.join(","));

  await setUiLocale("en");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#app-header", { timeout: 15000 });
  const en = await openEditor();
  check("and it reads English again after switching back", /\bTitle\b/.test(en) && !/标题/.test(en), en.slice(0, 220));

  console.log("\n8. The interface-language switch repaints both viewers (no reload)");
  // One server fact, two client-side readers that refresh on different paths.
  // The header dropdown ticks from `currentLocale()` — module state in
  // `js/i18n.js`, set only by `loadMessages()` — while this screen re-reads
  // `GET i18n/ui-locale`. The Save button used to POST the preference itself and
  // re-render without reloading the dictionary, so the panel said one language
  // and the dropdown kept ticking the other until a full page reload. A Node
  // guard can prove the code shape; only a browser can prove the screen.
  const readTick = () =>
    page.evaluate(() => {
      const on = document.querySelector("#lang-menu .menu-item.active");
      return on ? on.dataset.uiLocale : null;
    });

  await page.click('[data-nav="languages"]');
  await page.waitForTimeout(800);

  const opts = await page.evaluate(() => [...document.querySelectorAll("#ui-locale-select option")].map((o) => o.value));
  // The site does not serve Chinese at this point in the run (section 5
  // disabled it) and the interface menu still offers it — that is the whole
  // point of the two lists being separate, and it is also why the operator
  // sees Chinese in the dropdown after disabling it as a *site* language.
  check("the interface menu offers the bundled packs regardless of the site's languages",
    opts.includes("zh-CN") && opts.includes("en"), opts.join(","));

  const tick0 = await readTick();
  const sel0 = await page.inputValue("#ui-locale-select");
  check("the header and the panel agree before any change", tick0 === sel0, `tick=${tick0} select=${sel0}`);

  // Drive the real button, not the API: the defect lived in its handler.
  await page.selectOption("#ui-locale-select", "zh-CN");
  await page.click('[data-action="save-ui-locale"]');
  await page.waitForTimeout(1500);
  const tick1 = await readTick();
  const sel1 = await page.inputValue("#ui-locale-select");
  check("the header tick follows the save with no reload", tick1 === "zh-CN", `tick=${JSON.stringify(tick1)}`);
  check("and the panel agrees with it", sel1 === "zh-CN", `select=${JSON.stringify(sel1)}`);
  check("the save was accepted, not a silent 4xx",
    apiLog.some((l) => /^POST i18n\/ui-locale -> 200/.test(l)),
    apiLog.filter((l) => l.includes("ui-locale")).join("\n       ") || "no POST seen");
  check("the dictionary really switched with it (sidebar is Chinese)",
    /内容|仪表盘/.test(await page.locator(".sidebar").innerText()));

  await page.selectOption("#ui-locale-select", "en");
  await page.click('[data-action="save-ui-locale"]');
  await page.waitForTimeout(1500);
  check("and switching back moves the tick back", (await readTick()) === "en", `tick=${JSON.stringify(await readTick())}`);
  check("with the dictionary back in English",
    /Posts|Dashboard/.test(await page.locator(".sidebar").innerText()));

  // Take back the fixture post if this run created it (see the `target` lookup):
  // the script is an acceptance test, not a seed, so it must not leave content
  // in the operator's database. A post that was already there is left alone.
  if (target && target.created) {
    await page.evaluate(async (id) => {
      await fetch(`/api/v1/posts/${encodeURIComponent(id)}?site=default`, { method: "DELETE" });
    }, target.id);
  }

  // Leave the operator's own interface language as we found it. This script
  // forces `en` so its assertions can read English; it must not make that a
  // permanent change to someone's admin.
  await setUiLocale(originalUiLang);
  // And the language set this run was allowed to disturb.
  restoreLanguages(langSnapshot);
  console.log(`\n(interface language and language set restored)`);

  console.log("\n6. Console / network health");
  const real = problems.filter((p) => !/401/.test(p));
  check("no console errors, page errors, failed requests or 5xx", real.length === 0, real.join("\n       "));
  if (problems.length && real.length === 0) {
    console.log(`  (ignored ${problems.length} expected pre-auth 401s)`);
  }

  // Close once, at the very end. It used to sit between section 5 and 6, which
  // meant any section added after it ran against a closed browser — the symptom
  // is a confusing "Target page, context or browser has been closed" from deep
  // inside a helper, pointing at the helper rather than at the stray close.
  await browser.close();

  console.log(`\n${checks - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
