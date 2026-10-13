/**
 * Screen: Widgets — sidebar widgets rendered by the active theme.
 *
 * Widgets are grouped by the sidebars the active theme declares
 * (`sidebars[]` in its manifest, served by `theme/sidebars`) — the groups
 * the screen offers are exactly what the theme renders, so a widget can no
 * longer be filed under a sidebar nothing displays. Since 0020 the table is
 * site-scoped: every call goes through `scoped()` and the server re-verifies
 * ownership, so two sites cannot see each other's widgets.
 */
import { api, scoped } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

const TYPE_KEY = {
  text: "core.widgets.typeText",
  html: "core.widgets.typeHtml",
  "recent-posts": "core.widgets.typeRecent",
  menu: "core.widgets.typeMenu",
};

async function openWidgetDialog(existing) {
  const [sbs, menus, i18n] = await Promise.all([
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
    api(scoped("menus")).catch(() => ({ items: [] })),
    api(scoped("i18n/locales")).catch(() => ({ enabled: [] })),
  ]);
  const sidebarOptions = (sbs.items || [{ id: "sidebar" }, { id: "footer" }]).map((s) => ({ value: s.id, label: s.label || s.id }));
  let cfg = {};
  try { cfg = existing ? JSON.parse(String(existing.config || "{}")) : {}; } catch { cfg = {}; }
  const menuOptions = (menus.items || []).map((m) => ({ value: m.id, label: m.name }));
  return openDialog({
    title: existing ? t("core.widgets.editTitle", "Edit widget") : t("core.widgets.addTitle", "Add a widget"),
    description: t("core.widgets.bodyHint", "Text is escaped; HTML is inserted as-is"),
    confirmLabel: t("core.action.save", "Save"),
    fields: [
      { name: "widget_type", label: t("core.widgets.fieldType", "Type"), type: "select", value: existing?.widget_type || "text", options: Object.entries(TYPE_KEY).map(([value, key]) => ({ value, label: t(key, value) })) },
      { name: "title", label: t("core.widgets.fieldTitle", "Widget title"), value: existing?.title || "", placeholder: "About this site" },
      { name: "sidebar", label: t("core.widgets.fieldSidebar", "Sidebar"), type: "select", value: existing?.sidebar || sidebarOptions[0]?.value || "sidebar", options: sidebarOptions },
      { name: "locale", label: t("core.widgets.fieldLocale", "Language"), type: "select", value: existing?.locale || "", options: [{ value: "", label: t("core.widgets.localeAll", "All languages") }, ...(i18n.enabled || []).map((l) => ({ value: l, label: l }))] },
      { name: "body", label: `${t("core.widgets.fieldBody", "Content")} — ${t("core.widgets.typeText", "Text")} / ${t("core.widgets.typeHtml", "HTML")}`, type: "textarea", value: cfg.body || "", placeholder: "…" },
      { name: "count", label: `${t("core.widgets.fieldCount", "Number of posts")} — ${t("core.widgets.typeRecent", "Recent posts")}`, type: "number", value: cfg.count ?? 5 },
      { name: "menu_id", label: `${t("core.widgets.fieldMenu", "Menu to render")} — ${t("core.widgets.typeMenu", "Menu")}`, type: "select", value: cfg.menu_id || "", options: [{ value: "", label: menuOptions.length ? "—" : t("core.widgets.noMenus", "Create a menu first, then point the widget at it") }, ...menuOptions] },
    ],
  });
}

/** The config half of a dialog result, per chosen type (the other fields stay form noise). */
function configFor(type, v) {
  if (type === "text" || type === "html") return { body: v.body || "" };
  if (type === "recent-posts") return { count: Math.max(1, Math.min(20, Number(v.count) || 5)) };
  if (type === "menu") return { menu_id: v.menu_id || "" };
  return {};
}

