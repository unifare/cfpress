/**
 * Screen: Widgets — sidebar widgets rendered by the active theme.
 *
 * Supports two view modes:
 *   1. Visual Canvas (WYSIWYG layout with interactive slot anchors,
 *      draggable widget catalog, responsive device viewport, template selector,
 *      and in-place live bridge without iframe reloads).
 *   2. Classical List View (grouped tables by declared sidebars).
 *
 * Component Library Classification (dotnetcms parity):
 *   - All (全部)
 *   - Core (核心: text, html, recent-posts, menu, search, categories)
 *   - Theme (主题: theme declared blocks)
 *   - Plugin (插件: plugin provided widgets like adinsert)
 *   - Custom (自定义: user-defined widgets with template & schema)
 *
 * Widgets are grouped by the sidebars the active theme declares.
 * Site-scoped: every call goes through `scoped()`.
 */
import { adminBase, api, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { currentLocale, t } from "../i18n.js";
import { attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

const _t = (en, zh) => {
  const l = currentLocale();
  return l && l.toLowerCase().startsWith("zh") ? (zh || en) : en;
};

const TYPE_KEY = {
  text: "core.widgets.typeText",
  html: "core.widgets.typeHtml",
  "recent-posts": "core.widgets.typeRecent",
  menu: "core.widgets.typeMenu",
  "core.text": "core.widgets.typeText",
  "core.html": "core.widgets.typeHtml",
  "core.recent-posts": "core.widgets.typeRecent",
  "core.menu": "core.widgets.typeMenu",
  "core.search": "core.widgets.typeSearch",
  "core.categories": "core.widgets.typeCategories",
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

let currentCatalogFilter = "all"; // 'all' | 'core' | 'theme' | 'plugin' | 'custom'
let catalogSearchQuery = "";
let cachedWidgetTypes = [];

async function openCustomWidgetModal(existing = null) {
  const isEdit = !!existing;
  const res = await openDialog({
    title: isEdit ? _t("Edit Custom Widget Definition", "编辑自定义小部件定义") : _t("New Custom Widget Definition", "新建自定义小部件定义"),
    description: _t("Declare reusable custom widget with template and fields schema.", "创建可复用的自定义小部件，支持 HTML/模板代码与参数配置 Schema。"),
    confirmLabel: t("core.action.save", "Save"),
    fields: [
      { name: "name", label: _t("Widget Name", "部件名称"), value: existing?.name || "", placeholder: "促销横幅 / 公告", required: true },
      { name: "type", label: _t("Type Identifier (custom.*)", "类型标识 (需包含或以 custom. 开头)"), value: existing?.type || "", placeholder: "custom.promo_banner", disabled: isEdit, required: true },
      { name: "icon", label: _t("Icon Name", "图标名称"), value: existing?.icon || "puzzle", placeholder: "puzzle, layers, tag, search, star..." },
      { name: "description", label: _t("Description", "功能描述"), value: existing?.description || "", placeholder: "简述部件功能与展示场景" },
      { name: "template", label: _t("HTML / Template Code", "HTML / 模板代码"), type: "textarea", value: existing?.template || "", placeholder: `<div class="promo-box">\n  <h4>{{ title }}</h4>\n  <p>{{ content }}</p>\n</div>`, required: true },
      { name: "schema_json", label: _t("Fields Schema (JSON Array)", "配置字段 Schema (JSON 数组)"), type: "textarea", value: existing?.schema_json || `[\n  {"key":"title","label":"标题","type":"text","default":"热卖促销"},\n  {"key":"content","label":"内容","type":"textarea","default":""}\n]`, placeholder: `[{"key":"title","label":"标题","type":"text"}]` },
    ],
  });

  if (!res) return false;
  try {
    let schemaObj = [];
    try { schemaObj = JSON.parse(res.schema_json || "[]"); } catch {
      toast(_t("Invalid JSON in fields schema", "配置字段 Schema 必须是合法的 JSON 格式"), "error");
      return false;
    }

    if (isEdit) {
      await api(scoped(`widgets/custom-types/${existing.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: res.name,
          icon: res.icon,
          description: res.description,
          template: res.template,
          schema_json: JSON.stringify(schemaObj, null, 2),
        }),
      });
      toast(_t("Custom widget updated successfully", "自定义小部件定义已更新"));
    } else {
      await api(scoped("widgets/custom-types"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: res.name,
          type: res.type,
          icon: res.icon,
          description: res.description,
          template: res.template,
          schema_json: JSON.stringify(schemaObj, null, 2),
        }),
      });
      toast(_t("Custom widget created successfully", "自定义小部件已成功创建"));
    }
    render();
    return true;
  } catch (err) {
    toast(err?.message || "Failed to save custom widget", "error");
    return false;
  }
}

async function openWidgetDialog(existing, defaultSlot, defaultType) {
  const [sbs, menus, i18n, typesRes] = await Promise.all([
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
    api(scoped("menus")).catch(() => ({ items: [] })),
    api(scoped("i18n/locales")).catch(() => ({ enabled: [] })),
    api(scoped("widgets/types")).catch(() => ({ items: [] })),
  ]);

  const allTypes = (typesRes.items && typesRes.items.length) ? typesRes.items : cachedWidgetTypes;
  const sidebarOptions = (sbs.items || [{ id: "sidebar" }, { id: "footer" }]).map((s) => ({ value: s.id, label: s.label || s.id }));
  let cfg = {};
  try { cfg = existing ? JSON.parse(String(existing.config || "{}")) : {}; } catch { cfg = {}; }
  const menuList = menus.items || [];
  const menuOptions = menuList.map((m) => ({ value: m.id, label: m.name }));
  const chosenType = existing?.widget_type || defaultType || "core.text";
  const normType = chosenType.replace(/^core\./, "");

  const matchedDef = allTypes.find((t) => t.type === chosenType || t.type === normType) || null;

  // Build type options
  const typeOptions = (allTypes.length ? allTypes : [
    { type: "core.text", title: "Text", category: "core" },
    { type: "core.html", title: "Custom HTML", category: "core" },
    { type: "core.recent-posts", title: "Recent Posts", category: "core" },
    { type: "core.menu", title: "Menu", category: "core" },
    { type: "core.search", title: "Search", category: "core" },
    { type: "core.categories", title: "Categories", category: "core" },
  ]).map((t) => {
    const catLabel = t.category === "core" ? _t("Core", "核心")
      : t.category === "theme" ? _t("Theme", "主题")
      : t.category === "plugin" ? _t("Plugin", "插件")
      : _t("Custom", "自定义");
    return { value: t.type, label: `[${catLabel}] ${t.title || t.name} (${t.type})` };
  });

  const fields = [
    { name: "widget_type", label: t("core.widgets.fieldType", "Type"), type: "select", value: chosenType, options: typeOptions },
    { name: "title", label: t("core.widgets.fieldTitle", "Widget title"), value: existing?.title || "", placeholder: "About this site" },
    { name: "sidebar", label: t("core.widgets.fieldSidebar", "Sidebar"), type: "select", value: existing?.sidebar || defaultSlot || sidebarOptions[0]?.value || "sidebar", options: sidebarOptions },
    { name: "locale", label: t("core.widgets.fieldLocale", "Language"), type: "select", value: existing?.locale || "", options: [{ value: "", label: t("core.widgets.localeAll", "All languages") }, ...(i18n.enabled || []).map((l) => ({ value: l, label: l }))] },
  ];

  if (normType === "text" || normType === "html") {
    fields.push({ name: "body", label: `${t("core.widgets.fieldBody", "Content")} — ${normType === "html" ? "HTML" : "Text"}`, type: "textarea", value: cfg.body || "", placeholder: "…" });
  } else if (normType === "recent-posts") {
    fields.push({ name: "count", label: `${t("core.widgets.fieldCount", "Number of posts")}`, type: "number", value: cfg.count ?? 5 });
  } else if (normType === "menu") {
    fields.push({ name: "menu_id", label: `${t("core.widgets.fieldMenu", "Menu to render")}`, type: "select", value: cfg.menu_id || (menuOptions[0]?.value || ""), options: menuOptions });
  } else if (normType === "search") {
    fields.push({ name: "placeholder", label: _t("Placeholder Text", "搜索框提示文字"), type: "text", value: cfg.placeholder || "Search..." });
  } else if (normType === "categories") {
    fields.push({ name: "show_count", label: _t("Show Count (1/0)", "显示文章数量 (1/0)"), type: "number", value: cfg.show_count ?? 1 });
  } else if (chosenType.startsWith("custom.") && matchedDef) {
    for (const f of matchedDef.fields || []) {
      if (f.name === "title" || f.key === "title") continue;
      const fKey = f.name || f.key;
      const fLabel = f.label || fKey;
      const fType = f.type === "textarea" ? "textarea" : f.type === "number" ? "number" : "text";
      fields.push({ name: fKey, label: fLabel, type: fType, value: cfg[fKey] ?? (f.default ?? "") });
    }
  } else if (chosenType === "plugin.adinsert") {
    fields.push({ name: "block_no", label: _t("Ad Block Number (1-16)", "广告代码块编号 (1-16)"), type: "number", value: cfg.block_no ?? 1 });
  }

  const res = await openDialog({
    title: existing ? t("core.widgets.editTitle", "Edit widget") : t("core.widgets.addTitle", "Add a widget"),
    description: t("core.widgets.bodyHint", "Text is escaped; HTML is inserted as-is"),
    confirmLabel: t("core.action.save", "Save"),
    fields,
  });

  if (!res) return null;
  if ((res.widget_type === "menu" || res.widget_type === "core.menu") && !res.menu_id) {
    toast(t("core.widgets.menuRequired", "Please select a menu to display, or create one under Appearance -> Menus first."), "error");
    return null;
  }
  return res;
}

/** The config half of a dialog result, per chosen type. */
function configFor(type, v) {
  const norm = type.replace(/^core\./, "");
  if (norm === "text" || norm === "html") return { body: v.body || "" };
  if (norm === "recent-posts") return { count: Math.max(1, Math.min(20, Number(v.count) || 5)) };
  if (norm === "menu") return { menu_id: v.menu_id || "" };
  if (norm === "search") return { placeholder: v.placeholder || "Search..." };
  if (norm === "categories") return { show_count: Number(v.show_count) || 1 };
  if (type === "plugin.adinsert") return { block_no: Math.max(1, Math.min(16, Number(v.block_no) || 1)) };

  const cfg = {};
  for (const [k, val] of Object.entries(v)) {
    if (!["widget_type", "title", "sidebar", "locale"].includes(k)) {
      cfg[k] = val;
    }
  }
  return cfg;
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
  updateSlotCounts();
}

async function updateSlotCounts() {
  try {
    const d = await api(scoped("widgets"));
    const items = d.items || [];
    const summary = document.querySelector("#canvas-slots-summary");
    if (summary) {
      summary.querySelectorAll("[data-slot-summary-id]").forEach((el) => {
        const sid = el.getAttribute("data-slot-summary-id");
        const count = items.filter((w) => (w.sidebar || "sidebar") === sid).length;
        const badge = el.querySelector(".badge");
        if (badge) badge.textContent = count;
      });
    }
  } catch {}
}

export default async function widgets(c) {
  const [d, sbs, widgetTypesRes, pagesRes, routesRes] = await Promise.all([
    api(scoped("widgets")),
    api(scoped("theme/sidebars")).catch(() => ({ items: [{ id: "sidebar" }, { id: "footer" }] })),
    api(scoped("widgets/types")).catch(() => ({ items: [] })),
    api(scoped("content?type=page&limit=50")).catch(() => ({ items: [] })),
    api(scoped("theme/routes")).catch(() => ({ items: [] })),
  ]);
  const items = d.items || [];
  const declared = sbs.items || [{ id: "sidebar" }, { id: "footer" }];
  const groups = [...declared.map((s) => s.id), ...[...new Set(items.map((w) => w.sidebar))].filter((sb) => !declared.some((s) => s.id === sb))];

  const typeLabel = (w) => {
    const norm = (w.widget_type || "text").replace(/^core\./, "");
    if (TYPE_KEY[norm]) return esc(t(TYPE_KEY[norm], norm));
    if (String(w.widget_type).startsWith("custom.")) return `<span style="color:#10b981;">[${_t("Custom", "自定义")}]</span> ${esc(w.title || w.widget_type)}`;
    if (String(w.widget_type).startsWith("theme.")) return `<span style="color:#6366f1;">[${_t("Theme", "主题")}]</span> ${esc(w.title || w.widget_type)}`;
    if (String(w.widget_type).startsWith("plugin.")) return `<span style="color:#0284c7;">[${_t("Plugin", "插件")}]</span> ${esc(w.title || w.widget_type)}`;
    return esc(w.widget_type);
  };

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
        { type: "core.text", title: "Text", description: "Arbitrary text", icon: "file-text", category: "core" },
        { type: "core.html", title: "Custom HTML", description: "Custom HTML / embed code", icon: "puzzle", category: "core" },
        { type: "core.recent-posts", title: "Recent Posts", description: "List of latest posts", icon: "layers", category: "core" },
        { type: "core.menu", title: "Navigation Menu", description: "Site navigation menu", icon: "menu", category: "core" },
        { type: "core.search", title: "Search Bar", description: "Site search box", icon: "search", category: "core" },
        { type: "core.categories", title: "Categories", description: "Post categories", icon: "tag", category: "core" },
      ];
  cachedWidgetTypes = catalogTypes;

  const filteredCatalog = catalogTypes.filter((item) => {
    const cat = item.category || (
      item.type.startsWith("core.") ? "core" :
      item.type.startsWith("custom.") ? "custom" :
      item.type.startsWith("theme.") ? "theme" : "plugin"
    );
    if (currentCatalogFilter !== "all" && cat !== currentCatalogFilter) return false;
    if (catalogSearchQuery) {
      const q = catalogSearchQuery.toLowerCase();
      const match = (item.title || "").toLowerCase().includes(q) ||
                    (item.name || "").toLowerCase().includes(q) ||
                    (item.type || "").toLowerCase().includes(q) ||
                    (item.description || "").toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  const catalogHtml = filteredCatalog.length ? filteredCatalog.map((item) => {
    const cat = item.category || (
      item.type.startsWith("core.") ? "core" :
      item.type.startsWith("custom.") ? "custom" :
      item.type.startsWith("theme.") ? "theme" : "plugin"
    );
    let badgeHtml = `<span class="badge outline" style="font-size:10px;">${_t("Core", "核心")}</span>`;
    if (cat === "theme") badgeHtml = `<span class="badge primary" style="font-size:10px;">${_t("Theme", "主题")}</span>`;
    else if (cat === "plugin") badgeHtml = `<span class="badge" style="background:#0284c7;color:#fff;font-size:10px;">${_t("Plugin", "插件")}</span>`;
    else if (cat === "custom") badgeHtml = `<span class="badge success" style="font-size:10px;">${_t("Custom", "自定义")}</span>`;

    const isCustom = cat === "custom";

    return `
      <div class="widget-catalog-item" draggable="true" data-widget-type="${attr(item.type)}" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--card-bg, #fff);display:flex;flex-direction:column;gap:6px;cursor:grab;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.03);user-select:none;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="display:inline-flex;color:var(--primary);">${icon(item.icon || "puzzle")}</span>
            <div>
              <div style="font-weight:600;font-size:13px;line-height:1.2;">${esc(item.title || item.name)}</div>
              <div style="font-family:monospace;font-size:10px;color:var(--muted);">${esc(item.type)}</div>
            </div>
          </div>
          <div>${badgeHtml}</div>
        </div>

        ${item.description ? `<div style="font-size:11px;color:var(--muted);line-height:1.3;">${esc(item.description)}</div>` : ""}

        <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:2px;">
          ${isCustom ? `
            <button type="button" class="btn outline sm" data-action="edit-custom-widget" data-id="${attr(item.id)}" title="${_t("Edit definition", "编辑部件定义")}" style="padding:2px 6px;">${icon("pencil")}</button>
            <button type="button" class="btn outline danger sm" data-action="del-custom-widget" data-id="${attr(item.id)}" title="${_t("Delete definition", "删除部件定义")}" style="padding:2px 6px;">${icon("trash")}</button>
          ` : ""}
          <button type="button" class="btn outline sm" data-action="quick-add-widget" data-type="${attr(item.type)}" title="${esc(t("core.widgets.add", "Add widget"))}" style="padding:2px 8px;font-size:11px;">
            ${icon("plus")} ${_t("Add", "添加")}
          </button>
        </div>
      </div>
    `;
  }).join("") : `<div style="text-align:center;padding:1.5rem 0.5rem;color:var(--muted);font-size:12px;">${_t("No matching widgets found.", "暂无匹配的小部件。")}</div>`;

  const slotsList = (detectedSlots.length ? detectedSlots : groups.map((g) => ({ id: g, label: g }))).map((s) => {
    const sId = typeof s === "string" ? s : s.id;
    const count = items.filter((w) => (w.sidebar || "sidebar") === sId).length;
    return `<div data-slot-summary-id="${attr(sId)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px;">
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
      <div style="width:310px;flex-shrink:0;display:flex;flex-direction:column;gap:14px;">
        <div class="panel" style="padding:14px;">
          <!-- Top Bar: Title, Count, New Custom Widget Button -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div class="card-title" style="font-size:14px;margin-bottom:0;display:flex;align-items:center;">
              ${esc(t("core.widgets.catalog", "Widget catalog"))}
              <span class="badge" style="margin-left:6px;font-size:11px;">${filteredCatalog.length}</span>
            </div>
            <button type="button" class="btn outline sm" data-action="new-custom-widget" style="padding:2px 8px;font-size:11px;">
              ${icon("plus")} ${_t("New Custom Widget", "新建自定义部件")}
            </button>
          </div>

          <!-- Search box -->
          <div style="position:relative;margin-bottom:8px;">
            <input type="text" id="widget-search" class="input sm" placeholder="${_t("Search widgets...", "搜索部件名称或标识...")}" value="${esc(catalogSearchQuery)}" style="width:100%;padding-right:24px;font-size:12px;" />
            ${catalogSearchQuery ? `<span data-action="clear-widget-search" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted);font-size:14px;line-height:1;">×</span>` : ""}
          </div>

          <!-- Category Tabs: 全部 / 核心 / 主题 / 插件 / 自定义 -->
          <div class="widget-cat-tabs" style="display:flex;gap:4px;margin-bottom:12px;background:var(--muted-bg, #f1f5f9);padding:3px;border-radius:6px;font-size:11px;">
            <button type="button" class="btn sm ${currentCatalogFilter === "all" ? "primary" : "text"}" data-action="filter-cat" data-cat="all" style="flex:1;padding:3px 2px;text-align:center;">${_t("All", "全部")}</button>
            <button type="button" class="btn sm ${currentCatalogFilter === "core" ? "primary" : "text"}" data-action="filter-cat" data-cat="core" style="flex:1;padding:3px 2px;text-align:center;">${_t("Core", "核心")}</button>
            <button type="button" class="btn sm ${currentCatalogFilter === "theme" ? "primary" : "text"}" data-action="filter-cat" data-cat="theme" style="flex:1;padding:3px 2px;text-align:center;">${_t("Theme", "主题")}</button>
            <button type="button" class="btn sm ${currentCatalogFilter === "plugin" ? "primary" : "text"}" data-action="filter-cat" data-cat="plugin" style="flex:1;padding:3px 2px;text-align:center;">${_t("Plugin", "插件")}</button>
            <button type="button" class="btn sm ${currentCatalogFilter === "custom" ? "primary" : "text"}" data-action="filter-cat" data-cat="custom" style="flex:1;padding:3px 2px;text-align:center;">${_t("Custom", "自定义")}</button>
          </div>

          <div class="widget-catalog-list" style="max-height:calc(100vh - 360px);overflow-y:auto;">
            ${catalogHtml}
          </div>
        </div>

        <div class="panel" style="padding:14px;">
          <div class="card-title" style="margin-bottom:8px;font-size:14px;">${esc(t("core.widgets.activeSlots", "Page slots"))}</div>
          <div style="display:flex;flex-direction:column;" id="canvas-slots-summary">
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
    actions: `${viewToggleButtons}<button class="btn outline sm" data-action="new-custom-widget" style="margin-right:8px;">${icon("puzzle")}${_t("Custom Widget", "自定义小部件")}</button><button class="btn primary sm" data-action="new-widget">${icon("plus")}${esc(t("core.widgets.add", "Add widget"))}</button>`,
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

// Global change & input delegation
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "canvas-page-select") {
    previewPath = e.target.value || "/";
    const input = document.querySelector("#canvas-path-input");
    if (input) input.value = previewPath;
    reloadCanvasIframe();
  }
});

document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "widget-search") {
    catalogSearchQuery = e.target.value || "";
    render();
  }
});

// Global click delegation
document.addEventListener("click", async (e) => {
  // Category tabs filter
  const catBtn = e.target.closest("[data-action=filter-cat]");
  if (catBtn) {
    currentCatalogFilter = catBtn.dataset.cat || "all";
    render();
    return;
  }

  // Clear search
  if (e.target.closest("[data-action=clear-widget-search]")) {
    catalogSearchQuery = "";
    render();
    return;
  }

  // New Custom Widget Definition
  if (e.target.closest("[data-action=new-custom-widget]")) {
    await openCustomWidgetModal();
    return;
  }

  // Edit Custom Widget Definition
  const editCustomBtn = e.target.closest("[data-action=edit-custom-widget]");
  if (editCustomBtn) {
    const id = editCustomBtn.dataset.id;
    const item = cachedWidgetTypes.find((t) => t.id === id);
    if (item) await openCustomWidgetModal(item);
    return;
  }

  // Delete Custom Widget Definition
  const delCustomBtn = e.target.closest("[data-action=del-custom-widget]");
  if (delCustomBtn) {
    const id = delCustomBtn.dataset.id;
    const okDel = await confirmDialog({
      title: _t("Delete custom widget definition?", "确定要删除此自定义小部件定义吗？"),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!okDel) return;
    try {
      await api(scoped(`widgets/custom-types/${id}`), { method: "DELETE" });
      toast(_t("Custom widget definition deleted", "自定义小部件定义已删除"));
      render();
    } catch (err) {
      toast(err?.message || "Failed to delete custom widget definition", "error");
    }
    return;
  }

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
    const type = quickAddBtn.dataset.type || "core.text";
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
    const type = item.dataset.widgetType || "core.text";
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
      const type = data.type || "core.text";
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
