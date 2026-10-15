/**
 * Tests for the official Hook Tester & Inspector plugin (`content/plugins/hook-tester`).
 *
 * Verifies that the official hook auditing plugin:
 * 1. Passes strict manifest validation with all 8 declarable hooks
 * 2. Correctly declares its private audit log table and admin screens
 * 3. Declares plugin settings and bilingual language packs
 * 4. Integrates cleanly with the host plugin hook runtime and executes hook tracing
 *
 * Usage: node tests/suites/hook-tester.test.mjs
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
  const pluginManifestPath = join(root, "content", "plugins", "hook-tester", "plugin.json");
  const manifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  check("manifest name is hook-tester", manifest.name, "hook-tester");

  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "hook-tester-val.mjs");
  const { DECLARABLE_HOOKS } = await bundle("src/extensions/contract/hooks.ts", "hook-tester-hooks.mjs");

  let valError = null;
  let normalized = null;
  try {
    normalized = validateManifest(manifest, "plugin");
  } catch (e) {
    valError = e?.message || String(e);
  }
  check("validateManifest accepts hook-tester plugin", valError, null);
  checkTruthy("normalized manifest exists", !!normalized);

  section("2. Hook Coverage against Platform DECLARABLE_HOOKS");
  check("hook-tester covers all declarable hooks", manifest.hooks.length, DECLARABLE_HOOKS.length);
  for (const h of manifest.hooks) {
    checkTruthy(`hook "${h}" is in DECLARABLE_HOOKS`, DECLARABLE_HOOKS.includes(h));
  }

  section("3. Declared Tables & Admin Pages");
  checkTruthy("declares log table", manifest.tables?.some(t => t.name === "log"));
  const logTable = manifest.tables.find(t => t.name === "log");
  check("log table has translatable fields", logTable.translatable.sort(), ["details", "execution_status", "hook_name", "target"]);

  checkTruthy("declares adminPages", Array.isArray(manifest.adminPages) && manifest.adminPages.length > 0);
  const logPage = manifest.adminPages.find(p => p.id === "logs");
  checkTruthy("has logs admin page", !!logPage);
  check("logs page has stats, table, and form blocks", logPage.blocks.map(b => b.type), ["stats", "table", "form"]);

  section("4. Language Packs & Translations");
  checkTruthy("declares en and zh-CN packs", !!manifest.langs?.en && !!manifest.langs?.["zh-CN"]);
  const enKeys = Object.keys(manifest.langs.en).sort();
  const zhKeys = Object.keys(manifest.langs["zh-CN"]).sort();
  check("en and zh-CN translation keys match exactly", enKeys, zhKeys);

  section("5. Host Hooks Runtime Integration");
  const { HOOK_IMPLS } = await bundle("src/extensions/plugin/runtime.ts", "hook-tester-runtime.mjs");
  checkTruthy("HOOK_IMPLS defines afterSavePost", typeof HOOK_IMPLS.afterSavePost?.impl === "function");
  checkTruthy("HOOK_IMPLS defines beforeDeletePost", typeof HOOK_IMPLS.beforeDeletePost?.impl === "function");

  // Verify execution tracing
  const logs = [];
  const mockCtx = {
    api: {
      log: async (msg) => { logs.push(msg); },
    },
  };
  await HOOK_IMPLS.afterSavePost.impl(mockCtx, { id: "p-101", title: "Test Article" });
  check("afterSavePost logs invocation details", logs[0], "afterSavePost triggered for post: p-101 (Test Article)");

  await HOOK_IMPLS.beforeDeletePost.impl(mockCtx, { id: "p-101" });
  check("beforeDeletePost logs invocation details", logs[1], "beforeDeletePost triggered for post: p-101");

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
