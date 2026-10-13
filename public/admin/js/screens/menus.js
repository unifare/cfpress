/**
 * Screen: Menus — full navigation manager.
 *
 * Left column: menus for this site (create / rename / relocate / delete).
 * Right column: the selected menu's items — add from a link, a post or a
 * page, edit inline (title, URL, language, parent), drag to reorder, delete.
 *
 * Site scoping is load-bearing: `menus` and `menu_items` are keyed per site,
 * so every read and write goes through `scoped()` and the server re-verifies
 * ownership. Reordering submits the full rendered sequence in one PUT — the
 * server validates every id against this menu before writing, so two drags
 * cannot interleave into a half-applied order.
 */
import { api, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

let selectedMenuId = null;

/** Tree flattening in display order: parent, then its children, then the next parent. */
function renderedOrder(items) {
  const tops = items.filter((i) => !i.parent_id);
  const out = [];
  for (const p of tops) {
    out.push(p);
    for (const c of items.filter((i) => String(i.parent_id) === String(p.id))) out.push(c);
  }
  for (const i of items) if (!out.includes(i)) out.push(i);
  return out;
}

export default async function menus(c) {
  const [d, locs] = await Promise.all([
    api(scoped("menus")),
    api(scoped("theme/menu-locations")).catch(() => ({ items: [{ id: "header" }] })),
  ]);
  const items = d.items || [];
  const locations = locs.items || [{ id: "header" }];
  if (!selectedMenuId || !items.some((m) => m.id === selectedMenuId)) selectedMenuId = items[0]?.id ?? null;
  const sel = items.find((m) => m.id === selectedMenuId) || null;

  const menuRows = items.map((m) => `<tr data-menu-id="${attr(m.id)}" style="cursor:pointer${m.id === selectedMenuId ? ";background:var(--bg-soft,rgba(0,0,0,.04))" : ""}">
      <td style="font-weight:500">${esc(m.name)}</td>
      <td><span class="badge outline">${esc(m.location || "—")}</span></td>
      <td class="actions">
        <button class="btn outline sm" data-menu-edit="${attr(m.id)}">${icon("pencil")}</button>
        <button class="btn outline danger sm" data-menu-del="${attr(m.id)}">${icon("trash")}</button>
      </td>
    </tr>`).join("");

  let itemRows = "";
  if (sel) {
    const x = await api(scoped(`menus/${sel.id}/items`));
    const rows = renderedOrder(x.items || []);
    itemRows = rows.map((i) => `<tr draggable="true" data-item-id="${attr(i.id)}" data-item-parent="${attr(i.parent_id || "")}"${i.parent_id ? ' style="color:var(--muted)"' : ""}>
      <td>${i.parent_id ? '<span class="muted">└</span> ' : ""}<span style="font-weight:500">${esc(i.title || "—")}</span></td>
      <td class="muted text-sm">${esc(i.url || "")}</td>
      <td>${i.locale ? `<span class="badge outline">${esc(i.locale)}</span>` : ""}</td>
      <td class="actions">
        <button class="btn outline sm" data-item-edit="${attr(i.id)}">${icon("pencil")}</button>
        <button class="btn outline danger sm" data-item-del="${attr(i.id)}">${icon("trash")}</button>
      </td>
    </tr>`).join("");
  }

  c.innerHTML = `${pageHead({
    title: t("core.nav.menus", "Menus"),
    sub: t("core.menus.sub", "Navigation menus for this site"),
    actions: `<button class="btn primary" data-action="new-menu">${icon("plus")}${esc(t("core.menus.new", "New menu"))}</button>`,
    crumbs: [{ label: t("core.nav.appearance", "Appearance") }, { label: t("core.nav.menus", "Menus") }],
  })}
  <div style="display:grid;grid-template-columns:1fr 2fr;gap:1rem;align-items:start">
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${esc(t("core.menus.colMenu", "Menu"))}</th><th>${esc(t("core.menus.colLocation", "Location"))}</th><th></th></tr></thead>
      <tbody>${menuRows || emptyRow(3, t("core.menus.none", "No menus for this site yet."))}</tbody>
    </table></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th colspan="4">${esc(t("core.menus.items", "Menu items"))}${sel ? ` — ${esc(sel.name)}` : ""}
        <span class="muted text-sm" style="margin-left:.5rem">${esc(t("core.menus.dragHint", "Drag rows to reorder"))}</span>
        ${sel ? `<button class="btn primary sm" style="float:right" data-action="add-item">${icon("plus")}${esc(t("core.menus.addItem", "Add item"))}</button>` : ""}
      </th></tr></thead>
      <tbody id="menu-items-body">${itemRows || emptyRow(4, t("core.menus.noItems", "No items yet. Add a link, a post or a page."))}</tbody>
    </table></div>
  </div>`;

  wireDrag(sel);
}

function wireDrag(sel) {
  if (!sel) return;
  let dragId = null;
  const table = document.getElementById("menu-items-body");
  if (!table) return;
  table.addEventListener("dragstart", (e) => { dragId = e.target.closest("tr")?.dataset.itemId || null; });
  table.addEventListener("dragover", (e) => {
    const row = e.target.closest("tr");
    if (row && dragId) { e.preventDefault(); row.style.borderTop = "2px solid var(--accent,#888)"; }
  });
  table.addEventListener("dragleave", (e) => { const row = e.target.closest("tr"); if (row) row.style.borderTop = ""; });
  table.addEventListener("drop", async (e) => {
    const row = e.target.closest("tr");
    row && (row.style.borderTop = "");
    if (!row || !dragId) return;
    e.preventDefault();
    const targetId = row.dataset.itemId;
    if (targetId === dragId) return;
    await applyReorder(sel, dragId, targetId);
  });
}

async function applyReorder(sel, dragId, targetId) {
  // Reload items, move dragId before targetId (only within the same parent —
  // re-parenting happens in the edit dialog, never by accident of a drop).
  const x = await api(scoped(`menus/${sel.id}/items`));
  const all = renderedOrder(x.items || []);
  const drag = all.find((i) => i.id === dragId);
  const target = all.find((i) => i.id === targetId);
  if (!drag || !target || String(drag.parent_id || "") !== String(target.parent_id || "")) return;
  const rest = all.filter((i) => i.id !== dragId);
  const at = rest.findIndex((i) => i.id === targetId);
  rest.splice(at, 0, drag);
  await api(scoped(`menus/${sel.id}/items`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: rest.map((i) => i.id) }) });
  toast(t("core.menus.reordered", "Order saved"));
  render();
}

