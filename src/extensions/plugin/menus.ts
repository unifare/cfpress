/**
 * Plugin-contributed admin menus (ARCHITECTURE.md §4.4).
 *
 * ## Why a plugin's menus are install-wide
 *
 * A theme is activated *per site*, so its menus are per site: two sites can run
 * two themes and show two different sidebars. A plugin has no such switch —
 * `plugin_installs.enabled` is one install-wide flag — so "which site owns this
 * plugin's menu?" has no per-site answer to mirror.
 *
 * Rather than fan out one row per site (and then need a second hook on site
 * creation, whose absence would silently leave a new site with no plugin
 * menus), plugin rows are written once against `ALL_SITES` and matched by the
 * read helpers in `platform/admin-menus.ts`. Enabling a plugin is one write,
 * disabling it is one delete, and a site created tomorrow is already correct.
 *
 * ## Where registration is triggered
 *
 * `loadEnabledPlugins()` in `runtime.ts` is the single place that already
 * answers "which plugins are enabled, and what did each declare?" — hooks and
 * menus both come from that answer, so menus are materialised there instead of
 * growing a second, separately-maintained list. The enable/disable endpoint
 * calls `resetPluginRuntime()` + `bootPluginRuntime()` and therefore converges
 * immediately; a `waitUntil` boot converges the rest.
 */
import { Env } from "../../shared/types";
import {
  registerOwnerMenus,
  clearOwnerMenus,
  listOwnerMenus,
  ALL_SITES,
  type AdminMenuRow,
} from "../../platform/admin-menus";

export interface PluginAdminMenu {
  id: string;
  label?: string;
  icon?: string;
  screen: string;
  args?: Record<string, unknown>;
  capability?: string;
  /** Optional translation key for the label (`plugin.{name}.…`). See ThemeAdminMenu. */
  label_key?: string;
}

/** Materialise a plugin's `adminMenus` into the shared registry. */
export async function registerPluginMenus(
  env: Env,
  pluginName: string,
  menus: PluginAdminMenu[] | undefined
): Promise<number> {
  const list = Array.isArray(menus) ? menus : [];
  return registerOwnerMenus(
    env,
    ALL_SITES,
    "plugin",
    pluginName,
    list
      .filter((m) => m && m.id && m.screen)
      .map((m, i) => ({
        id: m.id,
        label: m.label ?? m.id,
        icon: m.icon ?? null,
        screen: m.screen,
        args: m.args ?? {},
        capability: m.capability ?? null,
        labelKey: m.label_key ?? null,
        sortOrder: i,
      }))
  );
}

/**
 * Remove exactly this plugin's menus. Other plugins' and the theme's menus are
 * untouched — that is the property the registry exists to provide.
 */
export async function clearPluginMenus(env: Env, pluginName: string): Promise<void> {
  await clearOwnerMenus(env, ALL_SITES, "plugin", pluginName);
}

export async function listPluginMenus(
  env: Env,
  siteId: string,
  pluginName: string
): Promise<AdminMenuRow[]> {
  return listOwnerMenus(env, siteId, "plugin", pluginName);
}

/**
 * Materialise a plugin's declared `tables[]` for every active site.
 *
 * ## Why this is a provider, not an import
 *
 * The DDL generator lives in `extensions/theme/tables.ts`, and rule 3 forbids
 * `plugin/` from importing `theme/` — the guard resolves real paths, so the
 * import would fail the architecture test rather than sail through. The exact
 * pattern the repo already uses twice (`setHostHooks`, `setPackProviders`)
 * applies: the plugin layer declares the *interface* it needs, and `index.ts`
 * — the one module allowed to know every layer — injects the implementation at
 * boot. Without an injection, `syncTables` is null and registration is a no-op,
 * which is precisely "the plugin declares tables and nothing materialises them"
 * — the state before this function existed, made explicit rather than silent.
 *
 * ## Why per site (and not the `ALL_SITES` trick menus use)
 *
 * A plugin's *menus* are install-wide because `plugin_installs.enabled` is a
 * single flag with no per-site answer. A plugin's *tables* are not: the
 * generated table is per site (`theme_table_defs` is keyed by `site_id`, and
 * `resolveTableForSite` looks up by the request's site). One shared table would
 * put every site's rows in one place with no `site_id` to separate them. So
 * this fans out over the active sites, per site, like theme activation does.
 */
export async function registerPluginTables(
  env: Env,
  pluginName: string,
  manifest: { tables?: unknown }
): Promise<number> {
  const decls = Array.isArray(manifest?.tables) ? manifest.tables : [];
  if (!decls.length || !syncTables) return 0;
  return syncTables(env, pluginName, manifest);
}

/**
 * The table-sync implementation, injected by `index.ts`.
 *
 * `ownerType` is fixed to `"plugin"` by the shape of this hook, so an
 * implementation cannot accidentally materialise a plugin's tables under the
 * theme namespace — the mismatch that `generatedTableName` exists to prevent.
 */
export type PluginTableSync = (
  env: Env,
  pluginName: string,
  manifest: { tables?: unknown }
) => Promise<number>;

let syncTables: PluginTableSync | null = null;

/** Install the plugin table-sync implementation. Called once from `index.ts`. */
export function setPluginTableSync(fn: PluginTableSync | null): void {
  syncTables = fn;
}
