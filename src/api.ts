import { Env, SessionUser } from "./shared/types";
import { bootstrapAdmin, changePassword, changeUsername, currentUser, getMenuPrefs, login, logout, requireAdmin, rescopeSessionCookie, setMenuPrefs, setUserUiLang } from "./platform/auth";
import { activity, jsonBody, now, ok } from "./shared/repo";
import { randomId } from "./shared/crypto";
import { CORE_BLOCKS } from "./rendering/blocks";
import { installedPlugins, installedThemes, seedBundledExtensions, capabilityList, bootPluginRuntime, applyFilters, doAction, resetPluginRuntime, pluginRuntimeStatus } from "./extensions/plugin/runtime";
import { unzipSync } from "fflate";
import { validateManifest } from "./extensions/contract/validation";
import { CAPABILITIES } from "./extensions/contract/capabilities";
import { PURGE_ON_SITE_DELETE } from "./extensions/contract/schema";
import { SETTING_DEFS, getSetting, setSetting, platformSetting, setPlatformSetting, isDeclaredSetting, settingDef, adminPath, resetAdminPathMemo } from "./platform/settings";
import { safeZipPath, sha256 } from "./extensions/security";
import { createRevision, autosave } from "./platform/revisions";
import { requirePermission, can, accessibleSiteIds, SITE_ROLES, SUPERADMIN_ROLE } from "./platform/permissions";
import { bumpContentCache } from "./shared/cache";
import { BUNDLED_THEMES } from "./shared/bundled";
import { featureSnapshot, inheritedValue, truthy, FEATURE_SETTINGS_KEY, FEATURE_SWITCHES, type FeatureSwitch } from "./shared/features";
import { DEMO_CONTENTS, DEMO_LOCALES, DEMO_MENUS, DEMO_SEED_STAMP, CTBLOG_MENUS } from "./shared/demo-content";
import { clearOwnerMenusAllSites, listAdminMenuGroups } from "./platform/admin-menus";
import { clearPluginMenus } from "./extensions/plugin/menus";
import { createSite, updateSite, deleteSite, listSites, DEFAULT_SITE_ID } from "./platform/sites";
// The front-end identity is a separate module with a separate table and a
// separate cookie on purpose (§2.1) — importing it here does not merge the two
// logins, it is what lets the front API read the member session without ever
// touching `admin_sessions`.
import { registerMember, loginMember, logoutMember, requireMember } from "./platform/members";
// The custom-field read ladder is defined once; the admin read has to agree
// with what the front end renders for the same post in the same language.
import { resolveMetaByPost } from "./platform/post-meta";
import { defaultLocale } from "./platform/frontend";
import { resolvePostUrl, DEFAULT_PERMALINK_STRUCTURE } from "./platform/permalink";
// Media access policy — the same module the front-end `/media/<key>` read path
// uses, so the library a user can list is the library they can fetch.
import { readMediaPolicy, mediaOwnerClause } from "./platform/media-policy";
// Third-party image hosts: the upload half of the storage choice. This module
// only speaks vendor APIs (bytes in, URLs out); the tenant check, the row and
// the policy stay here, so no caller can upload without recording.
import { mediaProviderOf, isMediaStorageProvider, remoteObjectKey, readMediaStorage, readMediaKeys, uploadToImgbb, uploadToPostimages, deleteRemoteImage, type MediaStorageProvider } from "./platform/media-hosts";
import { invalidateThemeWorker } from "./extensions/theme/runtime-worker";
import {applyThemeCapabilities, clearThemeCapabilities, listPostTypes, listTaxonomies, listRoutes, listThemeAdminMenus, listThemeBlocks, listFieldDefs, themeSettings, parseSettingOptions} from "./extensions/theme/capabilities";
import { listThemeFiles, readThemeFile, writeThemeFile, deleteThemeFile, copyTheme, exportThemeZip } from "./extensions/theme/assets";
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from "./platform/api-keys";
import { generateOpenApiSchema } from "./platform/openapi";
import {
  availableUiLocaleEntries,
  availableUiLocales,
  corePackLocaleEntries,
  corePackLocales,
  disableSiteLocale,
  enableSiteLocale,
  isLocaleCode,
  loadUiPacks,
  mergePacks,
  platformLocales,
  resolveContentLocale,
  resolveUiLocale,
  setSiteDefaultLocale,
  siteDefaultLocale,
  siteLocaleCodes,
  siteLocaleRows,
  siteLocales,
  TERMINAL_LOCALE,
  upsertPlatformLocale,
} from "./platform/i18n";
import { activeTheme } from "./extensions/theme/runtime-declarative";
import {
  listOwnerTableDefs,
  refreshThemeTableI18n,
} from "./extensions/theme/tables";
import { tableBySlug, tableDelete, tableList, tableSave, tableAggregate, deriveSlug, resolveTableForSite } from "./extensions/theme/table-facade";

/**
 * Write the demo content (`shared/demo-content.ts` — the one definition) into
 * one site. Three callers, one implementation: the boot hook for a brand-new
 * install (`maybeSeedDemoContent`), the admin Settings screen's "Restore demo
 * content" button (`POST seed-demo`), and the terminal script, which now only
 * logs in and calls this endpoint.
 *
 * Both languages of a piece are written against **one row** via `savePost` —
 * the exact path an editor save takes — so caching, revisions, slug rules and
 * per-locale meta all behave as they do for real content. Idempotent: the
 * per-site id (`demo_<siteId>_<key>`) makes the second run update the same
 * rows, never duplicate them. `filter` scopes a run to one piece and/or one
 * locale (the admin button walks piece by piece to keep each request small on
 * the free plan's CPU budget); the default writes everything.
 */
export async function seedDemoContent(
  env: Env,
  siteId: string,
  userId: string,
  filter?: { key?: string; locale?: string }
): Promise<Response> {
  const pieces = filter?.key
    ? DEMO_CONTENTS.filter((p) => p.key === filter.key)
    : DEMO_CONTENTS;
  if (filter?.key && pieces.length === 0) return ok({ error: `unknown demo piece: ${filter.key}` }, 400);
  const locales = DEMO_LOCALES.filter((l) => !filter?.locale || l === filter.locale);
  if (filter?.locale && !locales.includes(filter.locale as (typeof DEMO_LOCALES)[number])) {
    return ok({ error: `unknown demo locale: ${filter.locale}` }, 400);
  }

  // A seed in N languages needs all N *served*: `siteLocales()` filters on
  // `enabled = 1`, so a disabled row means the theme is handed a shorter list
  // and renders no switcher for that language. The same calls the
  // `i18n/locales` endpoint makes; `is_default: false` leaves whatever the
  // site already chose as its default alone. Display names come from
  // `Intl.DisplayNames`, not a hand-written table.
  for (const code of locales) {
    if (!pieces.some((p) => p.versions[code])) continue;
    let name: string = code, native: string = code;
    try { name = new Intl.DisplayNames([TERMINAL_LOCALE], { type: "language" }).of(code) || code; } catch { /* unknown tag */ }
    try { native = new Intl.DisplayNames([code], { type: "language" }).of(code) || name; } catch { /* falls back to English */ }
    await upsertPlatformLocale(env, { code, name, native_name: native, direction: "ltr", enabled: 1 });
    await enableSiteLocale(env, siteId, code, { isDefault: false });
    // A second language is exactly the event that makes theme `_i18n` tables
    // exist (§2.5.3). Nothing else has to remember to do this.
    await refreshThemeTableI18n(env, siteId);
  }

  let written = 0;
  const failed: string[] = [];
  for (const piece of pieces) {
    for (const code of locales) {
      const v = piece.versions[code];
      if (!v) continue;
      // Per-site id: `posts.id` is a global primary key, so a fixed literal
      // would make seeding a second site collide with the first — and
      // `savePost` answers 404 for a cross-site id (the MS-1.1 oracle).
      const id = `demo_${siteId}_${piece.key}`;
      const res = await savePost(env, userId, id, {
        locale: code,
        // The slug must be sent explicitly: omitting it makes savePost fall
        // back to the post id, which silently breaks every permalink.
        slug: v.slug,
        title: v.title,
        excerpt: v.excerpt,
        content: v.content,
        status: "published",
        ...(v.meta ? { meta: v.meta } : {}),
      }, piece.kind, siteId);
      if (res.status < 400) written++;
      else failed.push(`${piece.key}/${code}:${res.status}`);
    }
  }
  for (const m of DEMO_MENUS) {
    const existing = await env.DB.prepare("SELECT id FROM menus WHERE site_id=? AND (id=? OR location=?) LIMIT 1").bind(siteId, m.id, m.location).first<any>();
    const menuId = existing?.id || m.id;
    if (!existing) {
      await env.DB.prepare(
        "INSERT INTO menus (id, site_id, name, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(menuId, siteId, m.name, m.location, now(), now()).run();
    }
    const itemCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM menu_items WHERE site_id=? AND menu_id=?").bind(siteId, menuId).first<any>();
    if (Number(itemCount?.c ?? 0) === 0) {
      let order = 0;
      for (const it of m.items) {
        const itemId = `demo_${siteId}_${menuId}_${order}`;
        await env.DB.prepare(
          "INSERT OR REPLACE INTO menu_items (id, site_id, menu_id, parent_id, title, url, target, sort_order, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(itemId, siteId, menuId, null, it.title, it.url, it.target ?? null, order++, it.locale ?? null, now(), now()).run();
      }
    }
  }
  if (written > 0) {
    await bumpContentCache(env, siteId);
    await activity(env, userId, "seed", "demo-content", "demo", { site: siteId, written, failed });
  }
  return ok({ ok: failed.length === 0, written, failed, site: siteId });
}

/**
 * Boot-chain hook: give a brand-new install something to look at.
 *
 * The predicate decides **once per install**, keyed by a settings stamp
 * (`demo.seeded`), because "the posts table is empty" is a fact that changes:
 * an operator who deletes their content must not find the demo resurrected on
 * the next isolate boot. Three states:
 *
 *   - stamped → do nothing (the normal case after the first boot; the admin
 *     button re-runs the writer explicitly and is never gated on this);
 *   - not stamped, site already has posts (a member draft, an import, a site
 *     upgraded from an older version) → never seed, and record the decision;
 *   - not stamped, no posts at all → seed, then stamp.
 *
 * The author is the install owner: `bootstrapAdmin` runs before this in the
 * boot chain, and demo content is staff content — authoring it as a blank id
 * would blur rule 84a's member/staff id spaces.
 *
 * `siteId` is a test seam (and a future multi-site escape hatch): the boot
 * chain calls it with none, which resolves the install's default site. The
 * contract suite passes a fixture site because the shared local D1's default
 * site belongs to the operator.
 */
export async function maybeSeedDemoContent(env: Env, siteId?: string): Promise<void> {
  const sites = await listSites(env);
  const site = siteId
    ? sites.find((s) => s.id === siteId)
    : (sites.find((s) => Number(s.is_default) === 1) ?? sites[0]);
  if (!site) return;
  // ⚠️ `getSetting` answers the *declared default* for an unwritten row, and
  // that default is the string `"0"` — truthy in JavaScript. A bare `if
  // (await getSetting(...))` would therefore read "never seeded" as "already
  // seeded" and the boot hook would never seed anything. Every boolean
  // setting read goes through `truthy()`; this one is no exception.
  if (truthy(await getSetting(env, site.id, DEMO_SEED_STAMP))) return;
  const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM posts WHERE site_id=?").bind(site.id).first<any>();
  if (Number(count?.c ?? 0) > 0) {
    await setSetting(env, site.id, DEMO_SEED_STAMP, "1");
    return;
  }
  const admin = await env.DB.prepare("SELECT id FROM site_users WHERE role='superadmin' ORDER BY created_at LIMIT 1").first<any>();
  if (!admin?.id) return;
  // No stamp until the seed answered without failures: a broken or partial
  // seed is retried on the next boot rather than silently never happening.
  // The boot chain's own try/catch keeps a throw from failing the request.
  const res = await seedDemoContent(env, site.id, String(admin.id));
  if (res.status < 400) await setSetting(env, site.id, DEMO_SEED_STAMP, "1");
}

/**
 * Which site does this admin request target? Explicit `?site=` wins; otherwise
 * the default site. The admin UI passes it so one install can manage many
 * sites from the same backend.
 */
function requestSiteId(url: URL): string {
  const s = String(url.searchParams.get("site") ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s) ? s : DEFAULT_SITE_ID;
}

/**
 * Was an explicit `?site=` supplied but malformed? `requestSiteId()` falls
 * back to the default site for anything it cannot parse — so without this
 * check `?site=PROBE_A` (uppercase) silently serves the default tenant's
 * rows with 200 (MS-2.4: "站点悄悄落到默认值"). Malformed is caller input,
 * so it answers 400, never another site's data.
 */
function siteParamMalformed(url: URL): boolean {
  if (!url.searchParams.has("site")) return false;
  const s = String(url.searchParams.get("site") ?? "").trim();
  return !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(s);
}

/**
 * May this user see this site at all? The switcher (`GET sites`) already
 * answers this with `accessibleSiteIds`; every other site-scoped read must
 * ask the same question — otherwise the switcher hides a site that `?site=`
 * still opens (MS-3.1: B 站的任何内容/设置端点对无成员者 403).
 *
 * This is deliberately weaker than `can()`: it asks "member of this site",
 * not "may do X here". Write paths keep their own `requirePermission` check
 * on top; reads need at least this.
 */
async function requireSiteAccess(env: Env, user: { id: string; role: string; apiKeyId?: string; sites?: string[] }, siteId: string): Promise<boolean> {
  // Machine-to-machine API keys: if bound to specific sites, that limit applies even to superadmin keys
  if (user.apiKeyId && Array.isArray(user.sites) && !user.sites.includes("*") && !user.sites.includes(siteId)) {
    return false;
  }
  if (user.role === SUPERADMIN_ROLE) return true;
  const allowed = await accessibleSiteIds(env, user as any);
  return allowed !== null && allowed.includes(siteId);
}

/**
 * How a post identifies its translation group.
 *
 * A row's group is its `lang_group` when that is set, and otherwise its own id —
 * that is how content created before it had any translations names itself.
 *
 * The SQL mirror of `groupOf()` is `GROUP_SQL`, and the two must stay in step.
 * Matching `p.lang_group = ?` on the SQL side instead *excludes* the very row
 * whose id named the group (its `lang_group` is NULL), so that row vanished from
 * its own translation group: the editor reported the language as missing and
 * offered to create a duplicate of a version that already existed.
 */
const GROUP_SQL = "COALESCE(NULLIF(TRIM(p.lang_group), ''), p.id)";
function groupOf(row: any): string {
  const g = String(row?.lang_group ?? "").trim();
  return g || String(row?.id ?? "");
}

/**
 * Every language version of one piece of content, keyed by `lang_group`.
 *
 * Returns one entry per *enabled site locale*, not per existing row, because
 * the editor's language bar has to show the versions that do **not** exist yet
 * (that is what the `＋` button is for).
 */
async function translationGroup(env: Env, siteId: string, postId: string) {
  const source = await env.DB.prepare(
    "SELECT id, type, lang_group, site_id FROM posts WHERE id=? AND site_id=? LIMIT 1"
  )
    .bind(postId, siteId)
    .first<any>();
  if (!source) return null;
  const group = groupOf(source);
  const rows = await env.DB.prepare(
    `SELECT p.id, p.slug, p.status, p.updated_at, t.locale, t.title
       FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id
      WHERE p.site_id = ? AND ${GROUP_SQL} = ?
      ORDER BY t.locale`
  )
    .bind(siteId, group)
    .all();
  const existing = ((rows.results as any[]) ?? []);
  const codes = await siteLocaleCodes(env, siteId);
  const byLocale = new Map<string, any>();
  for (const r of existing) {
    if (r.locale) byLocale.set(String(r.locale), r);
  }
  const versions = codes.map((code) => {
    const hit = byLocale.get(code);
    return {
      locale: code,
      exists: !!hit,
      post_id: hit?.id ?? null,
      slug: hit?.slug ?? null,
      title: hit?.title ?? null,
      status: hit?.status ?? null,
    };
  });
  // A translation in a locale the site no longer serves still exists in the
  // database. Surface it rather than hiding it — the content is real.
  for (const r of existing) {
    const code = String(r.locale ?? "");
    if (!code || codes.includes(code)) continue;
    versions.push({
      locale: code,
      exists: true,
      post_id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
    });
  }
  return { group, type: String(source.type), source_id: String(source.id), versions };
}

/** A slug that is free for this site+type, derived from `base`. */
async function freeSlug(env: Env, siteId: string, type: string, base: string): Promise<string> {
  const clean = String(base || "untitled").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "untitled";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? clean : `${clean}-${i + 1}`;
    const hit = await env.DB.prepare(
      "SELECT id FROM posts WHERE site_id=? AND type=? AND slug=? LIMIT 1"
    )
      .bind(siteId, type, candidate)
      .first<any>();
    if (!hit) return candidate;
  }
  return `${clean}-${await randomId()}`;
}

async function listPosts(env: Env, url: URL, kind: string, siteId: string) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
  const offset = (page - 1) * limit;
  const q = url.searchParams.get("q") ?? "";
  const locale = String(url.searchParams.get("locale") ?? "").trim();
  const category = String(url.searchParams.get("category") ?? "").trim();
  // A post has one row per locale, so joining translations without pinning a
  // locale would return the same post several times — the list pins one row
  // per post. Which row is the question: this used to be `MIN(locale)`, i.e.
  // *lexicographic* order, which answered "which translation sorts first" —
  // `en` on a bilingual site by coincidence of the alphabet, not because the
  // site considers English primary. The list is the operator's table of
  // contents; it must open on the language the site opens on, and `?locale=`
  // (the content list's language filter) overrides it.
  const dflt = await defaultLocale(env, siteId);
  const pinned = locale || dflt;

  // Resolve category and its hierarchical descendants
  let categoryTermIds: string[] = [];
  if (category) {
    const termRows = await env.DB.prepare(
      "SELECT id, slug, parent_id FROM terms WHERE site_id=? AND (taxonomy='category' OR taxonomy='categories')"
    ).bind(siteId).all<any>().catch(() => ({ results: [] }));
    const allTerms = (termRows.results as any[]) ?? [];
    const root = allTerms.find((t) => t.id === category || t.slug === category);
    if (root) {
      const queue = [root.id];
      categoryTermIds.push(root.id);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const t of allTerms) {
          if (t.parent_id === cur && !categoryTermIds.includes(t.id)) {
            categoryTermIds.push(t.id);
            queue.push(t.id);
          }
        }
      }
    } else {
      categoryTermIds.push(category);
    }
  }

  let rows: any;
  if (categoryTermIds.length > 0) {
    const catPh = categoryTermIds.map(() => "?").join(",");
    rows = await env.DB.prepare(`
      SELECT p.id, p.slug, p.status, p.type, p.template, p.author_id, p.created_at, p.updated_at,
             t.locale, t.title, t.excerpt, t.content, COALESCE(t.slug, p.slug) AS slug_own
      FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
      WHERE p.site_id = ? AND p.type = ? AND (? = '' OR t.title LIKE ? OR p.slug LIKE ?)
        AND EXISTS (SELECT 1 FROM term_relationships r JOIN terms tm ON tm.id = r.term_id WHERE r.post_id = p.id AND tm.site_id = ? AND r.term_id IN (${catPh}))
      ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
    `).bind(pinned, siteId, kind, q, `%${q}%`, `%${q}%`, siteId, ...categoryTermIds, limit, offset).all();
  } else {
    rows = await env.DB.prepare(`
      SELECT p.id, p.slug, p.status, p.type, p.template, p.author_id, p.created_at, p.updated_at,
             t.locale, t.title, t.excerpt, t.content, COALESCE(t.slug, p.slug) AS slug_own
      FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
      WHERE p.site_id = ? AND p.type = ? AND (? = '' OR t.title LIKE ? OR p.slug LIKE ?)
      ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
    `).bind(pinned, siteId, kind, q, `%${q}%`, `%${q}%`, limit, offset).all();
  }

  const items = ((rows.results as any[]) ?? []).map((i) => ({
    ...i,
    slug: i.slug_own || i.slug,
    locales: [i.locale].filter(Boolean) as string[],
    categories: [] as any[],
    tags: [] as any[],
    url: "",
  }));
  // Which languages and terms each item actually has — the list shows version badges
  // and category tags from this.
  const ids = items.map((i) => i.id);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const [vr, tr] = await Promise.all([
      env.DB.prepare(
        `SELECT post_id, locale FROM post_translations WHERE post_id IN (${ph}) ORDER BY locale`
      ).bind(...ids).all().catch(() => ({ results: [] as any[] })),
      env.DB.prepare(
        `SELECT r.post_id, t.id, t.taxonomy, t.slug, t.name
         FROM term_relationships r
         JOIN terms t ON t.id = r.term_id
         WHERE r.post_id IN (${ph}) AND t.site_id = ?`
      ).bind(...ids, siteId).all().catch(() => ({ results: [] as any[] })),
    ]);
    const have = new Map<string, string[]>();
    for (const r of (vr.results as any[]) ?? []) {
      const list = have.get(r.post_id) ?? [];
      list.push(String(r.locale));
      have.set(r.post_id, list);
    }
    const postCats = new Map<string, any[]>();
    const postTags = new Map<string, any[]>();
    for (const r of (tr.results as any[]) ?? []) {
      if (r.taxonomy === "category" || r.taxonomy === "categories") {
        const list = postCats.get(r.post_id) ?? [];
        list.push({ id: r.id, slug: r.slug, name: r.name });
        postCats.set(r.post_id, list);
      } else if (r.taxonomy === "tag" || r.taxonomy === "post_tag") {
        const list = postTags.get(r.post_id) ?? [];
        list.push({ id: r.id, slug: r.slug, name: r.name });
        postTags.set(r.post_id, list);
      }
    }
    for (const i of items) {
      i.locales = have.get(i.id) ?? i.locales;
      i.categories = postCats.get(i.id) ?? [];
      i.tags = postTags.get(i.id) ?? [];
    }
  }

  const permalinkPattern = (await getSetting(env, siteId, "permalink.structure")) || DEFAULT_PERMALINK_STRUCTURE;
  const sites = await listSites(env).catch(() => []);
  const curSite = sites.find((s) => s.id === siteId);
  const rawPrefix = curSite?.path_prefix ? String(curSite.path_prefix).trim().replace(/\/+$/, "") : "";
  const sitePrefix = rawPrefix ? (rawPrefix.startsWith("/") ? rawPrefix : `/${rawPrefix}`) : "";
  const activePt = (kind !== "post" && kind !== "page") ? await findActivePostType(env, kind, siteId) : null;

  for (const i of items) {
    if (kind === "page") {
      const pageSlug = String(i.slug || "").trim();
      let pagePath = pageSlug ? (pageSlug.startsWith("/") ? pageSlug : `/${pageSlug}`) : "/";
      if (i.locale && i.locale !== dflt) {
        pagePath = `/${i.locale}${pagePath.startsWith("/") ? pagePath : "/" + pagePath}`;
      }
      i.url = sitePrefix ? `${sitePrefix}${pagePath}` : pagePath;
    } else if (kind === "post") {
      const primaryCat = i.categories?.[0]?.slug || "uncategorized";
      const postPath = resolvePostUrl(permalinkPattern, {
        ...i,
        category: primaryCat,
      }, {
        locale: i.locale,
        isDefaultLocale: !i.locale || i.locale === dflt,
      });
      i.url = sitePrefix ? `${sitePrefix}${postPath.startsWith("/") ? postPath : "/" + postPath}` : postPath;
    } else {
      const ptBase = String(activePt?.rewrite_slug || activePt?.name || kind).replace(/^\/+/, "");
      let cptPath = `/${ptBase}/${i.slug || ""}`;
      if (i.locale && i.locale !== dflt) {
        cptPath = `/${i.locale}${cptPath}`;
      }
      i.url = sitePrefix ? `${sitePrefix}${cptPath}` : cptPath;
    }
  }

  return ok({ items, page, limit, site: siteId });
}

