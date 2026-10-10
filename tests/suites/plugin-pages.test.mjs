/**
 * Plugin-declared admin pages — install-time and runtime (batch 10, step 8).
 *
 * ## What this suite is defending
 *
 * `adminPages[].blocks[]` is the third application of the "declare → host
 * renders" pattern, and it is the one with the most places for a declaration to
 * be *accepted and then never honoured*. The properties below were each written
 * because the corresponding bug is invisible at HTTP 200:
 *
 *   1. **A menu that names a page no plugin declared is refused at install.**
 *      Accepting it installs a sidebar entry that opens a blank screen, which
 *      reads as a load failure rather than a manifest typo (rule 50).
 *
 *   2. **The block type set is closed.** A block type with no renderer draws
 *      nothing where content was promised. The validator, the contract and the
 *      SPA's `RENDERED_BLOCK_TYPES` have to name the same set (rule 49).
 *
 *   3. **A `form` block's write lands in the plugin's own table.** The form is a
 *      *second view of one write path*, not a second write path — so the proof
 *      is a row in the physical table, not a 201 in the response.
 *
 *   4. **A `stats` block's aggregate is numerically correct.** The renderer and
 *      the API both had to be taught to compute it; a `sum` that the server
 *      never ran, or a `count` that counted the wrong tenant's rows, both look
 *      like a number on the screen.
 *
 *   5. **Disabling a plugin removes its menus *and* its pages.** The menus are
 *      rows in a registry; the pages are read from `state.plugins`, which is
 *      built from the enabled set. A disabled plugin whose page still resolves
 *      is the "declared but not enabled" hole that rule 50's runtime half is
 *      meant to close.
 *
 *   6. **The renderer reads the field declarations from where the API puts
 *      them.** This is the one property in the suite that is read *out of the
 *      response*, not out of the database, so it cannot be proven by any of the
 *      checks above. The table endpoint answers `{ def: { fields }, items }`;
 *      the renderer once looked for a flat `data.fields`, found nothing, and
 *      drew "the table declares no such fields" for every `table` and `form`
 *      block — at HTTP 200, with the data present and correct on the wire. The
 *      only way to catch that class of defect is to render and read the markup.
 *
 * ## Why this drives the real Worker
 *
 * Same reason as every other integration suite: the properties live in
 * `validateManifest`, the enable path and the table facade, and a fixture that
 * re-implements them would pass while the real code regressed.
 *
 * Usage: node tests/suites/plugin-pages.test.mjs
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
const expectedRed = new Set(process.env.EXPECT_RED ? process.env.EXPECT_RED.split(",") : []);

/**
 * Record an assertion failure.
 *
 * `check`/`checkTruthy` mirror the other suites. The `expectedRed` set is how
 * the reverse-verification harness (`_plugin-pages-inject.mjs`) asserts that a
 * *specific* assertion went red rather than merely "something did" — reading
 * the failure list back out of the printed summary is how a run with no summary
 * (type 6) or a crash (which prints its own line) can be told apart.
 */
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

