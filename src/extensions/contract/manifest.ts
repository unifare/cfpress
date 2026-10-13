/**
 * The vocabulary an extension declaration may use (ARCHITECTURE.md §5.3).
 *
 * Everything here answers one question: *what is a legal declaration?* The
 * allowed capability names, the allowed admin screens, the six field types a
 * generated table may use, the reserved columns, and the shape rules for the
 * identifiers that end up inside generated SQL or R2 keys.
 *
 * ## Why this is a separate file from `validation.ts`
 *
 * `validation.ts` asks "is this particular manifest acceptable?" and produces a
 * message. This file says what exists at all. Keeping them apart matters because
 * the vocabularies have **other readers**: `tests/suites/architecture.test.mjs` reads
 * this file to check that every *shipped* theme and plugin only uses screens
 * that exist, and the admin SPA needs the same set to decide whether it has a
 * renderer. When the list lived inside the validator, the only way to check a
 * shipped manifest was to copy the list — and a copy drifts.
 *
 * So: **add a screen or a field type here, and every reader sees it at once.**
 * Nothing may re-declare these lists locally.
 */

import type { NotificationChannel } from "./channels";

/**
 * Columns the platform owns on every generated table.
 *
 * A theme declaring one of these would produce a `CREATE TABLE` with two
 * columns of the same name — or worse, silently shadow the platform's
 * `site_id` and break multi-site isolation for that table. There is no
 * legitimate use, so it is rejected rather than de-duplicated.
 */
export const RESERVED_COLUMNS = [
  "id", "site_id", "slug", "lang_group", "status", "created_at", "updated_at",
] as const;

/** Field types allowed on a post type's custom fields (13, incl. media/select). */
export const ALLOWED_FIELD_TYPES = [
  "text", "textarea", "number", "boolean", "select", "date", "datetime",
  "media", "media-multiple", "color", "url", "email", "richtext",
] as const;

/**
 * Field types allowed on an extension-declared table (§9 decision 2: basic
 * only).
 *
 * Deliberately much shorter than `ALLOWED_FIELD_TYPES`. Every type here must
 * have exactly one admin control (see `public/admin/js/table-form.js`), because
 * the admin form is *generated* from the declaration — a type with no control
 * would render an empty input and look like a data problem.
 */
export const ALLOWED_TABLE_FIELD_TYPES = ["text", "longtext", "number", "boolean", "date", "datetime"] as const;

/**
 * Field types whose value is **prose a human reads**, and which therefore must
 * be translatable.
 *
 * This pairing is the machine-checkable form of a product rule: *every piece of
 * data in this system carries multi-language capability*. A field holding words
 * that a visitor reads in their own language has no business being
 * single-valued — if it is, then enabling a second language silently shows
 * everyone the first language's text, and the only way to fix it later is a
 * migration plus a manual retranslation pass.
 *
 * The split is total: every entry in `ALLOWED_TABLE_FIELD_TYPES` is in exactly
 * one of this list and `LANGUAGE_NEUTRAL_FIELD_TYPES` (asserted by
 * `tests/suites/architecture.test.mjs`, so adding a seventh type cannot silently skip
 * the decision).
 */
export const PROSE_FIELD_TYPES = ["text", "longtext"] as const;

/**
 * Field types whose value means the same thing in every language.
 *
 * A price, a stock count, a boolean flag and a calendar date are not
 * translated — they are *formatted* per locale at render time. Marking one of
 * these `translatable` would create an `_i18n` column that editors are invited
 * to fill with a different number per language, which is a data-integrity
 * problem dressed as a feature.
 *
 * The two lists are complementary and must stay that way — see
 * `PROSE_FIELD_TYPES` for the totality check.
 */
export const LANGUAGE_NEUTRAL_FIELD_TYPES = ["number", "boolean", "date", "datetime"] as const;

/**
 * Does a field of this type hold translated prose?
 *
 * The single answer to "must this field be in `translatable`?" — used by the
 * runtime validator, the architecture test, and the scaffolder. Anything that
 * needs to make this decision asks here rather than re-deriving it from a list,
 * because a second derivation is a second answer waiting to disagree.
 */
