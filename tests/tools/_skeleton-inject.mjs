/**
 * Reverse-validation for the system-skeleton guards (§10 rules 41–45).
 *
 * ## What this proves
 *
 * `architecture.test.mjs` and `_schema-scope.mjs` now assert the *shape* of the
 * system skeleton: the schema declaration, the language structure, the hook
 * contract, the domain event contract. A guard that has never been seen to fail
 * is indistinguishable from no guard at all — this repo has already shipped
 * seven false greens, and every one of them was a check whose red state nobody
 * had ever looked at.
 *
 * So this tool injects a specific, realistic defect for each guard, asserts the
 * **expected** assertion goes red, then restores and asserts the tree is
 * pristine again.
 *
 * ## The two traps this tool itself avoids (both were real bugs)
 *
 * 1. **Byte count cannot see an equal-length replacement.** `"site"` →
 *    `"sote"` is the same length, so a byte-count guard prints "nothing
 *    changed" while the injection *did* land — a false negative in the tool
 *    that exists to prevent false negatives. So the before/after comparison is
 *    a **content hash** (SHA-256).
 * 2. **A snapshot taken from a dirty tree restores a dirty tree.** If a
 *    previous run left an injected file behind, "restore" faithfully restores
 *    the corruption. So `assertPristine()` runs **before** the snapshot *and*
 *    **after** the restore.
 *
 * ## Why it is not in `npm test`
 *
 * It is a tool, not a suite: it mutates the working tree and shells out to the
 * suites. Same category as `_eshop-inject.mjs` and `_i18n-browser.cjs`.
 *
 * Usage: node tests/tools/_skeleton-inject.mjs
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href);
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const normalize = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

const SCHEMA = join(ROOT, "src/extensions/contract/schema.ts");
const EVENTS = join(ROOT, "src/extensions/contract/events.ts");
const ARCH = join(ROOT, "tests/suites/architecture.test.mjs");
const SCOPE = join(ROOT, "tests/tools/_schema-scope.mjs");
const MANIFEST = join(ROOT, "src/extensions/contract/manifest.ts");
const VALIDATION = join(ROOT, "src/extensions/contract/validation.ts");
// Batch 16: the block attribute contract and its two consumers. The contract
// exists because the editor wrote `attrs.text` for every block while the
// renderer read a different attribute per type, so six of twelve blocks
// rendered empty at HTTP 200.
const BLOCKS = join(ROOT, "src/rendering/blocks.ts");
const FRONTEND = join(ROOT, "src/platform/frontend.ts");
const BLOCK_FIELDS = join(ROOT, "public/admin/js/block-fields.js");
const MEDIA_PICKER = join(ROOT, "public/admin/js/media-picker.js");
const MEDIA_SCREEN = join(ROOT, "public/admin/js/screens/media.js");
const CORE_PACK = join(ROOT, "src/platform/i18n/core-pack.ts");
// Deleting a site walks `PURGE_ON_SITE_DELETE`, a list `contract/schema.ts`
// derives from the per-table `onSiteDelete` policy. The platform function takes
// that list as a required parameter (it may not import `extensions/`), so the
// defect this scenario injects is "the caller called it with a list that loops
// zero times" — the historical shape, verbatim.
const SITES = join(ROOT, "src/platform/sites.ts");
const PACKS = join(ROOT, "src/platform/i18n/packs.ts");
const EDITOR_SCREEN = join(ROOT, "public/admin/js/screens/editor.js");
const API = join(ROOT, "src/api.ts");
// The admin's interface-language preference. One server fact with two
// client-side readers — the header dropdown ticks from module state, the
// Languages screen re-reads the server — so "one writer, and it reloads the
// dictionary" is the invariant, and `languages.js` writing it itself is the
// defect that made the two disagree on screen.
const ADMIN_I18N = join(ROOT, "public/admin/js/i18n.js");
const LANGUAGES_SCREEN = join(ROOT, "public/admin/js/screens/languages.js");
// The themes screen reads per-site theme usage out of the themes payload. The
// map lives at the response level, not on each item — reading it off the item
// is silently `undefined`, so every card claims "Not in use" and the uninstall
// click lands on the endpoint's 409 naming a site the UI just called unused.
const THEMES_SCREEN = join(ROOT, "public/admin/js/screens/themes.js");
// The deploy-time layer of the feature switches. Editing it is what an operator
// does to turn a capability on for every site at once, so it is the half of the
// switch definition that no source-level guard would otherwise see.
const WRANGLER = join(ROOT, "wrangler.jsonc");
// The deploy-time half of "what ships": this script decides which of
// `content/themes/` reaches `public/themes/`, and everything under `public/` is
// uploaded verbatim by `wrangler deploy`. It mirrored the whole directory once,
// which put the test fixture theme on the public internet.
const SYNC_THEMES = join(ROOT, "scripts/sync-bundled-themes.mjs");
const FIXTURE_LEAK = join(ROOT, "public/themes/fixture/theme.json");
// The shipped theme's manifest. Its `locales[]` is a claim about what the theme
// ships, and the only thing that can check the claim is the pack directory.
const THEME_MANIFEST = join(ROOT, "content/themes/default/theme.json");
// Rule 69's two halves: the boot chain that chains the seeder to the installer,
// and the installer whose predicate decides whether a theme is already
// installed.
const INDEX = join(ROOT, "src/index.ts");
const CAPABILITIES = join(ROOT, "src/extensions/theme/capabilities.ts");
// Batch C: the admin prefix. Two independent invariants, each with a historical
// shape worth injecting:
//   - the SPA must build every URL from the injected base, never hard-code
//     `/api/v1/…` (that is what broke the moment the prefix became movable);
//   - the session cookie must be named `cfpress_admin` and scoped to the admin
//     prefix, not `cfpress_session` with `Path=/` (which put the admin session
//     on every front-end request and left the two session kinds indistinguishable).
const ADMIN_STATE = join(ROOT, "public/admin/js/state.js");
const AUTH = join(ROOT, "src/platform/auth.ts");
// The other identity: the front-end member. It is deliberately a *different*
// module from `auth.ts` — the point of batch D is that the two identities are
// structurally apart, so the two live in two files that do not import each
// other's session table.
const MEMBERS = join(ROOT, "src/platform/members.ts");
// The migration that creates the member tables. `member_sessions` carrying its
// own `site_id` is load-bearing: `deleteSite`'s purge loop is
// `WHERE site_id=?`, so a session table without the column is unreachable.
const MIGRATION_0022 = join(ROOT, "content/migrations/0022_front_members.sql");
// The Sites screen. Its per-row preview URL is built from the site's own prefix
// or host — and from the site's own, not the current one, because a browser
// cannot count rows and the screen has no other source for the numbers.
const SITES_SCREEN = join(ROOT, "public/admin/js/screens/sites.js");

/**
 * The scenarios. Each names the suite to run and the assertion (a substring of
 * its `ok`/`FAIL` name) that must flip.
 *
 * `flip` is the *whole* point: without it the tool proves only "some test was
 * red", not "the guard for this defect was red". A guard that fails for an
 * unrelated reason is still broken.
 */
