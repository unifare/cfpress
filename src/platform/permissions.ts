/**
 * Permissions — **the site is part of the question** (batch E, rule 78).
 *
 * ## Why `siteId` is a required parameter
 *
 * A permission question with no site in it cannot be answered correctly on an
 * install that holds more than one site. The old signature,
 * `can(env, user, permission)`, read `site_users.role` — one column, one answer
 * for every tenant — so an `editor` on the shop site was an `editor` everywhere
 * and "may this person publish *here*" had no way to be false for one site and
 * true for another.
 *
 * `siteId` is therefore **required**, not optional-with-a-default. An optional
 * parameter would let a call site silently ask the site-blind question again —
 * and the site-blind question still *has* an answer (it reads someone's row),
 * which is exactly how the defect would survive review. With it required, the
 * compiler names every place that has to decide which site it means.
 *
 * ## Two kinds of permission
 *
 * Not every permission has a site dimension, and pretending otherwise produces
 * a site id nobody can supply:
 *
 *   - **site-scoped** (`content.write`, `settings.manage`, `media.write`,
 *     `site.manage`) — answered from site_users_sites for *that* site.
 *   - **install-wide** (`platform.manage`, `users.manage`,
 *     `extensions.manage`) — managing the platform, its accounts or its
 *     extensions is not something a site-scoped role should carry at all.
 *
 * `PLATFORM_PERMISSIONS` is the closed set of the second kind, and it is the
 * one place that distinction is written down. A permission outside it is
 * site-scoped by construction.
 *
 * ## The absence of a row is the denial
 *
 * `site_users_sites` has one row per (person, site). A user with no row for the
 * requested site has **no access** to it — we do **not** fall back to a global
 * role. A fallback is how "removed from a site" turns into "still has access to
 * it": the row is gone, the fallback answers anyway, and the removal appears to
 * have worked while nothing changed. `superadmin` is the single deliberate
 * exception (§ below).
 *
 * ## superadmin
 *
 * A membership row per site has no answer for a site that does not exist yet.
 * `superadmin` is that answer, and it is checked **first**: it is an
 * install-wide role, granted on purpose (migration 0023 makes the sole existing
 * admin a superadmin so an upgrade cannot lock its owner out of creating the
 * next site). It short-circuits the membership lookup — but it is a stored role
 * on `site_users`, never a value writable through a per-site role edit.
 */
import { Env, SessionUser } from "../shared/types";

/**
 * Permissions that are answered for the **install**, not for a site.
 *
 * Managing the platform, its user accounts and its installed extensions are
 * platform operations: there is no "settings.manage on site B" for a user who
 * cannot see site B at all. Keeping this list explicit (rather than inferring
 * it from a naming convention) is what lets the guard in
 * `architecture.test.mjs` require `siteId` on every *other* call.
 */
export const PLATFORM_PERMISSIONS: ReadonlySet<string> = new Set([
  "platform.manage",
  "users.manage",
  "extensions.manage",
]);

/** The install-wide role that outranks every membership row. */
export const SUPERADMIN_ROLE = "superadmin";

/** Roles a per-site membership may carry. `superadmin` is deliberately absent. */
export const SITE_ROLES = ["admin", "editor", "author"] as const;

export function isPlatformPermission(permission: string): boolean {
  return PLATFORM_PERMISSIONS.has(permission);
}

/**
 * May this user exercise `permission` **on this site**?
 *
 * `siteId` is required for every site-scoped permission. Platform permissions
 * ignore it — a caller that has one still passes the site it is acting in, so
 * the call sites do not fork by permission kind (a fork is the next place the
 * distinction gets wrong).
 */
export async function can(
  env: Env,
  user: SessionUser,
  permission: string,
  siteId: string
): Promise<boolean> {
  // If request is authenticated via an API Key, check key-level scope and site boundaries first
  if (user.apiKeyId) {
    if (user.sites && !user.sites.includes("*") && !user.sites.includes(siteId)) {
      return false;
    }
    if (user.scopes && !user.scopes.includes("*") && !user.scopes.includes(permission)) {
      return false;
    }
  }

  // Install-wide first: a superadmin may act on every site, including one
  // created after their role was granted. Nothing else short-circuits.
  if (user.role === SUPERADMIN_ROLE) return true;

  // A platform permission is not negotiable per site — a user who is not a
  // superadmin simply does not have it. Note this is *narrower* than the old
  // behaviour, where any `admin` had every permission: install-wide powers now
  // belong to the superadmin role, and per-site `admin` is scoped to its site.
  if (isPlatformPermission(permission)) return false;

  // The membership row, or nothing. No fallback to `site_users.role`: a user
  // removed from a site must lose access to it, and a fallback is precisely how
  // that removal would fail to take effect.
  const row = await env.DB.prepare(
    "SELECT role FROM site_users_sites WHERE user_id = ? AND site_id = ? LIMIT 1"
  ).bind(user.id, siteId).first<{ role: string }>();
  if (!row) return false;

  // The role's own grant, from the same install-wide matrix as before.
  if (row.role === "admin") return true;
  const perm = await env.DB.prepare(
    "SELECT enabled FROM role_permissions WHERE role = ? AND permission = ? LIMIT 1"
  ).bind(row.role, permission).first<{ enabled: number }>();
  return !!perm?.enabled;
}

/** Convenience wrapper, so call sites read the same as they always did. */
export async function requirePermission(
  env: Env,
  user: SessionUser,
  permission: string,
  siteId: string
): Promise<boolean> {
  return can(env, user, permission, siteId);
}

/**
 * May this user act on this site **at all**?
 *
 * Used by the site switcher and the Sites screen: the sites a user can open are
 * exactly the sites they hold a membership for (plus every site, for a
 * superadmin). Reading this from `site_users_sites` is what makes "you are not
 * a member of the shop site" mean the site is not in your switcher — rather
 * than appearing there and failing on first click.
 */
export async function accessibleSiteIds(env: Env, user: SessionUser): Promise<string[] | null> {
  if (user.apiKeyId && user.sites && !user.sites.includes("*")) {
    return user.sites;
  }
  if (user.role === SUPERADMIN_ROLE) return null; // null = every site
  const rows = await env.DB.prepare(
    "SELECT site_id FROM site_users_sites WHERE user_id = ? ORDER BY site_id"
  ).bind(user.id).all<{ site_id: string }>();
  return ((rows.results as any[]) ?? []).map((r) => String(r.site_id));
}

/** Every site-scoped role this user holds, keyed by site, for the admin UI. */
export async function siteRolesFor(
  env: Env,
  userId: string
): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    "SELECT site_id, role FROM site_users_sites WHERE user_id = ?"
  ).bind(userId).all<any>();
  const out: Record<string, string> = {};
  for (const r of (rows.results as any[]) ?? []) out[String(r.site_id)] = String(r.role);
  return out;
}
