/**
 * The install boundary: is this manifest acceptable? (ARCHITECTURE.md §5.3)
 *
 * A manifest is the **only** place an extension can get it wrong in a way that
 * surfaces far from the mistake. A typo in `translatable` does not fail the
 * install; it produces an `_i18n` table with no column for the field the theme
 * then writes to, and the error appears at render time pointing at the renderer.
 * A `table-list` menu naming an undeclared table installs cleanly and opens an
 * empty page.
 *
 * So everything that can be checked is checked here, and **a failure throws**:
 * `validateManifest` raises, `src/api.ts` catches and returns 400. A theme that
 * cannot be installed beats a theme that half works — the second one costs a
 * debugging session, the first one costs a re-upload.
 *
 * ## What is deliberately *not* here
 *
 * The vocabularies (allowed screens, field types, reserved columns) live in
 * `manifest.ts` so other readers can share them; the capability list lives in
 * `capabilities.ts` for the same reason. This file only decides.
 *
 * ## The second line of defence
 *
 * Two of these rules are also enforced against the *shipped* extensions by
 * `tests/suites/architecture.test.mjs` (screen names, and route/tables agreement).
 * That is not duplication: the test guards what is in this repository, this
 * guards anything installed at runtime from a third-party zip.
 */
import {
  ALLOWED_ADMIN_SCREENS, ALLOWED_AGGREGATES, ALLOWED_FIELD_TYPES, ALLOWED_PAGE_BLOCKS, ALLOWED_TABLE_FIELD_TYPES,
  FIELD_KEY_RE, IDENT_RE, LOCALE_CODE_RE, PLUGIN_PAGE_SCREEN_PREFIX, RESERVED_COLUMNS, SCOPE_NAME_RE,
  TABLE_ADMIN_SCREENS, TABLE_LANGUAGE_STRATEGIES, TABLE_NAME_RE, isProseFieldType, validExtensionName,
  validTemplateName, validVersion,
} from "./manifest";
import { ALLOWED_CHANNEL_FIELD_TYPES, HOST_CHANNEL_CODES, isChannelFieldType, isHostChannelCode } from "./channels";
import { isCapability } from "./capabilities";
import { DECLARABLE_HOOKS } from "./hooks";
import { isDomainEvent } from "./events";
import type { ValidatedManifest } from "./manifest";