async function openItemDialog(sel, existing) {
  // Link sources for the picker: posts and pages in the site's default
  // language. Computed URLs mirror the frontend (`/{locale}/blog/{slug}` for
  // posts, `/{locale}/{slug}` for pages) so a menu item lands on the same
  // page the theme would link to.
  let pickable = [];
  try {
    const [ps, pgs] = await Promise.all([
      api(scoped("posts?limit=100")),
      api(scoped("pages?limit=100")),
    ]);
    pickable = [
      ...(ps.items || []).map((p) => ({ value: `post:${p.id}:${p.slug}:${p.locale || ""}`, label: `[${t("core.menus.srcPost", "Post")}] ${p.title || p.slug}`, title: p.title || p.slug })),
      ...(pgs.items || []).map((p) => ({ value: `page:${p.id}:${p.slug}:${p.locale || ""}`, label: `[${t("core.menus.srcPage", "Page")}] ${p.title || p.slug}`, title: p.title || p.slug })),
    ];
  } catch { /* the custom-link path works without the picker */ }
  const pickableByValue = Object.fromEntries(pickable.map((p) => [p.value, p]));
  let locales = [];
  try { locales = (await api(scoped("i18n/locales"))).enabled || []; } catch { /* locale select degrades to All languages */ }

  const parentOptions = [{ value: "", label: t("core.menus.parentTop", "Top level") }];
  if (existing) {
    const x = await api(scoped(`menus/${sel.id}/items`));
    for (const i of (x.items || []).filter((i) => !i.parent_id && i.id !== existing.id)) {
      parentOptions.push({ value: i.id, label: i.title || i.url || i.id });
    }
  }

  const v = await openDialog({
    title: existing ? t("core.menus.editItem", "Edit item") : t("core.menus.addItem", "Add item"),
    confirmLabel: existing ? t("core.menus.saveItem", "Save item") : t("core.menus.addItem", "Add item"),
    fields: [
      ...(existing ? [] : [{ name: "target", label: t("core.menus.target", "Target"), type: "select", value: "custom", options: [{ value: "custom", label: t("core.menus.srcLink", "Custom link") }, ...pickable] }]),
      { name: "title", label: t("core.menus.fieldTitle", "Link text"), value: existing?.title || "", required: true },
      { name: "url", label: t("core.menus.fieldUrl", "URL"), value: existing?.url || "", placeholder: "https://… 或 /zh-CN/blog" },
      { name: "parent_id", label: t("core.menus.fieldParent", "Parent"), type: "select", value: existing?.parent_id || "", options: parentOptions },
      { name: "locale", label: t("core.menus.fieldLocale", "Language"), type: "select", value: existing?.locale || "", options: [{ value: "", label: t("core.menus.localeAuto", "All languages") }, ...locales.map((l) => ({ value: l, label: l }))] },
    ],
  });
  if (!v) return null;
  // A picker selection wins over the URL field; the typed title stays as the
  // link text (falls back to the target's own title when left empty).
  let url = v.url;
  let title = v.title;
  if (v.target && v.target !== "custom") {
    const [, , slug, loc] = v.target.split(":");
    url = `/${loc || "zh-CN"}/${v.target.startsWith("post:") ? "blog/" : ""}${slug}`;
    if (!title) title = pickableByValue[v.target]?.title || slug;
  }
  return { title, url, parent_id: v.parent_id || null, locale: v.locale || null };
}

