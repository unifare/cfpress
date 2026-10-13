/**
 * Scaffold contract test — `scripts/make-theme.mjs` / `make-plugin.mjs` /
 * `make-table.mjs`. ARCHITECTURE.md §5.5 (defence four) and §8 batch 4.
 *
 * ## Why this suite exists
 *
 * A generator is a promise: "start from this and you cannot get the shape
 * wrong." That promise is worth nothing unless something checks it. The
 * skeleton it emits is made of exactly the constructs that fail *quietly* here —
 * `{{len(posts)}}` (a helper called with parentheses; the spaced form raises and
 * takes the whole page down to a bare shell), `{{{post.html}}}` (the engine
 * escapes by default, and the body lives on the item), `@section` slots,
 * `@include` targets that must exist, and language-pack keys whose prefix
 * decides who wins a collision. None are discoverable from a blank file, and all
 * of them are asserted below.
 *
 * ## How it drives the real thing without spawning
 *
 * This environment cannot spawn a child process at all — the sandbox locks the
 * node binary, which is also why `tests/run-all.mjs` reports SKIP on this
 * machine. A generator that could only be exercised as a command would therefore
 * be a generator whose output is never checked. So each generator exports
 * `main(argv, io)` plus a pure content builder (`themeFiles` / `pluginFiles` /
 * `tableDeclarations`), and this suite calls them directly. `process.exit` moved
 * behind an `isMain()` guard, and user-facing problems are thrown as `CliError`
 * and returned as an exit code — so argument handling, refusal messages and exit
 * codes are all testable too.
 *
 * ## What it deliberately does NOT cover
 *
 * "It can be activated" needs a real Worker and a real D1. That chain is proven
 * end to end by `tests/suites/theme-integration.test.mjs` on a fixture theme of the
 * same shape (upload → validate → activate → materialise → render), so it is not
 * duplicated here. What is unique to the scaffold — *the emitted content is
 * correct* — is covered by four independent checks:
 *
 *   1. the real `validateManifest` accepts the generated manifest,
 *   2. the real architecture rules accept the generated theme (imported from
 *      `_extension-rules.mjs`, the same functions `architecture.test.mjs` uses —
 *      not a copy, so "passes the architecture test" is a fact rather than a
 *      claim),
 *   3. every template renders through the real template engine, with data and
 *      without, and no template syntax survives into the output,
 *   4. every `@include` / `@extends` target resolves to a file that was shipped.
 *
 * Usage: node tests/suites/scaffold.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { langPackProblems, themeManifestProblems } from "../fixtures/_extension-rules.mjs";
import { main as makeTheme } from "../../scripts/make-theme.mjs";
import { main as makePlugin } from "../../scripts/make-plugin.mjs";
import { main as makeTable } from "../../scripts/make-table.mjs";
// Imported from the contract, not re-listed: the assertion below asks the same
// question the validator asks, and must get the same answer by construction.
import { isProseFieldType } from "../../src/extensions/contract/manifest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

let pass = 0;
let fail = 0;
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

/**
 * Generated output goes to a scratch tree, *not* to the repo's `content/themes/`.
 *
 * The scratch root mirrors the repo layout (`<root>/content/themes/<name>/`), because
 * the architecture rules take a root and read `<root>/content/themes` — that is what
 * lets this suite apply the real rules to a tree the repo never sees.
 */
const SCRATCH = join(root, ".wrangler", "scaffold-probe");
const THEME = "probe-theme";
const PLUGIN = "probe-plugin";
const themesRoot = join(SCRATCH, "content", "themes");
const pluginsRoot = join(SCRATCH, "content", "plugins");
const themeDir = join(themesRoot, THEME);
const pluginDir = join(pluginsRoot, PLUGIN);

/** Capture what a generator would print, without a terminal. */
function makeIo() {
  const out = [];
  const err = [];
  return {
    log: (s) => out.push(String(s)),
    error: (s) => err.push(String(s)),
    get stdout() { return out.join("\n"); },
    get stderr() { return err.join("\n"); },
  };
}

/** Bundle a real source module so the test drives shipped code, not a copy. */
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
  // Under SCRATCH, so the `finally` that clears it also clears these. Writing
  // them to `.wrangler/` directly would leave a bundle behind on every run.
  mkdirSync(SCRATCH, { recursive: true });
  const tmp = join(SCRATCH, outName);
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function walkFiles(dir) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e);
      if (statSync(abs).isDirectory()) go(abs);
      else out.push(relative(dir, abs).split("\\").join("/"));
    }
  };
  go(dir);
  return out.sort();
}

