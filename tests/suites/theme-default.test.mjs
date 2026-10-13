/**
 * The 墨白 MOBAI theme, validated end to end — `content/themes/default/`.
 *
 * ## Why this suite exists
 *
 * A theme's templates are the one part of this repository that **cannot fail
 * loudly**. A missing `{{/section}}`, a helper written as `{{truncate x 20}}`,
 * a `{{post.html}}` where `{{{post.html}}}` was meant — none of them throw
 * where a developer would see it. The engine degrades to an unstyled shell, or
 * escapes the article into visible `<p>` tags, and the manifest validator and
 * the architecture test both pass. Only rendering the real templates through
 * the real engine catches them.
 *
 * So this suite renders every declared template with a realistic scope, plus
 * the scopes a live site reaches that a happy path never does (no posts, no
 * menu, no description, no cover, an object that failed to load), and asserts
 * the invariants that hold for all of them.
 *
 * It also checks the head, because that is where this theme's SEO contract
 * lives: a canonical URL, Open Graph tags, and the `<link rel="alternate">`
 * that is the only thing making `/feed.xml` discoverable.
 *
 * Usage: node tests/suites/theme-default.test.mjs
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

const THEME = "default";
const themeDir = join(root, "content", "themes", THEME);
const read = (p) => readFileSync(join(themeDir, p), "utf8");

/**
 * Nest a theme pack the way `buildScope` does, so the templates are rendered
 * against the real dictionary rather than a stub. A key the template asks for
 * and the pack does not define would otherwise degrade silently to the English
 * literal baked into the markup — visible on the site, invisible in a test that
 * only checked the markup.
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

async function main() {
  const { validateManifest } = await bundle("src/extensions/contract/validation.ts", "default-validation.mjs");
  const { renderTemplateSource } = await bundle("src/rendering/template-engine.ts", "default-engine.mjs");
  // The *real* member projection, so the signed-in fixture cannot drift from
  // what the runtime hands a template. See section 8b.
  const { memberScope } = await bundle("src/platform/members.ts", "default-members.mjs");

  // The theme's own dictionaries, nested exactly as `buildScope` nests them.
  const zhPack = nest(JSON.parse(read("langs/zh-CN.json")), THEME);
  const enPack = nest(JSON.parse(read("langs/en.json")), THEME);

  // -- 1. the install boundary --------------------------------------------
  section("1. The install boundary accepts it");
  const manifest = JSON.parse(read("theme.json"));
  let error = null;
  try {
    const v = validateManifest(manifest, "theme");
    check("the validator normalises the manifest", v.name, THEME);
  } catch (e) { error = e.message; }
  check("validateManifest does not throw", error, null);
  check("every declared template is shipped", themeManifestProblems(root).filter((p) => p.includes(`/${THEME}`)), []);
  check("language packs are namespaced", langPackProblems(root).filter((p) => p.includes(`/themes/${THEME}/`)), []);
  // `locales: ["zh-CN","en"]` is what makes this a Chinese theme, and until now
  // nothing read it: a declared locale with no `langs/{code}.json` renders every
  // `{{default(theme.strings.x, "English literal")}}` as the literal, so the
  // "Chinese version" would silently be the English one.
  check(
    "every locale the manifest declares ships a language pack",
    themeManifestProblems(root).filter((p) => p.includes(`/${THEME}`) && p.includes("declares locale")),
    []
  );
  // The chips and the tag cloud read these two fields off each post. A theme
  // that renders a category label without declaring the field would show
  // "未分类" forever and nobody would know why.
  const fieldKeys = (manifest.fields || []).map((f) => f.key);
  check("the category and tags fields are declared", fieldKeys.includes("category") && fieldKeys.includes("tags"), true);

  // -- 2. the palette ------------------------------------------------------
  section("2. The palette is defined for both themes");
  const styles = read("templates/parts/styles.html");
  check("light tokens are on :root", /:root\s*\{[^}]*--bg:/.test(styles), true);
  check("dark tokens are defined", /\[data-theme="dark"\]\s*\{[^}]*--bg:/.test(styles), true);
  const colorTokens = (block) => [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*(oklch\([^;]*\))/g)].map((m) => m[1]).sort();
  const rootBlock = styles.slice(styles.indexOf(":root"), styles.indexOf('[data-theme="dark"]'));
  const darkBlock = styles.slice(styles.indexOf('[data-theme="dark"]'), styles.indexOf("*,*::before"));
  checkTruthy("the light palette defines colours", colorTokens(rootBlock).length > 5);
  check("every light colour is redefined for dark", colorTokens(rootBlock).filter((t) => !colorTokens(darkBlock).includes(t)), []);
  check("dark defines no colour the light palette lacks", colorTokens(darkBlock).filter((t) => !colorTokens(rootBlock).includes(t)), []);

  // -- 3. every template renders through the real engine -------------------
  section("3. Every declared template renders through the real template engine");
  const loadTemplate = async (name) => {
    for (const p of [join(themeDir, "templates", `${name}.html`), join(themeDir, "templates", "parts", `${name}.html`)]) {
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const render = async (file, scope) =>
    renderTemplateSource(readFileSync(join(themeDir, "templates", file), "utf8"), scope, { loadTemplate });

  const cover = "https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=1200";
  const post = {
    id: "post_1", slug: "hello", type: "post", title: "在信息过载的时代重新学会深度阅读",
    excerpt: "墨白是一份独立中文博客：设计、技术与生活方式的长文章。",
    html: "<h2>工具越强，品味越贵</h2><p>正文段落。</p><blockquote>引用。</blockquote><pre><code>const x = 1;</code></pre>",
    reading_time: "12 分钟阅读", date_display: "2026年10月8日", created_at: 1791433031,
    cover, meta: { category: "设计", tags: "长阅读,设计系统" }, url: "/zh-CN/blog/hello",
  };
  const base = (over = {}) => ({
    site: { title: "墨白", description: "一份独立中文博客。", robots: "index,follow", locale: "zh-CN", url: "https://default.example" },
    page: { title: "墨白", description: "一份独立中文博客。", path: "/zh-CN", kind: "home", document_title: "墨白" },
    locale: "zh-CN",
    locales: [{ code: "zh-CN", name: "简体中文", is_default: true }],
    theme: { name: THEME, title: "墨白 MOBAI", version: "1.0.0", strings: zhPack },
    menu: { primary: [], primary_html: "" },
    post: null,
    ...over,
  });

  const kinds = [
    ["home.html", base({ posts: [post] })],
    ["index.html", base({ posts: [post] })],
    ["archive.html", base({ posts: [post] })],
    ["single.html", base({ post, page: { title: post.title, kind: "single", document_title: post.title + " · 墨白", path: "/zh-CN/blog/hello" } })],
    ["page.html", base({ post: { ...post, reading_time: "", date_display: "", cover: "" } })],
    ["404.html", base({ page: { title: "Not Found", kind: "404", document_title: "Not Found · 墨白", path: "/zh-CN/nope" } })],
  ];
  for (const [file, scope] of kinds) {
    const html = await render(file, scope);
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render (an unclosed section?)");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    if (!html.includes("墨白")) problems.push("site title missing");
    check(`${file} renders clean`, problems, []);
  }

  // -- 4. the article is not escaped ---------------------------------------
  section("4. Rendered article HTML is not escaped");
  const single = await render("single.html", base({ post }));
  checkTruthy("prose markup survives", single.includes("<blockquote>引用。</blockquote>"));
  checkTruthy("code block survives", single.includes("<pre><code>const x = 1;</code></pre>"));
  checkTruthy("no escaped paragraph tags", !single.includes("&lt;p&gt;"));
  checkTruthy("the date is printed", single.includes("2026年10月8日"));
  checkTruthy("reading time is printed", single.includes("12 分钟阅读"));
  checkTruthy("the category is printed", single.includes("设计"));
  checkTruthy("the tags are printed", single.includes("长阅读"));

  // -- 5. the head carries the SEO contract --------------------------------
  section("5. The head carries the SEO contract");
  // A post page, so `page.path` is the post's URL rather than the site root —
  // the canonical has to follow the page, and asserting against the root would
  // pass for the wrong reason.
  const postPage = base({ post, page: { title: post.title, kind: "single", document_title: post.title + " · 墨白", path: "/zh-CN/blog/hello" } });
  const singlePost = await render("single.html", postPage);
  checkTruthy("canonical is absolute", singlePost.includes('<link rel="canonical" href="https://default.example/zh-CN/blog/hello">'), singlePost.match(/<link rel="canonical"[^>]*>/)?.[0] || "(no canonical)");
  checkTruthy("og:url is absolute", singlePost.includes('<meta property="og:url" content="https://default.example/zh-CN/blog/hello">'), singlePost.match(/<meta property="og:url"[^>]*>/)?.[0] || "(no og:url)");
  checkTruthy("og:image uses the cover", singlePost.includes(`<meta property="og:image" content="${cover}">`));
  checkTruthy("the feed is discoverable", singlePost.includes('rel="alternate"') && singlePost.includes("/feed.xml"));
  checkTruthy("article:published_time is set", singlePost.includes('property="article:published_time"'));
  // Without a request origin there is no absolute URL to publish; the theme must
  // omit the tag rather than emit `href="/zh-CN"` as a canonical.
  const noOrigin = await render("single.html", base({
    post,
    page: { title: post.title, kind: "single", document_title: post.title, path: "/zh-CN/blog/hello" },
    site: { title: "墨白", description: "", robots: "", locale: "zh-CN", url: "" },
  }));
  checkTruthy("canonical is omitted when there is no origin", !noOrigin.includes('rel="canonical"'));
  checkTruthy("the feed link still works relatively", noOrigin.includes('href="/feed.xml"'));

  // -- 6. covers degrade, they do not break --------------------------------
  section("6. A missing cover degrades instead of breaking");
  const noCover = await render("home.html", base({ posts: [{ ...post, cover: "" }] }));
  checkTruthy("no broken img tag", !noCover.includes("<img src=\"\""));
  checkTruthy("the card still renders", noCover.includes("在信息过载的时代重新学会深度阅读"));
  const noMeta = await render("home.html", base({ posts: [{ ...post, meta: {} }] }));
  checkTruthy("a post with no category falls back", noMeta.includes("未分类"));
  checkTruthy("no undefined leaked from empty meta", !noMeta.includes("undefined"));

  // -- 7. the empty and degraded scopes ------------------------------------
  section("7. Empty and degraded scopes still render");
  const empties = [
    ["home.html", base({ posts: [] })],
    ["index.html", base({ posts: [] })],
    ["archive.html", base({ posts: [] })],
    ["home.html", base({ posts: [], site: { title: "裸站", description: "", robots: "", locale: "zh-CN", url: "" } })],
    ["single.html", base({ post: null })],
    ["page.html", base({ post: null })],
    ["single.html", base({ post: { ...post, html: "", excerpt: "", cover: "", date_display: "", reading_time: "" } })],
    ["home.html", base({ posts: [post], menu: { primary: [], primary_html: "" } })],
  ];
  for (const [file, scope] of empties) {
    const html = await render(file, scope);
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    check(`${file} renders clean when empty/degraded`, problems, []);
  }
  checkTruthy("an empty list says so", (await render("home.html", base({ posts: [] }))).includes("还没有发布任何内容"));

  // -- 8. no-flash bootstrap ------------------------------------------------
  section("8. The palette is resolved before first paint");
  const layout = read("templates/parts/layout.html");
  const scriptAt = layout.indexOf("default-theme");
  const styleAt = layout.indexOf("parts/styles");
  checkTruthy("the bootstrap reads localStorage", scriptAt > -1);
  checkTruthy("it runs before the stylesheet", scriptAt > -1 && styleAt > -1 && scriptAt < styleAt);
  checkTruthy("it sets colorScheme for native controls", layout.includes("colorScheme"));

  // -- 8b. the member pages -------------------------------------------------
  //
  // The sign-in and register templates are the only pages whose markup changes
  // on who is asking, and the two branches are reached through the `member`
  // scope the platform sets from the **member** session (rule 77). Both
  // branches must render cleanly: an unauthenticated visitor sees the form, a
  // signed-in reader sees the account state. A template that only ever got
  // tested signed-out would ship an `{{#if member}}` branch nobody ever saw.
  //
  // ⚠️ The fixture is built by calling the **real** `memberScope()` rather than
  // hand-writing the object. The hand-written version is what hid the defect
  // this section is named after: it spelled the field `display_name`, the real
  // scope handed templates a camelCase `displayName`, so `{{member.display_name}}`
  // rendered empty on the live site while this suite stayed green. A fixture
  // that invents a shape the runtime never produces cannot fail — it is a guard
  // made of the very assumption it was meant to test (§12 #5). Deriving it from
  // the projection means the fixture drifts *with* the runtime, and the day the
  // projection is renamed this section goes red instead of quietly passing.
  section("8b. The member pages render in both states");
  const signedInMember = memberScope({ id: "mem_1", siteId: "site_1", username: "bob", email: null, displayName: "Bob", role: "member", status: "active" });
  // Sanity: the projection must carry the snake_case key the templates ask for.
  // Without this the whole section would still pass on an empty object.
  check("the member scope carries display_name", signedInMember.display_name, "Bob");
  check("the member scope is snake_case, not camelCase", "displayName" in signedInMember, false);
  const loginOut = await render("login.html", base({ member: null, page: { title: "Sign in", kind: "page", document_title: "Sign in · 墨白", path: "/zh-CN/login" } }));
  const loginIn = await render("login.html", base({ member: signedInMember, page: { title: "Sign in", kind: "page", document_title: "Sign in · 墨白", path: "/zh-CN/login" } }));
  const regOut = await render("register.html", base({ member: null, page: { title: "Create an account", kind: "page", document_title: "Create an account · 墨白", path: "/zh-CN/register" } }));
  for (const [name, html] of [["login (signed out)", loginOut], ["login (signed in)", loginIn], ["register (signed out)", regOut]]) {
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    check(`${name} renders clean`, problems, []);
  }
  // The form must post to the front-end API, and only there — a theme form that
  // forgot its `action` would post back to the page itself and appear to do
  // nothing, which is indistinguishable from a broken endpoint.
  checkTruthy("the login form posts to the front-end auth endpoint", loginOut.includes('action="/api/v1/front/auth/login"'), loginOut.match(/<form[^>]*>/)?.[0] || "(no form)");
  checkTruthy("the register form posts to the front-end auth endpoint", regOut.includes('action="/api/v1/front/auth/register"'), regOut.match(/<form[^>]*>/)?.[0] || "(no form)");
  // Signed out: a password field. Signed in: a sign-out button instead of a
  // second login form — showing the form again is the dead end this guards.
  checkTruthy("signed out shows a password field", loginOut.includes('type="password"'));
  checkTruthy("signed in does NOT show a second login form", !loginIn.includes('type="password"'), "a signed-in reader would be asked to sign in again");
  checkTruthy("signed in shows the sign-out action", loginIn.includes('action="/api/v1/front/auth/logout"'));
  checkTruthy("signed in names the reader", loginIn.includes("Bob"));
  // The header reflects the same state, so the account entry point is reachable
  // from every page rather than only from the login URL itself.
  checkTruthy("the header offers sign in when signed out", loginOut.includes("/zh-CN/login") && loginOut.includes("登录"));
  checkTruthy("the header shows the member name when signed in", loginIn.includes("Bob"));
  // The account page and the editor are the two pages a reader only reaches
  // once signed in, and both are plain forms (rule 85). They are asserted on
  // the rendered markup — never on `html.includes("form-error")`, which the
  // stylesheet satisfies on its own (`.form-error{…}` is a CSS rule), the
  // "anchor on the mention, not the consumer" shape (§12 #16, 铁律 3b).
  const acctPage = { title: "Account", kind: "page", document_title: "Account · 墨白", path: "/zh-CN/account" };
  const composePage = { title: "Write a story", kind: "page", document_title: "Write a story · 墨白", path: "/zh-CN/compose" };
  const accountIn = await render("account.html", base({
    member: signedInMember, my_posts: [{ ...post, status: "draft" }], page: acctPage,
  }));
  const accountOut = await render("account.html", base({ member: null, page: acctPage }));
  const composeIn = await render("compose.html", base({ member: signedInMember, query: {}, page: composePage }));
  const composeOut = await render("compose.html", base({ member: null, query: {}, page: composePage }));
  for (const [name, html] of [["account (signed in)", accountIn], ["account (signed out)", accountOut],
    ["compose (signed in)", composeIn], ["compose (signed out)", composeOut]]) {
    const problems = [];
    if (!html.includes("<html")) problems.push("shell did not render");
    if (html.includes("{{")) problems.push("unresolved template syntax leaked");
    if (html.includes("undefined")) problems.push("output contains undefined");
    check(`${name} renders clean`, problems, []);
  }
  checkTruthy("the account page names the reader", accountIn.includes("Bob"));
  // A destructive action is a POST form; a GET link would delete on prefetch.
  checkTruthy("the account page deletes through a POST form",
    /<form[^>]*action="\/api\/v1\/front\/posts\/[^"]*\/delete"/.test(accountIn),
    "a delete must be a form, not a link");
  checkTruthy("the account page offers no plain link that deletes", !/href="[^"]*delete/.test(accountIn));
  checkTruthy("each row links back into the editor", accountIn.includes('href="/zh-CN/compose?id=post_1"'));
  checkTruthy("the editor posts to the front API", composeIn.includes('action="/api/v1/front/posts"'));
  checkTruthy("the editor carries a redirect field", /name="redirect"/.test(composeIn),
    "without a redirect the reader lands on a JSON body after saving");
  checkTruthy("the editor chooses the language with a <select>", /<select name="locale">/.test(composeIn));
  const composeFailed = await render("compose.html", base({ member: signedInMember, query: { error: "slug already used" }, page: composePage }));
  checkTruthy("the editor shows the failure the server sent back",
    composeFailed.includes(lookup(zhPack, "compose.errSlug")) && !composeFailed.includes(lookup(zhPack, "compose.errGeneric")),
    "?error= must be read and rendered");
  const composeEditing = await render("compose.html", base({ member: signedInMember, query: { id: "post_1" }, edit_post: post, page: composePage }));
  checkTruthy("the editor switches to an edit form for ?id=",
    composeEditing.includes('action="/api/v1/front/posts/post_1"'),
    "?id= must switch the form from create to edit");

  // -- 9. the pack actually covers what the templates ask for ---------------  //
  // `{{default(theme.strings.x.y, "English literal")}}` degrades silently: a
  // key that is missing from the pack renders the literal, so a typo in the
  // template or a forgotten entry in `langs/` shows an English string on a
  // Chinese site and nothing anywhere else. This is the only place that notices.
  section("9. Every string the templates ask for exists in both packs");
  const tplFiles = ["home.html", "index.html", "archive.html", "single.html", "page.html", "404.html",
    "login.html", "register.html", "account.html", "compose.html",
    "parts/layout.html", "parts/header.html", "parts/footer.html"];
  const refs = new Set();
  for (const f of tplFiles) {
    for (const m of read(`templates/${f}`).matchAll(/theme\.strings\.([a-zA-Z0-9_.]+)/g)) refs.add(m[1]);
  }
  checkTruthy("the templates reference a real set of strings", refs.size > 20, `found ${refs.size}`);
  check("every referenced key exists in zh-CN", [...refs].filter((p) => lookup(zhPack, p) === undefined), []);
  check("every referenced key exists in en", [...refs].filter((p) => lookup(enPack, p) === undefined), []);
  // And the other direction: a key nobody uses is dead weight in a pack that
  // has to be translated by hand.
  const zhFlat = Object.keys(JSON.parse(read("langs/zh-CN.json"))).map((k) => k.replace(`theme.${THEME}.`, ""));
  check("no unused keys in zh-CN", zhFlat.filter((k) => !refs.has(k)), []);
  const enFlat = Object.keys(JSON.parse(read("langs/en.json"))).map((k) => k.replace(`theme.${THEME}.`, ""));
  check("no unused keys in en", enFlat.filter((k) => !refs.has(k)), []);
  // Both packs must cover the same key set, or a language switch silently drops
  // back to English for the keys the other pack forgot.
  check("zh-CN and en cover the same keys", zhFlat.slice().sort(), enFlat.slice().sort());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("failures:\n  " + failures.join("\n  "));
  // Unconditional exit — see the same note in `theme-bundled.test.mjs`. Exiting
  // only on failure makes the injector harness read a green run as a broken
  // runner (`no summary (aborted)`) rather than as "the guard did not go red".
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log(`\n0 passed, 1 failed`);
  console.log(`(aborted) ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
