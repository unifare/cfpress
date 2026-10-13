/**
 * Real-browser acceptance for the media picker (batch 16 Track A3).
 *
 * The Node suite (`media-picker.test.mjs`) proves the control's markup and the
 * URL it builds; `architecture.test.mjs` proves only one module builds either.
 * Neither can prove the thing that actually matters to a person: **clicking
 * "Choose from library" opens a dialog, uploading inside it works, picking a
 * file puts its URL into the field that asked, and that URL survives the save.**
 *
 * That gap is not hypothetical in this repo — the admin's screen-render tests
 * pass for a button that does nothing, because `render()` catches and swaps in
 * an error panel (AGENTS.md rule 24). So this script drives a real Chromium.
 *
 * It also asserts the operator's chosen media policy end to end: the uploaded
 * object is readable **with** a session and refused **without** one. That is
 * `cfpress.media.require_session`, defaulted on by request — see rule 60e.
 *
 * Self-cleaning: the created post and the uploaded media row are deleted at the
 * end (deleting the row also removes the R2 object, which the API does).
 *
 * Usage:
 *   npx wrangler dev --port 47913 --ip 127.0.0.1     (in another shell)
 *   node tests/tools/_media-picker-browser.cjs
 */
const PW = "C:/Users/TF/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core";
const { chromium } = require(PW);

const BASE = process.env.CFPRESS_BASE || "http://127.0.0.1:47913";
const SITE = process.env.CFPRESS_SITE || "default";

let checks = 0;
let failed = 0;
const problems = [];
function check(name, cond, detail = "") {
  checks++;
  if (cond) { console.log(`  ok   ${name}`); return true; }
  failed++;
  problems.push(name);
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  return false;
}

/** Call the app's own API from inside the page.
 *
 * ⚠️ Not `context.request`: the session cookie is `Secure`, and Playwright's
 * request context does not apply the browser's "localhost is trustworthy"
 * exception, so it sends no cookie and every call comes back 401 — while the
 * page itself is happily authenticated. The page's own `fetch` is both
 * authenticated and the same code path the app uses, which is what the other
 * acceptance scripts in this directory do.
 */
function api(page, path, init) {
  return page.evaluate(async ([p, i]) => {
    const r = await fetch(p, i);
    let body = null;
    try { body = await r.json(); } catch { /* not JSON (a media object, say) */ }
    return { status: r.status, body };
  }, [path, init ?? null]);
}
const jsonInit = (data) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

/** A raw GET through the page, for responses that are not JSON (a published
 *  page's HTML). */
const raw = (page, path) =>
  page.evaluate(async (p) => {
    const r = await fetch(p);
    return { status: r.status, text: await r.text() };
  }, path);

/** The session cookie lives in the context's jar, so the page and the request
 *  context share it — which is convenient, and also a trap: signing in through
 *  the *request* context signs the browser in, and the sign-in form then never
 *  renders. So the sign-in is driven through the page and everything after it
 *  goes through the page too. */
