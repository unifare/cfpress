/**
 * `npm run make:theme -- my-shop` — generate a theme skeleton.
 * ARCHITECTURE.md §5.5 (defence four: start from a shape that is already right).
 *
 * ## Why this exists
 *
 * A theme is a pile of conventions: which files the resolver looks for, how a
 * layout hands a slot to a page, how a helper is called, what a language-pack
 * key must be prefixed with. None of them are discoverable from a blank file,
 * and every one of them fails *quietly* — a template with `{{len posts}}`
 * renders an empty page rather than raising, and a pack key without its prefix
 * only shows up as a test failure later.
 *
 * So the generator emits a theme that is already correct, and the author edits
 * *content*. Everything the skeleton ships is checked by
 * `tests/suites/scaffold.test.mjs` against the real validator and the real template
 * engine, so "the skeleton is valid" is not a claim, it is a test.
 *
 * ## What it deliberately does NOT ship
 *
 * No `tables[]` and no `adminMenus`. A generated theme has no business logic,
 * so declaring a table would produce a table nobody writes to. Use
 * `npm run make:table -- <theme> <table>` when there is a real one — that
 * command adds both halves (`tables[]` *and* the menu that opens it), because
 * declaring one without the other is the mistake it exists to prevent.
 */
import { join } from "node:path";
import {
  CliError, ROOT, assertName, isMain, parseArgs, report, titleCase, writeTree,
} from "./_scaffold.mjs";

const HELP = `
Usage: npm run make:theme -- <name> [options]

  <name>            theme name, e.g. my-shop (lowercase, 2-64 chars)
  --out <dir>       where to create it (default: themes/)
  --force           overwrite files that already exist
  --title "..."     display title (default: derived from the name)
`;

/**
 * The layout every other template extends.
 *
 * `{{@section "content"}}` is where a page's body lands. The CSS is inlined
 * rather than linked on purpose: a theme is uploaded as a set of files and
 * served from R2, and an external stylesheet would be a second request whose
 * path depends on the version prefix.
 */
const layout = `<!doctype html>
<html lang="{{locale}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{#if page.title}}{{page.title}}{{#if site.title}} | {{site.title}}{{/if}}{{else}}{{site.title}}{{/if}}</title>
{{#if page.description}}<meta name="description" content="{{page.description}}">{{/if}}
<style>
  :root{--ink:#1c1a17;--muted:#6b655c;--line:#e3ded4;--bg:#fdfcfa;--accent:#8a5a2b}
  @media (prefers-color-scheme:dark){:root{--ink:#efece6;--muted:#a09a90;--line:#332f29;--bg:#161513;--accent:#d8a86a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:44rem;margin:0 auto;padding:0 1.25rem}
  a{color:inherit}
  header.site{border-bottom:1px solid var(--line)}
  header.site .wrap{display:flex;align-items:baseline;gap:1.5rem;padding-block:1.1rem;flex-wrap:wrap}
  .brand{font-weight:700;text-decoration:none;letter-spacing:-.01em}
  nav.primary{display:flex;gap:1rem;font-size:.94rem}
  nav.primary a{color:var(--muted);text-decoration:none}
  nav.primary a:hover{color:var(--accent)}
  main{padding-block:2.5rem 4rem}
  h1{font-size:clamp(1.7rem,4vw,2.4rem);line-height:1.15;margin:0 0 .6rem;letter-spacing:-.02em}
  .lede{color:var(--muted);font-size:1.05rem;margin:0 0 2rem}
  ul.posts{list-style:none;margin:0;padding:0;display:grid;gap:1.6rem}
  ul.posts h2{font-size:1.2rem;margin:0 0 .3rem}
  ul.posts h2 a{text-decoration:none}
  ul.posts h2 a:hover{text-decoration:underline}
  ul.posts p{margin:0;color:var(--muted);font-size:.95rem}
  .meta{color:var(--muted);font-size:.85rem;margin-top:.4rem}
  article.post :is(h2,h3){margin-top:2rem}
  article.post img{max-width:100%;height:auto}
  footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}
  footer.site .wrap{padding-block:1.5rem}
  .empty{color:var(--muted);font-style:italic}
</style>
</head>
<body>
{{@include "parts/header"}}
<main class="wrap">
{{@section "content"}}
</main>
{{@include "parts/footer"}}
</body>
</html>
`;

/**
 * Note the three spellings that trip people up and are therefore demonstrated
 * here rather than described: `{{len(posts)}}` with parentheses (a helper
 * called with spaces raises and takes the whole page down), `{{@first}}`
 * bound to the *iteration* scope rather than to the item, and — the one that
 * costs the most to discover — **`{{/section}}` is mandatory**.
 *
 * The engine tells a section *definition* from a layout's section *slot* by
 * scanning ahead for a matching `{{/section}}`. A child whose section is never
 * closed therefore reads as a slot, contributes nothing to `@sections`, and the
 * layout renders its slot empty: HTTP 200, no error, a blank page. Closing it
 * is not a style preference.
 */
const indexTpl = `{{@extends "parts/layout"}}
{{@section "content"}}

<h1>{{site.title}}</h1>
{{#if site.description}}<p class="lede">{{site.description}}</p>{{/if}}

{{#if posts}}
  <ul class="posts">
    {{#each posts as post}}
      <li>
        {{#if @first}}<span class="meta">Latest</span>{{/if}}
        <h2><a href="{{post.url}}">{{post.title}}</a></h2>
        {{#if post.excerpt}}<p>{{truncate(post.excerpt, 160)}}</p>{{/if}}
        {{#if post.created_at}}<p class="meta">{{date(post.created_at)}}</p>{{/if}}
      </li>
    {{/each}}
  </ul>
{{else}}
  <p class="empty">Nothing published yet.</p>
{{/if}}

{{/section}}
`;

