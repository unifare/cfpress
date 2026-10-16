/**
 * The authoritative answer to "what scope does this data live at?" (§10 rules 41–44)
 *
 * ## Why this file exists
 *
 * A multi-tenant, multi-language CMS has exactly two axes on which *every*
 * stored row must have a defensible answer:
 *
 *   - **tenant** — which site does this row belong to? (`site_id`)
 *   - **language** — is this row per-language, or language-neutral? (`locale`)
 *
 * Neither axis is self-evident from a table's name. `media_files` looks global
 * and is not. `locales` looks per-site and is not — it is the platform's
 * language registry, shared by every site. Getting one of these wrong is
 * *invisible in a single-tenant, single-language install*, which is the only
 * configuration anyone tests by hand. That is precisely the failure mode this
 * file is built to make impossible.
 *
 * So the classification is *declared here, once*, and then **checked against
 * the real database** by `tests/suites/architecture.test.mjs` (via a live
 * `PRAGMA table_info` walk). A table that is tenant-scoped must really have
 * `site_id`; a table that is not must be on the exempt list *with a reason*.
 * Adding a table without classifying it fails the suite.
 *
 * ## The three kinds of scope
 *
 * 1. **Tenant-scoped** (`TENANT_TABLES`) — one row per site. Must have `site_id`.
 * 2. **Platform-global** (`PLATFORM_TABLES`) — one row for the whole install.
 *    Must *not* have `site_id` (having one would suggest per-site copies that
 *    do not exist). Some of these are "child" rows reached through a
 *    tenant-scoped parent — `post_meta` joins to `posts.site_id` — and are
 *    listed in `DERIVED_TENANT_TABLES` to say so explicitly.
 * 3. **Generated** (`GENERATED_*`) — tables the platform creates from an
 *    extension declaration. Their shape is not fixed, so they are matched by
 *    pattern rather than by name, and the *rules* for their columns are stated
 *    instead of a list.
 *
 * ## Language is a different question from tenant
 *
 * Tenant scope answers "whose row is this". Language scope answers "is this
 * value the same in every language". They are independent: `settings` is
 * tenant-scoped and language-neutral; `locales` is platform-global and is
 * *about* language without being per-language; `theme_eshop_product_i18n` is
 * neither tenant-scoped (it is reached through its parent row) nor
 * language-neutral.
 *
 * `LOCALE_TABLES` therefore lists, by table, *how* language is expressed —
 * because "has a `locale` column" is not the only shape. A versioned table
 * keys on `(post_id, locale)`; a sidecar keys on `(row_id, locale)`; the main
 * row of a sidecar pair carries `lang_group` and no locale at all.
 *
 * Keeping the *reason* next to each entry is the point. A bare allow-list rots;
 * a list where every entry has to justify itself gets re-read.
 */

/**
 * Every table in the platform schema, with its tenant + language scope.
 *
 * `tenant`: `"site"` (must have `site_id`) or `"platform"` (must not, and the
 *           note says why).
 * `derivedTenant`: for platform tables reached through a tenant-scoped parent,
 *                  the FK column that carries the scope. These are genuinely
 *                  tenant-isolated, just not by a local column.
 * `locale`: how language is expressed, or `null` for language-neutral.
 *           - `{ kind: "column" }`  — a `locale` column on this table
 *           - `{ kind: "sidecar" }` — paired `X` + `X_i18n` (this is the `X`)
 *           - `{ kind: "i18n" }`    — this IS an `X_i18n` sidecar
 *           Note: sidecar tables have no `site_id`; their scope is inherited
 *           from the parent row they point at via `row_id`.
 * `onSiteDelete`: what happens to **this site's rows** when the site itself is
 *           deleted. Required on every `tenant: "site"` entry.
 *           - `"purge"` — per-site config or registry: it means nothing without
 *             the site, so `deleteSite()` removes it. A leftover
 *             `admin_menu_registry` row for a deleted site is a menu that
 *             appears in the admin and cannot be opened.
 *           - `"retain"` — content, media or audit history: the rows become
 *             unreachable (nothing resolves the deleted site) but are **not**
 *             destroyed. Deleting a site must not destroy an author's work —
 *             the same policy a theme switch follows.
 *           ⚠️ The requirement is the point. A new site-scoped table that does
 *           not declare a policy fails `architecture.test.mjs`, so "we deleted
 *           a site and its registry rows are still there" cannot happen again
 *           by omission. The list `deleteSite()` walks is *derived from here*,
 *           so there is no second place to forget.
 */