export function isProseFieldType(type: string): boolean {
  return (PROSE_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Screen types a declared admin menu may open.
 *
 * `table-list` / `table-edit` (batch 3) are the two that let a theme show a
 * generated form for its own table without shipping a line of admin code — the
 * form is built from `tables[].fields[]`. `plugin-settings` is the plugin
 * counterpart of `theme-settings`: it opens the extension's own declared
 * settings rather than the site's.
 *
 * `plugin-page` (batch 10) is the third application of the same idea: a plugin
 * declares a page as *data* (`adminPages[].blocks[]`) and the host renders it.
 * The screen name is parameterised — `plugin-page:<id>` — so the menu registry
 * can tell which declared page it opens; see `pluginPageScreen()`.
 */
export const ALLOWED_ADMIN_SCREENS = [
  "dashboard", "content-list", "content-edit", "settings", "media", "custom",
  "theme-settings", "plugin-settings", "table-list", "table-edit", "features",
] as const;

/**
 * Prefix for a screen that opens a plugin-declared page.
 *
 * A plugin page cannot be a plain member of `ALLOWED_ADMIN_SCREENS` because
 * there is one per declared page, not one for the feature. So the screen is
 * `plugin-page:<id>`, where `<id>` must name a page the plugin actually
 * declared — an id that resolves to nothing would render an empty screen, which
 * is why the validator (rule 50) checks membership rather than just the prefix.
 */
export const PLUGIN_PAGE_SCREEN_PREFIX = "plugin-page:";

/** Build the screen name a menu uses to open a plugin-declared page. */
export function pluginPageScreen(pageId: string): string {
  return `${PLUGIN_PAGE_SCREEN_PREFIX}${pageId}`;
}

/**
 * Is this screen one of the fixed, unparameterised ones?
 *
 * Used by callers that must distinguish "a screen I have a renderer for" from
 * "a `plugin-page:<id>` I have to resolve first".
 */
export function isFixedAdminScreen(screen: string): boolean {
  return (ALLOWED_ADMIN_SCREENS as readonly string[]).includes(screen);
}

/**
 * Block types a plugin-declared page may be built from (rule 49).
 *
 * This is the whole mechanism behind "a plugin can have its own admin page"
 * without shipping code. The reference implementation offered
 * `sdk.adminPage(path, handler)` — a function the plugin registers, which a
 * Workers runtime cannot load and would not allow to run even if it could.
 * `blocks[]` preserves the capability and keeps the trust boundary: the plugin
 * says *what data, in what shape*, and the host decides how to render it.
 *
 * Every type here must have a renderer in `public/admin/js/plugin-page.js`; a
 * type with no renderer produces a blank section that looks like a failed load.
 * `tests/suites/architecture.test.mjs` checks the two lists against each other.
 *
 *   `table` — rows of one of the plugin's own tables, as a list
 *   `stats` — one aggregate over that table (count, grouped)
 *   `form`  — an input form writing through the host's facade
 */
export const ALLOWED_PAGE_BLOCKS = ["table", "stats", "form"] as const;

/**
 * Aggregates a `stats` block may declare (rule 49).
 *
 * A closed set, and deliberately small: each entry is one SQL expression the
 * host can compute without a query builder, and each has a server-side
 * implementation (`tableAggregate` in `theme/table-facade.ts`). A name outside
 * this list is refused at install time, so the admin never draws a "cannot
 * compute" panel for a manifest that could have been rejected.
 *
 * `latest` is NOT here. An earlier draft listed it in the renderer's `KNOWN`
 * set while the validator rejected it — a declaration the runtime could never
 * reach. Two spellings of one closed set is the drift the shared constant
 * exists to prevent; the validator and the renderer now read this list.
 */
export const ALLOWED_AGGREGATES = ["count", "sum"] as const;
export type PageAggregate = (typeof ALLOWED_AGGREGATES)[number];

/**
 * Screen types that read an extension-owned table, and therefore must name one.
 *
 * Kept next to the screen list rather than inside the validator so the two can
 * never drift: adding a screen here without adding it to
 * `ALLOWED_ADMIN_SCREENS` is a no-op, not a hole.
 */
export const TABLE_ADMIN_SCREENS = ["table-list", "table-edit"] as const;

/**
 * Locale codes accepted in a theme's `locales[]` and its `langs{}` keys.
 *
 * Deliberately a *shape* check (BCP-47-ish), not a membership check against
 * the `locales` table: a theme ships its language packs before it is
 * installed, and the platform's enabled-locale set is per site and may change
 * afterwards. What matters here is that the code is well-formed enough to be
 * a filename (`zh-CN.json`) and a URL segment.
 */
export const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/;

/** Names that become identifiers in generated DDL or generated SQL. */
export const IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const FIELD_KEY_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;

/**
 * Names a template scope variable may take.
 *
 * Used by a route's `query.as`, which is the same idea as the `as` attribute on
 * `{{@query ... as="x"}}`: it names the variable a listing lands in. Both should
 * therefore accept exactly the same spellings.
 *
 * Deliberately tighter than `IDENT_RE`. The value becomes a property a template
 * reaches through the expression parser, which tokenises identifiers as
 * `[A-Za-z_$][A-Za-z0-9_$]*`. A hyphen is a legal JS property name but is not
 * reachable from a template — `{{#each my-list}}` parses as `my` minus `list`,
 * and there is no arithmetic operator — so allowing it would create a binding
 * nobody can read, which is the failure mode this whole area keeps producing.
 */
export const SCOPE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Table names become identifiers in generated DDL, so keep them boring. */
export const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Template names are not identifiers: WordPress-style names may be numeric
 * (`404`), nested with a slash (`parts/card`) and contain dots (`single-post.v2`).
 * Reject only the things that would let a name escape the R2 prefix.
 */
export function validTemplateName(name: unknown): boolean {
  if (typeof name !== "string" || !name || name.length > 120) return false;
  if (name.startsWith("/") || name.includes("..") || name.includes("\\") || name.includes("\0")) return false;
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(name);
}

export function validExtensionName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-_]{1,63}$/.test(name);
}

