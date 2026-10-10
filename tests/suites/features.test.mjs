/**
 * Feature-switch API tests — the HTTP surface behind `shared/features.ts`.
 *
 * `theme-worker.test.mjs` §10 and `multisite.test.mjs` §9 prove the *resolver*
 * honours a switch and that the consumers respect it. Neither reaches the part
 * an operator actually touches: the admin screen's API. Three things can break
 * there while every other suite stays green:
 *
 *   1. **The route is not registered**, or is registered without a permission
 *      check. Both are invisible to a unit test of `featureEnabled()`.
 *   2. **The response shape drifts** from what `public/admin/js/screens/features.js`
 *      reads. The screen has no build step and no types, so a renamed field is a
 *      blank panel at runtime and nothing else.
 *   3. **The save path persists something nothing reads** — a key spelled
 *      differently from `FEATURE_SWITCHES`, which is the "declared but never
 *      consumed" defect this repo has already fixed five times.
 *
 * So this suite drives the real compiled Worker over real requests and asserts
 * the layer boundaries explicitly, including that a var alone (with no site row)
 * is enough to enable a switch.
 *
 * Usage: node tests/suites/features.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

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

/**
 * Run one section, turning an uncaught throw into a **recorded failure**.
 *
 * This matters more than it looks. A throw that escapes `main()` ends the
 * process before the summary line, and the reverse-validation tool treats "no
 * summary" as "could not read the result" — so the injected defect reads as a
 * broken harness rather than as the guard going red.
 *
 * That is not hypothetical: with the `settings` key injected as wrong, section 4
 * hits a UNIQUE violation inside the server, the throw escapes, and the whole
 * run reports "no summary" — *even though five assertions had already gone red
 * correctly*. The tool then refuses to count the scenario as valid, which is the
 * right call for a tool but hides the fact that the guard did its job.
 *
 * Sections are therefore wrapped. A crash inside a section is a failure of that
 * section, not of the suite, and everything after it still runs.
 */
async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 160);
    fail++;
    failures.push(`${title} (threw)`);
    console.log(`  FAIL ${title} threw: ${msg}`);
  }
}

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "features-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function makeD1(sqlite) {
  return {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async first(c) { const r = sqlite.prepare(st.sql).get(...st.params); return c !== undefined && r ? r[c] : (r ?? null); },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
        async run() { const r = sqlite.prepare(st.sql).run(...st.params); return { success: true, meta: { changes: r.changes } }; },
      };
      return api;
    },
    async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

/**
 * Build an env. `vars` is spread in last so a test can add or omit the
 * deploy-time `CFPRESS_*` values without editing this helper.
 */