async function main() {
  // A previous run that died mid-way must not wedge this one — and the removal
  // is *verified*, because `force: true` swallows the error. This matters more
  // than it looks: `writeTree` refuses to clobber, so a leftover tree survives
  // the next generation and every assertion below would then describe output
  // this run never wrote. The suite would go green on content the generator no
  // longer emits, which is a false green of exactly the kind this repo has been
  // bitten by before.
  rmSync(SCRATCH, { recursive: true, force: true });
  if (existsSync(SCRATCH)) {
    throw new Error(`could not clear ${SCRATCH} — assertions would describe a stale tree`);
  }

  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "scaffold-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "scaffold-engine.mjs");

  // -- 1. generate a theme -------------------------------------------------
  section("1. `make-theme` emits a complete skeleton");
  const io1 = makeIo();
  check("generator exits 0", makeTheme([THEME, "--title", "Probe Theme", "--out", themesRoot], io1), 0);

  // `walkFiles` sorts lexically, and `templates/page.html` < `templates/parts/…`
  // because `g` < `r` — so `single.html` belongs *after* the `parts/` entries,
  // not with the other top-level templates.
  const expectedFiles = [
    "langs/en.json",
    "langs/zh-CN.json",
    "templates/404.html",
    "templates/index.html",
    "templates/page.html",
    "templates/parts/footer.html",
    "templates/parts/header.html",
    "templates/parts/layout.html",
    "templates/single.html",
    "theme.json",
  ];
  check("emitted file set is exactly as documented", walkFiles(themeDir), expectedFiles);
  checkTruthy("the generator reports what it wrote", /\+ theme\.json/.test(io1.stdout));

  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
  check("theme.json is valid JSON with the right name", manifest.name, THEME);
  check("--title is honoured", manifest.title, "Probe Theme");

  // -- 2. the real validator accepts it ------------------------------------
  section("2. The generated manifest passes the real install boundary");
  let validationError = null;
  try {
    const v = validateManifest(manifest, "theme");
    check("validator returns the normalised manifest", v.name, THEME);
  } catch (e) {
    validationError = e?.message || String(e);
  }
  check("validateManifest accepts the skeleton", validationError, null);

  // The generator must not ship a table: a skeleton has no business logic, so a
  // declared table would be a table nobody writes to. `make-table` exists for
  // when there is a real one, and it adds both halves.
  check("skeleton declares no tables", manifest.tables, undefined);
  check("skeleton declares no admin menus", manifest.adminMenus, undefined);

  // -- 3. declared templates exist, includes resolve ------------------------
  section("3. Declared templates and include targets resolve");
  const missing = (manifest.templates ?? []).filter(
    (t) => !existsSync(join(themeDir, "templates", `${t}.html`))
  );
  check("every declared template ships a file", missing, []);

  // `@include "parts/header"` must land on `templates/parts/header.html`. A
  // dangling include throws at render time and degrades the whole page to a bare
  // shell, so "the skeleton's includes resolve" is worth asserting.
  const refs = [];
  for (const rel of walkFiles(themeDir)) {
    if (!rel.endsWith(".html")) continue;
    const src = readFileSync(join(themeDir, rel), "utf8");
    for (const m of src.matchAll(/\{\{@(?:include|extends)\s+"([^"]+)"\s*\}\}/g)) {
      refs.push({ from: rel, name: m[1] });
    }
  }
  checkTruthy("the skeleton actually uses @include/@extends", refs.length >= 4);
  check("every @include/@extends target exists", refs.filter((r) => !existsSync(join(themeDir, "templates", `${r.name}.html`))), []);

  // Every child must close every section it opens.
  //
  // This is asserted on the *text* rather than only by rendering, because the
  // engine's failure mode here is silent: it tells a section definition from a
  // layout's slot by scanning ahead for `{{/section}}`, so an unclosed section
  // in a child reads as a slot, contributes nothing to `@sections`, and the
  // layout renders an empty `<main>` — HTTP 200, no exception. The skeleton
  // shipped exactly that bug and rendered blank. Checking the counts is the
  // cheap half; section 5 is the half that proves it through the real engine.
  const unclosed = [];
  for (const rel of walkFiles(themeDir)) {
    if (!rel.endsWith(".html")) continue;
    const src = readFileSync(join(themeDir, rel), "utf8");
    const opens = (src.match(/\{\{@section\s/g) ?? []).length;
    const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;
    const extendsSomething = /\{\{@extends\s/.test(src);
    // A layout has slots and no closer by design; a child must balance.
    if (extendsSomething && opens !== closes) unclosed.push(`${rel}: ${opens} open, ${closes} closed`);
    if (!extendsSomething && closes > 0) unclosed.push(`${rel}: closes ${closes} section(s) without @extends`);
  }
  check("every child closes every section it opens", unclosed, []);

  // -- 4. the real architecture rules accept it ----------------------------
  section("4. The real architecture rules accept the generated theme");
  // The documented acceptance criterion for this batch is "架构测试过". These are
  // the *same functions* `tests/suites/architecture.test.mjs` calls — not a copy, since
  // a copied rule is always the stale one.
  check("theme manifest rules report nothing", themeManifestProblems(SCRATCH), []);
  check("language-pack rules report nothing", langPackProblems(SCRATCH), []);

  // -- 5. every template renders through the real engine -------------------
  section("5. Every template renders through the real template engine");
  const loadTemplate = async (name) => {
    const abs = join(themeDir, "templates", `${name}.html`);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const baseScope = {
    site: { title: "Probe Theme", description: "A generated theme." },
    page: { title: "", description: "" },
    locale: "en",
    theme: { name: THEME, title: "Probe Theme", version: "0.1.0" },
    menu: { primary: [{ title: "Home", url: "/en" }] },
  };
  const post = {
    slug: "hello",
    title: "Hello World",
    excerpt: "The first entry.",
    created_at: 1700000000,
    url: "/en/blog/hello",
  };

  const home = await render("index.html", { ...baseScope, posts: [post] });
  checkTruthy("index inherits the layout (site header rendered)", home.includes("Probe Theme"));
  checkTruthy("index renders the primary menu", home.includes('href="/en"'));
  checkTruthy("index renders the post list", home.includes("Hello World") && home.includes("/en/blog/hello"));
  // `@first` is bound to the *iteration* scope, not to the item. Getting that
  // wrong is silent: the branch simply never renders.
  checkTruthy("index honours @first in the iteration scope", home.includes("Latest"));
  checkTruthy("index did not take the empty branch", !home.includes("Nothing published yet."));
  checkTruthy("no template syntax leaked into the output", !home.includes("{{"));

  const homeEmpty = await render("index.html", { ...baseScope, posts: [] });
  checkTruthy("index takes the empty branch with no posts", homeEmpty.includes("Nothing published yet."));

  const single = await render("single.html", { ...baseScope, page: { title: "Hello World" }, post: { ...post, html: "<p>Body</p>" } });
  checkTruthy("single renders the title", single.includes("Hello World"));
  // Triple braces: the engine escapes by default, and the body lives on the item
  // (`post.html`). Reading it from a bare `html` variable silently renders the
  // empty branch instead.
  checkTruthy("single emits the body unescaped", single.includes("<p>Body</p>"));
  checkTruthy("single does not take the empty branch", !single.includes("no body content"));

  const singleEmpty = await render("single.html", { ...baseScope, post: {} });
  checkTruthy("single takes the empty branch without a body", singleEmpty.includes("This entry has no body content."));

  const page = await render("page.html", { ...baseScope, page: { title: "About" }, post: { html: "<p>Hi</p>" } });
  checkTruthy("page renders its own copy", page.includes("About") && page.includes("<p>Hi</p>"));

  const notFound = await render("404.html", { ...baseScope });
  checkTruthy("404 renders", notFound.includes("Page not found"));

  // -- 6. language packs are namespaced ------------------------------------
  section("6. Language packs carry the owner prefix");
  const badKeys = [];
  for (const f of ["en.json", "zh-CN.json"]) {
    const dict = JSON.parse(readFileSync(join(themeDir, "langs", f), "utf8"));
    for (const k of Object.keys(dict)) if (!k.startsWith(`theme.${THEME}.`)) badKeys.push(`${f}: ${k}`);
  }
  check("every pack key is prefixed", badKeys, []);
  check("declared locales have packs", manifest.locales, ["en", "zh-CN"]);

  // -- 7. the generator refuses to clobber ---------------------------------
  section("7. Re-running refuses to overwrite");
  const io2 = makeIo();
  check("second run still exits 0", makeTheme([THEME, "--out", themesRoot], io2), 0);
  checkTruthy("second run left every file alone", /left alone/.test(io2.stdout));
  checkTruthy("second run wrote nothing", !/^  \+ /m.test(io2.stdout));

  const io3 = makeIo();
  check("--force exits 0", makeTheme([THEME, "--out", themesRoot, "--force"], io3), 0);
  checkTruthy("--force overwrites", /\+ theme\.json/.test(io3.stdout));

  // -- 8. bad input is refused before anything is written ------------------
  section("8. Invalid input is refused with an exit code");
  const ioBad = makeIo();
  check("a name with a space exits 2", makeTheme(["Bad Name", "--out", themesRoot], ioBad), 2);
  checkTruthy("the refusal explains the rule", /lowercase letters, digits/.test(ioBad.stderr));
  check("a one-character name exits 2", makeTheme(["x", "--out", themesRoot], makeIo()), 2);
  check("no positional argument exits 1", makeTheme([], makeIo()), 1);
  check("--help exits 0", makeTheme(["--help"], makeIo()), 0);

  // -- 9. make-plugin ------------------------------------------------------
  section("9. `make-plugin` emits an installable plugin");
  const ioP = makeIo();
  check("plugin generator exits 0", makePlugin([PLUGIN, "--out", pluginsRoot], ioP), 0);
  check("plugin file set", walkFiles(pluginDir), ["README.md", "plugin.json"]);

  const pluginManifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
  let pluginError = null;
  try {
    validateManifest(pluginManifest, "plugin");
  } catch (e) {
    pluginError = e?.message || String(e);
  }
  check("validateManifest accepts the plugin skeleton", pluginError, null);

  // A plugin ships no executable code: behaviour is *named*. A name the host
  // does not implement used to install, enable and report active while doing
  // nothing at all — the case above is what now catches it, through the real
  // validator, because the hook list lives in the contract.
  checkTruthy("the plugin names at least one hook", (pluginManifest.hooks ?? []).length > 0);
  checkTruthy(
    "the plugin asks for a settings screen, never a theme-table screen",
    (pluginManifest.adminMenus ?? []).every((m) => m.screen !== "table-list" && m.screen !== "table-edit")
  );
  // Inline packs, because a plugin zip is never unpacked — there is no directory
  // to read `langs/{locale}.json` from.
  checkTruthy(
    "inline pack keys carry the plugin prefix",
    Object.values(pluginManifest.langs ?? {}).every((dict) =>
      Object.keys(dict).every((k) => k.startsWith(`plugin.${PLUGIN}.`))
    )
  );

  // -- 10. make-table adds both halves -------------------------------------
  section("10. `make-table` adds the table *and* the menu that opens it");
  const ioPrint = makeIo();
  check("printing the snippet exits 0", makeTable([THEME, "product", "--out", themesRoot], ioPrint), 0);
  checkTruthy("the snippet shows both halves", /"tables"/.test(ioPrint.stdout) && /"adminMenus"/.test(ioPrint.stdout));
  checkTruthy("the snippet is indented, not collapsed onto one line", /\n\s+"name": "product"/.test(ioPrint.stdout));
  check("printing does not touch theme.json", JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")).tables, undefined);

  const ioT = makeIo();
  check(
    "--write exits 0",
    makeTable([THEME, "product", "--fields", "name:text,price:number,sku:text", "--write", "--out", themesRoot], ioT),
    0
  );
  const withTable = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
  check("table was added", withTable.tables.map((t) => t.name), ["product"]);
  check("menu was added", withTable.adminMenus.map((m) => m.id), ["product-list"]);
  check("fields were parsed", withTable.tables[0].fields.map((f) => `${f.key}:${f.type}`), ["name:text", "price:number", "sku:text"]);

  // The pair must agree: the menu's `args.table` has to name the declared table,
  // or the install fails with "references table X which is not declared" — the
  // exact half-right state the command exists to prevent.
  const declaredTables = withTable.tables.map((t) => t.name);
  check(
    "the generated menu points at the generated table",
    withTable.adminMenus.every((m) => !m.args?.table || declaredTables.includes(m.args.table)),
    true
  );
  // The default rule is deliberately blunt: every `text`/`longtext` field is
  // translatable, everything else is not. So `sku` *is* included here — it was
  // declared `type: "text"`. Sharpening that would mean the generator guessing
  // which text fields are identifiers, and a guess that is sometimes wrong is
  // worse than a rule that is always predictable. `--translatable` is the way
  // out, and it is exercised positively below.
  check("text fields default to translatable, numbers do not", withTable.tables[0].translatable, ["name", "sku"]);

  // The generator's default must satisfy the *validator's* multi-language rule,
  // or `make-table` would hand you a manifest that fails to install. Run the
  // real validator over the real generated manifest rather than asserting the
  // shape of `translatable` a second time — the point is that the two agree,
  // and only running both can show that.
  {
    const genManifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
    let genError = null;
    try {
      validateManifest(genManifest, "theme");
    } catch (e) {
      genError = e?.message ?? String(e);
    }
    check(
      "the generated manifest passes the real validator's multi-language rule",
      genError,
      null
    );
    // And state the rule it satisfied, so a regression is legible. Compared as
    // sets (sorted), not `every()`: `every()` is vacuously true on an empty
    // `prose`, so a generator that stopped emitting prose fields at all would
    // still report green.
    const t0 = genManifest.tables[0];
    const prose = t0.fields.filter((f) => isProseFieldType(f.type)).map((f) => f.key).sort();
    checkTruthy("the generator did emit at least one prose field", prose.length > 0);
    check(
      "every prose field it generated is translatable",
      prose.filter((k) => !t0.translatable.includes(k)),
      []
    );
  }

  let tableError = null;
  try {
    validateManifest(withTable, "theme");
  } catch (e) {
    tableError = e?.message || String(e);
  }
  check("the manifest with a table still validates", tableError, null);
  check("the architecture rules still accept it", themeManifestProblems(SCRATCH), []);

  check("a duplicate table exits 2", makeTable([THEME, "product", "--write", "--out", themesRoot], makeIo()), 2);

  const ioR = makeIo();
  check("a reserved column name exits 2", makeTable([THEME, "order", "--fields", "site_id:text", "--write", "--out", themesRoot], ioR), 2);
  checkTruthy("the refusal names the reserved set", /reserved column/.test(ioR.stderr));
  check("a bad field type exits 2", makeTable([THEME, "order", "--fields", "ref:reference", "--write", "--out", themesRoot], makeIo()), 2);
  check("--translatable naming no field exits 2", makeTable([THEME, "order", "--fields", "a:text", "--translatable", "b", "--write", "--out", themesRoot], makeIo()), 2);
  check("a one-character table name exits 2", makeTable([THEME, "t", "--write", "--out", themesRoot], makeIo()), 2);

  // `--translatable` was only ever exercised on its rejection path, which means
  // a generator that ignored the flag entirely would still have passed. A second
  // theme gives it a table to write into without tripping the duplicate check.
  const THEME2 = "probe-override";
  check("a second theme generates", makeTheme([THEME2, "--out", themesRoot], makeIo()), 0);
  check(
    "explicit --translatable exits 0",
    makeTable(
      [THEME2, "product", "--fields", "name:text,sku:text,price:number", "--translatable", "name", "--write", "--out", themesRoot],
      makeIo()
    ),
    0
  );
  const overridden = JSON.parse(readFileSync(join(themesRoot, THEME2, "theme.json"), "utf8"));
  check("--translatable replaces the default set", overridden.tables[0].translatable, ["name"]);

  // A route is *not* what this command adds, but the table it declares must be
  // resolvable from one — that pairing is what makes a declared table reachable
  // on the front end (§3.2.2).
  const withRoute = {
    ...withTable,
    templates: [...withTable.templates, "archive-product"],
    routes: [{ path: "/shop", template: "archive-product", resolve: { table: "product" }, query: { as: "products" } }],
  };
  let routeError = null;
  try {
    validateManifest(withRoute, "theme");
  } catch (e) {
    routeError = e?.message || String(e);
  }
  check("a route may resolve the generated table", routeError, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  return fail === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a parseable summary, and it must say it
  // failed. Without this the reverse-validation tool reads "no summary" as
  // "could not tell", which is never a pass (AGENTS.md false green type 6).
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  code = 2;
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
