/**
 * Screen: create / edit one row of a theme-declared table
 * (`table-edit`, ARCHITECTURE.md §3.5).
 *
 * The form is generated from the table's `fields[]`. Nothing here knows what a
 * "product" is — add a field to the theme's manifest and it appears, with a
 * control chosen from its declared type.
 */
import { api, scoped, state } from "../state.js";
import { go, pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc, toast } from "../../ui.js";
import { collectForm, fieldControl, slugControl, statusControl } from "../table-form.js";

/**
 * The declared fields of the form currently on screen.
 *
 * Kept in module scope because the save handler has only the DOM to work from,
 * and the DOM cannot tell a `date` from a `text` — both are `<input>`. Reading
 * the types back out of the rendered controls would silently coerce every
 * value as a string, so the declaration is remembered instead of re-derived.
 */
let currentFields = [];

function menuForTable(logical) {
  return state.adminMenus.find(
    (m) => m.args?.table === logical && (m.screen === "table-list" || m.screen === "table-edit")
  );
}

function notice(c, title, body) {
  c.innerHTML = `${pageHead({ title, sub: "", crumbs: [{ label: t("core.nav.fromTheme", "From theme") }, { label: title }] })}
  <div class="panel"><div class="empty">${esc(body)}</div></div>`;
}

export async function tableEditScreen(c, table, slug) {
  const logical = String(table ?? "").trim();
  if (!logical) {
    notice(c, t("core.table.notice", "Table"), t("core.table.needsName", "This screen needs a table name. Declare it as args.table on the menu."));
    return;
  }

  const wanted = String(slug ?? "").trim();
  let def = null;
  let row = null;

  if (wanted) {
    const d = await api(scoped(`theme-tables/${encodeURIComponent(logical)}/${encodeURIComponent(wanted)}`));
    def = d.def ?? null;
    row = d.row ?? null;
  } else {
    // A brand-new row still needs the declaration to know which fields exist.
    const d = await api(scoped(`theme-tables/${encodeURIComponent(logical)}?limit=1`));
    def = d.def ?? null;
  }

  if (!def) {
    notice(c, logical, t("core.table.notDeclared", "No table named “{name}” is declared for this site.", { name: logical }));
    return;
  }
  if (wanted && !row) {
    notice(c, logical, t("core.table.noRow", "No row with slug “{slug}” in {table}.", { slug: wanted, table: def.table_name }));
    return;
  }

  const fields = Array.isArray(def.fields) ? def.fields : [];
  currentFields = fields;

  const menu = menuForTable(logical);
  const singular = menu?.label || def.label || logical;
  const title = wanted ? t("core.table.editTitle", "Edit {name}", { name: singular }) : t("core.table.newTitle", "New {name}", { name: singular });

  const controls = [
    // The slug is the row's identity (`tableSave` upserts on it), so it is
    // fixed once the row exists — otherwise a typo would create a second row
    // instead of renaming this one, and nothing would report a problem.
    wanted
      ? `<div class="field"><label>${esc(t("core.content.slug", "Slug"))}</label><input type="text" value="${attr(wanted)}" disabled></div>`
      : slugControl(""),
    ...fields.map((f) => fieldControl(f, row ? row[f.key] : undefined)),
    statusControl(row ? row.status : "draft"),
  ].join("");

  c.innerHTML = `${pageHead({
    title,
    sub: t("core.table.tableName", "table {name}", { name: def.table_name }),
    actions: `<button class="btn primary" data-table-save="${attr(logical)}" data-table-slug="${attr(wanted)}">${icon("save")}${esc(t("core.action.save", "Save"))}</button>`,
    crumbs: [
      { label: t("core.nav.fromTheme", "From theme") },
      { label: singular },
      { label: wanted || t("core.table.new", "New") },
    ],
  })}
  <div class="panel"><div class="form-grid">${controls}</div></div>`;
}

document.addEventListener("click", async (e) => {
  const save = e.target.closest("[data-table-save]");
  if (!save) return;
  const table = save.dataset.tableSave;
  const editing = save.dataset.tableSlug;

  const root = document.querySelector("#content");
  const payload = collectForm(root, currentFields);

  // `slug` and `status` are platform columns, not declared fields, so they are
  // read separately. On an edit the slug input is disabled (and therefore not
  // submitted at all), so the known value is carried forward.
  const slugEl = root.querySelector('[data-tf="slug"]');
  payload.slug = editing || (slugEl ? slugEl.value.trim() : "");
  const statusEl = root.querySelector('[data-tf="status"]');
  if (statusEl) payload.status = statusEl.value;

  if (!payload.slug) {
    toast(t("core.table.slugRequired", "Slug is required"), "error");
    return;
  }

  try {
    await api(scoped(`theme-tables/${encodeURIComponent(table)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast(t("core.msg.saved", "Saved."));
    await go(`table:${table}`);
  } catch (err) {
    toast(err.message || t("core.table.saveFailed", "Save failed"), "error");
  }
});
