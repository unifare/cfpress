/**
 * Runtime tests for the CFPress template engine.
 *
 * Runs against the *compiled* engine. Because the project is TypeScript with
 * no build step, we transpile on the fly using esbuild if available, otherwise
 * fall back to a minimal strip that handles the constructs used here.
 *
 * Run: node tests/suites/template-engine.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

// --- load the TS engine -----------------------------------------------------
let engine;
async function loadEngine() {
  const src = readFileSync(join(root, "src/rendering/template-engine.ts"), "utf8");
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch {
    esbuild = null;
  }
  if (esbuild) {
    const out = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "es2022" });
    const url = "data:text/javascript;base64," + Buffer.from(out.code).toString("base64");
    return import(url);
  }
  // Fallback: TypeScript ships tsc; transpile via its API.
  const ts = require("typescript");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const url = "data:text/javascript;base64," + Buffer.from(out.outputText).toString("base64");
  return import(url);
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkThrows(name, fn) {
  try {
    const r = fn();
    // An async function that rejects is also a valid "throws".
    if (r && typeof r.then === "function") {
      return r.then(
        () => {
          fail++;
          console.log(`  FAIL ${name} (expected a throw)`);
        },
        () => {
          pass++;
          console.log(`  ok   ${name}`);
        }
      );
    }
    fail++;
    console.log(`  FAIL ${name} (expected a throw)`);
  } catch {
    pass++;
    console.log(`  ok   ${name}`);
  }
}

async function main() {
  engine = await loadEngine();
  const { renderTemplate, renderTemplateSource, parseTemplate, evaluate, parseExpression } = engine;

  const noTemplates = async () => null;

  console.log("\n1. Output & escaping");
  check("plain text", await renderTemplate("hello", {}, { loadTemplate: noTemplates }), "hello");
  check("variable", await renderTemplate("{{site.title}}", { site: { title: "CFPress" } }, { loadTemplate: noTemplates }), "CFPress");
  check(
    "html is escaped by default",
    await renderTemplate("{{x}}", { x: '<b>&"</b>' }, { loadTemplate: noTemplates }),
    "&lt;b&gt;&amp;&quot;&lt;/b&gt;"
  );
  check("triple brace is raw", await renderTemplate("{{{x}}}", { x: "<b>hi</b>" }, { loadTemplate: noTemplates }), "<b>hi</b>");
  check("missing path renders empty", await renderTemplate("[{{a.b.c}}]", {}, { loadTemplate: noTemplates }), "[]");

  console.log("\n2. Conditions");
  check("if true", await renderTemplate("{{#if ok}}Y{{/if}}", { ok: true }, { loadTemplate: noTemplates }), "Y");
  check("if false", await renderTemplate("{{#if ok}}Y{{/if}}", { ok: false }, { loadTemplate: noTemplates }), "");
  check("if else", await renderTemplate("{{#if ok}}Y{{else}}N{{/if}}", { ok: 0 }, { loadTemplate: noTemplates }), "N");
  check("unless", await renderTemplate("{{#unless ok}}N{{/unless}}", { ok: false }, { loadTemplate: noTemplates }), "N");
  check("comparison >", await renderTemplate("{{#if n > 3}}big{{/if}}", { n: 5 }, { loadTemplate: noTemplates }), "big");
  check("string equality", await renderTemplate('{{#if t == "product"}}P{{/if}}', { t: "product" }, { loadTemplate: noTemplates }), "P");
  check("logical and", await renderTemplate("{{#if a && b}}AB{{/if}}", { a: 1, b: 2 }, { loadTemplate: noTemplates }), "AB");
  check("logical or", await renderTemplate("{{#if a || b}}X{{/if}}", { a: 0, b: 1 }, { loadTemplate: noTemplates }), "X");
  check("negation", await renderTemplate("{{#if !a}}X{{/if}}", { a: false }, { loadTemplate: noTemplates }), "X");
  check("empty array is falsy", await renderTemplate("{{#if list}}X{{else}}E{{/if}}", { list: [] }, { loadTemplate: noTemplates }), "E");

  console.log("\n3. Loops");
  check(
    "each with default this",
    await renderTemplate("{{#each items}}[{{this}}]{{/each}}", { items: [1, 2, 3] }, { loadTemplate: noTemplates }),
    "[1][2][3]"
  );
  check(
    "each as item",
    await renderTemplate("{{#each items as x}}{{x.n}},{{/each}}", { items: [{ n: "a" }, { n: "b" }] }, { loadTemplate: noTemplates }),
    "a,b,"
  );
  check(
    "each with index",
    await renderTemplate("{{#each items as x, i}}{{i}}:{{x}} {{/each}}", { items: ["a", "b"] }, { loadTemplate: noTemplates }),
    "0:a 1:b "
  );
  check("each empty -> else", await renderTemplate("{{#each items as x}}{{x}}{{else}}none{{/each}}", { items: [] }, { loadTemplate: noTemplates }), "none");
  check(
    "@first / @last",
    await renderTemplate("{{#each items as x}}{{#if @first}}S{{/if}}{{x}}{{#if @last}}E{{/if}}{{/each}}", { items: [1, 2, 3] }, { loadTemplate: noTemplates }),
    "S123E"
  );
  check(
    "nested each",
    await renderTemplate("{{#each outer as o}}{{#each o as i}}{{i}}{{/each}}|{{/each}}", { outer: [[1, 2], [3]] }, { loadTemplate: noTemplates }),
    "12|3|"
  );

  console.log("\n4. Helpers");
  check("len on array", await renderTemplate("{{len(items)}}", { items: [1, 2, 3] }, { loadTemplate: noTemplates }), "3");
  check("truncate", await renderTemplate("{{truncate(s, 4)}}", { s: "abcdefgh" }, { loadTemplate: noTemplates }), "abcd…");
  check("number format", await renderTemplate("{{number(p)}}", { p: 1234567 }, { loadTemplate: noTemplates }), "1,234,567");
  check("default", await renderTemplate("{{default(a, 'fallback')}}", { a: "" }, { loadTemplate: noTemplates }), "fallback");
  check("upper", await renderTemplate("{{upper(x)}}", { x: "abc" }, { loadTemplate: noTemplates }), "ABC");
  check("date", await renderTemplate("{{date(t)}}", { t: 1700000000 }, { loadTemplate: noTemplates }), "2023-11-14");
  check("contains array", await renderTemplate("{{#if contains(tags,'a')}}Y{{/if}}", { tags: ["a", "b"] }, { loadTemplate: noTemplates }), "Y");
  checkThrows("unknown helper throws", () => engine.evaluate(engine.parseExpression("bogusHelper(1)"), {}));

  console.log("\n5. Includes & inheritance");
  const files = {
    "parts/card": "<div class=\"card\">{{title}}</div>",
    "base": "<html><body>{{@section \"content\"}}</body></html>",
    "child": '{{@extends "base"}}{{@section "content"}}<p>{{msg}}</p>{{/section}}',
  };
  const loader = async (name) => (name in files ? files[name] : null);
  check("include", await renderTemplate('{{@include "parts/card"}}', { title: "Hi" }, { loadTemplate: loader }), '<div class="card">Hi</div>');
  check(
    "extends + section override",
    await renderTemplateSource(files.child, { msg: "hello" }, { loadTemplate: loader }),
    "<html><body><p>hello</p></body></html>"
  );
  checkThrows("missing include throws", () => renderTemplate('{{@include "nope"}}', {}, { loadTemplate: loader }));

  console.log("\n6. Query blocks");
  check(
    "query binds rows",
    await renderTemplate(
      '{{@query type="product" limit=2 as="products"}}{{#each products as p}}{{p.title}};{{/each}}{{/query}}',
      {},
      {
        loadTemplate: noTemplates,
        runQuery: async (params) => {
          check("  query params parsed", JSON.stringify(params), '{"type":"product","limit":2}');
          return [{ title: "A" }, { title: "B" }];
        },
      }
    ),
    "A;B;"
  );

  console.log("\n7. Safety");
  checkThrows("assignment is not supported", () => parseTemplate("{{ x = 1 }}"));
  // `evil()` parses, but can only ever resolve to a whitelisted helper — a
  // template can never reach a real function, so it fails at evaluation.
  checkThrows("arbitrary call is rejected", () => evaluate(parseExpression("evil()"), {}));
  checkThrows("constructor is not reachable", () => evaluate(parseExpression("constructor()"), {}));
  checkThrows("new Function not reachable", () => parseTemplate("{{ new Function('x') }}"));
  check(
    "globalThis is not implicitly exposed",
    evaluate(parseExpression("globalThis"), {}),
    undefined
  );
  checkThrows("unclosed block throws", () => parseTemplate("{{#if a}}never closed"));
  checkThrows("unclosed each throws", () => parseTemplate("{{#each a}}never closed"));
  checkThrows("mixing slots and definitions throws", () =>
    parseTemplate('{{@section "a"}}body{{/section}}{{@section "b"}}')
  );
  // The slot/definition distinction is guessed by scanning ahead for a closer.
  // When the guess is wrong the page renders blank with a 200 and no error, so
  // the one case that can be *proved* wrong is rejected instead of guessed:
  // a file that `@extends` is a child, and a child never provides slots. This
  // is the skeleton bug the generator shipped, caught structurally.
  checkThrows("a child that leaves its section unclosed throws", () =>
    parseTemplate('{{@extends "layout"}}{{@section "content"}}<p>hi</p>')
  );
  checkThrows("unexpected closer throws", () => parseTemplate("{{/if}}"));
  checkThrows("cyclic extends throws", () =>
    renderTemplateSource('{{@extends "a"}}', {}, { loadTemplate: async (n) => (n === "a" ? '{{@extends "a"}}' : null) })
  );

  console.log("\n8. Layout / slot semantics");
  {
    const layoutFiles = {
      layout: '<html><body>{{@section "content"}}<footer>F</footer></body></html>',
      child: '{{@extends "layout"}}{{@section "content"}}<p>{{msg}}</p>{{/section}}',
      orphan: '<html><body>{{@section "content"}}</body></html>',
      base: '<b>{{@section "main"}}{{@section "side"}}</b>',
      mid: '{{@extends "base"}}{{@section "main"}}MID{{/section}}',
      leaf: '{{@extends "mid"}}{{@section "main"}}LEAF{{/section}}',
    };
    const load = async (n) => (n in layoutFiles ? layoutFiles[n] : null);
    check(
      "layout renders child content in the slot",
      await renderTemplateSource(layoutFiles.child, { msg: "hi" }, { loadTemplate: load }),
      "<html><body><p>hi</p><footer>F</footer></body></html>"
    );
    check(
      "slot with no override renders empty",
      await renderTemplateSource(layoutFiles.orphan, {}, { loadTemplate: load }),
      "<html><body></body></html>"
    );
    check(
      "three-level inheritance: leaf wins",
      await renderTemplateSource(layoutFiles.leaf, {}, { loadTemplate: load }),
      "<b>LEAF</b>"
    );

    // The case above cannot see the merge order, because its root (`base`) has
    // only slots and therefore contributes no definitions: whatever the leaf
    // says wins by default. The inversion is only observable when the root
    // *also* defines the section and the leaf does not — then the intermediate
    // layout must win, and the old "keep the first write except for i === 0"
    // form handed it to the root instead, i.e. the least-derived copy.
    const deepFiles = {
      root: '{{@section "main"}}ROOT{{/section}}',
      mid: '{{@extends "root"}}{{@section "main"}}MID{{/section}}',
      leaf: '{{@extends "mid"}}{{@section "side"}}LEAF-SIDE{{/section}}',
    };
    check(
      "an intermediate layout beats the root for a section the leaf does not define",
      await renderTemplateSource(deepFiles.leaf, {}, {
        loadTemplate: async (n) => (n in deepFiles ? deepFiles[n] : null),
      }),
      "MID"
    );
  }

  console.log("\n9. Dotnetcms parity (helpers & layout pipeline)");
  {
    // prefix_lang helper
    check("prefix_lang absolute URL", await renderTemplate("{{prefix_lang('/about', 'en')}}", {}, { loadTemplate: noTemplates }), "/en/about");
    check("prefix_lang preserves external URL", await renderTemplate("{{prefix_lang('https://example.com', 'en')}}", {}, { loadTemplate: noTemplates }), "https://example.com");
    check("prefix_lang uses scope locale when omitted", await renderTemplate("{{prefix_lang('/search')}}", { locale: "zh-CN" }, { loadTemplate: noTemplates }), "/zh-CN/search");
    check("prefix_lang avoids double prefix", await renderTemplate("{{prefix_lang('/en/blog', 'en')}}", {}, { loadTemplate: noTemplates }), "/en/blog");

    // t helper
    check("t fallback", await renderTemplate("{{t('not.found', 'Default Text')}}", {}, { loadTemplate: noTemplates }), "Default Text");
    check("t with dictionary object", await renderTemplate("{{t('btn.save', 'Save')}}", { t: { "btn.save": "保存" } }, { loadTemplate: noTemplates }), "保存");
    check("t with theme.strings nested", await renderTemplate("{{t('nav.home')}}", { theme: { strings: { nav: { home: "首页" } } } }, { loadTemplate: noTemplates }), "首页");
    check("t with theme.strings prefixed", await renderTemplate("{{t('theme.mytheme.nav.home')}}", { theme: { strings: { nav: { home: "首页" } } } }, { loadTemplate: noTemplates }), "首页");
    check("t prototype safe", await renderTemplate("{{t('constructor')}}", { t: {} }, { loadTemplate: noTemplates }), "constructor");
    check("t with @translator function", await renderTemplate("{{t('core.ok')}}", { "@translator": (k, fb) => (k === "core.ok" ? "OK!" : fb) }, { loadTemplate: noTemplates }), "OK!");

    // widgets helper
    check("widgets area output", await renderTemplate("{{{widgets('sidebar-1')}}}", { widgets: { "sidebar-1": "<aside>Widgets</aside>" } }, { loadTemplate: noTemplates }), "<aside>Widgets</aside>");
    check("widgets missing area empty", await renderTemplate("{{{widgets('missing')}}}", { widgets: {} }, { loadTemplate: noTemplates }), "");

    // hook helper
    check("hook output", await renderTemplate("{{{hook('frontend:head:start')}}}", { "@hooks": { "frontend:head:start": "<meta name='custom'>" } }, { loadTemplate: noTemplates }), "<meta name='custom'>");

    // automatic layout pipeline: child with no @extends gets wrapped into defaultLayout
    const autoFiles = {
      "base": "<html><head></head><body><div class=\"content\">{{@section \"content\"}}</div><div class=\"body\">{{{body}}}</div></body></html>",
      "child": "<h1>Child Content</h1>",
    };
    const autoLoader = async (n) => (n in autoFiles ? autoFiles[n] : null);
    check(
      "automatic layout wrapping populates content slot and body variable",
      await renderTemplateSource(autoFiles.child, {}, {
        loadTemplate: autoLoader,
        defaultLayout: "base",
      }),
      '<html><head></head><body><div class="content"><h1>Child Content</h1></div><div class="body"><h1>Child Content</h1></div></body></html>'
    );

    // Verify child @query executes only once when layout uses @section content (no redundant body pre-render)
    let execCount = 0;
    const queryFiles = {
      "base": "<html><body>{{@section \"content\"}}</body></html>",
      "child": "{{@query type=\"post\" asVar=\"items\"}}x{{/query}}",
    };
    await renderTemplateSource(queryFiles.child, {}, {
      loadTemplate: async (n) => queryFiles[n],
      defaultLayout: "base",
      runQuery: async () => { execCount++; return [{}]; },
    });
    check("child @query is only executed once under autoLayout with section content", execCount, 1);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
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