function makeEnv(sqlite, vars = {}) {
  const kv = new Map();
  const media = new Map();
  return {
    DB: makeD1(sqlite),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    MEDIA: {
      async get(k) { return media.has(k) ? { async text() { const e = media.get(k); return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: media.get(k) } : null; },
      async put(k, v) { media.set(k, v); return { key: k }; },
      async delete(k) { media.delete(k); },
    },
    ASSETS: assetsStub(),
    ...vars,
  };
}

const FEATURES_KEY = "cfpress.features";

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  // ⚠️ This line is load-bearing, and not for the reader.
  //
  // The reverse-validation tools (`tests/tools/_skeleton-inject.mjs`) run a
  // suite in a **worker thread** and stub `process.exit` so they can read the
  // verdict. Their harness does `import(suite).then(() => done(0))`, and
  // `import()` resolves as soon as the module body finishes — which is when
  // `main()` has merely been *called*, not awaited. So the harness can post its
  // "done" message and terminate the worker while `main()` is still waiting on
  // its first `await`.
  //
  // The race is won by whoever writes output first. A suite whose first
  // `console.log` sits behind an `await` loses it, and the tool reports
  // "no summary (aborted)" — which reads as "the guard did not go red", i.e.
  // exactly the false negative the tool exists to prevent. Every suite here
  // that predates this one prints its D1 path synchronously for the same
  // reason; this comment is the reason written down.
  //
  // So: log before the first `await`, always.
  console.log(`Using local D1: ${join(d1Dir, files[0])}\n`);

  // Idempotent cleanup up front, so a crashed previous run cannot leave a row
  // that makes the "no row" assertions below pass for the wrong reason — and so
  // the probe user's UNIQUE username is free to be re-created.
  //
  // This is the repo's standing rule for fixtures: a suite cleans up after
  // *itself* at both ends, because a crash skips only the second one.
  //
  // ⚠️ The delete is a **prefix** match (`LIKE 'cfpress.features%'`), not an
  // equality match on the exact key. That is not paranoia: the reverse-validation
  // tool injects a write to `cfpress.features-typo`, the suite then crashes
  // mid-run, and the leftover row makes the *next* run fail with a UNIQUE
  // violation at a line that has nothing to do with the first failure. An
  // equality-only cleanup turns one honest red into a confusing second one.
  const clearRow = () => sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key LIKE 'cfpress.features%'");
  // Snapshot the operator's own feature row first. `cfpress.features` is a
  // person's setting, not a fixture: deleting it silently resets every switch
  // they turned on, and the row only *looks* like suite state because the suite
  // rewrites it. Restore it at the end (see below).
  const prevFeatureRows = sqlite.prepare("SELECT * FROM settings WHERE site_id='default' AND key LIKE 'cfpress.features%'").all();
  clearRow();
  sqlite.exec("DELETE FROM site_users WHERE username='features-probe'");

  const worker = (await compileWorker()).default;
  const req = (env, path, init = {}) =>
    worker.fetch(new Request(`http://localhost${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
  const getFeatures = async (env) => (await req(env, "/api/v1/features", { headers: { Cookie: cookie } })).json();
  const save = (env, body) => req(env, "/api/v1/features", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // -----------------------------------------------------------------------
  console.log("0. auth");
  // -----------------------------------------------------------------------
  const bare = makeEnv(sqlite);
  {
    await req(bare, "/api/v1/health");
    const lr = await req(bare, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "change-me-now" }),
    });
    var cookie = lr.headers.get("set-cookie")?.split(";")[0] ?? "";
    checkTruthy("logged in", cookie.startsWith("cfpress_admin="));
  }

  // -----------------------------------------------------------------------
  await section("1. GET /features reports every switch with its provenance", async () => {
    const r = await req(bare, "/api/v1/features", { headers: { Cookie: cookie } });
    check("features list is 200", r.status, 200);
    const body = await r.json();
    check("one entry per declared switch", body.items.length, 3);
    check("the expected keys are present", body.items.map((i) => i.key).sort(), ["cache_mirror_kv", "theme_runtime_worker", "ui_locale_follow_site"]);
    check("all ship disabled", body.items.every((i) => i.enabled === false), true);
    check("with no var and no row the provenance is the default", body.items.every((i) => i.source === "default"), true);
    check("each entry names its var", body.items.every((i) => typeof i.var === "string" && i.var.startsWith("CFPRESS_")), true);
    check("each entry states its declared default", body.items.every((i) => i.default_on === false), true);
    check("each entry carries the inherited preview the screen shows", body.items.every((i) => i.inherited && typeof i.inherited.enabled === "boolean"), true);
    check("the settings key is exposed", body.settings_key, FEATURES_KEY);

    // The screen reads these exact field names. Naming them here is the point:
    // the screen has no types, so a rename is otherwise undetectable.
    const item = body.items[0];
    check("the entry shape the screen consumes is stable",
      ["key", "label", "var", "default_on", "enabled", "source", "inherited"].every((f) => f in item), true);
  });

  // -----------------------------------------------------------------------
  await section("2. both routes are gated, at two different layers", async () => {
  // ⚠️ Note which layer each assertion actually tests, because the two are not
  // interchangeable and the first draft conflated them.
  //
  // Every route below `requireAdmin` in `api.ts` is already behind a session
  // gate, so "an anonymous request is rejected" is satisfied by *any* route —
  // it never touches the features code. An assertion like that stays green even
  // if the features route is moved above the gate, which is the mistake worth
  // guarding.
  //
  // So there are two distinct claims:
  //   (a) these routes sit below the admin gate  -> anonymous is rejected
  //   (b) POST additionally requires `settings.manage` -> a signed-in
  //       non-holder is rejected. `can()` short-circuits on `role === "admin"`,
  //       so this can only be tested with a non-admin user.
  // (b) is the one that goes red if the `requirePermission` line is removed,
  // which is why the injector targets that line.

    const anonGet = await req(bare, "/api/v1/features");
    check("the route is not reachable anonymously (GET)", anonGet.status >= 400, true);
    checkTruthy("the anonymous GET is a real rejection, not a 200 with an error body", anonGet.status !== 200);

    const anonPost = await req(bare, "/api/v1/features", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "cache_mirror_kv", value: true }),
    });
    check("the route is not reachable anonymously (POST)", anonPost.status >= 400, true);
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM settings WHERE site_id='default' AND key='${FEATURES_KEY}'`).get();
    check("the rejected anonymous POST wrote nothing", Number(rows.n), 0);

    // (b) A signed-in user who lacks `settings.manage`.
    //
    // Created through the users API rather than with a hand-rolled INSERT, so
    // the password hashing stays the platform's business and this suite never
    // has to know how a stored hash is shaped. The role must not be `admin`:
    // `can()` short-circuits to true for admins, so an admin would be allowed
    // and the assertion could never go red.
    const created = await req(bare, "/api/v1/users", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "features-probe", password: "features-probe-pw-1", role: "author" }),
    });
    checkTruthy("the non-admin probe user was created", created.status < 300);

    sqlite.exec("DELETE FROM role_permissions WHERE role='author' AND permission='settings.manage'");

    const lr2 = await req(bare, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "features-probe", password: "features-probe-pw-1" }),
    });
    const probeCookie = lr2.headers.get("set-cookie")?.split(";")[0] ?? "";
    checkTruthy("the non-admin probe user can sign in", probeCookie.startsWith("cfpress_admin="));

    const forbidden = await req(bare, "/api/v1/features", {
      method: "POST",
      headers: { Cookie: probeCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "cache_mirror_kv", value: true }),
    });
    check("a signed-in user without settings.manage cannot write", forbidden.status, 403);
    const rows2 = sqlite.prepare(`SELECT COUNT(*) AS n FROM settings WHERE site_id='default' AND key='${FEATURES_KEY}'`).get();
    check("the forbidden write persisted nothing", Number(rows2.n), 0);

    // Reading is *not* permission-gated beyond the admin gate — deliberately,
    // the screen lists switches to anyone who can open the admin. Asserted so
    // the asymmetry is a decision rather than an accident.
    const readAllowed = await req(bare, "/api/v1/features", { headers: { Cookie: probeCookie } });
    check("reading the switch list needs only a session", readAllowed.status, 200);

    // The table is `site_users` (users are site-scoped), not `users`.
    sqlite.exec("DELETE FROM site_users WHERE username='features-probe'");
  });

  // -----------------------------------------------------------------------
  await section("3. a save round-trips and is observable", async () => {
    // Start from a clean table so this section exercises the **INSERT** path.
    // Section 4 later leaves a row behind for a different reason, and letting
    // that leak backwards would move this test onto the UPDATE branch without
    // saying so — the assertion would still pass while covering half the code.
    clearRow();

    const r = await save(bare, { key: "cache_mirror_kv", value: true });
    check("save is 200", r.status, 200);
    const body = await r.json();
    check("the save reports the new state", body.enabled, true);
    check("the save names the row as the source", body.source, "site");

    const after = await getFeatures(bare);
    check("the row is now the source", after.items.find((i) => i.key === "cache_mirror_kv").source, "site");
    check("only the named switch moved", after.items.find((i) => i.key === "theme_runtime_worker").enabled, false);

    // One row, not one per switch — that is what keeps adding a switch a pure
    // code change with no migration.
    //
    // ⚠️ `rows[0]` is indexed only after asserting the length, and the parse is
    // guarded. Indexing an empty array throws, and an uncaught throw ends the
    // suite *before its summary line* — which the reverse-validation tool reads
    // as "aborted", i.e. as "the guard did not go red". The failure it would
    // hide is precisely the one this assertion exists to catch (a save that
    // wrote nothing), so the crash would mask its own red. Every multi-step
    // assertion below follows the same rule: assert the shape, then read it.
    const rows = sqlite.prepare(`SELECT value FROM settings WHERE site_id='default' AND key='${FEATURES_KEY}'`).all();
    check("exactly one settings row backs every switch", rows.length, 1);
    let parsed = null;
    try { parsed = rows.length ? JSON.parse(rows[0].value) : null; } catch { parsed = "<unparseable>"; }
    check("the row is a JSON object keyed by switch", parsed, { cache_mirror_kv: true });
  });

  // -----------------------------------------------------------------------
  await section("4. the three layers, tested one at a time", async () => {
  // Precedence is site row -> var -> default. Each layer gets its own env so a
  // passing assertion cannot be explained by a different layer agreeing.

    // Start clean: section 3 left a row, and the "var alone" claim below is only
    // about the site row being *absent*.
    clearRow();

    // Layer 2 alone: no site row for this switch, var present.
    const withVar = makeEnv(sqlite, { CFPRESS_CACHE_MIRROR_KV: "true", CFPRESS_THEME_RUNTIME_WORKER: "true" });
    const onlyVar = await getFeatures(withVar);
    const runtime = onlyVar.items.find((i) => i.key === "theme_runtime_worker");
    check("a var alone enables a switch", runtime.enabled, true);
    check("provenance names the var layer", runtime.source, "var");

    // Layer 3 alone: neither var nor row.
    const bareRuntime = (await getFeatures(bare)).items.find((i) => i.key === "theme_runtime_worker");
    check("with neither var nor row the declared default wins", bareRuntime.enabled, false);
    check("provenance names the default layer", bareRuntime.source, "default");

    // Layer 1 beats layer 2, in the direction that matters: off beats on.
    await save(withVar, { key: "theme_runtime_worker", value: false });
    const rowOff = await getFeatures(withVar);
    const rowOffItem = rowOff.items.find((i) => i.key === "theme_runtime_worker");
    check("a site row saying off beats a var saying on", rowOffItem.enabled, false);
    check("the source is the row", rowOffItem.source, "site");

    // Reset drops the site's opinion and the var reappears — not the default.
    const reset = await save(withVar, { key: "cache_mirror_kv", value: null });
    check("reset is 200", reset.status, 200);
    const resetBody = await reset.json();
    check("reset falls back to the var, not to the default", resetBody.enabled, true);
    check("reset reports the var as the source", resetBody.source, "var");

    // A row that predates a switch must not disable it. Simulated by writing a
    // row mentioning only the other key, then reading the unmentioned one on an
    // env whose var turns it on.
    sqlite.prepare("INSERT OR REPLACE INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1)")
      .run("set_rows_legacy", "default", FEATURES_KEY, JSON.stringify({ cache_mirror_kv: false }));
    const legacy = await getFeatures(withVar);
    const legacyRuntime = legacy.items.find((i) => i.key === "theme_runtime_worker");
    check("a row that predates a switch falls through to the var", legacyRuntime.enabled, true);
    check("and does not report the default", legacyRuntime.source, "var");
    // The mentioned key is still governed by the row.
    check("the mentioned key is still governed by the row", legacy.items.find((i) => i.key === "cache_mirror_kv").source, "site");
    clearRow();
  });

  // -----------------------------------------------------------------------
  await section("5. a corrupt row degrades instead of breaking the screen", async () => {
    clearRow();
    sqlite.prepare("INSERT OR REPLACE INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1)")
      .run("set_rows_corrupt", "default", FEATURES_KEY, "{not json at all");
    const r = await req(bare, "/api/v1/features", { headers: { Cookie: cookie } });
    check("the list still returns 200", r.status, 200);
    const body = await r.json();
    check("a corrupt row reads as no site opinion", body.items.every((i) => i.source !== "site"), true);
    clearRow();
  });

  // -----------------------------------------------------------------------
  await section("6. unknown keys are refused, not persisted", async () => {
  // Persisting a key nothing reads is the exact defect this repo keeps fixing,
  // so the API rejects it rather than storing it quietly.

    const r = await save(bare, { key: "not_a_real_switch", value: true });
    check("an unknown key is a 400", r.status, 400);
    const body = await r.json();
    checkTruthy("the error names the offending key", JSON.stringify(body).includes("not_a_real_switch"));
    const rows = sqlite.prepare(`SELECT value FROM settings WHERE site_id='default' AND key='${FEATURES_KEY}'`).all();
    check("nothing was written for the unknown key", rows.some((x) => String(x.value).includes("not_a_real_switch")), false);

    const missing = await save(bare, { value: true });
    check("a missing key is a 400", missing.status, 400);
  });

  // -----------------------------------------------------------------------
  await section("7. the admin screen is wired to the route it reads", async () => {
  // Cheap structural checks, but they are the difference between "the API
  // exists" and "an operator can reach it". The screen has no build step and no
  // types, so a missing nav entry or a renamed export is silent at runtime.

    const screenSrc = readFileSync(join(root, "public/admin/js/screens/features.js"), "utf8");
    checkTruthy("the screen default-exports a function taking the container", /export default async function features\(\s*\w+\s*\)/.test(screenSrc));
    checkTruthy("the screen calls the features endpoint", /["'`]features["'`]|\/features/.test(screenSrc));
    const indexSrc = readFileSync(join(root, "public/admin/js/screens/index.js"), "utf8");
    checkTruthy("the screen is registered in the screen index", /\bfeatures\b/.test(indexSrc));
    const navSrc = readFileSync(join(root, "public/admin/js/nav.js"), "utf8");
    checkTruthy("the screen has a nav entry", /key:\s*"features"/.test(navSrc));
    checkTruthy("the nav icon exists in the icon table", !/icon:\s*"sliders-horizontal"/.test(navSrc) || readFileSync(join(root, "public/admin/icons.js"), "utf8").includes('"sliders-horizontal"'));
  });

  // -----------------------------------------------------------------------
  await section("8. the row is updated, not duplicated, on a second save", async () => {
  // Section 3 asserts the INSERT branch (starting from a clean table). A save
  // onto an existing row takes the UPDATE branch, which is a different statement
  // with a different failure mode: get the key wrong there and you either
  // duplicate the row (UNIQUE violation on the next save) or write to a row
  // nothing reads. Pinned separately so neither branch stands in for the other.

    clearRow();
    await save(bare, { key: "cache_mirror_kv", value: true });
    const r2 = await save(bare, { key: "theme_runtime_worker", value: true });
    check("a second save is 200", r2.status, 200);
    const r3 = await save(bare, { key: "ui_locale_follow_site", value: true });
    check("a third save is 200", r3.status, 200);

    const rows = sqlite.prepare(`SELECT value FROM settings WHERE site_id='default' AND key='${FEATURES_KEY}'`).all();
    check("still exactly one row after three saves", rows.length, 1);
    // Same guard as section 3: never index before checking the shape, or a
    // failure here ends the suite before its summary and reads as "aborted".
    let parsed = null;
    try { parsed = rows.length ? JSON.parse(rows[0].value) : null; } catch { parsed = "<unparseable>"; }
    check("every declared switch lives in that one row", parsed, { cache_mirror_kv: true, theme_runtime_worker: true, ui_locale_follow_site: true });

    const state = await getFeatures(bare);
    check("every declared switch reads back on", state.items.every((i) => i.enabled === true), true);
    check("every one reports the row as its source", state.items.every((i) => i.source === "site"), true);
    clearRow();
  });

  clearRow();
  // Put the operator's feature row back (see the snapshot above).
  for (const r of prevFeatureRows) {
    const keys = Object.keys(r);
    try {
      sqlite.prepare(`INSERT INTO settings (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => r[k]));
    } catch { /* ok */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failures:", failures.join(", ")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