async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  // Named, not just counted: "a 404 happened" is not a diagnosis, and this run
  // has already produced one 404 whose only trace was a console line with no URL.
  const badResponses = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.url()}`);
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
  });

  const cookie = "session lives in the page's own jar";
  let postId = null;
  let mediaId = null;
  let mediaKey = null;

  try {
    console.log("\n1. sign in and open a new post in the editor");
    await page.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
    // The SPA boots asynchronously (it asks who it is, gets a 401 and only then
    // draws the sign-in form), so `domcontentloaded` is not "the form is there".
    await page.waitForSelector("#u", { timeout: 30000 });
    await page.fill("#u", "admin");
    await page.fill("#p", "change-me-now");
    await page.click("#signin");
    await page.waitForSelector(".sidebar", { timeout: 30000 });
    check("the admin shell renders after sign-in", await page.locator(".sidebar").count() > 0);
    // The pre-sign-in `/api/v1/auth/me` 401 is *designed* (AGENTS.md: the admin
    // asks who it is before it can know there is nobody). From here on, any
    // console error is a real one.
    consoleErrors.length = 0;

    // `ui_lang` is persisted per user in D1, so a previous run in another
    // language would make every label assertion below read the wrong text.
    await api(page, "/api/v1/i18n/ui-locale", jsonInit({ locale: "en" }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 30000 });
    consoleErrors.length = 0;

    // Drive the app's own entry points rather than guessing at a click path —
    // `go` and `newContent` are both published `window.*` handlers (rule 23).
    //
    // ⚠️ `newContent` alone is not enough: it sets `state.editing` and
    // re-renders the *current* page, and it is the content-list screen that
    // delegates to the editor when `state.editing` is set. So the list has to
    // be the current page first — exactly as clicking "Add" from the list does.
    await page.evaluate(() => window.go("posts"));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.newContent("posts"));
    await page.waitForSelector("#blocks", { timeout: 15000 });
    check("the editor screen opened", await page.locator("#blocks").count() > 0);

    console.log("\n2. the palette offers the blocks, and an image block renders the media control");
    const palette = page.locator("[data-block]");
    check("the palette has a button per declared block", await palette.count() >= 12, `found ${await palette.count()}`);
    // Labels come from the server dictionary, so "Image" is the English one.
    await page.locator('[data-block="core/image"]').first().click();
    await page.waitForSelector(".media-field", { timeout: 5000 });
    check("adding an image block renders the shared media control", await page.locator(".media-field").count() === 1);
    check("and it carries the picker button", await page.locator(".media-field [data-media-pick]").count() === 1);
    // The control is the *shared* one: the wrapper marker exists, which is what
    // the architecture guard requires to appear in exactly one module.
    check("the wrapper is the picker's own", await page.locator('[data-media-field][data-media-multiple="0"]').count() === 1);

    console.log("\n3. the picker dialog opens, uploads, and returns a URL");
    await page.locator("[data-media-pick]").first().click();
    await page.waitForSelector("#media-picker-host .overlay", { timeout: 5000 });
    check("the dialog opened", await page.locator("#media-picker-host .overlay").count() === 1);
    // The grid is filled by an async load that starts when the dialog opens, so
    // asserting its content straight after `.overlay` appears is a race — the
    // first request after a cold worker is easily slower than the next
    // statement. Wait for the load to land, then assert.
    await page.waitForFunction(() => document.querySelector("#mp-grid")?.textContent.trim().length > 0, null, { timeout: 20000 });
    check("the dialog loads the library from the server",
      (await page.locator("#mp-grid").innerText()).trim().length > 0);
    check("and reports how many files it holds", (await page.locator("#mp-count").innerText()).trim().length > 0);

    // Upload from inside the dialog — the whole point of "manage and upload in
    // one place". A 1x1 PNG so the file is a real image.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64"
    );
    await page.setInputFiles("#mp-file", { name: "picker-acceptance.png", mimeType: "image/png", buffer: png });
    await page.waitForSelector("#mp-grid [data-media-id]", { timeout: 20000 });
    check("the uploaded file appears in the grid", await page.locator("#mp-grid [data-media-id]").count() >= 1);

    // A single pick pre-selects the newest upload; click it anyway so the
    // selection path is exercised rather than assumed.
    await page.locator("#mp-grid [data-media-id]").first().click();
    check("the tile reports itself selected",
      (await page.locator("#mp-grid [data-media-id]").first().getAttribute("aria-pressed")) === "true");
    await page.click("#mp-ok");
    await page.waitForSelector("#media-picker-host .overlay", { state: "detached", timeout: 5000 });

    const url = await page.locator(".media-field input").first().inputValue();
    check("the picked URL landed in the field that asked for it", /^\/media\/uploads%2F/.test(url), `got ${JSON.stringify(url)}`);
    check("the control previews it", await page.locator(".media-field img").count() === 1);
    mediaKey = decodeURIComponent(url.slice("/media/".length));
    check("and the key is namespaced by site", mediaKey.startsWith(`uploads/${SITE}/`), `key=${mediaKey}`);

    console.log("\n4. the URL survives a save");
    // Published rather than draft, so the front-end leg below can read it: the
    // single-post route only serves `status='published'`.
    await page.selectOption("#status", "published");
    await page.fill("#title", "Picker acceptance");
    await page.click('[data-action="save-content"]');
    await page.waitForTimeout(1200);

    const list = await api(page, `/api/v1/posts?site=${SITE}`);
    const row = (list.body?.items || []).find((p) => p.title === "Picker acceptance");
    check("the post was saved", !!row, `status=${list.status}`);
    if (row) {
      postId = row.id;
      const one = await api(page, `/api/v1/posts/${postId}?site=${SITE}`);
      const content = one.body?.items?.[0]?.content ?? "[]";
      let blocks = [];
      try { blocks = JSON.parse(content); } catch { /* asserted below */ }
      const image = blocks.find((b) => b.type === "core/image");
      check("the saved content holds an image block", !!image);
      // The defect this whole batch exists for: the editor wrote `attrs.text`
      // for every type, so the renderer (which reads `url`) drew nothing.
      check("the image's URL is stored under `url`, not `text`", image?.attrs?.url === url,
        `attrs=${JSON.stringify(image?.attrs)}`);
      check("and nothing was written to the key the renderer ignores", image?.attrs?.text === undefined);

      // The last leg of the loop, and the one nothing else covers: the HTML a
      // **visitor** gets. The Node suite proves contract → renderer on synthetic
      // input, and the assertions above prove editor → saved JSON; neither proves
      // that the theme renders it on a published page.
      const published = await api(page, `/api/v1/posts?site=${SITE}`);
      const pub = (published.body?.items || []).find((p) => p.title === "Picker acceptance");
      const pageUrl = pub ? `${pub.locale || "en"}/blog/${pub.slug}` : null;
      check("the post has a front-end URL", !!pageUrl, `slug=${pub?.slug}`);
      if (pageUrl) {
        const rendered = await raw(page, `/${pageUrl}`);
        check("the published page renders", rendered.status === 200, `status=${rendered.status}`);
        check("and contains the picked image", rendered.text.includes(`<img src="${url}"`),
          rendered.text.slice(0, 200));
      }
    }

    console.log("\n5. the operator's media policy holds end to end");
    const media = await api(page, `/api/v1/media?site=${SITE}`);
    const mine = (media.body?.items || []).find((m) => m.object_key === mediaKey);
    check("the upload is in this site's library", !!mine, `status=${media.status}`);
    check("the library reports owner isolation", media.body?.isolation === "owner", `isolation=${media.body?.isolation}`);
    mediaId = mine?.id ?? null;

    const withSession = await api(page, `/media/${encodeURIComponent(mediaKey)}`);
    check("the object is served to a signed-in reader", withSession.status === 200, `status=${withSession.status}`);
    // An anonymous reader is refused under `require_session` (default on by
    // request — rule 60e). Asserted here so the consequence is a known fact
    // rather than a surprise when a published page shows a broken image.
    // This one really is anonymous: it leaves the browser entirely.
    const anon = await fetch(`${BASE}/media/${encodeURIComponent(mediaKey)}`);
    check("and refused to an anonymous reader (the chosen policy)", anon.status === 404, `status=${anon.status}`);

    console.log("\n6. the dialog's cancel path");
    await page.evaluate(() => window.go("pages"));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.newContent("pages"));
    await page.waitForSelector("#blocks", { timeout: 15000 });
    await page.locator('[data-block="core/image"]').first().click();
    await page.waitForSelector("[data-media-pick]", { timeout: 5000 });
    await page.locator("[data-media-pick]").first().click();
    await page.waitForSelector("#media-picker-host .overlay", { timeout: 5000 });
    await page.click("#mp-cancel");
    await page.waitForSelector("#media-picker-host .overlay", { state: "detached", timeout: 5000 });
    check("cancelling leaves the field untouched", (await page.locator(".media-field input").first().inputValue()) === "");

    console.log("\n7. the library screen: tiles, search, inline alt text, delete");
    // The library screen and the picker must show the same objects, through the
    // same URL builder — a second way of building `/media/<key>` is a second way
    // to build a 404 (rule 62). So this section drives the screen itself.
    const uploaded = [];
    const png2 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64"
    );
    await page.evaluate(() => window.go("media"));
    await page.waitForSelector("#media-drop", { timeout: 15000 });
    check("the library screen renders its toolbar and drop zone",
      (await page.locator("#media-q").count()) === 1 && (await page.locator("#media-type").count()) === 1
      && (await page.locator("#media-drop").count()) === 1);

    // Upload two files through the screen's own control, so the tiles are the
    // screen's own rendering rather than something the test fabricated.
    await page.setInputFiles("#upload", [
      { name: "alpha-acceptance.png", mimeType: "image/png", buffer: png2 },
      { name: "beta-acceptance.png", mimeType: "image/png", buffer: png2 },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("[data-media-row]").length >= 2, null, { timeout: 20000 });
    check("both uploads render as tiles", await page.locator("[data-media-row]").count() >= 2);
    check("a tile previews the image through the shared URL builder",
      (await page.locator('[data-media-row] .media-thumb img[src^="/media/"]').count()) >= 2);

    const lib = await api(page, `/api/v1/media?site=${SITE}&q=acceptance&limit=50`);
    for (const m of lib.body?.items ?? []) uploaded.push(m.id);
    check("the screen's uploads are in this site's library", uploaded.length >= 2, `found ${uploaded.length}`);

    // Search narrows the grid (the endpoint has always supported it; the screen
    // used to show the first page and nothing else).
    await page.fill("#media-q", "alpha-acceptance");
    await page.waitForFunction(() => document.querySelectorAll("[data-media-row]").length === 1, null, { timeout: 15000 });
    check("search narrows the grid to one tile", (await page.locator("[data-media-row]").count()) === 1);

    // Alt text saves in place, and survives a reload — the value is the point,
    // not the toast.
    await page.fill(".media-alt", "Acceptance alt");
    await page.locator(".media-alt").blur();
    await page.waitForTimeout(600);
    const alphaId = (await page.locator("[data-media-row]").first().getAttribute("data-media-row"));
    const afterAlt = await api(page, `/api/v1/media?site=${SITE}&q=alpha-acceptance`);
    const savedAlt = (afterAlt.body?.items ?? []).find((m) => String(m.id) === String(alphaId))?.alt_text;
    check("editing alt text in place saves it", savedAlt === "Acceptance alt", `stored alt_text=${JSON.stringify(savedAlt)}`);

    // Delete through the tile's own button, then confirm the dialog.
    await page.click(`[data-media-del^="${alphaId}|"]`);
    await page.waitForSelector(".overlay #dlg-ok", { timeout: 5000 });
    await page.click(".overlay #dlg-ok");
    await page.waitForFunction((id) => !document.querySelector(`[data-media-row="${id}"]`), alphaId, { timeout: 15000 });
    check("deleting a tile removes it from the grid", (await page.locator(`[data-media-row="${alphaId}"]`).count()) === 0);
    const afterDelete = await api(page, `/api/v1/media?site=${SITE}&q=alpha-acceptance`);
    check("and the row is gone from the library", (afterDelete.body?.items ?? []).length === 0);

    // Clean up whatever the tile's own delete did not already remove. Issuing a
    // second DELETE for it would log a 404 that reads like a product failure —
    // the harness has to know what it already did.
    for (const id of uploaded.filter((x) => String(x) !== String(alphaId))) {
      try { await api(page, `/api/v1/media/${id}?site=${SITE}`, { method: "DELETE" }); } catch { /* best effort */ }
    }
    const leftovers = await api(page, `/api/v1/media?site=${SITE}&q=acceptance`);
    check("the library screen section cleaned up after itself", (leftovers.body?.items ?? []).length === 0,
      `left ${(leftovers.body?.items ?? []).length}`);

    check("no console errors during the run", consoleErrors.length === 0,
      `${consoleErrors.slice(0, 3).join(" | ")}  ||  4xx: ${badResponses.join(", ") || "none"}`);
    check("no 5xx responses during the run", failedRequests.length === 0, failedRequests.slice(0, 4).join(" | "));
  } finally {
    // Self-clean: the row and the object go together, and the fixture post is
    // removed so a re-run starts from the same state.
    try { if (mediaId) await api(page, `/api/v1/media/${mediaId}?site=${SITE}`, { method: "DELETE" }); } catch { /* best effort */ }
    try { if (postId) await api(page, `/api/v1/posts/${postId}?site=${SITE}`, { method: "DELETE" }); } catch { /* best effort */ }
    try {
      const leftovers = await api(page, `/api/v1/media?site=${SITE}`);
      if ((leftovers.body?.items || []).some((m) => m.object_key === mediaKey)) console.log("  (note: the fixture media row outlived cleanup)");
    } catch { /* page may be gone */ }
    await browser.close();
  }

  console.log(`\n${checks} passed, ${failed} failed`);
  if (failed) { console.log("Failures: " + problems.join(", ")); process.exit(1); }
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  process.exit(2);
});
