/**
 * Every bundled front-end theme, validated end to end.
 *
 * ## Why this suite exists
 *
 * `theme-default.test.mjs` renders one theme — and it hard-codes
 * `content/themes/default/`. `theme-fixture.test.mjs` renders the mechanism
 * fixture. That left a hole the repository had already been bitten by: **a
 * second bundled theme had no guard watching it at all.** `architecture.test.mjs`
 * notices a new `content/themes/*` directory must be in `BUNDLED_THEMES`
 * (rule 66), and `_extension-rules.mjs` checks the manifest and the language
 * packs — but *nothing rendered its templates*. A missing `{{/section}}`, a
 * helper written `{{truncate x 20}}` (helpers are `f(a,b)` only), an
 * `{{#each post.meta.tags}}` over what is really a comma-joined **string** —
 * every one of those degrades to a styled 200 with the content silently gone.
 * The manifest validator, the architecture rules and the CSP all pass.
 *
 * This is ARCHITECTURE §12's core lesson: *"I tend to check the words I wrote
 * rather than what actually happened."* The earlier suites checked the words
 * ("a theme exists") rather than what happened ("its templates produce a page
 * with the article in it"). So this suite walks **the real `BUNDLED_THEMES`
 * list** and renders every declared template of every theme through the real
 * engine, with a realistic scope plus the degraded scopes a live site reaches
 * that a happy path never does (no posts, no menu, no member, no description).
 *
 * ## Why the theme list is imported rather than written out
 *
 * A hand-written list is a list someone forgets to update. Importing
 * `BUNDLED_THEMES` means adding a theme to the distribution set *automatically*
 * adds it to this suite, in the same commit, with no second place to remember.
 * The non-vacuity assertion at the top ("the list is not empty", "every theme
 * directory declared as bundled actually exists on disk") is what keeps the
 * import honest — an import of an empty array would otherwise render zero
 * themes and pass.
 *
 * ## What is asserted per theme, and why each one can fail silently
 *
 *   - the template set renders, in both the populated and the empty scope
 *   - `{{{post.html}}}` is not escaped (`{{post.html}}` shows `<p>` tags)
 *   - no `{{` survives and no literal `undefined` appears (a scope key the
 *     theme invented, spelled camelCase, or asked for on the wrong branch)
 *   - every `theme.strings.*` key the markup references exists in **both**
 *     packs (a miss renders the English literal on the Chinese site)
 *   - the two packs cover the same key set (a switch silently reverts to
 *     English for the forgotten keys)
 *   - the head carries a canonical feed link only when it has an origin
 *
 * Usage: node tests/suites/theme-bundled.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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
    console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t) { console.log(`\n${t}`); }

async function bundle(entry, outName) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true, format: "esm", target: "es2022", write: false, platform: "neutral", logLevel: "silent",
  });
  const dir = join(root, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, outName);
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

/**
 * Nest a theme pack the way `buildScope` does, so the templates render against
 * the real dictionary. A flat `{ "theme.x.y": "…" }` object would make every
 * `{{default(theme.strings.x.y, "English")}}` miss and fall back to the
 * literal — the test would pass while the site showed English.
 */
function nest(messages, name) {
  const prefix = `theme.${name}.`;
  const out = {};
  for (const [k, v] of Object.entries(messages)) {
    if (!k.startsWith(prefix)) continue;
    const parts = k.slice(prefix.length).split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {});
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}
const lookup = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * A post shaped the way the runtime projects it — **snake_case**, because that
 * is what every theme in this repository reads (`post.reading_time`,
 * `page.document_title`). This is deliberate: the historical false green this
 * suite exists to prevent was a fixture that hand-wrote `display_name` for the
 * *member* scope while the runtime handed templates a camelCase `displayName`,
 * so `{{member.display_name}}` rendered empty on the live site and the suite
 * stayed green. A fixture that invents a shape the runtime never produces is
 * worse than no fixture. See `src/platform/members.ts` → `memberScope()`.
 */
const cover = "https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=1200";
function makePost() {
  return {
    id: "post_1", slug: "hello", type: "post", title: "在信息过载的时代重新学会深度阅读",
    excerpt: "一份独立中文博客：设计、技术与生活方式的长文章。",
    html: "<h2>工具越强，品味越贵</h2><p>正文段落。</p><blockquote>引用。</blockquote><pre><code>const x = 1;</code></pre>",
    reading_time: "12 分钟阅读", date_display: "2026年10月8日", created_at: 1791433031,
    cover, meta: { category: "设计", tags: "长阅读,设计系统" }, url: "/zh-CN/blog/hello",
  };
}

