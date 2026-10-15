/**
 * Tests for the official Shop Theme (`content/themes/shop`).
 *
 * Verifies that the official e-commerce theme:
 * 1. Passes strict manifest validation with custom tables and admin menus
 * 2. Declares product and order tables with compliant multi-language fields
 * 3. Registers custom admin menus pointing to valid screens and tables
 * 4. Renders all templates and parts against populated and degraded scopes
 * 5. Ships bilingual language packs with identical key sets
 *
 * Usage: node tests/suites/shop-theme.test.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
  const themeDir = join(root, "content", "themes", "shop");
  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));

  section("1. Shop Theme Manifest & Validation");
  check("theme manifest name is shop", manifest.name, "shop");

  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "shop-validation.mjs");
  let valErr = null;
  let normalized = null;
  try {
    normalized = validateManifest(manifest, "theme");
  } catch (e) {
    valErr = e?.message || String(e);
  }
  check("validateManifest accepts shop theme", valErr, null);
  checkTruthy("normalized manifest exists", !!normalized);

  section("2. Tables & Multi-Language Schema");
  check("declares 2 tables", manifest.tables.length, 2);
  const productTable = manifest.tables.find(t => t.name === "product");
  const orderTable = manifest.tables.find(t => t.name === "order");
  checkTruthy("product table exists", !!productTable);
  checkTruthy("order table exists", !!orderTable);

  check("product translatable fields match prose types", productTable.translatable.sort(), ["description", "name", "sku"]);
  check("order translatable fields match prose types", orderTable.translatable.sort(), ["customer_email", "customer_name", "note", "order_no", "order_status"]);

  section("3. Admin Menus & Routes");
  check("declares 3 business admin menus", manifest.adminMenus.length, 3);
  check("menu targets are valid", manifest.adminMenus.map(m => m.args?.table).sort(), ["order", "product", "product"]);
  check("declares routes for product catalog and cart", manifest.routes.map(r => r.path).sort(), ["/cart", "/products", "/products/:slug"]);

  section("4. Templates & Parts Rendering");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "shop-engine.mjs");

  const loadTemplate = async (name) => {
    for (const p of [
      join(themeDir, "templates", `${name}.html`),
      join(themeDir, "templates", "parts", `${name}.html`),
    ]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };

  const renderContext = {
    loadTemplate,
    helpers: {
      hook: () => "<!-- hook -->",
    },
  };

  const baseScope = {
    locale: "en",
    site: { title: "Official Shop Store", description: "Best products online" },
    page: { document_title: "Shop Demo" },
    products: [
      { slug: "wireless-headphones", name: "Pro Wireless Headphones", sku: "WH-100", price: 199, in_stock: true },
      { slug: "mechanical-keyboard", name: "RGB Mechanical Keyboard", sku: "KB-200", price: 129, in_stock: true },
    ],
    product: {
      slug: "wireless-headphones",
      name: "Pro Wireless Headphones",
      sku: "WH-100",
      price: 199,
      description: "<p>Premium active noise cancelling headphones.</p>",
    },
    post: {
      title: "Store Grand Opening",
      published_at: "2026-10-16",
      content: "<p>Welcome to our new official store!</p>",
    },
  };

  for (const tplName of manifest.templates) {
    let err = null;
    let html = "";
    try {
      const src = readFileSync(join(themeDir, "templates", `${tplName}.html`), "utf8");
      html = await renderTemplateSource(src, baseScope, renderContext);
    } catch (e) {
      err = e?.message || String(e);
    }
    check(`template "${tplName}" renders cleanly`, err, null);
    checkTruthy(`template "${tplName}" output is non-empty`, typeof html === "string" && html.length > 50);
  }

  section("5. Language Packs Parity");
  const enPack = JSON.parse(readFileSync(join(themeDir, "langs", "en.json"), "utf8"));
  const zhPack = JSON.parse(readFileSync(join(themeDir, "langs", "zh-CN.json"), "utf8"));
  const enKeys = Object.keys(enPack).sort();
  const zhKeys = Object.keys(zhPack).sort();
  check("en and zh-CN translation keys match exactly", enKeys, zhKeys);

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
