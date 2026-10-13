/**
 * Snapshot / restore the rows a theme activation rewrites *site-wide*.
 *
 * Activating a theme on a site clear-then-inserts that theme's declared
 * capabilities for the site: `field_defs`, `post_types`, `taxonomies`,
 * `theme_routes`, `theme_blocks`, `admin_menu_registry` — and the derived
 * `theme_installs.active` column is recomputed from `settings`.
 *
 * The suites run against the *same* sqlite file `wrangler dev` serves
 * (AGENTS.md), so a suite that activates a fixture theme on the default site
 * silently destroys the operator's real theme's rows: the editor's custom
 * fields disappear, the front-end routes 404, and the Themes screen loses its
 * "active" badge — until something re-activates the theme by hand. `i18n`
 * documented this as a KNOWN GAP; the residue guard (`tests/tools/_residue-guard.mjs`)
 * then turned it into a red test, which is how it got fixed for real.
 *
 * Usage, at both ends of a suite that activates a theme:
 *
 *   const caps = snapshotCapabilities(sqlite);   // AFTER the idempotent sweep
 *   ...run...
 *   sweep();                                     // remove this run's fixtures
 *   restoreCapabilities(sqlite, caps);           // put the operator's rows back
 *
 * The snapshot must be taken **after** the suite's own up-front sweep: taking
 * it before would capture an older run's leftovers and restore them, so the
 * suite could never clean anything up.
 *
 * Whole-table, not per-site: these tables are small, and restoring the whole
 * table is what makes the derived `theme_installs.active` column come back too.
 */
import { DatabaseSync } from "node:sqlite";

/**
 * Tables a theme activation rewrites. `theme_installs` is included for its
 * `active` column, which is derived from `settings` and is recomputed on every
 * activation — restoring the table restores the column.
 */
export const CAPABILITY_TABLES = [
  "field_defs",
  "post_types",
  "taxonomies",
  "theme_routes",
  "theme_blocks",
  "admin_menu_registry",
  "theme_installs",
];

/** @param {DatabaseSync} sqlite */
export function snapshotCapabilities(sqlite) {
  const snap = {};
  for (const t of CAPABILITY_TABLES) {
    try {
      snap[t] = sqlite.prepare(`SELECT * FROM "${t}"`).all();
    } catch {
      snap[t] = null; // table absent in this schema revision
    }
  }
  return snap;
}

/** @param {DatabaseSync} sqlite @param {ReturnType<typeof snapshotCapabilities>} snap */
export function restoreCapabilities(sqlite, snap) {
  for (const t of CAPABILITY_TABLES) {
    const rows = snap[t];
    if (rows == null) continue;
    try {
      sqlite.exec(`DELETE FROM "${t}"`);
      for (const r of rows) {
        const keys = Object.keys(r);
        sqlite.prepare(`INSERT INTO "${t}" (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
          .run(...keys.map((k) => r[k]));
      }
    } catch { /* table may not exist yet — nothing to restore */ }
  }
}