/**
 * The scope every theme is rendered against. Named the way `buildScope` names
 * it — `site`, `page`, `locale`, `locales`, `theme.strings`, `menu`, `member`
 * — so a theme that reads `scope.site.title` gets the site title, exactly as it
 * would in production. Keys a theme invents show up as a literal `undefined` in
 * the output and are caught by the invariant below.
 *
 * `lang_nav` / `lang_current` are populated with a **multilingual** site on
 * purpose. Left empty they are the shape a monolingual site produces, and the
 * language switcher is behind `{{#if lang_nav}}` — so an empty fixture renders
 * the trigger never, and any assertion about the switcher passes by vacuously
 * finding nothing. The dropdown is the one control whose whole absence is
 * itself a valid render, which makes an empty fixture the wrong default.
 *
 * The current language is deliberately **not first**. A fixture whose
 * `current: true` sits at index 0 makes `find(current)` and `[0]` agree, so a
 * scope that picks the wrong entry passes every assertion about the trigger —
 * the fixture's ordering coincidence, not the code, decides the outcome.
 * Three languages with the rendered one in the middle removes the coincidence:
 * `lang_current` must be the *matching* entry, and position cannot stand in
 * for the match. (`over.lang_nav` still lets a caller force a layout.)
 */
function makeScope(themeName, title, pack, over = {}) {
  const post = makePost();
  const langNav = [
    { code: "en", name: "English", current: false, url: "/en" },
    { code: "zh-CN", name: "简体中文", current: true, url: "/zh-CN" },
    { code: "ja", name: "日本語", current: false, url: "/ja" },
  ];
  return {
    site: { title, description: "一份独立中文博客。", robots: "index,follow", locale: "zh-CN", url: "https://theme.example" },
    page: { title, description: "一份独立中文博客。", path: "/zh-CN", kind: "home", document_title: title },
    locale: "zh-CN",
    locales: [{ code: "zh-CN", name: "简体中文", is_default: true }],
    theme: { name: themeName, title, version: "1.0.0", strings: pack },
    menu: { primary: [], primary_html: "", header: [], header_html: "" },
    widgets: { sidebar: [], sidebar_html: "", footer: [], footer_html: "" },
    post: null,
    member: null,
    posts: [post],
    my_posts: [],
    // The request's query, flattened — what a form reads back to show why a
    // submission failed (`?error=`). Present-but-empty is the production shape
    // for a GET; a fixture that omitted it would let a template print a literal
    // `undefined` and still pass `everyPageChecks` only by luck of the guard.
    query: {},
    // The member's own post being edited, or null. `buildScope` derives it from
    // `my_posts` (one reader, two views); the fixture keeps them consistent.
    edit_post: null,
    lang_nav: langNav,
    lang_current: langNav.find((l) => l.current),
    ...over,
  };
}

/**
 * The invariants that hold for every rendered theme page, populated or not.
 *
 * `isPart` drops the `<html>` requirement: a fragment under `templates/parts/`
 * is included *into* a page, so rendering it standalone legitimately produces
 * no document shell. Requiring one there would fail correct markup — and a
 * guard that fails correct markup gets weakened, which is worse than a gap.
 * The other two invariants still apply to a fragment: leftover `{{` means the
 * parser choked, and a literal `undefined` means a scope read missed.
 */
function everyPageChecks(html, isPart = false) {
  const problems = [];
  if (!isPart && !html.includes("<html")) problems.push("shell did not render (an unclosed {{@section}}?)");
  if (html.includes("{{")) problems.push("unresolved template syntax leaked");
  if (html.includes("undefined")) problems.push("output contains undefined");
  return problems;
}