export const PLATFORM_SCHEMA = [
  // -- tenant-scoped, language-neutral ---------------------------------------
  { table: "admin_menu_registry", tenant: "site", locale: null, onSiteDelete: "purge", note: "menus are per site; plugin rows use site_id='*' (rule 32)" },
  { table: "field_defs", tenant: "site", locale: null, onSiteDelete: "purge", note: "post-type field definitions are per site" },
  { table: "menu_items", tenant: "site", locale: { kind: "column" }, onSiteDelete: "purge", note: "nav items are translated in place (locale column)" },
  { table: "menus", tenant: "site", locale: null, onSiteDelete: "purge", note: "menu containers; items carry the locale" },
  { table: "post_types", tenant: "site", locale: null, onSiteDelete: "purge", note: "CPT registration is per site (theme activation differs per site)" },
  { table: "posts", tenant: "site", locale: null, onSiteDelete: "retain", note: "content language is expressed by lang_group + post_translations" },
  { table: "redirects", tenant: "site", locale: null, onSiteDelete: "purge", note: "redirects are per site" },
  { table: "rewrites", tenant: "site", locale: null, onSiteDelete: "purge", note: "rewrite rules are per site" },
  { table: "settings", tenant: "site", locale: null, onSiteDelete: "purge", note: "site settings (UNIQUE(site_id,key))" },
  { table: "site_locales", tenant: "site", locale: null, onSiteDelete: "purge", note: "which languages this site serves" },
  { table: "taxonomies", tenant: "site", locale: null, onSiteDelete: "purge", note: "taxonomy registration is per site" },
  { table: "terms", tenant: "site", locale: null, onSiteDelete: "purge", note: "terms are per site" },
  { table: "theme_blocks", tenant: "site", locale: null, onSiteDelete: "purge", note: "declared blocks are per site" },
  { table: "theme_routes", tenant: "site", locale: null, onSiteDelete: "purge", note: "front-end routes are per site; the 404-on-theme-switch defect lived here" },
  { table: "theme_table_defs", tenant: "site", locale: null, onSiteDelete: "purge", note: "logical→physical table map is per site" },
  { table: "media_files", tenant: "site", locale: null, onSiteDelete: "retain", note: "site_id added in migration 0009; uploaded_by added in 0018 (NULL = uploaded before ownership existed, grandfathered visible site-wide); storage/remote_url/remote_delete_url added in 0025 (r2 = this install's bucket, else a third-party host; the row stays the tenant+owner record and the policy front door either way); alt_text/title are language-neutral by design — one alt for every language, stated in the editor UI rather than silently assumed" },
  { table: "members", tenant: "site", locale: null, onSiteDelete: "purge", note: "front-end member accounts, per site by construction (migration 0022). Deliberately NOT a role on site_users: 'registered on the shop site' is a tenant fact, not an install-wide identity" },
  { table: "member_sessions", tenant: "site", locale: null, onSiteDelete: "purge", note: "member session token → member, carrying site_id so deleteSite()'s uniform per-site purge reaches it. A table distinct from admin_sessions, so a member session id is not a valid admin session id by construction (migration 0022)" },
  { table: "site_users_sites", tenant: "site", locale: null, onSiteDelete: "purge", note: "the (person, site) membership that replaces a single global `site_users.role` — one row per site a staff user may act on, and the ABSENCE of a row is the denial (migration 0023). Carries site_id so a deleted site's memberships go with it; the identity itself (site_users) is install-wide and is NOT purged, because the person outlives the site" },

  // -- tenant-scoped via a parent (no local site_id, by design) --------------
  { table: "post_meta", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: { kind: "column" }, note: "custom post fields; scoped by the post they hang off, per language since 0019 (a category name is prose, not a number). '' = written before the dimension existed; the read ladder is own locale → site default → '' → any" },
  { table: "post_revisions", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: { kind: "column" }, note: "revisions carry a locale column AND inherit tenant from the post" },
  { table: "post_autosaves", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: { kind: "column" }, note: "autosave draft, keyed (post_id,user_id,locale)" },
  { table: "post_translations", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: { kind: "column" }, note: "L1 content translation; keyed (post_id,locale)" },
  { table: "seo_meta", tenant: "platform", derivedTenant: "entity_id → posts.site_id", locale: { kind: "column" }, note: "polymorphic entity_type/entity_id; per-language SEO fields" },
  { table: "term_relationships", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: null, note: "pure join table" },
  { table: "scheduled_posts", tenant: "platform", derivedTenant: "post_id → posts.site_id", locale: null, note: "publish queue keyed by post" },

  // -- platform-global ------------------------------------------------------
  { table: "sites", tenant: "platform", locale: null, note: "THE tenant registry — a row here IS a site, so it cannot have site_id" },
  { table: "locales", tenant: "platform", locale: null, note: "language registry shared by all sites; per-site enablement is site_locales" },
  { table: "site_users", tenant: "platform", locale: null, note: "users are install-wide; ui_lang/menu_prefs are per-user preferences" },
  { table: "admin_sessions", tenant: "platform", locale: null, note: "session token → user; site is resolved per request, not per session" },
  { table: "admin_activity", tenant: "platform", locale: null, note: "audit log is install-wide" },
  { table: "role_permissions", tenant: "platform", locale: null, note: "role→permission matrix is install-wide (an explicit §9 decision)" },
  { table: "i18n_overrides", tenant: "site", locale: { kind: "column" }, onSiteDelete: "purge", note: "UI-string overrides ARE per site AND per language — the one table that is both" },
  { table: "content_cache_versions", tenant: "platform", locale: null, note: "cache generation counters; bumped per site by key" },
  { table: "extension_versions", tenant: "platform", locale: null, note: "installed extension packages (theme/plugin zips)" },
  { table: "extension_capabilities", tenant: "platform", locale: null, note: "capability flags per installed extension" },
  { table: "plugin_installs", tenant: "platform", locale: null, note: "plugin registry; plugins are install-wide (menus may be per site via site_id='*')" },
  { table: "theme_installs", tenant: "platform", locale: null, note: "theme registry; which theme is ACTIVE is per site (settings key theme.active)" },
  { table: "plugin_setting_defs", tenant: "platform", locale: null, note: "plugin-declared setting schema" },
  { table: "plugin_settings", tenant: "platform", locale: null, note: "plugin setting values, keyed (plugin_id,key); no site dimension in v0.8" },
  { table: "theme_setting_defs", tenant: "platform", locale: null, note: "theme-declared setting schema, keyed by theme_name" },
  { table: "theme_settings", tenant: "platform", locale: null, note: "theme setting values, keyed (theme_name,key); config read only by the admin, not the front end" },
  { table: "shortcodes", tenant: "platform", locale: null, note: "registered shortcodes (platform-global registry)" },
  { table: "platform_settings", tenant: "platform", locale: null, note: "install-wide settings (admin.path); the platform half of the two-level settings model - the site half is `settings`. Every key is declared in SETTING_DEFS (src/platform/settings.ts)" },
  { table: "widget_instances", tenant: "site", locale: { kind: "column" }, onSiteDelete: "purge", note: "sidebar widget placement; per site since 0020 (was install-wide — leaked across sites)" },
  { table: "notification_log", tenant: "site", locale: null, onSiteDelete: "retain", note: "host-written send ledger: also the dedup store for ChannelMessage.dedupKey" },
  { table: "api_keys", tenant: "platform", locale: null, note: "machine-to-machine API keys for external AI agents and workflows; install-wide token registry" },
] as const;

