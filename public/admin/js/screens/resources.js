/**
 * Screen: generic table for tabular resources (locales, activity).
 *
 * The fetch is deliberately **not** site-scoped, and that is correct for both
 * callers: `locales` is the deployment-wide language dictionary (only
 * `menus`/`menu_items` are filtered by site in `genericTable`), and
 * `admin_activity` is a global log with no `site_id` column. Kept as-is so this
 * module split stays behaviour-neutral.
 */
import { api } from "../state.js";
import { pageHead } from "../shell.js";
import { t } from "../i18n.js";
import { emptyRow, esc } from "../../ui.js";

export default async function resources(c, path, title) {
  const d = await api(path);
  const rows = d.items || [];
  const keys = rows[0] ? Object.keys(rows[0]).slice(0, 7) : [];
  c.innerHTML = `${pageHead({
    title,
    sub: rows.length === 1 ? t("core.res.recordsOne", "1 record") : t("core.res.recordsMany", "{n} records", { n: rows.length }),
    crumbs: [{ label: t("core.nav.general", "General") }, { label: title }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>${keys.map((k) => `<th>${esc(k.replace(/_/g, " "))}</th>`).join("") || `<th>${esc(t("core.res.colData", "Data"))}</th>`}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${keys.map((k) => `<td>${esc(r[k] ?? "—")}</td>`).join("")}</tr>`).join("") || emptyRow(keys.length || 1, t("core.res.noRecords", "No records."))}</tbody>
  </table></div>`;
}