async function checkTheme(themeName, validateManifest, renderTemplateSource) {
  section(`── theme: ${themeName} ──────────────────────────────────────────`);
  const themeDir = join(root, "content", "themes", themeName);
  const read = (p) => readFileSync(join(themeDir, p), "utf8");

  // -- 1. install boundary -------------------------------------------------
  const manifest = JSON.parse(read("theme.json"));
  let error = null;
  try {
    const v = validateManifest(manifest, "theme");
    check(`${themeName}: the validator normalises the manifest`, v.name, themeName);
  } catch (e) { error = e.message; }
  check(`${themeName}: validateManifest does not throw`, error, null);
  check(
    `${themeName}: every declared template is shipped`,
    themeManifestProblems(root).filter((p) => p.includes(`/themes/${themeName}/`)),
    []
  );
  check(
    `${themeName}: language packs are namespaced`,
    langPackProblems(root).filter((p) => p.includes(`/themes/${themeName}/`)),
    []
  );
  // Declared locales must ship a pack — otherwise the "Chinese version" is the
  // English literal, visible on the site and invisible everywhere else.
  check(
    `${themeName}: every declared locale ships a language pack`,
    themeManifestProblems(root).filter((p) => p.includes(`/themes/${themeName}/`) && p.includes("declares locale")),
    []
  );

  const declaredLocales = manifest.locales || [];
  checkTruthy(`${themeName}: the manifest declares its locales`, declaredLocales.length > 0, JSON.stringify(declaredLocales));
  const packs = {};
  for (const code of declaredLocales) {
    const p = join(themeDir, "langs", `${code}.json`);
    checkTruthy(`${themeName}: langs/${code}.json exists`, existsSync(p));
    if (existsSync(p)) packs[code] = JSON.parse(read(`langs/${code}.json`));
  }

  // -- 2. every declared template renders ---------------------------------
  const loadTemplate = async (name) => {
    for (const p of [join(themeDir, "templates", `${name}.html`), join(themeDir, "templates", "parts", `${name}.html`)]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const zh = packs["zh-CN"] ? nest(packs["zh-CN"], themeName) : {};
  const title = manifest.title || themeName;
  const post = makePost();

  // Every template the manifest declares must at least be renderable. The
  // concrete scope differs per kind, so this only asserts the shell survives —
  // a template that throws takes the whole theme down, which is the loudest
  // failure a site can have and the one a manifest check cannot see.
  const declared = manifest.templates || [];
  const scopeFor = (tpl) => {
    if (tpl === "single") return makeScope(themeName, title, zh, {
      post, page: { title: post.title, kind: "single", document_title: `${post.title} · ${title}`, path: post.url },
    });
    if (tpl === "page") return makeScope(themeName, title, zh, {
      post: { ...post, reading_time: "", date_display: "", cover: "" },
      page: { title: post.title, kind: "page", document_title: post.title, path: post.url },
    });
    if (tpl === "404") return makeScope(themeName, title, zh, {
      page: { title: "Not Found", kind: "404", document_title: `Not Found · ${title}`, path: "/zh-CN/nope" },
      posts: [],
    });
    return makeScope(themeName, title, zh);
  };
  const rendered = {};
  for (const tpl of declared) {
    const file = `${tpl}.html`;
    checkTruthy(`${themeName}: templates/${file} exists`, existsSync(join(themeDir, "templates", file)));
    if (!existsSync(join(themeDir, "templates", file))) continue;
    try {
      rendered[tpl] = await render(file, scopeFor(tpl));
    } catch (e) {
      rendered[tpl] = null;
      failures.push(`${themeName}: ${file} threw`);
      fail++;
      console.log(`  FAIL ${themeName}: ${file} threw\n       ${e.message}`);
      continue;
    }
    check(`${themeName}: ${file} renders clean`, everyPageChecks(rendered[tpl]), []);
  }

  // -- 3. the empty / degraded scopes --------------------------------------
  // A live site reaches these: a brand-new install has no posts, an unset menu
  // renders as `[]`, a visitor is signed out. A theme that only ever saw the
  // happy scope ships an empty-state page nobody tested.
  for (const tpl of declared) {
    if (!existsSync(join(themeDir, "templates", `${tpl}.html`))) continue;
    const empty = scopeFor(tpl);
    empty.posts = [];
    empty.post = tpl === "single" || tpl === "page" ? null : empty.post;
    empty.menu = {};
    empty.widgets = {};
    try {
      check(`${themeName}: ${tpl}.html renders clean when empty`, everyPageChecks(await render(`${tpl}.html`, empty)), []);
    } catch (e) {
      fail++; failures.push(`${themeName}: ${tpl}.html (empty) threw`);
      console.log(`  FAIL ${themeName}: ${tpl}.html (empty) threw\n       ${e.message}`);
    }
  }

  // -- 4. article HTML is not escaped --------------------------------------
  if (rendered.single) {
    checkTruthy(`${themeName}: prose markup survives ({{{post.html}}})`, rendered.single.includes("<blockquote>引用。</blockquote>"),
      "a single-brace {{post.html}} escapes the article into visible <p> tags");
    checkTruthy(`${themeName}: no escaped paragraph tags`, !rendered.single.includes("&lt;p&gt;"));
    checkTruthy(`${themeName}: the article title is printed`, rendered.single.includes("在信息过载的时代重新学会深度阅读"));
  }

  // -- 5. the member branch renders in BOTH states -------------------------
  // The member scope is the one scope whose shape the runtime *projects*
  // (rule 77 / `memberScope()`), so it is exactly where a camelCase/snake_case
  // mismatch hides. It is also where a first draft of this suite produced a
  // **dead guard**: it iterated `declared` templates only. The header — the
  // very file that shipped a blank member name — is a *part*, so it was never a
  // render target; it only appeared included inside other templates, and
  // `includes("Bob")` on those was satisfied by the login/account pages. The
  // injection that restored the real defect (`member.display_name` →
  // `member.displayName` in `parts/header.html`) left this suite at 100/0.
  //
  // So: scan templates **and** parts, render each one that reads `member` as a
  // first-class target, and assert the reader's name appears. Rendering a part
  // standalone is legitimate here — `{{member.display_name}}` resolves against
  // the scope whether the markup is a page or a fragment of one.
  const allFiles = [];
  for (const dir of ["templates", "templates/parts"]) {
    const d = join(themeDir, dir);
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".html")) allFiles.push({ rel: `${dir}/${e.name}`, name: e.name.slice(0, -5), part: dir.endsWith("parts") });
    }
  }
  // Two distinct predicates, because they mean different things:
  //
  //   `{{#if member}}`     — branches on whether someone is signed in. The file
  //                          must render in both states, but it need not print
  //                          a name (the footer only swaps a link).
  //   `{{member.<field>}}` — actually reads the projected scope. THIS is where
  //                          a field's spelling matters, so this is where the
  //                          "names the reader" assertion belongs.
  //
  // A first draft used `.includes("member")`, which matched `.member-chip` in
  // the stylesheet and `{{#if member}}` in the footer — appearance, not
  // consumption (铁律 3b). It produced two false failures on correct markup.
  const BRANCH_RE = /\{\{#(?:if|unless)\s+member\b/;
  const FIELD_RE = /\{\{[^}]*\bmember\.[a-z_]/;
  const branchReaders = allFiles.filter((f) => BRANCH_RE.test(readFileSync(join(themeDir, f.rel), "utf8")));
  const fieldReaders = allFiles.filter((f) => FIELD_RE.test(readFileSync(join(themeDir, f.rel), "utf8")));
  checkTruthy(`${themeName}: at least one file branches on the member scope`, branchReaders.length > 0,
    `scanned ${allFiles.map((f) => f.rel).join(", ")}`);

  const signedInScope = () => makeScope(themeName, title, zh, {
    member: { id: "mem_1", username: "bob", display_name: "Bob", name: "Bob", email: "bob@example.com", role: "member", status: "active" },
  });
  const renderStandalone = async (f, scope) => {
    const s = { ...scope };
    if (f.name === "single" || f.name === "page") s.post = post;
    return renderTemplateSource(readFileSync(join(themeDir, f.rel), "utf8"), s, { loadTemplate });
  };

  for (const f of branchReaders) {
    try {
      check(`${themeName}: ${f.rel} renders clean signed in`, everyPageChecks(await renderStandalone(f, signedInScope()), f.part), []);
    } catch (e) {
      fail++; failures.push(`${themeName}: ${f.rel} (signed in) threw`);
      console.log(`  FAIL ${themeName}: ${f.rel} (signed in) threw\n       ${e.message}`);
    }
  }
  for (const f of fieldReaders) {
    try {
      const html = await renderStandalone(f, signedInScope());
      check(`${themeName}: ${f.rel} renders clean signed in`, everyPageChecks(html, f.part), []);
      // This file reads a `member.<field>`, so whatever it prints must not be a
      // blank. If `member.display_name` resolves to undefined the page renders
      // silently empty — the production symptom was an empty chip in the
      // header. Asserting the literal is what makes that loud.
      checkTruthy(`${themeName}: ${f.rel} names the signed-in reader`, html.includes("Bob"),
        "a {{member.<field>}} read resolved empty — check the scope projection (memberScope) or the field's spelling (snake_case, not camelCase)");
    } catch (e) {
      fail++; failures.push(`${themeName}: ${f.rel} (signed in) threw`);
      console.log(`  FAIL ${themeName}: ${f.rel} (signed in) threw\n       ${e.message}`);
    }
  }

  // -- 5b. the language switcher renders as a dropdown ----------------------
  // `{{#if lang_nav}}` guards the whole control, and a monolingual site has no
  // `lang_nav` — so **deleting the dropdown leaves the suite green**. That is
  // the vacuous-check shape (§12 #3: a check over an empty set checks nothing),
  // and it is why `makeScope` seeds a bilingual `lang_nav` above: without it,
  // every assertion below would pass by finding nothing.
  //
  // The switch from a row of flat links to a `<details>` menu is what these
  // pin. Three things make it a *dropdown* rather than links again, and each is
  // separately checkable:
  //
  //   - the trigger is `<summary>` and labels itself with the **current
  //     language's name** (`{{lang_current.name}}`) — not a raw code. A reader
  //     picking a language should not have to decode `zh-CN`, and a template
  //     cannot look the current entry up, so a missing `lang_current` renders
  //     an empty trigger, silently.
  //
  //     This must be read **inside the `<summary>`**, not from the page. The
  //     menu below the trigger lists every language by name, so a
  //     whole-document `includes("简体中文")` stays green when the trigger is
  //     switched to `{{lang_current.code}}` — the menu's own row supplies the
  //     name. That is the "anchor on the mention, not the consumer" shape
  //     (§12 #16, rules 69/78/79), and it was this assertion's first version:
  //     it reported `went red` on an unrelated line and would have pinned
  //     nothing. `triggerText` below is the actual consumer.
  //   - the entries are inside the menu, so they are NOT visible until opened.
  //   - the control is not a flat `<nav class="lang-nav">` any more.
  const langReaders = allFiles.filter((f) => /\{\{#if\s+lang_nav\b/.test(readFileSync(join(themeDir, f.rel), "utf8")));
  checkTruthy(`${themeName}: at least one file renders the language switcher`, langReaders.length > 0,
    `scanned ${allFiles.map((f) => f.rel).join(", ")}`);
  // The trigger's own text: everything between `<summary …>` and `</summary>`,
  // with tags (the globe / caret icons) stripped. Both templates put the label
  // in a `<span>` next to an inline SVG, so "strip tags, then read" is what the
  // reader sees; matching the raw `<summary>` substring would also accept
  // markup that renders nothing.
  const triggerText = (html) => {
    const m = html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    return m ? m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
  };
  for (const f of langReaders) {
    try {
      const html = await renderStandalone(f, makeScope(themeName, title, zh));
      check(`${themeName}: ${f.rel} renders clean with a switcher`, everyPageChecks(html, f.part), []);
      checkTruthy(`${themeName}: ${f.rel} opens the switcher as a <details> menu`, html.includes("<details") && html.includes("<summary"),
        "the switcher is not a <details>/<summary> dropdown");
      const trig = triggerText(html);
      checkTruthy(`${themeName}: ${f.rel} labels the trigger with the current language's name`,
        trig.includes("简体中文") && !/\bzh-CN\b/.test(trig),
        `the trigger reads "${trig}" — a {{lang_current.name}} read must resolve to the name, not a raw code`);
      checkTruthy(`${themeName}: ${f.rel} lists every language, not just the current one`, html.includes("English"),
        "the menu must offer the other languages as well as the current one");
      // The old flat row is the shape being replaced; if it comes back, the
      // "dropdown" is a row of pills wearing a menu's name.
      checkTruthy(`${themeName}: ${f.rel} does not render the languages as a flat nav row`, !html.includes('class="lang-nav"'),
        "the switcher regressed to a flat row of links");
    } catch (e) {
      fail++; failures.push(`${themeName}: ${f.rel} (switcher) threw`);
      console.log(`  FAIL ${themeName}: ${f.rel} (switcher) threw\n       ${e.message}`);
    }
  }

  // -- 5c. the member's write surface is plain forms -----------------------
  // The member surface is the one part of a theme that **writes**, and it is
  // rendered as HTML a browser submits with no script at all. Three things
  // about that are load-bearing, and every one of them fails quietly:
  //
  //   - the form posts to the front API and carries a `redirect`, or a reader
  //     who just saved a story is shown a raw JSON body;
  //   - the language is a `<select name="locale">`, or a multilingual site can
  //     only ever write its default language;
  //   - a rejection comes back as `?error=<code>` and the template **reads**
  //     it, or a failed save re-renders the form with no explanation.
  //
  // The last one is why `query` is in the scope at all, and it is asserted on
  // the rendered message — never on `html.includes("form-error")`, which the
  // stylesheet satisfies on its own (`.form-error{…}` is a CSS rule). That is
  // the "anchor on the mention, not the consumer" shape (§12 #16, 铁律 3b).
  const withPosts = { ...signedInScope(), my_posts: [{ ...post, status: "draft" }] };
  const composeFile = { rel: "templates/compose.html", name: "compose", part: false };
  if (existsSync(join(themeDir, "templates", "compose.html"))) {
    const create = await renderStandalone(composeFile, signedInScope());
    checkTruthy(`${themeName}: compose.html posts to the front API`,
      create.includes('action="/api/v1/front/posts"'),
      "the editor must submit to /api/v1/front/posts");
    checkTruthy(`${themeName}: compose.html carries a redirect field`,
      /name="redirect"/.test(create),
      "without a redirect the reader lands on a JSON body after saving");
    checkTruthy(`${themeName}: compose.html chooses the language with a <select>`,
      /<select name="locale">/.test(create),
      "a multilingual site needs a way to say which language it is writing");
    // Assert against the **pack's own wording**, not the template's English
    // fallback: the pack wins in production, so a literal assertion would only
    // be testing the fixture. The generic line must NOT appear for a code the
    // theme knows — otherwise every failure reads the same and the specific
    // message is decoration.
    const slugMsg = lookup(zh, "compose.errSlug");
    const genericMsg = lookup(zh, "compose.errGeneric");
    const failed = await renderStandalone(composeFile, { ...signedInScope(), query: { error: "slug already used in this language" } });
    checkTruthy(`${themeName}: compose.html shows the failure the server sent back`,
      Boolean(slugMsg) && failed.includes(slugMsg) && !failed.includes(genericMsg),
      `?error= must be read and rendered — looked for ${JSON.stringify(slugMsg)}`);
    const unknown = await renderStandalone(composeFile, { ...signedInScope(), query: { error: "not found" } });
    checkTruthy(`${themeName}: compose.html falls back for a code it does not know`,
      Boolean(genericMsg) && unknown.includes(genericMsg) && !unknown.includes(slugMsg),
      `an unmapped code must still say something — looked for ${JSON.stringify(genericMsg)}`);
    const editing = await renderStandalone(composeFile, { ...signedInScope(), query: { id: "post_1" }, edit_post: post });
    checkTruthy(`${themeName}: compose.html turns into an edit form for ?id=`,
      editing.includes('action="/api/v1/front/posts/post_1"'),
      "?id= must switch the form from create to edit");
  }
  if (existsSync(join(themeDir, "templates", "account.html"))) {
    const account = await renderStandalone({ rel: "templates/account.html", name: "account", part: false }, withPosts);
    checkTruthy(`${themeName}: account.html deletes through a POST form`,
      /<form[^>]*action="\/api\/v1\/front\/posts\/[^"]*\/delete"/.test(account),
      "a destructive action must be a POST form; a GET link deletes on prefetch");
    checkTruthy(`${themeName}: account.html offers no plain link that deletes`,
      !/href="[^"]*delete/.test(account),
      "a delete must never be reachable by an ordinary link");
    checkTruthy(`${themeName}: account.html links each row to the editor`,
      /href="\/zh-CN\/compose\?id=[^"]+"/.test(account),
      "managing a story needs a way back into the editor for that post");
  }

  // -- 6. the packs cover what the markup asks for -------------------------
  // `{{default(theme.strings.x.y, "English literal")}}` degrades silently, so
  // this is the only place a missing key is noticed. Scan every file under
  // templates/ (nested parts included) rather than a hand-written list — a new
  // template someone forgets to add to the list is precisely the file whose
  // keys would go unchecked.
  const tplFiles = [];
  (function walk(d, prefix) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".html")) tplFiles.push(`${prefix}${e.name}`);
    }
  })(join(themeDir, "templates"), "");
  const refs = new Set();
  for (const f of tplFiles) {
    for (const m of read(`templates/${f}`).matchAll(/theme\.strings\.([a-zA-Z0-9_.]+)/g)) refs.add(m[1]);
  }
  checkTruthy(`${themeName}: the templates reference a real set of strings`, refs.size > 10, `found ${refs.size}`);

  for (const code of declaredLocales) {
    const pack = packs[code];
    if (!pack) continue;
    const nested = nest(pack, themeName);
    check(
      `${themeName}: every referenced key exists in ${code}`,
      [...refs].filter((p) => lookup(nested, p) === undefined),
      []
    );
    // The other direction is deliberately NOT asserted, and the reason is
    // worth recording because the first draft of this suite got it wrong.
    //
    // A theme pack is layer ③ of the **interface** dictionary (`packs.ts`),
    // which later layers (plugin, then DB overrides) may win. So a pack
    // legitimately carries keys no template ever reads: the scaffold emits
    // `theme.<name>.admin.title` / `.admin.description` even though the Themes
    // screen renders `theme_installs.title` (the manifest field) rather than
    // these, because they are the theme's *intended* admin wording and a DB
    // override or a future consumer is exactly what the layer exists for.
    // Asserting "no unused key" would therefore fail a correct theme on a
    // legitimate convention — an assertion that is wrong is one that gets
    // disabled. What *is* asserted is the direction that has a silent failure
    // mode: a template asking for a key no pack defines renders the English
    // literal on a Chinese page, and nothing else notices.
    const flat = Object.keys(pack).map((k) => k.replace(`theme.${themeName}.`, ""));
    checkTruthy(`${themeName}: ${code} defines keys beyond the admin-only ones`,
      flat.some((k) => refs.has(k)), `pack has ${flat.length} keys, none referenced by a template`);
  }
  // Both packs must cover the same key set, or a language switch silently drops
  // back to English for the keys the other pack forgot.
  if (declaredLocales.length > 1) {
    const sets = declaredLocales.map((c) =>
      Object.keys(packs[c] || {}).map((k) => k.replace(`theme.${themeName}.`, "")).sort()
    );
    for (let i = 1; i < sets.length; i++) {
      check(`${themeName}: ${declaredLocales[0]} and ${declaredLocales[i]} cover the same keys`, sets[0], sets[i]);
    }
  }
}

