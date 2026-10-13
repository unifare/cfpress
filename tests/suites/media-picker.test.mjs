/**
 * The media picker — the one control for choosing a file, and the loop it
 * closes with the renderer.
 *
 * ## Why this suite exists
 *
 * Three places need "choose a file from the library": a block's `media` /
 * `media-list` attribute, a content custom field of type `media` /
 * `media-multiple`, and a theme/plugin setting of the same type. Before this
 * batch each had its own answer, and two of them had **no answer at all**: the
 * custom-field types are declared in `ALLOWED_FIELD_TYPES` but had no control
 * branch in the editor, so they fell through to a plain text input; the
 * settings form rendered a bare URL box.
 *
 * What this suite pins down is the part that cannot be seen by reading the
 * dialog: the **URL the picker produces is the URL the server serves and the
 * renderer draws**. A picker that returns a plausible-looking path is worth
 * nothing — the read path checks the key's tenant before serving (rule 60), and
 * a block renders `attrs.url` verbatim.
 *
 * The structural half ("only one file builds this control") lives in
 * `architecture.test.mjs` so `npm run gate` covers it too.
 *
 * Usage: node tests/suites/media-picker.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}
async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) {
    fail++; failures.push(`${title} (threw)`);
    console.log(`  FAIL ${title} threw: ${String((e && e.message) || e).slice(0, 200)}`);
  }
}

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", `${name}.mjs`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function stubDom() {
  const makeEl = (tag = "div") => ({
    tagName: String(tag).toUpperCase(), hidden: false, style: {}, dataset: {}, children: [],
    innerHTML: "", textContent: "", classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => makeEl("div"), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, appendChild(n) { return n; }, closest: () => null, focus() {},
  });
  const store = new Map();
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {}, scrollY: 0 };
  globalThis.document = {
    documentElement: makeEl("html"), body: makeEl("body"),
    querySelector: () => makeEl("div"), querySelectorAll: () => [], createElement: (t) => makeEl(t),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.location = { origin: "http://localhost" };
  globalThis.CSS = { escape: (s) => String(s) };
}

/** A row as `GET /api/v1/media` returns it. */
const ROW = {
  id: "mf_1", object_key: "uploads/mta/2026-10-09/abc-shot.png", filename: "shot.png",
  mime_type: "image/png", size: 2048, alt_text: "A shot", title: "shot.png",
};

