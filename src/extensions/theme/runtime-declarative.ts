/**
 * Theme runtime: binds the template engine to R2-stored theme files, the
 * content database and the template hierarchy resolver.
 *
 * This replaces the old `replaceAll`-based renderer. Templates are now real
 * programs (conditions, loops, includes, inheritance, queries) interpreted by
 * `template-engine.ts` — never evaluated as JavaScript, which keeps the
 * Worker's security model intact.
 */
import { Env } from "../../shared/types";
import { bundledThemeFile } from "../../shared/bundled";
import { esc, setting, siteInfo, menusForLocation, widgetGroups, locales, renderBlocks, formatDate, coverFrom, langNav, defaultLocale, readingTime } from "../../platform/frontend";
import { resolveMetaByPost } from "../../platform/post-meta";
import { parsePack } from "../../platform/i18n/translate";
import { resolveLocale } from "../../platform/i18n/resolve";
import { currentMember, memberScope } from "../../platform/members";
import { themePackKey } from "./packs";
import { resolveTemplate, templateCandidates, type TemplateContext } from "../../rendering/template-resolver";
import { resolveContentLocale } from "../../platform/i18n/locale-registry";
import { renderTemplateSource, TemplateError, type RenderOptions } from "../../rendering/template-engine";
import { NULL_HOOKS, hostHooks, type HostHooks } from "../contract/hooks";

// ---------------------------------------------------------------------------
// Theme discovery
// ---------------------------------------------------------------------------

export interface ActiveTheme {
  name: string;
  version: string;
  manifest: ThemeManifest;
}

export interface ThemeMenuLocation {
  id: string;
  label?: string;
}

export interface ThemeSidebar {
  id: string;
  label?: string;
}

export interface ThemeManifest {
  name: string;
  title: string;
  version: string;
  templates?: string[];
  parts?: string[];
  postTypes?: ThemePostType[];
  taxonomies?: ThemeTaxonomy[];
  fields?: ThemeField[];
  routes?: ThemeRoute[];
  /** Menu locations the theme can render; falls back to `header` alone. */
  menuLocations?: ThemeMenuLocation[];
  /** Widget sidebars the theme renders. */
  sidebars?: ThemeSidebar[];
  adminMenus?: ThemeAdminMenu[];
  blocks?: ThemeBlock[];
  settings?: ThemeSettingDef[];
  capabilities?: string[];
  runtime?: "declarative" | "worker";
}

export interface ThemePostType {
  name: string;
  label?: string;
  labels?: { singular?: string; plural?: string };
  supports?: string[];
  hasArchive?: boolean;
  rewrite?: { slug?: string };
}

export interface ThemeTaxonomy {
  name: string;
  label?: string;
  postTypes?: string[];
  hierarchical?: boolean;
}

export interface ThemeField {
  key: string;
  label?: string;
  type: string;
  postTypes?: string[];
  required?: boolean;
  default?: unknown;
}

export interface ThemeRoute {
  path: string;
  template: string;
  /** Heading shown on the rendered archive. Falls back to the template name. */
  title?: string;
  query?: Record<string, unknown>;
  resolve?: { type: string; by?: "slug" | "id" };
}

export interface ThemeAdminMenu {
  id: string;
  label: string;
  icon?: string;
  screen: string;
  args?: Record<string, unknown>;
  /**
   * Optional gate. The menu is hidden unless the viewer holds this capability.
   * It was accepted by the validator long before it was declared here, so a
   * theme could set it and have the type checker call it a mistake.
   */
  capability?: string;
  /**
   * Optional translation key for the label (`theme.{name}.…`). When the UI
   * dictionary has a translation for the current interface language, the
   * admin-menus API returns it instead of the literal `label`; when it does
   * not, `label` is returned unchanged. The fallback text is therefore not
   * optional even when a key is given.
   */
  label_key?: string;
}

export interface ThemeBlock {
  name: string;
  title?: string;
  template?: string;
}

export interface ThemeSettingDef {
  key: string;
  label?: string;
  type?: string;
  default?: unknown;
  /** Declared choices for a `select` setting (validator allows an array). */
  options?: unknown[];
}

