/**
 * Multi-site resolution.
 *
 * A CFPress install can host several sites from one Worker + one database.
 * A site is identified by an id (e.g. `default`, `shop`) and matched against
 * an incoming request in two ways, highest priority first:
 *
 *   1. `path_prefix`  — the URL starts with the prefix (`/shop/...`). Used
 *                        when one domain serves many sites under sub-paths.
 *   2. `host`         — the request host matches (`shop.example.com`).
 *   3. the default site (any request that matches nothing else).
 *
 * Every data-access function takes an explicit `siteId`; nothing in the
 * runtime may assume `"default"` any more. This module is the single place
 * that turns a `Request` into a `siteId`.
 */
import { Env } from "../shared/types";
import { seedSiteLocales } from "./i18n/locale-registry";

export const DEFAULT_SITE_ID = "default";

export interface SiteRecord {
  id: string;
  name: string;
  host: string | null;
  path_prefix: string | null;
  is_default: number;
  status: string;
}

export interface ResolvedSite {
  siteId: string;
  site: SiteRecord | null;
  /** Path with the matched prefix stripped, e.g. `/shop/blog/x` -> `/blog/x`. */
  path: string;
  /** Which rule matched — useful for debugging and tests. */
  matchedBy: "path_prefix" | "host" | "default";
}

/** Normalise a prefix to `/foo` (no trailing slash), or null when empty. */
function normalisePrefix(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s === "/") return null;
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  return withSlash.replace(/\/+$/, "") || null;
}

/** Case-insensitive host comparison; strips ports and a leading `www.`. */
export function normaliseHost(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");
}

/**
 * Load every active site. Cached per-request by the caller (see
 * `resolveSite`), because the router hits this on each request.
 */
export async function listSites(env: Env): Promise<SiteRecord[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT id,name,host,path_prefix,is_default,status FROM sites WHERE status='active'"
    ).all();
    const rows = ((r.results as any[]) ?? []).filter((s) => s && typeof s.id === "string");
    if (rows.length) return rows as SiteRecord[];
  } catch {
    /* `sites` table missing (pre-0008 database) — fall through. */
  }
  return [
    {
      id: DEFAULT_SITE_ID,
      name: "Default Site",
      host: null,
      path_prefix: null,
      is_default: 1,
      status: "active",
    },
  ];
}

/**
 * Resolve the site for a request.
 *
 * Pass a pre-loaded `sites` list to avoid a query when the caller already
 * has one (the router resolves once and reuses it inside one request).
 */
export async function resolveSite(
  env: Env,
  u: URL,
  sites?: SiteRecord[]
): Promise<ResolvedSite> {
  const all = sites ?? (await listSites(env));
  const path = u.pathname || "/";
  const host = normaliseHost(u.host);

  // 1. Longest matching path prefix wins, so `/shop/fr` beats `/shop`.
  let best: SiteRecord | null = null;
  let bestPrefix: string | null = null;
  for (const s of all) {
    const prefix = normalisePrefix(s.path_prefix);
    if (!prefix) continue;
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!bestPrefix || prefix.length > bestPrefix.length) {
        best = s;
        bestPrefix = prefix;
      }
    }
  }
  if (best && bestPrefix) {
    const stripped = path.slice(bestPrefix.length);
    return {
      siteId: best.id,
      site: best,
      path: stripped.startsWith("/") ? stripped : `/${stripped}`,
      matchedBy: "path_prefix",
    };
  }

  // 2. Host match.
  if (host) {
    const byHost = all.find((s) => {
      const h = normaliseHost(s.host);
      return h !== "" && h === host;
    });
    if (byHost) return { siteId: byHost.id, site: byHost, path, matchedBy: "host" };
  }

  // 3. Explicit default, else the first site.
  //
  // This is the ONE place a site fallback is legitimate (§10 rule 4): a request
  // has to belong to *some* site, and this function is where that choice is
  // made. Every other site/locale fallback in the codebase must resolve here
  // instead of inventing its own literal — the architecture test enforces that,
  // and this line is exempt only via the marker below, which is greppable on
  // purpose so the exemption stays visible and cannot spread silently.
  // ARCH-RULE-EXEMPT: site-default (see docs/ARCHITECTURE.md §10 rule 4)
  const fallback = all.find((s) => s.is_default === 1) ?? all[0] ?? null;
  return {
    siteId: fallback?.id ?? DEFAULT_SITE_ID,
    site: fallback,
    path,
    matchedBy: "default",
  };
}

/**
 * Lightweight per-request memo so a single request never issues the same
 * `sites` query twice.
 *
 * ⚠️ It has to be *dropped* per request — see `resetSiteListMemo`. Keying on
 * `env` alone is not a per-request scope, because `env` outlives a request:
 * it is the isolate. Without the reset the list was frozen for the isolate's
 * lifetime, so a site created in the admin did not resolve on the front end
 * (its host and its path prefix both fell through to the default site) until
 * the isolate happened to recycle. That is the multi-tenant shape of a stale
 * cache, and it is invisible in a single-site install.
 */
const memo = new WeakMap<Env, Promise<SiteRecord[]>>();

export function siteListMemo(env: Env): Promise<SiteRecord[]> {
  let p = memo.get(env);
  if (!p) {
    p = listSites(env);
    memo.set(env, p);
  }
  return p;
}

/**
 * Drop the memoised site list. Called once per request from the entry point,
 * which is the scope this memo always claimed to have.
 */
export function resetSiteListMemo(env: Env): void {
  memo.delete(env);
}

// ---------------------------------------------------------------------------
// Site CRUD (admin API)
// ---------------------------------------------------------------------------