async function savePost(
  env: Env,
  userId: string,
  id: string | null,
  body: any,
  kind: "post" | "page" | string,
  siteId: string
) {
  await bootPluginRuntime(env);
  // Give plugins a chance to normalise the payload before anything is written.
  // A plugin may return a replacement body; a throw or a non-object result
  // leaves the original payload intact.
  try {
    const filtered = await applyFilters("beforeSavePost", { env, siteId }, body);
    if (filtered && typeof filtered === "object" && !Array.isArray(filtered)) body = filtered;
  } catch {
    /* plugin failure must not block a content save */
  }
  const entityId = id ?? `${kind}_${await randomId()}`;
  // The locale to write. Falling back to a literal `"en"` was wrong for the
  // same reason `siteId = "default"` was: on a site whose default language is
  // `zh-CN`, a client that omits `locale` would silently author an English
  // translation. The fallback belongs to the site, so it is looked up.
  const defaultLocale = await siteDefaultLocale(env, siteId);
  const locale = String(body.locale ?? "").trim() || defaultLocale;
  const isDefaultLocale = locale === defaultLocale;
  // The slug a client sends is the URL segment *for the locale being saved*.
  // `posts.slug` keeps its meaning as the default-language slug (repo i18n
  // invariant: the main table holds default-language values), so only a
  // default-locale save may change it. Per-locale values live in
  // `post_translations.slug`; NULL there means "follow the main table".
  // `undefined` (field absent) leaves the translation's slug untouched; an
  // empty string clears the override so the URL follows the main table.
  const slugGiven = body.slug !== undefined;
  const tSlug = String(body.slug ?? "").trim();
  const status = String(body.status ?? "draft");
  const publishAt = body.publish_at ? Number(body.publish_at) : null;
  const title = String(body.title ?? "");
  const excerpt = String(body.excerpt ?? "");
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? []);
  // A `PUT` names an id; a `POST` does not. Naming an id must not become a
  // silent no-op when no such row exists: SQLite's `UPDATE` affects zero rows
  // without raising, so the translation insert below would create a row
  // pointing at a post that does not exist — a 200 that leaves the site with
  // orphan translations and no post. So existence is checked first and a `PUT`
  // for an unknown id *creates* it, which is the idempotence a client supplying
  // a stable id (the seed script, an import, a sync) is relying on.
  const existingPost = id
    ? await env.DB.prepare("SELECT id, site_id FROM posts WHERE id=? LIMIT 1").bind(entityId).first<any>()
    : null;
  if (existingPost && existingPost.site_id !== siteId) {
    // The id exists but belongs to another site. Creating it here would collide
    // with the primary key; updating it would edit a neighbour's content.
    // Answered 404 (not 409): 409 confirms "this id exists on another site",
    // which is the existence oracle MS-1.1 forbids (cross-site known-id → 404).
    return ok({ error: "not found" }, 404);
  }
  // `let`, not `const`: a lost INSERT race (below) turns the create into an
  // update of the row the other writer won.
  let isCreate = !existingPost;
  // An explicitly sent slug must be free *in this language*: two translations
  // of different posts may not share a URL, while different posts never see
  // each other's per-locale rows. The main-table check on top covers the
  // default language, whose slug is also the post's identity.
  if (tSlug) {
    const clash = await env.DB.prepare(
      `SELECT p.id FROM posts p JOIN post_translations t ON t.post_id=p.id
        WHERE p.site_id=? AND p.type=? AND t.locale=? AND COALESCE(t.slug,p.slug)=? AND p.id<>? LIMIT 1`
    ).bind(siteId, kind, locale, tSlug, entityId).first<any>();
    if (clash) return ok({ error: "slug already used in this language" }, 409);
    if (isDefaultLocale) {
      const clashMain = await env.DB.prepare(
        "SELECT id FROM posts WHERE site_id=? AND type=? AND slug=? AND id<>? LIMIT 1"
      ).bind(siteId, kind, tSlug, entityId).first<any>();
      if (clashMain) return ok({ error: "slug already used in this language" }, 409);
    }
  }
  if (isCreate) {
    // `lang_group` ties the language versions of one piece of content together.
    // A new post starts as its own group of one; a translation added later
    // adopts the existing group (see the i18n/translations endpoint).
    const langGroup = String(body.lang_group ?? "").trim() || entityId;
    const initialTemplate = body.template !== undefined ? String(body.template ?? "").trim() : (kind === "page" ? "none" : null);
    try {
      await env.DB.prepare("INSERT INTO posts (id, site_id, author_id, type, slug, status, lang_group, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(entityId, siteId, userId, kind, tSlug || entityId, status, langGroup, initialTemplate || (kind === "page" ? "none" : null), now(), now()).run();
    } catch (e: any) {
      // Serial callers can never see this: the existence check above read no
      // row. Concurrent ones can — two demo seeds racing (the boot hook and a
      // restore button landing together) both pass the check and both INSERT.
      // Losing the race to the *same site's* row is just "the serial second
      // call": fall through to the update path below. Losing it to *another
      // site's* row stays a hard error — swallowing it would write across
      // tenants, the exact thing MS-1.1 forbids.
      if (!/UNIQUE constraint failed: posts\.id/.test(String(e?.message ?? e))) throw e;
      const racy = await env.DB.prepare("SELECT site_id FROM posts WHERE id=? LIMIT 1").bind(entityId).first<any>();
      if (!racy || racy.site_id !== siteId) throw e;
      isCreate = false;
    }
  }
  if (!isCreate) {
    const old = await env.DB.prepare("SELECT * FROM post_translations WHERE post_id=? AND locale=? LIMIT 1").bind(entityId,locale).first<any>();
    if(old) await createRevision(env,entityId,userId,locale,String(old.title||""),String(old.excerpt||""),String(old.content||""));
    // Who owns the main-table slug? Two storage shapes exist and both are
    // legitimate: a language version may be its own `posts` row (the
    // translations endpoint creates siblings that share a `lang_group`), or
    // one row may carry several translation rows. In the sibling shape the
    // saved locale's URL IS this row's `p.slug` and the save must be allowed
    // to rename it; in the shared shape renaming `p.slug` would move the
    // *other* languages' URLs (their COALESCE falls through to it). So the
    // main slug follows the save only when the locale is the site default or
    // no other locale's translation lives on this row.
    const others = await env.DB.prepare("SELECT COUNT(*) AS c FROM post_translations WHERE post_id=? AND locale<>?").bind(entityId, locale).first<any>();
    const ownsMainSlug = isDefaultLocale || Number(others?.c ?? 0) === 0;
    // ⚠️ The `tSlug || entityId` fallback is CREATE-only. On an update, a save
    // that omits the slug (a status-only publish, an editor saving just the
    // body) must not touch the URL at all — rewriting it to the entity id
    // silently renamed every existing permalink.
    const updTemplate = body.template !== undefined ? (String(body.template ?? "").trim() || (kind === "page" ? "none" : null)) : undefined;
    if (ownsMainSlug && tSlug) {
      if (updTemplate !== undefined) {
        await env.DB.prepare("UPDATE posts SET slug = ?, status = ?, template = ?, updated_at = ? WHERE id = ? AND site_id = ?")
          .bind(tSlug, status, updTemplate, now(), entityId, siteId).run();
      } else {
        await env.DB.prepare("UPDATE posts SET slug = ?, status = ?, updated_at = ? WHERE id = ? AND site_id = ?")
          .bind(tSlug, status, now(), entityId, siteId).run();
      }
    } else {
      if (updTemplate !== undefined) {
        await env.DB.prepare("UPDATE posts SET status = ?, template = ?, updated_at = ? WHERE id = ? AND site_id = ?")
          .bind(status, updTemplate, now(), entityId, siteId).run();
      } else {
        await env.DB.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ? AND site_id = ?")
          .bind(status, now(), entityId, siteId).run();
      }
    }
  }
  const existing = await env.DB.prepare("SELECT id, slug FROM post_translations WHERE post_id = ? AND locale = ? LIMIT 1").bind(entityId, locale).first<any>();
  if (existing) {
    // `slugGiven` absent → leave the override alone; empty → clear it (NULL
    // makes the URL follow the main table again).
    const nextSlug = slugGiven ? (tSlug || null) : (existing.slug ?? null);
    await env.DB.prepare("UPDATE post_translations SET title=?, excerpt=?, content=?, slug=?, updated_at=? WHERE id=?").bind(title, excerpt, content, nextSlug, now(), existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO post_translations (id, post_id, locale, title, excerpt, content, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await randomId(), entityId, locale, title, excerpt, content, tSlug || null, now(), now()).run();
  }
  if(publishAt && status === "scheduled") {
    await env.DB.prepare("INSERT INTO scheduled_posts(post_id,publish_at,processed_at) VALUES(?,?,NULL) ON CONFLICT(post_id) DO UPDATE SET publish_at=excluded.publish_at,processed_at=NULL").bind(entityId,publishAt).run();
  } else {
    await env.DB.prepare("DELETE FROM scheduled_posts WHERE post_id=?").bind(entityId).run();
  }
  // Custom fields: persist any theme-declared meta sent alongside the post.
  // The value is written against THIS save's locale (migration 0019): a
  // category name is prose, and the language that saved it owns what it says.
  // Reading is the ladder in `platform/post-meta.ts` — never here.
  await writePostMeta(env, siteId, entityId, locale, body.meta);
  if (Array.isArray(body.terms) || Array.isArray(body.tags) || Array.isArray(body.categories)) {
    // Preserve existing tags or categories if only one of them is updated in this save
    let existingTerms: any[] = [];
    if (!Array.isArray(body.terms) && (!Array.isArray(body.tags) || !Array.isArray(body.categories))) {
      const exRes = await env.DB.prepare(
        "SELECT t.id, t.taxonomy FROM terms t JOIN term_relationships r ON r.term_id=t.id WHERE r.post_id=? AND t.site_id=?"
      ).bind(entityId, siteId).all<any>().catch(() => ({ results: [] }));
      existingTerms = (exRes.results as any[]) ?? [];
    }

    const combinedTerms = [...(Array.isArray(body.terms) ? body.terms : [])];

    // Handle categories
    if (Array.isArray(body.categories)) {
      for (const cItem of body.categories) {
        const cStr = typeof cItem === "object" && cItem !== null ? String(cItem.id || cItem.name || "").trim() : String(cItem ?? "").trim();
        if (!cStr) continue;
        let termRow = await env.DB.prepare(
          "SELECT id FROM terms WHERE site_id=? AND (taxonomy='category' OR taxonomy='categories') AND (id=? OR slug=? OR name=?) LIMIT 1"
        ).bind(siteId, cStr, cStr.toLowerCase(), cStr).first<any>().catch(() => null);
        if (termRow?.id) {
          combinedTerms.push(termRow.id);
        } else {
          const newId = "term_" + await randomId();
          const catSlug = cStr.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || newId;
          const ts = now();
          await env.DB.prepare(
            "INSERT INTO terms(id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, created_at, updated_at) VALUES(?,?,?,?,?,NULL,NULL,0,?,?,?,?)"
          ).bind(newId, siteId, "category", catSlug, cStr, locale, newId, ts, ts).run().catch(() => {});
          combinedTerms.push(newId);
        }
      }
    } else if (!Array.isArray(body.terms)) {
      // Keep existing categories if body.categories wasn't explicitly provided
      for (const et of existingTerms) {
        if (et.taxonomy === "category" || et.taxonomy === "categories") combinedTerms.push(et.id);
      }
    }

    // Handle tags
    if (Array.isArray(body.tags)) {
      for (const tItem of body.tags) {
        const tStr = String(tItem ?? "").trim();
        if (!tStr) continue;
        let termRow = await env.DB.prepare(
          "SELECT id FROM terms WHERE site_id=? AND (taxonomy='tag' OR taxonomy='post_tag') AND (id=? OR slug=? OR name=?) AND (locale='' OR locale=?) LIMIT 1"
        ).bind(siteId, tStr, tStr.toLowerCase(), tStr, locale).first<any>().catch(() => null);
        if (!termRow?.id) {
          const newId = "term_" + await randomId();
          const tagSlug = tStr.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || newId;
          const ts = now();
          await env.DB.prepare(
            "INSERT INTO terms(id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, created_at, updated_at) VALUES(?,?,?,?,?,NULL,NULL,0,?,?,?,?)"
          ).bind(newId, siteId, "tag", tagSlug, tStr, locale, newId, ts, ts).run().catch(() => {});
          combinedTerms.push(newId);
        } else {
          combinedTerms.push(termRow.id);
        }
      }
    } else if (!Array.isArray(body.terms)) {
      // Keep existing tags if body.tags wasn't explicitly provided
      for (const et of existingTerms) {
        if (et.taxonomy === "tag" || et.taxonomy === "post_tag") combinedTerms.push(et.id);
      }
    }

    await env.DB.prepare("DELETE FROM term_relationships WHERE post_id=?").bind(entityId).run().catch(() => {});
    for (const termItem of combinedTerms) {
      const tid = String(termItem ?? "").trim();
      if (tid) {
        const termRow = await env.DB.prepare("SELECT id FROM terms WHERE site_id=? AND (id=? OR slug=?) LIMIT 1")
          .bind(siteId, tid, tid).first<any>().catch(() => null);
        const resolvedId = termRow?.id ? String(termRow.id) : tid;
        await env.DB.prepare("INSERT OR IGNORE INTO term_relationships(term_id, post_id) VALUES(?,?)")
          .bind(resolvedId, entityId).run().catch(() => {});
      }
    }
    // Re-aggregate count for active terms in this site
    await env.DB.prepare(`
      UPDATE terms SET count = (
        SELECT COUNT(DISTINCT r.post_id) FROM term_relationships r
        JOIN posts p ON p.id = r.post_id
        WHERE r.term_id = terms.id AND p.status = 'published' AND p.site_id = ?
      ) WHERE site_id = ?
    `).bind(siteId, siteId).run().catch(() => {});
  }
  await bumpContentCache(env, siteId);
  await activity(env, userId, isCreate ? "create" : "update", kind, entityId, { locale, title, status, siteId });
  // The URL segment this save left the locale with: the override just written,
  // else the translation's standing override, else the main-table identity.
  const effectiveSlug = tSlug || existing?.slug || entityId;
  // Notify plugins after the write has landed so they can index/notify.
  try {
    await doAction("afterSavePost", { env, siteId }, { id: entityId, type: kind, slug: effectiveSlug, locale, title, status, siteId, created: isCreate });
  } catch {
    /* never surface a plugin failure to the editor */
  }
  return ok({ id: entityId, site: siteId });
}

/** Is this meta key declared by the active theme for this site? */
async function fieldExists(env: Env, key: string, siteId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT id FROM field_defs WHERE site_id=? AND meta_key=? LIMIT 1"
    )
      .bind(siteId, key)
      .first<any>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Write a save's theme-declared custom fields, against **that save's locale**
 * (migration 0019): a category name is prose, and the language that saved it
 * owns what it says. This is the **only** writer of `post_meta`; reading is
 * the ladder in `platform/post-meta.ts`, never here (rule 70).
 */
async function writePostMeta(
  env: Env, siteId: string, entityId: string, locale: string, meta: unknown
): Promise<void> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    const key = String(k);
    if (!/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(key)) continue;
    if (!(await fieldExists(env, key, siteId))) continue;
    await env.DB.prepare(
      "INSERT INTO post_meta(post_id,meta_key,locale,meta_value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(post_id,meta_key,locale) DO UPDATE SET meta_value=excluded.meta_value,updated_at=excluded.updated_at"
    )
      .bind(entityId, key, locale, v === null || v === undefined ? null : String(v), now())
      .run()
      .catch(() => {});
  }
}

/** Look up a theme-declared post type that is currently active for a site. */
async function findActivePostType(env: Env, name: string, siteId: string) {
  try {
    return await env.DB.prepare(
      "SELECT * FROM post_types WHERE site_id=? AND name=? AND active=1 LIMIT 1"
    )
      .bind(siteId, name)
      .first<any>();
  } catch {
    return null;
  }
}

/** Custom-field rows of a post, unresolved — the ladder decides per language. */
async function postMetaRows(env: Env, postId: string): Promise<{ post_id: string; meta_key: string; locale: string | null; meta_value: string | null }[]> {
  try {
    const r = await env.DB.prepare("SELECT post_id, meta_key, locale, meta_value FROM post_meta WHERE post_id=?")
      .bind(postId)
      .all();
    return (r.results as any[]) ?? [];
  } catch {
    return []; // pre-0019 database: the `locale` column itself is missing
  }
}

