/**
 * Theme capability installation.
 *
 * When a theme is activated, its manifest declarations (post types, taxonomies,
 * fields, routes, admin menus, blocks, settings) are materialised into the
 * database. When it is deactivated, its declarations are marked inactive but
 * the *data* is preserved, so switching back restores everything.
 */
import { Env } from "../../shared/types";
import { now } from "../../shared/repo";
import { randomId } from "../../shared/crypto";
import { syncOwnerTables } from "./tables";
import { activeTheme } from "./runtime-declarative";
import { listSites } from "../../platform/sites";
import { registerOwnerMenus, clearOwnerMenus, listOwnerMenus } from "../../platform/admin-menus";
import type {
  ThemeManifest,
  ThemePostType,
  ThemeTaxonomy,
  ThemeField,
  ThemeRoute,
  ThemeAdminMenu,
  ThemeBlock,
  ThemeSettingDef,
} from "./runtime-declarative";

export interface ApplyResult {
  postTypes: number;
  taxonomies: number;
  fields: number;
  routes: number;
  adminMenus: number;
  blocks: number;
  settings: number;
  tables: number;
}

/**
 * Write a theme's declarations into the database, replacing anything it
 * declared previously. Runs inside the request that activates the theme.
 */
export async function applyThemeCapabilities(
  env: Env,
  themeName: string,
  manifest: ThemeManifest,
  siteId: string
): Promise<ApplyResult> {
  const ts = now();
  const result: ApplyResult = {
    postTypes: 0,
    taxonomies: 0,
    fields: 0,
    routes: 0,
    adminMenus: 0,
    blocks: 0,
    settings: 0,
    tables: 0,
  };

  // Re-declaring from the same theme is idempotent: clear its previous
  // declarations (but never touch rows declared by other themes).
  await clearThemeCapabilities(env, themeName, siteId);

  for (const pt of manifest.postTypes ?? []) {
    if (!validName(pt.name)) continue;
    await env.DB.prepare(
      `INSERT INTO post_types(name,site_id,label,singular_label,plural_label,supports,has_archive,rewrite_slug,declared_by_theme,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         label=excluded.label, singular_label=excluded.singular_label, plural_label=excluded.plural_label,
         supports=excluded.supports, has_archive=excluded.has_archive, rewrite_slug=excluded.rewrite_slug,
         declared_by_theme=excluded.declared_by_theme, active=1, updated_at=excluded.updated_at`
    )
      .bind(
        pt.name,
        siteId,
        pt.label ?? pt.labels?.plural ?? pt.name,
        pt.labels?.singular ?? pt.label ?? pt.name,
        pt.labels?.plural ?? pt.label ?? pt.name,
        JSON.stringify(pt.supports ?? ["title", "editor"]),
        pt.hasArchive ? 1 : 0,
        pt.rewrite?.slug ?? null,
        themeName,
        ts,
        ts
      )
      .run();
    result.postTypes++;
  }

  for (const tax of manifest.taxonomies ?? []) {
    if (!validName(tax.name)) continue;
    await env.DB.prepare(
      `INSERT INTO taxonomies(name,site_id,label,post_types,hierarchical,declared_by_theme,active,created_at,updated_at)
       VALUES(?,?,?,?,?,?,1,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         label=excluded.label, post_types=excluded.post_types, hierarchical=excluded.hierarchical,
         declared_by_theme=excluded.declared_by_theme, active=1, updated_at=excluded.updated_at`
    )
      .bind(tax.name, siteId, tax.label ?? tax.name, JSON.stringify(tax.postTypes ?? []), tax.hierarchical ? 1 : 0, themeName, ts, ts)
      .run();
    result.taxonomies++;
  }

  for (const f of manifest.fields ?? []) {
    if (!f.key || !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(f.key)) continue;
    await env.DB.prepare(
      `INSERT INTO field_defs(id,site_id,meta_key,label,field_type,post_types,required,default_value,sort_order,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,meta_key) DO UPDATE SET
         label=excluded.label, field_type=excluded.field_type, post_types=excluded.post_types,
         required=excluded.required, default_value=excluded.default_value,
         declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(
        scopedId("field", siteId, f.key),
        siteId,
        f.key,
        f.label ?? f.key,
        f.type ?? "text",
        JSON.stringify(f.postTypes ?? []),
        f.required ? 1 : 0,
        f.default === undefined ? null : JSON.stringify(f.default),
        result.fields,
        themeName,
        ts,
        ts
      )
      .run();
    result.fields++;
  }

  for (const r of manifest.routes ?? []) {
    if (!r.path || !r.template) continue;
    const normalised = r.path.startsWith("/") ? r.path : `/${r.path}`;
    await env.DB.prepare(
      `INSERT INTO theme_routes(id,site_id,path,template,title,query_json,resolve_json,sort_order,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,path) DO UPDATE SET
         template=excluded.template, title=excluded.title, query_json=excluded.query_json,
         resolve_json=excluded.resolve_json,
         sort_order=excluded.sort_order, declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(
        scopedId("route", siteId, r.path),
        siteId,
        normalised,
        r.template,
        r.title ?? null,
        JSON.stringify(r.query ?? {}),
        r.resolve ? JSON.stringify(r.resolve) : null,
        result.routes,
        themeName,
        ts,
        ts
      )
      .run();
    result.routes++;
  }

  // Admin menus now go into the shared registry (§4.4) rather than a
  // theme-only table, so a plugin's menus and a theme's menus are one list
  // with one renderer. `owner_type`/`owner_name` are what let the deactivation
  // path below remove exactly this theme's menus and nothing else.
  result.adminMenus = await registerOwnerMenus(
    env,
    siteId,
    "theme",
    themeName,
    (manifest.adminMenus ?? [])
      .filter((m) => m && m.id && m.screen)
      .map((m, i) => ({
        id: m.id,
        label: m.label ?? m.id,
        icon: m.icon ?? null,
        screen: m.screen,
        args: m.args ?? {},
        capability: m.capability ?? null,
        labelKey: m.label_key ?? null,
        // Declaration order *is* the menu order; the manifest has no explicit
        // sort field, and inventing one would let a theme claim a position
        // ahead of the platform's own items.
        sortOrder: i,
      }))
  );

  for (const b of manifest.blocks ?? []) {
    if (!b.name) continue;
    await env.DB.prepare(
      `INSERT INTO theme_blocks(id,site_id,name,title,template,declared_by_theme,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,name) DO UPDATE SET
         title=excluded.title, template=excluded.template, declared_by_theme=excluded.declared_by_theme, updated_at=excluded.updated_at`
    )
      .bind(scopedId("block", siteId, b.name), siteId, b.name, b.title ?? b.name, b.template ?? null, themeName, ts, ts)
      .run();
    result.blocks++;
  }

  for (const s of manifest.settings ?? []) {
    if (!s.key) continue;
    await env.DB.prepare(
      `INSERT INTO theme_setting_defs(theme_name,key,label,type,default_value,options)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(theme_name,key) DO UPDATE SET label=excluded.label, type=excluded.type, default_value=excluded.default_value, options=excluded.options`
    )
      .bind(themeName, s.key, s.label ?? s.key, s.type ?? "text", s.default === undefined ? null : String(s.default), Array.isArray(s.options) ? JSON.stringify(s.options) : null)
      .run();
    result.settings++;
  }

  // Theme-owned business tables (§2.5.2). The DDL is generated from the
  // declaration, never written by the theme; the `_i18n` companion is created
  // only when this site serves more than one language.
  const tables = await syncOwnerTables(env, "theme", themeName, manifest, siteId);
  result.tables = tables.length;

  await env.DB.prepare("UPDATE theme_installs SET manifest=?, updated_at=? WHERE name=?")
    .bind(JSON.stringify(manifest), ts, themeName)
    .run();

  return result;
}

/**
 * Mark everything a theme declared as inactive. Data rows (posts, terms,
 * meta) are deliberately left intact so reactivating restores the site.
 *
 * Theme-owned business tables (§2.5.2) are not in this list, and that is not an
 * oversight. Neither the generated tables nor their `theme_table_defs` rows are
 * touched: the rows are how the platform remembers which generated name a
 * logical name resolved to, and without them a re-activation would have to
 * guess. Switching a theme away hides its data; it never destroys it.
 */
export async function clearThemeCapabilities(
  env: Env,
  themeName: string,
  siteId: string
): Promise<void> {
  const ts = now();
  const statements = [
    env.DB.prepare("DELETE FROM post_types WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM taxonomies WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM field_defs WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM theme_routes WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
    env.DB.prepare("DELETE FROM theme_blocks WHERE site_id=? AND declared_by_theme=?").bind(siteId, themeName),
  ];
  for (const s of statements) await s.run().catch(() => {});
  // Menus live in the shared registry, so they are cleared through its API
  // rather than a raw DELETE — the ownership predicate stays in one place.
  await clearOwnerMenus(env, siteId, "theme", themeName);
  // Settings are per-theme; keep definitions but they simply stop being used.
  void ts;
}

/**
 * Install a theme's declared capabilities wherever it is the theme that
 * renders, when they are not installed yet.
 *
 * **Why a registry row is not an install.** `seedBundledExtensions`
 * (`extensions/plugin/runtime.ts`) upserts the `theme_installs` row for every
 * bundled theme, and that alone is enough to make one *render*: `activeTheme()`
 * falls back to `ORDER BY active DESC, installed_at ASC` and probes for a
 * loadable `index.html`. It is not enough to make one *own* anything.
 * Activation is a user action and a fresh install has none in it, so a
 * brand-new deployment served the bundled theme while the theme owned nothing:
 * `GET theme/fields` answered `{"items":[]}`, the editor therefore offered no
 * custom fields, and `savePost`'s `fieldExists` gate dropped every `meta` value
 * on the way in — HTTP 200, no error, nothing written. Measured on a fresh
 * production install: the demo content's `category`/`tags` came back `{}` and
 * every home page read "Uncategorised" in both languages.
 *
 * **Why it is chained from `index.ts` rather than done in the seeder.** Rule 4
 * forbids `plugin/` from importing `theme/`, so the seeding path cannot call
 * this itself. `index.ts` is the one module allowed to know both layers, and
 * it already owns the boot sequence.
 *
 * **Why the predicate is "owns nothing" and not a version stamp.** A stamp
 * records "theme X at version V was installed here", so it has to be
 * invalidated by *anything* that deletes capability rows. The test suites
 * delete exactly those rows on purpose (they share one local D1), and a stamp
 * would therefore refuse to repair the one state it exists to repair. Counting
 * rows costs a single query and self-heals.
 *
 * Runs on boot inside `ctx.waitUntil`, so the common case is written to be
 * free: one `listSites`, one `activeTheme`, one count per site.
 *
 * Known and accepted: a theme whose manifest declares *only* `settings[]` or
 * `tables[]` has nothing in the counted tables, so it re-runs this on every
 * boot. Every statement in `applyThemeCapabilities` is an upsert or a
 * `DELETE ... WHERE declared_by_theme=?`, so the repeat is idempotent; it is
 * noted here rather than hidden.
 */
export async function ensureThemeCapabilities(env: Env): Promise<number> {
  let installed = 0;
  for (const site of await listSites(env)) {
    try {
      const theme = await activeTheme(env, site.id);
      // A theme that declares none of the countable kinds owns nothing *by
      // design*, so asking whether it owns anything would be a question with
      // no wrong answer — and answering "no" every boot would re-install it
      // forever.
      const m = theme.manifest;
      const declares =
        (m.postTypes?.length ?? 0) +
        (m.taxonomies?.length ?? 0) +
        (m.fields?.length ?? 0) +
        (m.routes?.length ?? 0) +
        (m.blocks?.length ?? 0) +
        (m.adminMenus?.length ?? 0);
      if (!declares) continue;

      // One query, six sources — the five tables `clearThemeCapabilities`
      // deletes from, plus the menu registry it clears through its own API.
      // The predicate has to mirror the clear, or "installed" and "not
      // installed" would disagree about the same theme.
      const row = await env.DB.prepare(
        `SELECT (
           (SELECT COUNT(*) FROM post_types   WHERE site_id=? AND declared_by_theme=?) +
           (SELECT COUNT(*) FROM taxonomies   WHERE site_id=? AND declared_by_theme=?) +
           (SELECT COUNT(*) FROM field_defs   WHERE site_id=? AND declared_by_theme=?) +
           (SELECT COUNT(*) FROM theme_routes WHERE site_id=? AND declared_by_theme=?) +
           (SELECT COUNT(*) FROM theme_blocks WHERE site_id=? AND declared_by_theme=?) +
           (SELECT COUNT(*) FROM admin_menu_registry
              WHERE site_id=? AND owner_type='theme' AND owner_name=?)
         ) AS owned`
      )
        .bind(site.id, theme.name, site.id, theme.name, site.id, theme.name, site.id, theme.name, site.id, theme.name, site.id, theme.name)
        .first<any>();
      if (Number(row?.owned ?? 0) > 0) continue;

      await applyThemeCapabilities(env, theme.name, theme.manifest, site.id);
      installed++;
    } catch {
      // Boot must never be the thing that breaks a request. A repair that
      // cannot run leaves the install exactly as it was before this function
      // existed, which is a state the site already renders from.
    }
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Readers used by the API and the router
// ---------------------------------------------------------------------------

export interface PostTypeRow {
  name: string;
  label: string;
  singular_label: string | null;
  plural_label: string | null;
  supports: string[];
  has_archive: number;
  rewrite_slug: string | null;
}

export async function listPostTypes(env: Env, siteId: string): Promise<PostTypeRow[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM post_types WHERE site_id=? AND active=1 ORDER BY name"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      supports: safeJsonArray(row.supports),
    }));
  } catch {
    return [];
  }
}

