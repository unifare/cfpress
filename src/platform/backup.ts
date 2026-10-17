/**
 * Site Backup & Restore Subsystem for CFPress.
 *
 * Provides complete, tenant-isolated data export and restore for multi-lingual sites:
 * - Content: posts, pages, CPTs, post_translations, post_meta, revisions
 * - Structure: taxonomies, terms, hierarchical parent links, term_relationships
 * - Layout: menus, menu_items, widget_instances, custom_widget_types
 * - Settings: settings, site_locales, i18n_overrides, redirects, rewrites, seo_meta
 * - Media metadata: media_files registry
 * - Point-in-time auto-snapshots for 1-click rollback before any restoration.
 */

import { Env } from "../shared/types";
import { now } from "../shared/repo";
import { randomId } from "../shared/crypto";
import { bumpContentCache } from "../shared/cache";
import { resolveMetaByPost } from "./post-meta";

// Backup handles raw DB serialization for post_meta; runtime consumers use resolveMetaByPost.
export const _backupMetaRef = resolveMetaByPost;

export interface BackupSummary {
  posts: number;
  translations: number;
  post_meta: number;
  taxonomies: number;
  terms: number;
  term_relationships: number;
  settings: number;
  site_locales: number;
  menus: number;
  menu_items: number;
  widgets: number;
  media: number;
  redirects: number;
  rewrites: number;
}

export interface BackupEnvelope {
  generator: string;
  cfpress_version: string;
  format: "cfpress_backup_v1";
  exported_at: string;
  site_id: string;
  site_name: string;
  summary: BackupSummary;
  data: Record<string, any[]>;
}

export interface SnapshotRow {
  id: string;
  site_id: string;
  name: string;
  trigger_type: string;
  summary: BackupSummary;
  created_at: number;
}

/**
 * Exports all data for a specific site into a structured backup envelope.
 */
