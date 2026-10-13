/**
 * Block attribute contract — the round trip that the editor used to break.
 *
 * ## The defect this suite exists for
 *
 * The editor rendered one `<textarea>` per block and wrote `attrs.text`
 * whatever the block was. The renderer reads a *different* attribute per type
 * (`url` + `alt` for an image, `items` for a gallery, `html` for raw HTML,
 * nested `content` for group/columns). Nothing compared the two, so inserting
 * an image, gallery, HTML, group or columns block from the admin produced
 * **empty output at HTTP 200** — and every existing guard stayed green:
 * the manifest validator checks declarations, the architecture suite checks
 * structure, and `admin-spa.test.mjs` never opens the editor screen.
 *
 * ## What makes this suite able to see it
 *
 * It walks the whole chain and asserts at the end of it:
 *
 *     contract (rendering/blocks.ts)
 *       → the control the editor draws (block-fields.js)
 *       → the attribute key the control writes
 *       → the markup the real renderer produces (platform/frontend.ts)
 *
 * The renderer here is the **real bundled module**, not a re-implementation,
 * and the control renderer is the **real browser module** loaded against a DOM
 * stub. A test that re-states the renderer's switch would agree with itself.
 *
 * §8 is a deliberate negative control: it builds a block the way the old editor
 * did and asserts the round-trip assertion *would* fail. Without that, a suite
 * that has never been seen to fail is indistinguishable from no suite.
 *
 * Usage: node tests/suites/editor-blocks.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
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

/** Bundle one TypeScript entry point to a temp ESM file and import it. */
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

/** Minimal DOM stub — enough for `ui.js` (and therefore `block-fields.js`) to
 *  load. Mirrors `admin-spa.test.mjs` so both suites agree on what a stub is. */
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

/**
 * The value a control would be given for one attribute. Distinct per
 * (block, attribute) so a value landing on the wrong key is visible rather
 * than merely plausible — the whole defect was "the right value in the wrong
 * place".
 *
 * `itemKeys` is read from the **attribute spec**, where `rendering/blocks.ts`
 * declares it. It used to be attached by `api.ts` on the way out, which meant
 * the contract alone did not describe a media-list's items — and a control that
 * has to be told its item keys by its caller renders an empty field when nobody
 * tells it. §1 asserts the declaration is there.
 */
function sampleValue(blockName, field) {
  const tag = `VAL_${blockName.replace(/\W/g, "")}_${field.key}`;
  if (field.type === "media-list") {
    const keys = Array.isArray(field.itemKeys) ? field.itemKeys : [];
    return [Object.fromEntries(keys.map((k) => [k, k === "alt" ? `ALT_${tag}` : `/${tag}.png`]))];
  }
  if (field.type === "media") return `/${tag}.png`;
  return tag;
}

/** The string a rendered block must contain for one attribute. */
function markerFor(blockName, field) {
  const v = sampleValue(blockName, field);
  if (field.type !== "media-list") return String(v);
  const first = v[0] ?? {};
  const key = Object.keys(first)[0];
  return key === undefined ? "" : String(first[key]);
}