/** Find a post type by its rewrite slug (used for front-end routing). */
export async function findPostTypeBySlug(
  env: Env,
  slug: string,
  siteId: string
): Promise<PostTypeRow | null> {
  const all = await listPostTypes(env, siteId);
  return all.find((pt) => (pt.rewrite_slug ?? pt.name) === slug) ?? null;
}

export async function listRoutes(env: Env, siteId: string) {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM theme_routes WHERE site_id=? ORDER BY sort_order"
    )
      .bind(siteId)
      .all();
    return (r.results as any[]) ?? [];
  } catch {
    return [];
  }
}

export interface TaxonomyRow {
  name: string;
  label: string;
  post_types: any[];
  hierarchical: number;
}

export async function listTaxonomies(env: Env, siteId: string): Promise<TaxonomyRow[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM taxonomies WHERE site_id=? AND active=1 ORDER BY name"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      post_types: safeJsonArray(row.post_types),
    }));
  } catch {
    return [];
  }
}

/**
 * The active theme's admin menus for one site.
 *
 * Reads the shared registry filtered to `owner_type='theme'`, which means the
 * result includes *every* theme that ever registered menus on this site — not
 * only the active one. That is intentional and matches the rest of the
 * capability model: deactivating a theme removes its declarations, so anything
 * still here belongs to a theme that is currently active.
 */
