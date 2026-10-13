/**
 * The test fixture theme, validated end to end — `themes/fixture/`.
 *
 * ## Why this suite exists
 *
 * `themes/fixture` is the **living document** of what a theme may declare:
 * theme-owned tables, a generated admin screen, declarative front-end routes
 * with `resolve.table` / `query.as`, and a bilingual catalogue. Documentation
 * drifts; a theme that the real validator, the real architecture rules and the
 * real template engine all accept does not.
 *
 * It is also the only place the *combination* is exercised. `scaffold.test.mjs`
 * proves the generator emits a valid skeleton — a skeleton declares no tables
 * and no routes, because it has no business logic. `theme-integration.test.mjs`
 * proves the machinery works on an inline fixture. Neither would notice if
 * `resolve.table` and `translatable` stopped fitting together, or if the item
 * templates assumed a field the declaration no longer carries.
 *
 * ## Why a fixture and not a showcase theme
 *
 * This suite used to run against `themes/eshop`, a 9-template demo shop. The
 * assertions below test *the theme mechanism* (tables, routes, translatable
 * fields, render kinds), not the shop's opinionated design — so carrying 9
 * files of styling meant the suite could break for reasons that had nothing to
 * do with the platform. `fixture` keeps every capability and drops the
 * decoration: what is asserted here is exactly what the platform promises.
 *
 * Note the distinct template kinds the fixture must keep, because each one
 * exercises a different render path: `archive-item` / `single-item` read a
 * theme-owned table, `index` / `single` / `page` render content, and
 * `archive` / `category` / `tag` / `search` / `404` render empty-scope
 * branches that a happy-path fixture would never reach.
 *
 * ## What is deliberately NOT here
 *
 * Upload → activate → query the database. That chain needs a real Worker and a
 * real D1, and it is already covered end to end by `theme-integration.test.mjs`
 * on a fixture of the same shape. What is unique to `fixture` — *its
 * declaration and its templates agree with each other and with the platform* —
 * is what is asserted below.
 *
 * Usage: node tests/suites/theme-fixture.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { langPackProblems, themeManifestProblems } from "../fixtures/_extension-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}
function section(t) { console.log(`\n${t}`); }

/**
 * A crashed harness must still print a summary.
 *
 * Without this, a template that throws during section 5 aborts `main()` before
 * the `N passed, M failed` line, and the *only* signal left is a stack trace.
 * A reader (or a script) that greps for the summary then finds nothing and
 * concludes the suite is fine — which is exactly how this suite's own section
 * check was once mistaken for a pass while it was red. A run must never be
 * silently summary-less: absence of a summary is a failure, stated as one.
 */
