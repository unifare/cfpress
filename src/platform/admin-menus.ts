/**
 * The unified admin menu registry (ARCHITECTURE.md §4.4).
 *
 * ## Why this lives in `platform/` and not in `extensions/`
 *
 * Both extension kinds write here: a theme registers its menus when it is
 * activated, a plugin registers its when it is enabled. If this module lived
 * under `extensions/theme/`, the plugin path would have to import it — and
 * rule 3 of §7.3 forbids `extensions/theme/` and `extensions/plugin/` from
 * importing each other. If it lived under `extensions/plugin/`, the reverse.
 * Neither extension kind may own a table the other one also writes.
 *
 * `platform/` is the lowest layer that is allowed to know about the database
 * and is importable by every extension, so it is the only correct home. The
 * dependency direction stays one-way: `extensions/` → `platform/`, never back.
 *
 * ## Why ownership is a column and not a naming convention
 *
 * `owner_type` + `owner_name` are what make "disable the SEO plugin and only
 * the SEO plugin's menus disappear" a `WHERE` clause instead of a guessing
 * game. The alternative — encoding the owner into `menu_id`, or trusting that
 * `sort_order` ranges do not overlap — breaks the moment two extensions pick
 * the same id, and it breaks silently.
 */

import { Env } from "../shared/types";
import { now } from "../shared/repo";

export type MenuOwnerType = "theme" | "plugin" | "core";

/**
 * A `site_id` meaning "every site on this install".
 *
 * Themes are activated per site, so their menus are per site — that is the
 * whole point of the theme/site split. Plugins are not: `plugin_installs.enabled`
 * is a single install-wide flag, and there is no per-site plugin switch to
 * mirror. So a plugin's menus have to answer "which site?" somehow, and the
 * two candidate answers are both bad:
 *
 *   fan out on enable   writes N rows and needs a second hook on site
 *                       creation. Miss that hook and a new site silently has
 *                       no plugin menus — a missing-UI bug with no error.
 *   one shared row      this. One write on enable, correct for sites that do
 *                       not exist yet, nothing to keep in sync.
 *
 * The magic value is confined to the read and write helpers in this file; no
 * caller has to know it exists except the plugin registration path, which
 * passes it explicitly.
 */
export const ALL_SITES = "*";

/** What an extension hands us. Deliberately structural, not imported from
 *  `extensions/`: `platform/` may not depend on `extensions/`. */
export interface AdminMenuInput {
  id: string;
  label?: string;
  icon?: string | null;
  screen: string;
  args?: Record<string, unknown>;
  capability?: string | null;
  /** Optional dictionary key the API translates `label` through (§2.4). */
  labelKey?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}

export interface AdminMenuRow {
  id: string;
  site_id: string;
  owner_type: MenuOwnerType;
  owner_name: string;
  menu_id: string;
  label: string;
  /** The declared translation key, if any. The API layer consumes it; the row
   *  keeps the declared value so the client can show *what* would translate. */
  label_key: string | null;
  icon: string | null;
  screen: string;
  args: Record<string, unknown>;
  capability: string | null;
  sort_order: number;
  enabled: number;
}

export interface AdminMenuGroup {
  owner_type: MenuOwnerType;
  owner_name: string;
  items: AdminMenuRow[];
}

export interface MenuFilter {
  ownerType?: MenuOwnerType;
  ownerName?: string;
  /** Hide rows whose `capability` this viewer does not hold. Omitted means
   *  "no filtering" — used by internal callers and by tests. */
  can?: (capability: string) => boolean | Promise<boolean>;
  /** Include rows with `enabled = 0`. Default false. */
  includeDisabled?: boolean;
}