export async function createSite(
  env: Env,
  input: { id?: string; name: string; host?: string | null; pathPrefix?: string | null }
): Promise<{ id: string } | { error: string }> {
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "name required" };
  const id = String(input.id ?? "")
    .trim()
    .toLowerCase();
  const safeId = id || `site_${Math.random().toString(36).slice(2, 10)}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(safeId)) {
    return { error: "id must be lowercase letters, digits, - or _" };
  }
  const existing = await env.DB.prepare("SELECT id FROM sites WHERE id=?").bind(safeId).first<any>();
  if (existing) return { error: "site id already exists" };
  const prefix = normalisePrefix(input.pathPrefix);
  const host = input.host ? normaliseHost(input.host) : null;
  const ts = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO sites(id,name,host,path_prefix,is_default,status,created_at,updated_at) VALUES(?,?,?,?,0,'active',?,?)"
  )
    .bind(safeId, name, host, prefix, ts, ts)
    .run();
  // Give the new site its language switch rows.
  //
  // ⚠️ This call was **missing**, and `seedSiteLocales`'s own doc comment
  // claimed it happened ("Called when a site is created, so the 'no rows →
  // serve the dictionary' fallback stays a safety net rather than the normal
  // path"). It was not called from anywhere in the runtime, so every site
  // created through the admin spent its life on that fallback: it served the
  // whole dictionary and had **no `is_default` row at all**, which is precisely
  // the "new site is a shell with an unchosen language" symptom the Sites
  // screen's next-step prompt exists to paper over. Seeding here makes the
  // fallback what it says it is — a safety net for databases migrated from
  // before 0011, not the path every new site takes.
  //
  // Failure is not swallowed: a site whose languages were not seeded would
  // render in an arbitrary language and nothing would say why. The insert is
  // already done, so this surfaces as an error the caller can report rather
  // than a silently half-built site.
  await seedSiteLocales(env, safeId);
  return { id: safeId };
}

export async function updateSite(
  env: Env,
  id: string,
  patch: { name?: string; host?: string | null; pathPrefix?: string | null; status?: string }
): Promise<{ ok: true } | { error: string }> {
  const row = await env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(id).first<any>();
  if (!row) return { error: "site not found" };
  const name = patch.name !== undefined ? String(patch.name).trim() || row.name : row.name;
  const host = patch.host !== undefined ? (patch.host ? normaliseHost(patch.host) : null) : row.host;
  const prefix =
    patch.pathPrefix !== undefined ? normalisePrefix(patch.pathPrefix) : row.path_prefix;
  const status = patch.status ? String(patch.status) : row.status;
  await env.DB.prepare(
    "UPDATE sites SET name=?,host=?,path_prefix=?,status=?,updated_at=? WHERE id=?"
  )
    .bind(name, host, prefix, status, Math.floor(Date.now() / 1000), id)
    .run();
  return { ok: true };
}

/**
 * Delete a site.
 *
 * The default site can never be deleted. Everything else splits in two, and the
 * split is **declared** rather than decided here:
 *
 *   - `"purge"` tables (`PURGE_ON_SITE_DELETE`) are per-site config and
 *     registry — a menu, a route, a generated-table mapping. They mean nothing
 *     without the site, and leaving them behind is not neutral: a leftover
 *     `admin_menu_registry` row is a menu that shows up in the admin and cannot
 *     be opened, and a leftover `theme_table_defs` row keeps declaring a table
 *     for a site nobody can see.
 *   - `"retain"` tables are content, media and audit history. Their rows become
 *     unreachable (nothing resolves the deleted site) but are not destroyed —
 *     deleting a site must not destroy an author's work, the same policy a
 *     theme switch follows.
 *
 * ⚠️ **`purgeTables` is a required parameter, and that is the point.** The list
 * is derived from `contract/schema.ts` (`PURGE_ON_SITE_DELETE`), where every
 * site-scoped table has to declare what happens to its rows — and
 * `architecture.test.mjs` fails if one does not. This function cannot import
 * that declaration itself: `platform/` must not know about `extensions/` (rule
 * 2), so the caller injects it, the same way the rest of the platform takes an
 * interface rather than reaching for an implementation. Required, not optional,
 * so a caller cannot forget to decide.
 *
 * It used to delete only the `sites` row and `theme.active`: the deleted site's
 * theme-registry and admin-menu rows survived, which is how "I deleted the site
 * and its menus are still listed" was possible.
 *
 * `settings` is in the purge list, which is what removes the site's
 * `theme.active` row — that row is what theme uninstall checks per site, so
 * leaving it would block the uninstall of a theme nobody can see or deactivate,
 * surfacing as "still active on: <deleted site>" with no way out.
 */
export async function deleteSite(
  env: Env,
  id: string,
  purgeTables: readonly string[],
): Promise<{ ok: true } | { error: string }> {
  if (id === DEFAULT_SITE_ID) return { error: "the default site cannot be deleted" };
  const row = await env.DB.prepare("SELECT is_default FROM sites WHERE id=?").bind(id).first<any>();
  if (!row) return { error: "site not found" };
  if (row.is_default) return { error: "the default site cannot be deleted" };
  await env.DB.prepare("DELETE FROM sites WHERE id=?").bind(id).run();
  for (const table of purgeTables) {
    // No `catch`: every one of these is a platform table created by a
    // migration, so a failure here is a real failure and must be visible
    // rather than leaving half a deletion behind (AGENTS.md, false-green #5).
    await env.DB.prepare(`DELETE FROM ${table} WHERE site_id=?`).bind(id).run();
  }
  return { ok: true };
}