export async function exportSiteBackup(env: Env, siteId: string): Promise<BackupEnvelope> {
  const [
    siteRow,
    postsRes,
    transRes,
    metaRes,
    revRes,
    taxRes,
    termsRes,
    termRelRes,
    settingsRes,
    localesRes,
    i18nRes,
    menusRes,
    menuItemsRes,
    widgetsRes,
    custWidgetsRes,
    redirectsRes,
    rewritesRes,
    mediaRes,
    seoRes,
  ] = await Promise.all([
    env.DB.prepare("SELECT id, name, host, path_prefix FROM sites WHERE id=? LIMIT 1").bind(siteId).first<any>().catch(() => null),
    env.DB.prepare("SELECT id, author_id, author_member_id, type, slug, status, lang_group, template, created_at, updated_at FROM posts WHERE site_id=? ORDER BY created_at").bind(siteId).all<any>(),
    env.DB.prepare(`SELECT t.id, t.post_id, t.locale, t.title, t.excerpt, t.content, t.slug, t.created_at, t.updated_at
      FROM post_translations t JOIN posts p ON p.id=t.post_id WHERE p.site_id=? ORDER BY t.post_id, t.locale`).bind(siteId).all<any>(),
    env.DB.prepare(`SELECT m.post_id, m.meta_key, m.locale, m.meta_value
      FROM post_meta m JOIN posts p ON p.id=m.post_id WHERE p.site_id=?`).bind(siteId).all<any>(),
    env.DB.prepare(`SELECT r.id, r.post_id, r.author_id, r.locale, r.version, r.title, r.excerpt, r.content, r.created_at
      FROM post_revisions r JOIN posts p ON p.id=r.post_id WHERE p.site_id=?`).bind(siteId).all<any>(),
    env.DB.prepare("SELECT name, label, post_types, hierarchical, active FROM taxonomies WHERE site_id=? ORDER BY name").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, taxonomy, slug, name, description, locale, lang_group, parent_id, count, created_at, updated_at FROM terms WHERE site_id=? ORDER BY taxonomy, id").bind(siteId).all<any>(),
    env.DB.prepare(`SELECT r.post_id, r.term_id
      FROM term_relationships r JOIN terms t ON t.id=r.term_id WHERE t.site_id=?`).bind(siteId).all<any>(),
    env.DB.prepare("SELECT key, value, autoload FROM settings WHERE site_id=? ORDER BY key").bind(siteId).all<any>(),
    env.DB.prepare("SELECT code, is_default, enabled, sort_order FROM site_locales WHERE site_id=? ORDER BY sort_order").bind(siteId).all<any>(),
    env.DB.prepare("SELECT locale, key, value FROM i18n_overrides WHERE site_id=? ORDER BY locale, key").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, name, location, created_at, updated_at FROM menus WHERE site_id=? ORDER BY id").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, menu_id, parent_id, title, url, target, sort_order, locale, created_at, updated_at FROM menu_items WHERE site_id=? ORDER BY menu_id, sort_order").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, sidebar, widget_type, title, config, sort_order, enabled, locale FROM widget_instances WHERE site_id=? ORDER BY sidebar, sort_order").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, type, name, description, icon, template, schema_json, created_at, updated_at FROM custom_widget_types WHERE site_id=? ORDER BY type").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, source, target, status, created_at, updated_at FROM redirects WHERE site_id=? ORDER BY id").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, from_path, to_path, created_at, updated_at FROM rewrites WHERE site_id=? ORDER BY id").bind(siteId).all<any>(),
    env.DB.prepare("SELECT id, object_key, filename, mime_type, size, alt_text, title, width, height, storage, remote_url, remote_delete_url, uploaded_by, created_at FROM media_files WHERE site_id=? ORDER BY created_at").bind(siteId).all<any>(),
    env.DB.prepare(`SELECT s.id, s.entity_type, s.entity_id, s.locale, s.title, s.description, s.canonical, s.robots, s.og_image
      FROM seo_meta s JOIN posts p ON p.id=s.entity_id WHERE p.site_id=?`).bind(siteId).all<any>(),
  ]);

  const posts = (postsRes.results as any[]) ?? [];
  const post_translations = (transRes.results as any[]) ?? [];
  const post_meta = (metaRes.results as any[]) ?? [];
  const post_revisions = (revRes.results as any[]) ?? [];
  const taxonomies = (taxRes.results as any[]) ?? [];
  const terms = (termsRes.results as any[]) ?? [];
  const term_relationships = (termRelRes.results as any[]) ?? [];
  const settings = (settingsRes.results as any[]) ?? [];
  const site_locales = (localesRes.results as any[]) ?? [];
  const i18n_overrides = (i18nRes.results as any[]) ?? [];
  const menus = (menusRes.results as any[]) ?? [];
  const menu_items = (menuItemsRes.results as any[]) ?? [];
  const widget_instances = (widgetsRes.results as any[]) ?? [];
  const custom_widget_types = (custWidgetsRes.results as any[]) ?? [];
  const redirects = (redirectsRes.results as any[]) ?? [];
  const rewrites = (rewritesRes.results as any[]) ?? [];
  const media_files = (mediaRes.results as any[]) ?? [];
  const seo_meta = (seoRes.results as any[]) ?? [];

  const summary: BackupSummary = {
    posts: posts.length,
    translations: post_translations.length,
    post_meta: post_meta.length,
    taxonomies: taxonomies.length,
    terms: terms.length,
    term_relationships: term_relationships.length,
    settings: settings.length,
    site_locales: site_locales.length,
    menus: menus.length,
    menu_items: menu_items.length,
    widgets: widget_instances.length + custom_widget_types.length,
    media: media_files.length,
    redirects: redirects.length,
    rewrites: rewrites.length,
  };

  const data: Record<string, any[]> = {
    posts,
    post_translations,
    post_meta,
    post_revisions,
    taxonomies,
    terms,
    term_relationships,
    settings,
    site_locales,
    i18n_overrides,
    menus,
    menu_items,
    widget_instances,
    custom_widget_types,
    redirects,
    rewrites,
    media_files,
    seo_meta,
  };

  return {
    generator: "CFPress",
    cfpress_version: "0.8.0",
    format: "cfpress_backup_v1",
    exported_at: new Date().toISOString(),
    site_id: siteId,
    site_name: String(siteRow?.name || siteId),
    summary,
    data,
  };
}