/**
 * Primary key for a registry row.
 *
 * The natural key is `(site_id, owner_type, owner_name, menu_id)`, but a
 * PRIMARY KEY must be a single value. Embedding **all four** parts is not
 * cosmetic: two themes may each declare a menu called `main`, and the old
 * `scopedId("tam", site, id)` scheme — which omitted the owner — would have
 * given them the same row id and made the second theme silently overwrite the
 * first. Including the owner is what makes the `UNIQUE` constraint reachable
 * instead of being shadowed by a primary-key collision.
 *
 * The human-readable part is a slug for debuggability only. It is *not*
 * trusted to be injective — extension names may contain both `-` and `_`, so
 * `acme-shop` and `acme_shop` slug to the same string. A short hash of the raw
 * tuple is appended so two distinct owners can never share a row id; without
 * it, that pair of names would silently merge into one menu.
 */
export function menuRowId(
  ownerType: MenuOwnerType,
  ownerName: string,
  siteId: string,
  menuId: string
): string {
  const raw = `${ownerType}\u0000${ownerName}\u0000${siteId}\u0000${menuId}`;
  return `menu_${slug(ownerType)}_${slug(ownerName)}_${slug(menuId)}_${hash8(raw)}`;
}

function slug(v: unknown): string {
  return String(v ?? "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
}

/** FNV-1a, 32-bit, hex. Synchronous on purpose — the id is built in a hot path
 *  and WebCrypto's `subtle` is async. Not a security boundary. */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function parseArgs(v: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(v ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalise(row: any): AdminMenuRow {
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    owner_type: row.owner_type as MenuOwnerType,
    owner_name: String(row.owner_name),
    menu_id: String(row.menu_id),
    label: String(row.label),
    label_key: row.label_key ?? null,
    icon: row.icon ?? null,
    screen: String(row.screen),
    args: parseArgs(row.args_json),
    capability: row.capability ?? null,
    sort_order: Number(row.sort_order ?? 0),
    enabled: Number(row.enabled ?? 1),
  };
}

/**
 * Replace every menu an owner declared. Idempotent: calling it twice with the
 * same input leaves the same rows.
 *
 * Clearing first (rather than upserting and then deleting the leftovers) is
 * what makes *removal* work: a theme that drops a menu from its manifest
 * between versions must lose that menu, and an upsert-only path would happily
 * keep the orphan forever.
 */
export async function registerOwnerMenus(
  env: Env,
  siteId: string,
  ownerType: MenuOwnerType,
  ownerName: string,
  menus: AdminMenuInput[]
): Promise<number> {
  await clearOwnerMenus(env, siteId, ownerType, ownerName);
  const ts = now();
  let written = 0;
  let order = 0;
  for (const m of menus) {
    if (!m || !m.id || !m.screen) continue;
    await env.DB.prepare(
      `INSERT INTO admin_menu_registry
         (id, site_id, owner_type, owner_name, menu_id, label, label_key, icon, screen,
          args_json, capability, sort_order, enabled, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         label=excluded.label, label_key=excluded.label_key, icon=excluded.icon, screen=excluded.screen,
         args_json=excluded.args_json, capability=excluded.capability,
         sort_order=excluded.sort_order, enabled=excluded.enabled,
         updated_at=excluded.updated_at`
    )
      .bind(
        menuRowId(ownerType, ownerName, siteId, m.id),
        siteId,
        ownerType,
        ownerName,
        m.id,
        m.label ?? m.id,
        m.labelKey ?? null,
        m.icon ?? null,
        m.screen,
        JSON.stringify(m.args ?? {}),
        m.capability ?? null,
        Number(m.sortOrder ?? order),
        1,
        ts,
        ts
      )
      .run();
    written++;
    order++;
  }
  return written;
}

/**
 * Delete exactly one owner's menus, leaving every other owner untouched.
 *
 * This is the whole point of the registry: disabling a plugin must not disturb
 * a theme, and switching a theme must not disturb a plugin.
 */
export async function clearOwnerMenus(
  env: Env,
  siteId: string,
  ownerType: MenuOwnerType,
  ownerName: string
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM admin_menu_registry WHERE site_id=? AND owner_type=? AND owner_name=?"
  )
    .bind(siteId, ownerType, ownerName)
    .run()
    .catch(() => {});
}

/**
 * Delete one owner's menus on *every* site.
 *
 * `clearOwnerMenus` above is the deactivation path and is per site on purpose:
 * a theme switched away on site A must keep its menus on site B. Uninstalling
 * is the opposite case — the extension is leaving the install, so rows on sites
 * the caller never enumerated are leftovers it still has to remove.
 *
 * Those rows are reachable, not hypothetical: an activation interrupted before
 * it wrote `theme.active` leaves menus behind with no site selecting the theme,
 * and they point at tables an uninstall is about to drop.
 *
 * The predicate still lives here rather than in the caller, so
 * `admin_menu_registry`'s schema stays owned by this file.
 */
export async function clearOwnerMenusAllSites(
  env: Env,
  ownerType: MenuOwnerType,
  ownerName: string
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM admin_menu_registry WHERE owner_type=? AND owner_name=?"
  )
    .bind(ownerType, ownerName)
    .run()
    .catch(() => {});
}