export function validVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

// ---------------------------------------------------------------------------
// Declaration model
// ---------------------------------------------------------------------------
//
// These interfaces describe what a declaration may *say*. They are the type
// half of the same vocabulary the constants above describe, and they exist so
// that platform code reading a manifest has a name for the shape instead of
// passing `any` around. The validator still takes `unknown` at the boundary —
// an installed zip is untrusted input, and a type annotation is not a check.

export interface AdminMenuDecl {
  id: string;
  label: string;
  screen: string;
  icon?: string;
  /** Screen-specific. `table-list`/`table-edit` need `table`, `custom` needs `view`. */
  args?: Record<string, unknown>;
  /** Gates the menu on a capability; an unusable menu is then impossible. */
  capability?: string;
  sortOrder?: number;
}

export interface TableFieldDecl {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
}

/**
 * How a declared table stores its language dimension (§10 rule 42).
 *
 * This exists because `translatable` alone answers *which fields* vary by
 * language but not *how* the variation is stored — and those are different
 * facts. A reader (a migration author, a template, the admin editor) needs
 * both, and inferring the second from the first is how the `_i18n` naming rule
 * ended up hand-rolled in two places.
 *
 * The three strategies:
 *
 * - `"none"`     — the table holds no prose; every column is language-neutral.
 *                  A table of prices and flags. `translatable` must be empty.
 * - `"sidecar"`  — the default, and the only one v0.8 materialises. Prose moves
 *                  to a generated `{table}_i18n` keyed `(row_id, locale)` once
 *                  the site serves ≥2 languages; the main row keeps copies so a
 *                  second language needs no migration. Mirrors the platform's
 *                  own L1 design (§2.3).
 * - `"versioned"`— one full row per language, discriminated by `locale`, with
 *                  `lang_group` tying the versions together. The shape
 *                  `posts` + `post_translations` already uses. Declared here
 *                  for tables an extension manages in that style; v0.8 does not
 *                  generate these, so declaring one is an install error until
 *                  it does (see `validation.ts`).
 */
export const TABLE_LANGUAGE_STRATEGIES = ["none", "sidecar", "versioned"] as const;
export type TableLanguageStrategy = (typeof TABLE_LANGUAGE_STRATEGIES)[number];

/**
 * The language structure of a declared table.
 *
 * Written as a nested object rather than three parallel arrays because the
 * fields are *about each other*: a `fallback` only means something relative to
 * `translatable`, and a `strategy` of `"none"` makes both meaningless. Nesting
 * keeps them from drifting apart in a manifest that was hand-edited.
 */
export interface TableLanguageDecl {
  /** How the language dimension is stored. Defaults to `"sidecar"`. */
  strategy?: TableLanguageStrategy;
  /**
   * Field keys that vary by language. Must equal the prose fields of `fields[]`
   * exactly (rule 41) — this is where that requirement is *stated*, and
   * `translatable` is kept as the flat spelling of the same list.
   */
  translatable?: string[];
  /**
   * Locale codes to consult, in order, when the requested language has no
   * value — after the site default has already been tried.
   *
   * Empty/absent means "just the site default", which is the platform contract
   * (§10 rule 10). A theme may narrow it further but never extend it beyond the
   * site's enabled languages: promising a fallback the site does not serve
   * would render the wrong language rather than nothing.
   */
  fallback?: string[];
  /**
   * Locales this table requires a value for before a row may be published.
   *
   * A constraint on *content*, not on schema: the platform creates the columns
   * either way. Absent means "no requirement", which is the safe default for a
   * theme that has not thought about it.
   */
  requiredLocales?: string[];
}

