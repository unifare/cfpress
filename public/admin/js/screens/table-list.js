/**
 * Screen: a theme-declared table's row list (`table-list`, ARCHITECTURE.md §3.5).
 *
 * Reached from a theme or plugin menu that declares
 * `{ screen: "table-list", args: { table: "product" } }`. Every column comes
 * from the table's own `fields[]` declaration — the theme ships no admin code
 * and this screen knows nothing about "products".
 */
import { api, scoped, state } from "../state.js";
import { go, pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, confirmDialog, emptyRow, esc, fmtDate, statusBadge, toast } from "../../ui.js";
import { formatValue } from "../table-form.js";

/** The menu that pointed here, so the page can borrow its label. */
function menuForTable(logical) {
  return state.adminMenus.find(
    (m) => m.args?.table === logical && (m.screen === "table-list" || m.screen === "table-edit")
  );
}

function notice(c, title, body) {
  c.innerHTML = `${pageHead({ title, sub: "", crumbs: [{ label: t("core.nav.fromTheme", "From theme") }, { label: title }] })}
  <div class="panel"><div class="empty">${esc(body)}</div></div>`;
}

export async function tableListScreen(c, table) {
  const logical = String(table ?? "").trim();
  // Reached without a table (the `table-list` screen key itself, or a menu with
  // no args). Say so rather than rendering an empty table that looks broken.
  if (!logical) {
    notice(c, t("core.table.notice", "Table"), t("core.table.needsName", "This screen needs a table name. Declare it as args.table on the menu."));
    return;
  }

  const d = await api(scoped(`theme-tables/${encodeURIComponent(logical)}?limit=100`));
  const def = d.def;
  if (!def) {
    notice(c, logical, t("core.table.notDeclared", "No table named “{name}” is declared for this site.", { name: logical }));
    return;
  }

  const menu = menuForTable(logical);
  const title = menu?.label || def.label || logical;
  const fields = Array.isArray(def.fields) ? def.fields : [];
  const rows = Array.isArray(d.items) ? d.items : [];

  const head = [t("core.content.slug", "Slug"), ...fields.map((f) => String(f.label || f.key)), t("core.content.status", "Status"), t("core.content.updated", "Updated"), ""]
    .map((h) => `<th>${esc(h)}</th>`)
    .join("");

  const body = rows
    .map((row) => {
      const cells = fields
        .map((f) => `<td>${esc(formatValue(f, row[f.key]))}</td>`)
        .join("");
      const slug = String(row.slug ?? "");
      return `<tr>
      <td><div style="font-weight:500">${esc(slug)}</div><div class="muted text-sm">/${esc(String(row.id ?? ""))}</div></td>
      ${cells}
      <td>${statusBadge(row.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(row.updated_at))}</td>
      <td class="actions">
        <button class="btn outline sm" data-table-edit="${attr(logical)}|${attr(slug)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button>
        <button class="btn outline sm danger" data-table-del="${attr(logical)}|${attr(slug)}">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>
      </td>
    </tr>`;
    })
    .join("");

  c.innerHTML = `${pageHead({
    title,
    sub: `${rows.length === 1 ? t("core.table.rowsOne", "1 row") : t("core.table.rowsMany", "{n} rows", { n: rows.length })} · ${t("core.table.tableName", "table {name}", { name: def.table_name })}`,
    actions: `<button class="btn primary" data-table-new="${attr(logical)}">${icon("plus")}${esc(t("core.table.add", "Add"))}</button>`,
    crumbs: [{ label: t("core.nav.fromTheme", "From theme") }, { label: title }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>${head}</tr></thead>
    <tbody>${body || emptyRow(fields.length + 4, t("core.table.noRows", "No rows yet."))}</tbody>
  </table></div>`;
}

/**
 * Delegated actions.
 *
 * Document-level rather than inline `onclick=` on purpose: an inline handler is
 * resolved against `window`, so forgetting to publish it in the entry point's
 * `WINDOW_HANDLERS` map produces a button that does nothing and reports
 * nothing (AGENTS.md rule 21).
 */
document.addEventListener("click", async (e) => {
  const add = e.target.closest("[data-table-new]");
  if (add) {
    await go(`table-new:${add.dataset.tableNew}`);
    return;
  }

  const edit = e.target.closest("[data-table-edit]");
  if (edit) {
    const [table, slug] = String(edit.dataset.tableEdit).split("|");
    await go(`table-edit:${table}:${encodeURIComponent(slug)}`);
    return;
  }

  const del = e.target.closest("[data-table-del]");
  if (del) {
    const [table, slug] = String(del.dataset.tableDel).split("|");
    const yes = await confirmDialog({
      title: t("core.table.deleteTitle", "Delete row"),
      description: t("core.table.deleteDesc", "Delete “{slug}” from {table}? This cannot be undone.", { slug, table }),
    });
    if (!yes) return;
    try {
      await api(scoped(`theme-tables/${encodeURIComponent(table)}/${encodeURIComponent(slug)}`), {
        method: "DELETE",
      });
      toast(t("core.table.rowDeleted", "Row deleted"));
      await go(`table:${table}`);
    } catch (err) {
      toast(err.message || t("core.table.deleteFailed", "Delete failed"), "error");
    }
  }
});