/**
 * Rows for one owner, in declaration order.
 *
 * `siteId` may be a real site or `ALL_SITES`. Reads always include the
 * install-wide rows, so a caller never has to ask twice.
 */
export async function listOwnerMenus(
  env: Env,
  siteId: string,
  ownerType: MenuOwnerType,
  ownerName: string
): Promise<AdminMenuRow[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM admin_menu_registry
       WHERE (site_id=? OR site_id=?) AND owner_type=? AND owner_name=?
       ORDER BY sort_order, menu_id`
    )
      .bind(siteId, ALL_SITES, ownerType, ownerName)
      .all();
    return ((r.results as any[]) ?? []).map(normalise);
  } catch {
    return [];
  }
}

/**
 * Every menu this site should show, flat, in render order.
 *
 * Order is `core → theme → plugin`, then `sort_order`, then `menu_id`. The
 * owner-type rank is fixed rather than configurable because it encodes a
 * product decision (§4.4): platform items first, the active theme's content
 * management next, third-party additions last in their own group.
 */
export async function listAdminMenus(
  env: Env,
  siteId: string,
  filter: MenuFilter = {}
): Promise<AdminMenuRow[]> {
  const groups = await listAdminMenuGroups(env, siteId, filter);
  return groups.flatMap((g) => g.items);
}

/** The same rows, grouped by owner, for the SPA's sidebar. */
export async function listAdminMenuGroups(
  env: Env,
  siteId: string,
  filter: MenuFilter = {}
): Promise<AdminMenuGroup[]> {
  let rows: AdminMenuRow[] = [];
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM admin_menu_registry WHERE site_id=? OR site_id=?"
    )
      .bind(siteId, ALL_SITES)
      .all();
    rows = ((r.results as any[]) ?? []).map(normalise);
  } catch {
    return [];
  }

  if (!filter.includeDisabled) rows = rows.filter((row) => row.enabled !== 0);
  if (filter.ownerType) rows = rows.filter((row) => row.owner_type === filter.ownerType);
  if (filter.ownerName) rows = rows.filter((row) => row.owner_name === filter.ownerName);

  if (filter.can) {
    const kept: AdminMenuRow[] = [];
    for (const row of rows) {
      if (!row.capability) {
        kept.push(row);
        continue;
      }
      // A capability check must never take the whole sidebar down: an
      // extension declaring a capability the platform does not know about
      // hides its own menu, it does not break the admin.
      let allowed = false;
      try {
        allowed = await filter.can(row.capability);
      } catch {
        allowed = false;
      }
      if (allowed) kept.push(row);
    }
    rows = kept;
  }

  const rank: Record<string, number> = { core: 0, theme: 1, plugin: 2 };
  rows.sort((a, b) => {
    const dr = (rank[a.owner_type] ?? 9) - (rank[b.owner_type] ?? 9);
    if (dr) return dr;
    if (a.owner_name !== b.owner_name) return a.owner_name.localeCompare(b.owner_name);
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.menu_id.localeCompare(b.menu_id);
  });

  const out: AdminMenuGroup[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.owner_type === row.owner_type && last.owner_name === row.owner_name) {
      last.items.push(row);
    } else {
      out.push({ owner_type: row.owner_type, owner_name: row.owner_name, items: [row] });
    }
  }
  return out;
}