const SCENARIOS = [
  {
    label: "a table is removed from the schema declaration",
    file: SCHEMA,
    before: [
      '  { table: "rewrites", tenant: "site", locale: null, onSiteDelete: "purge", note: "rewrite rules are per site" },\n',
    ],
    after: [""],
    runs: [["tests/tools/_schema-scope.mjs", "no table is missing from the schema declaration"]],
  },
  {
    label: "a tenant-scoped table is misclassified as platform-global",
    file: SCHEMA,
    before: [
      '{ table: "settings", tenant: "site", locale: null, onSiteDelete: "purge", note: "site settings (UNIQUE(site_id,key))" }',
    ],
    after: [
      '{ table: "settings", tenant: "platform", locale: null, note: "site settings (UNIQUE(site_id,key))" }',
    ],
    runs: [["tests/tools/_schema-scope.mjs", "no platform-global table carries a site_id column"]],
  },
  {
    label: "a derived list is hand-written instead of derived",
    file: SCHEMA,
    before: [
      "export const TENANT_TABLES = PLATFORM_SCHEMA\n  .filter((t) => t.tenant === \"site\")\n  .map((t) => t.table);",
    ],
    after: [
      "export const TENANT_TABLES = [\n  \"settings\",\n].filter(Boolean);",
    ],
    runs: [["tests/suites/architecture.test.mjs", "TENANT_TABLES is derived from PLATFORM_SCHEMA, not hand-written"]],
  },
  {
    label: "the same table is declared twice",
    file: SCHEMA,
    before: [
      '  { table: "menus", tenant: "site", locale: null, onSiteDelete: "purge", note: "menu containers; items carry the locale" },\n',
    ],
    after: [
      '  { table: "menus", tenant: "site", locale: null, onSiteDelete: "purge", note: "menu containers; items carry the locale" },\n' +
        '  { table: "menus", tenant: "platform", locale: null, note: "a contradictory second answer" },\n',
    ],
    runs: [["tests/suites/architecture.test.mjs", "no table is declared twice"]],
  },
  {
    label: "a value is added to the locale-scoped event list",
    file: EVENTS,
    before: ['  "SiteDefaultLocaleChanged",\n] as const;'],
    after: ['  "SiteDefaultLocaleChanged",\n  "PostPublishd",\n] as const;'],
    runs: [["tests/suites/architecture.test.mjs", "every locale-scoped event is a declared domain event"]],
  },
  {
    label: "a domain event is duplicated",
    file: EVENTS,
    before: ['  // -- media ----------------------------------------------------------------\n  "MediaUploaded",'],
    after: ['  // -- media ----------------------------------------------------------------\n  "MediaUploaded",\n  "MediaUploaded",'],
    runs: [["tests/suites/architecture.test.mjs", "no domain event is declared twice"]],
  },
  {
    label: "a domain event is added to the hook list (contracts collapsed)",
    file: join(ROOT, "src/extensions/contract/hooks.ts"),
    before: ['export const DECLARABLE_HOOKS = ['], 
    after: ['export const DECLARABLE_HOOKS = [\n  "PostPublished",'],
    runs: [["tests/suites/architecture.test.mjs", "no domain event is smuggled into the hook list"]],
  },
  {
    label: "a site-level fact is marked as carrying a language",
    file: EVENTS,
    before: ['  "PostTranslationCreated",\n  "SiteDefaultLocaleChanged",'],
    after: ['  "PostTranslationCreated",\n  "SiteDefaultLocaleChanged",\n  "SiteCreated",'],
    runs: [["tests/suites/architecture.test.mjs", "site-level facts are not marked locale-scoped"]],
  },
  {
    label: "the payload version fallback is removed",
    file: EVENTS,
    before: ['  return EVENT_PAYLOAD_VERSIONS[event] ?? 1;'],
    after: ['  return EVENT_PAYLOAD_VERSIONS[event] as number;'],
    runs: [["tests/suites/architecture.test.mjs", "payloadVersionOf has a total fallback"]],
  },
  {
    label: "a runtime-owned table is also declared as a platform table",
    file: SCHEMA,
    before: ['export const RUNTIME_TABLES = ["\\u005fcf_METADATA", "d1_migrations"] as const;'],
    after: ['export const RUNTIME_TABLES = ["\\u005fcf_METADATA", "d1_migrations", "locales"] as const;'],
    // Adding "locales" to the runtime list mutates the array in place from the
    // derived-export guard's point of view too, so more than one assertion can
    // go red; the one that *must* is the runtime/platform overlap.
    runs: [["tests/suites/architecture.test.mjs", "no runtime-owned table is also a declared platform table"]],
    alsoAccept: ["TENANT_TABLES is derived from PLATFORM_SCHEMA, not hand-written"],
  },
  {
    label: "an unknown language strategy is admitted by the vocabulary",
    file: MANIFEST,
    before: ['export const TABLE_LANGUAGE_STRATEGIES = ["none", "sidecar", "versioned"] as const;'],
    after: ['export const TABLE_LANGUAGE_STRATEGIES = ["none", "sidecar", "versioned", "sideways"] as const;'],
    // The failure is proved by the validator suite's own pinned statement; it
    // has no per-assertion name here, so this scenario only requires red.
    runs: [["tests/suites/manifest-validation.test.mjs", null]],
  },
  {
    label: "a doc code block names a test suite that does not exist",
    file: join(ROOT, "docs/guides/THEME-DEV.md"),
    before: ["node tests/suites/theme-fixture.test.mjs # 真主题渲染快照"],
    after: ["node tests/theme-deleted-long-ago.test.mjs # 真主题渲染快照"],
    runs: [["tests/suites/architecture.test.mjs", "every test path named in a doc code block exists on disk"]],
  },
  {
    // The second half of the doc guard: a `node <path>` command written in
    // *prose* (not in a code block). Prose is exempt from the fenced-block rule
    // so the history section can quote retired names — but a copy-pasteable
    // command is not history. `tests/_eshop-inject.mjs` survived batch 10
    // precisely here: deleted from disk, still named in two prose lines.
    label: "a doc tells the reader to run a `node` command that no file backs",
    file: join(ROOT, "AGENTS.md"),
    before: ["node tests/suites/launcher-parity.test.mjs"],
    after: ["node tests/suites/launcher-parity-GONE.test.mjs"],
    runs: [["tests/suites/architecture.test.mjs", "every `node <path>` command written in a doc points at a file that exists"]],
  },
  {
    // An icon name that is not in the table. `icons.js` falls back to the
    // `info` glyph, so the screen still renders and every other check in
    // `admin-spa.test.mjs` still passes — the button is simply wearing the
    // wrong picture. This is the "silent near-miss" shape: it was a real bug
    // in `account.js` (`icon("key-round")`, never defined) when the guard was
    // written, which is why the injection moves an *existing* name to a
    // slightly-wrong one rather than inventing a call site.
    label: "a screen asks for an icon name the icon table does not define",
    file: join(ROOT, "public/admin/js/screens/account.js"),
    before: ['icon("key-round")'],
    after: ['icon("key-round-not-a-real-icon")'],
    runs: [["tests/suites/admin-spa.test.mjs", 'every icon("...") name is defined in the icon table']],
  },
  {
    // The switch vocabulary is pinned to exactly one file because three readers
    // must agree on it (resolver, admin screen, `vars` name). A second copy is
    // how "saves fine, does nothing" gets in — the defect this repo has fixed
    // five times under the name "declared but never consumed".
    label: "the feature-switch vocabulary is declared a second time",
    file: join(ROOT, "src/extensions/contract/manifest.ts"),
    before: ['export const ALLOWED_ADMIN_SCREENS = ['],
    after: [
      'export const FEATURE_SWITCHES = [\n' +
        '  { key: "cache_mirror_kv", varName: "CFPRESS_CACHE_MIRROR_KV", defaultOn: true, label: "a rival copy" },\n' +
        '] as const;\n\n' +
        'export const ALLOWED_ADMIN_SCREENS = [',
    ],
    runs: [["tests/suites/architecture.test.mjs", "FEATURE_SWITCHES is defined in exactly one file"]],
  },
  {
    // `defaultOn` omitted is the quietest possible bug: `undefined` is falsy, so
    // the switch behaves as "off", which is usually correct — and the omission
    // is invisible until someone reads the definition expecting a stated choice.
    label: "a declared switch stops stating its default explicitly",
    file: join(ROOT, "src/shared/features.ts"),
    before: ['    varName: "CFPRESS_CACHE_MIRROR_KV",\n    defaultOn: false,'],
    after: ['    varName: "CFPRESS_CACHE_MIRROR_KV",'],
    runs: [["tests/suites/architecture.test.mjs", "every declared feature switch states its default explicitly"]],
  },
  {
    // A switch whose var is absent from `wrangler.jsonc` has no deploy-time
    // fallback, and the symptom is indistinguishable from a correct deploy:
    // `undefined` and `"false"` both resolve to off. It only surfaces when an
    // operator sets the var, deploys, and finds the switch unchanged — at which
    // point the config that "obviously" has the var is the last place they look.
    // The named assertion is the only observer, so it has to be pinned.
    label: "a switch loses its var from the deploy config",
    file: WRANGLER,
    before: ['    "CFPRESS_THEME_RUNTIME_WORKER": "false",\n    "CFPRESS_UI_LOCALE_FOLLOW_SITE": "false"\n'],
    after: ['    "CFPRESS_THEME_RUNTIME_WORKER": "false"\n'],
    runs: [["tests/suites/architecture.test.mjs", "every switch varName is declared in wrangler.jsonc vars"]],
  },
  {
    // The mirror image: a var left behind by a rename. Nothing reads it, so the
    // operator edits it, deploys, and watches a switch that no longer exists
    // change nothing at all.
    label: "the deploy config keeps a var no switch reads",
    file: WRANGLER,
    before: ['    "CFPRESS_UI_LOCALE_FOLLOW_SITE": "false"\n'],
    after: ['    "CFPRESS_UI_LOCALE_FOLLOW_SITE": "false",\n    "CFPRESS_UI_LOCALE_FROM_SITE": "false"\n'],
    runs: [["tests/suites/architecture.test.mjs", "wrangler.jsonc declares no var that no switch reads"]],
  },
  {
    // The drift that actually happened, reproduced: a field added to the
    // committed config and not to the real-ids copy every command runs against.
    // It survived two batches because an omitted var and `"false"` both resolve
    // to off. Pinned against the parity tool rather than the architecture suite
    // because the architecture suite only ever reads the committed file — it
    // cannot see the copy that ships.
    //
    // ⚠️ The injection lands in `wrangler.jsonc`, not `wrangler.local.jsonc`,
    // even though the historical drift was the other way round. The local file
    // is gitignored, so a scenario that wrote to it would depend on a file that
    // does not exist on a fresh clone, and — worse — a failed restore there
    // would take this account's real ids with it and go unreported, because
    // `assertPristine` only covers watched files. Diverging the committed side
    // trips the identical assertion with none of that risk.
    //
    // The observer is the same one as the next scenario's, and deliberately so:
    // the guard is "the derived file matches a fresh derivation", which every
    // kind of template edit trips. Two scenarios, one observer, two defects —
    // that is the honest shape, not a duplicated test.
    label: "the committed config and the generated config drift apart",
    file: WRANGLER,
    before: ['  "triggers": {"crons": ["*/5 * * * *"]},\n'],
    after: [''],
    runs: [["tests/tools/_config-parity.mjs", "wrangler.local.jsonc is exactly what the generator produces"]],
  },
  {
    // The same divergence, one level down and much easier to miss: the `vars`
    // block stays present on both sides but holds a different set of switches.
    // A key-set comparison at the top level would stay green for this, which is
    // why the guard compares the whole derived file rather than its keys.
    label: "the two configs disagree about which switches exist",
    file: WRANGLER,
    before: ['    "CFPRESS_CACHE_MIRROR_KV": "false",\n'],
    after: [''],
    runs: [["tests/tools/_config-parity.mjs", "wrangler.local.jsonc is exactly what the generator produces"]],
  },
  {
    // A switch that defaults to on is a feature nobody asked for, shipping to
    // every deploy. Two of the current switches gate a paid binding and a KV
    // write amplifier; the third narrows a documented default, so "on by
    // default" is wrong for all three.
    label: "a switch defaults to on",
    file: join(ROOT, "src/shared/features.ts"),
    before: ['    defaultOn: false,\n    label: "Mirror the content-cache version into KV",'],
    after: ['    defaultOn: true,\n    label: "Mirror the content-cache version into KV",'],
    runs: [["tests/suites/architecture.test.mjs", "every switch defaults to off"]],
  },
  {
    // `ui_locale_follow_site` is the only thing between "the operator asked for
    // a site-only language menu" and "the menu shows everything anyway". It is
    // the quietest kind of defect: the menu still renders, still switches
    // languages, and is simply the wrong set — so nothing looks broken. The
    // named assertion is the only observer.
    label: "the interface-language menu stops honouring ui_locale_follow_site",
    file: PACKS,
    before: ['  if (await featureEnabled(env, siteId, "ui_locale_follow_site")) {'],
    after: ['  if (false) {'],
    runs: [["tests/suites/i18n.test.mjs", "on: the menu lists the site's languages only"]],
  },
  {
    // If the API ever persists a key that `FEATURE_SWITCHES` does not declare,
    // the operator gets a switch that saves successfully and is never read.
    // That is the "declared but never consumed" family — already fixed five
    // times in this repo — so the rejection has to be pinned, not just written.
    //
    // Note which assertion this pins. Neutralizing the guard makes the route
    // report 400 anyway (there is a defensive read after it), so "an unknown key
    // is a 400" stays green and *the persistence assertion is what flips*. That
    // was a genuine correction: the first version of this scenario pinned the
    // status code and reported a false "did not go red". The lesson is the one
    // in §12 — the guard to pin is the one that can actually observe the defect.
    label: "the features API accepts a switch key it does not declare",
    file: join(ROOT, "src/api.ts"),
    before: ['  if (!FEATURE_SWITCHES.some((s) => s.key === key)) {\n    return ok({ error: `unknown feature switch: ${key}` }, 400);\n  }'],
    after: ['  if (false) {\n    return ok({ error: `unknown feature switch: ${key}` }, 400);\n  }'],
    runs: [["tests/suites/features.test.mjs", "nothing was written for the unknown key"]],
  },
  {
    // Removing this line does not make the route public — `requireAdmin` sits
    // above it — but it does let *any signed-in user* change a switch that
    // turns on paid features. The anonymous assertions in the suite stay green
    // when this line goes, which is exactly why the suite also creates a
    // non-admin user; that assertion is what this scenario pins.
    label: "the features write route drops its settings.manage check",
    file: join(ROOT, "src/api.ts"),
    before: ['if (path === "features" && method === "POST") {\n    if (!(await requirePermission(env, user, "settings.manage"))) return ok({ error: "Forbidden" }, 403);'],
    after: ['if (path === "features" && method === "POST") {\n    if (false) return ok({ error: "Forbidden" }, 403);'],
    runs: [["tests/suites/features.test.mjs", "a signed-in user without settings.manage cannot write"]],
  },
  {
    // The `settings` row is the site layer of the precedence chain, and the
    // resolver reads it under one fixed key (`FEATURE_SETTINGS_KEY`). If a write
    // stored the switches under a different key, the row would be written and
    // never read — a silent no-op, the shape this repo keeps fixing.
    //
    // The anchor is the **INSERT** branch deliberately. The UPDATE branch needs
    // a pre-existing row, and a scenario that depends on which branch a suite
    // happens to reach is fragile — the first draft used the UPDATE path and
    // tripped a UNIQUE violation instead of the intended assertion, which read
    // as "no summary" and proved nothing. The INSERT branch is exercised by
    // section 3, which saves onto a clean table.
    label: "a saved switch is written under the wrong settings key",
    file: join(ROOT, "src/api.ts"),
    before: ['.bind(await randomId(), siteId, FEATURE_SETTINGS_KEY, next).run();'],
    after: ['.bind(await randomId(), siteId, FEATURE_SETTINGS_KEY + "-typo", next).run();'],
    runs: [["tests/suites/features.test.mjs", "the row is now the source"]],
  },
  {
    // The dashboard's stat cards must arrive as data (`cards` from the API,
    // translated server-side, plugin-extendable). A client-side `stat("Posts")`
    // is a copy that will not translate and will not see plugin cards.
    label: "a hard-coded stat card reappears in the dashboard screen",
    file: join(ROOT, "public/admin/js/screens/dashboard.js"),
    before: ["  const cards = (d.cards || [])"],
    after: ["  const cards = (d.cards || [])\n  const legacy = stat(\"Posts\", 0);"],
    runs: [["tests/suites/architecture.test.mjs", "the dashboard screen carries no hard-coded stat cards"]],
  },
  {
    // The settings auto-form must have a rendering branch for every type in
    // ALLOWED_FIELD_TYPES. Deleting a branch silently degrades that type to a
    // text input — a declared select loses its choices, a boolean becomes
    // free text — with nothing else failing.
    label: "a settings-form type branch is deleted",
    file: join(ROOT, "public/admin/js/screens/theme-menu.js"),
    before: ['    case "boolean":'],
    after: [''],
    runs: [["tests/suites/architecture.test.mjs", "every allowed field type has a rendering branch in the settings form"]],
  },
  {
    // The editor's insert palette must be delivered by `GET /api/v1/blocks`
    // from the renderer's `CORE_BLOCKS`. A block-name literal in the SPA is a
    // second list guaranteed to drift (the hand-written palette had already
    // lost gallery/button/columns while the renderer kept supporting them).
    label: "a block-name literal reappears in the admin SPA",
    file: join(ROOT, "public/admin/js/screens/editor.js"),
    before: ["  // Never re-list block types here."],
    after: ["  // Never re-list block types here.\n  const legacy = [\"core/paragraph\", \"Paragraph\"];"],
    runs: [["tests/suites/architecture.test.mjs", "the admin SPA carries no block-name literals (palette comes from CORE_BLOCKS)"]],
  },
  {
    // The renderer reads one attribute per block type. Reading a *different*
    // one than the contract declares is exactly the defect class this guard
    // exists for: the block still renders, just with nothing in it.
    label: "the renderer reads an attribute the contract does not declare",
    file: FRONTEND,
    before: ['case"core/image":return a.url?'],
    after: ['case"core/image":return a.src?'],
    runs: [["tests/suites/architecture.test.mjs", "the renderer reads exactly the attributes each block declares"]],
  },
  {
    // A block the renderer supports but the palette no longer offers is a
    // block nobody can insert — the other direction of the same drift.
    label: "a renderer case loses its block declaration",
    file: BLOCKS,
    before: ['{ key: "alt", type: "text", labelKey: "core.block.field.imageAlt", fallback: "Alt text" }'],
    after: ['{ key: "caption", type: "text", labelKey: "core.block.field.imageAlt", fallback: "Alt text" }'],
    runs: [["tests/suites/architecture.test.mjs", "the renderer reads exactly the attributes each block declares"]],
  },
  {
    // A declared type with no control branch degrades to a text input, which is
    // how a declared media field silently becomes a URL box.
    label: "an attribute type loses its control branch",
    file: BLOCK_FIELDS,
    before: ['    case "url":\n'],
    after: ['    case "link":\n'],
    runs: [["tests/suites/architecture.test.mjs", "every attribute type has a control branch"]],
  },
  {
    // The exported list is what a reader trusts; if it drops a type the switch
    // still handles, the two tables disagree and nothing else notices.
    label: "the control module's exported type list drifts from the contract",
    file: BLOCK_FIELDS,
    before: ['export const RENDERED_ATTR_TYPES = ["text", "textarea", "url", "media", "media-list"];'],
    after: ['export const RENDERED_ATTR_TYPES = ["text", "textarea", "url", "media-list"];'],
    runs: [["tests/suites/architecture.test.mjs", "the control module's type list matches the contract's closed set"]],
  },
  {
    // A media-list without its item keys renders a field with no inputs at all:
    // the control has no way to invent `url`/`alt`, so the shape belongs in the
    // declaration.
    label: "a media-list attribute stops declaring its item keys",
    file: BLOCKS,
    before: [', required: true, itemKeys: MEDIA_ITEM_KEYS }]'],
    after: [', required: true }]'],
    runs: [["tests/suites/architecture.test.mjs", "every media-list attribute declares its item keys"]],
  },
  {
    // "One control" is a claim about the codebase. A screen that grows its own
    // copy is how three answers to the same question appear — and the two that
    // had no answer at all (the media custom-field types) is how they started.
    label: "a screen grows its own media control",
    file: MEDIA_SCREEN,
    before: ['import { mediaItem, mediaUrl } from "../media-picker.js";'],
    after: ['import { mediaItem, mediaUrl } from "../media-picker.js";\nconst legacyControl = `<div data-media-field><button data-media-pick>Choose</button></div>`;'],
    runs: [["tests/suites/architecture.test.mjs", "exactly one module emits the media control wrapper"]],
  },
  {
    // The read path checks the key's tenant before serving (rule 60), so a URL
    // assembled by hand is a 404 waiting for a filename with a slash in it. The
    // media screen had three of them before the picker owned the URL.
    label: "a screen hand-builds a /media/ URL again",
    file: MEDIA_SCREEN,
    before: ['function formatBytes(n) {'],
    after: ['const handBuiltUrl = `/media/${encodeURIComponent("uploads/default/x.png")}`;\nfunction formatBytes(n) {'],
    runs: [["tests/suites/architecture.test.mjs", "exactly one module builds a /media/ URL"]],
  },
  {
    // The URL builder itself: a key is one path segment, so it has to be
    // percent-encoded. Un-encoded, a key containing `/` becomes several segments
    // and the read path decodes a different key than the one that was stored.
    label: "the media URL stops encoding the object key",
    file: MEDIA_PICKER,
    before: ['  return key ? `/media/${encodeURIComponent(key)}` : "";'],
    after: ['  return key ? `/media/${key}` : "";'],
    runs: [["tests/suites/media-picker.test.mjs", "a key becomes one encoded path segment"]],
  },
  {
    // `t()` falls back to the English literal, so a key that does not exist is
    // silent: the screen renders correct-looking English while everything around
    // it is in the user's language.
    label: "a screen asks for a dictionary key nobody declared",
    file: EDITOR_SCREEN,
    before: ['t("core.editor.back", "Back")'],
    after: ['t("core.editor.backTypo", "Back")'],
    runs: [["tests/suites/architecture.test.mjs", "every key the admin asks for is declared in both core packs"]],
  },
  {
    // A key added to one pack only is the same defect from the other side: the
    // language that lacks it silently shows English.
    label: "a dictionary key is added to one core pack only",
    file: CORE_PACK,
    before: ['  "core.editor.edit": "Edit",\n'],
    after: ['  "core.editor.edit": "Edit",\n  "core.editor.englishOnly": "EN only",\n'],
    runs: [["tests/suites/architecture.test.mjs", "no key is declared in one core pack but not the other"]],
  },
  {
    // The reverse direction, scoped to the editor's namespace: a string that was
    // written into the dictionary and then never shown.
    label: "an editor dictionary key loses its call site",
    file: EDITOR_SCREEN,
    before: ['t("core.editor.duplicate", "Duplicate")'],
    after: ['"Duplicate"'],
    runs: [["tests/suites/architecture.test.mjs", "every editor dictionary key has a call site"]],
  },
  {
    // The autosave interval used to be cleared in two of the editor's exit
    // paths, which is how navigation came to be the missing one: a hand-rolled
    // `clearInterval` is the second cleanup path reappearing.
    label: "a screen clears the autosave timer by hand again",
    file: EDITOR_SCREEN,
    before: ['  stopAutosave();\n  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });'],
    after: ['  clearInterval(state.autosaveTimer);\n  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });'],
    runs: [["tests/suites/architecture.test.mjs", "only the shared helper clears the autosave timer"]],
  },
  {
    // Uninstalling the theme that renders a live site takes the site down with
    // it, so the endpoint refuses with a 409 that names the site. Removing the
    // guard is how an operator discovers their front page is gone.
    label: "theme uninstall accepts a theme a site is still using",
    file: API,
    before: ["  if(sites.length && !force) return ok({error:`still active on: ${sites.join(\", \")}`},409);"],
    after: [""],
    runs: [["tests/suites/theme-integration.test.mjs", "uninstalling the active theme is refused"]],
  },
  // The other half of uninstalling: what it removes *besides* the obvious three.
  // Each of these four was a real gap — the uninstall deleted the registry row,
  // the generated tables and the R2 files, and left admin menus pointing at the
  // dropped tables plus a phantom theme in the settings. §9 used to upload the
  // throwaway theme and uninstall it without ever activating it, so it owned
  // nothing and every "is X gone?" assertion passed on a build that removed
  // none of it. One scenario per line, because one line is one leak.
  {
    label: "theme uninstall leaves the theme's admin menus behind",
    file: API,
    before: ['  await clearOwnerMenusAllSites(env,"theme",name);'],
    after: [''],
    runs: [["tests/suites/theme-integration.test.mjs", "its admin menus are gone"]],
  },
  {
    label: "theme uninstall leaves the theme's setting definitions behind",
    file: API,
    before: ['  await env.DB.prepare("DELETE FROM theme_setting_defs WHERE theme_name=?").bind(name).run().catch(()=>{});'],
    after: [''],
    runs: [["tests/suites/theme-integration.test.mjs", "its setting definitions are gone"]],
  },
  {
    label: "theme uninstall leaves the theme's saved setting values behind",
    file: API,
    before: ['  await env.DB.prepare("DELETE FROM theme_settings WHERE theme_name=?").bind(name).run().catch(()=>{});'],
    after: [''],
    runs: [["tests/suites/theme-integration.test.mjs", "its saved setting values are gone"]],
  },
  {
    label: "theme uninstall leaves the theme's capability grants behind",
    file: API,
    before: [`  await env.DB.prepare("DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name=?").bind(name).run().catch(()=>{});`],
    after: [''],
    runs: [["tests/suites/theme-integration.test.mjs", "its capability grants are gone"]],
  },
  // --- rule 66: bundled themes ship through Worker assets -------------------
  {
    label: "declarative template loading loses the bundled-assets fallback",
    // The whole reason a wiped database used to render `__fallback__`: the
    // R2 miss threw away the request instead of falling through to the
    // worker assets. The structural guard must go red on exactly this.
    file: join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
    before: [`  const text = obj ? await obj.text() : await bundledThemeFile(env, theme.name, \`templates/\${name}.html\`);`],
    after: [`  const text = obj ? await obj.text() : null;`],
    runs: [["tests/suites/architecture.test.mjs", "every theme-content consumer falls back to bundled assets (rule 66c)"]],
  },
  {
    label: "the synced assets tree drifts from content/themes",
    // A template edited in `content/` but never synced ships stale markup
    // from `public/` — invisible until someone compares bytes. The
    // byte-identity guard is the pin; this proves it can fail. The anchor is
    // the file's first line (`{{@extends "parts/layout"}}`), replaced by a
    // drifted copy so the trees no longer agree byte-for-byte.
    file: join(ROOT, "public/themes/default/templates/home.html"),
    before: ['{{@extends "parts/layout"}}'],
    after: ['{{@extends "parts/layout"}}{{!-- drift: content/ was edited, public/ never re-synced --}}'],
    runs: [["tests/suites/architecture.test.mjs", "every synced theme file is byte-identical to its source"]],
  },
  {
    label: "a non-bundled theme directory leaks into the deployed assets",
    // The test fixture theme must never ship — everything under `public/` is
    // uploaded verbatim by `wrangler deploy`. It *did* ship for as long as the
    // sync mirrored all of `content/themes/`, and `architecture.test.mjs`
    // could not see it because it asserted the two trees matched: the leak was
    // pinned as correctness, and `/themes/fixture/theme.json` answered 200 in
    // production. A guard that asserts an *absence* needs an absence to be
    // staged, which no string replacement can do, so this scenario copies a
    // real file into the forbidden path.
    creates: {
      from: join(ROOT, "content/themes/fixture/theme.json"),
      to: FIXTURE_LEAK,
    },
    runs: [["tests/suites/architecture.test.mjs", "no theme directory that is not bundled reaches the deployed assets"]],
  },
  {
    label: "the sync goes back to mirroring all of content/themes",
    // The shape that leaked the fixture. The tree check above cannot catch it:
    // `public/themes` is clean today and would only turn dirty the next time
    // somebody ran the script by hand — which is precisely how a leak survives
    // a green suite. So the sync's own copy set is pinned lexically, and this
    // proves that pin can fail.
    file: SYNC_THEMES,
    before: ["  const files = names.flatMap((n) => listThemeFiles(join(sourceRoot, n)).map((f) => `${n}/${f}`));"],
    after: ["  const files = listThemeFiles(sourceRoot);"],
    runs: [["tests/suites/architecture.test.mjs", "the sync does not enumerate the whole content/themes directory"]],
  },
  {
    label: "the bundled languages stop being offered for the site",
    // `core_locales` shipped for a long time with **no consumer at all**: the
    // payload carried the fact, nothing read it, and a fresh install therefore
    // offered no Chinese under System → Languages. Dropping the rows from the
    // payload has to go red, or the new assertions are measuring the field's
    // existence instead of what the screen can actually list.
    file: API,
    before: [`      core_entries: corePackLocaleEntries(),`],
    after: [''],
    runs: [["tests/suites/i18n.test.mjs", "bundled languages ship as rows for the Languages screen"]],
  },
  // --- the interface language: one writer, two viewers ----------------------
  {
    // The historical defect, reproduced. The Languages screen POSTed the
    // preference itself and re-rendered without reloading the dictionary, so
    // the panel said `zh-CN` while the header dropdown kept ticking `en` until
    // a full page reload. Nothing else in this repo can see that: the server
    // answered 200, the screen rendered, the request succeeded. The only
    // observer is the single-writer scan, so it is what has to be pinned.
    label: "the Languages screen writes the interface-language preference itself",
    file: LANGUAGES_SCREEN,
    before: ["      await setUiLocale(locale);\n"],
    after: [
      '      await api("i18n/ui-locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) });\n',
    ],
    runs: [["tests/suites/admin-spa.test.mjs", "only js/i18n.js writes the interface-language preference"]],
  },
  {
    // The other half of the same invariant, and the half a single-writer scan
    // cannot see: the writer is still the only one, and it no longer refreshes
    // the dictionary. That is precisely the original bug with the write moved
    // into the right module — the tick stays stale after a successful save.
    label: "the interface-language writer stops reloading the dictionary",
    file: ADMIN_I18N,
    before: ["  await loadMessages();\n}"],
    after: ["  // reload dropped\n}"],
    runs: [["tests/suites/admin-spa.test.mjs", "and that one writer reloads the dictionary itself"]],
  },
  {
    // A refused switch that resolves quietly is a screen reporting success
    // while nothing changed — the shape this repo keeps fixing. Both callers
    // now branch on the rejection (`shell.js` toasts, the Languages screen
    // opens a dialog), and both branches are dead code if this swallow returns.
    label: "a refused interface language is swallowed instead of thrown",
    file: ADMIN_I18N,
    before: ["  if (!res.ok) {"],
    after: ["  if (false) {"],
    runs: [["tests/suites/admin-spa.test.mjs", "a refused interface language rejects instead of reporting success"]],
  },
  // --- the themes screen reads usage from the wrong level -------------------
  {
    // The bug the operator reported as "the UI says it is not in use, then the
    // server refuses": `active_by_site` is on the *response*, and reading it off
    // each item is always `undefined`. The card renders "Not in use", the
    // uninstall button carries no site list, the pre-emptive dialog never fires,
    // and the 409 names a site that was never on screen. Nothing else can see
    // it — the screen renders, the payload is correct, the endpoint is right.
    label: "the themes screen looks for per-site usage on the wrong level",
    file: THEMES_SCREEN,
    before: ["const others = activeSitesFor(x.name, bySite).filter((s) => s !== state.site);"],
    after: ["const others = activeSitesFor(x.name, x.active_by_site).filter((s) => s !== state.site);"],
    runs: [["tests/suites/admin-spa.test.mjs", "a theme another site uses names that site"]],
  },
  {
    // The other half of the same screen: a bundled theme has no package to
    // remove, so the uninstall route answers 400 for every attempt. Dropping the
    // flag puts the button back, and the operator's only feedback becomes the
    // refusal — an action offered with exactly one possible answer.
    //
    // ⚠️ The observer is `admin-contract`, not `admin-spa`. The SPA suite renders
    // the screen from its own stubbed payload, so removing a field from the
    // endpoint is invisible to it — the first version of this scenario pinned the
    // SPA assertion and reported "did NOT go red". **The guard has to be one that
    // can see the defect**: an endpoint change needs a test that calls the
    // endpoint.
    label: "the themes payload stops saying which themes ship with the product",
    file: API,
    before: ["        bundled:(BUNDLED_THEMES as readonly string[]).includes(String(r.name))?1:0,\n"],
    after: [""],
    runs: [["tests/suites/admin-contract.test.mjs", "the payload marks the themes that ship with the product"]],
  },
  // --- the language switcher, and what "a Chinese version" has to mean ------
  {
    // The switcher swaps the locale segment. That is right for a *listing* —
    // one path, several translations of it — and wrong for an *article*:
    // migration 0016 made the slug per language, so `/en/blog/<zh-slug>` is a
    // 404 and the switcher offered a dead link on exactly the pages a reader is
    // most likely to switch on. `post.alternates` already carried each version's
    // own URL (it is what hreflang prints); the guard is that the switcher reads
    // it instead of guessing.
    label: "the language switcher ignores each translation's own slug",
    file: FRONTEND,
    before: ['    url:own.get(String(l.code))??`/${l.code}${rest?"/"+rest:""}`,'],
    after: ['    url:`/${l.code}${rest?"/"+rest:""}`,'],
    runs: [["tests/suites/locale-url.test.mjs", "the switcher on an article points at each language's own slug"]],
  },
  {
    // `manifest.locales[]` was checked for BCP-47 shape and read by nothing, so
    // a theme could advertise a Chinese version it did not ship: every
    // `{{default(theme.strings.x, "English literal")}}` then rendered the
    // literal, and a missing translation became indistinguishable from an
    // absent one — on the site and in every other test. The scaffold's manifest
    // comment had promised this check since it was written; the rule itself did
    // not exist. Adding a language without its pack is exactly how a developer
    // trips it.
    label: "a theme declares a locale it ships no language pack for",
    file: THEME_MANIFEST,
    before: ['    "en"\n  ],'],
    after: ['    "en",\n    "ja"\n  ],'],
    runs: [["tests/suites/theme-default.test.mjs", "every locale the manifest declares ships a language pack"]],
  },
  {
    // A registry row is not an install. `seedBundledExtensions` writes the
    // `theme_installs` row that makes a bundled theme *render*, and it was
    // mistaken for making the theme *own* its declarations. On a fresh
    // production install the theme served every page — Chinese ones and the
    // switcher included — while `GET theme/fields` answered `{"items":[]}`, so
    // `savePost`'s `fieldExists` gate dropped every `meta` value with an HTTP
    // 200. Dropping the second call is exactly that defect coming back.
    label: "the boot sequence registers the bundled theme without installing it",
    file: INDEX,
    before: ["     await ensureThemeCapabilities(env);\n"],
    after: [""],
    runs: [["tests/suites/architecture.test.mjs", "the boot sequence installs what it registers"]],
  },
  {
    // The other half: even with the call in place, a predicate that asks "did I
    // stamp this?" instead of "does the theme own anything?" cannot repair the
    // state it exists to repair. The suites delete capability rows on purpose
    // (they share one local D1), and a stamp survives that deletion — so the
    // installer would skip, and the fields would stay gone.
    label: "the installer asks whether it stamped the theme instead of whether it owns anything",
    file: CAPABILITIES,
    before: [
      "           (SELECT COUNT(*) FROM field_defs   WHERE site_id=? AND declared_by_theme=?) +",
    ],
    after: [
      "           (SELECT COUNT(*) FROM settings WHERE site_id=? AND key='theme.installed') +",
    ],
    runs: [["tests/suites/architecture.test.mjs", "the installed/not-installed predicate counts rows (rule 69c)"]],
  },
  // --- post_meta carries a language (batch 23, MEDIA-EDITOR-PLAN B5) --------
  {
    // `post_meta` is keyed (post_id, meta_key, locale) since migration 0019,
    // and every reader resolves values through one ladder in
    // `platform/post-meta.ts`. A reader that keeps the ladder but forgets to
    // pass the language is the quietest regression: the map still fills, the
    // template still renders, and the page simply shows the site default's
    // value in every language — the exact symptom B5 exists to remove.
    label: "the listing attach stops being language-aware",
    file: join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
    before: ["  const byPost = resolveMetaByPost(metaRows as any[], locale, fallback);"],
    after: ['  const byPost = resolveMetaByPost(metaRows as any[], "", fallback);'],
    runs: [["tests/suites/locale-url.test.mjs", "and the second language's listing resolves its own"]],
  },
  {
    // The single object is the other reader of the same ladder. Dropping its
    // attach does not break the page: `post.meta.category` renders empty, the
    // kicker falls back to its generic label, and HTTP stays 200 — the silent
    // half-answer that shipped before this batch.
    label: "the single page stops attaching custom fields",
    file: FRONTEND,
    before: ["    row.meta=resolveMetaByPost((mr.results as any[])??[],locale,dflt).get(row.id)??{};"],
    after: ["    row.meta={};"],
    runs: [["tests/suites/locale-url.test.mjs", "the single page shows the default language's own value"]],
  },
  {
    // A write that discards the language lands every value on the `''` legacy
    // tier, where the *last* writer of any language wins for all of them. Both
    // languages then read one blended value — and because SQLite upserts
    // silently, the defect is a 200 with content in the wrong language.
    label: "the meta writer saves every language onto the legacy tier",
    file: API,
    before: [".bind(entityId, key, locale, v === null || v === undefined ? null : String(v), now())"],
    after: ['.bind(entityId, key, "", v === null || v === undefined ? null : String(v), now())'],
    runs: [["tests/suites/locale-url.test.mjs", "the single page shows the default language's own value"]],
  },
  {
    // `attachMeta` renders each row's blocks anyway; reading_time is a string
    // scan on that HTML, not a second render pass. Dropping the line degrades
    // every listing card by one field with no error anywhere.
    label: "listings stop deriving a reading time",
    file: join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
    before: ['    it.reading_time = readingTime(String(it.html ?? ""), 220, locale);\n'],
    after: [""],
    runs: [["tests/suites/locale-url.test.mjs", "listings carry a reading time (derived, not rendered twice)"]],
  },
  {
    // The ladder's whole point is that a listing, a single page and the admin's
    // language rows answer "which value does this language see" the same way.
    // A second copy of the resolver is how the card says 设计 while the article
    // says Design comes back — so a rival definition has to be refused
    // structurally, before any of the behavioural suites could disagree.
    label: "a second copy of the meta ladder is defined",
    file: API,
    before: ['import { resolveMetaByPost } from "./platform/post-meta";'],
    after: [
      'import { resolveMetaByPost } from "./platform/post-meta";\n' +
        'function resolveMetaByPost(rows: any[], locale: string, fallback: string) { return new Map(); }',
    ],
    runs: [["tests/suites/architecture.test.mjs", "the meta read ladder is defined in exactly one module (rule 70)"]],
  },
  // --- the admin speaks languages (batch 24) ---------------------------------
  {
    // The historical shape, verbatim: for a shared-row post (one `posts` id,
    // one translation row per language) the version bar answered a click by
    // only relabelling `state.editing.locale` — the previous language's title
    // and blocks stayed on screen under the new language's name, and saving
    // from that screen overwrote the other language with the wrong content.
    label: "the editor only relabels the language instead of loading its row",
    file: EDITOR_SCREEN,
    before: ["    await editContent(state.type, postId || current.id, locale);"],
    after: [
      "    if (postId && postId !== current.id) await editContent(state.type, postId);",
      "    else { current.locale = locale; render(); }",
    ],
    runs: [["tests/suites/admin-spa.test.mjs", "switching versions loads the requested language's row, not a relabel"]],
  },
  {
    // The representative row used to be `MIN(locale)` — alphabetically first,
    // which pinned bilingual lists to `en` by coincidence of the alphabet.
    // `|| "en"` is the same observable behaviour (rule 57's hardcoded-locale
    // family) and flips the same named assertion on a site whose default is
    // not `en`.
    label: "the content list pins a hardcoded language instead of the site's default",
    file: API,
    before: ["  const pinned = locale || dflt;"],
    after: ['  const pinned = locale || "en";'],
    runs: [["tests/suites/admin-contract.test.mjs", "the list opens on the site's default language"]],
  },
  {
    // Without the per-post language set, the list cannot say "en ✓ zh-CN ✓" —
    // every row looks monolingual and version discovery moves back into
    // opening every post.
    label: "the list stops carrying each post's language versions",
    file: API,
    before: ["    for (const i of items) i.locales = have.get(i.id) ?? i.locales;"],
    after: [""],
    runs: [["tests/suites/admin-contract.test.mjs", "each item carries the languages it actually has"]],
  },
  {
    label: "the list shows only the row's own language",
    file: join(ROOT, "public/admin/js/screens/content-list.js"),
    before: ["    const versions = Array.isArray(x.locales) && x.locales.length ? x.locales : [x.locale].filter(Boolean);"],
    after: ["    const versions = [x.locale].filter(Boolean);"],
    runs: [["tests/suites/admin-spa.test.mjs", "the list shows a badge per language version the post has"]],
  },
  // --- a refusal must have an exit: forced theme uninstall (batch 25) --------
  {
    // The historical shape, verbatim: the uninstall refused whenever any site
    // rendered the theme, force or no force. The screen could only explain
    // the refusal — "deactivate it there first" — with no way to do that from
    // where the operator stood, which is how "this theme cannot be deleted"
    // gets believed.
    label: "the theme uninstall refuses even when forced",
    file: API,
    before: ["  if(sites.length && !force) return ok({error:`still active on: ${sites.join(\", \")}`},409);"],
    after: ["  if(sites.length) return ok({error:`still active on: ${sites.join(\", \")}`},409);"],
    runs: [["tests/suites/theme-integration.test.mjs", "a forced uninstall is accepted while the theme is in use"]],
  },
  // --- a menu location resolves deterministically (batch 26, rule 73) --------
  {
    // The historical shape, verbatim: `menu()` answered `LIMIT 1` with no
    // ORDER BY, so with two header menus the nav was whichever row SQLite
    // felt like returning — it could flip between requests with no code
    // change. Dropping the ORDER BY must turn the rule-73 guard red.
    label: "the menu lookup answers LIMIT 1 without ordering",
    file: FRONTEND,
    before: ["SELECT id FROM menus WHERE location=? AND site_id=? ORDER BY id LIMIT 1"],
    after: ["SELECT id FROM menus WHERE location=? AND site_id=? LIMIT 1"],
    runs: [["tests/suites/architecture.test.mjs", "the menu-location lookup orders before limiting (rule 73)"]],
  },
  {
    // The historical shape: the renderer ignored the theme's declared
    // locations entirely and hardcoded the header — a theme declaring a
    // footer menu location had its declaration silently discarded.
    label: "the renderer hardcodes the header location",
    file: join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
    before: ["  const menuLocs: { id: string }[] = theme.manifest.menuLocations?.length ? theme.manifest.menuLocations : [{ id: \"header\" }];"],
    after: ["  const menuLocs: { id: string }[] = [{ id: \"header\" }];"],
    runs: [["tests/suites/architecture.test.mjs", "the renderer reads locations from the theme manifest, not a literal (rule 73b)"]],
  },
  // --- widgets are site-scoped end to end (batch 27, rule 74) ----------------
  {
    // The historical shape, verbatim: the only widget read path had no tenant
    // filter at all — every site's sidebar showed every site's widgets. The
    // render query losing its site_id must turn the rule-74 guard red.
    label: "the widget render ignores the site",
    file: FRONTEND,
    before: ["SELECT * FROM widget_instances WHERE site_id=? AND enabled=1 AND (locale='' OR locale=?)"],
    after: ["SELECT * FROM widget_instances WHERE enabled=1 AND (locale='' OR locale=?)"],
    runs: [["tests/suites/architecture.test.mjs", "the widget render query carries the site id (rule 74)"]],
  },
  {
    // The historical shape: widgets existed in the admin but the template
    // scope never carried them — operators filed widgets under sidebars
    // nothing rendered, and the screen looked implemented while the front
    // end ignored every row.
    label: "the widgets never reach the template scope",
    file: join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
    before: ["    widgetGroups(env, siteId, o.locale),"],
    after: ["    Promise.resolve({}),"],
    runs: [["tests/suites/architecture.test.mjs", "buildScope feeds the rendered widget groups into the template scope (rule 74b)"]],
  },
  // --- deleting a site purges its registry rows (contract: onSiteDelete) -----
  {
    // The historical shape, verbatim: `deleteSite()` deleted the `sites` row
    // and the site's `theme.active` setting and stopped there. The deleted
    // site's admin-menu rows and generated-table mappings survived, so the
    // admin kept listing a menu for a site that no longer existed — and a
    // `theme_table_defs` row for a site nobody can see kept declaring its
    // generated tables. Which tables a delete purges is now **declared**
    // (`onSiteDelete` in `contract/schema.ts`) and `deleteSite()` walks the
    // list derived from it; calling it with a list that loops zero times must
    // turn both assertions red.
    label: "deleting a site leaves its registry rows behind",
    file: SITES,
    before: ["  for (const table of purgeTables) {"],
    after: ["  for (const table of []) {"],
    runs: [
      ["tests/suites/multisite.test.mjs", "deleting a site purges its admin-menu rows"],
      ["tests/suites/multisite.test.mjs", "deleting a site purges its generated-table mappings"],
    ],
  },
  {
    // The declaration half of the same guard. `onSiteDelete` is required on
    // every site-scoped table; dropping it from one entry means the table's
    // rows have no policy, and the architecture suite must name it.
    label: "a site-scoped table does not declare what happens on site delete",
    file: SCHEMA,
    before: ['  { table: "admin_menu_registry", tenant: "site", locale: null, onSiteDelete: "purge", note:'],
    after: ['  { table: "admin_menu_registry", tenant: "site", locale: null, note:'],
    runs: [["tests/suites/architecture.test.mjs", "every site-scoped table declares an onSiteDelete policy"]],
  },
  // --- the admin prefix is injected, not hard-coded (batch C) ----------------
  {
    // The historical shape, verbatim: `state.js` built every admin API URL from
    // the literal `/api/v1/`. That is correct only while the prefix is exactly
    // `/admin`; the moment an operator moves the admin, the SPA calls a prefix
    // that no longer exists and loads blank against a wall of 404s. The guard is
    // a source scan for a bare absolute URL, so reverting one call site to the
    // literal must turn "no SPA module hard-codes an API or admin asset URL" red.
    label: "an SPA module hard-codes the API base again",
    file: ADMIN_STATE,
    before: ['const res = await fetch(adminBase + "/api/v1/" + path, opts);'],
    after: ['const res = await fetch("/api/v1/" + path, opts);'],
    runs: [["tests/suites/admin-spa.test.mjs", "no SPA module hard-codes an API or admin asset URL"]],
  },
  {
    // The cookie half of batch C. The session cookie used to be `cfpress_session`
    // with `Path=/`, so it rode along on every front-end request and shared a
    // generic name with the member cookie that arrives in batch D. Reverting the
    // `Path` to `/` must turn the cookie-scope assertion red — the assertion is
    // the only thing standing between "admin session is scoped" and "it is on
    // every page".
    label: "the admin session cookie is scoped to / instead of the prefix",
    file: AUTH,
    before: [
      "      \"Set-Cookie\": `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`",
    ],
    after: [
      "      \"Set-Cookie\": `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`",
    ],
    runs: [["tests/suites/admin-contract.test.mjs", "the session cookie path is the admin prefix, not /"]],
  },
  {
    // And the name: a shared `cfpress_session` name is how "an admin is logged
    // in" and (batch D's) "a member is logged in" get conflated by the next
    // reader. Every suite that logs in asserts the name; this injection is the
    // proof those assertions are not vacuous.
    label: "the admin session cookie reverts to the shared name",
    file: AUTH,
    before: ['const SESSION_COOKIE = "cfpress_admin";'],
    after: ['const SESSION_COOKIE = "cfpress_session";'],
    runs: [["tests/suites/admin-contract.test.mjs", "logged in"]],
  },
  {
    // The structural half of rule 75b: the admin API must be mounted under the
    // prefix by *stripping* it and handing the request to `handleApi`. The
    // historical bug was exactly this missing branch — only the login endpoint
    // was special-cased, so `/admin/api/v1/platform-settings` fell through to
    // the asset layer and 404'd. Reverting the mount must turn the architecture
    // guard red (and the admin-contract behavioural checks with it).
    label: "the admin API is not mounted under the prefix",
    file: INDEX,
    // The anchor tracks the current line verbatim (`+u.search` was added in
    // batch 28's follow-up). An anchor that no longer matches reports
    // "appears 0x" and skips the scenario — which is a *failure*, not a pass,
    // precisely so a stale anchor cannot masquerade as a validated guard.
    before: [' if(p.startsWith(adminBase+"/api/"))return handleApi(env,new Request(new URL(p.slice(adminBase.length)+u.search,u.origin),request));\n'],
    after: [""],
    runs: [["tests/suites/architecture.test.mjs", "the admin API is mounted under the prefix, not just the login door (rule 75b)"]],
  },
  {
    // Rule 75c's second half: serving the old `/admin/*` assets when a custom
    // prefix is set is how the hidden admin stays discoverable — a scanner that
    // finds `/admin/admin.js` has found the admin. Dropping the `adminBase`
    // gate on the asset bail-out must turn the guard red.
    label: "the old prefix's assets are served again",
    file: INDEX,
    before: [' if(adminBase==="/admin"&&(u.pathname==="/admin"||u.pathname.startsWith("/admin/")))return env.ASSETS.fetch(request);'],
    after: [' if(u.pathname==="/admin"||u.pathname.startsWith("/admin/"))return env.ASSETS.fetch(request);'],
    runs: [["tests/suites/architecture.test.mjs", "the old prefix's static assets are gated on the default prefix (rule 75c)"]],
  },
  // --- sites: the aggregate has to be per site, and count what it claims ---
  {
    // The historical shape of the prefix mount, verbatim: the request URL was
    // rebuilt from `u.origin` alone, so **every query parameter vanished** on
    // the prefixed route while unprefixed `/api/*` (handed the original request)
    // kept working. Nothing 500s: `?site=` falling off reads as "the current
    // site", which is the default, so the tenant selector silently resolved to
    // the wrong site and `?withCounts=1` just returned the older payload shape.
    // This is the defect the Sites screen surfaced, and it lives on a line that
    // looks like a faithful rewrite.
    label: "the prefixed API mount drops the query string",
    file: INDEX,
    before: [' if(p.startsWith(adminBase+"/api/"))return handleApi(env,new Request(new URL(p.slice(adminBase.length)+u.search,u.origin),request));\n'],
    after: [' if(p.startsWith(adminBase+"/api/"))return handleApi(env,new Request(new URL(p.slice(adminBase.length),u.origin),request));\n'],
    runs: [["tests/suites/admin-contract.test.mjs", "?site= survives the prefix mount"]],
  },
  {
    // The historical shape of "one number for many tenants": a COUNT with no
    // `GROUP BY site_id`. It answers *something* (the platform total), which is
    // exactly why it survives review — every row shows a plausible number, and
    // the only way to see it is wrong is to have a second site and compare.
    // Reverting the grouped count must turn the per-site assertion red.
    label: "the site count loses its per-site grouping",
    file: join(ROOT, "src/api.ts"),
    before: ['        env.DB.prepare("SELECT site_id, COUNT(*) AS count FROM posts WHERE type=\'post\' GROUP BY site_id").all(),'],
    after: ['        env.DB.prepare("SELECT \'\' AS site_id, COUNT(*) AS count FROM posts WHERE type=\'post\'").all(),'],
    runs: [["tests/suites/admin-contract.test.mjs", "a neighbour site's post count is its own"]],
  },
  {
    // The theme column's wrong answer, in the shape it would really be written:
    // `activeTheme()` answers "which theme should *render* this site" — it
    // probes storage and will name a theme that merely happens to be installed.
    // For a report of "what did this site choose" that marks an unthemed site
    // as themed.
    //
    // ⚠️ The first version of this scenario substituted `activeTheme()` for the
    // whole read, which made the site that *did* choose report the wrong name
    // too — so the "never chose reports empty" assertion stayed green and the
    // run failed as INVALID. An injection that trips a *different* assertion
    // proves nothing about the guard under test. This shape keeps the chosen
    // site correct (its row is read normally) and only fabricates a value for
    // sites that *have no row*, which is exactly the defect: a site that chose
    // nothing must not borrow the renderer's answer.
    label: "a site with no chosen theme borrows the renderer's answer",
    file: join(ROOT, "src/api.ts"),
    before: ["      const themes = Object.fromEntries(((themeRows.results as any[]) ?? []).map((r) => [String(r.site_id), String(r.value ?? \"\")]));\n"],
    after: [
      "      const themes = Object.fromEntries(((themeRows.results as any[]) ?? []).map((r) => [String(r.site_id), String(r.value ?? \"\")]));\n" +
        "      for (const s of items) if (!(s.id in themes)) themes[s.id] = (await activeTheme(env, s.id)).name;\n",
    ],
    runs: [["tests/suites/admin-contract.test.mjs", "a site that never chose reports empty, not the default's theme"]],
  },
  {
    // And the missing seed call. `seedSiteLocales` existed, was exported, and
    // its own doc said it ran when a site was created — it was called from
    // nowhere. Every admin-created site therefore had no switch rows and rode
    // the "no rows → serve the whole dictionary" fallback, which is why the
    // defect left no visible trace. Removing the call must turn the row-level
    // assertion red (the *served* locale list looks identical either way, which
    // is the whole reason the assertion reads the table).
    label: "a new site is created without its language rows",
    file: join(ROOT, "src/platform/sites.ts"),
    before: ["  await seedSiteLocales(env, safeId);\n"],
    after: [""],
    runs: [["tests/suites/admin-contract.test.mjs", "a newly created site has its own language switch rows"]],
  },
  // --- the two identities must not converge (batch D, rule 77) --------------
  {
    // The historical shape: one session table for everyone. This is the shape a
    // "just add a role" design produces, and it is the defect the whole batch
    // exists to prevent — a member session id becomes a valid admin session id
    // *by construction*, so the red line (member cookie on the admin API) can
    // only be held by a check somebody has to remember.
    //
    // The member resolver reading `admin_sessions` must turn rule 77b red.
    label: "the member resolver reads the admin session table",
    file: MEMBERS,
    before: ["    FROM member_sessions s JOIN members m"],
    after: ["    FROM admin_sessions s JOIN members m"],
    runs: [["tests/suites/architecture.test.mjs", "currentMember resolves against member_sessions, never admin_sessions (rule 77b)"]],
  },
  {
    // The same defect from the other side, and the one that is easiest to write
    // by accident: giving both cookies the same name. A single `Cookie:` header
    // carrying both is then unreadable, and whichever parser runs first wins —
    // the exact conflation the separate names exist to make impossible.
    label: "the member cookie reuses the admin cookie's name",
    file: MEMBERS,
    before: ['const MEMBER_COOKIE = "cfpress_member";'],
    after: ['const MEMBER_COOKIE = "cfpress_admin";'],
    runs: [["tests/suites/architecture.test.mjs", "the two cookie names are different (rule 77a)"]],
  },
  {
    // A member is a tenant fact, so its session row must carry the tenant. Drop
    // `site_id` from `member_sessions` and the table can no longer be reached
    // by `deleteSite`'s `WHERE site_id=?` purge — and `currentMember`'s join
    // loses the half of its constraint that keeps one site's session from
    // authenticating on another.
    label: "member_sessions is created without its own site_id",
    file: MIGRATION_0022,
    before: ["  site_id TEXT NOT NULL,\n  member_id TEXT NOT NULL,"],
    after: ["  member_id TEXT NOT NULL,"],
    runs: [["tests/suites/architecture.test.mjs", "member_sessions carries site_id too (rule 77c)"]],
  },
  {
    // And the schema contract's half: the table is not declared site-scoped, so
    // it never enters `PURGE_ON_SITE_DELETE` and a deleted site's sessions
    // survive it. (`schema-scope` catches the column mismatch too — this names
    // the declaration the purge list is derived from.)
    label: "the contract does not declare members a site table",
    file: SCHEMA,
    before: ['  { table: "members", tenant: "site"'],
    after: ['  { table: "members", tenant: "platform"'],
    runs: [["tests/suites/architecture.test.mjs", "the contract declares members a site table (rule 77d)"]],
  },
];