function summary(note) {
  const suffix = note ? ` (${note})` : "";
  console.log(`\n${pass} passed, ${fail} failed${suffix}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

/**
 * Bundle a real source module. Node's built-in type stripping rejects some TS
 * the engine uses, and this environment cannot spawn a build, so esbuild is
 * invoked in-process — the same approach the other harnesses take.
 */
async function bundle(entry, outName) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  const dir = join(root, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, outName);
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

const THEME = "fixture";
const themeDir = join(root, "content", "themes", THEME);

async function main() {
  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "fixture-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "fixture-engine.mjs");

  // -- 1. install boundary -------------------------------------------------
  section("1. The install boundary accepts it");
  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
  let error = null;
  try {
    const v = validateManifest(manifest, "theme");
    check("the validator normalises the manifest", v.name, THEME);
  } catch (e) {
    error = e?.message || String(e);
  }
  check("validateManifest accepts the theme", error, null);

  // -- 2. the declaration is the point of this theme -----------------------
  section("2. It declares what makes it interesting");
  check("declares a theme-owned table", manifest.tables.map((t) => t.name), ["item"]);
  check(
    "only the text-bearing fields are translatable",
    manifest.tables[0].translatable,
    ["name", "blurb"]
  );
  check(
    "price and stock are not translatable",
    manifest.tables[0].translatable.some((k) => ["price", "stock", "in_stock", "released_on"].includes(k)),
    false
  );
  check(
    "both halves of the table are declared (table + the menu that opens it)",
    manifest.adminMenus.some((m) => m.screen === "table-list" && m.args?.table === "item"),
    true
  );
  check(
    "the menu's table is a declared table",
    manifest.adminMenus
      .filter((m) => m.args?.table)
      .every((m) => manifest.tables.some((t) => t.name === m.args.table)),
    true
  );
  // A one-object route miss must be a 404, which only works if routing knows
  // which rows are single objects — that is what `resolve.by` says.
  const itemRoute = manifest.routes.find((r) => r.path === "/items/:slug");
  check("the item route resolves the table by slug", itemRoute.resolve, { table: "item", by: "slug" });
  check("the item route names a template", itemRoute.template, "single-item");
  check("the listing route names its scope", manifest.routes.find((r) => r.path === "/items").query.as, "items");
  check("lanes are declared", manifest.locales, ["en", "zh-CN"]);

  // -- 3. the real architecture rules -------------------------------------
  section("3. The real architecture rules accept it");
  // Same functions `architecture.test.mjs` calls, not a copy — see
  // `_extension-rules.mjs` for why a copy would be the wrong answer.
  check("theme manifest rules report nothing", themeManifestProblems(root), []);
  check("language-pack rules report nothing", langPackProblems(root), []);

  // -- 4. declarations match the filesystem -------------------------------
  section("4. Every declared template and part ships a file");
  check(
    "every declared template exists",
    manifest.templates.filter((t) => !existsSync(join(themeDir, "templates", `${t}.html`))),
    []
  );
  check(
    "every declared part exists",
    manifest.parts.filter((p) => !existsSync(join(themeDir, "templates", "parts", `${p}.html`))),
    []
  );
  // `langs/<locale>.json` for each declared locale — the rules in section 3
  // check the *keys*; this checks the files are there at all, so the prefix
  // rule cannot be satisfied by an empty directory.
  check(
    "every declared locale ships a pack",
    manifest.locales.filter((l) => !existsSync(join(themeDir, "langs", `${l}.json`))),
    []
  );

  // Every child must close every section it opens. The engine tells a section
  // definition from a layout slot by scanning ahead for `{{/section}}`, so an
  // unclosed section in a child reads as a slot and renders an empty <main>
  // with HTTP 200 and no error. The engine now rejects it too (structurally —
  // `validateSections` checks the parsed node's `body === null`), but asserting
  // it here says *which file* and needs no rendering to fail.
  //
  // The count must run on comment-stripped source. `{{! … }}` comments are
  // stripped before parsing, so a `{{/section}}` written inside one is not a
  // closer — counting raw text lets a comment *mask* an unclosed section, and
  // the check then reports green on the exact defect it exists to catch. This
  // was a real false green: dropping the real closer while the comment kept a
  // decoy passed this assertion while the engine threw.
  const unclosed = [];
  for (const t of manifest.templates) {
    const raw = readFileSync(join(themeDir, "templates", `${t}.html`), "utf8");
    const src = raw.replace(/\{\{![\s\S]*?\}\}/g, "");
    const opens = (src.match(/\{\{@section\s/g) ?? []).length;
    const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;
    if (opens !== closes) unclosed.push(`${t}.html: ${opens} open, ${closes} closed`);
  }
  check("every child closes every section it opens", unclosed, []);

  const refs = [];
  for (const rel of ["parts/layout.html", ...manifest.templates.map((t) => `${t}.html`)]) {
    // Comment-stripped for the same reason as the section count above: a target
    // named in a `{{! … }}` comment is documentation, not a dependency, and
    // flagging it would make the check fire on prose.
    const src = readFileSync(join(themeDir, "templates", rel), "utf8").replace(/\{\{![\s\S]*?\}\}/g, "");
    for (const m of src.matchAll(/\{\{@(?:include|extends)\s+"([^"]+)"\s*\}\}/g)) refs.push(m[1]);
  }
  check(
    "every @include/@extends target exists",
    [...new Set(refs)].filter(
      (n) => !existsSync(join(themeDir, "templates", `${n}.html`)) && !existsSync(join(themeDir, "templates", "parts", `${n}.html`))
    ),
    []
  );

  // -- 5. every template renders through the real engine -------------------
  section("5. Every template renders through the real template engine");
  const loadTemplate = async (name) => {
    for (const p of [
      join(themeDir, "templates", `${name}.html`),
      join(themeDir, "templates", "parts", `${name}.html`),
    ]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const base = {
    site: { title: "Fixture Site", description: "Test material.", robots: "", locale: "en" },
    page: { title: "Items", description: "", path: "/items", kind: "archive", document_title: "Items | Fixture Site" },
    locale: "en",
    locales: [{ code: "en", name: "English", is_default: true }],
    theme: { name: THEME, title: "Test Fixture Theme", version: "1.0.0" },
    menu: { primary: [{ title: "Items", url: "/en/items", target: null }], primary_html: "" },
  };
  // A row shaped the way `tableList` returns one: platform columns plus the
  // declared fields. If the templates ever read a field the declaration does
  // not carry, the rendered output loses it and an assertion below turns red.
  const item = {
    id: "ttr_1", slug: "oak-desk", site_id: "default", lang_group: "ttr_1", status: "published",
    created_at: 1750000000, updated_at: 1750000000,
    name: "Oak Desk", blurb: "Solid white oak, hand-finished.", price: 1200, stock: 4,
    in_stock: 1, released_on: "2025-03-01",
  };

  const archive = await render("archive-item.html", { ...base, items: [item] });
  checkTruthy("archive inherits the layout", archive.includes('class="brand"'));
  checkTruthy("archive renders the item name", archive.includes("Oak Desk"));
  // The item link must come from the route's own path. Hard-coding `/blog/`
  // sent every item link to a 404 and returned 200 while doing it.
  checkTruthy("archive links to the route's own path", archive.includes('href="/en/items/oak-desk"'));
  checkTruthy("archive links are not hard-coded to /blog/", !archive.includes("/blog/"));
  checkTruthy("the number helper formats the price", archive.includes("1,200"));
  checkTruthy("the truthy branch of in_stock renders", archive.includes("In stock"));
  checkTruthy("no template syntax leaked into the output", !archive.includes("{{"));

  const archiveEmpty = await render("archive-item.html", { ...base, items: [] });
  checkTruthy("the empty archive takes the empty branch", archiveEmpty.includes("No items yet"));

  const single = await render("single-item.html", { ...base, page: { ...base.page, title: "Items" }, post: item, item });
  checkTruthy("single renders the name", single.includes("Oak Desk"));
  checkTruthy("single renders the price", single.includes("1,200"));
  checkTruthy("single shows the release date", single.includes("2025-03-01"));

  const soldOut = await render("single-item.html", { ...base, item: { ...item, in_stock: 0 } });
  checkTruthy("the sold-out branch renders", soldOut.includes("Sold out"));

  // A one-object miss must render the not-found branch — not the listing.
  const miss = await render("single-item.html", { ...base, item: null });
  checkTruthy("a missing item renders the not-found branch", miss.includes("Item not found"));

  const home = await render("index.html", { ...base, page: { ...base.page, kind: "home" }, posts: [] });
  checkTruthy("index takes the empty branch with no posts", home.includes("Nothing published yet"));

  const index = await render("index.html", {
    ...base,
    posts: [{ slug: "hello", title: "Hello", excerpt: "First.", created_at: 1750000000, url: "/en/blog/hello" }],
  });
  checkTruthy("index renders the post list", index.includes("Hello"));
  checkTruthy("index did not take the empty branch", !index.includes("Nothing published yet"));

  // Triple braces: the engine escapes by default and the body lives on the item.
  const page = await render("page.html", { ...base, post: { html: "<p>Hi</p>" } });
  checkTruthy("page emits the body unescaped", page.includes("<p>Hi</p>"));

  const notFound = await render("404.html", { ...base });
  checkTruthy("404 renders", notFound.includes("Not found"));
  checkTruthy("404 links back to the locale root", notFound.includes('href="/en"'));

  // The remaining render kinds exist so a theme mismatch shows up here rather
  // than as a blank page on a live site: each one is a distinct list scope.
  for (const kind of ["archive", "category", "tag", "search"]) {
    const out = await render(`${kind}.html`, { ...base, posts: [] });
    checkTruthy(`${kind}.html renders its empty branch`, out.includes("No "));
    checkTruthy(`${kind}.html does not leak template syntax`, !out.includes("{{"));
  }

  // -- 6. every declared template, every scope, no leaked syntax -----------
  //
  // Section 5 above renders each kind with the *scope it was written for*, and
  // that is what catches a missing field. This section renders every template
  // with a *realistic* scope and asserts the four invariants that hold for all
  // of them, whatever they are about. The distinction matters: a template can
  // render correctly for the field it reads and still print `undefined` in a
  // branch nobody exercised, or fill `<main>` empty because the layout slot did
  // not resolve. Both are 200-with-wrong-content, the failure mode this repo
  // keeps finding, and neither is visible from a per-field assertion.
  //
  // These invariants used to live in `theme-aurora.test.mjs`. That suite was
  // retired with `themes/aurora`, but the checks were about *the engine and the
  // template contract*, not about Aurora's design — so they belong here, next
  // to the theme that is now the only shipped declaration fixture.
  section("6. Every declared template renders a full shell");
  const realPosts = [
    { id: "post_1", slug: "hello-world", type: "post", status: "published",
      created_at: 1750000000, updated_at: 1750000000, locale: "en",
      title: "Hello World", excerpt: "My first post on this site.",
      url: "/en/blog/hello-world", meta: {},
      html: `<p>Opening paragraph. ${"The quick brown fox jumps over the lazy dog. ".repeat(20)}</p>`
          + "<h2>A section heading</h2><p>Body copy under the first heading.</p>"
          + "<blockquote>A pull quote worth remembering.</blockquote>"
          + "<h2>A second heading</h2><ul><li>First item</li><li>Second item</li></ul>"
          + "<pre><code>const x = 1;</code></pre>" },
    { id: "post_2", slug: "second-post", type: "post", status: "published",
      created_at: 1751000000, updated_at: 1751000000, locale: "en",
      title: "Second Post", url: "/en/blog/second-post", meta: {},
      excerpt: "Testing the archive layout with a longer summary that should be truncated by the template helper." },
  ];
  const rich = {
    ...base,
    site: { title: "Fixture Site", description: "A realistic scope.", robots: "index,follow", locale: "en" },
    menu: { primary: [{ title: "Items", url: "/en/items", target: null }], primary_html: '<a href="/en/items">Items</a>' },
    posts: realPosts,
    post: realPosts[0],
    item,
  };

  // Each declared template with the scope its kind implies. `home` and `index`
  // differ only by `page.kind`, which is exactly the distinction the resolver
  // hierarchy uses to pick between them — so rendering both proves the file
  // exists for each and that neither is mistaken for the other.
  const everyKind = [
    ["index.html", { ...rich, page: { ...rich.page, kind: "home", title: "Fixture Site", path: "/en" } }],
    ["home.html", { ...rich, page: { ...rich.page, kind: "home", title: "Fixture Site", path: "/en" } }],
    ["single.html", { ...rich, page: { ...rich.page, kind: "single", title: "Hello World" } }],
    ["page.html", { ...rich, post: { ...realPosts[0], type: "page" }, page: { ...rich.page, kind: "page", title: "About" } }],
    ["archive.html", { ...rich, page: { ...rich.page, kind: "archive", title: "Archive", path: "/en/blog" } }],
    ["category.html", { ...rich, page: { ...rich.page, kind: "category", title: "Category" } }],
    ["tag.html", { ...rich, page: { ...rich.page, kind: "tag", title: "Tag" } }],
    ["search.html", { ...rich, page: { ...rich.page, kind: "search", title: "Search" } }],
    ["archive-item.html", { ...rich, page: { ...rich.page, kind: "archive", title: "Items", path: "/en/items" } }],
    ["single-item.html", { ...rich, page: { ...rich.page, kind: "single", title: "Oak Desk" } }],
    ["404.html", { ...rich, page: { ...rich.page, kind: "404", title: "Not found" } }],
  ];
  const shellProblems = [];
  for (const [file, scope] of everyKind) {
    try {
      const html = await render(file, scope);
      const issues = [];
      if (!html.includes("<html")) issues.push("no <html> shell (layout slot did not fill)");
      if (html.includes("{{")) issues.push("leaked template syntax");
      if (html.includes("undefined")) issues.push("output contains 'undefined'");
      if (issues.length) shellProblems.push(`${file}: ${issues.join("; ")}`);
    } catch (e) {
      shellProblems.push(`${file}: threw ${e.message}`);
    }
  }
  check("all 11 declared templates render a full shell", shellProblems, []);

  // The scopes a live site reaches that a happy-path fixture never does. Each
  // once rendered a blank page or the literal string "undefined".
  const edges = [
    ["index.html, no posts", "index.html", { ...rich, posts: [], page: { ...rich.page, kind: "home" } }],
    ["archive.html, no posts", "archive.html", { ...rich, posts: [], page: { ...rich.page, kind: "archive" } }],
    ["single.html, empty body", "single.html", { ...rich, post: { ...realPosts[0], html: "" } }],
    ["index.html, no menu", "index.html", { ...rich, menu: { primary: [], primary_html: "" } }],
    ["index.html, no description", "index.html", { ...rich, site: { title: "S", description: "", robots: "", locale: "en" } }],
  ];
  const edgeProblems = [];
  for (const [label, file, scope] of edges) {
    try {
      const html = await render(file, scope);
      const issues = [];
      if (!html.includes("<html")) issues.push("no <html> shell");
      if (html.includes("{{")) issues.push("leaked template syntax");
      if (html.includes("undefined")) issues.push("output contains 'undefined'");
      if (issues.length) edgeProblems.push(`${label}: ${issues.join("; ")}`);
    } catch (e) {
      edgeProblems.push(`${label}: threw ${e.message}`);
    }
  }
  check("degraded scopes still render a full shell", edgeProblems, []);

  summary();
  return fail === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // Record it as a failure so the summary is both present and truthful.
  fail++;
  failures.push(`harness threw: ${(e && e.message) || e}`);
  summary("aborted");
  code = 2;
}
process.exit(code);
