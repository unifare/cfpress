/**
 * seed-demo-content.mjs — seed the demo content through the **API**, then
 * verify a reader can actually see it.
 *
 * The demo content itself lives in exactly one place: `src/shared/
 * demo-content.ts`. The worker writes it (`POST /api/v1/seed-demo`, the same
 * writer the boot hook and the admin Settings button use — one implementation,
 * three callers); this script is the terminal door to it: it logs in, calls
 * the endpoint, and then does what the server *cannot* do honestly — verify
 * from the outside that "written" means "readable":
 *
 *   1. **The API agrees, per language** — `?locale=` is the filter the admin
 *      list uses, so a row that only exists in the default language is
 *      invisible here even though the write said 200.
 *   2. **The front end renders the language at all** — a language that
 *      renders a fallback page at HTTP 200 is worse than one not offered.
 *
 * Running it blind is safe on any database state: the endpoint is idempotent
 * (per-site fixed ids update the same rows) and this script writes nothing
 * itself. CFP_BASE / CFP_USER / CFP_PASS / CFP_SITE / CFP_ADMIN as usual.
 */

const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const USER = process.env.CFP_USER || "admin";
const PASS = process.env.CFP_PASS || "change-me-now";
const SITE = process.env.CFP_SITE || "default";
// The admin API lives under the configurable admin prefix (default `/admin`).
const ADMIN = (process.env.CFP_ADMIN || "/admin").replace(/\/+$/, "");

// The expected shape, per piece and language. The writer owns the prose; this
// table is only what verification *expects to find* — deliberately separate,
// because a verifier that imports the implementation verifies nothing.
const EXPECTED = [
  { kind: "posts", key: "hello", en: { slug: "hello-world", title: "Hello World" }, "zh-CN": { slug: "ni-hao-shi-jie", title: "你好，世界" } },
  { kind: "posts", key: "second", en: { slug: "second-post", title: "Second Post" }, "zh-CN": { slug: "di-er-pian", title: "第二篇" } },
  { kind: "posts", key: "edge", en: { slug: "rendering-at-the-edge", title: "Rendering at the edge, one pass at a time" }, "zh-CN": { slug: "zai-bian-yuan-xuan-ran", title: "在边缘一次渲染" } },
  { kind: "posts", key: "templates", en: { slug: "a-template-language-small-enough-to-reason-about", title: "A template language small enough to reason about" }, "zh-CN": { slug: "ke-yi-tui-qiao-de-mo-ban-yu-yan", title: "小到可以推敲的模板语言" } },
  { kind: "posts", key: "i18n", en: { slug: "two-languages-one-row", title: "Two languages, one row" }, "zh-CN": { slug: "liang-zhong-yu-yan-tong-yi-xing", title: "两种语言，同一行" } },
  { kind: "pages", key: "about", en: { slug: "about", title: "About" }, "zh-CN": { slug: "guan-yu", title: "关于" } },
];
const LOCALES = ["en", "zh-CN"];

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const site = `?site=${encodeURIComponent(SITE)}`;

// The login lives under the admin prefix (`/api/v1/auth/login` is retired and
// answers 404 by design — rule 75). The rest of the admin API answers both
// under the prefix and bare; the bare form is what this script calls.
const login = await api(`${ADMIN}/api/v1/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (login.status >= 400) {
  console.error("login failed", login.status, login.json);
  process.exit(1);
}
console.log(`login ok  (${BASE}, site=${SITE})`);

const seed = await api(`/api/v1/seed-demo${site}`, {
  method: "POST",
  body: JSON.stringify({}),
});
if (seed.status >= 400) {
  console.error("seed failed", seed.status, seed.json);
  process.exit(1);
}
console.log(`seed ok   (${seed.json.written} version(s), failed: ${JSON.stringify(seed.json.failed ?? [])})`);
if ((seed.json.failed ?? []).length) {
  console.error("the endpoint reported failures — see above");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Verify — written ≠ readable. Read it back, per language, through both doors.
// ---------------------------------------------------------------------------
console.log("\nverify");
let verifyFailures = 0;

for (const locale of LOCALES) {
  const expected = EXPECTED.filter((c) => c[locale]);

  // 1. The API agrees, for *this* language — the strong check. Matched by the
  //    per-site demo id (`demo_<site>_<key>`): the admin list's `title`
  //    follows the filtered locale, but its `slug` stays the main table's
  //    (batch 24's representative-row shape), so a slug match here would read
  //    the wrong field. The per-locale URL gets its own check below.
  for (const kind of ["posts", "pages"]) {
    const want = EXPECTED.filter((c) => c.kind === kind && c[locale]);
    if (!want.length) continue;
    const list = await api(`/api/v1/${kind}${site}&locale=${encodeURIComponent(locale)}&limit=100`);
    const rows = new Map((list.json?.items ?? []).map((r) => [r.id, r]));
    for (const c of want) {
      const row = rows.get(`demo_${SITE}_${c.key}`);
      const ok = row && row.title === c[locale].title;
      if (!ok) {
        verifyFailures++;
        console.log(`  FAIL ${locale} ${kind} ${c.key} not readable (${row ? `title=${JSON.stringify(row.title)}` : "no row"})`);
      }
    }
  }

  // 2. Each language version answers at its own permalink (migration 0016:
  //    every language owns its slug). Posts live under the built-in blog
  //    route (`/{locale}/blog/{slug}`), pages at `/{locale}/{slug}` — the
  //    URLs a reader holds.
  for (const c of expected) {
    const prefix = c.kind === "posts" ? "blog/" : "";
    const page = await fetch(`${BASE}/${encodeURIComponent(locale)}/${prefix}${c[locale].slug}`);
    const html = page.status === 200 ? await page.text() : "";
    if (page.status !== 200 || !html.includes(c[locale].title.slice(0, 20))) {
      verifyFailures++;
      console.log(`  FAIL ${locale} /${c[locale].slug} did not render its piece (HTTP ${page.status})`);
    }
  }

  // 3. The front end renders this language at all — the smoke check. A prefix
  //    rather than the whole title, because a theme is free to truncate a card.
  const home = await fetch(`${BASE}/${encodeURIComponent(locale)}`);
  const html = await home.text();
  const hits = expected.filter((c) => html.includes(c[locale].title.slice(0, 20))).length;
  if (home.status !== 200 || hits === 0) {
    verifyFailures++;
    console.log(`  FAIL ${locale} front page did not render the seeded content (HTTP ${home.status}, ${hits} title(s) found)`);
  } else {
    console.log(`  ok   ${locale} API + permalinks + front page (${hits}/${expected.length} title(s) on the home page)`);
  }
}

console.log(`\n${verifyFailures} verify failure(s).`);
if (verifyFailures) process.exit(1);
console.log("Seed verified: every language readable through the API and rendered on its front page.");