export interface TableDecl {
  name: string;
  label?: string;
  /**
   * Field keys that also live in `{table}_i18n` when the site is multilingual.
   *
   * Kept as a flat list because it is the form the generator emits and the
   * validator checks; `language.translatable` is the same list in context.
   * When both are present they must agree — the validator rejects a mismatch
   * rather than picking a winner, because a silent pick means one of them is
   * stale and nobody can tell which.
   */
  translatable?: string[];
  /** Explicit language structure. See `TableLanguageDecl`. */
  language?: TableLanguageDecl;
  fields?: TableFieldDecl[];
}

export interface SettingDecl {
  key: string;
  type?: string;
  label?: string;
  options?: unknown[];
  default?: string | number | boolean | null;
}

/**
 * One section of a plugin-declared admin page.
 *
 * The `source` field names one of the plugin's own declared tables — the same
 * names as `tables[].name`, resolved through the owner-scoped facade. It is a
 * *logical* name; the plugin never learns the physical one (rule 8).
 */
export interface PageBlockDecl {
  type: PageBlockType;
  /** A logical table name from this plugin's own `tables[]`. */
  source?: string;
  /** `table`: which fields to show. Absent means the declared non-prose fields. */
  columns?: string[];
  /** `stats`: the aggregate to compute. */
  aggregate?: "count" | "sum";
  /** `stats`: the field to aggregate, and the field to group by. */
  field?: string;
  groupBy?: string;
  /** `form`: which fields to offer for input. */
  fields?: string[];
  /** Heading, as a dictionary key (rule 11). */
  labelKey?: string;
}

export type PageBlockType = (typeof ALLOWED_PAGE_BLOCKS)[number];

/**
 * An admin page a plugin declares.
 *
 * `path` is a single stable segment under the plugin's own admin URL; the host
 * owns the surrounding routes. It cannot be absolute and cannot contain `/`,
 * because a plugin that could choose its route could shadow a platform screen.
 */
export interface AdminPageDecl {
  id: string;
  path: string;
  /** Page title and nav label, as dictionary keys (rule 11). */
  titleKey?: string;
  title?: string;
  blocks?: PageBlockDecl[];
}

/** What both extension kinds declare. */
export interface ExtensionManifest {
  name: string;
  title?: string;
  version: string;
  description?: string;
  permissions?: string[];
  adminMenus?: AdminMenuDecl[];
  settings?: SettingDecl[];
  /** Inline language packs: locale code → `{ "plugin.{name}.key": "text" }`. */
  langs?: Record<string, Record<string, string>>;
}

export interface ThemeManifest extends ExtensionManifest {
  templates?: string[];
  parts?: string[];
  runtime?: "declarative" | "worker";
  entry?: string;
  supports?: string[];
  postTypes?: unknown[];
  taxonomies?: unknown[];
  fields?: unknown[];
  routes?: unknown[];
  /** Menu locations the theme renders; absence means the legacy `header`. */
  menuLocations?: { id: string; label?: string }[];
  /** Widget sidebars the theme renders; the SPA groups widgets by this list. */
  sidebars?: { id: string; label?: string }[];
  blocks?: unknown[];
  locales?: string[];
  tables?: TableDecl[];
}

export interface PluginManifest extends ExtensionManifest {
  hooks?: string[];
  /**
   * Domain events this plugin wants delivered (§10 rule 45).
   *
   * Distinct from `hooks`, and both are needed: `hooks` says *where the plugin
   * attaches*, `subscribes` says *which facts it cares about*. A plugin that
   * declares `hooks: ["afterSavePost"]` has signed up for an implementation
   * detail; one that declares `subscribes: ["PostPublished"]` has signed up for
   * a fact that survives the hook being reshaped.
   *
   * Validated against `DOMAIN_EVENTS`, so a misspelling is an install error
   * rather than a subscription that never fires.
   */
  subscribes?: string[];
  /**
   * Pages this plugin shows in the admin, as declarations (rule 49).
   *
   * Deliberately *not* a script path. A no-build Workers runtime cannot load
   * plugin code, and running it would breach the capability model — so a page
   * is described as blocks and rendered by the host.
   */
  adminPages?: AdminPageDecl[];
  /**
   * Notification channels this plugin offers (§2 of the design doc).
   *
   * Each declared `code` must be one the host implements
   * (`HOST_CHANNEL_CODES`); the plugin supplies the configuration *schema*, and
   * the host supplies the sending. Declaring an unimplemented channel would put
   * a selectable option in the admin that fails at send time.
   */
  channels?: NotificationChannel[];
  /**
   * Tables owned by this plugin. Same shape and same language rules as a
   * theme's `tables[]` — plugin tables get `_i18n` sidecars by default, not as
   * a special case (batch 10, migration 0014).
   */
  tables?: TableDecl[];
}

/** The normalised result of a successful validation. */
export interface ValidatedManifest {
  name: string;
  title: string;
  version: string;
  manifest: any;
}