/** Every file any scenario may touch, hashed before and after. */
const WATCHED = [...new Set([SCHEMA, EVENTS, ARCH, SCOPE, MANIFEST, VALIDATION,
  join(ROOT, "src/shared/features.ts"),
  join(ROOT, "src/shared/types.ts"),
  join(ROOT, "src/shared/bundled.ts"),
  PACKS,
  SYNC_THEMES,
  FIXTURE_LEAK,
  join(ROOT, "src/extensions/theme/runtime-declarative.ts"),
  join(ROOT, "public/themes/default/templates/home.html"),
  THEME_MANIFEST,
  INDEX, CAPABILITIES,
  join(ROOT, "src/api.ts"),
  join(ROOT, "src/extensions/contract/hooks.ts"),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "docs/guides/THEME-DEV.md"),
  join(ROOT, "public/admin/js/screens/account.js"),
  join(ROOT, "public/admin/js/screens/editor.js"),
  join(ROOT, "public/admin/js/screens/content-list.js"),
  join(ROOT, "public/admin/js/screens/dashboard.js"),
  join(ROOT, "public/admin/js/screens/menus.js"),
  join(ROOT, "public/admin/js/screens/theme-menu.js"),
  ADMIN_I18N, LANGUAGES_SCREEN, THEMES_SCREEN,
  ADMIN_STATE, AUTH, SITES, SITES_SCREEN,
  BLOCKS, FRONTEND, BLOCK_FIELDS, MEDIA_PICKER, MEDIA_SCREEN, CORE_PACK, API, WRANGLER])];