/**
 * Two things are demonstrated here rather than described, because both fail
 * silently:
 *
 *   `{{len(posts)}}` — a helper is called with parentheses. `{{len posts}}`
 *   raises "Trailing tokens" and takes the whole page down to a bare shell.
 *
 *   `{{{post.html}}}` — triple braces, because the engine escapes by default.
 *   The body lives on the *item* (`post.html`), not in a bare `html` variable;
 *   reading it from the wrong place renders the empty branch with no error.
 */
const singleTpl = `{{@extends "parts/layout"}}
{{@section "content"}}

<article class="post">
  <h1>{{page.title}}</h1>
  {{#if post.created_at}}<p class="meta">{{date(post.created_at)}}</p>{{/if}}
  {{#if post.html}}{{{post.html}}}{{else}}<p class="empty">This entry has no body content.</p>{{/if}}
</article>

{{/section}}
`;

const pageTpl = `{{@extends "parts/layout"}}
{{@section "content"}}

<article class="post">
  <h1>{{page.title}}</h1>
  {{#if post.html}}{{{post.html}}}{{else}}<p class="empty">This page has no body content.</p>{{/if}}
</article>

{{/section}}
`;

const notFoundTpl = `{{@extends "parts/layout"}}
{{@section "content"}}

<h1>Page not found</h1>
<p class="lede">That address does not exist on this site.</p>
<p><a href="/{{locale}}">Back to the front page</a></p>

{{/section}}
`;

const headerTpl = `<header class="site">
  <div class="wrap">
    <a class="brand" href="/{{locale}}">{{site.title}}</a>
    <nav class="primary">
      {{#each menu.primary as item}}<a href="{{item.url}}">{{item.title}}</a>{{/each}}
    </nav>
  </div>
</header>
`;

const footerTpl = `<footer class="site">
  <div class="wrap">
    <span>{{theme.title}} v{{theme.version}}</span>
  </div>
</footer>
`;

/**
 * Language packs, layer ③ of the *interface* dictionary.
 *
 * Read that twice, because it is the most commonly misunderstood part of this
 * platform: these packs translate the **admin's** wording, not front-end copy.
 * A template has no `t()` helper — front-end text is either written into the
 * template or is content. So the keys below are named after this theme's admin
 * surface, and the prefix (`theme.<name>.`) is the part that actually matters:
 * two extensions defining the same unnamespaced key would overwrite each other
 * with the winner decided by load order.
 */
const packEn = (n, t) => ({
  [`theme.${n}.admin.title`]: t,
  [`theme.${n}.admin.description`]: "Appearance and settings for this theme.",
});

const packZh = (n, t) => ({
  [`theme.${n}.admin.title`]: t,
  [`theme.${n}.admin.description`]: "该主题的外观与设置。",
});

/**
 * The whole theme, as data.
 *
 * Separated from the CLI so `tests/suites/scaffold.test.mjs` can assert on the emitted
 * content without running a process — this environment cannot spawn one at all.
 * The manifest and the file tree are the part that can be *wrong*; writing them
 * to disk is the part that cannot.
 */
export function themeFiles({ name, title }) {
  const manifest = {
    name,
    title,
    version: "0.1.0",
    author: "",
    description: `${title} — a CFPress theme. Edit this before shipping.`,
    supports: ["blocks", "menus", "widgets"],
    templates: ["index", "single", "page", "404"],
    parts: ["layout", "header", "footer"],
    // Declares which languages this theme ships packs for. The architecture test
    // checks it against `langs/` so "declared but not shipped" fails loudly.
    locales: ["en", "zh-CN"],
    settings: [
      { key: "tagline", label: "Tagline", type: "text", default: title },
      { key: "showDates", label: "Show dates", type: "boolean", default: "true" },
    ],
  };

  const files = {
    "theme.json": JSON.stringify(manifest, null, 2) + "\n",
    "templates/parts/layout.html": layout,
    "templates/parts/header.html": headerTpl,
    "templates/parts/footer.html": footerTpl,
    "templates/index.html": indexTpl,
    "templates/single.html": singleTpl,
    "templates/page.html": pageTpl,
    "templates/404.html": notFoundTpl,
    "langs/en.json": JSON.stringify(packEn(name, title), null, 2) + "\n",
    "langs/zh-CN.json": JSON.stringify(packZh(name, title), null, 2) + "\n",
  };

  return { manifest, files };
}

export function main(argv, io = console) {
  try {
    const args = parseArgs(argv);
    // Asking for help is a *successful* request, so it exits 0 and prints to
    // stdout. Forgetting the argument is a usage error, so it exits 1 and
    // prints to stderr — a script that pipes the output of a bare invocation
    // must not see help text on stdout.
    if (args.help || args.h) {
      io.log(HELP.trim());
      return 0;
    }
    if (!args._.length) {
      io.error(HELP.trim());
      return 1;
    }

    const name = assertName(args._[0], "theme");
    const title = String(args.title || titleCase(name));
    const outRoot = String(args.out || join(ROOT, "content", "themes"));
    const dir = join(outRoot, name);

    const { files } = themeFiles({ name, title });
    const result = writeTree(dir, files, { force: !!args.force });

    report("theme", name, dir, result, [
      `Activate it:  curl -X POST "$BASE/api/v1/extensions/themes/${name}/activate?site=default" -b cookies.txt`,
      `Render it:    open $BASE/en`,
      `Add a table:  npm run make:table -- ${name} product`,
      "",
      "Front-end text lives in the templates; `langs/` is for the admin's wording.",
      "Declared templates must exist as files — the resolver looks for exactly these names.",
    ], io);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.error(`\n  error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