/**
 * Resolve the active theme for a site.
 *
 * A missing `theme.active` setting is ambiguous: the string we would use as a
 * fallback is also a legitimate theme name (`default`), so a site whose
 * setting was never written looks exactly like a site that deliberately chose
 * the bundled theme — and, because the bundled theme has no R2 files, every
 * page then renders the bare `__fallback__` shell. That is a silent, very
 * confusing failure.
 *
 * So when no setting exists we do not guess by name. We walk the installed
 * themes and pick the first one whose package is actually present in R2
 * (probed by its `index.html`, the one template the hierarchy always ends
 * at), which guarantees the result can really render. Only if nothing is
 * loadable do we fall back to the literal `default`.
 */
export async function activeTheme(env: Env, siteId: string): Promise<ActiveTheme> {
  let name = await setting(env, "theme.active", "", siteId);
  if (!name) {
    // No explicit choice for this site: find one that can actually render.
    const candidates = await env.DB.prepare(
      "SELECT name, version FROM theme_installs ORDER BY active DESC, installed_at ASC"
    ).all<any>();
    for (const c of (candidates.results as any[]) ?? []) {
      const probe = `extensions/themes/${c.name}/${c.version}/files/templates/index.html`;
      const obj = await env.MEDIA.get(probe);
      // Bundled themes have no R2 package at all — their index.html ships in
      // the worker assets. Probing both keeps "can really render" true on a
      // fresh install where nothing was ever uploaded to R2.
      if (obj || (await bundledThemeFile(env, String(c.name), "templates/index.html")) !== null) {
        name = String(c.name); break;
      }
    }
    if (!name) name = "default";
  }
  const row = await env.DB.prepare(
    "SELECT name, version, manifest FROM theme_installs WHERE name=? LIMIT 1"
  )
    .bind(name)
    .first<any>();
  if (!row) {
    return { name, version: "1.0.0", manifest: { name, title: name, version: "1.0.0" } };
  }
  let manifest: ThemeManifest;
  try {
    manifest = JSON.parse(String(row.manifest ?? "{}"));
  } catch {
    manifest = { name: row.name, title: row.name, version: row.version };
  }
  // A manifest with no explicit name would break key construction downstream.
  if (!manifest.name) manifest.name = String(row.name);
  if (!manifest.version) manifest.version = String(row.version);
  return { name: String(row.name), version: String(row.version), manifest };
}

// ---------------------------------------------------------------------------
// Template loading (R2 for uploaded themes, worker assets for bundled themes)
// ---------------------------------------------------------------------------

/** R2 key prefix holding a theme version's unpacked files. */
export function themeFilePrefix(theme: ActiveTheme): string {
  return `extensions/themes/${theme.name}/${theme.version}/files`;
}

// The bundled-theme assets reader (`bundledThemeFile`) lives in
// `shared/bundled.ts` — plugin seeding needs it too, and plugin code may not
// import theme code. Every R2 miss below falls back to it.

/**
 * Load a template by logical name, e.g. `single-product`. `name` may contain
 * subdirectories such as `parts/card`. Returns null when absent.
 */
export async function loadThemeTemplate(
  env: Env,
  theme: ActiveTheme,
  name: string,
  cache?: Map<string, string | null>
): Promise<string | null> {
  if (cache?.has(name)) return cache.get(name)!;
  const key = `${themeFilePrefix(theme)}/templates/${name}.html`;
  const obj = await env.MEDIA.get(key);
  // R2 only ever holds uploaded themes; a bundled theme's files ship inside
  // the worker assets, so a miss here is normal for them, not an error.
  const text = obj ? await obj.text() : await bundledThemeFile(env, theme.name, `templates/${name}.html`);
  cache?.set(name, text);
  return text;
}

// ---------------------------------------------------------------------------
// Query resolution for {{@query ...}}
// ---------------------------------------------------------------------------

interface QueryRow {
  id: string;
  slug: string;
  type: string;
  status: string;
  created_at: number;
  updated_at: number;
  locale: string;
  title: string | null;
  excerpt: string | null;
  content: string | null;
}

const QUERY_ORDER_WHITELIST = new Set([
  "created_at",
  "updated_at",
  "title",
  "slug",
  "published_at",
]);

/**
 * Execute a declarative `@query`. Params are validated against a whitelist so
 * a template can never reach arbitrary SQL.
 */