export default async function widgets(c) {
  const [d, sbs] = await Promise.all([
    api(scoped("widgets")),
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
  ]);
  const items = d.items || [];
  const declared = sbs.items || [{ id: "sidebar" }, { id: "footer" }];
  const groups = [...declared.map((s) => s.id), ...[...new Set(items.map((w) => w.sidebar))].filter((sb) => !declared.some((s) => s.id === sb))];

  const typeLabel = (w) => esc(t(TYPE_KEY[w.widget_type] || "core.widgets.typeText", w.widget_type));
  const groupHtml = (sb) => {
    const rows = items.filter((w) => (w.sidebar || "sidebar") === sb)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id)));
    const body = rows.map((w) => `<tr data-widget-id="${attr(w.id)}">
      <td><span class="badge outline">${typeLabel(w)}</span></td>
      <td style="font-weight:500">${esc(w.title || "—")}</td>
      <td>${w.locale ? `<span class="badge outline">${esc(w.locale)}</span>` : `<span class="muted text-sm">${esc(t("core.widgets.localeAll", "All languages"))}</span>`}</td>
      <td>${w.enabled ? `<span class="badge success">${esc(t("core.widgets.enabled", "on"))}</span>` : `<span class="badge">${esc(t("core.widgets.disabled", "off"))}</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-w-up="${attr(w.id)}" title="↑">${icon("arrow-up")}</button>
        <button class="btn outline sm" data-w-down="${attr(w.id)}" title="↓">${icon("arrow-down")}</button>
        <button class="btn outline sm" data-w-edit="${attr(w.id)}">${icon("pencil")}</button>
        <button class="btn outline danger sm" data-w-del="${attr(w.id)}">${icon("trash")}</button>
      </td>
    </tr>`).join("");
    return `<div class="panel" style="margin-top:1rem">
      <div class="card-title">${esc(declared.find((s) => s.id === sb)?.label || sb)}</div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${esc(t("core.widgets.fieldType", "Type"))}</th><th>${esc(t("core.widgets.fieldTitle", "Widget title"))}</th><th>${esc(t("core.widgets.fieldLocale", "Language"))}</th><th></th><th></th></tr></thead>
        <tbody>${body || emptyRow(5, t("core.widgets.none", "No widgets in this sidebar yet."))}</tbody>
      </table></div>
    </div>`;
  };

  c.innerHTML = `${pageHead({
    title: t("core.nav.widgets", "Widgets"),
    sub: t("core.widgets.sub", "Sidebar widgets rendered by the active theme"),
    actions: `<button class="btn primary" data-action="new-widget">${icon("plus")}${esc(t("core.widgets.add", "Add widget"))}</button>`,
    crumbs: [{ label: t("core.nav.appearance", "Appearance") }, { label: t("core.nav.widgets", "Widgets") }],
  })}${groups.map(groupHtml).join("")}`;
}

async function findWidget(id) {
  const d = await api(scoped("widgets"));
  return (d.items || []).find((w) => w.id === id) || null;
}

/** Swap a widget with its neighbour inside the same sidebar. */
async function move(id, dir) {
  const d = await api(scoped("widgets"));
  const rows = (d.items || []).sort((a, b) => (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id)));
  const me = rows.find((w) => w.id === id);
  if (!me) return;
  const group = rows.filter((w) => (w.sidebar || "sidebar") === (me.sidebar || "sidebar"));
  const at = group.findIndex((w) => w.id === id);
  const other = group[at + dir];
  if (!other) return;
  // Two PUTs with explicit sort_order values — the server stores what it is
  // told, and the screen re-reads the group after the swap.
  await api(scoped(`widgets/${me.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: other.sort_order }) });
  await api(scoped(`widgets/${other.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: me.sort_order }) });
  toast(t("core.widgets.moved", "Order saved"));
  render();
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-action=new-widget]") || e.target.closest("[data-w-edit]")) {
    const editing = e.target.closest("[data-w-edit]")?.dataset.wEdit;
    const existing = editing ? await findWidget(editing) : null;
    const v = await openWidgetDialog(existing);
    if (!v) return;
    const type = v.widget_type;
    const payload = { widget_type: type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(type, v) };
    if (existing) {
      await api(scoped(`widgets/${existing.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast(t("core.widgets.saved", "Widget saved"));
    } else {
      await api(scoped("widgets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast(t("core.widgets.added", "Widget added"));
    }
    render();
    return;
  }

  const up = e.target.closest("[data-w-up]");
  const down = e.target.closest("[data-w-down]");
  if (up || down) { await move((up || down).dataset.wUp || (up || down).dataset.wDown, up ? -1 : 1); return; }

  const del = e.target.closest("[data-w-del]");
  if (del) {
    const w = await findWidget(del.dataset.wDel);
    const okDel = await confirmDialog({
      title: t("core.widgets.deleteTitle", "Delete widget “{name}”?", { name: w?.title || del.dataset.wDel }),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!okDel) return;
    await api(scoped(`widgets/${del.dataset.wDel}`), { method: "DELETE" });
    toast(t("core.widgets.deleted", "Widget deleted"));
    render();
  }
});