document.addEventListener("click", async (e) => {
  const pickMenu = e.target.closest("tr[data-menu-id]");
  if (pickMenu && !e.target.closest("button")) {
    selectedMenuId = pickMenu.dataset.menuId;
    render();
    return;
  }

  if (e.target.closest("[data-action=new-menu]") || e.target.closest("[data-menu-edit]")) {
    const editing = e.target.closest("[data-menu-edit]")?.dataset.menuEdit;
    const locations = await api(scoped("theme/menu-locations")).catch(() => ({ items: [{ id: "header" }] }));
    const cur = editing ? (await api(scoped("menus"))).items?.find((m) => m.id === editing) : null;
    const v = await openDialog({
      title: cur ? t("core.menus.editTitle", "Edit menu") : t("core.menus.newTitle", "New menu"),
      confirmLabel: cur ? t("core.action.save", "Save") : t("core.menus.create", "Create menu"),
      fields: [
        { name: "name", label: t("core.menus.fieldName", "Menu name"), required: true, value: cur?.name || "", placeholder: "Primary" },
        { name: "location", label: t("core.menus.fieldLocation", "Location"), type: "select", value: cur?.location || "header", options: (locations.items || [{ id: "header" }]).map((l) => ({ value: l.id, label: l.label || l.id })) },
      ],
    });
    if (!v) return;
    if (cur) {
      await api(scoped(`menus/${cur.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      toast(t("core.menus.updated", "Menu updated"));
    } else {
      await api(scoped("menus"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      toast(t("core.menus.created", "Menu created"));
    }
    render();
    return;
  }

  const del = e.target.closest("[data-menu-del]");
  if (del) {
    const id = del.dataset.menuDel;
    const m = (await api(scoped("menus"))).items?.find((x) => x.id === id);
    const okDel = await confirmDialog({
      title: t("core.menus.deleteTitle", "Delete menu “{name}”?", { name: m?.name || id }),
      description: t("core.menus.deleteDesc", "The menu and all its items are removed."),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!okDel) return;
    await api(scoped(`menus/${id}`), { method: "DELETE" });
    toast(t("core.menus.deleted", "Menu deleted"));
    if (selectedMenuId === id) selectedMenuId = null;
    render();
    return;
  }

  const sel = selectedMenuId ? (await api(scoped("menus"))).items?.find((m) => m.id === selectedMenuId) : null;
  if (!sel) return;

  if (e.target.closest("[data-action=add-item]")) {
    const v = await openItemDialog(sel, null);
    if (!v) return;
    await api(scoped(`menus/${sel.id}/items`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    toast(t("core.menus.itemAdded", "Item added"));
    render();
    return;
  }

  const ed = e.target.closest("[data-item-edit]");
  if (ed) {
    const id = ed.dataset.itemEdit;
    const x = await api(scoped(`menus/${sel.id}/items`));
    const item = (x.items || []).find((i) => i.id === id);
    if (!item) return;
    const v = await openItemDialog(sel, item);
    if (!v) return;
    await api(scoped(`menu_items/${id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: v.title, url: v.url, parent_id: v.parent_id || null, locale: v.locale || null }) });
    toast(t("core.menus.itemSaved", "Item saved"));
    render();
    return;
  }

  const rm = e.target.closest("[data-item-del]");
  if (rm) {
    const id = rm.dataset.itemDel;
    const x = await api(scoped(`menus/${sel.id}/items`));
    const item = (x.items || []).find((i) => i.id === id);
    const okDel = await confirmDialog({
      title: t("core.menus.deleteItemTitle", "Delete item “{name}”?", { name: item?.title || id }),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!okDel) return;
    await api(scoped(`menu_items/${id}`), { method: "DELETE" });
    toast(t("core.menus.itemDeleted", "Item deleted"));
    render();
  }
});