export async function runThemeQuery(
  env: Env,
  params: Record<string, string | number>,
  scope: Record<string, unknown>,
  siteId: string
): Promise<QueryRow[]> {
  const type = params.type ? String(params.type) : "post";
  // `siteId` is a required parameter, so the site default is reachable — the
  // locale ladder itself lives in `resolveContentLocale` (one definition).
  // Note there is deliberately no `?? "en"` here: a hardcoded terminal locale
  // is exactly the "silently read the wrong language" bug this rule guards.
  const locale = params.locale
    ? String(params.locale)
    : scope.locale
      ? String(scope.locale)
      : await resolveContentLocale(env, siteId);
  const status = params.status ? String(params.status) : "published";
  const limit = Math.min(100, Math.max(1, Number(params.limit ?? 10)));
  const offset = Math.max(0, Number(params.offset ?? 0));

  // `order` looks like "created_at desc".
  const rawOrder = String(params.order ?? "created_at desc").trim().split(/\s+/);
  const orderCol = QUERY_ORDER_WHITELIST.has(rawOrder[0]) ? rawOrder[0] : "created_at";
  const orderDir = String(rawOrder[1] ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const conditions: string[] = ["p.site_id = ?", "p.type = ?", "p.status = ?", "t.locale = ?"];
  const binds: unknown[] = [siteId, type, status, locale];

  if (params.slug) {
    // Rule 58: per-language URL segment — match the COALESCE, never `p.slug`.
    conditions.push("COALESCE(t.slug, p.slug) = ?");
    binds.push(String(params.slug));
  }
  if (params.ids && typeof params.ids === "string") {
    const ids = params.ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (ids.length) {
      conditions.push(`p.id IN (${ids.map(() => "?").join(",")})`);
      binds.push(...ids);
    }
  }
  // Exclude the object currently being viewed (useful for "related" blocks).
  if (params.exclude_current === "true" && scope.post && (scope.post as any).id) {
    conditions.push("p.id != ?");
    binds.push(String((scope.post as any).id));
  }

  const sql = `SELECT p.id, p.slug AS slug_default, COALESCE(t.slug, p.slug) AS slug, p.type, p.status, p.created_at, p.updated_at,
                      t.locale, t.title, t.excerpt, t.content
               FROM posts p JOIN post_translations t ON t.post_id = p.id
               WHERE ${conditions.join(" AND ")}
               ORDER BY p.${orderCol} ${orderDir}
               LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const items = (rows.results as any[]) ?? [];
  await attachMeta(env, items, locale, await defaultLocale(env, siteId));
  deriveListingFields(items, locale);
  return items as QueryRow[];
}

/**
 * The three fields every listing card shows, derived from the row it already
 * has.
 *
 * One definition, two readers (`runThemeQuery` for anything a route lists,
 * `memberPosts` for the account screen): a route-based archive should not be
 * the one page where a cover is missing, and "my posts" should not be the one
 * where the reading time is. `attachMeta` has just rendered `html`, so the
 * reading time is a string scan on that, not a second render pass.
 *
 * Deliberately does **not** set `url`: that is the one field the two callers
 * disagree about. A listing is linked through its route's base; a member's own
 * posts are linked through the built-in permalink, because the account page is
 * not where they live.
 */
function deriveListingFields(items: any[], locale: string): void {
  for (const it of items) {
    it.date_display = formatDate(it.created_at, locale);
    it.cover = coverFrom(it.content);
    it.reading_time = readingTime(String(it.html ?? ""), 220, locale);
  }
}

/**
 * A member's own posts, for the account screen.
 *
 * Three things make this *not* just `runThemeQuery` with an extra filter, and
 * each is a way the naive version silently answers the wrong question:
 *
 * 1. **Every status, not just `published`.** A member opens their account to
 *    see what they have written, and most of it is not live yet. The template
 *    prints a status badge (`{{post.status}}`) — a query that filtered to
 *    `published` would make that badge a constant, i.e. decoration. So this
 *    reads drafts and pending rows too. (The *public* listing is the one that
 *    filters to `published`; that is `runThemeQuery`.)
 *
 * 2. **`site_id` AND `author_member_id`, never the id alone.** A member id is
 *    unique per site, so `author_member_id=?` *happens* to be unambiguous
 *    today — which is exactly the coincidence rule 6 forbids relying on. If a
 *    future migration ever makes member ids global, the site-blind query would
 *    start returning another site's posts, and nothing would notice. Match on
 *    both, the way migration 0024 documents.
 *
 * 3. **One row per post, in this language only.** The join is the translation
 *    row for the locale being rendered, so a member who wrote a post in both
 *    languages sees it once — in the language they are reading the account
 *    page in — not twice.
 *
 * The `url` is built from the **built-in post permalink** (`/{locale}/blog/…`),
 * deliberately *not* from the route this page is served under. The account page
 * lives at `/account`, so reusing the route base would link every post to
 * `/account/<slug>` and 404 on click — the caller passes the rule in rather
 * than the callee reaching for `scope`.
 */
async function memberPosts(env: Env, siteId: string, memberId: string, locale: string): Promise<QueryRow[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.slug AS slug_default, COALESCE(t.slug, p.slug) AS slug, p.type, p.status,
            p.created_at, p.updated_at, t.locale, t.title, t.excerpt, t.content
       FROM posts p JOIN post_translations t ON t.post_id = p.id
      WHERE p.site_id = ? AND p.author_member_id = ? AND t.locale = ?
      ORDER BY p.created_at DESC`
  )
    .bind(siteId, memberId, locale)
    .all();
  const items = (rows.results as any[]) ?? [];
  await attachMeta(env, items, locale, await defaultLocale(env, siteId));
  deriveListingFields(items, locale);
  for (const it of items) {
    // The built-in permalink, not the current route's base. A member's post
    // always lives at `/{locale}/blog/{slug}` regardless of which page lists it.
    it.url = `/${locale}/blog/${it.slug}`;
  }
  return items as QueryRow[];
}

