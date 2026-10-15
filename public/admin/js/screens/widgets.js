/**
 * Screen: Widgets — sidebar widgets rendered by the active theme.
 *
 * Supports two view modes:
 *   1. Visual Canvas (WYSIWYG layout with interactive slot anchors,
 *      draggable widget catalog, responsive device viewport, template selector,
 *      and in-place live bridge without iframe reloads).
 *   2. Classical List View (grouped tables by declared sidebars).
 *
 * Widgets are grouped by the sidebars the active theme declares
 * (`sidebars[]` in its manifest, served by `theme/sidebars`).
 * Since 0020 the table is site-scoped: every call goes through `scoped()`.
 */
import { adminBase, api, scoped, state } from "../state.js";
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

const VIEWPORT_WIDTHS = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

let currentView = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("cfpress_widgets_view")) || "canvas";
let currentViewport = "desktop";
let previewPath = "/";
let detectedSlots = [];

async function openWidgetDialog(existing, defaultSlot, defaultType) {
  const [sbs, menus, i18n] = await Promise.all([
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
    api(scoped("menus")).catch(() => ({ items: [] })),
    api(scoped("i18n/locales")).catch(() => ({ enabled: [] })),
  ]);
  const sidebarOptions = (sbs.items || [{ id: "sidebar" }, { id: "footer" }]).map((s) => ({ value: s.id, label: s.label || s.id }));
  let cfg = {};
  try { cfg = existing ? JSON.parse(String(existing.config || "{}")) : {}; } catch { cfg = {}; }
  const menuList = menus.items || [];
  const menuOptions = menuList.map((m) => ({ value: m.id, label: m.name }));
  const chosenType = existing?.widget_type || defaultType || "text";

  if ((chosenType === "menu" || defaultType === "menu") && menuOptions.length === 0) {
    toast(t("core.widgets.noMenus", "Create a menu first, then point the widget at it"), "error");
    return null;
  }

  const initialMenuId = cfg.menu_id || (menuOptions.length ? menuOptions[0].value : "");

  const res = await openDialog({
    title: existing ? t("core.widgets.editTitle", "Edit widget") : t("core.widgets.addTitle", "Add a widget"),
    description: t("core.widgets.bodyHint", "Text is escaped; HTML is inserted as-is"),
    confirmLabel: t("core.action.save", "Save"),
    fields: [
      { name: "widget_type", label: t("core.widgets.fieldType", "Type"), type: "select", value: chosenType, options: Object.entries(TYPE_KEY).map(([value, key]) => ({ value, label: t(key, value) })) },
      { name: "title", label: t("core.widgets.fieldTitle", "Widget title"), value: existing?.title || "", placeholder: "About this site" },
      { name: "sidebar", label: t("core.widgets.fieldSidebar", "Sidebar"), type: "select", value: existing?.sidebar || defaultSlot || sidebarOptions[0]?.value || "sidebar", options: sidebarOptions },
      { name: "locale", label: t("core.widgets.fieldLocale", "Language"), type: "select", value: existing?.locale || "", options: [{ value: "", label: t("core.widgets.localeAll", "All languages") }, ...(i18n.enabled || []).map((l) => ({ value: l, label: l }))] },
      { name: "body", label: `${t("core.widgets.fieldBody", "Content")} — ${t("core.widgets.typeText", "Text")} / ${t("core.widgets.typeHtml", "HTML")}`, type: "textarea", value: cfg.body || "", placeholder: "…" },
      { name: "count", label: `${t("core.widgets.fieldCount", "Number of posts")} — ${t("core.widgets.typeRecent", "Recent posts")}`, type: "number", value: cfg.count ?? 5 },
      { name: "menu_id", label: `${t("core.widgets.fieldMenu", "Menu to render")} — ${t("core.widgets.typeMenu", "Menu")}`, type: "select", value: initialMenuId, options: [{ value: "", label: menuOptions.length ? "—" : t("core.widgets.noMenus", "Create a menu first, then point the widget at it") }, ...menuOptions] },
    ],
  });

  if (!res) return null;
  if (res.widget_type === "menu" && !res.menu_id) {
    toast(t("core.widgets.menuRequired", "Please select a menu to display, or create one under Appearance -> Menus first."), "error");
    return null;
  }
  return res;
}