/**
 * A generated table: `theme_{name}_{table}` and `plugin_{name}_{table}`.
 *
 * ⚠️ **This pattern alone is not a sufficient discriminator**, and relying on
 * it produced a real false positive: `theme_installs`, `theme_settings`,
 * `plugin_installs` and `plugin_settings` all match it, yet they are platform
 * registry tables with no `site_id` by design. A name prefix cannot tell
 * "a table a theme declared" from "a platform table about themes".
 *
 * The authority is therefore `PLATFORM_SCHEMA`: a table is *generated* only if
 * it matches this pattern **and** is not a declared platform table. Use
 * `isGeneratedTable()` / `isGeneratedBusinessTable()` rather than testing this
 * regex directly.
 */
export const GENERATED_TABLE_RE = /^(?:theme|plugin)_[a-z][a-z0-9_]*$/;

/** A generated translation sidecar: `…_i18n`. */
export const GENERATED_I18N_TABLE_RE = /_i18n$/;

/** Infra tables owned by the runtime, not by CFPress. */
export const RUNTIME_TABLES = ["\u005fcf_METADATA", "d1_migrations"] as const;

/** Platform tables that must carry `site_id`. */
export const TENANT_TABLES = PLATFORM_SCHEMA
  .filter((t) => t.tenant === "site")
  .map((t) => t.table);