/** Attach theme-declared custom fields to query results as `meta`. */
async function attachMeta(env: Env, rows: any[], locale: string, fallback: string): Promise<void> {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  let metaRows: any[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT post_id, meta_key, locale, meta_value FROM post_meta WHERE post_id IN (${placeholders})`
    )
      .bind(...ids)
      .all();
    metaRows = (res.results as any[]) ?? [];
  } catch {
    metaRows = []; // table may not exist on a pre-0008 database
  }
  // The ladder lives in `platform/post-meta.ts` — a listing and the single page
  // of the same post must resolve a field's language the same way.
  const byPost = resolveMetaByPost(metaRows as any[], locale, fallback);
  for (const row of rows) {
    row.meta = byPost.get(row.id) ?? {};
    // Expose a rendered HTML form for convenience in templates.
    row.html = row.content ? renderBlocks(String(row.content)) : "";
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface ThemeRenderOptions {
  /**
   * The site being rendered. Required, not optional: the renderer resolves the
   * active theme, settings and cache namespace from it, so a missing value
   * cannot be papered over with a default without rendering another site's
   * content. `locale` is the *content* locale (L1); `siteId` is orthogonal.
   */
  siteId: string;
  locale: string;
  path: string;
  /** Request origin (`https://example.com`), exposed as `site.url`. Empty when
   *  a caller renders without a request — templates guard on it rather than
   *  emitting a half-built absolute URL. */
  origin?: string;
  kind: TemplateContext["kind"];
  postType?: string;
  slug?: string;
  taxonomy?: string;
  term?: string;
  /**
   * An explicitly named template, which outranks the hierarchy.
   *
   * Set by a theme route (`routes[].template`). Without it a route that
   * resolves a theme-owned table has nothing to derive a name from — no post
   * type — and would render the generic `archive`/`single` instead of the
   * template the theme actually asked for.
   */
  template?: string;
  title: string;
  description?: string;
  /** The current object, exposed to templates as `post`. */
  post?: Record<string, unknown>;
  /** Pre-built scope additions (e.g. `posts` on an archive). */
  extra?: Record<string, unknown>;
  /**
   * The request being rendered.
   *
   * Optional because most call sites (tests, a render without an HTTP request)
   * have none, and because the front-end member scope is the only thing that
   * needs it. When present, `buildScope` reads the **member** cookie through
   * `currentMember` and exposes the result as `member` — never the admin
   * cookie, and never through `currentUser`. A theme cannot tell the two
   * sessions apart because it is only ever handed one of them (rule 77).
   */
  request?: Request;
  /**
   * The plugin hook dispatcher.
   *
   * Optional only so that tests and narrow call sites can render without
   * setting up the plugin runtime. When absent we read the process-wide slot
   * (`hostHooks()`), which `index.ts` fills at boot and which falls back to
   * `NULL_HOOKS` — behaving exactly like "this site has no plugins". The theme
   * layer never imports `plugin/`; see `contract/hooks.ts` for why.
   */
  hooks?: HostHooks;
}

/**
 * Resolve the hook dispatcher for a render.
 *
 * Centralised so no call site has to remember the fallback, and so the
 * "no plugins installed" case is indistinguishable from "not yet injected".
 */
function hooksOf(o: ThemeRenderOptions): HostHooks {
  return o.hooks ?? hostHooks() ?? NULL_HOOKS;
}

/**
 * The active theme's own language pack, nested so a template can read
 * `theme.strings.<group>.<key>`.
 *
 * Theme packs (`langs/{locale}.json`, keys prefixed `theme.{name}.`) used to
 * feed only the *admin* dictionary. That left a theme's front-end chrome
 * hardcoded in its markup — the one place a string could not be translated
 * without editing the template. Exposing the pack here lets a template write
 * `{{default(theme.strings.nav.home, "Home")}}`: the pack supplies the
 * translation when the locale has one, and the literal is the fallback for a
 * locale the theme does not ship. A missing or malformed pack yields `{}` — an
 * untranslated page is a far better outcome than a blank one.
 */
function nestThemeStrings(messages: Record<string, string>, themeName: string): Record<string, unknown> {
  const prefix = `theme.${themeName}.`;
  const out: Record<string, any> = Object.create(null);
  for (const [key, value] of Object.entries(messages)) {
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= Object.create(null));
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

async function loadThemeStrings(env: Env, theme: ActiveTheme, locale: string): Promise<Record<string, unknown>> {
  try {
    const obj = await env.MEDIA.get(themePackKey(theme as any, locale));
    // Same two-source rule as templates: uploaded themes live in R2, bundled
    // themes ship their `langs/` inside the worker assets.
    const raw = obj ? await obj.text() : await bundledThemeFile(env, theme.name, `langs/${locale}.json`);
    if (!raw) return Object.create(null);
    const pack = parsePack(raw);
    return pack ? nestThemeStrings(pack, theme.name) : Object.create(null);
  } catch {
    return Object.create(null);
  }
}

/** Build the base scope every template can rely on. */
export async function buildScope(
  env: Env,
  theme: ActiveTheme,
  o: ThemeRenderOptions
): Promise<Record<string, unknown>> {
  const siteId = o.siteId;
  const [s, ls, strings, siteDefault, widgets] = await Promise.all([
    siteInfo(env, siteId),
    locales(env, siteId),
    loadThemeStrings(env, theme, o.locale),
    defaultLocale(env, siteId),
    widgetGroups(env, siteId, o.locale),
  ]);
  // Menus per declared location (rule 73 — one deterministic winner per
  // location). The locations come from the active theme's manifest, read at
  // render time; a theme that declares none gets the historical `header`
  // behaviour. Each location yields `menu.<id>` (item array) and
  // `menu.<id>_html` (pre-rendered anchors); `menu.primary*` stays as an
  // alias of the header location so pre-73 templates keep working.
  const menuLocs: { id: string }[] = theme.manifest.menuLocations?.length ? theme.manifest.menuLocations : [{ id: "header" }];
  const menuRows = await Promise.all(menuLocs.map((l) => menusForLocation(env, siteId, l.id, o.locale)));
  const menuCtx: Record<string, unknown> = {};
  menuLocs.forEach((l, i) => {
    const items = ((menuRows[i] as any[]) ?? []).map((it) => ({
      title: it.title,
      url: it.url,
      target: it.target ?? null,
    }));
    menuCtx[l.id] = items;
    menuCtx[`${l.id}_html`] = items.map((it) => `<a href="${esc(it.url)}">${esc(it.title)}</a>`).join(" ");
  });
  menuCtx.primary = menuCtx.header;
  menuCtx.primary_html = menuCtx.header_html;
  // The language switcher. Locale parsing goes through `resolveLocale` (rule
  // 56 — one definition), and the entries are built only from the locales this
  // site declares (rule 59 — no site-blind fallback).
  //
  // ⚠️ Read `post.alternates` *here*, while its URLs are still relative: the
  // hreflang block below replaces the property with origin-prefixed copies, so
  // reading it after that would put absolute URLs into the theme's nav.
  const langNavRows = langNav(ls as any[], o.locale, resolveLocale(o.path, {
    codes: ((ls as any[]) ?? []).map((l) => String(l?.code ?? "")).filter(Boolean),
    defaultLocale: siteDefault,
  }).rest, (o.post as any)?.alternates);
  // The entry the reader is already on, exposed on its own so a **dropdown** can
  // label its trigger with the current language instead of the raw code.
  //
  // A theme cannot look an item up: the template language has `{{#each}}` and
  // nine helpers, and "find the one whose `current` is true" is not among them.
  // Looping the list to print the active name is not possible either — the
  // active entry is in the middle of the list, so a `{{#if l.current}}` inside
  // the trigger would print every *other* language's name too. So the pick is
  // made here, from the **same array** `lang_nav` comes from: one source, two
  // views of it, and they cannot disagree about which language is current.
  const langCurrent = langNavRows.find((l) => l.current) ?? null;
  // One entry is not a switcher — a monolingual site gets no `lang_nav` at all
  // rather than a control that points at the page it is already on.
  // Plugins may contribute extra scope keys via the `beforeRender` action by
  // mutating the payload object handed to them.
  const extra: Record<string, unknown> = { ...(o.extra ?? {}) };
  const hooks = hooksOf(o);
  // The front-end member, if this request carries a valid member session.
  //
  // Read through `currentMember`, which is bound to the **member** cookie and
  // the **member_sessions** table — a completely different door from the one
  // `currentUser` opens. A theme therefore cannot see an admin session here
  // even when an admin is logged in, and the reverse holds too (rule 77).
  // Absent when the caller had no request to read a cookie from, or nobody is
  // signed in; templates guard on it.
  //
  // The row is projected through `memberScope` so templates can address it in
  // snake_case (`{{member.display_name}}`) like every other scope entry. Handing
  // `publicMember`'s camelCase object straight through left that key undefined
  // and printed a blank name, silently — see the comment on `memberScope`.
  const memberRow = o.request ? await currentMember(env, o.request, siteId) : null;
  const member = memberRow ? memberScope(memberRow) : null;
  // The signed-in member's own posts, for `{{#each my_posts as post}}`.
  //
  // Only fetched when there *is* a member: the account template guards the
  // whole block with `{{#if member}}`, and a signed-out visitor has no posts by
  // definition. Skipping the query keeps an anonymous hit on `/account` as
  // cheap as it was, and — more importantly — means `my_posts` is **absent**
  // rather than an empty array, so a template that forgot the `{{#if member}}`
  // guard falls through its `{{else}}` branch instead of rendering a "0
  // articles" header over an empty list.
  const myPosts = memberRow ? await memberPosts(env, siteId, memberRow.id, o.locale) : null;
  await hooks.boot(env);
  try {
    await hooks.doAction("beforeRender", { env, siteId }, { siteId, locale: o.locale, path: o.path, kind: o.kind, scope: extra });
  } catch {
    /* a failing plugin must not break rendering */
  }
  // hreflang entries become absolute here, where the request origin is known —
  // findContent runs without one. `default` marks the site's default language
  // so a template can emit `hreflang="x-default"` without a lookup.
  const post = o.post as any;
  if (o.origin && post && Array.isArray(post.alternates)) {
    post.alternates = post.alternates.map((a: any) => ({
      ...a,
      url: `${o.origin}${a.url}`,
      default: a.locale === siteDefault,
    }));
  }
  return {
    site: { title: s.title, description: s.description, robots: s.robots, locale: o.locale, url: o.origin ?? "" },
    page: {
      title: o.title,
      description: o.description ?? s.description,
      path: o.path,
      kind: o.kind,
      // Ready-to-render <title> text. A theme cannot compare two strings in
      // the template language, so the "do not repeat the site name" rule is
      // applied here: on the front page `title` already *is* the site title,
      // and naively appending the suffix yields "My Shop | My Shop".
      document_title:
        o.title && s.title && o.title !== s.title ? `${o.title} | ${s.title}` : o.title || s.title,
    },
    locale: o.locale,
    locales: (ls as any[]).map((l) => ({ code: l.code, name: l.name, is_default: l.is_default })),
    menu: menuCtx,
    // Rendered widget groups keyed by declared sidebar id; a sidebar with no
    // enabled widgets is absent so templates can `{{#if …}}` on it.
    widgets,
    post: o.post ?? null,
    // The signed-in front-end member, or null. Deliberately its own key rather
    // than folded into `extra`: it comes from a platform lookup a plugin cannot
    // forge, and a theme reads `{{#if member}}` to decide between "sign in" and
    // the account menu.
    member,
    // The same member's own posts, or **absent** when there is no member (see
    // the note where it is computed). Not part of `extra` because it is derived
    // from an identity the platform resolved, not from anything a caller may
    // pass in — a plugin must not be able to point "my posts" at someone else.
    ...(myPosts ? { my_posts: myPosts } : {}),
    lang_nav: langNavRows.length > 1 ? langNavRows : [],
    // The current entry alone, for a dropdown's trigger label. Same condition as
    // `lang_nav` — a monolingual site has no switcher, so it gets no current
    // entry either rather than a control that lists one language.
    lang_current: langNavRows.length > 1 ? langCurrent : null,
    theme: { name: theme.name, version: theme.version, title: theme.manifest.title, strings },
    ...extra,
  };
}

export interface ThemeRenderResult {
  html: string;
  template: string;
  tried: string[];
  error?: string;
}

/**
 * Render a themed page. On any template error we surface the message in dev
 * and fall back to a minimal shell so the site stays up.
 */
export async function renderThemePage(
  env: Env,
  o: ThemeRenderOptions
): Promise<ThemeRenderResult> {
  const theme = await activeTheme(env, o.siteId);
  const cache = new Map<string, string | null>();
  const load = (name: string) => loadThemeTemplate(env, theme, name, cache);

  const ctx: TemplateContext = {
    kind: o.kind,
    postType: o.postType,
    slug: o.slug,
    taxonomy: o.taxonomy,
    term: o.term,
    template: o.template,
  };

  const resolved = await resolveTemplate(ctx, load, () => minimalShell(o));
  if (!resolved) {
    return { html: minimalShell(o), template: "__none__", tried: templateCandidates(ctx) };
  }

  const scope = await buildScope(env, theme, o);
  const opts: RenderOptions = {
    loadTemplate: load,
    // `o.siteId` is required by `ThemeRenderOptions`, so it is passed straight
    // through. There used to be an `?? "default"` here: dead under the current
    // types, but a landmine the moment anyone makes the field optional — it
    // would silently render another site's data instead of failing to compile.
    runQuery: (params, sc) => runThemeQuery(env, params, sc, o.siteId),
  };

  try {
    let html = await renderTemplateSource(resolved.source, scope, opts);
    html = await decorateOutput(env, o, resolved.name, html);
    return { html, template: resolved.name, tried: resolved.tried };
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : "Template rendering failed";
    // Never leak template internals to end users in production.
    const html = minimalShell(o, message);
    return { html, template: resolved.name, tried: resolved.tried, error: message };
  }
}

/**
 * Post-render pipeline shared by every themed page:
 *   1. expand `[shortcode]` markup,
 *   2. fire the `html` filter so enabled plugins can rewrite the document.
 *
 * A plugin throwing must never take the page down, so each stage is isolated
 * and the document falls back to whatever the previous stage produced.
 */
async function decorateOutput(env: Env, o: ThemeRenderOptions, template: string, html: string): Promise<string> {
  const hooks = hooksOf(o);
  await hooks.boot(env);
  const siteId = o.siteId;
  const ctx = { env, siteId };

  let out = html;
  try {
    out = await hooks.renderShortcodes(env, out, siteId);
  } catch {
    /* a broken shortcode leaves the raw markup in place */
  }
  try {
    const filtered = await hooks.applyFilters("html", ctx, out);
    if (typeof filtered === "string") out = filtered;
  } catch {
    /* a broken filter leaves the previous stage's output */
  }
  return out;
}

/** Absolute last-resort shell used when a theme is missing or broken. */
export function minimalShell(o: ThemeRenderOptions, error?: string): string {
  const note = error ? `<p class="cfpress-error">Template error: ${esc(error)}</p>` : "";
  return `<!doctype html><html lang="${esc(o.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head><body>${note}<h1>${esc(o.title)}</h1></body></html>`;
}

export { TemplateError };