function hashAll() {
  const out = {};
  for (const f of WATCHED) out[rel(f)] = existsSync(f) ? sha(normalize(readFileSync(f, "utf8"))) : "<absent>";
  return out;
}

/**
 * Assert the working tree matches the pristine snapshot.
 *
 * Called **before** injecting (so a previous run's leftovers cannot be baked
 * into the snapshot) and **after** restoring (so a failed restore is not
 * mistaken for a clean tree).
 */
function assertPristine(pristine, when) {
  const now = hashAll();
  const diffs = Object.keys(now).filter((k) => now[k] !== pristine[k]);
  if (diffs.length) {
    console.error(`\n✗ TREE NOT PRISTINE (${when}):`);
    for (const d of diffs) console.error(`    ${d}: ${pristine[d]} -> ${now[d]}`);
    console.error("  Restore the tree and re-run before trusting any result below.");
    process.exit(1);
  }
}

/** Promise-based worker run; resolves with the suite's captured output + code. */
function runSuite(relPath) {
  return new Promise((resolve) => {
    // ⚠️ The worker is created with `eval:true` from an **ESM** parent, so its
    // scope is ESM: `require` is not defined there. `import()` is the loader
    // that works, and it is what the suites are written for (`"type":"module"`).
    // The first version used `require` and every load threw, which surfaced as
    // "no summary" — i.e. as a broken *runner*, not a broken *guard*.
    //
    // ⚠️ **`import()` resolving is not the suite finishing.** This was the
    // second false-negative in this harness, and it was much harder to see than
    // the first. Every suite ends with `process.exit(0)`, which is stubbed to
    // `done` below — but the module body *also* completes while `main()` is
    // still awaiting its first `await`. So `.then(() => done(0))` is a **second,
    // premature** trigger: whichever fires first wins, and the worker is
    // terminated with only the output written so far.
    //
    // The effect is a suite that reports "no summary (aborted)" — read as "the
    // guard did not go red", the exact false negative this tool exists to rule
    // out. It only bites suites slow enough to lose the race (esbuild compile
    // time is the usual culprit), so it looks like a per-suite quirk rather
    // than a harness bug: `architecture` and `admin-spa` passed, `features` did
    // not, and the difference was milliseconds.
    //
    // The fix is to make the suite's own `process.exit` the *only* trigger. If
    // the module itself throws before ever calling it, `esbuild`-style failures
    // still need reporting — so the catch reports, but a clean resolve does not.
    const entry = `
      let out = "";
      process.stdout.write = (c) => { out += c; };
      process.stderr.write = (c) => { out += c; };
      let reported = false;
      const done = (code) => {
        if (reported) return;
        reported = true;
        parentPort.postMessage({ out, code: code == null ? 0 : code });
      };
      process.exit = done;
      import(${JSON.stringify(pathToFileURL(join(ROOT, relPath)).href)})
        .catch((e) => { out += "\\n[suite threw before process.exit] " + ((e && e.stack) || e) + "\\n"; done(1); });
    `;
    let settled = false;
    const w = new Worker(`const { parentPort } = require("node:worker_threads");\n${entry}`, {
      eval: true,
    });
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { w.terminate(); } catch { /* already gone */ }
      resolve(verdict);
    };
    w.on("message", (m) => finish(parseVerdict(m.out, m.code)));
    w.on("error", (e) => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: `WORKER ERROR: ${(e && e.stack) || e}`, err: "worker error",
    }));
    w.on("exit", () => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker exited without reporting",
    }));
    // Hard ceiling so a hung suite cannot wedge the tool.
    setTimeout(() => finish({
      passed: null, failed: null, aborted: true, code: 1,
      text: "", err: "worker timed out",
    }), 120_000).unref?.();
  });
}