/** The config half of a dialog result, per chosen type. */
function configFor(type, v) {
  if (type === "text" || type === "html") return { body: v.body || "" };
  if (type === "recent-posts") return { count: Math.max(1, Math.min(20, Number(v.count) || 5)) };
  if (type === "menu") return { menu_id: v.menu_id || "" };
  return {};
}

function reloadCanvasIframe() {
  const ifr = document.querySelector("#canvas-iframe");
  if (ifr) ifr.src = `${adminBase}/preview?path=${encodeURIComponent(previewPath)}&site=${encodeURIComponent(state.site || "default")}`;
}

function refreshCanvasSlots() {
  const ifr = document.querySelector("#canvas-iframe");
  if (ifr && ifr.contentWindow) {
    ifr.contentWindow.postMessage({ action: "canvas:refresh-slots" }, "*");
  } else {
    reloadCanvasIframe();
  }
}

export default async function widgets(c) {
  const [d, sbs, widgetTypesRes, pagesRes, routesRes] = await Promise.all([
    api(scoped("widgets")),
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
    api("widgets/types").catch(() => ({ items: [] })),
    api(scoped("content?type=page&limit=50")).catch(() => ({ items: [] })),
    api(scoped("theme/routes")).catch(() => ({ items: [] })),
  ]);
  const items = d.items || [];
  const declared = sbs.items || [{ id: "sidebar" }, { id: "footer" }];
  const groups = [...declared.map((s) => s.id), ...[...new Set(items.map((w) => w.sidebar))].filter((sb) => !declared.some((s) => s.id === sb))];

  const typeLabel = (w) => esc(t(TYPE_KEY[w.widget_type] || "core.widgets.typeText", w.widget_type));

  const listHtml = groups.map((sb) => {
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
  }).join("");

  const catalogTypes = (widgetTypesRes.items && widgetTypesRes.items.length)
    ? widgetTypesRes.items
    : [
        { type: "text", title: "Text", description: "Arbitrary text", icon: "file-text" },
        { type: "html", title: "HTML", description: "Custom HTML / embed code", icon: "puzzle" },
        { type: "recent-posts", title: "Recent Posts", description: "List of latest posts", icon: "layers" },
        { type: "menu", title: "Menu", description: "Site navigation menu", icon: "menu" },
      ];

  const catalogHtml = catalogTypes.map((item) => `
    <div class="widget-catalog-item" draggable="true" data-widget-type="${attr(item.type)}" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg, #fff);display:flex;align-items:center;justify-content:space-between;cursor:grab;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.03);user-select:none;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="display:inline-flex;color:var(--primary);">${icon(item.icon || "puzzle")}</span>
        <div>
          <div style="font-weight:600;font-size:13px;line-height:1.2;">${esc(item.title)}</div>
          <div style="font-size:11px;color:var(--muted);">${esc(item.description || "")}</div>
        </div>
      </div>
      <button class="btn outline sm" data-action="quick-add-widget" data-type="${attr(item.type)}" title="${esc(t("core.widgets.add", "Add widget"))}" style="padding:2px 6px;">${icon("plus")}</button>
    </div>
  `).join("");

  const slotsList = (detectedSlots.length ? detectedSlots : groups.map((g) => ({ id: g, label: g }))).map((s) => {
    const sId = typeof s === "string" ? s : s.id;
    const count = items.filter((w) => (w.sidebar || "sidebar") === sId).length;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px;">
      <span style="font-weight:500;">${esc(sId)}</span>
      <span class="badge outline">${count}</span>
    </div>`;
  }).join("");

  const pages = pagesRes.items || [];
  const themeRoutes = routesRes.items || [];

  const pageSelectOptions = [
    `<optgroup label="${esc(t("core.widgets.groupStandard", "Standard templates"))}">`,
    `  <option value="/" ${previewPath === "/" ? "selected" : ""}>🏠 ${esc(t("core.widgets.tplHome", "Home (front-page)"))}</option>`,
    `  <option value="/blog" ${previewPath === "/blog" ? "selected" : ""}>📰 ${esc(t("core.widgets.tplBlog", "Blog archive (home)"))}</option>`,
    `</optgroup>`,
    pages.length ? `<optgroup label="${esc(t("core.widgets.groupPages", "Pages"))}">` + pages.map((p) => {
      const u = "/" + p.slug;
      return `<option value="${attr(u)}" ${previewPath === u ? "selected" : ""}>📄 ${esc(p.title || p.slug)}</option>`;
    }).join("") + `</optgroup>` : "",
    themeRoutes.length ? `<optgroup label="${esc(t("core.widgets.groupRoutes", "Theme routes"))}">` + themeRoutes.map((r) => {
      const u = r.route_path || "/";
      return `<option value="${attr(u)}" ${previewPath === u ? "selected" : ""}>🎨 ${esc(r.title || r.route_path)} (${esc(r.template || "")})</option>`;
    }).join("") + `</optgroup>` : "",
  ].join("");

  const previewUrl = `${adminBase}/preview?path=${encodeURIComponent(previewPath)}&site=${encodeURIComponent(state.site || "default")}`;
  const iframeWidth = VIEWPORT_WIDTHS[currentViewport] || "100%";

  const canvasHtml = `
    <div style="display:flex;gap:16px;margin-top:1rem;align-items:flex-start;">
      <!-- Left Panel: Widget Catalog & Slots Info -->
      <div style="width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:14px;">
        <div class="panel" style="padding:14px;">
          <div class="card-title" style="margin-bottom:6px;font-size:14px;">${esc(t("core.widgets.catalog", "Widget catalog"))}</div>
          <p class="muted text-sm" style="margin-bottom:12px;line-height:1.4;">${esc(t("core.widgets.dragHint", "Drag a widget into a slot in the preview"))}</p>
          <div class="widget-catalog-list">
            ${catalogHtml}
          </div>
        </div>

        <div class="panel" style="padding:14px;">
          <div class="card-title" style="margin-bottom:8px;font-size:14px;">${esc(t("core.widgets.activeSlots", "Page slots"))}</div>
          <div style="display:flex;flex-direction:column;">
            ${slotsList}
          </div>
        </div>
      </div>

      <!-- Right Panel: Canvas Frame & Responsive Toolbar -->
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;">
        <div class="panel" style="padding:8px 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn ${currentViewport === "desktop" ? "primary" : "outline"} sm" data-action="set-viewport" data-viewport="desktop" title="${esc(t("core.widgets.viewportDesktop", "Desktop"))}">${icon("monitor")}</button>
            <button class="btn ${currentViewport === "tablet" ? "primary" : "outline"} sm" data-action="set-viewport" data-viewport="tablet" title="${esc(t("core.widgets.viewportTablet", "Tablet"))}">768px</button>
            <button class="btn ${currentViewport === "mobile" ? "primary" : "outline"} sm" data-action="set-viewport" data-viewport="mobile" title="${esc(t("core.widgets.viewportMobile", "Mobile"))}">375px</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex:1;max-width:540px;">
            <select id="canvas-page-select" class="input sm" style="max-width:240px;height:32px;padding:3px 8px;font-size:12px;">
              ${pageSelectOptions}
            </select>
            <input type="text" id="canvas-path-input" class="input sm" value="${esc(previewPath)}" placeholder="/" style="flex:1;min-width:80px;" />
            <button class="btn outline sm" data-action="navigate-preview" title="${esc(t("core.widgets.previewPage", "Navigate"))}">${icon("arrow-right")}</button>
            <button class="btn outline sm" data-action="reload-preview" title="${esc(t("core.widgets.refreshPreview", "Refresh preview"))}">${icon("refresh")}</button>
          </div>
        </div>

        <div style="min-height:640px;background:var(--muted-bg, #f1f5f9);border:1px solid var(--border);border-radius:8px;display:flex;justify-content:center;overflow:hidden;padding:12px 0;">
          <iframe id="canvas-iframe" src="${previewUrl}" style="width:${iframeWidth};height:620px;border:1px solid var(--border);border-radius:6px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.06);transition:width 0.25s ease;"></iframe>
        </div>
      </div>
    </div>
  `;

  const viewToggleButtons = `
    <div class="btn-group" style="display:inline-flex;margin-right:8px;">
      <button class="btn ${currentView === "canvas" ? "primary" : "outline"} sm" data-action="toggle-view" data-view="canvas">${icon("palette")}${esc(t("core.widgets.viewCanvas", "Visual Canvas"))}</button>
      <button class="btn ${currentView === "list" ? "primary" : "outline"} sm" data-action="toggle-view" data-view="list">${icon("menu")}${esc(t("core.widgets.viewList", "List"))}</button>
    </div>
  `;

  c.innerHTML = `${pageHead({
    title: t("core.nav.widgets", "Widgets"),
    sub: t("core.widgets.sub", "Sidebar widgets rendered by the active theme"),
    actions: `${viewToggleButtons}<button class="btn primary sm" data-action="new-widget">${icon("plus")}${esc(t("core.widgets.add", "Add widget"))}</button>`,
    crumbs: [{ label: t("core.nav.appearance", "Appearance") }, { label: t("core.nav.widgets", "Widgets") }],
  })}${currentView === "canvas" ? canvasHtml : listHtml}`;
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
  await api(scoped(`widgets/${me.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: other.sort_order }) });
  await api(scoped(`widgets/${other.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: me.sort_order }) });
  toast(t("core.widgets.moved", "Order saved"));
  render();
}

// Global change delegation (for template select)
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "canvas-page-select") {
    previewPath = e.target.value || "/";
    const input = document.querySelector("#canvas-path-input");
    if (input) input.value = previewPath;
    reloadCanvasIframe();
  }
});

// Global click delegation
document.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-action=toggle-view]");
  if (toggleBtn) {
    currentView = toggleBtn.dataset.view || "canvas";
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem("cfpress_widgets_view", currentView);
    render();
    return;
  }

  const viewportBtn = e.target.closest("[data-action=set-viewport]");
  if (viewportBtn) {
    currentViewport = viewportBtn.dataset.viewport || "desktop";
    render();
    return;
  }

  if (e.target.closest("[data-action=reload-preview]")) {
    reloadCanvasIframe();
    return;
  }

  if (e.target.closest("[data-action=navigate-preview]")) {
    const input = document.querySelector("#canvas-path-input");
    if (input) {
      previewPath = input.value || "/";
      const sel = document.querySelector("#canvas-page-select");
      if (sel) {
        const matchOpt = Array.from(sel.options).find((o) => o.value === previewPath);
        if (matchOpt) sel.value = previewPath;
      }
      reloadCanvasIframe();
    }
    return;
  }

  const quickAddBtn = e.target.closest("[data-action=quick-add-widget]");
  if (quickAddBtn) {
    const type = quickAddBtn.dataset.type || "text";
    const v = await openWidgetDialog(null, null, type);
    if (!v) return;
    const payload = { widget_type: v.widget_type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(v.widget_type, v) };
    try {
      await api(scoped("widgets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast(t("core.widgets.added", "Widget added"));
    } catch (err) {
      toast(err?.message || "Failed to add widget", "error");
    }
    if (currentView === "canvas") refreshCanvasSlots();
    else render();
    return;
  }

  if (e.target.closest("[data-action=new-widget]") || e.target.closest("[data-w-edit]")) {
    const editing = e.target.closest("[data-w-edit]")?.dataset.wEdit;
    const existing = editing ? await findWidget(editing) : null;
    const v = await openWidgetDialog(existing);
    if (!v) return;
    const type = v.widget_type;
    const payload = { widget_type: type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(type, v) };
    try {
      if (existing) {
        await api(scoped(`widgets/${existing.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast(t("core.widgets.saved", "Widget saved"));
      } else {
        await api(scoped("widgets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast(t("core.widgets.added", "Widget added"));
      }
    } catch (err) {
      toast(err?.message || "Failed to save widget", "error");
    }
    if (currentView === "canvas") refreshCanvasSlots();
    else render();
    return;
  }

  const up = e.target.closest("[data-w-up]");
  const down = e.target.closest("[data-w-down]");
  if (up || down) { await move((up || down).dataset.wUp || (up || down).dataset.wDown, up ? -1 : 1); return; }

  const del = e.target.closest("[data-w-del]");
  if (del) {
    const id = del.dataset.wDel;
    const w = await findWidget(id);
    const okDel = await confirmDialog({
      title: t("core.widgets.deleteTitle", "Delete widget “{name}”?", { name: w?.title || id }),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!okDel) return;
    try {
      await api(scoped(`widgets/${id}`), { method: "DELETE" });
      toast(t("core.widgets.deleted", "Widget deleted"));
    } catch (err) {
      if (err?.message?.includes("not found")) {
        toast(t("core.widgets.notFound", "Widget not found or already removed"), "info");
      } else {
        toast(err?.message || "Failed to delete widget", "error");
      }
    }
    if (currentView === "canvas") refreshCanvasSlots();
    else render();
  }
});

// Drag and drop start from catalog
document.addEventListener("dragstart", (e) => {
  const item = e.target.closest(".widget-catalog-item");
  if (item && e.dataTransfer) {
    const type = item.dataset.widgetType || "text";
    e.dataTransfer.setData("application/x-widget-type", type);
  }
});

// PostMessage Bridge listener from the preview iframe
if (typeof window !== "undefined") {
  window.addEventListener("message", async (e) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.action === "frame:ready") {
      detectedSlots = Array.isArray(data.slots) ? data.slots : [];
      return;
    }
    if (data.action === "widget:drop") {
      const type = data.type || "text";
      const slot = data.slot || "sidebar";
      const v = await openWidgetDialog(null, slot, type);
      if (!v) return;
      const payload = { widget_type: v.widget_type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(v.widget_type, v) };
      try {
        await api(scoped("widgets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast(t("core.widgets.added", "Widget added"));
      } catch (err) {
        toast(err?.message || "Failed to add widget", "error");
      }
      refreshCanvasSlots();
      return;
    }
    if (data.action === "widget:edit") {
      const existing = await findWidget(data.widgetId);
      if (!existing) {
        toast(t("core.widgets.notFound", "Widget not found or already removed"), "error");
        refreshCanvasSlots();
        return;
      }
      const v = await openWidgetDialog(existing);
      if (!v) return;
      const payload = { widget_type: v.widget_type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(v.widget_type, v) };
      try {
        await api(scoped(`widgets/${existing.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast(t("core.widgets.saved", "Widget saved"));
      } catch (err) {
        toast(err?.message || "Failed to save widget", "error");
      }
      refreshCanvasSlots();
      return;
    }
    if (data.action === "widget:delete") {
      const w = await findWidget(data.widgetId);
      const okDel = await confirmDialog({
        title: t("core.widgets.deleteTitle", "Delete widget “{name}”?", { name: w?.title || data.widgetId }),
        confirmLabel: t("core.action.delete", "Delete"),
      });
      if (!okDel) return;
      try {
        await api(scoped(`widgets/${data.widgetId}`), { method: "DELETE" });
        toast(t("core.widgets.deleted", "Widget deleted"));
      } catch (err) {
        if (err?.message?.includes("not found")) {
          toast(t("core.widgets.notFound", "Widget not found or already removed"), "info");
        } else {
          toast(err?.message || "Failed to delete widget", "error");
        }
      }
      refreshCanvasSlots();
      const ifr = document.querySelector("#canvas-iframe");
      if (ifr?.contentWindow) {
        ifr.contentWindow.postMessage({ action: "canvas:remove-widget-dom", widgetId: data.widgetId }, "*");
      }
      return;
    }
    if (data.action === "slot:add") {
      const slot = data.slot || "sidebar";
      const v = await openWidgetDialog(null, slot);
      if (!v) return;
      const payload = { widget_type: v.widget_type, title: v.title, sidebar: v.sidebar, locale: v.locale || "", config: configFor(v.widget_type, v) };
      try {
        await api(scoped("widgets"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        toast(t("core.widgets.added", "Widget added"));
      } catch (err) {
        toast(err?.message || "Failed to add widget", "error");
      }
      refreshCanvasSlots();
      return;
    }
    if (data.action === "navigate") {
      if (data.url && typeof data.url === "string") {
        previewPath = data.url;
        const input = document.querySelector("#canvas-path-input");
        if (input) input.value = previewPath;
        const sel = document.querySelector("#canvas-page-select");
        if (sel) {
          const matchOpt = Array.from(sel.options).find((o) => o.value === previewPath);
          if (matchOpt) sel.value = previewPath;
        }
        reloadCanvasIframe();
      }
    }
  });
}