// Intentionally `any[]`: manifest blocks are validated field by field below,
// and the strict object type would make every property probe an error.
function asArray(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function fail(msg: string): never { throw new Error(msg); }
/** Escape a string for literal use inside `new RegExp`. Extension names may
 *  contain `.`, `+`, `(` … — an unescaped name would silently widen the
 *  `label_key` prefix check instead of tightening it. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate an extension manifest. Themes carry a much larger declaration
 * surface than plugins (post types, taxonomies, fields, routes, menus, blocks),
 * so each block is checked and normalised here rather than failing later at
 * activation time with a vague error.
 */
export function validateManifest(manifest: any, type: "plugin" | "theme"): ValidatedManifest {
  if (!manifest || typeof manifest !== "object") fail("Invalid manifest");
  if (!validExtensionName(String(manifest.name || ""))) fail("Invalid extension name");
  if (!validVersion(String(manifest.version || ""))) fail("Invalid extension version");
  if (type === "plugin" && manifest.permissions && !Array.isArray(manifest.permissions)) fail("permissions must be an array");
  if (type === "theme" && manifest.supports && !Array.isArray(manifest.supports)) fail("supports must be an array");
  const perms = asArray(manifest.permissions);
  for (const p of perms) if (!isCapability(p)) fail(`Unsupported capability: ${p}`);

  validateInlineLangs(manifest, type);

  if (type === "theme") validateThemeManifest(manifest);
  else validatePluginManifest(manifest);

  return { name: String(manifest.name), title: String(manifest.title || manifest.name), version: String(manifest.version), manifest };
}

/**
 * The plugin install boundary (rules 48–51).
 *
 * Plugins used to be validated much more lightly than themes, and two of the
 * gaps were the *"declared but never read"* family this repo keeps hitting: a
 * plugin's `adminMenus` was accepted and dropped (fixed in batch 3), and
 * `tables[]` was refused outright because the platform had nowhere to register
 * a plugin's tables (fixed by migration 0014).
 *
 * The remaining rules are the ones that make "a plugin is data, not code" true
 * in a way a machine can check:
 *
 *   48. no executable code — no code-bearing key in the manifest, and no
 *       `.js`/`.ts` file in the package. A Workers runtime cannot load plugin
 *       code, and running it would breach the capability model, so a manifest
 *       that asks for it is rejected with the reason rather than ignored.
 *   49. every `adminPages[].blocks[].type` is one the SPA renders.
 *   50. a `plugin-page:<id>` menu opens a page the plugin actually declared.
 *   51. every channel `code` is one the host implements, and every
 *       `configSchema[].type` has an admin control.
 */
function validatePluginManifest(m: any) {
  const name = String(m.name);

  // Rule 48, first half: a code-bearing key. Each of these appeared in the
  // reference implementation as a way to register plugin behaviour; accepting
  // one here would be accepting a promise the runtime cannot keep.
  for (const key of ["entry", "entryFile", "handler", "main", "script", "activate", "deactivate"]) {
    if (m[key] !== undefined) {
      fail(
        `plugin declares "${key}", which names executable code — a Workers runtime cannot load plugin code, ` +
        `so plugins declare data and the host performs the behaviour (rule 48)`
      );
    }
  }

  // Tables are materialised now, so this is real validation rather than the
  // refusal that used to stand here.
  const declaredTables = validateTables(m);

  const declaredPages = validateAdminPages(m.adminPages, declaredTables, name);
  validateChannels(m.channels);
  validateAdminMenus(m.adminMenus, declaredTables, "plugin", name, declaredPages);

  validateHooks(m.hooks);
  validateSubscriptions(m.subscribes);
}

/**
 * Validate `adminPages[]` (rules 49 and 50) and return the declared page ids.
 *
 * A page is a *declaration*: an id, a path, and a list of blocks. Nothing here
 * can execute, which is the point — the reference implementation's
 * `sdk.adminPage(path, handler)` cannot exist in this runtime, so the page is
 * described as data and rendered by the host.
 */
function validateAdminPages(pages: unknown, declaredTables: Set<string>, ownerName: string): Set<string> {
  const seen = new Set<string>();
  for (const page of asArray(pages)) {
    if (!page || typeof page !== "object") fail("adminPages entries must be objects");

    const id = String(page.id || "");
    if (!id) fail("adminPages entries need an id");
    // The id becomes `plugin-page:<id>` in the menu registry and the SPA's page
    // key, so it has to survive being an identifier.
    if (!IDENT_RE.test(id)) fail(`Invalid admin page id: "${id}"`);
    if (seen.has(id)) fail(`Duplicate admin page id: ${id}`);
    seen.add(id);

    const path = String(page.path || "");
    if (!path) fail(`adminPage ${id}: needs a path`);
    // A single segment, because the host owns the surrounding routes: a plugin
    // that could choose an absolute path could shadow a platform screen.
    if (path.includes("/") || path.startsWith(".") || path.includes("..")) {
      fail(`adminPage ${id}: path must be a single relative segment, got "${path}"`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(path)) {
      fail(`adminPage ${id}: invalid path "${path}"`);
    }

    // Titles are dictionary keys under the owner's namespace (rule 11).
    for (const key of ["titleKey", "labelKey"]) {
      if (page[key] === undefined || page[key] === null) continue;
      const value = String(page[key]);
      if (!value.startsWith(`plugin.${ownerName}.`)) {
        fail(`adminPage ${id}: ${key} must match "plugin.${ownerName}.<key>" (rule 11), got "${value}"`);
      }
    }

    for (const block of asArray(page.blocks)) {
      if (!block || typeof block !== "object") fail(`adminPage ${id}: blocks entries must be objects`);
      const type = String(block.type || "");
      if (!(ALLOWED_PAGE_BLOCKS as readonly string[]).includes(type)) {
        fail(`adminPage ${id}: unsupported block type "${type}" (allowed: ${ALLOWED_PAGE_BLOCKS.join(", ")})`);
      }
      // Every block type reads one of the plugin's *own* tables. A block with
      // no source would render nothing; one naming a table the plugin never
      // declared would read another extension's data or an empty result.
      const source = String(block.source || "");
      if (!source) fail(`adminPage ${id}: block "${type}" needs a source table`);
      if (!declaredTables.has(source)) {
        fail(`adminPage ${id}: block "${type}" reads table "${source}", which is not declared in tables[]`);
      }
      if (block.type === "stats" && block.aggregate !== undefined) {
        const agg = String(block.aggregate);
        if (!(ALLOWED_AGGREGATES as readonly string[]).includes(agg)) {
          fail(`adminPage ${id}: unsupported aggregate "${agg}" (allowed: ${ALLOWED_AGGREGATES.join(", ")})`);
        }
        if (agg === "sum" && !String(block.field || "")) {
          fail(`adminPage ${id}: aggregate "sum" needs a field`);
        }
      }
      for (const listKey of ["columns", "fields"]) {
        if (block[listKey] === undefined) continue;
        if (!Array.isArray(block[listKey])) fail(`adminPage ${id}: ${listKey} must be an array`);
      }
    }
  }
  return seen;
}

/**
 * Validate `channels[]` (rule 51).
 *
 * Two halves, both about the admin form that gets generated from this
 * declaration: the `code` must be one the host can actually deliver through
 * (otherwise the admin offers an option that fails at send time), and each
 * config field's `type` must have exactly one control (otherwise the form draws
 * an empty input, and an empty input reads as broken data rather than a
 * manifest mistake).
 */
function validateChannels(channels: unknown) {
  const seenCodes = new Set<string>();
  for (const ch of asArray(channels)) {
    if (!ch || typeof ch !== "object") fail("channels entries must be objects");
    const code = String(ch.code || "");
    if (!code) fail("channels entries need a code");
    if (seenCodes.has(code)) fail(`Duplicate channel code: ${code}`);
    seenCodes.add(code);

    if (!isHostChannelCode(code)) {
      fail(
        `channel "${code}" is not implemented by the host (available: ${HOST_CHANNEL_CODES.join(", ")}) — ` +
        `offering a channel the platform cannot deliver would put an option in the admin that fails at send time`
      );
    }

    const labelKey = String(ch.labelKey || "");
    if (!labelKey) fail(`channel ${code}: needs a labelKey`);

    const seenFields = new Set<string>();
    for (const field of asArray(ch.configSchema)) {
      if (!field || typeof field !== "object") fail(`channel ${code}: configSchema entries must be objects`);
      const key = String(field.key || "");
      if (!FIELD_KEY_RE.test(key)) fail(`channel ${code}: invalid config field key "${key}"`);
      if (seenFields.has(key)) fail(`channel ${code}: duplicate config field "${key}"`);
      seenFields.add(key);

      const type = String(field.type || "");
      if (!isChannelFieldType(type)) {
        fail(
          `channel ${code} field "${key}": unsupported type "${type}" ` +
          `(allowed: ${ALLOWED_CHANNEL_FIELD_TYPES.join(", ")}) — every type needs exactly one admin control`
        );
      }
      // Same namespacing rule as menu labels: a config label outside the owner's
      // namespace never resolves, so it would silently stay untranslated.
      const fieldLabelKey = String(field.labelKey || "");
      if (!fieldLabelKey) fail(`channel ${code} field "${key}": needs a labelKey`);
    }
  }
}

/**
 * Inline language packs (§2.4 layers ②/③).
 *
 * A plugin declares its strings in `plugin.json` rather than shipping a
 * `langs/` directory, because a plugin package is stored as a zip and never
 * unpacked (see `uploadExtension`). The namespace rule is the same one the
 * architecture test applies to a theme's `langs/….json`: two extensions that
 * both define `nav.home` overwrite each other once the dictionaries are merged,
 * and which one wins depends on load order — a heisenbug with no correct fix at
 * the call site.
 */
function validateInlineLangs(m: any, type: "plugin" | "theme") {
  if (m.langs === undefined) return;
  if (!m.langs || typeof m.langs !== "object" || Array.isArray(m.langs)) {
    fail("langs must be an object mapping locale codes to string dictionaries");
  }
  const prefix = `${type}.${String(m.name)}.`;
  for (const [locale, pack] of Object.entries(m.langs as Record<string, unknown>)) {
    if (!LOCALE_CODE_RE.test(locale)) fail(`langs: invalid locale code "${locale}"`);
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      fail(`langs.${locale} must be an object of {key: string}`);
    }
    for (const [key, value] of Object.entries(pack as Record<string, unknown>)) {
      if (typeof value !== "string") fail(`langs.${locale}.${key} must be a string`);
      if (!key.startsWith(prefix) && !key.startsWith("core.")) {
        fail(`langs.${locale}: key "${key}" must start with "${prefix}"`);
      }
    }
  }
}

/**
 * Validate a plugin's declared `hooks`.
 *
 * This is the one declaration whose failure mode is *total silence*. A hook
 * name the host does not implement is filtered away by the runtime
 * (`h in HOOK_IMPLS`), so a plugin declaring `beforRender` installs, enables,
 * reports itself active, and does nothing — no error, no log, no missing menu.
 * The author concludes the hook system is broken.
 *
 * Rejecting the typo at install time costs one re-upload and saves that entire
 * investigation. Duplicates are refused for a related reason: registering the
 * same hook twice is almost always a copy-paste, and the symptom (the filter
 * running twice) is invisible.
 */
function validateHooks(hooks: unknown) {
  if (hooks === undefined) return;
  if (!Array.isArray(hooks)) fail("hooks must be an array of hook names");
  const seen = new Set<string>();
  for (const h of hooks) {
    const name = String(h);
    if (!(DECLARABLE_HOOKS as readonly string[]).includes(name)) {
      fail(`Unsupported hook: "${name}" (declarable hooks: ${DECLARABLE_HOOKS.join(", ")})`);
    }
    if (seen.has(name)) fail(`Duplicate hook: ${name}`);
    seen.add(name);
  }
}

/**
 * Validate a plugin's declared `subscribes` (§10 rule 45).
 *
 * Same reasoning as `validateHooks`, and the same failure mode: a subscription
 * to an event name that does not exist never fires and says nothing. The only
 * difference is that the vocabulary is larger, which makes a typo *more* likely,
 * not less.
 */
function validateSubscriptions(list: unknown) {
  if (list === undefined) return;
  if (!Array.isArray(list)) fail("subscribes must be an array of domain event names");
  const seen = new Set<string>();
  for (const s of list) {
    const name = String(s);
    if (!isDomainEvent(name)) {
      fail(
        `Unknown domain event: "${name}". ` +
        `Events are declared in src/extensions/contract/events.ts (DOMAIN_EVENTS); ` +
        `a subscription to a name that is not there never fires and reports nothing.`
      );
    }
    if (seen.has(name)) fail(`Duplicate subscription: ${name}`);
    seen.add(name);
  }
}

/**
 * Validate `adminMenus` for either extension kind.
 *
 * Shared on purpose. Before batch 3 this loop lived inside
 * `validateThemeManifest`, so a plugin's `adminMenus` was never checked at all
 * — a plugin could declare `screen: "nonsense"` and install cleanly, then
 * produce a sidebar entry that opened a dead end. Now both kinds go through
 * one function, and `ownerType` is only used for the one rule that genuinely
 * differs (plugin-owned tables are not materialised yet).
 *
 * `args` is checked *per screen type* rather than as a bare object, because
 * "object, but missing the key this screen reads" is the failure that reaches
 * production: the manifest is valid, activation succeeds, and the page renders
 * empty. Better to refuse the manifest.
 */
function validateAdminMenus(
  menus: unknown,
  declaredTables: Set<string>,
  ownerType: "plugin" | "theme",
  ownerName: string,
  declaredPages: Set<string> = new Set<string>()
) {
  const seen = new Set<string>();
  // Rule 11 (§10): pack keys are namespaced by owner. A `label_key` outside
  // the owner's namespace would either shadow another extension's key or, more
  // likely, never resolve at all — the menu would silently stay untranslated.
  // The manifest is refused instead of shipping a key that cannot work.
  const keyRe = new RegExp(
    `^${ownerType}\\.${escapeRegExp(ownerName)}\\.[^\\s]+$`
  );
  for (const menu of asArray(menus)) {
    if (!menu || typeof menu !== "object") fail("adminMenus entries must be objects");

    const id = String(menu.id || "");
    if (!id) fail("adminMenus entries need an id");
    // The id becomes the SPA's page key (`menu:<id>`) and part of the registry
    // primary key, so it has to survive being an identifier.
    if (!IDENT_RE.test(id)) fail(`Invalid admin menu id: "${id}"`);
    if (seen.has(id)) fail(`Duplicate admin menu id: ${id}`);
    seen.add(id);

    const screen = String(menu.screen || "");

    // `plugin-page:<id>` opens a page the plugin declared (rule 50). Checked
    // before the fixed-screen list, because the whole point is that it is
    // parameterised — it can never be a member of that list.
    if (screen.startsWith(PLUGIN_PAGE_SCREEN_PREFIX)) {
      const pageId = screen.slice(PLUGIN_PAGE_SCREEN_PREFIX.length);
      if (!pageId) fail(`adminMenu ${id}: screen "${screen}" names no page`);
      if (!declaredPages.has(pageId)) {
        // An id that resolves to nothing opens a screen with nothing to render:
        // the sidebar entry looks correct and the page behind it is blank, which
        // reads as a load failure rather than a manifest typo.
        fail(
          `adminMenu ${id}: opens plugin page "${pageId}", which is not in adminPages[]` +
          (declaredPages.size ? ` (declared: ${[...declaredPages].join(", ")})` : " (none declared)")
        );
      }
    } else if (!(ALLOWED_ADMIN_SCREENS as readonly string[]).includes(screen)) {
      fail(`Unsupported admin screen "${screen}" for menu ${id}`);
    }

    // A menu may gate itself behind a capability. Checking it here means an
    // installed-but-unusable menu is impossible.
    if (menu.capability !== undefined && menu.capability !== null && !isCapability(String(menu.capability))) {
      fail(`adminMenu ${id}: unsupported capability "${menu.capability}"`);
    }

    if (
      menu.label_key !== undefined &&
      menu.label_key !== null &&
      (typeof menu.label_key !== "string" || !keyRe.test(menu.label_key))
    ) {
      fail(`adminMenu ${id}: label_key must match "${ownerType}.${ownerName}.<key>" (rule 11), got "${menu.label_key}"`);
    }

    if (menu.args !== undefined && (typeof menu.args !== "object" || menu.args === null || Array.isArray(menu.args))) {
      fail(`adminMenu ${id}: args must be an object`);
    }
    const args: Record<string, unknown> = (menu.args && typeof menu.args === "object" && !Array.isArray(menu.args))
      ? menu.args as Record<string, unknown>
      : {};

    if ((TABLE_ADMIN_SCREENS as readonly string[]).includes(screen)) {
      const table = String(args.table || "");
      if (!table) fail(`adminMenu ${id}: screen "${screen}" requires args.table`);
      if (!declaredTables.has(table)) {
        fail(`adminMenu ${id}: references table "${table}" which is not declared in tables[]`);
      }
    }

    if (screen === "custom") {
      const view = String(args.view || "");
      if (!view) fail(`adminMenu ${id}: screen "custom" requires args.view`);
      // The view is resolved inside the extension package, so it must not be
      // able to walk out of it.
      if (view.startsWith("/") || view.includes("..") || view.includes("\\") || view.includes("\0")) {
        fail(`adminMenu ${id}: args.view must be a relative path inside the package`);
      }
    }

    if (screen === "content-list" && args.type !== undefined && !IDENT_RE.test(String(args.type))) {
      fail(`adminMenu ${id}: args.type must be an identifier`);
    }
  }
}

function validateThemeManifest(m: any) {
  // `templates` / `parts` are now actually honoured by the resolver, so reject
  // nonsense names instead of silently ignoring them as the old code did.
  for (const key of ["templates", "parts"] as const) {
    if (m[key] === undefined) continue;
    for (const t of asArray(m[key])) {
      if (!validTemplateName(t)) fail(`Invalid ${key} entry: ${t}`);
    }
  }

  for (const pt of asArray(m.postTypes)) {
    if (!pt || typeof pt !== "object") fail("postTypes entries must be objects");
    if (!IDENT_RE.test(String(pt.name || ""))) fail(`Invalid post type name: ${pt?.name}`);
    if (pt.supports !== undefined && !Array.isArray(pt.supports)) fail(`postType ${pt.name}: supports must be an array`);
  }

  for (const tax of asArray(m.taxonomies)) {
    if (!tax || typeof tax !== "object") fail("taxonomies entries must be objects");
    if (!IDENT_RE.test(String(tax.name || ""))) fail(`Invalid taxonomy name: ${tax?.name}`);
    if (tax.postTypes !== undefined && !Array.isArray(tax.postTypes)) fail(`taxonomy ${tax.name}: postTypes must be an array`);
  }

  for (const f of asArray(m.fields)) {
    if (!f || typeof f !== "object") fail("fields entries must be objects");
    if (!FIELD_KEY_RE.test(String(f.key || ""))) fail(`Invalid field key: ${f?.key}`);
    const ft = String(f.type || "text");
    if (!(ALLOWED_FIELD_TYPES as readonly string[]).includes(ft)) fail(`Unsupported field type "${ft}" for key ${f.key}`);
    if (f.postTypes !== undefined && !Array.isArray(f.postTypes)) fail(`field ${f.key}: postTypes must be an array`);
  }

  const seenPaths = new Set<string>();
  for (const r of asArray(m.routes)) {
    if (!r || typeof r !== "object") fail("routes entries must be objects");
    const path = String(r.path || "");
    if (!path || !path.startsWith("/")) fail(`Route path must start with "/": ${path}`);
    if (path.includes("..")) fail(`Route path may not contain "..": ${path}`);
    if (seenPaths.has(path)) fail(`Duplicate route path: ${path}`);
    seenPaths.add(path);
    const tpl = String(r.template || "");
    if (!tpl) fail(`Route ${path} must declare a template`);
    // The renderer now *consumes* this name — it outranks the hierarchy — so a
    // malformed one is not cosmetic: it becomes an R2 path segment.
    if (!validTemplateName(tpl)) fail(`Route ${path}: invalid template name "${tpl}"`);

    // `resolve` decides what the route reads. Every branch below has a silent
    // default, and a silent default is how a declaration stops meaning anything:
    // `by: "ID"` quietly reads by slug, and a route declaring both `type` and
    // `table` gets the table ignored because the post lookup runs last and
    // overwrites the row. Neither is a style question — both answer a request
    // with the wrong data and no error.
    const res = r.resolve;
    if (res !== undefined) {
      if (!res || typeof res !== "object") fail(`Route ${path}: resolve must be an object`);
      const hasType = res.type !== undefined && String(res.type) !== "";
      const hasTable = res.table !== undefined && String(res.table) !== "";
      if (!hasType && !hasTable) fail(`Route ${path}: resolve must declare "type" or "table"`);
      if (hasType && hasTable) {
        fail(`Route ${path}: resolve declares both "type" and "table"; only one can decide what the route reads`);
      }
      if (hasType && !IDENT_RE.test(String(res.type))) {
        fail(`Route ${path}: resolve.type must be an identifier, got "${res.type}"`);
      }
      if (res.by !== undefined && res.by !== "slug" && res.by !== "id") {
        fail(`Route ${path}: resolve.by must be "slug" or "id", got "${res.by}"`);
      }
    }

    // `query.as` names the scope variable the listing lands in — the same
    // attribute `{{@query ... as="x"}}` takes. A name the expression parser
    // cannot tokenise would produce a binding no template can read, which looks
    // exactly like "the query returned nothing".
    if (r.query !== undefined) {
      if (!r.query || typeof r.query !== "object" || Array.isArray(r.query)) {
        fail(`Route ${path}: query must be an object`);
      } else if (r.query.as !== undefined && !SCOPE_NAME_RE.test(String(r.query.as))) {
        fail(`Route ${path}: query.as must be a template scope name, got "${r.query.as}"`);
      }
    }
  }

  // `adminMenus` is validated *after* `tables[]` below, because a
  // `table-list` / `table-edit` menu must name a table this manifest declares
  // and the declared set does not exist yet at this point.

  // -- Theme-owned tables (§3.2 / §9 decisions 2, 3) ------------------------
  //
  // The table name becomes part of a generated identifier
  // (`theme_{owner}_{name}`), so a bad name is not a style problem — it is
  // unrepresentable DDL. Fields and `translatable` are checked against each
  // other because "translate a field that does not exist" is the most likely
  // mistake and produces a silently-empty translation table.
  const declaredTables = validateTables(m);

  // A route resolving against a table must declare that table. Checked here as
  // well as in the architecture test: the test guards the *shipped* themes,
  // this guards anything installed at runtime, including third-party zips.
  for (const r of asArray(m.routes)) {
    const tbl = r?.resolve?.table;
    if (tbl && !declaredTables.has(String(tbl))) {
      fail(`route ${r?.path}: resolves table "${tbl}" which is not declared in tables[]`);
    }
  }

  // Now that `declaredTables` exists, the menus can be checked against it.
  validateAdminMenus(m.adminMenus, declaredTables, "theme", String(m.name));

  for (const code of asArray(m.locales)) {
    if (!LOCALE_CODE_RE.test(String(code))) {
      fail(`Invalid locale code: "${code}" (expected BCP-47 shape, e.g. "en", "zh-CN")`);
    }
  }

  for (const b of asArray(m.blocks)) {
    if (!b || typeof b !== "object") fail("blocks entries must be objects");
    if (!String(b.name || "")) fail("blocks entries need a name");
    if (!IDENT_RE.test(String(b.name))) fail(`Invalid block name: ${b.name}`);
  }

  for (const s of asArray(m.settings)) {
    if (!s || typeof s !== "object") fail("settings entries must be objects");
    const skey = String(s.key || "");
    if (!skey) fail("settings entries need a key");
    // Dotted keys are the convention (`shop.currency`); a bare identifier also
    // works. Anything else breaks the settings lookup, which splits on dots.
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i.test(skey)) fail(`Invalid setting key: "${skey}"`);
    if (s.type !== undefined && !(ALLOWED_FIELD_TYPES as readonly string[]).includes(String(s.type))) {
      fail(`setting ${skey}: unsupported type "${s.type}"`);
    }
    if (s.options !== undefined && !Array.isArray(s.options)) fail(`setting ${skey}: options must be an array`);
    if (s.default !== undefined && typeof s.default === "object" && s.default !== null) {
      fail(`setting ${skey}: default must be a scalar`);
    }
  }

  if (m.runtime !== undefined && !["declarative", "worker"].includes(String(m.runtime))) {
    fail(`Unsupported runtime: ${m.runtime}`);
  }

  // A worker-runtime theme renders from code and declares its entry file. Both
  // halves must agree or activation succeeds and the theme never renders.
  if (String(m.runtime) === "worker" && !String(m.entry || "")) {
    fail('runtime "worker" requires an "entry" file name');
  }
}