/** Turn raw suite output into a verdict; a missing summary is never a pass. */
function parseVerdict(text, code) {
  const m = text.match(/(\d+) passed, (\d+) failed/);
  if (!m) return { passed: null, failed: null, aborted: true, text, code, err: "no summary" };
  return {
    passed: Number(m[1]),
    failed: Number(m[2]),
    aborted: /\(aborted\)/.test(text),
    text,
    code,
    err: null,
  };
}

const problems = [];
/**
 * Apply an injection, proving the anchor was present and unique.
 *
 * ⚠️ Anchors are written with `\n` and matched against text that has been
 * newline-normalised first (`normalize`, defined with the other helpers). The
 * first version matched the file as-read, and `schema.ts` happened to be CRLF
 * (written on Windows) while every other file was LF — so three scenarios
 * silently reported "anchor appears 0x" and were skipped. A scenario that never
 * ran is not a scenario that passed.
 */
const apply = (file, before, after) => {
  const src = normalize(readFileSync(file, "utf8"));
  const hits = src.split(before).length - 1;
  if (hits !== 1) {
    throw new Error(`injection anchor appears ${hits} time(s) in ${rel(file)} (need exactly 1): ${JSON.stringify(before.slice(0, 70))}`);
  }
  writeFileSync(file, src.replace(before, after));
};

