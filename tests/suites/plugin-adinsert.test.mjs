/**
 * Tests for the official Ad Inserter plugin (`content/plugins/adinsert`).
 *
 * Verifies that the adinsert plugin:
 * 1. Passes strict manifest validation with all declared hooks, tables, settings and admin screens
 * 2. Provides bilingual language packs with perfectly symmetrical keys
 * 3. Correctly calculates automatic display placements (Before/After Content, Paragraph 1/2, % between paragraphs)
 * 4. Generates formatted ad markup with alignments (center, left, right, float)
 * 5. Accurately detects client device (Desktop / Mobile / Tablet)
 * 6. Handles shortcode expansion [adinsert block="1"]
 * 7. Injects global Header/Footer code and paragraph ad blocks on front-end document rendering
 *
 * Usage: node tests/suites/plugin-adinsert.test.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

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
function section(t) { console.log(`\n${t}`); }

async function bundle(entry, outName) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const dir = join(root, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, outName);
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

async function main() {
  section("1. Plugin Manifest & Declarations");
  const manifestPath = join(root, "content", "plugins", "adinsert", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  check("manifest name is adinsert", manifest.name, "adinsert");
  check("manifest title is Ad Inserter", manifest.title, "Ad Inserter");

  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "adinsert-val.mjs");
  const { DECLARABLE_HOOKS } = await bundle("src/extensions/contract/hooks.ts", "adinsert-hooks.mjs");

  let valError = null;
  let normalized = null;
  try {
    normalized = validateManifest(manifest, "plugin");
  } catch (e) {
    valError = e?.message || String(e);
  }
  check("validateManifest accepts adinsert plugin without errors", valError, null);
  checkTruthy("normalized manifest returned", !!normalized);

  section("2. Hook Declarations & Capabilities");
  for (const h of manifest.hooks) {
    checkTruthy(`hook "${h}" is declarable`, DECLARABLE_HOOKS.includes(h));
  }
  checkTruthy("declares html filter hook", manifest.hooks.includes("html"));
  checkTruthy("declares head hook", manifest.hooks.includes("head"));
  checkTruthy("declares footer hook", manifest.hooks.includes("footer"));
  checkTruthy("declares shortcode hook", manifest.hooks.includes("shortcode"));

  section("3. Tables, Admin Pages & Menus");
  const blocksTable = (manifest.tables || []).find((t) => t.name === "blocks");
  checkTruthy("declares blocks table", !!blocksTable);
  check(
    "blocks table has translatable fields",
    blocksTable?.translatable.sort(),
    ["alignment", "code", "device", "name", "page_types", "position"].sort()
  );

  const adinsertPage = (manifest.adminPages || []).find((p) => p.id === "adinsert");
  checkTruthy("declares adinsert admin page", !!adinsertPage);
  check("adinsert page has table block", adinsertPage?.blocks.map((b) => b.type), ["table"]);

  const adminMenuIds = (manifest.adminMenus || []).map((m) => m.id);
  checkTruthy("declares single adinsert admin menu", adminMenuIds.includes("adinsert") && adminMenuIds.length === 1);

  section("4. Bilingual Language Packs");
  checkTruthy("declares en pack", !!manifest.langs?.en);
  checkTruthy("declares zh-CN pack", !!manifest.langs?.["zh-CN"]);
  const enKeys = Object.keys(manifest.langs.en).sort();
  const zhKeys = Object.keys(manifest.langs["zh-CN"]).sort();
  check("en and zh-CN translation keys match 100%", enKeys, zhKeys);

  section("5. Ad Formatting & Alignment");
  const { formatAdMarkup, detectDevice, matchDevice, matchPageType, injectIntoParagraphs, filterAdInsert, handleAdInsertShortcode } =
    await bundle("src/extensions/plugin/adinsert.ts", "adinsert-core.mjs");

  const centerAd = formatAdMarkup("<ins>AD</ins>", "center");
  checkTruthy("center alignment wraps with text-align: center", centerAd.includes("text-align: center;"));
  checkTruthy("center alignment has class cfpress-adinsert-block", centerAd.includes("class=\"cfpress-adinsert-block\""));

  const floatLeftAd = formatAdMarkup("<ins>AD</ins>", "float_left");
  checkTruthy("float_left alignment wraps with float: left", floatLeftAd.includes("float: left;"));

  section("6. Device Detection & Matching");
  const desktopReq = new Request("https://example.com/", {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  check("detects desktop from Windows UA", detectDevice(desktopReq), "desktop");

  const mobileReq = new Request("https://example.com/", {
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile/15E148" },
  });
  check("detects mobile from iPhone UA", detectDevice(mobileReq), "mobile");

  const tabletReq = new Request("https://example.com/", {
    headers: { "user-agent": "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)" },
  });
  check("detects tablet from iPad UA", detectDevice(tabletReq), "tablet");

  check("all devices match 'all' rule", matchDevice("all", "mobile"), true);
  check("desktop matches desktop rule", matchDevice("desktop", "desktop"), true);
  check("mobile does not match desktop rule", matchDevice("desktop", "mobile"), false);

  section("7. Content & Paragraph Placement Algorithm");
  const sampleContent = "<p>First paragraph.</p>\n<p>Second paragraph.</p>\n<p>Third paragraph.</p>\n<p>Fourth paragraph.</p>";
  const adBlockMarkup = "<div class=\"test-ad\">[ADVERTISEMENT]</div>";

  // Before Content
  const beforeContent = injectIntoParagraphs(sampleContent, adBlockMarkup, "before_content");
  checkTruthy("before_content places ad before first paragraph", beforeContent.startsWith(adBlockMarkup));

  // After Content
  const afterContent = injectIntoParagraphs(sampleContent, adBlockMarkup, "after_content");
  checkTruthy("after_content places ad after last paragraph", afterContent.endsWith(adBlockMarkup));

  // Before Paragraph 2
  const beforeP2 = injectIntoParagraphs(sampleContent, adBlockMarkup, "before_paragraph", 2);
  checkTruthy(
    "before_paragraph 2 places ad immediately before second <p>",
    beforeP2.includes(`<p>First paragraph.</p>\n${adBlockMarkup}\n<p>Second paragraph.</p>`)
  );

  // After Paragraph 2
  const afterP2 = injectIntoParagraphs(sampleContent, adBlockMarkup, "after_paragraph", 2);
  checkTruthy(
    "after_paragraph 2 places ad immediately after second </p>",
    afterP2.includes(`<p>Second paragraph.</p>\n${adBlockMarkup}\n<p>Third paragraph.</p>`)
  );

  // Between Paragraphs 50%
  const between50 = injectIntoParagraphs(sampleContent, adBlockMarkup, "between_paragraphs", 50);
  checkTruthy("between_paragraphs 50% inserts around middle paragraph", between50.includes(adBlockMarkup));

  section("8. Shortcode Expansion [adinsert block=\"1\"]");
  const mockDbShortcode = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (sql.includes("plugin_adinsert_blocks")) {
                return {
                  results: [
                    { block_no: 1, name: "Banner 1", code: "<ins class='ad-1'>AdSense</ins>", alignment: "center", enabled: 1 },
                  ],
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const shortcodeRes = await handleAdInsertShortcode(
    { env: { DB: mockDbShortcode }, siteId: "default" },
    { name: "adinsert", attrs: { block: "1" } }
  );
  checkTruthy("shortcode body expanded with ad markup", shortcodeRes?.body?.includes("<ins class='ad-1'>AdSense</ins>"));
  checkTruthy("shortcode container formatted with center alignment", shortcodeRes?.body?.includes("text-align: center;"));

  section("9. Document-level Filtering (Header, Footer, Content)");
  const mockDbDoc = {
    prepare(sql) {
      const runner = {
        async all() {
          if (sql.includes("plugin_settings")) {
            return {
              results: [
                { key: "enabled", value: "1" },
                { key: "header_code", value: "<meta name=\"ad-sense-account\" content=\"ca-pub-12345\">" },
                { key: "footer_code", value: "<script id=\"ad-analytics\">/* tracked */</script>" },
              ],
            };
          }
          if (sql.includes("plugin_adinsert_blocks")) {
            return {
              results: [
                {
                  block_no: 1,
                  name: "In-Article Ad",
                  code: "<div id=\"in-article-banner\">PROMO</div>",
                  position: "after_paragraph",
                  paragraph_no: 1,
                  alignment: "center",
                  page_types: "all",
                  device: "all",
                  enabled: 1,
                },
              ],
            };
          }
          return { results: [] };
        },
      };
      return {
        ...runner,
        bind(...args) {
          return runner;
        },
      };
    },
  };

  const sampleHtmlDoc = `<!DOCTYPE html>
<html>
<head>
  <title>Sample Post</title>
</head>
<body>
  <article>
    <h1>Welcome to CFPress</h1>
    <p>This is paragraph one.</p>
    <p>This is paragraph two.</p>
  </article>
</body>
</html>`;

  const filteredDoc = await filterAdInsert(
    { env: { DB: mockDbDoc }, siteId: "default", request: desktopReq },
    sampleHtmlDoc
  );

  checkTruthy("header_code injected before </head>", filteredDoc.includes("<meta name=\"ad-sense-account\" content=\"ca-pub-12345\">\n</head>"));
  checkTruthy("footer_code injected before </body>", filteredDoc.includes("<script id=\"ad-analytics\">/* tracked */</script>\n</body>"));
  checkTruthy("in-article ad block injected after paragraph 1", filteredDoc.includes("<p>This is paragraph one.</p>\n<div class=\"cfpress-adinsert-block\" style=\"text-align: center; margin: 16px auto; display: flex; flex-direction: column; align-items: center; justify-content: center; clear: both; max-width: 100%; box-sizing: border-box;\"><div id=\"in-article-banner\">PROMO</div></div>"));

  section("10. Position 'disabled' (Shortcode-only Verification)");
  const mockDbDisabled = {
    prepare() {
      const r = {
        async all() {
          return {
            results: [
              {
                block_no: 7,
                name: "Disabled Auto-insert Ad",
                code: "<div id=\"shortcode-only-ad\">SPECIAL BANNER</div>",
                position: "disabled",
                paragraph_no: 1,
                alignment: "center",
                page_types: "all",
                device: "all",
                enabled: 1,
              },
            ],
          };
        },
      };
      return { ...r, bind: () => r };
    },
  };

  const autoInsertDisabledDoc = await filterAdInsert(
    { env: { DB: mockDbDisabled }, siteId: "default", request: desktopReq },
    sampleHtmlDoc
  );
  checkTruthy("disabled position is NEVER automatically inserted into HTML", !autoInsertDisabledDoc.includes("SPECIAL BANNER"));

  const shortcodeDisabledRes = await handleAdInsertShortcode(
    { env: { DB: mockDbDisabled }, siteId: "default" },
    { name: "adinsert", attrs: { block: "7" } }
  );
  checkTruthy("disabled position DOES expand when invoked explicitly via shortcode", shortcodeDisabledRes?.body?.includes("SPECIAL BANNER"));
  checkTruthy("disabled position shortcode carries center alignment style", shortcodeDisabledRes?.body?.includes("text-align: center"));

  section("11. Alignment & Responsive Wrapper Styles");
  const centerMarkup = formatAdMarkup("<div>AD</div>", "center");
  checkTruthy("center alignment has text-align: center", centerMarkup.includes("text-align: center;"));
  checkTruthy("center alignment has auto margin", centerMarkup.includes("margin: 16px auto;"));
  checkTruthy("center alignment has clear: both", centerMarkup.includes("clear: both;"));

  const floatLeftMarkup = formatAdMarkup("<div>AD</div>", "float_left");
  checkTruthy("float_left alignment has float: left", floatLeftMarkup.includes("float: left;"));
  checkTruthy("float_left alignment has max-width: 50% for responsive wrapping", floatLeftMarkup.includes("max-width: 50%;"));

  const floatRightMarkup = formatAdMarkup("<div>AD</div>", "float_right");
  checkTruthy("float_right alignment has float: right", floatRightMarkup.includes("float: right;"));
  checkTruthy("float_right alignment has max-width: 50% for responsive wrapping", floatRightMarkup.includes("max-width: 50%;"));

  section("12. Page Type Targeting (Posts, Pages, Homepage, Categories)");
  checkTruthy("posts block matches single post template", matchPageType("posts", "single", "single.html", "/post/1"));
  checkTruthy("posts block rejects homepage", !matchPageType("posts", "home", "index.html", "/"));
  checkTruthy("posts block rejects static page", !matchPageType("posts", "page", "page.html", "/about"));

  checkTruthy("home block matches homepage root path", matchPageType("home", "home", "index.html", "/"));
  checkTruthy("home block rejects single post", !matchPageType("home", "single", "single.html", "/post/1"));

  checkTruthy("category block matches category archive", matchPageType("category", "category", "category.html", "/category/news"));
  checkTruthy("category block rejects single post", !matchPageType("category", "single", "single.html", "/post/1"));

  checkTruthy("multi-page selection matches both posts and pages", matchPageType("posts,pages", "page", "page.html", "/contact"));
  checkTruthy("multi-page selection matches posts", matchPageType("posts,pages", "single", "single.html", "/blog/first"));
  checkTruthy("multi-page selection rejects homepage", !matchPageType("posts,pages", "home", "index.html", "/"));

  section("13. Device Targeting In-Filter Enforcement");
  const mockDbDeviceTest = {
    prepare() {
      const r = {
        async all() {
          return {
            results: [
              {
                block_no: 3,
                name: "Mobile Only Ad",
                code: "<div id=\"mobile-ad\">MOBILE AD</div>",
                position: "after_paragraph",
                paragraph_no: 1,
                alignment: "center",
                page_types: "all",
                device: "mobile",
                enabled: 1,
              },
            ],
          };
        },
      };
      return { ...r, bind: () => r };
    },
  };

  const desktopFiltered = await filterAdInsert(
    { env: { DB: mockDbDeviceTest }, siteId: "default", request: desktopReq },
    sampleHtmlDoc
  );
  checkTruthy("desktop request blocks mobile-only ad", !desktopFiltered.includes("MOBILE AD"));

  const mobileFiltered = await filterAdInsert(
    { env: { DB: mockDbDeviceTest }, siteId: "default", request: mobileReq },
    sampleHtmlDoc
  );
  checkTruthy("mobile request receives mobile-only ad", mobileFiltered.includes("MOBILE AD"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failed: " + failures.join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(1);
});