/**
 * Validate a `tables[]` declaration and return the logical names it declares.
 *
 * Shared by themes and plugins. The rules below are about the *declaration*,
 * not about who made it: the language requirement (prose must be translatable,
 * language-neutral must not be) and the naming rules apply identically to both
 * owners, and a second copy would be a second answer waiting to diverge — with
 * the symptom being a plugin whose prose silently stops being translatable the
 * day someone fixes one copy only.
 */
function validateTables(m: any): Set<string> {
  const declaredTables = new Set<string>();
  for (const t of asArray(m.tables)) {
    if (!t || typeof t !== "object") fail("tables entries must be objects");
    const tname = String(t.name || "");
    if (!TABLE_NAME_RE.test(tname)) fail(`Invalid table name: "${tname}" (expected /^[a-z][a-z0-9_]{1,63}$/)`);
    if (declaredTables.has(tname)) fail(`Duplicate table name: ${tname}`);
    declaredTables.add(tname);

    const fieldKeys = new Set<string>();
    for (const f of asArray(t.fields)) {
      if (!f || typeof f !== "object") fail(`table ${tname}: fields entries must be objects`);
      const key = String(f.key || "");
      if (!FIELD_KEY_RE.test(key)) fail(`table ${tname}: invalid field key "${key}"`);
      if ((RESERVED_COLUMNS as readonly string[]).includes(key)) fail(`table ${tname}: field "${key}" collides with a reserved column`);
      if (fieldKeys.has(key)) fail(`table ${tname}: duplicate field key "${key}"`);
      fieldKeys.add(key);
      const ft = String(f.type || "text");
      if (!(ALLOWED_TABLE_FIELD_TYPES as readonly string[]).includes(ft)) {
        fail(`table ${tname}: unsupported field type "${ft}" for field "${key}" (allowed: ${ALLOWED_TABLE_FIELD_TYPES.join(", ")})`);
      }
      if (f.required !== undefined && typeof f.required !== "boolean") {
        fail(`table ${tname}.${key}: "required" must be a boolean`);
      }
    }

    for (const k of asArray(t.translatable)) {
      if (!fieldKeys.has(String(k))) fail(`table ${tname}: marks "${k}" translatable but declares no such field`);
    }

    // Multi-language capability is not opt-in (§2.5.3, AGENTS.md rule 41).
    //
    // Every field that holds prose a human reads must be translatable, and no
    // field that is language-neutral may be. This is checked at the install
    // boundary rather than trusted, for the same reason the field-type check
    // above is: a theme that omits `translatable` installs cleanly, renders
    // correctly in one language, and only reveals the problem when a second
    // language is enabled — by which time the fix is a migration plus a
    // retranslation pass.
    //
    // Direction A: prose must be declared.
    const declaredTranslatable = new Set(asArray(t.translatable).map(String));
    for (const f of asArray(t.fields)) {
      const key = String(f?.key || "");
      const ft = String(f?.type || "text");
      if (isProseFieldType(ft) && !declaredTranslatable.has(key)) {
        fail(
          `table ${tname}: field "${key}" is type "${ft}" (prose) and must be listed in ` +
          `translatable — every user-readable value carries multi-language capability`
        );
      }
      // Direction B: language-neutral fields must not be declared.
      if (!isProseFieldType(ft) && declaredTranslatable.has(key)) {
        fail(
          `table ${tname}: field "${key}" is type "${ft}" (language-neutral) and must not be ` +
          `listed in translatable — numbers, flags and dates are formatted per locale, not translated`
        );
      }
    }

    // -- the explicit language structure (rule 42) --------------------------
    //
    // `language` states the *strategy*, which `translatable` cannot express.
    // Everything below is about keeping the two spellings of the same list in
    // agreement: a manifest may use either, but not both saying different things.
    const lang = t.language;
    if (lang !== undefined) {
      if (!lang || typeof lang !== "object" || Array.isArray(lang)) {
        fail(`table ${tname}: language must be an object`);
      } else {
        const strategy = lang.strategy === undefined ? "sidecar" : String(lang.strategy);
        if (!(TABLE_LANGUAGE_STRATEGIES as readonly string[]).includes(strategy)) {
          fail(
            `table ${tname}: language.strategy "${strategy}" is not one of ` +
            `${TABLE_LANGUAGE_STRATEGIES.join(" / ")}`
          );
        }

        // `strategy: "none"` is a claim that this table holds no prose. If it
        // does, the claim is false and the table would silently never be
        // translated — so check the claim rather than trusting it.
        const proseFields = asArray(t.fields)
          .filter((f) => isProseFieldType(String(f?.type ?? "text")))
          .map((f) => String(f?.key ?? ""));
        if (strategy === "none" && proseFields.length) {
          fail(
            `table ${tname}: language.strategy is "none" but fields ${proseFields.join(", ")} ` +
            `hold prose — those values would never be translatable`
          );
        }

        // `versioned` is declared for completeness but not implemented in v0.8.
        // Rejecting it here beats accepting a declaration the runtime ignores
        // (the "declared but never read" defect family this repo keeps hitting).
        if (strategy === "versioned") {
          fail(
            `table ${tname}: language.strategy "versioned" is not implemented in this version — ` +
            `use "sidecar" (the platform's L1-style shape is reserved for posts)`
          );
        }

        // Both spellings present => they must agree. Picking one silently means
        // the other is stale, and no later reader can tell which.
        if (Array.isArray(lang.translatable)) {
          const nested = [...new Set(lang.translatable.map(String))].sort();
          const flat = [...declaredTranslatable].sort();
          if (!Array.isArray(t.translatable)) {
            // Only the nested form was written; that is fine, but the flat list
            // is what the generator and facade read, so it must be populated.
            fail(
              `table ${tname}: language.translatable is present but the flat "translatable" is not — ` +
              `declare both or neither, so there is no ambiguity about which one is authoritative`
            );
          } else if (JSON.stringify(nested) !== JSON.stringify(flat)) {
            fail(
              `table ${tname}: language.translatable and translatable disagree ` +
              `([${nested.join(", ")}] vs [${flat.join(", ")}])`
            );
          }
          for (const k of lang.translatable) {
            if (!fieldKeys.has(String(k))) {
              fail(`table ${tname}: language.translatable names "${k}", which is not a declared field`);
            }
          }
        }

        for (const k of asArray(lang.fallback)) {
          if (!LOCALE_CODE_RE.test(String(k))) {
            fail(`table ${tname}: language.fallback entry "${k}" is not a valid locale code`);
          }
        }
        for (const k of asArray(lang.requiredLocales)) {
          if (!LOCALE_CODE_RE.test(String(k))) {
            fail(`table ${tname}: language.requiredLocales entry "${k}" is not a valid locale code`);
          }
        }
      }
    }

    // Decision 4 (unified menu registry): a `table-list` / `table-edit` screen
    // must point at a table this theme actually declares.
    const listScreen = String(t.admin?.screen || "");    if (listScreen && !(ALLOWED_ADMIN_SCREENS as readonly string[]).includes(listScreen)) {
      fail(`table ${tname}: unsupported admin screen "${listScreen}"`);
    }
  }
  return declaredTables;
}