export async function listThemeAdminMenus(env: Env, siteId: string) {
  const rows = await listOwnerMenus(env, siteId, "theme", await activeThemeOwner(env, siteId));
  return rows;
}

/**
 * Which theme currently owns this site's menus.
 *
 * The registry is keyed by owner, so the reader needs the owner's name, and
 * the only correct source for it is the per-site `theme.active` setting —
 * `theme_installs.active` is a global flag and would pick the wrong theme on a
 * multi-site install (see AGENTS.md).
 */
async function activeThemeOwner(env: Env, siteId: string): Promise<string> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key='theme.active'")
      .bind(siteId)
      .first<any>();
    return String(row?.value ?? "");
  } catch {
    return "";
  }
}

export async function listThemeBlocks(env: Env, siteId: string) {
  try {
    const r = await env.DB.prepare("SELECT * FROM theme_blocks WHERE site_id=? ORDER BY name")
      .bind(siteId)
      .all();
    return (r.results as any[]) ?? [];
  } catch {
    return [];
  }
}

export async function listFieldDefs(env: Env, siteId: string) {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM field_defs WHERE site_id=? ORDER BY sort_order, meta_key"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map((row) => ({
      ...row,
      post_types: safeJsonArray(row.post_types),
    }));
  } catch {
    return [];
  }
}