async function main() {
  console.log("Bundling the real renderer...\n");
  const frontend = await bundle("src/platform/frontend.ts", "picker-renderer");
  const { renderBlocks } = frontend;

  let picker = null;
  let tmpDir = null;
  let loadError = null;
  try {
    stubDom();
    tmpDir = mkdtempSync(join(tmpdir(), "cfpress-picker-"));
    cpSync(join(root, "public/admin"), tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');
    picker = await import(pathToFileURL(join(tmpDir, "js/media-picker.js")).href);
  } catch (e) {
    loadError = e;
  }

  await section("0. the picker module loads", async () => {
    checkTruthy("media-picker.js imports and evaluates", loadError === null && picker !== null);
    if (loadError) console.log(`       ${String((loadError && loadError.stack) || loadError).split("\n").slice(0, 5).join("\n       ")}`);
  });
  if (!picker) {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp */ } }
    process.exit(1);
  }

  await section("1. the URL it builds is the one the server serves", async () => {
    check("a key becomes one encoded path segment",
      picker.mediaUrl("uploads/mta/2026-10-09/abc-shot.png"),
      "/media/uploads%2Fmta%2F2026-10-09%2Fabc-shot.png");
    // The read path decodes exactly this way (`src/index.ts`), and then checks
    // the key's tenant (rule 60) — so a URL built any other way is a 404.
    const url = picker.mediaUrl("uploads/mta/2026-10-09/abc-shot.png");
    check("and decodes back to the same key", decodeURIComponent(url.slice("/media/".length)), "uploads/mta/2026-10-09/abc-shot.png");
    checkTruthy("the key keeps its tenant segment", decodeURIComponent(url.slice("/media/".length)).startsWith("uploads/mta/"));
    check("an empty key produces no URL at all", picker.mediaUrl(""), "");
    check("so does a missing key", picker.mediaUrl(undefined), "");
  });

  await section("2. it normalises what the API returns", async () => {
    const item = picker.mediaItem(ROW);
    check("a media_files row becomes the item shape",
      [item.id, item.url, item.alt, item.filename, item.mimeType, item.size],
      ["mf_1", "/media/uploads%2Fmta%2F2026-10-09%2Fabc-shot.png", "A shot", "shot.png", "image/png", 2048]);
    // A value already stored in a field is `{url}` — the same function has to
    // read both, or re-opening a picker on a saved value would lose it.
    check("an already-stored value round-trips", picker.mediaItem({ url: "/media/x.png", alt: "x" }).url, "/media/x.png");
    check("junk is refused rather than invented", [picker.mediaItem(null), picker.mediaItem("nope"), picker.mediaItem({})], [null, null, null]);
  });

  await section("3. a malformed payload does not break the dialog", async () => {
    check("items are extracted", picker.mediaItemsFromPayload({ items: [ROW] }).length, 1);
    check("a missing list yields none", picker.mediaItemsFromPayload({}).length, 0);
    check("a null payload yields none", picker.mediaItemsFromPayload(null).length, 0);
    check("unusable rows are dropped, not counted", picker.mediaItemsFromPayload({ items: [ROW, null, {}, "x"] }).length, 1);
  });

  await section("4. one control, two shapes", async () => {
    const single = picker.mediaFieldHtml({ value: "/media/a.png", label: "Image", inputAttrs: 'data-block-attr="url"' });
    const many = picker.mediaFieldHtml({ value: "/media/a.png\n/media/b.png", multiple: true, label: "Images" });
    checkTruthy("the single control is an input", single.includes("<input"));
    checkTruthy("and has no textarea", !single.includes("<textarea"));
    checkTruthy("the multiple control is a textarea (one URL per line, like a list block)",
      many.includes("<textarea") && many.includes("/media/a.png\n/media/b.png"));
    checkTruthy("both carry the picker button inside the field wrapper",
      single.includes('data-media-field') && single.includes("data-media-pick"));
    checkTruthy("the caller's addressing is passed through verbatim", single.includes('data-block-attr="url"'));
    checkTruthy("the multiple wrapper declares itself so the picker can allow several",
      many.includes('data-media-multiple="1"'));
    checkTruthy("a single wrapper does not", single.includes('data-media-multiple="0"'));
    checkTruthy("an image value is previewed", single.includes("<img src=\"/media/a.png\""));
    // A label is optional (a media-list row renders the control without one),
    // and a value is always escaped — a URL is user input.
    checkTruthy("a label can be omitted", !picker.mediaFieldHtml({ value: "" }).includes("<label"));
    checkTruthy("values are escaped", picker.mediaFieldHtml({ value: '"><script>x</script>' }).includes("&quot;&gt;&lt;script&gt;"));
  });

  await section("4b. the picker draws the library's wall of pictures", async () => {
    // The picker's tiles were inline-styled divs with 96px thumbs — a different
    // (and much poorer) interface than the library screen. Both now draw the
    // same wall; these checks pin the selection semantics, which are the part
    // a restyle can silently break.
    const it = picker.mediaItem(ROW);
    const plain = picker.pickerTileHtml(it, false, false);
    const picked = picker.pickerTileHtml(it, true, true);
    checkTruthy("selection is announced to the reader (aria-pressed)",
      plain.includes('aria-pressed="false"') && picked.includes('aria-pressed="true"'));
    checkTruthy("and to the eye (the selected class)",
      picked.includes("is-selected") && !plain.includes("is-selected"));
    checkTruthy("the check badge is part of every tile", plain.includes("media-check"));
    checkTruthy("the thumb is the shared square, not an inline-styled box",
      plain.includes("media-thumb") && !plain.includes("style=\"width:96px"));
    checkTruthy("a picked item's meta says so (multiple mode)",
      picked.includes("selected"));
    const grid = picker.pickerGridHtml([it], [], false);
    checkTruthy("the grid is the shared media grid, not an inline-styled div",
      grid.includes("media-grid") && grid.includes("media-pick-grid") && !grid.includes("grid-template-columns:repeat(auto-fill,minmax(7.5rem"));
  });

  await section("5. what the picker returns, the real renderer draws", async () => {
    // The loop this suite exists for: library row → picker item → block
    // attribute → the renderer's markup. A picker that produced a
    // plausible-looking but wrong URL would fail here and nowhere else.
    const item = picker.mediaItem(ROW);
    const image = renderBlocks(JSON.stringify([{ type: "core/image", attrs: { url: item.url, alt: item.alt } }]));
    checkTruthy("an image block renders the picked URL", image.includes(`<img src="${item.url}"`));
    checkTruthy("and its alt", image.includes(`alt="A shot"`));

    const two = [{ object_key: "uploads/mta/a.png", alt_text: "A", mime_type: "image/png" }, { object_key: "uploads/mta/b.png", alt_text: "B", mime_type: "image/png" }]
      .map(picker.mediaItem);
    const gallery = renderBlocks(JSON.stringify([{ type: "core/gallery", attrs: { items: two.map((i) => ({ url: i.url, alt: i.alt })) } }]));
    checkTruthy("a gallery renders every picked item", two.every((i) => gallery.includes(`<img src="${i.url}"`)));
    // Non-vacuity: the assertions above are `includes` on a string, so prove the
    // marker is really in the output rather than matching an empty needle.
    checkTruthy("the picked URLs are non-empty (non-vacuity)", two.every((i) => i.url.length > 20));
  });

  await section("6. the three consumers all go through the shared control", async () => {
    // A caller that builds its own media markup is the drift this module
    // exists to prevent. The structural check ("only media-picker.js defines
    // the control") lives in `architecture.test.mjs`; this asserts the positive
    // half — each consumer actually calls the shared builder.
    const consumers = {
      "public/admin/js/block-fields.js": "a block's media attribute",
      "public/admin/js/screens/editor.js": "a custom field of type media / media-multiple",
      "public/admin/js/screens/theme-menu.js": "a theme or plugin setting of the same type",
    };
    const missing = [];
    for (const [file, why] of Object.entries(consumers)) {
      const src = readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (!/mediaFieldHtml\s*\(/.test(src)) missing.push(`${file} (${why})`);
    }
    check("every declared consumer uses the shared control", missing, []);
    check("there are three of them (non-vacuity)", Object.keys(consumers).length, 3);
    // The custom-field types are the ones that had no control branch at all.
    const editorSrc = readFileSync(join(root, "public/admin/js/screens/editor.js"), "utf8");
    checkTruthy("the editor's custom fields handle media", /field_type === "media"/.test(editorSrc));
    checkTruthy("and media-multiple", /field_type === "media-multiple"/.test(editorSrc));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir */ } }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a parseable summary, and it must say it
  // failed. Without this the reverse-validation tool reads "no summary" as
  // "could not tell", which is never a pass (ARCHITECTURE §12).
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(2);
});