/**
 * Pre-flight inspection of an incoming backup file against the active site.
 */
export async function inspectBackup(
  env: Env,
  siteId: string,
  payload: any
): Promise<{
  valid: boolean;
  error?: string;
  envelope?: Partial<BackupEnvelope>;
  site_id: string;
  source_site_id: string;
  source_site_name: string;
  exported_at: string;
  summary: BackupSummary;
  diff: {
    existing_posts_count: number;
    incoming_posts_count: number;
    existing_terms_count: number;
    incoming_terms_count: number;
  };
}> {
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Invalid backup JSON file: root must be an object", site_id: siteId, source_site_id: "", source_site_name: "", exported_at: "", summary: {} as any, diff: {} as any };
  }
  if (!payload.data || typeof payload.data !== "object") {
    return { valid: false, error: "Invalid backup JSON file: missing 'data' object", site_id: siteId, source_site_id: "", source_site_name: "", exported_at: "", summary: {} as any, diff: {} as any };
  }

  const [existPosts, existTerms] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM posts WHERE site_id=?").bind(siteId).first<any>().catch(() => ({ c: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS c FROM terms WHERE site_id=?").bind(siteId).first<any>().catch(() => ({ c: 0 })),
  ]);

  const data = payload.data || {};
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const terms = Array.isArray(data.terms) ? data.terms : [];

  const summary: BackupSummary = payload.summary || {
    posts: posts.length,
    translations: (data.post_translations || []).length,
    post_meta: (data.post_meta || []).length,
    taxonomies: (data.taxonomies || []).length,
    terms: terms.length,
    term_relationships: (data.term_relationships || []).length,
    settings: (data.settings || []).length,
    site_locales: (data.site_locales || []).length,
    menus: (data.menus || []).length,
    menu_items: (data.menu_items || []).length,
    widgets: (data.widget_instances || []).length,
    media: (data.media_files || []).length,
    redirects: (data.redirects || []).length,
    rewrites: (data.rewrites || []).length,
  };

  return {
    valid: true,
    site_id: siteId,
    source_site_id: String(payload.site_id || "unknown"),
    source_site_name: String(payload.site_name || payload.site_id || "CFPress Site"),
    exported_at: String(payload.exported_at || ""),
    summary,
    diff: {
      existing_posts_count: Number(existPosts?.c ?? 0),
      incoming_posts_count: posts.length,
      existing_terms_count: Number(existTerms?.c ?? 0),
      incoming_terms_count: terms.length,
    },
  };
}

/**
 * Restores a backup payload into the target site.
 */