async function uploadExtension(env:Env,userId:string,request:Request,type:"plugin"|"theme"){
  const form=await request.formData();
  const file=form.get("file");
  if(!(file instanceof File))return ok({error:"file required"},400);
  if(file.size>10*1024*1024)return ok({error:"extension package max size is 10MB"},413);
  let files:Record<string,Uint8Array>;
  try{files=unzipSync(new Uint8Array(await file.arrayBuffer())) as Record<string,Uint8Array>}catch{return ok({error:"invalid ZIP package"},400)}
  const entries=Object.entries(files);
  if(entries.length===0||entries.length>100)return ok({error:"invalid package file count"},400);
  let total=0;for(const [name,bytes] of entries){if(!safeZipPath(name))return ok({error:`unsafe path: ${name}`},400);total+=bytes.byteLength;if(total>20*1024*1024)return ok({error:"uncompressed package exceeds 20MB"},413)}
  const manifestEntry=entries.find(([n])=>n.split("/").at(-1)===(type==="plugin"?"plugin.json":"theme.json"));
  if(!manifestEntry)return ok({error:`${type}.json not found`},400);
  let manifest:any;try{manifest=JSON.parse(new TextDecoder().decode(manifestEntry[1]))}catch{return ok({error:"invalid manifest JSON"},400)}
  let meta:any;try{meta=validateManifest(manifest,type)}catch(e:any){return ok({error:e?.message||"invalid manifest"},400)}
  // A bundled theme's files ship inside the worker assets, and the assets copy
  // is the authority: `bundledThemeFile` is consulted on every R2 miss, so an
  // uploaded override would be silently shadowed while the registry claimed
  // the upload had won. Refuse rather than pretend — the fork should ship under
  // its own name.
  if(type==="theme"&&(BUNDLED_THEMES as readonly string[]).includes(String(meta.name)))return ok({error:`"${meta.name}" ships with the product; upload your variant under a different name`},400);
  // Extension packages live in R2, full stop: there is no third-party host
  // for them (unlike media library files). Without a binding there is nowhere
  // to put the bytes, so refuse with the remedy instead of recording an
  // install whose files do not exist.
  if(!env.MEDIA)return ok({error:"R2 is not configured on this install — extension upload needs it (media library uploads can use imgbb/postimages instead)"},400);
  const checksum=await sha256(await file.arrayBuffer());
  const packageKey=`extensions/${type}s/${meta.name}/${meta.version}/${checksum}.zip`;
  await env.MEDIA.put(packageKey,file.stream(),{httpMetadata:{contentType:"application/zip",cacheControl:"private, max-age=0"},customMetadata:{type,name:meta.name,version:meta.version}});
  if(type==="theme") {
    for(const [entry,bytes] of entries) {
      if(entry.endsWith("/") || entry.length>200) continue;
      const normalized=entry.replace(/^\.\//,"");
      const key=`extensions/themes/${meta.name}/${meta.version}/files/${normalized}`;
      const contentType=normalized.endsWith(".html")?"text/html;charset=UTF-8":normalized.endsWith(".css")?"text/css;charset=UTF-8":normalized.endsWith(".json")?"application/json":normalized.endsWith(".js")?"text/javascript;charset=UTF-8":"application/octet-stream";
      await env.MEDIA.put(key,bytes,{httpMetadata:{contentType,cacheControl:"public,max-age=300"}});
    }
  }
  const nowTs=now();
  await env.DB.prepare("INSERT OR IGNORE INTO extension_versions(id,extension_type,extension_name,version,package_key,checksum,manifest,installed_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(await randomId(),type,meta.name,meta.version,packageKey,checksum,JSON.stringify(manifest),nowTs).run();
  if(type==="plugin"){
    await env.DB.prepare(`INSERT INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`)
      .bind(`plugin_${meta.name}`,meta.name,meta.title,meta.version,0,JSON.stringify(manifest),nowTs,nowTs).run();
  }else{
    // Installing a theme must never change what any site is currently using.
    // `active` here only records that the package is installed and usable.
    await env.DB.prepare(`INSERT INTO theme_installs(id,name,title,version,active,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`)
      .bind(`theme_${meta.name}`,meta.name,meta.title,meta.version,0,JSON.stringify(manifest),nowTs,nowTs).run();
  }
  const perms=Array.isArray(manifest.permissions)?manifest.permissions:[];
  for(const cap of perms.filter((x:string)=>(CAPABILITIES as readonly string[]).includes(x))) await env.DB.prepare("INSERT OR REPLACE INTO extension_capabilities(extension_type,extension_name,capability,enabled) VALUES(?,?,?,1)").bind(type,meta.name,cap).run();
  if(type==="plugin" && Array.isArray(manifest.settings)) {
    for(const def of manifest.settings) {
      if(!def?.key) continue;
      await env.DB.prepare("INSERT OR REPLACE INTO plugin_setting_defs(plugin_name,key,label,type,default_value,options) VALUES(?,?,?,?,?,?)").bind(meta.name,String(def.key),String(def.label||def.key),String(def.type||"text"),String(def.default??""),Array.isArray(def.options)?JSON.stringify(def.options):null).run();
    }
  }
  await activity(env,userId,"install",type,meta.name,{version:meta.version,checksum});
  return ok({ok:true,type,name:meta.name,title:meta.title,version:meta.version,checksum,files:entries.length},201);
}

async function pluginSettings(env:Env,name:string){
  const defs=await env.DB.prepare("SELECT * FROM plugin_setting_defs WHERE plugin_name=? ORDER BY key").bind(name).all();
  const vals=await env.DB.prepare("SELECT key,value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1)").bind(name).all();
  const map=Object.fromEntries((vals.results as any[]).map(x=>[x.key,x.value]));
  return ok({items:(defs.results as any[]).map(x=>({...x,value:map[x.key]??x.default_value??"",options:parseSettingOptions(x.options)}))});
}
async function savePluginSetting(env:Env,userId:string,name:string,b:any){
  const row=await env.DB.prepare("SELECT id FROM plugin_installs WHERE name=? LIMIT 1").bind(name).first<any>();
  if(!row)return ok({error:"plugin not found"},404);
  const allowed=await env.DB.prepare("SELECT key FROM plugin_setting_defs WHERE plugin_name=? AND key=?").bind(name,String(b.key||"")).first<any>();
  if(!allowed)return ok({error:"setting not declared"},400);
  await env.DB.prepare("INSERT INTO plugin_settings(plugin_id,key,value) VALUES(?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value").bind(row.id,String(b.key),String(b.value??"")).run();
  await activity(env,userId,"update","plugin_setting",name,{key:b.key});
  return ok({ok:true});
}

async function deletePost(env: Env, userId: string, id: string, siteId: string) {
  await bootPluginRuntime(env);
  // The id comes straight from the URL, so ownership is established before
  // anything is removed. The statements below are keyed by `post_id`, which is
  // only meaningful once this row is known to belong to this site — without
  // this check a request against one site could delete another site's post.
  const owned = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND site_id=? LIMIT 1").bind(id, siteId).first<any>();
  if (!owned) return ok({ error: "not found" }, 404);
  // Let plugins purge their own derived data (indexes, caches) first.
  try {
    await doAction("beforeDeletePost", { env, siteId }, { id, siteId });
  } catch {
    /* a plugin failure must not prevent the delete */
  }
  await env.DB.prepare("DELETE FROM post_translations WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM post_meta WHERE post_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM term_relationships WHERE post_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM posts WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  await bumpContentCache(env, siteId);
  await activity(env, userId, "delete", "post", id, { siteId });
  return ok({ ok: true });
}

async function genericTable(env: Env, table: string, url: URL, siteId: string) {
  const allowed = new Set(["locales", "redirects", "rewrites", "plugins", "themes", "menus", "menu_items"]);
  if (!allowed.has(table)) return ok({ error: "Unsupported resource" }, 404);
  // Tables that carry site_id are filtered; global registries (plugins/themes)
  // are not, because an extension install is shared by every site.
  const scoped = new Set(["menus", "menu_items", "redirects", "rewrites"]);
  const sql = scoped.has(table)
    ? `SELECT * FROM ${table} WHERE site_id=? ORDER BY rowid DESC LIMIT 500`
    : `SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 500`;
  const rows = scoped.has(table)
    ? await env.DB.prepare(sql).bind(siteId).all()
    : await env.DB.prepare(sql).all();
  return ok({ items: rows.results, site: siteId });
}

/** Settings key holding the site-level admin menu customization blob. */
const MENU_CUSTOM_KEY = "admin.menu.custom";

/** Locale keys inside a `label` override object. */
const LABEL_LOCALE_RE = /^[A-Za-z0-9-]{2,10}$/;
/** Upper bound of per-label languages (the admin offers far fewer today). */
const LABEL_MAX_LOCALES = 8;
/** Sidebar item keys: core ids, `cpt:<name>`, `menu:<menu_id>`. */
const ITEM_KEY_RE = /^[A-Za-z0-9:_-]{1,120}$/;
/** Group ids are the SPA's built-in group keys (kebab-case). */
const GROUP_ID_RE = /^[a-z][a-z0-9-]{0,59}$/;

function normaliseMenuCustomLabel(v: unknown, what: string): Record<string, string> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what}: label must be an object of locale -> string`);
  const out: Record<string, string> = {};
  for (const [loc, val] of Object.entries(v as Record<string, unknown>).slice(0, LABEL_MAX_LOCALES)) {
    if (!LABEL_LOCALE_RE.test(loc)) throw new Error(`${what}: bad locale in label: ${loc}`);
    if (typeof val !== "string" || !val.trim()) throw new Error(`${what}: label for ${loc} must be a non-empty string`);
    if (val.length > 120) throw new Error(`${what}: label for ${loc} is longer than 120 characters`);
    out[loc] = val.trim();
  }
  return Object.keys(out).length ? out : null;
}

function normaliseMenuCustomOrder(v: unknown, what: string): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < -100000 || n > 100000) throw new Error(`${what}: order must be an integer`);
  return n;
}

/**
 * Normalize a PUT admin-menus/custom body into the storage blob. Throws with a
 * human-readable message on structural violations (the endpoint maps that to a
 * 400); unknown fields are dropped so the stored shape stays exactly what the
 * SPA consumes.
 */
function normaliseMenuCustom(b: unknown): { items: Record<string, unknown>; groups: Record<string, unknown> } {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("body must be an object");
  const body = b as Record<string, unknown>;
  const rawItems = body.items ?? {};
  if (typeof rawItems !== "object" || Array.isArray(rawItems)) throw new Error("items must be an object");
  const itemKeys = Object.keys(rawItems as Record<string, unknown>);
  if (itemKeys.length > 200) throw new Error("too many item overrides (max 200)");
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    const what = `item ${key}`;
    if (!ITEM_KEY_RE.test(key)) throw new Error(`${what}: bad key`);
    const v = (rawItems as Record<string, unknown>)[key];
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what}: must be an object`);
    const row = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const label = normaliseMenuCustomLabel(row.label, what);
    if (label) out.label = label;
    const order = normaliseMenuCustomOrder(row.order, what);
    if (order !== null) out.order = order;
    if (row.group !== undefined && row.group !== null) {
      if (typeof row.group !== "string" || !GROUP_ID_RE.test(row.group)) throw new Error(`${what}: bad group id`);
      out.group = row.group;
    }
    if (row.hidden !== undefined && row.hidden !== null) {
      if (typeof row.hidden !== "boolean") throw new Error(`${what}: hidden must be a boolean`);
      out.hidden = row.hidden;
    }
    if (Object.keys(out).length) items[key] = out;
  }
  const rawGroups = body.groups ?? {};
  if (typeof rawGroups !== "object" || Array.isArray(rawGroups)) throw new Error("groups must be an object");
  const groupKeys = Object.keys(rawGroups as Record<string, unknown>);
  if (groupKeys.length > 30) throw new Error("too many group overrides (max 30)");
  const groups: Record<string, unknown> = {};
  for (const id of groupKeys) {
    const what = `group ${id}`;
    if (!GROUP_ID_RE.test(id)) throw new Error(`${what}: bad group id`);
    const v = (rawGroups as Record<string, unknown>)[id];
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what}: must be an object`);
    const row = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const label = normaliseMenuCustomLabel(row.label, what);
    if (label) out.label = label;
    const order = normaliseMenuCustomOrder(row.order, what);
    if (order !== null) out.order = order;
    if (Object.keys(out).length) groups[id] = out;
  }
  return { items, groups };
}

async function settings(env: Env, siteId: string) {
  const rows = await env.DB.prepare("SELECT key, value, autoload FROM settings WHERE site_id=? ORDER BY key").bind(siteId).all();
  // Sensitive values (today the two image-host API keys) are never echoed:
  // every site member passes the read gate, and a key in many hands is quota
  // abuse waiting to happen. The write path keeps a blank write (`setSetting`
  // preserves on empty), so a redacted value round-trips safely through any
  // form that saves what it displayed.
  const items = ((rows.results as any[]) ?? []).map((r) =>
    settingDef(String(r.key))?.sensitive ? { ...r, value: "" } : r);
  return ok({ items, site: siteId });
}

/**
 * Read the platform feature switches for a site.
 *
 * Returns every declared switch with its resolved value **and where that value
 * came from** (`site` / `var` / `default`). The admin needs the provenance: a
 * checkbox that reads "off" because nobody set anything looks identical to one
 * that reads "off" because the operator turned it off, and only one of those
 * is worth acting on.
 *
 * `_kvWrites`-style honesty applies here too — the screen shows the *effective*
 * value, and the effective value is exactly what the runtime consumes, because
 * both go through `featureSnapshot()` / `featureEnabled()`.
 */
async function features(env: Env, siteId: string) {
  const snapshot = await featureSnapshot(env, siteId);
  const items = FEATURE_SWITCHES.map((s) => ({
    key: s.key,
    label: s.label,
    var: s.varName,
    default_on: s.defaultOn,
    enabled: snapshot[s.key].enabled,
    source: snapshot[s.key].source,
    // What the value would be if this site's row were removed — lets the admin
    // offer "reset to inherit" without a second round trip.
    inherited: inheritedValue(env, s),
  }));
  return ok({ items, site: siteId, settings_key: FEATURE_SETTINGS_KEY });
}

/**
 * Save one switch for a site.
 *
 * Stored as a single JSON object under one settings key rather than one row per
 * switch, so adding a switch is a code change with no migration and no chance
 * of a half-populated row. Unknown keys are rejected rather than ignored: a
 * typo that silently persists a key nothing reads is precisely the "declared
 * but never consumed" defect this repo keeps re-fixing.
 */
async function saveFeature(env: Env, userId: string, body: any, siteId: string) {
  const key = String(body.key ?? "");
  if (!key) return ok({ error: "key required" }, 400);
  // `featureSwitch()` throws on an unknown key; turn that into a 400 rather
  // than a 500, since it is caller input.
  if (!FEATURE_SWITCHES.some((s) => s.key === key)) {
    return ok({ error: `unknown feature switch: ${key}` }, 400);
  }

  const existing = await env.DB.prepare("SELECT id, value FROM settings WHERE site_id=? AND key=?")
    .bind(siteId, FEATURE_SETTINGS_KEY)
    .first<any>();
  let current: Record<string, unknown> = {};
  if (existing?.value != null) {
    try {
      const parsed = JSON.parse(String(existing.value));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch {
      /* a corrupt row is replaced rather than propagated */
    }
  }

  // `value: null` means "stop overriding on this site", so the row falls back
  // to the var / default. Deleting the key outright keeps the row honest about
  // which switches the operator actually chose.
  if (body.value === null || body.value === undefined) {
    delete current[key];
  } else {
    current[key] = truthy(body.value);
  }

  const next = JSON.stringify(current);
  if (existing) {
    await env.DB.prepare("UPDATE settings SET value=? WHERE site_id=? AND id=?").bind(next, siteId, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO settings (id, site_id, key, value, autoload) VALUES (?, ?, ?, ?, 1)")
      .bind(await randomId(), siteId, FEATURE_SETTINGS_KEY, next).run();
  }
  await activity(env, userId, "update", "feature", key, { siteId, value: current[key] ?? null });
  const snapshot = await featureSnapshot(env, siteId);
  // ⚠️ Read the snapshot defensively, and *never* index it blindly.
  //
  // The guard above already rejects unknown keys, so in theory this cannot be
  // undefined. But "in theory" is what the reverse-validation tool disproved:
  // neutralizing the guard does not turn the route into a permissive one, it
  // turns it into a **500**. `featureSnapshot()` only emits keys from
  // `FEATURE_SWITCHES`, so an unvalidated key yields `undefined` here and the
  // spread below throws on `.enabled`.
  //
  // A 500 on caller input is the wrong contract twice over: it hides the real
  // problem from the caller, and it means the only observable difference between
  // "the guard is present" and "the guard was deleted" is an unhandled
  // exception. Reporting the resolved state through an optional read keeps the
  // response shape stable and makes the failure legible.
  const resolved = snapshot[key];
  if (!resolved) {
    // Unreachable while the guard above stands; kept as the honest answer if it
    // ever does not.
    return ok({ error: `switch not resolvable: ${key}` }, 400);
  }
  return ok({ ok: true, key, enabled: resolved.enabled, source: resolved.source });
}

async function saveSetting(env: Env, userId: string, body: any, siteId: string) {
  const key = String(body.key ?? "");
  if (!key) return ok({ error: "key required" }, 400);
  if (!isDeclaredSetting(key)) return ok({ error: `undeclared setting key: ${key}` }, 400);
  if (settingDef(key)!.scope !== "site") {
    return ok({ error: `setting ${key} is not site-scoped (use the platform settings endpoint)` }, 400);
  }
  // `value: null` is the explicit "clear this key" signal (the SPA's per-key
  // Clear button), which `setSetting` implements as a row delete; a missing
  // `value` is a blank string, which keeps a sensitive value. Keeping the two
  // apart is what stops "I never saw the secret" from meaning "delete it".
  const value = body.value === null ? null : String(body.value ?? "");
  await setSetting(env, siteId, key, value);
  await activity(env, userId, "update", "setting", key, { siteId, cleared: value === null });
  return ok({ ok: true });
}

/**
 * Platform-scoped settings: one row for the whole install, readable and
 * writable only with `platform.manage`.
 *
 * These are the keys that mean the same thing for every site — where the admin
 * lives, whether registration is open — and they live in their own table
 * (`platform_settings`) rather than in `settings(site_id='*')`, because
 * `settings` is site-scoped and `deleteSite()` purges it per site.
 */
async function platformSettingsList(env: Env) {
  const read = [];
  for (const d of SETTING_DEFS.filter((x) => x.scope === "platform")) {
    const value = await platformSetting(env, d.key);
    read.push({ key: d.key, value, default: d.default as string | null, type: d.type });
  }
  return ok({ items: read, install: "platform" });
}

async function savePlatformSetting(env: Env, user: SessionUser, request: Request) {
  const body = await jsonBody(request);
  const key = String(body.key ?? "");
  if (!key) return ok({ error: "key required" }, 400);
  if (!isDeclaredSetting(key)) return ok({ error: `undeclared setting key: ${key}` }, 400);
  if (settingDef(key)!.scope !== "platform") {
    return ok({ error: `setting ${key} is not platform-scoped (use the site settings endpoint)` }, 400);
  }
  // `admin.path` is the one platform key that is also a *route*, so it has to
  // stay a shape the router and the SPA can both use: it must start with `/`,
  // must not end with one (the SPA appends its own segments), and must be
  // nothing but lowercase letters, digits, `-`, `_` and `/`. Rejecting here is
  // what stops an operator from typing themselves out of their own admin.
  if (key === "admin.path") {
    const value = String(body.value ?? "");
    if (!/^\/[a-z0-9/_-]*$/.test(value) || value.endsWith("/")) {
      return ok({ error: "admin.path must start with '/' and use only lowercase letters, digits, '-', '_' or '/'" }, 400);
    }
    if (value === "/") return ok({ error: "admin.path cannot be the site root" }, 400);
  }
  const value = body.value === null || body.value === undefined ? null : String(body.value);
  // Read the *old* prefix before the write, because the rename has two
  // consequences that are not "store a string":
  const previous = key === "admin.path" ? await adminPath(env) : null;
  await setPlatformSetting(env, key, value);
  await activity(env, user.id, "update", "platform-setting", key, { value });
  const res = ok({ ok: true, key, value });
  if (key === "admin.path") {
    // 1. Routing is live from the next request (`index.ts` drops the memo at
    //    the top of every fetch), but this request already read the *old*
    //    value into the memo — clear it so anything later in this same request
    //    sees where the admin actually is.
    resetAdminPathMemo(env);
    // 2. The caller's session cookie is scoped to the prefix they just left,
    //    so without this they are signed out by their own rename. Hand the
    //    same session back at the new address and expire the old cookie. This
    //    is what makes the change *live* rather than "reload and log in again".
    for (const cookie of rescopeSessionCookie(user.sessionId, previous ?? "/admin", String(value ?? ""))) {
      res.headers.append("Set-Cookie", cookie);
    }
  }
  return res;
}

/**
 * The media library for one site, as this user may see it.
 *
 * Scoping is two-dimensional and both halves are decided in
 * `platform/media-policy.ts`, not here: `site_id` (the tenant) and, when the
 * site's policy asks for it, `uploaded_by` (the owner). The same module answers
 * the `/media/<key>` read path, so a file the list shows is a file the reader
 * can actually fetch.
 */
async function mediaList(env: Env, url: URL, siteId: string, userId: string) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
  const offset = (page - 1) * limit;
  const q = String(url.searchParams.get("q") ?? "").trim();
  const type = String(url.searchParams.get("type") ?? "").trim();
  const policy = await readMediaPolicy(env, siteId);
  const owner = mediaOwnerClause(policy, userId);

  // `WHERE site_id = ?` is written into each statement rather than assembled
  // into a shared fragment: `tests/tools/_tenant-query-audit.mjs` reads
  // statements line by line, and a tenant predicate it cannot see is a tenant
  // predicate nobody re-reads. The optional filters and the owner clause are
  // appended after it.
  const extra: string[] = [];
  const extraBinds: unknown[] = [];
  if (q) { extra.push("(filename LIKE ? OR alt_text LIKE ? OR title LIKE ?)"); extraBinds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  // `type` is a MIME prefix ("image/", "application/pdf"), matched with LIKE so
  // a caller does not have to enumerate the exact media types it will accept.
  if (type) { extra.push("mime_type LIKE ?"); extraBinds.push(`${type}%`); }
  const tail = `${extra.length ? " AND " + extra.join(" AND ") : ""}${owner.sql}`;
  const binds = [siteId, ...extraBinds, ...owner.binds];

  const rows = await env.DB.prepare(
    `SELECT * FROM media_files WHERE site_id = ?${tail} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM media_files WHERE site_id = ?${tail}`)
    .bind(...binds).first<any>();
  // `storage` tells the Media screen where new uploads go and whether each
  // vendor key is configured — as booleans, because the keys themselves must
  // never leave the server. Additive: existing readers ignore unknown fields.
  const storage = await readMediaStorage(env, siteId);
  return ok({ items: rows.results, page, limit, total: total?.count ?? 0, isolation: policy.isolation, site: siteId, storage });
}

async function mediaUpload(env: Env, userId: string, request: Request, siteId: string) {
  // The tenant a file is filed under comes from `?site=`, which the client
  // controls and `requestSiteId()` only shape-checks. A write is the one place
  // that mints a tenant, so it is the one place that must confirm the site
  // exists — otherwise a typo files the upload under a site nobody can list.
  const known = await listSites(env);
  if (!known.some((s) => s.id === siteId)) return ok({ error: "unknown site" }, 400);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return ok({ error: "file required" }, 400);
  if (file.size > 25 * 1024 * 1024) return ok({ error: "max file size is 25MB" }, 413);
  const id = await randomId();
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Where the bytes go is the site's `cfpress.media` → `provider`: "r2" when
  // the site never chose (every existing install), anything else only when it
  // names a real provider. A present-but-unknown value answers 400 rather
  // than silently landing in R2 — the operator believes imgbb has the bytes,
  // and "answered success, stored elsewhere" is the defect this file will not
  // reintroduce.
  let provider: MediaStorageProvider = "r2";
  try {
    const raw = await getSetting(env, siteId, "cfpress.media").catch(() => "{}");
    const parsed = raw ? JSON.parse(String(raw)) : {};
    const p = mediaProviderOf(parsed && typeof parsed === "object" ? parsed : {});
    if (isMediaStorageProvider(p)) provider = p;
    else return ok({ error: `unknown media provider "${p}" (use r2, imgbb or postimages)` }, 400);
  } catch {
    provider = "r2";
  }
  let key: string;
  let remoteUrl: string | null = null;
  let remoteDeleteUrl: string | null = null;
  if (provider === "r2") {
    // Without an R2 binding this branch has nowhere to put bytes: refuse with
    // the remedy attached, instead of inserting a row that points at nothing
    // (or throwing a TypeError off an undefined binding, which the error
    // wrapper would report as an opaque 500).
    if (!env.MEDIA) return ok({ error: "R2 is not configured on this install — pick imgbb or postimages on the Media screen, or enable R2" }, 400);
    key = `uploads/${siteId}/${new Date().toISOString().slice(0,10)}/${id}-${safe}`;
    // The bytes go in as a buffer, not a `File.stream()`: a stream body is only
    // consumed by whatever reads it, and the local R2 shim accepts the handle
    // without draining it — the row then exists with no object behind it, and
    // the read path answers 404 forever after. Buffering makes the write
    // complete before the row claims it does.
    const bytes = await file.arrayBuffer();
    await env.MEDIA.put(key, bytes, {
      httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" }
    });
  } else {
    // Remote rows keep a namespaced key (`uploads/{site}/remote/…`) so the
    // tenant gate keeps answering from the key alone, and the content keeps
    // storing `/media/<key>` URLs: the read path 302s to the vendor after the
    // same policy decision, so the picker, the renderer and rule 60b need no
    // new URL shape. The vendor answers first — a row is only inserted once
    // there are bytes (a URL) to point at.
    key = remoteObjectKey(siteId, provider, id, safe);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const input = { bytes, filename: file.name, mimeType: file.type || "application/octet-stream" };
    // Effective keys: the site's own setting first, the install secret as
    // fallback (`readMediaKeys`). Either layer empty still refuses below.
    const keys = await readMediaKeys(env, siteId);
    try {
      const remote = provider === "imgbb"
        ? await uploadToImgbb(input, { apiKey: keys.imgbb })
        : await uploadToPostimages(input, { apiKey: keys.postimages });
      remoteUrl = remote.url;
      remoteDeleteUrl = remote.deleteUrl;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A missing key is operator configuration (400 with the fix attached);
      // a vendor refusal is upstream (502 with their message, truncated).
      // Log it server-side too: the UI toast shows the operator one failure,
      // but only the log shows the *pattern* (every failure at 400-forbidden
      // reads very differently from a mix of 429s and timeouts).
      if (!/missing API key/.test(message)) console.error(`media remote upload refused: provider=${provider} site=${siteId}: ${message}`);
      const missingKey = /missing API key/.test(message);
      return ok({ error: missingKey ? message : `remote host refused the upload: ${message}` }, missingKey ? 400 : 502);
    }
  }
  // `uploaded_by` is what the owner axis reads. Leaving it NULL here would make
  // every new upload fall into the grandfathered "visible site-wide" bucket,
  // which is the opposite of what recording an owner is for.
  await env.DB.prepare(
    "INSERT INTO media_files (id, site_id, object_key, filename, mime_type, size, alt_text, title, uploaded_by, created_at, storage, remote_url, remote_delete_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, siteId, key, file.name, file.type || "application/octet-stream", file.size, String(form.get("alt") ?? ""), String(form.get("title") ?? file.name), userId, now(), provider, remoteUrl, remoteDeleteUrl).run();
  await activity(env, userId, "upload", "media", id, { filename: file.name, size: file.size, siteId, storage: provider });
  return ok({ id, url: `/media/${encodeURIComponent(key)}`, site: siteId }, 201);
}

/**
 * Load a media row **and** establish that this user may act on it.
 *
 * Two separate questions, and the second one is the one that keeps getting
 * skipped: `site_id` decides whether the row is in this tenant at all, while
 * the owner axis decides whether this particular user may edit or delete it.
 * Both are checked before anything is written or removed — the pattern
 * `savePost`/`deletePost` had to learn twice (see `docs/HANDOVER.md` §8.33).
 *
 * Returns a stable error string rather than a Response so the caller decides
 * the status code; `not_found` covers "no such row" and "another site's row"
 * on purpose, so the API does not confirm the existence of other tenants' ids.
 */
async function mediaRowForWrite(
  env: Env,
  id: string,
  siteId: string,
  userId: string
): Promise<{ row: any } | { error: "not_found" | "not_owner" }> {
  const row = await env.DB.prepare("SELECT * FROM media_files WHERE id=? AND site_id=? LIMIT 1")
    .bind(id, siteId).first<any>();
  if (!row) return { error: "not_found" };
  const policy = await readMediaPolicy(env, siteId);
  if (policy.isolation === "owner" && row.uploaded_by != null && row.uploaded_by !== userId) {
    return { error: "not_owner" };
  }
  return { row };
}

/** Update the language-neutral descriptive fields. The bytes never change here:
 *  replacing a file's contents would silently break every page already
 *  referencing the old object, so that is a delete + upload, not a PATCH. */
/**
 * Uninstall a theme: everything keyed by it, plus its R2 files.
 *
 * "Everything" is the whole set, not just the obvious three: the registry row,
 * the generated-table mapping and the tables themselves, the capability rows
 * applied on any site, the theme's rows in the shared admin-menu registry, and
 * its setting definitions and saved values. A theme is the one case where
 * "deactivation keeps your data so switching back restores the site" does not
 * apply — there is no switching back — so anything left behind is orphaned
 * rather than dormant.
 *
 * Refuses while any site still selects it — uninstalling the theme that renders
 * a live site takes the site down with it, and the 409 names the sites so the
 * operator knows what to switch first. `active` on `theme_installs` cannot
 * answer that (it is a global recomputed flag); `settings.theme.active` is the
 * per-site truth. The refusal is the authority for the *unforced* call; a
 * `?force=1` DELETE is the operator's way out — it deactivates the theme on
 * every occupying site (they fall back to the bundled default, which rule 66
 * keeps renderable everywhere) and then removes it. A refusal without an exit
 * is how "this theme cannot be deleted" gets believed.
 *
 * Order matters the same way it does for media: the registry row is what names
 * the generated tables, so the tables are dropped **while the mapping is still
 * readable**, and only then is the row removed. R2 files go last — a theme that
 * is half-uninstalled (row gone, files left) is at least visible in the admin's
 * next listing, whereas files gone with the row still present is a theme the
 * admin believes exists and cannot load.
 */
async function uninstallTheme(env: Env, userId: string, name: string, force: boolean) {
  // A bundled theme has no R2 package to remove and its files come back with
  // the next deploy anyway; uninstalling it would only pretend to work.
  if((BUNDLED_THEMES as readonly string[]).includes(name)) return ok({error:`"${name}" ships with the product and cannot be uninstalled`},400);
  const row=await env.DB.prepare("SELECT name,version FROM theme_installs WHERE name=?").bind(name).first<any>();
  if(!row) return ok({error:"theme not found"},404);
  const active=await env.DB.prepare("SELECT site_id FROM settings WHERE key='theme.active' AND value=?").bind(name).all();
  const sites=((active.results as any[])??[]).map(r=>String(r.site_id));
  if(sites.length && !force) return ok({error:`still active on: ${sites.join(", ")}`},409);
  if(sites.length){
    // Forced: the operator has said this theme goes. Repoint every occupying
    // site to the bundled default — rule 66 keeps it installed and renderable
    // everywhere, so the fallback is a site that still renders. Capability
    // rows, menus, settings and generated tables are cleaned for *all* sites
    // by the uninstall below; only the per-site selection needs a write here.
    for(const s of sites){
      await env.DB.prepare("UPDATE settings SET value='default' WHERE site_id=? AND key='theme.active'").bind(s).run().catch(()=>{});
    }
  }

  const defs=await env.DB.prepare("SELECT table_name, i18n_table FROM theme_table_defs WHERE owner_type='theme' AND owner_name=?").bind(name).all();
  for(const d of ((defs.results as any[])??[])){
    for(const t of [d.table_name, d.i18n_table]){
      if(t) await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run().catch(()=>{});
    }
  }
  await env.DB.prepare("DELETE FROM theme_table_defs WHERE owner_type='theme' AND owner_name=?").bind(name).run();

  // Capability rows applied on any site. An inactive theme's rows are normally
  // gone already (deactivation clears them), but an interrupted activation
  // would leave some behind — and the theme is going away entirely, so every
  // site's leftovers go with it.
  for(const table of ["post_types","taxonomies","field_defs","theme_routes","theme_blocks"]){
    await env.DB.prepare(`DELETE FROM ${table} WHERE declared_by_theme=?`).bind(name).run().catch(()=>{});
  }

  // Admin menus are the same leftovers, but they live in the shared registry
  // and are therefore cleared through its API rather than a raw DELETE here —
  // the ownership predicate stays in one place, exactly as it does on the
  // deactivation path. Deactivation only clears the site it ran on, so a theme
  // whose activation was interrupted keeps menus pointing at the tables just
  // dropped above: the admin still sees the nav entry and the click 404s.
  await clearOwnerMenusAllSites(env,"theme",name);

  // Setting definitions and the values saved against them are keyed by theme
  // name. Deactivation deliberately keeps both (switching away and back must
  // not lose the site's configuration), so uninstalling is the only place they
  // can be removed — and once the theme is gone nothing reads them, so they
  // would sit in the admin forever as a theme that no longer exists.
  await env.DB.prepare("DELETE FROM theme_setting_defs WHERE theme_name=?").bind(name).run().catch(()=>{});
  await env.DB.prepare("DELETE FROM theme_settings WHERE theme_name=?").bind(name).run().catch(()=>{});

  // Capability grants are keyed by extension name and are what the runtime
  // consults before letting an extension act. The package is leaving the
  // install, so its grants must not outlive it.
  await env.DB.prepare("DELETE FROM extension_capabilities WHERE extension_type='theme' AND extension_name=?").bind(name).run().catch(()=>{});

  // R2 files: every version, not only the installed one — re-uploading a theme
  // leaves the previous version's prefix behind, and an uninstall that keeps
  // those bytes is a leak nobody can list. Without a binding there is nothing
  // to list, so the loop below is skipped whole (not half-guarded per key).
  let files=0;
  let cursor: string|undefined;
  if(env.MEDIA){
  do {
    const list=await env.MEDIA.list({prefix:`extensions/themes/${name}/`,cursor});
    for(const o of list.objects){ await env.MEDIA.delete(o.key).catch(()=>{}); files++; }
    cursor=list.truncated?list.cursor:undefined;
  } while(cursor);
  }

  await env.DB.prepare("DELETE FROM theme_installs WHERE name=?").bind(name).run();
  invalidateThemeWorker(env,name);
  await activity(env,userId,"uninstall","theme",name,{files,tables:((defs.results as any[])??[]).length});
  return ok({ok:true,name,files,tables:((defs.results as any[])??[]).length});
}

async function mediaUpdate(env: Env, userId: string, id: string, body: any, siteId: string) {
  const found = await mediaRowForWrite(env, id, siteId, userId);
  if ("error" in found) return ok({ error: found.error }, found.error === "not_found" ? 404 : 403);
  const fields: string[] = [];
  const binds: unknown[] = [];
  if (body.alt_text !== undefined) { fields.push("alt_text=?"); binds.push(String(body.alt_text ?? "")); }
  if (body.title !== undefined) { fields.push("title=?"); binds.push(String(body.title ?? "")); }
  if (!fields.length) return ok({ error: "nothing to update" }, 400);
  await env.DB.prepare(`UPDATE media_files SET ${fields.join(", ")} WHERE id=? AND site_id=?`)
    .bind(...binds, id, siteId).run();
  await activity(env, userId, "update", "media", id, { fields: fields.length, siteId });
  return ok({ ok: true, id, site: siteId });
}

/**
 * Delete a media file: the object first, then the row.
 *
 * Order is not cosmetic. The row is the only thing that knows the object's key,
 * so deleting the row first would strand the bytes in R2 with nothing left to
 * name them — an orphan no listing can show and no operator can find. Deleting
 * the object first can at worst leave a row whose object is gone, which the
 * read path already answers with 404 and a re-upload repairs.
 *
 * A failed R2 delete is reported, not swallowed: silently removing the row
 * would tell the operator the file is gone while it is still being served.
 */
async function mediaDelete(env: Env, userId: string, id: string, siteId: string) {
  const found = await mediaRowForWrite(env, id, siteId, userId);
  if ("error" in found) return ok({ error: found.error }, found.error === "not_found" ? 404 : 403);
  const key = String(found.row.object_key ?? "");
  const storage = String(found.row.storage ?? "r2");
  if (storage !== "r2" && isMediaStorageProvider(storage)) {
    // Remote bytes belong to the vendor: ask them to delete (best-effort —
    // `deleteRemoteImage` never throws), skip the R2 delete (there is no
    // object under this key), then drop the row either way. The row is ours;
    // a down vendor must not veto the local delete.
    const gone = await deleteRemoteImage(storage, found.row.remote_delete_url ?? null);
    if (!gone) console.error(`media remote delete unconfirmed: provider=${storage} id=${id}`);
  } else {
    try {
      // No R2 here either: without a binding there are no bytes to strand,
      // so the row delete below is the whole delete (and must not throw).
      if (key) await env.MEDIA?.delete(key);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return ok({ error: "object delete failed", detail: message }, 502);
    }
  }
  await env.DB.prepare("DELETE FROM media_files WHERE id=? AND site_id=?").bind(id, siteId).run();
  await activity(env, userId, "delete", "media", id, { key, siteId });
  return ok({ ok: true, id, key, site: siteId });
}

export async function handleApi(env: Env, request: Request): Promise<Response> {
  try {
    return await routeApi(env, request);
  } catch (e) {
    // Without this the exception escapes to the runtime, which answers with a
    // platform error page instead of JSON. `state.js` parses that as `{}` and
    // reports the opaque "Request failed", so the real cause is invisible from
    // the client and undiagnosable without live logs. Returning the message
    // keeps the failure legible; `console.error` keeps it in Workers Logs.
    const message = e instanceof Error ? e.message : String(e);
    console.error("api error:", message);
    return ok({ error: message }, 500);
  }
}

/**
 * The front-end API: `/api/v1/front/…`.
 *
 * Deliberately dispatched **before** `routeApi`'s `bootstrapAdmin` and
 * `requireAdmin`, because this surface must not consult the admin session at
 * all. That is the isolation: a request carrying an admin cookie is not
 * "an admin browsing the front end", it is an anonymous visitor — the front
 * end reads `cfpress_member` and nothing else. Handing a *staff* credential to
 * a front-end endpoint and being recognised is exactly the conflation §2.1
 * forbids, so it is enforced by construction rather than by a check that could
 * be reordered later.
 *
 * ## Why the site comes in as a parameter
 *
 * `index.ts` calls this **after** `resolveSite`, with the already-resolved
 * `siteId` and the already-stripped `path`. That ordering is the point: the
 * generic `/api/` branch runs before the site is known, so resolving the site
 * here again would always land on the default one — and a member on a
 * path-prefixed site (`/shop/api/v1/front/auth/login`) would find no API at
 * all. The visitor does not get to name their tenant either: there is no
 * `?site=` on this surface, and the resolved site is the only input.
 */
export async function handleFrontApi(env: Env, request: Request, siteId: string, resolvedPath: string): Promise<Response> {
  try {
    return await routeFrontApi(env, request, siteId, resolvedPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("front api error:", message);
    // A browser that submitted a form must not be shown a JSON body — not even
    // on a crash. The content type is still readable here (only the *body* is
    // consumed), so the shape of the answer is still the caller's.
    if (isFormRequest(request)) {
      return new Response(null, { status: 303, headers: { Location: "/?error=server_error" } });
    }
    return ok({ error: message }, 500);
  }
}

/**
 * Did this request come from a plain HTML form rather than a JSON caller?
 *
 * **Positive identification, not "anything that is not JSON".** A browser form
 * always sends one of these two types, so anything else — including a request
 * with no `Content-Type` at all — keeps the JSON path it had before, and no
 * existing caller changes shape. (`logout` is the one that would have: it takes
 * no body, so a script posts it with no content type.)
 */
function isFormRequest(request: Request): boolean {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

/**
 * Read a front-end request's parameters, whichever shape the caller sent.
 *
 * The theme renders its member surface as plain HTML forms — the templates say
 * "no JavaScript", and they mean it — so the API has to accept what a browser
 * actually sends: `application/x-www-form-urlencoded`. It keeps accepting JSON
 * too, because the tests and any script drive the same endpoints that way.
 *
 * **One reader for the whole surface.** A per-endpoint `request.json()` is how
 * the two shapes drift apart, and the drift is silent: the form path answers
 * `invalid_username` to a username the caller *did* send, because the JSON
 * parse failed and the `.catch` turned it into `{}`. That is exactly what the
 * login and register forms did before this existed.
 *
 * A form body is flat, so a custom field is spelled `meta_<key>`; the JSON path
 * sends `meta` whole, and is passed through untouched.
 */
async function readFrontParams(request: Request): Promise<{ body: Record<string, any>; form: boolean }> {
  if (!isFormRequest(request)) {
    const j = await request.json().catch(() => ({}));
    return { body: j && typeof j === "object" ? (j as Record<string, any>) : {}, form: false };
  }
  const fd = await request.formData().catch(() => null);
  const body: Record<string, any> = {};
  const meta: Record<string, string> = {};
  if (fd) {
    for (const [k, v] of fd.entries()) {
      if (typeof v !== "string") continue;
      if (k.startsWith("meta_")) meta[k.slice(5)] = v;
      else body[k] = v;
    }
  }
  if (Object.keys(meta).length) body.meta = meta;
  return { body, form: true };
}

/**
 * Where a form submission is allowed to be sent after it finishes.
 *
 * **Same-site absolute paths only.** The `redirect` field is caller-supplied in
 * the strongest sense — anyone can build a link to our form with any value in
 * it — so echoing it into `Location:` is an open redirect: a phishing page that
 * reads as ours. `//host` is protocol-relative (a *different* origin), and
 * `/\host` is a path to some browsers and an authority to others, so both are
 * refused along with anything absolute. A refused value falls back.
 */