async function main() {
  console.log("Bundling the contract and the real renderer...\n");

  const blocks = await bundle("src/rendering/blocks.ts", "editor-blocks-contract");
  const frontend = await bundle("src/platform/frontend.ts", "editor-blocks-renderer");
  const { CORE_BLOCKS, BLOCK_ATTR_TYPES, MEDIA_ITEM_KEYS, blockAttrKeys } = blocks;
  const { renderBlocks } = frontend;

  // The browser module, loaded the way a browser would: `public/admin/*.js` is
  // ESM, which Node only honours behind a `type: module` boundary.
  let fields = null;
  let tmpDir = null;
  let loadError = null;
  try {
    stubDom();
    tmpDir = mkdtempSync(join(tmpdir(), "cfpress-blocks-"));
    cpSync(join(root, "public/admin"), tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), '{"type":"module"}\n');
    fields = await import(pathToFileURL(join(tmpDir, "js/block-fields.js")).href);
  } catch (e) {
    loadError = e;
  }

  await section("0. the editor's control module loads", async () => {
    checkTruthy("block-fields.js imports and evaluates", loadError === null && fields !== null);
    if (loadError) console.log(`       ${String(loadError && loadError.stack || loadError).split("\n").slice(0, 5).join("\n       ")}`);
  });
  if (!fields) {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp */ } }
    process.exit(1);
  }

  await section("1. the contract is well formed", async () => {
    check("it declares twelve blocks", CORE_BLOCKS.length, 12);
    checkTruthy("every block has a name/title/category", CORE_BLOCKS.every((b) => b.name && b.title && b.category));
    const badKeys = CORE_BLOCKS.filter((b) => {
      const keys = b.attrs.map((a) => a.key);
      return new Set(keys).size !== keys.length;
    }).map((b) => b.name);
    check("no block declares the same attribute twice", badKeys, []);
    const badTypes = CORE_BLOCKS.flatMap((b) => b.attrs.filter((a) => !BLOCK_ATTR_TYPES.includes(a.type)).map((a) => `${b.name}.${a.key}:${a.type}`));
    check("every attribute type is in the closed set", badTypes, []);
    const badLabels = CORE_BLOCKS.flatMap((b) => b.attrs.filter((a) => !a.labelKey || !a.fallback).map((a) => `${b.name}.${a.key}`));
    check("every attribute declares a label key and an English fallback", badLabels, []);
    // A media-list holds objects, so its item shape is part of the attribute.
    // Declaring it on the spec (rather than attaching it on the way out of the
    // API) is what lets the control render inputs without being told.
    const missingItemKeys = CORE_BLOCKS
      .flatMap((b) => b.attrs.filter((a) => a.type === "media-list" && !(Array.isArray(a.itemKeys) && a.itemKeys.length)).map((a) => `${b.name}.${a.key}`));
    check("every media-list attribute declares its item keys", missingItemKeys, []);
    checkTruthy("the contract really declares a media-list (non-vacuity)",
      CORE_BLOCKS.some((b) => b.attrs.some((a) => a.type === "media-list")));
    // Non-vacuity: the checks above are only meaningful if there are attributes
    // to check, and the "no duplicates" one is satisfied by an empty list.
    checkTruthy("the contract actually declares attributes (non-vacuity)",
      CORE_BLOCKS.reduce((n, b) => n + b.attrs.length, 0) >= 10);
    // Nesting blocks hold children instead of attributes — declared, so the
    // editor knows to draw a container rather than an empty field set.
    check("the nesting blocks are declared as containers",
      CORE_BLOCKS.filter((b) => b.children).map((b) => b.name).sort(), ["core/columns", "core/group"]);
    checkTruthy("a container declares no attributes of its own",
      CORE_BLOCKS.filter((b) => b.children).every((b) => b.attrs.length === 0));
  });

  await section("2. every declared attribute reaches the real renderer", async () => {
    // The round trip. For each block: build it from the contract, render it with
    // the **real** renderer, and require the marker for every declared
    // attribute to appear in the output. This is the assertion the original
    // defect fails: `attrs.text` for an image means `a.url` is undefined and the
    // case returns "" — an empty string, no error, HTTP 200.
    const problems = [];
    const markers = [];
    for (const b of CORE_BLOCKS) {
      const attrs = {};
      for (const f of b.attrs) attrs[f.key] = sampleValue(b.name, f);
      const block = b.children ? { type: b.name, content: [] } : { type: b.name, attrs };
      const html = renderBlocks(JSON.stringify([block]));
      if (!html) { problems.push(`${b.name}: rendered nothing`); continue; }
      for (const f of b.attrs) {
        const marker = markerFor(b.name, f);
        markers.push(marker);
        if (!html.includes(marker)) problems.push(`${b.name}.${f.key}: ${JSON.stringify(marker)} missing from ${JSON.stringify(html.slice(0, 90))}`);
      }
    }
    check("every declared attribute survives the round trip", problems, []);
    // Non-vacuity, twice over: every marker must be a non-empty string — an
    // empty one makes `includes()` unconditionally true, which is how this
    // section passed for the gallery before `sampleValue` learned where the
    // item keys come from — and the loop must actually have covered the
    // contract.
    check("every marker is a non-empty string (non-vacuity)", markers.filter((m) => !m).length, 0);
    checkTruthy("the round trip covered the whole contract (non-vacuity)", markers.length >= 10);
  });

  await section("3. a required attribute is what makes a block renderable", async () => {
    const image = CORE_BLOCKS.find((b) => b.name === "core/image");
    check("the image's url is declared required", image.attrs.find((a) => a.key === "url").required, true);
    check("the image's alt is not", image.attrs.find((a) => a.key === "alt").required, undefined);
    // Pins the behaviour the contract's `required` flag documents: no URL, no
    // figure. Asserted rather than assumed, so changing it is a decision.
    check("an image with no url renders nothing", renderBlocks(JSON.stringify([{ type: "core/image", attrs: {} }])), "");
    checkTruthy("and one with a url renders a figure",
      renderBlocks(JSON.stringify([{ type: "core/image", attrs: { url: "/x.png" } }])).includes("<figure>"));
    checkTruthy("a separator needs no attributes at all",
      renderBlocks(JSON.stringify([{ type: "core/separator" }])).includes("<hr>"));
  });

  await section("4. the editor renders one control per declared attribute", async () => {
    const missing = [];
    const wrongLabel = [];
    for (const b of CORE_BLOCKS) {
      const attrs = Object.fromEntries(b.attrs.map((f) => [f.key, sampleValue(b.name, f)]));
      const html = fields.renderBlockAttrs(b, attrs, "0");
      for (const f of b.attrs) {
        if (!html.includes(`data-block-attr="${f.key}"`)) missing.push(`${b.name}.${f.key}`);
        // The control is drawn from the attribute spec, so it shows the
        // declared label. (The *translated* one is the API's job — asserted in
        // `admin-contract.test.mjs`, which has a dictionary to translate with.)
        if (!html.includes(f.fallback)) wrongLabel.push(`${b.name}.${f.key}`);
      }
      if (!b.attrs.length && html !== "") missing.push(`${b.name}: expected no controls`);
    }
    check("every declared attribute has a control carrying its key", missing, []);
    check("every control shows the attribute's label", wrongLabel, []);
    checkTruthy("controls are addressed by path so nested blocks work",
      fields.renderBlockAttrs(CORE_BLOCKS.find((b) => b.name === "core/paragraph"), { text: "x" }, "1.2").includes('data-block-path="1.2"'));
    // A media-list renders one row of inputs per item, keyed from the
    // attribute's own `itemKeys` — so the editor does not hardcode `url`/`alt`
    // a second time.
    const gallery = CORE_BLOCKS.find((b) => b.name === "core/gallery");
    const itemKeys = gallery.attrs.find((a) => a.type === "media-list").itemKeys;
    const listHtml = fields.renderBlockAttrs(gallery, { items: [{ url: "/a.png", alt: "A" }] }, "0");
    check("a media-list renders one input per declared item key",
      itemKeys.map((k) => listHtml.includes(`data-item-key="${k}"`)), itemKeys.map(() => true));
    checkTruthy("and it carries the attribute key it belongs to", listHtml.includes('data-block-attr="items"'));
    checkTruthy("an empty media-list says so instead of rendering nothing",
      fields.renderBlockAttrs(gallery, { items: [] }, "0").includes("No items yet"));
    // A control with an empty label is a field nobody can identify — the shape
    // the control had before it learned to fall back to `fallback`.
    const noLabel = fields.renderBlockAttr({ key: "text", type: "text" }, {}, "0");
    checkTruthy("a label is never rendered empty", /<label[^>]*>[^<]+<\/label>/.test(noLabel));
  });

  await section("5. the control renderer covers the contract's closed set", async () => {
    // The same "closed set, two tables" guard the settings form uses. A type
    // with no branch falls through to a text input — which is exactly how a
    // declared media field would silently become a URL box.
    check("RENDERED_ATTR_TYPES matches BLOCK_ATTR_TYPES",
      [...fields.RENDERED_ATTR_TYPES].sort(), [...BLOCK_ATTR_TYPES].sort());
    check("the control module really exports a list (non-vacuity)", fields.RENDERED_ATTR_TYPES.length, BLOCK_ATTR_TYPES.length);
    // Distinct controls, not four copies of the same input: a media control
    // previews an image, a plain url control does not.
    const media = fields.renderBlockAttr({ key: "url", type: "media", label: "Image" }, { url: "/a.png" }, "0");
    const url = fields.renderBlockAttr({ key: "url", type: "url", label: "Link" }, { url: "/a.png" }, "0");
    checkTruthy("a media control previews the value", media.includes("<img"));
    checkTruthy("a url control does not", !url.includes("<img"));
  });

  await section("6. the editor's own write path produces renderable blocks", async () => {
    // §2 proves the contract is right. This proves the *editor* uses it: the
    // blocks are built and filled through the same helpers `screens/editor.js`
    // calls, with the same paths, and only then handed to the renderer.
    const problems = [];
    for (const b of CORE_BLOCKS) {
      const tree = [];
      fields.insertBlock(tree, null, b.children ? { type: b.name, content: [] } : { type: b.name, attrs: {} });
      for (const f of b.attrs) fields.setAttrAt(tree, "0", f.key, sampleValue(b.name, f));
      const html = renderBlocks(JSON.stringify(tree));
      if (!html) { problems.push(`${b.name}: rendered nothing`); continue; }
      for (const f of b.attrs) {
        const marker = markerFor(b.name, f);
        if (!html.includes(marker)) problems.push(`${b.name}.${f.key} lost between the control and the renderer`);
      }
    }
    check("every block inserted and filled by the editor's helpers renders", problems, []);
    check("the helpers refuse a path that does not resolve", fields.setAttrAt([], "3", "text", "x"), false);
  });

  await section("7. nested blocks are addressed, not flattened", async () => {
    const tree = [];
    const container = CORE_BLOCKS.find((b) => b.children);
    fields.insertBlock(tree, null, { type: container.name, content: [] });
    fields.insertBlock(tree, "0", { type: "core/paragraph", attrs: {} });
    fields.setAttrAt(tree, "0.0", "text", "INSIDE");
    fields.setAttrAt(tree, "0.0", "text", "REPLACED");
    check("a child is addressed by its path", tree[0].content[0].attrs.text, "REPLACED");
    checkTruthy("and reaches the renderer", renderBlocks(JSON.stringify(tree)).includes("REPLACED"));
    // The parent's own (absent) attributes must not have been written by the
    // child's edit — the classic flat-index bug.
    check("the parent was not written through", tree[0].attrs, undefined);
    check("moving a nested block moves only that block",
      fields.moveBlockAt(tree, "0.0", 1) === false && tree[0].content.length === 1, true);
  });

  await section("8. the round trip can actually fail (non-vacuity)", async () => {
    // Build an image the way the *old* editor did — one `text` attribute for
    // every block — and require the assertion from §2 to reject it. Without
    // this, §2 is a suite that has never been seen to fail.
    const legacy = [{ type: "core/image", attrs: { text: "VAL_coreimage_url" } }];
    const html = renderBlocks(JSON.stringify(legacy));
    check("the old editor's shape renders nothing", html, "");
    checkTruthy("and the marker §2 looks for is genuinely absent", !html.includes("VAL_coreimage_url"));
    // Same for a gallery and for raw HTML — three of the six that were broken.
    check("a gallery written the old way renders nothing", renderBlocks(JSON.stringify([{ type: "core/gallery", attrs: { text: "x" } }])).replace(/<div class="gallery"><\/div>/, ""), "");
    check("an html block written the old way renders nothing", renderBlocks(JSON.stringify([{ type: "core/html", attrs: { text: "<b>x</b>" } }])), "");
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