// ---------------------------------------------------------------------------
async function main() {
console.log("Snapshotting the pristine tree...");
const pristine = hashAll();
assertPristine(pristine, "pre-flight");
console.log(`  ${WATCHED.length} watched files; baseline hashes:\n    ` +
  Object.entries(pristine).map(([k, v]) => `${k}=${v}`).join("\n    "));

let ran = 0;
for (const sc of SCENARIOS) {
  if (sc.skip) continue;
  console.log(`\n${"=".repeat(64)}\nScenario: ${sc.label}\n${"=".repeat(64)}`);

  // Two shapes of injection:
  //   * a text replacement in an existing file (`file` + `before`/`after`);
  //   * a file that must NOT exist being materialised (`creates`), because
  //     some guards assert an *absence* ("nothing that is not bundled ships")
  //     and no string replacement can produce a file that is not there.
  const creating = !!sc.creates;
  const target = creating ? sc.creates.to : sc.file;
  const key = rel(target);

  let beforeSrc = "";
  if (creating) {
    if (existsSync(target)) {
      problems.push(`${sc.label}: ${key} already exists — cannot stage an absence`);
      console.log(`  FAIL ${key} already exists — scenario not executed`);
      continue;
    }
    console.log(`  pre-condition: ${key} is absent (as it must be)`);
  } else {
    // Pre-condition: the scenario's own anchor must be present and unique.
    beforeSrc = normalize(readFileSync(sc.file, "utf8"));
    const anchorHits = beforeSrc.split(sc.before[0]).length - 1;
    if (anchorHits !== 1) {
      problems.push(`${sc.label}: anchor appears ${anchorHits}x (need 1)`);
      console.log(`  FAIL anchor not unique (${anchorHits}) — scenario not executed`);
      console.log(`       anchor: ${JSON.stringify(sc.before[0].slice(0, 90))}`);
      console.log(`       file:   ${rel(sc.file)} (${beforeSrc.length} chars)`);
      continue;
    }
  }

  // Undo whatever this scenario staged. For a created file that means deleting
  // it *and* the directory that had to be made for it, so the tree is not left
  // with an empty `public/themes/fixture/` that no hash can see.
  const undo = () => {
    if (!creating) { writeFileSync(sc.file, beforeSrc); return; }
    rmSync(target, { force: true });
    try { rmdirSync(dirname(target)); } catch { /* not empty, or already gone */ }
  };

  // Capture only the file the scenario touches, by hash.
  const preHashes = { [key]: creating ? "<absent>" : sha(normalize(readFileSync(sc.file, "utf8"))) };

  try {
    if (creating) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(sc.creates.from, target);
    } else {
      apply(sc.file, sc.before[0], sc.after[0]);
    }
  } catch (e) {
    problems.push(`${sc.label}: ${e.message}`);
    console.log(`  FAIL ${e.message}`);
    undo();
    assertPristine(pristine, `after failed injection of "${sc.label}"`);
    continue;
  }

  // **The injection must be proven to have landed.** Hash, not byte count:
  // `"site"` -> `"sote"` is equal length and would fool a size check.
  const postHash = existsSync(target) ? sha(normalize(readFileSync(target, "utf8"))) : "<absent>";
  if (postHash === preHashes[key]) {
    problems.push(`${sc.label}: injection produced no change in ${key} (hash unchanged)`);
    console.log(`  FAIL injection did not land (${preHashes[key]} == ${postHash}) — nothing was proved`);
    undo();
    assertPristine(pristine, `after no-op injection of "${sc.label}"`);
    continue;
  }
  console.log(`  injected ${key}: ${preHashes[key]} -> ${postHash}`);

  // Run the suites and check the *named* assertion flipped.
  let allFlipped = true;
  for (const [suite, expectRed] of sc.runs) {
    const res = await runSuite(suite);
    if (res.aborted) {
      problems.push(`${sc.label}: ${suite} produced no summary (aborted) while injected`);
      console.log(`  FAIL ${suite}: no summary while injected — cannot read the result (treated as failure)`);
      allFlipped = false;
      continue;
    }
    if (expectRed === null) {
      // No pinned assertion for this scenario; just require that it went red at
      // all. Recorded as a weak scenario so it is visible in the output.
      const red = res.failed > 0;
      console.log(`  ${red ? "ok  " : "FAIL"} ${suite}: ${res.passed} passed, ${res.failed} failed (expected >0 failures)`);
      if (!red) { problems.push(`${sc.label}: ${suite} stayed green`); allFlipped = false; }
      continue;
    }
    // The expected assertion must be the thing that failed.
    const failedBlock = res.text.match(/FAIL [^\n]*/g) ?? [];
    const hit = res.text.includes(`FAIL ${expectRed}`) || res.text.includes(`- ${expectRed}`);
    console.log(`  ${hit ? "ok  " : "FAIL"} ${suite}: "${expectRed}" ${hit ? "went red" : "did NOT go red"} (${res.passed}p/${res.failed}f)`);
    if (!hit) {
      problems.push(`${sc.label}: expected assertion never went red — ${failedBlock.slice(0, 3).join(" | ") || "nothing failed"}`);
      allFlipped = false;
    }
  }

  // Restore, then prove the restore — a silent restore failure makes every
  // later scenario run on top of this one's damage (the batch-4 trap).
  undo();
  const restored = existsSync(target) ? sha(normalize(readFileSync(target, "utf8"))) : "<absent>";
  assertPristine(pristine, `after restoring "${sc.label}"`);
  console.log(`  restored (${restored})  ${allFlipped ? "✓ scenario valid" : "✗ scenario INVALID"}`);
  ran++;
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
const final = await runSuite("tests/suites/architecture.test.mjs");
const finalScope = await runSuite("tests/tools/_schema-scope.mjs");
const finalManifest = await runSuite("tests/suites/manifest-validation.test.mjs");
const finalBlocks = await runSuite("tests/suites/editor-blocks.test.mjs");
const finalPicker = await runSuite("tests/suites/media-picker.test.mjs");
console.log(`post-restore: architecture ${final.passed}p/${final.failed}f, ` +
  `schema-scope ${finalScope.passed}p/${finalScope.failed}f, ` +
  `manifest ${finalManifest.passed}p/${finalManifest.failed}f, ` +
  `editor-blocks ${finalBlocks.passed}p/${finalBlocks.failed}f, ` +
  `media-picker ${finalPicker.passed}p/${finalPicker.failed}f`);
// A missing summary here means "I could not read the result", which is a
// failure — not an absence of failure.
for (const [label, res] of [["architecture", final], ["schema-scope", finalScope], ["manifest", finalManifest], ["editor-blocks", finalBlocks], ["media-picker", finalPicker]]) {
  if (res.aborted) problems.push(`${label} produced no readable verdict after restore (${res.err})`);
  else if (res.failed) problems.push(`${label} not green after restore (${res.failed} failed)`);
}
assertPristine(pristine, "final");

console.log(`\n${ran} scenario(s) executed, ${problems.length} problem(s)`);
if (problems.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("Every guard under test was observed to fail on its own defect.");
}

main().catch((e) => {
  console.error("\nTOOL ERROR:", (e && e.stack) || e);
  process.exit(1);
});