function safeRedirect(value: unknown, fallback: string): string {
  const s = String(value ?? "").replace(/[\r\n]/g, "");
  if (/^\/(?!\/)/.test(s) && !s.startsWith("/\\")) return s;
  return fallback;
}

/**
 * Answer a front-end request in the shape the caller used.
 *
 * A JSON caller is untouched: same body, same status — that is the contract the
 * tests pin. A **form** caller gets `303 See Other` back to its own `redirect`
 * field, because a browser cannot read a JSON body: without this, "no
 * JavaScript" sign-in ends on a page showing the reader `{"ok":true}`. The
 * cookie the endpoint set rides on both. A failure redirects too, with
 * `?error=<code>` — the alternative is showing a reader a JSON error page for a
 * typo in their password.
 */
async function frontAnswer(form: boolean, res: Response, opts: { redirect?: unknown; fallback: string }): Promise<Response> {
  if (!form) return res;
  let to = safeRedirect(opts.redirect, opts.fallback);
  if (res.status >= 400) {
    const body: any = await res.json().catch(() => ({}));
    const code = typeof body?.error === "string" ? body.error : "failed";
    to += (to.includes("?") ? "&" : "?") + "error=" + encodeURIComponent(code);
  }
  const headers: Record<string, string> = { Location: to };
  const cookie = res.headers.get("set-cookie");
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

/**
 * Front-end publishing: a member writing their **own** posts.
 *
 * ## Why this is not `savePost` with a different caller
 *
 * `savePost` answers to a **staff** session: it takes its author from the admin
 * cookie, writes it into `posts.author_id`, and trusts the caller's `status`
 * (an editor is allowed to publish). A member is a different identity (rule 77),
 * and the three differences are the reason this is a separate function:
 *
 *   1. **The author is the session, not the body.** `author_member_id` comes
 *      from `requireMember`'s result. `body.author_member_id` is not read at
 *      all — reading it would let one member author posts *as* another, which
 *      is the same defect shape as a client-supplied `site_id`. `author_id`
 *      stays `''` (migration 0024: never invent a fake staff user, because
 *      `author_id` is a staff id space and every reader of it assumes so).
 *   2. **The status is the server's decision.** A member submission is a
 *      *submission*: it lands as `draft`, and publishing stays a staff act.
 *      `body.status` is ignored outright, so a crafted request cannot put
 *      itself on the front page. An **edit** does not touch the status at all
 *      either — a member must not be able to publish, nor to knock a
 *      staff-published post back to draft.
 *   3. **Ownership is a filter, and a miss is 404.** Every statement carries
 *      `site_id` AND `author_member_id`; a post owned by another member,
 *      another site, or nobody answers 404 — never 403, which would confirm
 *      that the id exists (the existence oracle MS-1.1 forbids, and the reason
 *      `savePost` answers 404 for a cross-site id too).
 *
 * What it *shares* with `savePost` is everything that is about **content**
 * rather than identity: the per-language slug with its clash check (rule 58),
 * the per-language `post_meta` write (rule 70 — written here, read only through
 * `resolveMetaByPost`), and `bumpContentCache`.
 *
 * ## What is deliberately absent
 *
 * No `activity()` call. `admin_activity.user_id` holds a **staff** id, and
 * writing a member id into it would be the "one column, two meanings" defect
 * migration 0024 refused for `author_id`. Member actions are recorded by the
 * row they touch (`posts.author_member_id`), not in the staff log.
 *
 * No `scheduled_posts` row either: scheduling is publishing, and publishing is
 * a staff act.
 */
async function saveMemberPost(
  env: Env,
  siteId: string,
  memberId: string,
  id: string | null,
  body: any
): Promise<Response> {
  const defaultLoc = await siteDefaultLocale(env, siteId);
  const locale = String(body.locale ?? "").trim() || defaultLoc;
  const isDefaultLocale = locale === defaultLoc;
  const title = String(body.title ?? "");
  const excerpt = String(body.excerpt ?? "");
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? []);
  // `undefined` (field absent) leaves the translation's slug override alone; an
  // empty string clears it so the URL follows the main table again. Same
  // three-state contract as `savePost`.
  const slugGiven = body.slug !== undefined;
  const tSlug = String(body.slug ?? "").trim();

  const entityId = id ?? `post_${await randomId()}`;

  // Ownership is established before anything is written, on the **site and the
  // member together** — in the SQL, not by comparing a fetched column in JS. A
  // predicate the database applies cannot be forgotten by a later edit to the
  // branch that reads it, and it is the same shape the DELETE uses. A `PUT`
  // naming an id this member does not own is 404 for every reason it could be:
  // wrong site, wrong member, no such row. One answer, so the response cannot
  // be used to enumerate ids.
  const owned = await env.DB.prepare(
    "SELECT id FROM posts WHERE id=? AND site_id=? AND author_member_id=? AND type='post' LIMIT 1"
  ).bind(entityId, siteId, memberId).first<any>();
  if (id && !owned) {
    return ok({ error: "not found" }, 404);
  }
  const isCreate = !owned;

  // An explicitly sent slug must be free *in this language* (rule 58). Two
  // translations of different posts may not share a URL; the main-table check
  // on top covers the default language, whose slug is also the identity.
  if (tSlug) {
    const clash = await env.DB.prepare(
      `SELECT p.id FROM posts p JOIN post_translations t ON t.post_id=p.id
        WHERE p.site_id=? AND p.type='post' AND t.locale=? AND COALESCE(t.slug,p.slug)=? AND p.id<>? LIMIT 1`
    ).bind(siteId, locale, tSlug, entityId).first<any>();
    if (clash) return ok({ error: "slug already used in this language" }, 409);
    if (isDefaultLocale) {
      const clashMain = await env.DB.prepare(
        "SELECT id FROM posts WHERE site_id=? AND type='post' AND slug=? AND id<>? LIMIT 1"
      ).bind(siteId, tSlug, entityId).first<any>();
      if (clashMain) return ok({ error: "slug already used in this language" }, 409);
    }
  }

  if (isCreate) {
    await env.DB.prepare(
      `INSERT INTO posts (id, site_id, author_id, author_member_id, type, slug, status, lang_group, created_at, updated_at)
       VALUES (?, ?, '', ?, 'post', ?, 'draft', ?, ?, ?)`
    ).bind(entityId, siteId, memberId, tSlug || entityId, entityId, now(), now()).run();
  } else {
    // `status` is deliberately **not** in this UPDATE (see the note above).
    // The main-table slug follows the save only when this locale owns it —
    // otherwise renaming would move the *other* languages' URLs, whose
    // COALESCE falls through to it.
    const others = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM post_translations WHERE post_id=? AND locale<>?"
    ).bind(entityId, locale).first<any>();
    const ownsMainSlug = isDefaultLocale || Number(others?.c ?? 0) === 0;
    if (ownsMainSlug && tSlug) {
      await env.DB.prepare("UPDATE posts SET slug=?, updated_at=? WHERE id=? AND site_id=?")
        .bind(tSlug, now(), entityId, siteId).run();
    } else {
      await env.DB.prepare("UPDATE posts SET updated_at=? WHERE id=? AND site_id=?")
        .bind(now(), entityId, siteId).run();
    }
  }

  const existing = await env.DB.prepare(
    "SELECT id, slug FROM post_translations WHERE post_id=? AND locale=? LIMIT 1"
  ).bind(entityId, locale).first<any>();
  if (existing) {
    const nextSlug = slugGiven ? (tSlug || null) : (existing.slug ?? null);
    await env.DB.prepare(
      "UPDATE post_translations SET title=?, excerpt=?, content=?, slug=?, updated_at=? WHERE id=?"
    ).bind(title, excerpt, content, nextSlug, now(), existing.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO post_translations (id, post_id, locale, title, excerpt, content, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(await randomId(), entityId, locale, title, excerpt, content, tSlug || null, now(), now()).run();
  }

  // Custom fields: written against **this save's locale**, and only for keys
  // the active theme declares for this site. Reading is the ladder in
  // `platform/post-meta.ts` — never here (rule 70).
  await writePostMeta(env, siteId, entityId, locale, body.meta);

  await bumpContentCache(env, siteId);
  // Read the row back rather than reporting what was *asked for*: an update
  // does not touch the status, so echoing a literal `"draft"` would tell a
  // member their published post is a draft.
  const after = await env.DB.prepare(
    `SELECT p.status, COALESCE(t.slug, p.slug) AS slug
       FROM posts p JOIN post_translations t ON t.post_id=p.id AND t.locale=?
      WHERE p.id=? AND p.site_id=? LIMIT 1`
  ).bind(locale, entityId, siteId).first<any>();
  const slug = after?.slug ?? (tSlug || entityId);
  return ok(
    { id: entityId, post: { id: entityId, locale, slug, status: after?.status ?? "draft", url: `/${locale}/blog/${slug}` } },
    isCreate ? 201 : 200
  );
}

/** A member deleting their **own** post. Same ownership filter, same 404. */
async function deleteMemberPost(env: Env, siteId: string, memberId: string, id: string): Promise<Response> {
  const owned = await env.DB.prepare(
    "SELECT id FROM posts WHERE id=? AND site_id=? AND author_member_id=? AND type='post' LIMIT 1"
  ).bind(id, siteId, memberId).first<any>();
  if (!owned) return ok({ error: "not found" }, 404);
  // Plugins purge their derived data first, exactly as the staff path does.
  try {
    await doAction("beforeDeletePost", { env, siteId }, { id, siteId });
  } catch {
    /* a plugin failure must not prevent the delete */
  }
  await env.DB.prepare("DELETE FROM post_translations WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM post_meta WHERE post_id = ?").bind(id).run().catch(() => {});
  await env.DB.prepare("DELETE FROM term_relationships WHERE post_id = ?").bind(id).run().catch(() => {});
  // `site_id` stays in the predicate even though `owned` proved it: the check
  // and the write must agree on what "this post" means, and a later edit to one
  // of them should not be able to silently widen the other.
  await env.DB.prepare("DELETE FROM posts WHERE id = ? AND site_id = ?").bind(id, siteId).run();
  await bumpContentCache(env, siteId);
  return ok({ ok: true });
}

async function routeFrontApi(env: Env, request: Request, siteId: string, resolvedPath: string): Promise<Response> {
  // `resolvedPath` is the path *after* the site prefix was stripped, so the
  // match is on `/api/v1/front/…` regardless of how the site is mounted.
  const path = resolvedPath.replace(/^\/api\/v1\/front\/?/, "");
  const method = request.method;

  if (path === "auth/register" && method === "POST") {
    const { body, form } = await readFrontParams(request);
    const r = await registerMember(env, siteId, String(body.username ?? ""), String(body.password ?? ""), body.email ? String(body.email) : null);
    // `closed` is a policy refusal (403); the rest are input errors (400).
    // The codes are stable so the theme can translate them.
    const res =
      "error" in r
        ? ok({ error: r.error }, r.error === "closed" ? 403 : 400)
        : new Response(JSON.stringify({ ok: true, member: r.member }), {
            status: 201,
            headers: { "Content-Type": "application/json", "Set-Cookie": r.cookie },
          });
    return frontAnswer(form, res, { redirect: body.redirect, fallback: "/" });
  }

  if (path === "auth/login" && method === "POST") {
    const { body, form } = await readFrontParams(request);
    const r = await loginMember(env, siteId, String(body.username ?? ""), String(body.password ?? ""));
    const res =
      "error" in r
        ? ok({ error: r.error }, 401)
        : new Response(JSON.stringify({ ok: true, member: r.member }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Set-Cookie": r.cookie },
          });
    return frontAnswer(form, res, { redirect: body.redirect, fallback: "/" });
  }

  if (path === "auth/logout" && method === "POST") {
    const { body, form } = await readFrontParams(request);
    const r = await logoutMember(env, request);
    const res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": r.cookie },
    });
    return frontAnswer(form, res, { redirect: body.redirect, fallback: "/" });
  }

  if (path === "me" && method === "GET") {
    // `requireMember` answers 401 with JSON; `me` returning `{ member: null }`
    // with 200 would make "not signed in" and "signed in" the same shape, and
    // the theme's header would have to guess which it got.
    const m = await requireMember(env, request, siteId);
    if (m instanceof Response) return m;
    return ok({ member: m });
  }

  // -- the member's own posts (rule 84) ------------------------------------
  // Identity comes from `requireMember` and **only** from there; nothing in the
  // body or the path can name an author. A signed-out caller gets the 401
  // `requireMember` produces, which is the same answer every other front
  // endpoint gives — the surface has one gate, not one per endpoint.
  //
  // There is deliberately **no** `GET /posts` list here. The read path for "my
  // posts" is the account page's `my_posts` scope (rule 82), defined once in
  // `buildScope`; a second reader with its own SQL would be a second definition
  // of "mine", and the two would be free to disagree.
  // A form cannot send `PUT` or `DELETE`, so each write has a POST twin. They
  // are **routes**, not second implementations: every one calls the same
  // `saveMemberPost` / `deleteMemberPost`, so the ownership filter, the author
  // and the status rule live in exactly one place (rule 84). The JSON verbs
  // stay for scripts; `POST /posts/:id/delete` is how a browser deletes.
  if (path === "posts" && method === "POST") {
    const m = await requireMember(env, request, siteId);
    if (m instanceof Response) return m;
    const { body, form } = await readFrontParams(request);
    return frontAnswer(form, await saveMemberPost(env, siteId, m.id, null, body), {
      redirect: body.redirect,
      fallback: "/",
    });
  }
  const ownDelete = path.match(/^posts\/([^/]+)\/delete$/);
  if (ownDelete && method === "POST") {
    const m = await requireMember(env, request, siteId);
    if (m instanceof Response) return m;
    const { body, form } = await readFrontParams(request);
    const res = await deleteMemberPost(env, siteId, m.id, decodeURIComponent(ownDelete[1]));
    return frontAnswer(form, res, { redirect: body.redirect, fallback: "/" });
  }
  const ownPost = path.match(/^posts\/([^/]+)$/);
  if (ownPost && (method === "PUT" || method === "POST")) {
    const m = await requireMember(env, request, siteId);
    if (m instanceof Response) return m;
    const { body, form } = await readFrontParams(request);
    const res = await saveMemberPost(env, siteId, m.id, decodeURIComponent(ownPost[1]), body);
    return frontAnswer(form, res, { redirect: body.redirect, fallback: "/" });
  }
  if (ownPost && method === "DELETE") {
    const m = await requireMember(env, request, siteId);
    if (m instanceof Response) return m;
    return deleteMemberPost(env, siteId, m.id, decodeURIComponent(ownPost[1]));
  }

  return ok({ error: "Not found" }, 404);
}