export async function restoreSiteBackup(
  env: Env,
  siteId: string,
  payload: any,
  options: {
    mode?: "merge" | "clean";
    autoSnapshot?: boolean;
    name?: string;
  } = {}
): Promise<{ ok: boolean; mode: string; restored: BackupSummary; snapshot_id?: string }> {
  const inspection = await inspectBackup(env, siteId, payload);
  if (!inspection.valid) {
    throw new Error(inspection.error || "Invalid backup format");
  }

  const mode = options.mode === "clean" ? "clean" : "merge";

  let snapshotId: string | undefined;
  if (options.autoSnapshot !== false) {
    try {
      const snap = await createSnapshot(env, siteId, options.name || "还原前自动快照", "pre_restore");
      snapshotId = snap.id;
    } catch (e) {
      console.error("Auto snapshot creation warning:", e);
    }
  }

  const data = payload.data || {};

  // Clean mode: safely purge existing site data in reverse FK order
  if (mode === "clean") {
    await env.DB.prepare("DELETE FROM term_relationships WHERE term_id IN (SELECT id FROM terms WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM post_meta WHERE post_id IN (SELECT id FROM posts WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM post_translations WHERE post_id IN (SELECT id FROM posts WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM scheduled_posts WHERE post_id IN (SELECT id FROM posts WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM seo_meta WHERE entity_id IN (SELECT id FROM posts WHERE site_id=?)").bind(siteId).run().catch(() => {});
    await env.DB.prepare("DELETE FROM posts WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM terms WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM taxonomies WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM menu_items WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM menus WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM widget_instances WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM custom_widget_types WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM redirects WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM rewrites WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM i18n_overrides WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM settings WHERE site_id=?").bind(siteId).run();
    await env.DB.prepare("DELETE FROM site_locales WHERE site_id=?").bind(siteId).run();
  }

  const ts = now();

  // 1. Settings
  if (Array.isArray(data.settings)) {
    for (const s of data.settings) {
      if (!s.key) continue;
      await env.DB.prepare(`
        INSERT INTO settings (id, site_id, key, value, autoload) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(site_id, key) DO UPDATE SET value=excluded.value, autoload=excluded.autoload
      `).bind(await randomId(), siteId, String(s.key), s.value === null ? null : String(s.value), Number(s.autoload ?? 1)).run();
    }
  }

  // 2. Site Locales
  if (Array.isArray(data.site_locales)) {
    for (const l of data.site_locales) {
      const code = String(l.code || l.locale || "");
      if (!code) continue;
      await env.DB.prepare(`
        INSERT INTO site_locales (site_id, code, is_default, enabled, sort_order) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(site_id, code) DO UPDATE SET is_default=excluded.is_default, enabled=excluded.enabled, sort_order=excluded.sort_order
      `).bind(siteId, code, Number(l.is_default ?? 0), Number(l.enabled ?? 1), Number(l.sort_order ?? 0)).run();
    }
  }

  // 3. Taxonomies & Terms
  if (Array.isArray(data.taxonomies)) {
    for (const tax of data.taxonomies) {
      if (!tax.name) continue;
      await env.DB.prepare(`
        INSERT INTO taxonomies (name, site_id, label, post_types, hierarchical, active) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name, site_id) DO UPDATE SET label=excluded.label, post_types=excluded.post_types, hierarchical=excluded.hierarchical, active=excluded.active
      `).bind(String(tax.name), siteId, String(tax.label || tax.name), typeof tax.post_types === "string" ? tax.post_types : JSON.stringify(tax.post_types || ["post"]), Number(tax.hierarchical ?? 0), Number(tax.active ?? 1)).run();
    }
  }

  if (Array.isArray(data.terms)) {
    for (const tm of data.terms) {
      if (!tm.id) continue;
      await env.DB.prepare(`
        INSERT INTO terms (id, site_id, taxonomy, slug, name, description, locale, lang_group, parent_id, count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, taxonomy=excluded.taxonomy, slug=excluded.slug, name=excluded.name, description=excluded.description,
          locale=excluded.locale, lang_group=excluded.lang_group, parent_id=excluded.parent_id, count=excluded.count, updated_at=excluded.updated_at
      `).bind(
        String(tm.id), siteId, String(tm.taxonomy || "category"), String(tm.slug || tm.id), String(tm.name || ""),
        tm.description ? String(tm.description) : null, String(tm.locale ?? ""), tm.lang_group ? String(tm.lang_group) : String(tm.id),
        tm.parent_id ? String(tm.parent_id) : null, Number(tm.count ?? 0),
        Number(tm.created_at || ts), Number(tm.updated_at || ts)
      ).run();
    }
  }

  // 4. Posts & Pages
  if (Array.isArray(data.posts)) {
    for (const p of data.posts) {
      if (!p.id) continue;
      await env.DB.prepare(`
        INSERT INTO posts (id, site_id, author_id, author_member_id, type, slug, status, lang_group, template, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, author_id=excluded.author_id, author_member_id=excluded.author_member_id,
          type=excluded.type, slug=excluded.slug, status=excluded.status, lang_group=excluded.lang_group,
          template=excluded.template, updated_at=excluded.updated_at
      `).bind(
        String(p.id), siteId, String(p.author_id || ""), p.author_member_id ? String(p.author_member_id) : null,
        String(p.type || "post"), String(p.slug || p.id), String(p.status || "draft"),
        p.lang_group ? String(p.lang_group) : null, p.template ? String(p.template) : null,
        Number(p.created_at || ts), Number(p.updated_at || ts)
      ).run();
    }
  }

  // 5. Post Translations
  if (Array.isArray(data.post_translations)) {
    for (const pt of data.post_translations) {
      if (!pt.id || !pt.post_id) continue;
      await env.DB.prepare(`
        INSERT INTO post_translations (id, post_id, locale, title, excerpt, content, slug, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          post_id=excluded.post_id, locale=excluded.locale, title=excluded.title, excerpt=excluded.excerpt,
          content=excluded.content, slug=excluded.slug, updated_at=excluded.updated_at
      `).bind(
        String(pt.id), String(pt.post_id), String(pt.locale || ""), String(pt.title || ""),
        pt.excerpt ? String(pt.excerpt) : null, typeof pt.content === "string" ? pt.content : JSON.stringify(pt.content || []),
        pt.slug ? String(pt.slug) : null, Number(pt.created_at || ts), Number(pt.updated_at || ts)
      ).run();
    }
  }

  // 6. Post Meta
  if (Array.isArray(data.post_meta)) {
    for (const pm of data.post_meta) {
      if (!pm.post_id || !pm.meta_key) continue;
      await env.DB.prepare(`
        INSERT INTO post_meta (post_id, meta_key, locale, meta_value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(post_id, meta_key, locale) DO UPDATE SET meta_value=excluded.meta_value, updated_at=excluded.updated_at
      `).bind(String(pm.post_id), String(pm.meta_key), String(pm.locale || ""), pm.meta_value === null ? null : String(pm.meta_value), ts).run().catch(() => {});
    }
  }

  // 6b. Post Revisions
  if (Array.isArray(data.post_revisions)) {
    for (const pr of data.post_revisions) {
      if (!pr.id || !pr.post_id) continue;
      await env.DB.prepare(`
        INSERT INTO post_revisions (id, post_id, author_id, version, title, excerpt, content, locale, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, excerpt=excluded.excerpt, content=excluded.content
      `).bind(
        String(pr.id), String(pr.post_id), pr.author_id ? String(pr.author_id) : null, Number(pr.version || 1),
        pr.title ? String(pr.title) : null, pr.excerpt ? String(pr.excerpt) : null,
        typeof pr.content === "string" ? pr.content : JSON.stringify(pr.content || []),
        String(pr.locale || ""), Number(pr.created_at || ts)
      ).run().catch(() => {});
    }
  }

  // 7. Term Relationships
  if (Array.isArray(data.term_relationships)) {
    for (const tr of data.term_relationships) {
      if (!tr.post_id || !tr.term_id) continue;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO term_relationships (post_id, term_id) VALUES (?, ?)
      `).bind(String(tr.post_id), String(tr.term_id)).run().catch(() => {});
    }
  }

  // 8. Menus & Menu Items
  if (Array.isArray(data.menus)) {
    for (const m of data.menus) {
      if (!m.id) continue;
      await env.DB.prepare(`
        INSERT INTO menus (id, site_id, name, location, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET site_id=excluded.site_id, name=excluded.name, location=excluded.location, updated_at=excluded.updated_at
      `).bind(String(m.id), siteId, String(m.name || "Menu"), m.location ? String(m.location) : null, Number(m.created_at || ts), Number(m.updated_at || ts)).run();
    }
  }

  if (Array.isArray(data.menu_items)) {
    for (const mi of data.menu_items) {
      if (!mi.id || !mi.menu_id) continue;
      await env.DB.prepare(`
        INSERT INTO menu_items (id, site_id, menu_id, parent_id, title, url, target, sort_order, locale, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, menu_id=excluded.menu_id, parent_id=excluded.parent_id, title=excluded.title,
          url=excluded.url, target=excluded.target, sort_order=excluded.sort_order, locale=excluded.locale, updated_at=excluded.updated_at
      `).bind(
        String(mi.id), siteId, String(mi.menu_id), mi.parent_id ? String(mi.parent_id) : null,
        String(mi.title || ""), String(mi.url || "/"), mi.target ? String(mi.target) : null,
        Number(mi.sort_order ?? 0), mi.locale ? String(mi.locale) : null,
        Number(mi.created_at || ts), Number(mi.updated_at || ts)
      ).run();
    }
  }

  // 9. Widgets
  if (Array.isArray(data.widget_instances)) {
    for (const wi of data.widget_instances) {
      if (!wi.id) continue;
      await env.DB.prepare(`
        INSERT INTO widget_instances (id, site_id, sidebar, widget_type, title, config, sort_order, enabled, locale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, sidebar=excluded.sidebar, widget_type=excluded.widget_type,
          title=excluded.title, config=excluded.config, sort_order=excluded.sort_order,
          enabled=excluded.enabled, locale=excluded.locale
      `).bind(
        String(wi.id), siteId, String(wi.sidebar || "sidebar-1"),
        String(wi.widget_type || wi.type || "text"), String(wi.title || ""),
        wi.config ? (typeof wi.config === "string" ? wi.config : JSON.stringify(wi.config)) : "{}",
        Number(wi.sort_order ?? 0), Number(wi.enabled ?? 1), String(wi.locale ?? "")
      ).run();
    }
  }

  if (Array.isArray(data.custom_widget_types)) {
    for (const cwt of data.custom_widget_types) {
      if (!cwt.id || !cwt.type) continue;
      await env.DB.prepare(`
        INSERT INTO custom_widget_types (id, site_id, type, name, description, icon, template, schema_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, type=excluded.type, name=excluded.name, description=excluded.description,
          icon=excluded.icon, template=excluded.template, schema_json=excluded.schema_json, updated_at=excluded.updated_at
      `).bind(
        String(cwt.id), siteId, String(cwt.type), String(cwt.name || cwt.type),
        cwt.description ? String(cwt.description) : null, String(cwt.icon || "puzzle"),
        String(cwt.template || ""), typeof cwt.schema_json === "string" ? cwt.schema_json : JSON.stringify(cwt.schema_json || []),
        Number(cwt.created_at || ts), Number(cwt.updated_at || ts)
      ).run().catch(() => {});
    }
  }

  // 10. Redirects & Rewrites
  if (Array.isArray(data.redirects)) {
    for (const r of data.redirects) {
      const src = r.source || r.source_path;
      if (!r.id || !src) continue;
      await env.DB.prepare(`
        INSERT INTO redirects (id, site_id, source, target, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, source=excluded.source, target=excluded.target,
          status=excluded.status, updated_at=excluded.updated_at
      `).bind(String(r.id), siteId, String(src), String(r.target || r.target_path || "/"), Number(r.status || r.status_code || 301), Number(r.created_at || ts), Number(r.updated_at || ts)).run();
    }
  }

  if (Array.isArray(data.rewrites)) {
    for (const rw of data.rewrites) {
      const fromPath = rw.from_path || rw.source_pattern;
      if (!rw.id || !fromPath) continue;
      await env.DB.prepare(`
        INSERT INTO rewrites (id, site_id, from_path, to_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, from_path=excluded.from_path, to_path=excluded.to_path, updated_at=excluded.updated_at
      `).bind(String(rw.id), siteId, String(fromPath), String(rw.to_path || rw.target_pattern || "/"), Number(rw.created_at || ts), Number(rw.updated_at || ts)).run();
    }
  }

  // 11. Media files metadata
  if (Array.isArray(data.media_files)) {
    for (const mf of data.media_files) {
      if (!mf.id || !mf.object_key) continue;
      await env.DB.prepare(`
        INSERT INTO media_files (id, site_id, object_key, filename, mime_type, size, alt_text, title, width, height, storage, remote_url, remote_delete_url, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          site_id=excluded.site_id, object_key=excluded.object_key, filename=excluded.filename, mime_type=excluded.mime_type,
          size=excluded.size, alt_text=excluded.alt_text, title=excluded.title, width=excluded.width, height=excluded.height, storage=excluded.storage,
          remote_url=excluded.remote_url, remote_delete_url=excluded.remote_delete_url, uploaded_by=excluded.uploaded_by
      `).bind(
        String(mf.id), siteId, String(mf.object_key), String(mf.filename || "file"), String(mf.mime_type || "application/octet-stream"),
        Number(mf.size || 0), mf.alt_text ? String(mf.alt_text) : null, mf.title ? String(mf.title) : null,
        mf.width ? Number(mf.width) : null, mf.height ? Number(mf.height) : null,
        String(mf.storage || "r2"), mf.remote_url ? String(mf.remote_url) : null, mf.remote_delete_url ? String(mf.remote_delete_url) : null,
        mf.uploaded_by ? String(mf.uploaded_by) : null, Number(mf.created_at || ts)
      ).run();
    }
  }

  // 12. SEO Meta
  if (Array.isArray(data.seo_meta)) {
    for (const sm of data.seo_meta) {
      if (!sm.id || !sm.entity_id) continue;
      await env.DB.prepare(`
        INSERT INTO seo_meta (id, entity_type, entity_id, locale, title, description, canonical, robots, og_image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET
          title=excluded.title, description=excluded.description, canonical=excluded.canonical,
          robots=excluded.robots, og_image=excluded.og_image
      `).bind(
        String(sm.id), String(sm.entity_type || "post"), String(sm.entity_id), String(sm.locale || ""),
        sm.title ? String(sm.title) : null, sm.description ? String(sm.description) : null,
        sm.canonical ? String(sm.canonical) : null, sm.robots ? String(sm.robots) : null,
        sm.og_image ? String(sm.og_image) : null
      ).run().catch(() => {});
    }
  }

  // Invalidate cache
  await bumpContentCache(env, siteId);

  return {
    ok: true,
    mode,
    restored: inspection.summary,
    snapshot_id: snapshotId,
  };
}

/**
 * Creates a local point-in-time snapshot of the site.
 */
export async function createSnapshot(
  env: Env,
  siteId: string,
  name: string,
  triggerType: "pre_restore" | "manual" | "auto" = "manual"
): Promise<{ id: string; name: string; created_at: number; summary: BackupSummary }> {
  const backup = await exportSiteBackup(env, siteId);
  const id = `snap_${await randomId()}`;
  const ts = now();
  const summaryJson = JSON.stringify(backup.summary);
  const dataJson = JSON.stringify(backup);

  await env.DB.prepare(`
    INSERT INTO site_snapshots (id, site_id, name, trigger_type, summary, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, siteId, name, triggerType, summaryJson, dataJson, ts).run();

  // Prune snapshots beyond the newest 10 per site
  const oldRows = await env.DB.prepare(`
    SELECT id FROM site_snapshots WHERE site_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 10
  `).bind(siteId).all<any>().catch(() => ({ results: [] }));
  const oldIds = ((oldRows.results as any[]) ?? []).map((r) => r.id);
  if (oldIds.length) {
    const ph = oldIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM site_snapshots WHERE site_id=? AND id IN (${ph})`).bind(siteId, ...oldIds).run().catch(() => {});
  }

  return { id, name, created_at: ts, summary: backup.summary };
}

/**
 * Lists the available point-in-time snapshots for a site.
 */
export async function listSnapshots(env: Env, siteId: string): Promise<SnapshotRow[]> {
  const rows = await env.DB.prepare(`
    SELECT id, site_id, name, trigger_type, summary, created_at
    FROM site_snapshots
    WHERE site_id=?
    ORDER BY created_at DESC LIMIT 15
  `).bind(siteId).all<any>().catch(() => ({ results: [] }));

  return ((rows.results as any[]) ?? []).map((r) => {
    let summary: BackupSummary;
    try {
      summary = JSON.parse(r.summary);
    } catch {
      summary = {} as any;
    }
    return {
      id: r.id,
      site_id: r.site_id,
      name: r.name,
      trigger_type: r.trigger_type,
      summary,
      created_at: Number(r.created_at),
    };
  });
}

/**
 * Gets a snapshot's full data payload.
 */
export async function getSnapshot(env: Env, siteId: string, snapshotId: string): Promise<any | null> {
  const row = await env.DB.prepare(`
    SELECT data FROM site_snapshots WHERE id=? AND site_id=? LIMIT 1
  `).bind(snapshotId, siteId).first<any>().catch(() => null);

  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

/**
 * Deletes a snapshot.
 */
export async function deleteSnapshot(env: Env, siteId: string, snapshotId: string): Promise<boolean> {
  const res = await env.DB.prepare(`
    DELETE FROM site_snapshots WHERE id=? AND site_id=?
  `).bind(snapshotId, siteId).run().catch(() => null);
  return !!res?.meta?.changes;
}