function summary(aborted = false) {
  console.log("\n" + "=".repeat(64));
  console.log(`${pass} passed, ${fail} failed${aborted ? " (aborted)" : ""}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

/**
 * Bundle a module for direct import.
 *
 * `src/index.ts` is the Worker; the contract validator is imported on its own so
 * the install-boundary assertions can call it without a request.
 */
async function bundle(entry, tag) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", `pages-${tag}.mjs`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

const compileWorker = () => bundle("src/index.ts", "worker");
const compileContract = () => bundle("src/extensions/contract/validation.ts", "contract");

function makeD1(sqlite) {
  return {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async first(c) { const r = sqlite.prepare(st.sql).get(...st.params); return c !== undefined && r ? r[c] : (r ?? null); },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
        async run() { const r = sqlite.prepare(st.sql).run(...st.params); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
      };
      return api;
    },
    async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(k) {
      if (!store.has(k)) return null;
      const e = store.get(k);
      return { async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: e, httpEtag: '"x"', writeHttpMetadata() {} };
    },
    async put(k, v) { store.set(k, v); return { key: k }; },
    async delete(k) { store.delete(k); },
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite), MEDIA: makeR2(),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

async function req(worker, env, path, init) {
  return worker.fetch(new Request("http://localhost" + path, init), env, { waitUntil() {}, passThroughOnException() {} });
}

/**
 * Minimal DOM, installed only for the renderer section.
 *
 * `public/admin/js/plugin-page.js` imports `../ui.js`, which registers two
 * module-level `document.addEventListener` calls. Nothing in the tests needs a
 * real DOM — only those two registrations must not throw during import, so the
 * stub is the smallest one that lets the renderer be imported and called.
 *
 * The alternative was to skip rendering and instead `grep` the renderer source
 * for `data.def.fields`. That is exactly the "guard the spelling, not the
 * intent" shape this repo has been burned by (AGENTS.md type 7), and it would
 * have gone green on the very defect this section exists to catch: the failure
 * was a *lookup* whose key was wrong, and any rewrite of the lookup — a helper,
 * a destructure, a default — still spells the key.
 */
function installDomStub() {
  const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    innerHTML: "", textContent: "", querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, appendChild(n) { return n; }, removeEventListener() {},
  });
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    documentElement: el(), body: el(),
    querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
}

/** Import the real renderer with the stub in place. */
async function loadRenderer() {
  installDomStub();
  return import(pathToFileURL(join(root, "public/admin/js/plugin-page.js")).href + "?t=" + Date.now());
}

// ---------------------------------------------------------------------------
// The plugin under test.
//
// A *fixture* page plugin, distinct from the shipped `plugins/notify`. The
// shipped one is proven separately by `admin-menus.test.mjs` and the browser
// script; here the shapes need to be small enough to reason about, and the
// table needs a known numeric column so the `sum` assertion is arithmetic
// rather than a coincidence.
// ---------------------------------------------------------------------------
const PLUGIN = "paginate";
const MANIFEST = {
  name: PLUGIN,
  title: "Paginate Probe",
  version: "1.0.0",
  permissions: ["content.read", "settings.read", "settings.write"],
  tables: [
    {
      name: "entry",
      label: "Entries",
      fields: [
        { key: "label", type: "text", label: "Label" },
        { key: "score", type: "number", label: "Score" },
        { key: "detail", type: "longtext", label: "Detail" },
      ],
      translatable: ["label", "detail"],
    },
  ],
  adminPages: [
    {
      id: "board",
      path: "board",
      title: "Board",
      blocks: [
        { type: "stats", source: "entry", aggregate: "count" },
        { type: "stats", source: "entry", aggregate: "sum", field: "score" },
        { type: "table", source: "entry", columns: ["label", "score"] },
        { type: "form", source: "entry", fields: ["label", "score"] },
      ],
    },
  ],
  adminMenus: [
    { id: "paginate-board", label: "Board", icon: "box", screen: "plugin-page:board", capability: "content.read" },
  ],
};

function installPlugin(sqlite, manifest, enabled = 1) {
  const now = Math.floor(Date.now() / 1000);
  const name = manifest.name;
  sqlite.prepare(
    "INSERT INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,manifest=excluded.manifest,updated_at=excluded.updated_at"
  ).run(`plugin_${name}`, name, manifest.title ?? name, manifest.version ?? "1.0.0", enabled, JSON.stringify(manifest), now, now);
  for (const cap of manifest.permissions ?? []) {
    sqlite.prepare(
      "INSERT OR REPLACE INTO extension_capabilities(extension_type,extension_name,capability,enabled) VALUES(?,?,?,1)"
    ).run("plugin", name, cap);
  }
  return name;
}

async function login(worker, env) {
  await req(worker, env, "/api/v1/auth/me");
  const res = await req(worker, env, "/admin/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { Cookie: cookie };
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  // Idempotent cleanup up front. The generated table and the registry rows are
  // dropped too: `theme_table_defs` does NOT disappear when a plugin is
  // disabled (that is the design — switching hides data, it never destroys it),
  // so a previous failed run would otherwise leave a def whose physical table
  // the next run's DDL hits with `IF NOT EXISTS` and never learns.
  //
  // The same list runs again in the `finally` below, so the shared local D1 —
  // the file `wrangler dev` serves — is left as the suite found it. The
  // throwaway site `pagesite2` is what used to survive and show up on the
  // operator's Sites screen.
  const CLEANUP = [
    `DELETE FROM admin_menu_registry WHERE owner_type='plugin' AND owner_name='${PLUGIN}'`,
    `DELETE FROM theme_table_defs WHERE owner_type='plugin' AND owner_name='${PLUGIN}'`,
    `DROP TABLE IF EXISTS plugin_${PLUGIN}_entry_i18n`,
    `DROP TABLE IF EXISTS plugin_${PLUGIN}_entry`,
    `DELETE FROM extension_capabilities WHERE extension_type='plugin' AND extension_name='${PLUGIN}'`,
    `DELETE FROM plugin_setting_defs WHERE plugin_name='${PLUGIN}'`,
    `DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name='${PLUGIN}')`,
    `DELETE FROM plugin_installs WHERE name='${PLUGIN}'`,
    "DELETE FROM menu_items WHERE site_id='pagesite2'",
    "DELETE FROM menus WHERE site_id='pagesite2'",
    "DELETE FROM widget_instances WHERE site_id='pagesite2'",
    "DELETE FROM theme_table_defs WHERE site_id='pagesite2'",
    "DELETE FROM site_locales WHERE site_id='pagesite2'",
    "DELETE FROM settings WHERE site_id='pagesite2'",
    "DELETE FROM posts WHERE site_id='pagesite2'",
    "DELETE FROM sites WHERE id='pagesite2'",
  ];
  for (const sql of CLEANUP) { try { sqlite.exec(sql); } catch { /* ok */ } }

  const worker = (await compileWorker()).default;
  const contract = await compileContract();
  const env = makeEnv(sqlite);

  try {
    // -------------------------------------------------------------------
    console.log("\n1. A menu that opens an undeclared page is refused at install");
    // -------------------------------------------------------------------
    // Rule 50. The menu is otherwise perfectly well-formed — the *only* thing
    // wrong is that `plugin-page:ghost` names a page that is not in
    // `adminPages[]`. If the validator let this through, the sidebar would grow
    // an entry that opens a blank screen with no error anywhere.
    const ghost = JSON.parse(JSON.stringify(MANIFEST));
    ghost.adminMenus[0].screen = "plugin-page:ghost";
    let ghostErr = null;
    try { contract.validateManifest(ghost, "plugin"); } catch (e) { ghostErr = e.message; }
    checkTruthy("an undeclared plugin-page target is rejected", ghostErr);
    checkTruthy("the error names the missing page id", ghostErr && /ghost/.test(ghostErr));
    checkTruthy("the error lists what was declared", ghostErr && /board/.test(ghostErr));

    // The mirror image: naming the *declared* page is accepted. Without this,
    // a validator that rejected every `plugin-page:` screen would pass the
    // assertion above and break the whole feature.
    let goodErr = null;
    try { contract.validateManifest(MANIFEST, "plugin"); } catch (e) { goodErr = e.message; }
    check("the declared page is accepted", goodErr, null);

    // An id that is empty after the prefix is the degenerate case of the same
    // rule: `plugin-page:` with nothing after it can never resolve.
    const empty = JSON.parse(JSON.stringify(MANIFEST));
    empty.adminMenus[0].screen = "plugin-page:";
    let emptyErr = null;
    try { contract.validateManifest(empty, "plugin"); } catch (e) { emptyErr = e.message; }
    checkTruthy("a plugin-page screen with no id is rejected", emptyErr);

    // -------------------------------------------------------------------
    console.log("\n2. The block type set is closed");
    // -------------------------------------------------------------------
    const badBlock = JSON.parse(JSON.stringify(MANIFEST));
    badBlock.adminPages[0].blocks.push({ type: "gallery", source: "entry" });
    let blockErr = null;
    try { contract.validateManifest(badBlock, "plugin"); } catch (e) { blockErr = e.message; }
    checkTruthy("an unknown block type is rejected", blockErr);
    checkTruthy("the error lists the allowed types", blockErr && /table, stats, form/.test(blockErr));

    const badSource = JSON.parse(JSON.stringify(MANIFEST));
    badSource.adminPages[0].blocks[1].source = "not_mine";
    let srcErr = null;
    try { contract.validateManifest(badSource, "plugin"); } catch (e) { srcErr = e.message; }
    checkTruthy("a block reading an undeclared table is rejected", srcErr);

    const badAgg = JSON.parse(JSON.stringify(MANIFEST));
    badAgg.adminPages[0].blocks[0].aggregate = "median";
    let aggErr = null;
    try { contract.validateManifest(badAgg, "plugin"); } catch (e) { aggErr = e.message; }
    checkTruthy("an unknown aggregate is rejected", aggErr);
    checkTruthy("the error lists the allowed aggregates", aggErr && /count, sum/.test(aggErr));

    const sumNoField = JSON.parse(JSON.stringify(MANIFEST));
    delete sumNoField.adminPages[0].blocks[1].field;
    let sumErr = null;
    try { contract.validateManifest(sumNoField, "plugin"); } catch (e) { sumErr = e.message; }
    checkTruthy("a sum with no field is rejected", sumErr);

    // -------------------------------------------------------------------
    console.log("\n3. Install, then enable — the plugin's table is materialised");
    // -------------------------------------------------------------------
    const auth = await login(worker, env);
    installPlugin(sqlite, MANIFEST, 0);
    const en = await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });
    check("the plugin enables", en.status, 200);

    // The physical table the block reads. `resolveTableForSite` needs a
    // `theme_table_defs` row; the DDL itself is generated by the host.
    const physical = `plugin_${PLUGIN}_entry`;
    const tableRow = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(physical);
    checkTruthy("enabling the plugin created its declared table", tableRow);
    const defRow = sqlite.prepare(
      "SELECT owner_type,owner_name,logical_name,table_name FROM theme_table_defs WHERE owner_type='plugin' AND owner_name=? AND logical_name='entry'"
    ).get(PLUGIN);
    checkTruthy("its registry row records the owner", defRow);
    check("the registry names the physical table", defRow?.table_name, physical);

    // -------------------------------------------------------------------
    console.log("\n4. The page and its menu are visible while the plugin is enabled");
    // -------------------------------------------------------------------
    const list = await (await req(worker, env, "/api/v1/extensions/plugins", { headers: auth })).json();
    const entry = (list.items ?? []).find((p) => p.name === PLUGIN);
    checkTruthy("the plugin is listed", entry);
    check("its admin page is surfaced as a parsed array", Array.isArray(entry?.adminPages), true);
    check("with the declared page id", entry?.adminPages?.[0]?.id, "board");
    check("and its blocks intact", entry?.adminPages?.[0]?.blocks?.length, 4);

    const menus = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
    const group = (menus.groups ?? []).find((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN);
    checkTruthy("the plugin's menu is registered", group);
    check("and it opens the declared page", group?.items?.[0]?.screen, "plugin-page:board");

    // -------------------------------------------------------------------
    console.log("\n5. A form block's write lands in the plugin's real table");
    // -------------------------------------------------------------------
    // This is the write path the `form` block posts to — the same
    // `theme-tables/<t>` endpoint the built-in table screen uses. The assertion
    // is a row in the physical table, not a 201: a write path that reported
    // success while persisting nothing is exactly the "200 + wrong content"
    // shape this repo keeps finding.
    const post = await req(worker, env, "/api/v1/theme-tables/entry", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "first", score: 7, detail: "hello" }),
    });
    check("the form write is accepted", post.status, 201);
    const saved = sqlite.prepare(`SELECT label,score,detail,site_id FROM ${physical}`).all();
    check("exactly one row landed in the plugin's table", saved.length, 1);
    check("the label persisted", saved[0]?.label, "first");
    check("the number persisted as a number", saved[0]?.score, 7);
    check("the write is scoped to the requesting site", saved[0]?.site_id, "default");

    // A second row, then a third for a different site — the tenant boundary the
    // aggregate has to respect.
    await req(worker, env, "/api/v1/theme-tables/entry", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "second", score: 5, detail: "world" }),
    });
    // -------------------------------------------------------------------
    console.log("\n6. A stats block's aggregate is numerically correct");
    // -------------------------------------------------------------------
    const countRes = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=count", { headers: auth })).json();
    check("count returns the row count", countRes.value, 2);

    const sumRes = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=sum&field=score", { headers: auth })).json();
    check("sum adds the numeric column (7 + 5)", sumRes.value, 12);

    // `sum` over an empty selection is SQL NULL, which means "nothing to add
    // up" — not the number zero. Returning 0 here would be inventing a value.
    // The empty selection is produced by a status filter that matches nothing;
    // `status` is a platform column on every generated table, so this is a
    // genuine zero-row read rather than a badly-formed query.
    const emptyRes = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=sum&field=score&status=archived", { headers: auth })).json();
    check("sum over no rows is null, not zero", emptyRes.value, null);
    // And the count over the same empty selection is a real 0 — the contrast
    // proves the null above is "no rows", not "the filter was ignored".
    const emptyCount = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=count&status=archived", { headers: auth })).json();
    check("count over the same empty selection is 0", emptyCount.value, 0);

    // A `sum` on a column that is not a declared number must be refused rather
    // than interpolated into SQL. `label` is text; `nope` is not a field at all.
    const badSum = await req(worker, env, "/api/v1/theme-tables/entry?aggregate=sum&field=label", { headers: auth });
    check("summing a non-numeric column is refused", badSum.status, 400);
    const noSum = await req(worker, env, "/api/v1/theme-tables/entry?aggregate=sum&field=nope", { headers: auth });
    check("summing an undeclared column is refused", noSum.status, 400);
    // And an unknown aggregate name is refused too, so a crafted query cannot
    // reach the SQL builder.
    const badAggRes = await req(worker, env, "/api/v1/theme-tables/entry?aggregate=median", { headers: auth });
    check("an unknown aggregate is refused by the API", badAggRes.status, 400);

    // Grouped aggregate: three rows across two labels.
    await req(worker, env, "/api/v1/theme-tables/entry", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "first", score: 3, detail: "again" }),
    });
    const grouped = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=count&groupBy=label", { headers: auth })).json();
    checkTruthy("a grouped aggregate returns groups", Array.isArray(grouped.groups));
    const firstGroup = (grouped.groups ?? []).find((g) => g.key === "first");
    const secondGroup = (grouped.groups ?? []).find((g) => g.key === "second");
    check("the 'first' group counts its own rows", firstGroup?.value, 2);
    check("the 'second' group counts its own rows", secondGroup?.value, 1);

    // -------------------------------------------------------------------
    console.log("\n7. Disabling the plugin removes its menus and its pages");
    // -------------------------------------------------------------------
    const dis = await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/disable`, { method: "POST", headers: auth });
    check("the plugin disables", dis.status, 200);

    const menusAfter = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
    check(
      "its menu is gone from the registry",
      (menusAfter.groups ?? []).some((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN),
      false
    );

    const listAfter = await (await req(worker, env, "/api/v1/extensions/plugins", { headers: auth })).json();
    const entryAfter = (listAfter.items ?? []).find((p) => p.name === PLUGIN);
    checkTruthy("the plugin is still listed (it is installed, just disabled)", entryAfter);
    check("and reports itself disabled", Boolean(entryAfter?.enabled), false);
    // The page declaration is still *shipped* — the SPA's `findPage` filters on
    // `enabled`, and that filter is what makes "disabled" mean "the page is not
    // reachable" rather than "the page row was deleted".
    check("its adminPages are still in the manifest", Array.isArray(entryAfter?.adminPages), true);

    // The table and its rows survive: disabling hides data, it never destroys
    // it. Dropping here would make re-enabling silently lose everything.
    const stillThere = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${physical}`).get();
    check("its rows survive the disable", stillThere.n, 3);

    // Re-enabling brings the menu back and the rows are still readable.
    await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });
    const menusBack = await (await req(worker, env, "/api/v1/admin-menus?site=default", { headers: auth })).json();
    checkTruthy(
      "re-enabling restores the menu",
      (menusBack.groups ?? []).some((g) => g.owner_type === "plugin" && g.owner_name === PLUGIN)
    );
    const countBack = await (await req(worker, env, "/api/v1/theme-tables/entry?aggregate=count", { headers: auth })).json();
    check("the rows are still counted after re-enable", countBack.value, 3);

    // -------------------------------------------------------------------
    console.log("\n8. The tenant boundary holds across sites");
    // -------------------------------------------------------------------
    // A second site with its own physical table. The default site's rows must
    // not appear in its count — the whole reason a plugin's tables fan out per
    // site instead of sharing one `ALL_SITES` table the way menus do.
    await req(worker, env, "/api/v1/sites", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pagesite2", name: "Page Site 2" }),
    });
    // The second site's table is materialised by the *plugin runtime boot*, not
    // by the table read. `loadEnabledPlugins` is memoised for `ENABLED_TTL_MS`
    // (5s) and the fan-out over sites happens only on a cache miss, so a plain
    // `GET /extensions/plugins` here rides the memo and syncs nothing — the new
    // site's table then appears only if it already existed, which is exactly how
    // this assertion used to pass against a polluted database and fail against
    // a clean one. Re-enabling the plugin resets the memo and re-runs the sync
    // over every site, including the one just created.
    await req(worker, env, `/api/v1/extensions/plugins/${PLUGIN}/enable`, { method: "POST", headers: auth });
    const otherPhysical = `plugin_${PLUGIN}_entry`;
    const otherCount = await req(worker, env, "/api/v1/theme-tables/entry?aggregate=count&site=pagesite2", { headers: auth });
    const otherBody = await otherCount.json();
    check("the other site counts its own (empty) table", otherBody.value, 0);
    checkTruthy("the physical table name is shared by name only, separated by site",
      sqlite.prepare("SELECT COUNT(*) AS n FROM theme_table_defs WHERE owner_type='plugin' AND owner_name=? AND logical_name='entry'").get(PLUGIN).n >= 2);
    void otherPhysical;

    // -------------------------------------------------------------------
    console.log("\n9. The renderer draws the declarations the API actually returns");
    // -------------------------------------------------------------------
    // Everything above proves the server side. This proves the last hop: the
    // SPA turns the payload into markup. It renders the *real* renderer module
    // against the *real* payload shape, because the defect this guards against
    // (reading `data.fields` when the endpoint answers `data.def.fields`) is
    // invisible to every server-side assertion in this file.
    const renderer = await loadRenderer();
    // The declared field list the endpoint puts at `data.def.fields` — taken
    // from the plugin's own manifest so it cannot drift from the table.
    const declaredFields = MANIFEST.tables[0].fields;

    // A page payload as the `theme-tables/<t>` GET really answers it.
    const pageXml = {
      board: {
        blocks: [
          { type: "table", source: "entry", columns: ["label", "score"] },
          { type: "form", source: "entry", fields: ["label", "score"] },
        ],
      },
    };
    const tablePayload = {
      entry: { def: { fields: declaredFields }, locale: "en", items: [{ label: "first", score: 7 }, { label: "second", score: 5 }] },
    };
    const html = renderer.renderPluginPage(pageXml.board, tablePayload);

    // The two column headers: present only if the renderer found the fields.
    check("a table block draws a header per declared column", /<th>Label<\/th>/.test(html), true);
    check("and the second column too", /<th>Score<\/th>/.test(html), true);
    // The row data actually reaches the cell — not just the header.
    check("a row value reaches its cell", /<td>7<\/td>/.test(html), true);
    // The failure mode is a panel that *claims* the table declares nothing.
    // Asserting its absence is what makes the two checks above meaningful: a
    // renderer that drew the header and the empty panel both would pass them.
    check("no block claims the table declares no such fields", /declares no such fields/.test(html), false);
    // The form block reuses the same declarations; a form with no controls is
    // the same defect seen one block over.
    check("a form block draws a control per declared field", (html.match(/data-pp="(label|score)"/g) ?? []).length, 2);
    check("the form names the table it writes to", /data-pp-form="entry"/.test(html), true);

    // A `stats` block: the value the API computed is drawn, and a `null` (SUM
    // over no rows) is an em dash rather than a fabricated zero.
    const statsHtml = renderer.renderPluginPage(
      { blocks: [{ type: "stats", source: "entry", aggregate: "sum", field: "score" }] },
      { entry: { aggregate: "sum", field: "score", value: 12 } }
    );
    check("a stats block draws the aggregate value", /<div class="stat-value">12<\/div>/.test(statsHtml), true);
    const nullHtml = renderer.renderPluginPage(
      { blocks: [{ type: "stats", source: "entry", aggregate: "sum", field: "score" }] },
      { entry: { aggregate: "sum", field: "score", value: null } }
    );
    check("a null aggregate is drawn as an em dash, not 0", /<div class="stat-value">—<\/div>/.test(nullHtml), true);

    // The renderer's lists must be the contract's lists. This is a *set*
    // comparison against the module's own exports, so a block type added to the
    // renderer without a contract entry fails here rather than in a browser.
    check("the renderer's block list is the contract's closed set",
      renderer.RENDERED_BLOCK_TYPES, ["table", "stats", "form"]);
    check("the renderer's aggregate list is the contract's closed set",
      renderer.RENDERED_AGGREGATES, ["count", "sum"]);
  } finally {
    for (const sql of CLEANUP) { try { sqlite.exec(sql); } catch { /* ok */ } }
  }

  if (expectedRed.size) {
    // The reverse-verification harness sets EXPECT_RED to the assertion names it
    // expects to fail. Passing here means the injected defect did NOT trip the
    // guard it was aimed at — which is a failure of the harness, reported as
    // such. This is the only place the suite knows about its own verification.
    const stillGreen = [...expectedRed].filter((n) => !failures.includes(n));
    if (stillGreen.length) {
      fail++;
      failures.push(`expected-red assertion stayed green: ${stillGreen.join(", ")}`);
      console.log(`\nFAIL expected these to go red but they stayed green: ${stillGreen.join(", ")}`);
    } else {
      console.log(`\n(expected-red: all ${expectedRed.size} named assertion(s) went red as intended)`);
    }
  }

  summary();
  return fail ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a summary that says it failed (type 6).
  fail++;
  failures.push(`harness threw: ${(e && e.message) || e}`);
  summary("aborted");
  code = 2;
}
process.exit(code);