async function routeApi(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  // ⚠️ The *unprefixed* `/api/v1/front/…` path is answered here too, but with
  // the default site (the site is not known yet at this point). A site mounted
  // on a path prefix reaches its own front API through `index.ts`, which
  // resolves the site first and calls `handleFrontApi` with the stripped path
  // — see the call site. Reaching it here means "no site prefix in the URL",
  // i.e. the default site.
  if (url.pathname.startsWith("/api/v1/front/")) {
    await bootstrapAdmin(env);
    return handleFrontApi(env, request, DEFAULT_SITE_ID, url.pathname);
  }
  await bootstrapAdmin(env);
  const path = url.pathname.replace(/^\/api\/v1\/?/, "");
  const method = request.method;

  if (path === "health" && method === "GET") return ok({ ok: true, version: "0.7.0" });
  if ((path === "openapi.json" || path === "openapi") && method === "GET") {
    return ok(generateOpenApiSchema(url.origin));
  }
  // ⚠️ 登录端点已迁至 `/{admin.path}/api/login`（见 index.ts）——这里是后台唯一
  // 未鉴权、可被爆破的端点，因此必须与后台前缀一起隐身。旧路径一律 404。
  if (path === "auth/logout" && method === "POST") return logout(env, request, await adminPath(env));

  let user: SessionUser | null = null;
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer cfp_")) {
    const apiKeyUser = await authenticateApiKey(env, authHeader.slice(7).trim());
    if (!apiKeyUser) return ok({ error: "Unauthorized" }, 401);
    user = apiKeyUser;
  } else {
    const adminUser = await currentUser(env, request);
    if (adminUser) user = adminUser;
  }

  if (path === "auth/me" && method === "GET") {
    return user ? ok({ user }) : ok({ user: null }, 401);
  }

  if (!user) {
    return ok({ error: "Unauthorized" }, 401);
  }
  const siteId = requestSiteId(url);
  // Malformed `?site=` never falls back to another tenant's data (MS-2.4).
  if (siteParamMalformed(url)) return ok({ error: "invalid site" }, 400);

  // Cross-cutting gates
  if ((path === "posts" || path === "pages" || /^posts\//.test(path) || /^pages\//.test(path) || path === "terms" || /^terms\//.test(path) || /^taxonomies\//.test(path)) && method !== "GET") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
  }
  if (path === "media" && method === "POST" && !(await requirePermission(env, user, "media.write", siteId))) return ok({ error: "Forbidden" }, 403);

  if (method === "GET" && /^(posts|pages|content\/|search|media|settings|features|dashboard|stats|taxonomies|terms|tables|widgets|menus|menu_items|redirects|rewrites|locales|theme\/|theme-tables|i18n\/(locales|overrides|translations|messages|ui-locale))/.test(path)) {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
  }

  // Domain dispatchers
  const resAuth = await dispatchAuthAdminRoutes(env, request, user, path, method);
  if (resAuth) return resAuth;

  const resMenu = await dispatchAdminMenuCustomRoutes(env, request, user, siteId, path, method);
  if (resMenu) return resMenu;

  const resSite = await dispatchSiteAdminRoutes(env, request, user, siteId, path, method, url);
  if (resSite) return resSite;

  const resI18n = await dispatchI18nAdminRoutes(env, request, user, siteId, path, method, url);
  if (resI18n) return resI18n;

  const resThemeTable = await dispatchThemeTableAdminRoutes(env, request, user, siteId, path, method, url);
  if (resThemeTable) return resThemeTable;

  const resDash = await dispatchDashboardAndBlockRoutes(env, request, user, siteId, path, method, url);
  if (resDash) return resDash;

  const resContent = await dispatchContentAdminRoutes(env, request, user, siteId, path, method, url);
  if (resContent) return resContent;

  const resTax = await dispatchTaxonomyAndTermRoutes(env, request, user, siteId, path, method, url);
  if (resTax) return resTax;

  const resMedia = await dispatchMediaAdminRoutes(env, request, user, siteId, path, method, url);
  if (resMedia) return resMedia;

  const resSettings = await dispatchSettingsAdminRoutes(env, request, user, siteId, path, method, url);
  if (resSettings) return resSettings;

  const resNav = await dispatchNavAndWidgetRoutes(env, request, user, siteId, path, method, url);
  if (resNav) return resNav;

  const resExt = await dispatchExtensionAdminRoutes(env, request, user, siteId, path, method, url);
  if (resExt) return resExt;

  const resUsers = await dispatchUserAndActivityRoutes(env, request, user, siteId, path, method);
  if (resUsers) return resUsers;

  return ok({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Domain Route Dispatchers
// ---------------------------------------------------------------------------

async function dispatchAuthAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  path: string,
  method: string
): Promise<Response | null> {
  // -- self-service credentials (any signed-in role) -----------------------
  if (path === "auth/password" && method === "POST") {
    const b = await jsonBody(request);
    const result = await changePassword(env, user.id, String(b.current_password ?? ""), String(b.new_password ?? ""));
    if (result === "weak") return ok({ error: "weak" }, 400);
    if (result === "wrong_current") return ok({ error: "wrong_current" }, 403);
    await activity(env, user.id, "update", "user_password", user.id, {});
    return ok({ ok: true });
  }
  if (path === "auth/username" && method === "POST") {
    const b = await jsonBody(request);
    const wanted = String(b.username ?? "").trim();
    const result = await changeUsername(env, user.id, String(b.current_password ?? ""), wanted);
    if (result === "invalid") return ok({ error: "invalid" }, 400);
    if (result === "taken") return ok({ error: "taken" }, 409);
    if (result === "wrong_current") return ok({ error: "wrong_current" }, 403);
    await activity(env, user.id, "update", "user_username", user.id, { username: wanted });
    return ok({ ok: true, username: wanted });
  }

  // -- per-user sidebar menu configuration ---------------------------------
  if (path === "admin-menus/prefs" && method === "GET") {
    return ok({ hidden: await getMenuPrefs(env, user.id) });
  }
  if (path === "admin-menus/prefs" && method === "PUT") {
    const b = await jsonBody(request);
    if (!Array.isArray(b.hidden)) return ok({ error: "hidden must be an array of nav keys" }, 400);
    const hidden = [...new Set((b.hidden as unknown[]).map((v: unknown) => String(v)).filter((s: string) => s && s.length <= 120))].slice(0, 200);
    await setMenuPrefs(env, user.id, hidden);
    await activity(env, user.id, "update", "menu_prefs", user.id, { count: hidden.length });
    return ok({ ok: true, hidden });
  }

  // -- machine-to-machine API keys (for AI Agents and automation) ----------
  if (path === "auth/api-keys" && method === "GET") {
    const keys = await listApiKeys(env, user.role === SUPERADMIN_ROLE ? undefined : user.id);
    return ok({ items: keys, keys });
  }
  if (path === "auth/api-keys" && method === "POST") {
    const b = await jsonBody(request);
    const name = String(b.name || "").trim();
    if (!name) return ok({ error: "Name is required" }, 400);
    const scopes = Array.isArray(b.scopes) ? b.scopes.map(String) : ["*"];
    const sites = Array.isArray(b.sites) ? b.sites.map(String) : ["*"];
    const expiresInDays = b.expires_in_days ? Number(b.expires_in_days) : null;
    const created = await createApiKey(env, user.id, name, scopes, sites, expiresInDays);
    await activity(env, user.id, "create", "api_key", created.id, { name, scopes, sites });
    return ok({ key: created, ...created }, 201);
  }
  const matchRevokeKey = path.match(/^auth\/api-keys\/([^/]+)$/);
  if (matchRevokeKey && method === "DELETE") {
    const keyId = decodeURIComponent(matchRevokeKey[1]);
    const success = await revokeApiKey(env, keyId, user.role === SUPERADMIN_ROLE ? undefined : user.id);
    if (!success) return ok({ error: "API key not found" }, 404);
    await activity(env, user.id, "revoke", "api_key", keyId, {});
    return ok({ ok: true });
  }

  return null;
}

async function dispatchAdminMenuCustomRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string
): Promise<Response | null> {
  // -- site-level admin menu customization (batch 5) ------------------------
  if (path === "admin-menus/custom" && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?").bind(siteId, MENU_CUSTOM_KEY).first<any>();
    let parsed: any = {};
    try { parsed = row?.value ? JSON.parse(row.value) : {}; } catch { parsed = {}; }
    return ok({
      items: parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items) ? parsed.items : {},
      groups: parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups) ? parsed.groups : {},
      can_manage: await requirePermission(env, user, "settings.manage", siteId),
    });
  }
  if (path === "admin-menus/custom" && method === "PUT") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    let blob: { items: Record<string, unknown>; groups: Record<string, unknown> };
    try {
      blob = normaliseMenuCustom(b);
    } catch (e: any) {
      return ok({ error: e?.message || "invalid menu customization" }, 400);
    }
    await env.DB.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value")
      .bind(`admin-menu-custom-${siteId}`, siteId, MENU_CUSTOM_KEY, JSON.stringify(blob)).run();
    await activity(env, user.id, "update", "menu_custom", siteId, { items: Object.keys(blob.items).length, groups: Object.keys(blob.groups).length });
    return ok({ ok: true, ...blob });
  }
  if (path === "admin-menus/custom" && method === "DELETE") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    await env.DB.prepare("DELETE FROM settings WHERE site_id=? AND key=?").bind(siteId, MENU_CUSTOM_KEY).run();
    await activity(env, user.id, "delete", "menu_custom", siteId, {});
    return ok({ ok: true, items: {}, groups: {} });
  }

  return null;
}

async function dispatchSiteAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  // Sites registry (multi-site)
  if (path === "sites" && method === "GET") {
    const allowed = await accessibleSiteIds(env, user);
    const items = (await listSites(env)).filter(
      (s: any) => allowed === null || allowed.includes(String(s.id))
    );
    if (url.searchParams.get("withCounts") === "1") {
      const [posts, pages, themeRows] = await Promise.all([
        env.DB.prepare("SELECT site_id, COUNT(*) AS count FROM posts WHERE type='post' GROUP BY site_id").all(),
        env.DB.prepare("SELECT site_id, COUNT(*) AS count FROM posts WHERE type='page' GROUP BY site_id").all(),
        env.DB.prepare("SELECT site_id, value FROM settings WHERE key='theme.active'").all(),
      ]);
      const mediaCounts: Record<string, number> = {};
      for (const s of items as any[]) {
        const sid = String((s as any).id);
        try {
          const pol = await readMediaPolicy(env, sid);
          const oc = mediaOwnerClause(pol, user.id);
          const c = await env.DB.prepare(`SELECT COUNT(*) AS count FROM media_files WHERE site_id=?${oc.sql}`).bind(sid, ...oc.binds).first<any>();
          mediaCounts[sid] = Number(c?.count ?? 0) || 0;
        } catch {
          mediaCounts[sid] = 0;
        }
      }
      const bySite = (r: any) => Object.fromEntries(((r.results as any[]) ?? []).map((x) => [String(x.site_id), Number(x.count) || 0]));
      const postCounts = bySite(posts);
      const pageCounts = bySite(pages);
      const themes = Object.fromEntries(((themeRows.results as any[]) ?? []).map((r) => [String(r.site_id), String(r.value ?? "")]));
      return ok({
        items: items.map((s) => ({
          ...s,
          counts: {
            posts: postCounts[s.id] ?? 0,
            pages: pageCounts[s.id] ?? 0,
            media: mediaCounts[s.id] ?? 0,
          },
          theme: themes[s.id] ?? "",
        })),
      });
    }
    return ok({ items });
  }
  if (path === "sites" && method === "POST") {
    if(!(await requirePermission(env,user,"platform.manage",siteId))) return ok({error:"Forbidden"},403);
    const b = await jsonBody(request);
    const r = await createSite(env, { id: b.id, name: String(b.name ?? ""), host: b.host ?? null, pathPrefix: b.path_prefix ?? b.pathPrefix ?? null });
    if ("error" in r) return ok({ error: r.error }, 400);
    await activity(env, user.id, "create", "site", r.id, { name: b.name });
    return ok({ id: r.id }, 201);
  }
  const siteMatch = path.match(/^sites\/([^/]+)$/);
  if (siteMatch) {
    if (method === "GET") {
      const allowed = await accessibleSiteIds(env, user);
      if (allowed !== null && !allowed.includes(siteMatch[1])) return ok({ error: "Forbidden" }, 403);
      const site = (await listSites(env)).find((s: any) => String(s.id) === siteMatch[1]);
      if (!site) return ok({ error: "site not found" }, 404);
      const activeT = await activeTheme(env, siteMatch[1]).catch(() => null);
      const defLocale = await siteDefaultLocale(env, siteMatch[1]);
      const locs = await siteLocaleCodes(env, siteMatch[1]);
      return ok({ site: { ...site, active_theme: activeT?.name ?? null, default_locale: defLocale, enabled_locales: locs } });
    }
    if (method === "PUT" || method === "PATCH") {
      if(!(await requirePermission(env,user,"platform.manage",siteId))) return ok({error:"Forbidden"},403);
      const b = await jsonBody(request);
      const r = await updateSite(env, siteMatch[1], { name: b.name, host: b.host, pathPrefix: b.path_prefix ?? b.pathPrefix, status: b.status });
      if ("error" in r) return ok({ error: r.error }, 404);
      await activity(env, user.id, "update", "site", siteMatch[1]);
      return ok({ ok: true });
    }
    if (method === "DELETE") {
      if(!(await requirePermission(env,user,"platform.manage",siteId))) return ok({error:"Forbidden"},403);
      let generatedTables: string[] = [];
      let generatedSidecars: string[] = [];
      try {
        const defs = await env.DB.prepare(
          "SELECT table_name, i18n_table FROM theme_table_defs WHERE site_id=?"
        ).bind(siteMatch[1]).all();
        const mains = new Set<string>();
        const sides = new Set<string>();
        for (const d of ((defs.results as any[]) ?? [])) {
          if (typeof d.table_name === "string" && /^[a-z][a-z0-9_]*$/.test(d.table_name)) mains.add(d.table_name);
          if (typeof d.i18n_table === "string" && /^[a-z][a-z0-9_]*$/.test(d.i18n_table)) sides.add(d.i18n_table);
        }
        generatedTables = [...mains];
        generatedSidecars = [...sides];
      } catch { generatedTables = []; generatedSidecars = []; }
      const r = await deleteSite(env, siteMatch[1], PURGE_ON_SITE_DELETE);
      if ("error" in r) return ok({ error: r.error }, 400);
      for (const t of generatedTables) {
        try { await env.DB.prepare(`DELETE FROM ${t} WHERE site_id=?`).bind(siteMatch[1]).run(); }
        catch { /* a dropped/missing physical table is already gone */ }
      }
      for (const s of generatedSidecars) {
        const parent = s.replace(/_i18n$/, "");
        if (!generatedTables.includes(parent)) continue;
        try { await env.DB.prepare(`DELETE FROM ${s} WHERE row_id NOT IN (SELECT id FROM ${parent})`).run(); }
        catch { /* sidecar already gone */ }
      }
      await activity(env, user.id, "delete", "site", siteMatch[1]);
      return ok({ ok: true });
    }
  }
  const siteLocMatch = path.match(/^sites\/([^/]+)\/locales$/);
  if (siteLocMatch && method === "GET") {
    const sid = siteLocMatch[1];
    const allowed = await accessibleSiteIds(env, user);
    if (allowed !== null && !allowed.includes(sid)) return ok({ error: "Forbidden" }, 403);
    return ok({
      site: sid,
      default: await siteDefaultLocale(env, sid),
      enabled: await siteLocaleCodes(env, sid),
      items: await siteLocaleRows(env, sid),
    });
  }

  return null;
}