async function main() {
  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "bundled-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "bundled-engine.mjs");
  // The distribution set, imported rather than re-listed — so a theme added to
  // `BUNDLED_THEMES` is covered by this suite in the same commit.
  const { BUNDLED_THEMES } = await bundle("src/shared/bundled.ts", "bundled-list.mjs");

  section("0. The distribution set is real (non-vacuity)");
  checkTruthy("BUNDLED_THEMES is a non-empty list", Array.isArray(BUNDLED_THEMES) && BUNDLED_THEMES.length > 0, JSON.stringify(BUNDLED_THEMES));
  for (const t of BUNDLED_THEMES) {
    checkTruthy(`content/themes/${t}/theme.json exists`, existsSync(join(root, "content", "themes", t, "theme.json")));
  }

  for (const t of BUNDLED_THEMES) {
    await checkTheme(t, validateManifest, renderTemplateSource);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("failures:\n  " + failures.join("\n  "));
  // Exit **unconditionally**. Exiting only on failure is an implicit contract
  // with the injector harness: it reads this suite's own `process.exit` as the
  // completion signal, so a green run that never calls it drains the worker and
  // is reported as `no summary (aborted)` — "the runner is broken" instead of
  // "the guard did not go red". `_skeleton-inject.mjs` now also reports on
  // `beforeExit`, but the convention (every suite ends with `process.exit`) is
  // what the harness was written against, and this file had drifted from it.
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log(`\n0 passed, 1 failed`);
  console.log(`(aborted) ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