/**
 * The stored `options` JSON (migration 0017) becomes a real array for the
 * settings form renderer; anything malformed degrades to "no choices" rather
 * than a broken select.
 */
export function parseSettingOptions(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export async function themeSettings(env: Env, themeName: string) {
  try {
    const defs = await env.DB.prepare(
      "SELECT * FROM theme_setting_defs WHERE theme_name=? ORDER BY key"
    )
      .bind(themeName)
      .all();
    const vals = await env.DB.prepare("SELECT key,value FROM theme_settings WHERE theme_name=?")
      .bind(themeName)
      .all();
    const map = Object.fromEntries(((vals.results as any[]) ?? []).map((v) => [v.key, v.value]));
    return ((defs.results as any[]) ?? []).map((d) => ({
      ...d,
      value: map[d.key] ?? d.default_value ?? "",
      options: parseSettingOptions(d.options),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validName(name: unknown): boolean {
  return typeof name === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(name);
}

/**
 * Primary keys in the declaration tables are global, but the natural key is
 * per-site. Two sites may declare the same meta key / route / menu id, so the
 * synthetic id must embed the site to avoid a cross-site UNIQUE collision.
 */
function scopedId(prefix: string, siteId: string, value: string): string {
  const safeSite = String(siteId).replace(/[^a-z0-9]+/gi, "_");
  const safeValue = String(value).replace(/[^a-z0-9]+/gi, "_");
  return `${prefix}_${safeSite}_${safeValue}`;
}

function safeJsonArray(v: unknown): any[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export { randomId };