async function dispatchI18nAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if (path === "i18n/locales" && method === "GET") {
    const [rows, enabled, dictionary, uiLocales] = await Promise.all([
      siteLocaleRows(env, siteId),
      siteLocales(env, siteId),
      platformLocales(env),
      availableUiLocales(env, siteId),
    ]);
    return ok({
      site: siteId,
      items: rows,
      enabled: enabled.map((l) => l.code),
      default: await siteDefaultLocale(env, siteId),
      multilingual: enabled.length >= 2,
      dictionary,
      ui_locales: uiLocales,
      core_locales: corePackLocales(),
      core_entries: corePackLocaleEntries(),
    });
  }
  if (path === "i18n/locales" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const code = String(b.code ?? "").trim();
    if (!isLocaleCode(code)) return ok({ error: `invalid locale code: ${code}` }, 400);
    if (b.name) {
      await upsertPlatformLocale(env, {
        code,
        name: String(b.name),
        native_name: b.native_name ? String(b.native_name) : String(b.name),
        direction: b.direction === "rtl" ? "rtl" : "ltr",
        enabled: 1,
      });
    }
    await enableSiteLocale(env, siteId, code, { isDefault: b.is_default === true });
    const created = await refreshThemeTableI18n(env, siteId);
    await activity(env, user.id, "enable", "locale", code, { site: siteId, i18nTables: created });
    return ok({ ok: true, code, created_i18n_tables: created }, 201);
  }
  const localeMatch = path.match(/^i18n\/locales\/([A-Za-z0-9-]{2,10})$/);
  if (localeMatch) {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const code = localeMatch[1];
    if (method === "PATCH" || method === "PUT") {
      const b = await jsonBody(request);
      if (b.is_default === true) {
        try {
          await setSiteDefaultLocale(env, siteId, code);
        } catch (e: any) {
          return ok({ error: e?.message || "cannot set default locale" }, 400);
        }
      }
      await activity(env, user.id, "update", "locale", code, { site: siteId });
      return ok({ ok: true, default: await siteDefaultLocale(env, siteId) });
    }
    if (method === "DELETE") {
      try {
        await disableSiteLocale(env, siteId, code);
      } catch (e: any) {
        return ok({ error: e?.message || "cannot disable locale" }, 400);
      }
      await activity(env, user.id, "disable", "locale", code, { site: siteId });
      return ok({ ok: true, enabled: await siteLocaleCodes(env, siteId) });
    }
  }
  if (path === "i18n/dictionary" && method === "GET") {
    return ok({ items: await platformLocales(env), core: corePackLocales() });
  }
  if (path === "i18n/dictionary" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const code = String(b.code ?? "").trim();
    if (!isLocaleCode(code)) return ok({ error: `invalid locale code: ${code}` }, 400);
    await upsertPlatformLocale(env, {
      code,
      name: String(b.name ?? code),
      native_name: b.native_name ? String(b.native_name) : null,
      direction: b.direction === "rtl" ? "rtl" : "ltr",
      enabled: b.enabled === false ? 0 : 1,
      sort_order: Number(b.sort_order ?? 0),
    });
    return ok({ ok: true, code }, 201);
  }
  if (path === "i18n/ui-locale") {
    if (method === "GET") {
      const ui = await resolveUiLocale(env, siteId, {
        userLang: (user as any).ui_lang ?? null,
        defaultLocale: await siteDefaultLocale(env, siteId),
      });
      return ok({
        locale: ui,
        user_preference: (user as any).ui_lang ?? null,
        available: await availableUiLocales(env, siteId),
      });
    }
    if (method === "POST") {
      const b = await jsonBody(request);
      const wanted = String(b.locale ?? "").trim();
      if (!wanted) {
        await setUserUiLang(env, user.id, null);
        return ok({ ok: true, locale: null });
      }
      const available = await availableUiLocales(env, siteId);
      if (!available.includes(wanted)) {
        return ok({ error: `no interface pack for "${wanted}"`, available }, 400);
      }
      await setUserUiLang(env, user.id, wanted);
      return ok({ ok: true, locale: wanted });
    }
  }
  if (path === "i18n/messages" && method === "GET") {
    const available = await availableUiLocales(env, siteId);
    const wanted = String(url.searchParams.get("locale") ?? "").trim();
    const locale = wanted && available.includes(wanted)
      ? wanted
      : await resolveUiLocale(env, siteId, {
          userLang: (user as any).ui_lang ?? null,
          defaultLocale: await siteDefaultLocale(env, siteId),
        });
    const packs = await loadUiPacks(env, siteId, locale);
    return ok({ locale, available, ui_locales: await availableUiLocaleEntries(env, siteId), layers: packs.length, messages: mergePacks(packs) });
  }
  if (path === "i18n/overrides") {
    if (method === "GET") {
      const locale = String(url.searchParams.get("locale") ?? "").trim();
      try {
        const r = locale
          ? await env.DB.prepare("SELECT key,value FROM i18n_overrides WHERE site_id=? AND locale=? ORDER BY key").bind(siteId, locale).all()
          : await env.DB.prepare("SELECT locale,key,value FROM i18n_overrides WHERE site_id=? ORDER BY locale,key").bind(siteId).all();
        return ok({ items: (r.results as any[]) ?? [] });
      } catch {
        return ok({ items: [] });
      }
    }
    if (method === "POST") {
      if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
      const b = await jsonBody(request);
      const locale = String(b.locale ?? "").trim();
      const key = String(b.key ?? "").trim();
      if (!isLocaleCode(locale)) return ok({ error: "valid locale required" }, 400);
      if (!/^(core|theme|plugin)\.[a-z0-9_.-]+$/i.test(key)) {
        return ok({ error: "key must be namespaced core.* / theme.* / plugin.*" }, 400);
      }
      if (b.value === null || b.value === "") {
        await env.DB.prepare("DELETE FROM i18n_overrides WHERE site_id=? AND locale=? AND key=?")
          .bind(siteId, locale, key)
          .run();
        return ok({ ok: true, removed: true });
      }
      await env.DB.prepare(
        `INSERT INTO i18n_overrides(site_id,locale,key,value,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(site_id,locale,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
        .bind(siteId, locale, key, String(b.value), now())
        .run();
      return ok({ ok: true }, 201);
    }
  }
  if (path === "i18n/translations" && method === "GET") {
    const id = String(url.searchParams.get("id") ?? "").trim();
    if (!id) return ok({ error: "id required" }, 400);
    const group = await translationGroup(env, siteId, id);
    if (!group) return ok({ error: "not found" }, 404);
    return ok({ ...group, site: siteId });
  }
  if (path === "i18n/translations" && method === "POST") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const id = String(b.id ?? "").trim();
    const locale = String(b.locale ?? "").trim();
    const mode = String(b.mode ?? "blank") === "copy" ? "copy" : "blank";
    if (!id) return ok({ error: "id required" }, 400);
    if (!isLocaleCode(locale)) return ok({ error: "valid locale required" }, 400);
    if (!(await siteLocaleCodes(env, siteId)).includes(locale)) {
      return ok({ error: `locale "${locale}" is not enabled for this site` }, 400);
    }
    const source = await env.DB.prepare(
      "SELECT id, type, slug, status, lang_group FROM posts WHERE id=? AND site_id=? LIMIT 1"
    )
      .bind(id, siteId)
      .first<any>();
    if (!source) return ok({ error: "source post not found" }, 404);
    const group = groupOf(source);
    const already = await env.DB.prepare(
      `SELECT p.id FROM posts p JOIN post_translations t ON t.post_id=p.id
        WHERE p.site_id=? AND ${GROUP_SQL}=? AND t.locale=? LIMIT 1`
    )
      .bind(siteId, group, locale)
      .first<any>();
    if (already) return ok({ error: `a ${locale} version already exists`, post_id: already.id }, 409);

    const newId = `${source.type}_${await randomId()}`;
    const desired = String(b.slug ?? "").trim() || String(source.slug);
    const slugTaken = await env.DB.prepare(
      `SELECT p.id FROM posts p JOIN post_translations t ON t.post_id=p.id
        WHERE p.site_id=? AND p.type=? AND t.locale=? AND COALESCE(t.slug,p.slug)=? LIMIT 1`
    ).bind(siteId, String(source.type), locale, desired).first<any>();
    const slug = slugTaken ? await freeSlug(env, siteId, String(source.type), desired) : desired;
    const ts = now();
    await env.DB.prepare(
      "INSERT INTO posts(id,site_id,author_id,type,slug,status,lang_group,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
    )
      .bind(newId, siteId, user.id, String(source.type), slug, "draft", group, ts, ts)
      .run();
    let title = "";
    let excerpt = "";
    let content = "";
    if (mode === "copy") {
      const src = await env.DB.prepare(
        "SELECT title,excerpt,content FROM post_translations WHERE post_id=? LIMIT 1"
      )
        .bind(id)
        .first<any>();
      title = String(src?.title ?? "");
      excerpt = String(src?.excerpt ?? "");
      content = String(src?.content ?? "");
    }
    await env.DB.prepare(
      "INSERT INTO post_translations(id,post_id,locale,title,excerpt,content,slug,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
    )
      .bind(await randomId(), newId, locale, title, excerpt, content, slug, ts, ts)
      .run();
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "translate", String(source.type), newId, { from: id, locale, mode, site: siteId });
    return ok({ id: newId, locale, slug, mode, group }, 201);
  }

  return null;
}

async function dispatchThemeTableAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  // -- Extension-owned tables (L3) ----------------------------------------
  if ((path === "theme-tables" || path === "tables") && method === "GET") {
    const theme = await activeTheme(env, siteId).catch(() => null);
    const defs = await listOwnerTableDefs(env, siteId);
    const enabledPlugins = new Set(
      (await bootPluginRuntime(env).catch(() => [])).map((p) => p.name)
    );
    return ok({
      site: siteId,
      active_theme: theme?.name ?? null,
      items: defs.map((d) => ({
        ...d,
        active:
          d.owner_type === "theme"
            ? d.owner_name === theme?.name
            : enabledPlugins.has(d.owner_name),
      })),
    });
  }
  const ttMatch = path.match(/^(?:theme-tables|tables)\/([a-z][a-z0-9_]{0,63})$/);
  if (ttMatch) {
    const def = await resolveTableForSite(env, siteId, ttMatch[1]);
    if (!def) return ok({ error: `no table "${ttMatch[1]}" is declared for this site` }, 404);
    const locale = String(url.searchParams.get("locale") ?? "").trim() || (await siteDefaultLocale(env, siteId));
    if (method === "GET") {
      const agg = url.searchParams.get("aggregate");
      if (agg) {
        const result = await tableAggregate(env, def, {
          aggregate: agg,
          field: url.searchParams.get("field"),
          groupBy: url.searchParams.get("groupBy"),
          status: url.searchParams.get("status"),
        });
        if (!result) {
          return ok({ error: `cannot compute aggregate "${agg}" for table "${ttMatch[1]}"` }, 400);
        }
        return ok({ def, locale, ...result });
      }
      const items = await tableList(env, def, {
        locale,
        limit: Number(url.searchParams.get("limit") ?? 50),
        offset: Number(url.searchParams.get("offset") ?? 0),
        status: url.searchParams.get("status"),
      });
      return ok({ def, locale, items });
    }
    if (method === "POST" || method === "PUT") {
      if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
      const body = await jsonBody(request);
      try {
        const withSlug = body?.slug || method === "PUT" ? body : { ...body, slug: deriveSlug(def, body) };
        const row = await tableSave(env, def, withSlug, locale);
        return ok({ ok: true, locale, row }, 201);
      } catch (e: any) {
        return ok({ error: e?.message || "save failed" }, 400);
      }
    }
  }
  const ttRowMatch = path.match(/^(?:theme-tables|tables)\/([a-z][a-z0-9_]{0,63})\/([^/]+)$/);
  if (ttRowMatch) {
    const def = await resolveTableForSite(env, siteId, ttRowMatch[1]);
    if (!def) return ok({ error: `no table "${ttRowMatch[1]}" is declared for this site` }, 404);
    const locale = String(url.searchParams.get("locale") ?? "").trim() || (await siteDefaultLocale(env, siteId));
    const slug = decodeURIComponent(ttRowMatch[2]);
    if (method === "GET") {
      const row = await tableBySlug(env, def, slug, locale);
      return row ? ok({ def, locale, row }) : ok({ error: "not found" }, 404);
    }
    if (method === "PUT" || method === "POST") {
      if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
      const body = await jsonBody(request);
      try {
        const withSlug = { ...body, slug: body?.slug || slug };
        const row = await tableSave(env, def, withSlug, locale);
        return ok({ ok: true, locale, row });
      } catch (e: any) {
        return ok({ error: e?.message || "save failed" }, 400);
      }
    }
    if (method === "DELETE") {
      if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
      const row = await tableBySlug(env, def, slug, locale);
      if (!row) return ok({ error: "not found" }, 404);
      await tableDelete(env, def, String(row.id));
      return ok({ ok: true });
    }
  }

  return null;
}

async function dispatchDashboardAndBlockRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if ((path === "dashboard" || path === "stats") && method === "GET") {
    const mediaPolicy = await readMediaPolicy(env, siteId);
    const mediaOwner = mediaOwnerClause(mediaPolicy, user.id);
    const [posts, pages, media, drafts, published, recent] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND type='post'").bind(siteId).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND type='page'").bind(siteId).first<any>(),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM media_files WHERE site_id=?${mediaOwner.sql}`).bind(siteId, ...mediaOwner.binds).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND status='draft'").bind(siteId).first<any>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE site_id=? AND status='published'").bind(siteId).first<any>(),
      env.DB.prepare(
        `SELECT p.id, p.type, p.status, p.updated_at, t.locale, t.title
           FROM posts p LEFT JOIN post_translations t ON t.post_id = p.id
          WHERE p.site_id = ?
          ORDER BY p.updated_at DESC LIMIT 5`
      ).bind(siteId).all()
    ]);
    return ok({
      counts: {
        posts: Number(posts?.count ?? 0),
        pages: Number(pages?.count ?? 0),
        media: Number(media?.count ?? 0),
        drafts: Number(drafts?.count ?? 0),
        published: Number(published?.count ?? 0),
      },
      cards: await (async () => {
        const uiLocale = await resolveUiLocale(env, siteId, {
          userLang: (user as any).ui_lang ?? null,
          defaultLocale: await siteDefaultLocale(env, siteId),
        });
        const dict = mergePacks(await loadUiPacks(env, siteId, uiLocale));
        const label = (k: string, fb: string) => {
          const v = dict[`core.dashboard.${k}`];
          return typeof v === "string" && v ? v : fb;
        };
        const cards = [
          { key: "posts", label: label("posts", "Posts"), value: posts?.count ?? 0, note: `${published?.count ?? 0} ${label("published", "published")}` },
          { key: "pages", label: label("pages", "Pages"), value: pages?.count ?? 0 },
          { key: "media", label: label("media", "Media"), value: media?.count ?? 0 },
          { key: "drafts", label: label("drafts", "Drafts"), value: drafts?.count ?? 0, note: label("awaiting", "awaiting review") },
        ];
        try {
          const filtered = await applyFilters("dashboardCards", { env, siteId }, cards);
          return Array.isArray(filtered) ? filtered : cards;
        } catch {
          return cards;
        }
      })(),
      recent: recent?.results ?? [],
      site: siteId,
    });
  }

  if (path === "blocks" && method === "GET") {
    const available = await availableUiLocales(env, siteId);
    const wanted = String(url.searchParams.get("locale") ?? "").trim();
    const uiLocale = wanted && available.includes(wanted)
      ? wanted
      : await resolveUiLocale(env, siteId, {
          userLang: (user as any).ui_lang ?? null,
          defaultLocale: await siteDefaultLocale(env, siteId),
        });
    const dict = mergePacks(await loadUiPacks(env, siteId, uiLocale));
    const t = (key: string, fallback: string) => {
      const v = dict[key];
      return typeof v === "string" && v ? v : fallback;
    };
    const items = CORE_BLOCKS.map((b) => ({
      type: b.name,
      label: t(`core.block.${b.name.slice("core/".length)}`, b.title),
      category: b.category,
      children: b.children === true,
      attrs: b.attrs.map((a) => ({
        key: a.key,
        type: a.type,
        label: t(a.labelKey, a.fallback),
        required: a.required === true,
        ...(a.itemKeys ? { itemKeys: a.itemKeys } : {}),
      })),
    }));
    return ok({ items, site: siteId });
  }

  return null;
}

async function dispatchContentAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if (path === "posts" && method === "GET") return listPosts(env, url, "post", siteId);
  if (path === "pages" && method === "GET") return listPosts(env, url, "page", siteId);
  if (path === "posts" && method === "POST") return savePost(env, user.id, null, await jsonBody(request), "post", siteId);
  if (path === "pages" && method === "POST") return savePost(env, user.id, null, await jsonBody(request), "page", siteId);

  const contentMatch = path.match(/^content\/([a-z][a-z0-9_-]{0,63})$/);
  if (contentMatch && method === "GET") {
    const type = contentMatch[1];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    return listPosts(env, url, type, siteId);
  }
  if (contentMatch && method === "POST") {
    if(!(await requirePermission(env,user,"content.write",siteId))) return ok({error:"Forbidden"},403);
    const type = contentMatch[1];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    return savePost(env, user.id, null, await jsonBody(request), type, siteId);
  }
  const contentIdMatch = path.match(/^content\/([a-z][a-z0-9_-]{0,63})\/([^/]+)$/);
  if (contentIdMatch) {
    const type = contentIdMatch[1];
    const id = contentIdMatch[2];
    const pt = await findActivePostType(env, type, siteId);
    if (!pt) return ok({ error: "unknown post type" }, 404);
    if (method === "DELETE") {
      if(!(await requirePermission(env,user,"content.write",siteId))) return ok({error:"Forbidden"},403);
      return deletePost(env, user.id, id, siteId);
    }
    if (method === "PUT") {
      if(!(await requirePermission(env,user,"content.write",siteId))) return ok({error:"Forbidden"},403);
      return savePost(env, user.id, id, await jsonBody(request), type, siteId);
    }
    if (method === "GET") {
      if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
      const dflt = await defaultLocale(env, siteId);
      const [row, termRows] = await Promise.all([
        env.DB.prepare(`
          SELECT p.*, t.locale, t.title, t.excerpt, t.content, t.slug AS slug_own
          FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id
          WHERE p.id=? AND p.site_id=? ORDER BY CASE WHEN t.locale = ? THEN 0 ELSE 1 END, t.locale
        `).bind(id, siteId, dflt).all(),
        env.DB.prepare(
          "SELECT t.id, t.taxonomy, t.slug, t.name FROM terms t JOIN term_relationships r ON r.term_id=t.id WHERE r.post_id=? AND t.site_id=?"
        ).bind(id, siteId).all<any>().catch(() => ({ results: [] })),
      ]);
      const items = (row.results as any[]) ?? [];
      const metaRows = await postMetaRows(env, id);
      const terms = (termRows.results as any[]) ?? [];
      const categories = terms.filter((t: any) => t.taxonomy === "category" || t.taxonomy === "categories");
      const tags = terms.filter((t: any) => t.taxonomy === "tag" || t.taxonomy === "post_tag");
      const mapped = items.map((i) => ({ ...i, meta: resolveMetaByPost(metaRows, String(i.locale ?? ""), dflt).get(id) ?? {}, terms, categories, tags }));
      return ok({ items: mapped, item: mapped[0] ?? null, terms, categories, tags });
    }
  }

  const postMatch = path.match(/^(posts|pages)\/([^/]+)$/);
  if (postMatch) {
    const kind = postMatch[1] === "posts" ? "post" : "page";
    const id = postMatch[2];
    if (method === "DELETE") return deletePost(env, user.id, id, siteId);
    if (method === "PUT") return savePost(env, user.id, id, await jsonBody(request), kind, siteId);
    if (method === "GET") {
      if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
      const dflt = await defaultLocale(env, siteId);
      const [row, termRows] = await Promise.all([
        env.DB.prepare(`
          SELECT p.*, t.locale, t.title, t.excerpt, t.content, t.slug AS slug_own
          FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id
          WHERE p.id=? AND p.site_id=? ORDER BY CASE WHEN t.locale = ? THEN 0 ELSE 1 END, t.locale
        `).bind(id, siteId, dflt).all(),
        env.DB.prepare(
          "SELECT t.id, t.taxonomy, t.slug, t.name FROM terms t JOIN term_relationships r ON r.term_id=t.id WHERE r.post_id=? AND t.site_id=?"
        ).bind(id, siteId).all<any>().catch(() => ({ results: [] })),
      ]);
      const items = (row.results as any[]) ?? [];
      const metaRows = await postMetaRows(env, id);
      const terms = (termRows.results as any[]) ?? [];
      const categories = terms.filter((t: any) => t.taxonomy === "category" || t.taxonomy === "categories");
      const tags = terms.filter((t: any) => t.taxonomy === "tag" || t.taxonomy === "post_tag");
      const mapped = items.map((i) => ({ ...i, meta: resolveMetaByPost(metaRows, String(i.locale ?? ""), dflt).get(id) ?? {}, terms, categories, tags }));
      return ok({ items: mapped, item: mapped[0] ?? null, terms, categories, tags });
    }
  }

  const revm = path.match(/^(posts|pages)\/([^/]+)\/revisions$/);
  if (revm && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("SELECT r.* FROM post_revisions r JOIN posts p ON p.id=r.post_id WHERE r.post_id=? AND p.site_id=? ORDER BY r.locale,r.version DESC LIMIT 200").bind(revm[2],siteId).all();
    return ok({ items: r.results });
  }
  if (revm && method === "POST") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
    const owned = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND site_id=? LIMIT 1").bind(revm[2], siteId).first<any>();
    if (!owned) return ok({ error: "not found" }, 404);
    const b = await jsonBody(request);
    const v = await createRevision(env, revm[2], user.id, await resolveContentLocale(env, siteId, b.locale), String(b.title || ""), String(b.excerpt || ""), typeof b.content === "string" ? b.content : JSON.stringify(b.content || []));
    return ok({ version: v }, 201);
  }

  const am = path.match(/^(posts|pages)\/([^/]+)\/autosave$/);
  if (am && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const locale = await resolveContentLocale(env, siteId, url.searchParams.get("locale"));
    const r = await env.DB.prepare("SELECT a.* FROM post_autosaves a JOIN posts p ON p.id=a.post_id WHERE a.post_id=? AND p.site_id=? AND a.user_id=? AND a.locale=?").bind(am[2], siteId, user.id, locale).first();
    return ok({ item: r || null });
  }
  if (am && method === "POST") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
    const owned = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND site_id=? LIMIT 1").bind(am[2], siteId).first<any>();
    if (!owned) return ok({ error: "not found" }, 404);
    const b = await jsonBody(request);
    await autosave(env, am[2], user.id, await resolveContentLocale(env, siteId, b.locale), b);
    return ok({ ok: true, updated_at: now() });
  }

  const restore = path.match(/^(posts|pages)\/([^/]+)\/revisions\/([^/]+)\/restore$/);
  if (restore && method === "POST") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("SELECT r.* FROM post_revisions r JOIN posts p ON p.id=r.post_id WHERE r.id=? AND r.post_id=? AND p.site_id=?").bind(restore[3], restore[2], siteId).first<any>();
    if (!r) return ok({ error: "revision not found" }, 404);
    return savePost(env, user.id, restore[2], { locale: r.locale, title: r.title, excerpt: r.excerpt, content: r.content }, restore[1] === "posts" ? "post" : "page", siteId);
  }

  if (path === "search" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim();
    const locale = await resolveContentLocale(env, siteId, url.searchParams.get("locale"));
    if (!q) return ok({ items: [] });
    const r = await env.DB.prepare(`SELECT p.id,p.type,COALESCE(t.slug,p.slug) AS slug,p.status,t.locale,t.title,t.excerpt FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.status='published' AND t.locale=? AND (t.title LIKE ? OR t.excerpt LIKE ? OR t.content LIKE ?) ORDER BY p.updated_at DESC LIMIT 50`).bind(siteId, locale, `%${q}%`, `%${q}%`, `%${q}%`).all();
    return ok({ items: r.results });
  }

  return null;
}

async function dispatchTaxonomyAndTermRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  // 1. Taxonomies list
  if (path === "taxonomies" && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("SELECT * FROM taxonomies WHERE site_id=? AND active=1 ORDER BY name").bind(siteId).all<any>();
    let items = (r.results as any[]) ?? [];
    if (items.length === 0) {
      items = [
        { name: "category", site_id: siteId, label: "Categories", post_types: "[\"post\"]", hierarchical: 1, active: 1 },
        { name: "post_tag", site_id: siteId, label: "Tags", post_types: "[\"post\"]", hierarchical: 0, active: 1 },
      ];
    }
    return ok({ site: siteId, items });
  }

  // 2. Terms list: GET taxonomies/:tax/terms, GET terms, or GET tags
  const taxTermsMatch = path.match(/^taxonomies\/([a-z0-9_-]+)\/terms$/);
  if ((taxTermsMatch || path === "terms" || path === "tags") && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const taxonomy = taxTermsMatch ? taxTermsMatch[1] : (path === "tags" ? "tag" : (url.searchParams.get("taxonomy") || "category"));
    const isTagTax = taxonomy === "tag" || taxonomy === "post_tag";
    let query = isTagTax
      ? "SELECT id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, declared_by_theme, created_at, updated_at FROM terms WHERE site_id=? AND (taxonomy='tag' OR taxonomy='post_tag')"
      : "SELECT id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, declared_by_theme, created_at, updated_at FROM terms WHERE site_id=? AND taxonomy=?";
    const params: any[] = isTagTax ? [siteId] : [siteId, taxonomy];
    const reqLocale = (url.searchParams.get("locale") || "").trim();
    if (reqLocale) {
      query += " AND (locale='' OR locale=?)";
      params.push(reqLocale);
    }
    query += " ORDER BY name";
    const r = await env.DB.prepare(query).bind(...params).all<any>();
    return ok({ site: siteId, taxonomy, items: r.results ?? [] });
  }

  // 3. Create term: POST taxonomies/:tax/terms, POST terms, or POST tags
  if ((taxTermsMatch || path === "terms" || path === "tags") && method === "POST") {
    if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const taxonomy = taxTermsMatch ? taxTermsMatch[1] : (path === "tags" ? "tag" : String(b.taxonomy || "category"));
    const name = String(b.name || "").trim();
    if (!name) return ok({ error: "name is required" }, 400);
    const id = "term_" + await randomId();
    const rawSlug = String(b.slug || name).toLowerCase().trim();
    const slug = rawSlug.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || id;
    const desc = b.description ? String(b.description) : null;
    const parentId = b.parent_id ? String(b.parent_id) : null;
    const termLocale = String(b.locale ?? "").trim();
    const langGroup = String(b.lang_group || b.translation_of || "").trim() || id;
    const ts = now();
    try {
      await env.DB.prepare(
        "INSERT INTO terms(id, site_id, taxonomy, slug, name, description, parent_id, count, locale, lang_group, created_at, updated_at) VALUES(?,?,?,?,?,?,?,0,?,?,?,?)"
      ).bind(id, siteId, taxonomy, slug, name, desc, parentId, termLocale, langGroup, ts, ts).run();
      await bumpContentCache(env, siteId);
      await activity(env, user.id, "create", "term", id, { taxonomy, name, slug, siteId, locale: termLocale });
      return ok({ ok: true, item: { id, site_id: siteId, taxonomy, slug, name, description: desc, parent_id: parentId, count: 0, locale: termLocale, lang_group: langGroup } }, 201);
    } catch (e: any) {
      return ok({ error: e?.message || "term already exists" }, 400);
    }
  }

  // 4. Single term: GET/PUT/DELETE taxonomies/:tax/terms/:id, terms/:id, or tags/:id
  const termItemMatch = path.match(/^(?:taxonomies\/[a-z0-9_-]+\/terms|terms|tags)\/([^/]+)$/);
  if (termItemMatch) {
    const termId = decodeURIComponent(termItemMatch[1]);
    if (method === "GET") {
      if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
      const row = await env.DB.prepare("SELECT * FROM terms WHERE site_id=? AND (id=? OR slug=?) LIMIT 1")
        .bind(siteId, termId, termId).first<any>();
      if (!row) return ok({ error: "term not found" }, 404);
      return ok({ item: row });
    }
    if (method === "PUT" || method === "PATCH") {
      if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
      const b = await jsonBody(request);
      const row = await env.DB.prepare("SELECT * FROM terms WHERE site_id=? AND (id=? OR slug=?) LIMIT 1")
        .bind(siteId, termId, termId).first<any>();
      if (!row) return ok({ error: "term not found" }, 404);
      const newName = b.name !== undefined ? String(b.name).trim() : row.name;
      const newSlug = b.slug !== undefined ? String(b.slug).trim() : row.slug;
      const newDesc = b.description !== undefined ? String(b.description) : row.description;
      const newParent = b.parent_id !== undefined ? (b.parent_id ? String(b.parent_id) : null) : row.parent_id;
      const newLocale = b.locale !== undefined ? String(b.locale).trim() : (row.locale ?? "");
      const newLangGroup = b.lang_group !== undefined ? String(b.lang_group).trim() : (row.lang_group ?? row.id);
      const ts = now();
      await env.DB.prepare(
        "UPDATE terms SET name=?, slug=?, description=?, parent_id=?, locale=?, lang_group=?, updated_at=? WHERE id=? AND site_id=?"
      ).bind(newName, newSlug, newDesc, newParent, newLocale, newLangGroup, ts, row.id, siteId).run();
      await bumpContentCache(env, siteId);
      await activity(env, user.id, "update", "term", row.id, { name: newName, slug: newSlug });
      return ok({ ok: true, item: { ...row, name: newName, slug: newSlug, description: newDesc, parent_id: newParent, locale: newLocale, lang_group: newLangGroup, updated_at: ts } });
    }
    if (method === "DELETE") {
      if (!(await requirePermission(env, user, "content.write", siteId))) return ok({ error: "Forbidden" }, 403);
      const row = await env.DB.prepare("SELECT id FROM terms WHERE site_id=? AND (id=? OR slug=?) LIMIT 1")
        .bind(siteId, termId, termId).first<any>();
      if (!row) return ok({ error: "term not found" }, 404);
      await env.DB.prepare("DELETE FROM term_relationships WHERE term_id=?").bind(row.id).run().catch(() => {});
      await env.DB.prepare("DELETE FROM terms WHERE id=? AND site_id=?").bind(row.id, siteId).run();
      await bumpContentCache(env, siteId);
      await activity(env, user.id, "delete", "term", row.id);
      return ok({ ok: true });
    }
  }

  return null;
}

async function dispatchMediaAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if (path === "media" && method === "GET") return mediaList(env, url, siteId, user.id);
  if ((path === "media" || path === "media/upload") && method === "POST") {
    if (!(await requirePermission(env, user, "media.write", siteId))) return ok({ error: "Forbidden" }, 403);
    return mediaUpload(env, user.id, request, siteId);
  }
  const mediaItem = path.match(/^media\/([^/]+)$/);
  if (mediaItem && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const key = decodeURIComponent(mediaItem[1]);
    const row = await env.DB.prepare("SELECT * FROM media_files WHERE site_id=? AND (id=? OR file_name=? OR r2_key=?) LIMIT 1")
      .bind(siteId, key, key, key).first<any>();
    if (!row) return ok({ error: "media not found" }, 404);
    return ok({ item: row });
  }
  if (mediaItem && (method === "PATCH" || method === "PUT")) {
    if (!(await requirePermission(env, user, "media.write", siteId))) return ok({ error: "Forbidden" }, 403);
    return mediaUpdate(env, user.id, decodeURIComponent(mediaItem[1]), await jsonBody(request), siteId);
  }
  if (mediaItem && method === "DELETE") {
    if (!(await requirePermission(env, user, "media.write", siteId))) return ok({ error: "Forbidden" }, 403);
    return mediaDelete(env, user.id, decodeURIComponent(mediaItem[1]), siteId);
  }

  return null;
}

async function dispatchSettingsAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if (path === "settings" && method === "GET") return settings(env, siteId);
  if (path === "settings" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return saveSetting(env, user.id, await jsonBody(request), siteId);
  }
  if (path === "seed-demo" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    return seedDemoContent(env, siteId, user.id, { key: b?.key ? String(b.key) : undefined, locale: b?.locale ? String(b.locale) : undefined });
  }
  if (path === "platform-settings" && method === "GET") {
    if (!(await requirePermission(env, user, "platform.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return platformSettingsList(env);
  }
  if (path === "platform-settings" && method === "POST") {
    if (!(await requirePermission(env, user, "platform.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return savePlatformSetting(env, user, request);
  }

  if (path === "features" && method === "GET") return features(env, siteId);
  if (path === "features" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return saveFeature(env, user.id, await jsonBody(request), siteId);
  }

  return null;
}

const CORE_WIDGET_TYPES = new Set(["text", "html", "recent-posts", "menu", "search", "categories", "tag-cloud", "tags"]);

async function isWidgetTypeAllowed(siteId: string, env: Env, type: string): Promise<boolean> {
  const norm = type.replace(/^core\./, "");
  if (CORE_WIDGET_TYPES.has(norm)) return true;
  if (type.startsWith("custom.")) {
    const row = await env.DB.prepare("SELECT id FROM custom_widget_types WHERE site_id=? AND type=?").bind(siteId, type).first<any>();
    return !!row;
  }
  if (type.startsWith("theme.") || type.startsWith("plugin.")) return true;
  return false;
}

async function normaliseWidgetConfig(siteId: string, env: Env, type: string, cfg: unknown): Promise<Record<string, unknown>> {
  const c = (cfg && typeof cfg === "object" && !Array.isArray(cfg)) ? cfg as Record<string, unknown> : {};
  const norm = type.replace(/^core\./, "");
  if (norm === "text" || norm === "html") return { body: String(c.body ?? "") };
  if (norm === "recent-posts") {
    const n = Math.round(Number(c.count ?? 5));
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new Error("recent-posts count must be 1-20");
    return { count: n };
  }
  if (norm === "menu") {
    const menuId = String(c.menu_id ?? "");
    if (!menuId) throw new Error("menu widget needs menu_id");
    const m = await env.DB.prepare("SELECT id FROM menus WHERE site_id=? AND id=?").bind(siteId, menuId).first<any>();
    if (!m) throw new Error("menu_id does not exist on this site");
    return { menu_id: menuId };
  }
  if (norm === "search") {
    return { title: String(c.title ?? ""), placeholder: String(c.placeholder ?? "Search...") };
  }
  if (norm === "categories") {
    return { title: String(c.title ?? ""), show_count: c.show_count ? 1 : 0 };
  }
  if (norm === "tag-cloud" || norm === "tags") {
    const count = Math.min(100, Math.max(1, Math.round(Number(c.count ?? 30))));
    const taxonomy = String(c.taxonomy ?? "tag").trim() || "tag";
    const order_by = String(c.order_by ?? "count") === "name" ? "name" : "count";
    return { title: String(c.title ?? ""), count, taxonomy, order_by };
  }
  return c;
}

async function dispatchNavAndWidgetRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  const resourceMatch = path.match(/^(locales|redirects|rewrites|plugins|themes|menus|menu_items)$/);
  if (resourceMatch && method === "GET") return genericTable(env, resourceMatch[1], url, siteId);

  if (path === "menus" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM menus WHERE site_id=? ORDER BY name").bind(siteId).all();
    return ok({ items: rows.results, site: siteId });
  }
  if (path === "menus" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const id = b.id || `menu_${await randomId()}`;
    await env.DB.prepare(
      "INSERT INTO menus (id,site_id,name,location,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET name=excluded.name,location=excluded.location,updated_at=excluded.updated_at"
    ).bind(id, siteId, String(b.name || "Menu"), b.location || "header", now(), now()).run();
    return ok({ id, site: siteId }, 201);
  }
  const mm = path.match(/^menus\/([^/]+)\/items$/);
  if (mm && method === "GET") {
    const r = await env.DB.prepare("SELECT * FROM menu_items WHERE site_id=? AND menu_id=? ORDER BY sort_order,id").bind(siteId, mm[1]).all();
    return ok({ items: r.results, site: siteId });
  }
  if (mm && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const id = await randomId();
    await env.DB.prepare("INSERT INTO menu_items (id,site_id,menu_id,parent_id,title,url,target,sort_order,locale,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id, siteId, mm[1], b.parent_id || null, String(b.title || ""), String(b.url || "#"), b.target || null, Number(b.sort_order || 0), b.locale || null, now(), now()).run();
    return ok({ id, site: siteId }, 201);
  }
  if (mm && method === "PUT") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    if (!Array.isArray(b.order)) return ok({ error: "order array required" }, 400);
    const ids = (b.order as unknown[]).map(String);
    const rows = await env.DB.prepare("SELECT id FROM menu_items WHERE site_id=? AND menu_id=?").bind(siteId, mm[1]).all();
    const known = new Set(((rows.results as any[]) ?? []).map(r => String(r.id)));
    if (ids.some(id => !known.has(id))) return ok({ error: "unknown item in order" }, 400);
    let n = 0;
    for (const id of ids) {
      await env.DB.prepare("UPDATE menu_items SET sort_order=?,updated_at=? WHERE site_id=? AND menu_id=? AND id=?").bind(n++, now(), siteId, mm[1], id).run();
    }
    await activity(env, user.id, "update", "menu_items", mm[1], { count: ids.length });
    return ok({ ok: true, count: ids.length });
  }
  const mdm = path.match(/^menus\/([^/]+)$/);
  if (mdm && method === "PUT") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const location = String(b.location || "").trim();
    if (!location) return ok({ error: "location required" }, 400);
    const r = await env.DB.prepare("UPDATE menus SET name=?,location=?,updated_at=? WHERE site_id=? AND id=?").bind(String(b.name || "Menu"), location, now(), siteId, mdm[1]).run();
    if (!r.meta.changes) return ok({ error: "menu not found" }, 404);
    await activity(env, user.id, "update", "menu", mdm[1]);
    return ok({ ok: true });
  }
  if (mdm && method === "DELETE") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    await env.DB.prepare("DELETE FROM menu_items WHERE site_id=? AND menu_id=?").bind(siteId, mdm[1]).run();
    const r = await env.DB.prepare("DELETE FROM menus WHERE site_id=? AND id=?").bind(siteId, mdm[1]).run();
    if (!r.meta.changes) return ok({ error: "menu not found" }, 404);
    await activity(env, user.id, "delete", "menu", mdm[1]);
    return ok({ ok: true });
  }
  const mim = path.match(/^menu_items\/([^/]+)$/);
  if (mim && method === "PUT") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const cur = await env.DB.prepare("SELECT id,menu_id,parent_id,title,url,target,locale FROM menu_items WHERE site_id=? AND id=?").bind(siteId, mim[1]).first<any>();
    if (!cur) return ok({ error: "item not found" }, 404);
    let parentId: string | null;
    if (b.parent_id === undefined) { parentId = cur.parent_id ?? null; }
    else {
      parentId = b.parent_id ? String(b.parent_id) : null;
      if (parentId) {
        if (parentId === mim[1]) return ok({ error: "item cannot be its own parent" }, 400);
        const p = await env.DB.prepare("SELECT parent_id FROM menu_items WHERE site_id=? AND menu_id=? AND id=?").bind(siteId, cur.menu_id, parentId).first<any>();
        if (!p) return ok({ error: "parent not in the same menu" }, 400);
        if (p.parent_id) return ok({ error: "nesting beyond one level is not supported" }, 400);
      }
    }
    await env.DB.prepare("UPDATE menu_items SET title=?,url=?,target=?,locale=?,parent_id=?,updated_at=? WHERE site_id=? AND id=?")
      .bind(b.title === undefined ? String(cur.title ?? "") : String(b.title), b.url === undefined ? String(cur.url ?? "#") : String(b.url), b.target === undefined ? (cur.target ?? null) : (b.target || null), b.locale === undefined ? (cur.locale ?? null) : (b.locale || null), parentId, now(), siteId, mim[1]).run();
    await activity(env, user.id, "update", "menu_item", mim[1]);
    return ok({ ok: true });
  }
  if (mim && method === "DELETE") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("DELETE FROM menu_items WHERE site_id=? AND id=?").bind(siteId, mim[1]).run();
    if (!r.meta.changes) return ok({ error: "item not found" }, 404);
    await env.DB.prepare("UPDATE menu_items SET parent_id=NULL WHERE site_id=? AND parent_id=?").bind(siteId, mim[1]).run();
    await activity(env, user.id, "delete", "menu_item", mim[1]);
    return ok({ ok: true });
  }

  // -- widgets ----------------------------------------------------------------
  if (path === "widgets/types" && method === "GET") {
    // 1. Core widget types
    const coreItems = [
      {
        type: "core.text",
        name: "Text",
        title: "Text",
        description: "Arbitrary text with auto-paragraphs",
        icon: "file-text",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "body", label: "Content", type: "textarea", required: true },
        ],
      },
      {
        type: "core.html",
        name: "Custom HTML",
        title: "Custom HTML",
        description: "Raw HTML / embed code",
        icon: "puzzle",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "body", label: "HTML Code", type: "textarea", required: true },
        ],
      },
      {
        type: "core.recent-posts",
        name: "Recent Posts",
        title: "Recent Posts",
        description: "List of recently published posts",
        icon: "layers",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "count", label: "Number of Posts", type: "number", default: 5, min: 1, max: 20 },
        ],
      },
      {
        type: "core.menu",
        name: "Navigation Menu",
        title: "Navigation Menu",
        description: "Display a site navigation menu",
        icon: "menu",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "menu_id", label: "Select Menu", type: "select", options: "menus", required: true },
        ],
      },
      {
        type: "core.search",
        name: "Search Bar",
        title: "Search Bar",
        description: "Interactive search box for site contents",
        icon: "search",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "placeholder", label: "Placeholder Text", type: "text", default: "Search..." },
        ],
      },
      {
        type: "core.categories",
        name: "Categories",
        title: "Categories",
        description: "List of post categories and archives",
        icon: "folder",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "show_count", label: "Show Post Count", type: "boolean", default: true },
        ],
      },
      {
        type: "core.tag-cloud",
        name: "Tag Cloud",
        title: "Tag Cloud",
        description: "Display popular tags or taxonomy terms as a cloud",
        icon: "tag",
        category: "core",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "taxonomy", label: "Taxonomy", type: "text", default: "tag" },
          { name: "count", label: "Number of Tags", type: "number", default: 30, min: 1, max: 100 },
          {
            name: "order_by",
            label: "Order By",
            type: "select",
            options: [
              { value: "count", label: "Popularity (Post count)" },
              { value: "name", label: "Name (Alphabetical)" },
            ],
            default: "count",
          },
        ],
      },
    ];

    // 2. Theme types (from active theme blocks or declared widgets)
    const themeItems: any[] = [];
    try {
      const themeBlocks = await env.DB.prepare(
        "SELECT * FROM theme_blocks WHERE site_id=? ORDER BY name"
      ).bind(siteId).all();
      for (const tb of (themeBlocks.results as any[]) ?? []) {
        themeItems.push({
          type: `theme.${tb.name}`,
          name: tb.title || tb.name,
          title: tb.title || tb.name,
          description: `Theme block template: ${tb.name}`,
          icon: "palette",
          category: "theme",
          fields: [{ name: "title", label: "Title", type: "text" }],
        });
      }
    } catch {}

    // 3. Plugin types (e.g. adinsert, etc.)
    const pluginItems: any[] = [
      {
        type: "plugin.adinsert",
        name: "Ad Inserter Block",
        title: "Ad Inserter Block",
        description: "Insert a managed ad block into widget sidebar",
        icon: "layers",
        category: "plugin",
        fields: [
          { name: "title", label: "Title", type: "text" },
          { name: "block_no", label: "Ad Block Number (1-16)", type: "number", default: 1, min: 1, max: 16 },
        ],
      },
    ];

    // 4. Custom types (from custom_widget_types for this site)
    const customItems: any[] = [];
    try {
      const customs = await env.DB.prepare(
        "SELECT * FROM custom_widget_types WHERE site_id=? ORDER BY created_at DESC"
      ).bind(siteId).all();
      for (const row of (customs.results as any[]) ?? []) {
        let fields: any[] = [];
        try { fields = JSON.parse(String(row.schema_json || "[]")); } catch {}
        customItems.push({
          id: row.id,
          type: row.type,
          name: row.name,
          title: row.name,
          description: row.description || "",
          icon: row.icon || "puzzle",
          category: "custom",
          template: row.template || "",
          schema_json: row.schema_json || "[]",
          fields: Array.isArray(fields) && fields.length ? fields : [{ name: "title", label: "Title", type: "text" }],
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      }
    } catch {}

    return ok({
      site: siteId,
      items: [...coreItems, ...themeItems, ...pluginItems, ...customItems],
    });
  }

  // Custom widget types CRUD
  if (path === "widgets/custom-types" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const name = String(b.name || "").trim();
    if (!name) return ok({ error: "Widget name is required" }, 400);

    let rawType = String(b.type || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!rawType) rawType = `custom_${await randomId().then((s) => s.slice(0, 6))}`;
    const type = rawType.startsWith("custom.") ? rawType : `custom.${rawType.replace(/^custom_/, "")}`;

    const description = String(b.description || "").trim();
    const iconName = String(b.icon || "puzzle").trim();
    const template = String(b.template || "").trim();
    const schema_json = typeof b.schema_json === "string" ? b.schema_json : JSON.stringify(b.fields || []);

    const existing = await env.DB.prepare("SELECT id FROM custom_widget_types WHERE site_id=? AND type=?").bind(siteId, type).first<any>();
    if (existing) return ok({ error: `Widget type '${type}' already exists` }, 409);

    const ts = now();
    const id = `cwt_${await randomId()}`;
    await env.DB.prepare(
      "INSERT INTO custom_widget_types (id, site_id, type, name, description, icon, template, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, siteId, type, name, description, iconName, template, schema_json, ts, ts).run();

    await bumpContentCache(env, siteId);
    await activity(env, user.id, "create", "custom_widget_type", id);
    return ok({ ok: true, id, type, site: siteId }, 201);
  }

  const cwtMatch = path.match(/^widgets\/custom-types\/([^/]+)$/);
  if (cwtMatch && (method === "PUT" || method === "POST")) {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const cur = await env.DB.prepare("SELECT * FROM custom_widget_types WHERE site_id=? AND id=?").bind(siteId, cwtMatch[1]).first<any>();
    if (!cur) return ok({ error: "Custom widget type not found" }, 404);

    const b = await jsonBody(request);
    const name = b.name !== undefined ? String(b.name).trim() : cur.name;
    const description = b.description !== undefined ? String(b.description).trim() : cur.description;
    const iconName = b.icon !== undefined ? String(b.icon).trim() : cur.icon;
    const template = b.template !== undefined ? String(b.template) : cur.template;
    const schema_json = b.schema_json !== undefined
      ? (typeof b.schema_json === "string" ? b.schema_json : JSON.stringify(b.schema_json))
      : (b.fields !== undefined ? JSON.stringify(b.fields) : cur.schema_json);

    const ts = now();
    await env.DB.prepare(
      "UPDATE custom_widget_types SET name=?, description=?, icon=?, template=?, schema_json=?, updated_at=? WHERE site_id=? AND id=?"
    ).bind(name, description, iconName, template, schema_json, ts, siteId, cwtMatch[1]).run();

    await bumpContentCache(env, siteId);
    await activity(env, user.id, "update", "custom_widget_type", cwtMatch[1]);
    return ok({ ok: true, site: siteId });
  }

  if (cwtMatch && method === "DELETE") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const cur = await env.DB.prepare("SELECT * FROM custom_widget_types WHERE site_id=? AND id=?").bind(siteId, cwtMatch[1]).first<any>();
    if (!cur) return ok({ error: "Custom widget type not found" }, 404);

    await env.DB.prepare("DELETE FROM custom_widget_types WHERE site_id=? AND id=?").bind(siteId, cwtMatch[1]).run();
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "delete", "custom_widget_type", cwtMatch[1]);
    return ok({ ok: true, site: siteId });
  }

  if (path === "widgets" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM widget_instances WHERE site_id=? ORDER BY sidebar,sort_order,id").bind(siteId).all();
    return ok({ items: rows.results, site: siteId });
  }
  if (path === "widgets" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const type = String(b.widget_type || "text");
    if (!(await isWidgetTypeAllowed(siteId, env, type))) return ok({ error: `unknown or disallowed widget_type: ${type}` }, 400);
    let cfg: Record<string, unknown>;
    try { cfg = await normaliseWidgetConfig(siteId, env, type, b.config); } catch (e: any) { return ok({ error: e?.message || "invalid config" }, 400); }
    const id = await randomId();
    const sidebar = String(b.sidebar || "sidebar");
    let sortOrder: number;
    if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== "" && !isNaN(Number(b.sort_order))) {
      sortOrder = Number(b.sort_order);
    } else {
      const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM widget_instances WHERE site_id=? AND sidebar=?")
        .bind(siteId, sidebar).first<any>();
      sortOrder = Number(maxRow?.max_order ?? 0) + 10;
    }
    await env.DB.prepare("INSERT INTO widget_instances (id,site_id,sidebar,widget_type,title,config,sort_order,enabled,locale) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, siteId, sidebar, type, String(b.title || ""), JSON.stringify(cfg), sortOrder, b.enabled === false ? 0 : 1, String(b.locale || "")).run();
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "create", "widget", id);
    return ok({ id, site: siteId, sort_order: sortOrder }, 201);
  }
  const wim = path.match(/^widgets\/([^/]+)$/);
  if (wim && method === "PUT") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const cur = await env.DB.prepare("SELECT * FROM widget_instances WHERE site_id=? AND id=?").bind(siteId, wim[1]).first<any>();
    if (!cur) return ok({ error: "widget not found" }, 404);
    const b = await jsonBody(request);
    const type = String(b.widget_type || cur.widget_type);
    if (!(await isWidgetTypeAllowed(siteId, env, type))) return ok({ error: `unknown or disallowed widget_type: ${type}` }, 400);
    let cfg: Record<string, unknown>;
    try { cfg = await normaliseWidgetConfig(siteId, env, type, b.config === undefined ? JSON.parse(String(cur.config || "{}")) : b.config); } catch (e: any) { return ok({ error: e?.message || "invalid config" }, 400); }
    await env.DB.prepare("UPDATE widget_instances SET sidebar=?,widget_type=?,title=?,config=?,sort_order=?,enabled=?,locale=? WHERE site_id=? AND id=?")
      .bind(String(b.sidebar || cur.sidebar), type, b.title === undefined ? String(cur.title ?? "") : String(b.title), JSON.stringify(cfg), b.sort_order === undefined ? Number(cur.sort_order || 0) : Number(b.sort_order), b.enabled === undefined ? Number(cur.enabled ?? 1) : (b.enabled ? 1 : 0), b.locale === undefined ? String(cur.locale || "") : String(b.locale || ""), siteId, wim[1]).run();
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "update", "widget", wim[1]);
    return ok({ ok: true });
  }
  if (wim && method === "DELETE") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("DELETE FROM widget_instances WHERE site_id=? AND id=?").bind(siteId, wim[1]).run();
    if (!r.meta.changes) return ok({ error: "widget not found" }, 404);
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "delete", "widget", wim[1]);
    return ok({ ok: true });
  }

  return null;
}

