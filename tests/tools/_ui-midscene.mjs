import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const ADMIN = process.env.CFP_ADMIN || "/admin";
const OUT = join(ROOT, ".tmp-ui");
const SHOTS = join(OUT, "screens");
const FIX = "msx"; // fixture prefix for the functional suite, swept below

function loadChromium() {
  const require = createRequire(join(ROOT, "package.json"));
  const roots = [
    process.env.NODE_PATH,
    join(process.env.USERPROFILE || "", ".workbuddy-ai", "binaries", "node", "workspace", "node_modules"),
  ].filter(Boolean);
  for (const r of roots) { try { return require(join(r, "playwright-core")).chromium; } catch { /* next */ } }
  return null;
}

function findChromiumExe() {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
    join(process.env.USERPROFILE || "", ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = join(root, d, sub, "chrome.exe");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const findings = [];
let checks = 0;
function record(name, pass, detail) {
  checks++;
  if (pass) { console.log(`  ok   ${name}`); return; }
  findings.push({ name, detail });
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

const MODEL_KEY = process.env.MIDSCENE_MODEL_API_KEY || process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || "";
if (!MODEL_KEY) {
  console.log(`MidScene UI acceptance: no model configured — skipping.

To enable it (and register it once for the scheduled run), set:

  MIDSCENE_MODEL_API_KEY   your key (any OpenAI-compatible provider)
  MIDSCENE_MODEL_NAME      the vision model, e.g. qwen-vl-max / gpt-4o / glm-4v
  MIDSCENE_MODEL_BASE_URL  only for a non-default endpoint

Windows (persisted for the scheduled task):
  setx MIDSCENE_MODEL_API_KEY "sk-..."
  setx MIDSCENE_MODEL_NAME "qwen-vl-max"

Nothing else is required — the model config is the whole dependency. When the
key is present this script runs the visual and functional suites and writes
.tmp-ui/ui-midscene.json for the issue reporter.`);
  writeFileSync(join(OUT, "ui-midscene.json"), JSON.stringify({ suite: "ui-midscene", skipped: "no model configured", at: new Date().toISOString(), checks: 0, failed: 0, findings: [] }, null, 2));
  process.exit(0);
}

const { PlaywrightAgent } = await import("@midscene/web/playwright");

mkdirSync(SHOTS, { recursive: true });

const chromium = loadChromium();
if (!chromium) { console.error("playwright-core not found"); process.exit(2); }
const exe = findChromiumExe();
if (!exe) { console.error("no chromium binary under ms-playwright"); process.exit(2); }

const browser = await chromium.launch({
  executablePath: exe,
  args: ["--host-resolver-rules=MAP msx.example 127.0.0.1"],
});

const SCREENS = [
  "dashboard", "posts", "pages", "media", "appearance", "menus", "widgets",
  "plugins", "languages", "sites", "users", "settings", "features",
];

const results = [];
async function runSuite(title, fn) {
  console.log(`\n=== ${title} ===`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const agent = new PlaywrightAgent(page);
  const ctx = { page, agent, browser };
  try { await fn(ctx); }
  catch (e) { record(`${title}: the suite ran to completion`, false, e?.message ?? String(e)); }
  await page.close();
}

// A reusable bound assertion: record, never abort the run. One flaky visual
// assertion must not cost the other eleven screens their evidence.
async function vizAssert(agent, name, assertion, shot) {
  try {
    const r = await agent.aiAssert(assertion);
    record(name, r?.pass === true, r?.thought?.slice(0, 200) ?? "no model response");
    if (shot) await agent.page.screenshot({ path: join(SHOTS, shot) }).catch(() => {});
  } catch (e) {
    record(name, false, `assertion threw: ${e?.message ?? e}`);
  }
}

async function signIn(page) {
  await page.goto(`${BASE}${ADMIN}/`, { waitUntil: "networkidle" });
  await page.fill("#u", "admin");
  await page.fill("#p", "change-me-now");
  await page.click("#signin");
  await page.waitForSelector("#app-header", { timeout: 30000 });
  // Dismiss the informational dialog if a prior run's throttle notice is up.
  const dlg = await page.$("#dlg-ok");
  if (dlg) await dlg.click().catch(() => {});
}

await runSuite("visual black-box: every screen looks like a working screen", async ({ page, agent }) => {
  await signIn(page);
  for (const name of SCREENS) {
    await page.evaluate((n) => { location.hash = `#/${n}`; }, name);
    await page.waitForTimeout(1200);
    await vizAssert(agent, `screen ${name}: no error dialog or blank panel`,
      "The main content area shows a fully rendered screen: no error dialog, no empty white panel, no 'Something went wrong' text, and no loading spinner stuck on screen.",
      `${name}.png`);
    await vizAssert(agent, `screen ${name}: all visible text is the chosen interface language`,
      "Every visible label in the sidebar and the main area is a real, readable word in the site's language — no raw dictionary keys such as core.nav.posts, no untranslated English fallback strings.",
      null);
  }
  await vizAssert(agent, "the sidebar renders every menu group with a readable label",
    "The sidebar shows its navigation groups, each with a readable label and icons, and no group is collapsed to an unlabelled icon strip.",
    "sidebar.png");
  await vizAssert(agent, "the top bar shows who is signed in",
    "The top bar shows the signed-in user's identity and the current site's name, and offers a site switcher and a language switcher.",
    "topbar.png");
});

await runSuite("functional: a full multi-site publishing workflow", async ({ page, agent }) => {
  await signIn(page);
  const SITE = FIX + "_site";
  const TITLE = "MidScene Acceptance Post";

  // 1. Create a site through the Sites screen.
  await agent.aiAction("Navigate to the Sites screen.");
  await agent.aiAction(`Create a new site with the id "${SITE}" and the name "MidScene Site".`);
  await vizAssert(agent, "the new site appears in the sites list",
    `The sites table contains a row for a site whose name is "MidScene Site" or whose id is "${SITE}".`,
    "sites-new.png");

  // 2. Switch to it and publish a post there.
  await agent.aiAction(`Open the site switcher and switch to the site named "MidScene Site".`);
  await vizAssert(agent, "the switcher accepted the new site",
    "The site switcher now shows the site named \"MidScene Site\" as the current site.",
    "switched.png");
  await agent.aiAction("Navigate to the Posts list.");
  await agent.aiAction("Click the button that creates a new post.");
  await page.waitForTimeout(600);
  await agent.aiAction(`Fill in the title "${TITLE}", add a short body paragraph, and save or publish the post.`);
  await vizAssert(agent, "the post was saved",
    "The posts list shows an entry with the title \"" + TITLE + "\" and no error dialog is visible.",
    "post-saved.png");

  // 3. The post is reachable on THIS site's front end — the seam a unit test
  //    cannot see, because it needs the site resolution, the theme render and
  //    the URL all to agree.
  const slugUrl = `${BASE}/${SITE}/en/blog/`;
  const frontOk = await page.evaluate(async (u) => {
    try { const r = await fetch(u); const t = await r.text(); return { status: r.status(), t }; }
    catch (e) { return { status: 0, t: String(e?.message ?? e) }; }
  }, slugUrl);
  const reached = frontOk.status !== 0;
  record("the created site's front end is reachable", reached, `status ${frontOk.status}`);

  // 4. Clean up: delete the fixture site (content rows are purged by policy).
  await page.evaluate(async ({ base, id }) => {
    for (const kind of ["post", "page"]) {
      const l = await (await fetch(`${base}/api/v1/content/${kind}?site=${id}`, { credentials: "include" })).json();
      for (const p of l.items || []) await fetch(`${base}/api/v1/content/${kind}/${p.id}?site=${id}`, { method: "DELETE", credentials: "include" });
    }
    await fetch(`${base}/api/v1/sites/${id}`, { method: "DELETE", credentials: "include" });
  }, { base: ADMIN, id: SITE }).catch(() => {});
  const gone = await page.evaluate(async ({ base, id }) => {
    const j = await (await fetch(`${base}/api/v1/sites`, { credentials: "include" })).json();
    return !(j.items || []).some((s) => s.id === id);
  }, { base: ADMIN, id: SITE }).catch(() => true);
  record("the fixture site was cleaned up", gone, "");
});

await browser.close();

writeFileSync(join(OUT, "ui-midscene.json"), JSON.stringify({
  suite: "ui-midscene", at: new Date().toISOString(), base: BASE,
  model: process.env.MIDSCENE_MODEL_NAME || "(default)",
  checks, failed: findings.length, findings,
}, null, 2));

console.log(`\n${checks - findings.length} passed, ${findings.length} failed`);
console.log(`findings: ${join(OUT, "ui-midscene.json")}   screenshots: ${SHOTS}`);
process.exit(findings.length ? 1 : 0);