/** Platform tables that must NOT carry `site_id`, with the reason. */
export const PLATFORM_TABLES = PLATFORM_SCHEMA
  .filter((t) => t.tenant === "platform")
  .map((t) => t.table);

/** Tables whose tenant scope is inherited through a parent row. */
export const DERIVED_TENANT_TABLES = PLATFORM_SCHEMA
  .filter((t) => "derivedTenant" in t && t.derivedTenant)
  .map((t) => t.table);

/**
 * Site-scoped tables whose rows `deleteSite()` removes.
 *
 * Derived from the declaration above, for the same reason `TENANT_TABLES` is:
 * a hand-written list drifts, and the drift is invisible until someone deletes
 * a site and finds its menus still in the admin.
 */
export const PURGE_ON_SITE_DELETE = PLATFORM_SCHEMA
  .filter((t) => t.tenant === "site" && t.onSiteDelete === "purge")
  .map((t) => t.table);

/** Tables that express language through a `locale` column. */
export const LOCALE_COLUMN_TABLES = PLATFORM_SCHEMA
  .filter((t) => t.locale && t.locale.kind === "column")
  .map((t) => t.table);

/** Tables with no language dimension. */
export const LANGUAGE_NEUTRAL_TABLES = PLATFORM_SCHEMA
  .filter((t) => t.locale === null)
  .map((t) => t.table);

/**
 * The columns that express each axis. Kept next to the classification so the
 * rule "tenant-scoped means site_id" has exactly one spelling.
 */
export const TENANT_COLUMN = "site_id";
export const LOCALE_COLUMN = "locale";

/** Is this a generated extension table (not part of the platform schema)? */
export function isGeneratedTable(name: string): boolean {
  return isGeneratedBusinessTable(name) || isI18nTable(name);
}

/**
 * Is this a generated `_i18n` sidecar? (`…_i18n`, not a platform table.)
 *
 * `i18n_overrides` is a platform table that ends in neither, but the guard is
 * the same idea: the declaration wins over the suffix.
 */
export function isI18nTable(name: string): boolean {
  if (!GENERATED_I18N_TABLE_RE.test(name)) return false;
  if (PLATFORM_SCHEMA.some((t) => t.table === name)) return false;
  if ((RUNTIME_TABLES as readonly string[]).includes(name)) return false;
  return true;
}

/**
 * Is this a generated **business** table — one an extension declared, which
 * must therefore carry `site_id`?
 *
 * Must exclude the platform registry tables that share the `theme_`/`plugin_`
 * prefix. That exclusion is the whole reason this function exists rather than a
 * bare regex test at the call site.
 */
export function isGeneratedBusinessTable(name: string): boolean {
  if (!GENERATED_TABLE_RE.test(name)) return false;
  if (GENERATED_I18N_TABLE_RE.test(name)) return false;
  if (PLATFORM_SCHEMA.some((t) => t.table === name)) return false;
  if ((RUNTIME_TABLES as readonly string[]).includes(name)) return false;
  return true;
}

/** The declared scope record for a platform table, or `undefined`. */
export function scopeOf(table: string): (typeof PLATFORM_SCHEMA)[number] | undefined {
  return PLATFORM_SCHEMA.find((t) => t.table === table);
}