async function dispatchExtensionAdminRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string,
  url: URL
): Promise<Response | null> {
  if (path === "extensions/bootstrap" && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    await seedBundledExtensions(env);
    return ok({ ok: true });
  }
  if (path === "extensions/plugins" && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const rows = await env.DB.prepare("SELECT * FROM plugin_installs ORDER BY title").all();
    const runtime = await pluginRuntimeStatus(env).catch(() => []);
    const wired = Object.fromEntries(runtime.map(r => [r.name, r.hooks]));
    return ok({ items: ((rows.results as any[]) ?? []).map(r => {
      let m: any = {};
      try { m = JSON.parse(String(r.manifest || "{}")); } catch {}
      return {
        ...r,
        manifest: m,
        adminPages: Array.isArray(m.adminPages) ? m.adminPages : [],
        channels: Array.isArray(m.channels) ? m.channels : [],
        hooks_wired: wired[r.name] ?? []
      };
    }) });
  }
  const pm = path.match(/^extensions\/plugins\/([^/]+)\/(enable|disable|toggle)$/);
  if (pm && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const pluginName = pm[1];
    let action = pm[2];
    if (action === "toggle") {
      const cur = await env.DB.prepare("SELECT enabled FROM plugin_installs WHERE name=? LIMIT 1").bind(pluginName).first<any>();
      action = cur?.enabled ? "disable" : "enable";
    }
    await env.DB.prepare("UPDATE plugin_installs SET enabled=?,updated_at=? WHERE name=?").bind(action === "enable" ? 1 : 0, now(), pluginName).run();
    if (action === "disable") {
      await clearPluginMenus(env, pluginName);
    }
    resetPluginRuntime();
    await bootPluginRuntime(env);
    await activity(env, user.id, action, "plugin", pluginName);
    return ok({ ok: true, action, enabled: action === "enable" ? 1 : 0 });
  }
  if (path === "extensions/themes" && method === "GET") {
    if (!(await requireSiteAccess(env, user, siteId))) return ok({ error: "Forbidden" }, 403);
    const rows = await env.DB.prepare("SELECT * FROM theme_installs ORDER BY title").all();
    const active = await env.DB.prepare("SELECT site_id,value FROM settings WHERE key='theme.active'").all();
    const fullBySite = Object.fromEntries(((active.results as any[]) ?? []).map(r => [r.site_id, r.value]));
    const allowedSites = await accessibleSiteIds(env, user);
    const bySite = allowedSites === null ? fullBySite
      : Object.fromEntries(Object.entries(fullBySite).filter(([sid]) => (allowedSites as string[]).includes(String(sid))));
    const activeForSite = bySite[siteId] ?? "";
    return ok({
      items: ((rows.results as any[]) ?? []).map(r => ({
        ...r,
        active: r.name === activeForSite ? 1 : 0,
        bundled:(BUNDLED_THEMES as readonly string[]).includes(String(r.name))?1:0,
      })),
      active: activeForSite,
      active_by_site: bySite,
      site: siteId,
    });
  }
  const tm = path.match(/^extensions\/themes\/([^/]+)\/activate$/);
  if (tm && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const target = tm[1];
    const row = await env.DB.prepare("SELECT name,version,manifest FROM theme_installs WHERE name=? LIMIT 1").bind(target).first<any>();
    if (!row) return ok({ error: "theme not found" }, 404);
    let manifest: any;
    try { manifest = JSON.parse(String(row.manifest || "{}")); } catch { manifest = { name: target, version: row.version }; }

    const previousRow = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key='theme.active'").bind(siteId).first<any>();
    const previous = previousRow?.value ? String(previousRow.value) : null;
    if (previous && previous !== target) {
      await clearThemeCapabilities(env, previous, siteId);
      invalidateThemeWorker(env, previous);
    }
    await env.DB.prepare("INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value")
      .bind(`theme-active-${siteId}`, siteId, "theme.active", target).run();
    invalidateThemeWorker(env, target);
    await env.DB.prepare("UPDATE theme_installs SET active=0").run();
    await env.DB.prepare("UPDATE theme_installs SET active=1, updated_at=? WHERE name IN (SELECT value FROM settings WHERE key='theme.active')").bind(now()).run();

    const applied = await applyThemeCapabilities(env, target, manifest, siteId);
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "activate", "theme", target, { previous, siteId, ...applied });
    return ok({ ok: true, theme: target, site: siteId, previous, applied });
  }

  const td = path.match(/^extensions\/themes\/([^/]+)$/);
  if (td && method === "DELETE") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return uninstallTheme(env, user.id, decodeURIComponent(td[1]), url.searchParams.get("force") === "1");
  }

  const tfl = path.match(/^extensions\/themes\/([^/]+)\/files$/);
  if (tfl && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const res = await listThemeFiles(env, decodeURIComponent(tfl[1])).catch((e) => ({ error: e.message }));
    if ("error" in res) return ok({ error: res.error }, 400);
    return ok(res);
  }

  const tfile = path.match(/^extensions\/themes\/([^/]+)\/file$/);
  if (tfile && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const rel = url.searchParams.get("path") || "";
    const res = await readThemeFile(env, decodeURIComponent(tfile[1]), rel).catch((e) => ({ error: e.message }));
    if ("error" in res) return ok({ error: res.error }, 400);
    return ok(res);
  }
  if (tfile && method === "PUT") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const body = await jsonBody(request);
    const target = decodeURIComponent(tfile[1]);
    const res = await writeThemeFile(env, target, String(body.path || ""), String(body.content ?? "")).catch((e) => ({ error: e.message }));
    if ("error" in res) return ok({ error: res.error }, 400);
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "update_theme_file", "theme", target, { path: body.path });
    return ok(res);
  }
  if (tfile && method === "DELETE") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const rel = url.searchParams.get("path") || "";
    const target = decodeURIComponent(tfile[1]);
    const res = await deleteThemeFile(env, target, rel).catch((e) => ({ error: e.message }));
    if ("error" in res) return ok({ error: res.error }, 400);
    await bumpContentCache(env, siteId);
    await activity(env, user.id, "delete_theme_file", "theme", target, { path: rel });
    return ok(res);
  }

  const tcopy = path.match(/^extensions\/themes\/([^/]+)\/copy$/);
  if (tcopy && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const body = await jsonBody(request);
    const src = decodeURIComponent(tcopy[1]);
    const res = await copyTheme(env, src, String(body.name || ""), String(body.title || ""), user.id).catch((e) => ({ error: e.message }));
    if ("error" in res) return ok({ error: res.error }, 400);
    await activity(env, user.id, "copy", "theme", res.name, { from: src });
    return ok(res, 201);
  }

  const texp = path.match(/^extensions\/themes\/([^/]+)\/export$/);
  if (texp && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const target = decodeURIComponent(texp[1]);
    try {
      const zipBytes = await exportThemeZip(env, target);
      return new Response(zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(target)}.zip"`,
          "Cache-Control": "private, max-age=0",
        },
      });
    } catch (e: any) {
      return ok({ error: e.message || "Export failed" }, 400);
    }
  }

  if (path === "theme/post-types" && method === "GET") return ok({ items: await listPostTypes(env, siteId), site: siteId });
  if (path === "theme/templates" && method === "GET") {
    const t = await activeTheme(env, siteId).catch(() => null);
    const themeName = t?.name || "default";
    let templates: string[] = [];
    if (Array.isArray(t?.manifest?.templates) && t.manifest.templates.length > 0) {
      templates = [...t.manifest.templates];
    } else {
      const filesRes = await listThemeFiles(env, themeName).catch(() => ({ files: [] }));
      const files = "files" in filesRes ? filesRes.files : [];
      templates = files
        .filter((f: any) => f.path.startsWith("templates/") && !f.path.startsWith("templates/parts/") && f.path.endsWith(".html"))
        .map((f: any) => f.path.slice("templates/".length, -".html".length));
    }
    const unique = Array.from(new Set(templates)).sort();
    return ok({ items: unique, theme: themeName, site: siteId });
  }
  if (path === "theme/menu-locations" && method === "GET") {
    const t = await activeTheme(env, siteId).catch(() => null);
    const locs = t?.manifest?.menuLocations?.length ? t.manifest.menuLocations : [{ id: "header" }];
    const themeName = t?.name || "ctblog";
    const themeTitle = t?.manifest?.title || themeName;
    return ok({ items: locs, site: siteId, theme: themeName, themeTitle });
  }
  if (path === "theme/seed-menus" && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const t = await activeTheme(env, siteId).catch(() => null);
    const themeName = t?.name || "ctblog";
    const b = (await jsonBody(request).catch(() => ({}))) as any;
    const targetTheme = String(b.theme || themeName);

    if (targetTheme === "ctblog") {
      const createdIds: string[] = [];
      for (const m of CTBLOG_MENUS) {
        const menuId = `ctblog_${m.id}_${siteId}`;
        createdIds.push(menuId);
        await env.DB.prepare(
          "INSERT INTO menus (id,site_id,name,location,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET name=excluded.name,location=excluded.location,updated_at=excluded.updated_at"
        ).bind(menuId, siteId, m.name, m.location, now(), now()).run();

        await env.DB.prepare("DELETE FROM menu_items WHERE site_id=? AND menu_id=?").bind(siteId, menuId).run();
        let mOrder = 0;
        for (const it of m.items) {
          const itemId = `${menuId}_${mOrder}`;
          await env.DB.prepare(
            "INSERT INTO menu_items (id,site_id,menu_id,parent_id,title,url,target,sort_order,locale,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
          ).bind(itemId, siteId, menuId, null, it.title, it.url, null, mOrder++, it.locale ?? "", now(), now()).run();
        }
      }

      await bumpContentCache(env, siteId);
      await activity(env, user.id, "create", "menus", createdIds[0] || "", { theme: "ctblog" });
      return ok({ ok: true, theme: "ctblog", created: createdIds, site: siteId });
    }

    return ok({ ok: true, theme: targetTheme, created: [], site: siteId });
  }
  if (path === "theme/sidebars" && method === "GET") {
    const t = await activeTheme(env, siteId).catch(() => null);
    const declaredAreas = t?.manifest?.widgets?.areas?.map((a: any) => ({ id: a.id, label: a.label || a.name || a.id }));
    const sbs = t?.manifest?.sidebars?.length ? t.manifest.sidebars : (declaredAreas?.length ? declaredAreas : [{ id: "sidebar" }, { id: "footer" }]);
    return ok({ items: sbs, site: siteId });
  }
  if (path === "theme/routes" && method === "GET") return ok({ items: await listRoutes(env, siteId), site: siteId });
  if (path === "theme/menus" && method === "GET") return ok({ items: await listThemeAdminMenus(env, siteId), site: siteId });

  if (path === "admin-menus" && method === "GET") {
    const memo = new Map<string, boolean>();
    const canView = async (capability: string) => {
      if (memo.has(capability)) return memo.get(capability)!;
      const allowed = await can(env, user, capability, siteId).catch(() => false);
      memo.set(capability, allowed);
      return allowed;
    };
    const curTheme = await activeTheme(env, siteId).catch(() => null);
    const groups = await listAdminMenuGroups(env, siteId, { can: canView, activeTheme: curTheme?.name });
    const uiLocale = await resolveUiLocale(env, siteId, {
      userLang: (user as any).ui_lang ?? null,
      defaultLocale: await siteDefaultLocale(env, siteId),
    });
    const dict = mergePacks(await loadUiPacks(env, siteId, uiLocale)) as Record<string, unknown>;
    const translated = groups.map(g => ({ ...g, items: g.items.map(m => {
      let label = m.label;
      if (m.label_key) {
        const v = dict[m.label_key];
        if (typeof v === "string" && v) label = v;
      }
      return { ...m, label };
    }) }));
    return ok({ site: siteId, ui_locale: uiLocale, groups: translated, items: translated.flatMap(g => g.items) });
  }
  if (path === "theme/blocks" && method === "GET") return ok({ items: await listThemeBlocks(env, siteId), site: siteId });
  if (path === "theme/fields" && method === "GET") return ok({ items: await listFieldDefs(env, siteId), site: siteId });
  if (path === "theme/taxonomies" && method === "GET") return ok({ items: await listTaxonomies(env, siteId), site: siteId });

  const tsm = path.match(/^theme\/([^/]+)\/settings$/);
  if (tsm && method === "GET") return ok({ items: await themeSettings(env, tsm[1]) });
  if (tsm && method === "POST") {
    if (!(await requirePermission(env, user, "settings.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const def = await env.DB.prepare("SELECT key FROM theme_setting_defs WHERE theme_name=? AND key=?").bind(tsm[1], String(b.key || "")).first<any>();
    if (!def) return ok({ error: "setting not declared" }, 400);
    await env.DB.prepare("INSERT INTO theme_settings(theme_name,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(theme_name,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(tsm[1], String(b.key), String(b.value ?? ""), now()).run();
    await activity(env, user.id, "update", "theme_setting", tsm[1], { key: b.key });
    return ok({ ok: true });
  }
  const psm = path.match(/^extensions\/plugins\/([^/]+)\/settings$/);
  if (psm && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return pluginSettings(env, psm[1]);
  }
  if (psm && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return savePluginSetting(env, user.id, psm[1], await jsonBody(request));
  }

  const uploadMatch = path.match(/^extensions\/(plugins|themes)\/upload$/);
  if (uploadMatch && method === "POST") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return uploadExtension(env, user.id, request, uploadMatch[1] === "plugins" ? "plugin" : "theme");
  }
  if (path === "extensions/versions" && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const type = url.searchParams.get("type");
    const name = url.searchParams.get("name");
    const r = type && name
      ? await env.DB.prepare("SELECT * FROM extension_versions WHERE extension_type=? AND extension_name=? ORDER BY installed_at DESC").bind(type, name).all()
      : await env.DB.prepare("SELECT * FROM extension_versions ORDER BY installed_at DESC LIMIT 200").all();
    return ok({ items: r.results });
  }
  const capm = path.match(/^extensions\/(plugins|themes)\/([^/]+)\/capabilities$/);
  if (capm && method === "GET") {
    if (!(await requirePermission(env, user, "extensions.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    return ok({ items: await capabilityList(env, capm[1] === "plugins" ? "plugin" : "theme", capm[2]) });
  }

  return null;
}

async function dispatchUserAndActivityRoutes(
  env: Env,
  request: Request,
  user: SessionUser,
  siteId: string,
  path: string,
  method: string
): Promise<Response | null> {
  if (path === "users" && method === "GET") {
    if (!(await requirePermission(env, user, "users.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const r = await env.DB.prepare("SELECT id,username,email,role,status,created_at,updated_at FROM site_users ORDER BY username").all();
    const rows = ((r.results as any[]) ?? []);
    const memberships = await env.DB.prepare("SELECT user_id, site_id, role FROM site_users_sites").all<any>();
    const byUser: Record<string, Record<string, string>> = {};
    for (const m of (memberships.results as any[]) ?? []) {
      (byUser[String(m.user_id)] ??= {})[String(m.site_id)] = String(m.role);
    }
    return ok({
      items: rows.map((u) => ({
        ...u,
        sites: byUser[String(u.id)] ?? {},
        role_here: byUser[String(u.id)]?.[siteId] ?? null,
      })),
      site: siteId,
    });
  }
  if (path === "users" && method === "POST") {
    if (!(await requirePermission(env, user, "users.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const b = await jsonBody(request);
    const role = String(b.role || "author");
    if (!SITE_ROLES.includes(role as any)) return ok({ error: "invalid role" }, 400);
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    if (!username || password.length < 8) return ok({ error: "username and password(min 8) required" }, 400);
    const { hashPassword } = await import("./shared/crypto");
    const id = "user_" + await randomId();
    const stmts = [
      env.DB.prepare("INSERT INTO site_users(id,username,email,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id, username, b.email || null, await hashPassword(password), role, "active", now(), now()),
      env.DB.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)")
        .bind(id, siteId, role, now()),
    ];
    await env.DB.batch(stmts);
    await activity(env, user.id, "create", "user", id, { username, role, site: siteId });
    return ok({ id }, 201);
  }
  const userSite = path.match(/^users\/([^/]+)\/sites\/([^/]+)$/);
  if (userSite && (method === "PUT" || method === "PATCH")) {
    if (!(await requirePermission(env, user, "users.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const targetUser = userSite[1];
    const targetSite = decodeURIComponent(userSite[2]);
    const b = await jsonBody(request);
    const role = b.role === null || b.role === "" ? null : String(b.role);
    if (role !== null && !SITE_ROLES.includes(role as any)) return ok({ error: "invalid role" }, 400);
    const exists = await env.DB.prepare("SELECT id FROM site_users WHERE id=?").bind(targetUser).first<any>();
    if (!exists) return ok({ error: "user not found" }, 404);
    if (role === null) {
      await env.DB.prepare("DELETE FROM site_users_sites WHERE user_id=? AND site_id=?").bind(targetUser, targetSite).run();
      await activity(env, user.id, "revoke", "user_site", targetUser, { site: targetSite });
      return ok({ ok: true, role: null });
    }
    await env.DB.prepare(
      "INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,site_id) DO UPDATE SET role=excluded.role"
    ).bind(targetUser, targetSite, role, now()).run();
    await activity(env, user.id, "grant", "user_site", targetUser, { site: targetSite, role });
    return ok({ ok: true, role });
  }

  if (path === "activity" && method === "GET") {
    if (!(await requirePermission(env, user, "platform.manage", siteId))) return ok({ error: "Forbidden" }, 403);
    const rows = await env.DB.prepare("SELECT * FROM admin_activity ORDER BY created_at DESC LIMIT 100").all();
    return ok({ items: rows.results });
  }

  return null;
}
