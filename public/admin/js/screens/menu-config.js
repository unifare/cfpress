/**
 * Screen: Menu configuration — ONE editor, every action on the row.
 *
 * Each item row carries all of it: ↑/↓ reorder, an eye toggle to hide/show
 * the item site-wide, and a pencil (or clicking the name) to open the inline
 * strip with per-language labels, the group selector and a per-item reset.
 * Groups get the same treatment on their header row. No prose on the page —
 * the controls are the documentation. Requires `settings.manage`; without it
 * the screen renders read-only with a single hint line (the server enforces
 * the permission regardless).
 *
 * Changes save immediately (one PUT per change). The strip being edited stays
 * open across the re-render (`openKey` / `openGroup`), so entering an English
 * and a Chinese label does not require reopening. Structural changes
 * (reorder / move between groups) materialize explicit `order` integers for
 * the whole model — see `applyMenuCustom` in nav.js, the single consumer.
 *
 * The per-user "my display preferences" panel is gone: hiding is one control
 * (the eye) in one place. The per-user prefs API and its effect on the
 * sidebar remain unchanged.
 */
import { api, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, confirmDialog, esc, attr, toast } from "../../ui.js";
import { t, currentLocale, UI_LANGUAGES } from "../i18n.js";
import { baseGroups, applyMenuCustom } from "../nav.js";

/** Working copy of the customization blob; reset from server state on mount. */
let draft = { items: {}, groups: {} };
/** applyMenuCustom(baseGroups(), draft) — the arrangement the editor shows. */
let applied = [];
/** Item / group whose inline editor is expanded (survives re-render). */
let openKey = null;
let openGroup = null;

function locale() { return currentLocale() || "en"; }

function rebuild() {
  applied = applyMenuCustom(baseGroups(), draft, locale());
}

/** Write explicit orders for every group and item into the draft. */
function materializeAll() {
  applied.forEach((g, gi) => {
    draft.groups[g.id] = { ...(draft.groups[g.id] || {}), order: gi };
    g.items.forEach((it, ii) => {
      draft.items[it.key] = { ...(draft.items[it.key] || {}), order: ii };
    });
  });
}

async function saveCustom() {
  try {
    const d = await api("admin-menus/custom", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (d.error) throw new Error(d.error);
    state.menuCustom = { items: d.items || {}, groups: d.groups || {} };
    rebuild(); // re-apply from the server-normalized copy
    await render();
  } catch (err) {
    await alertDialog({ title: t("core.menuConfig.title", "Menu"), description: err.message });
  }
}

function moveItem(key, dir) {
  const g = applied.find((gr) => gr.items.some((it) => it.key === key));
  if (!g) return;
  const idx = g.items.findIndex((it) => it.key === key);
  const to = dir === "up" ? idx - 1 : idx + 1;
  if (to < 0 || to >= g.items.length) return;
  [g.items[idx], g.items[to]] = [g.items[to], g.items[idx]];
  materializeAll();
  saveCustom();
}

/** Drop `key` right before `targetKey` — possibly into another group. */
function moveBefore(key, targetKey) {
  if (key === targetKey) return;
  const from = applied.find((gr) => gr.items.some((it) => it.key === key));
  const item = from?.items.find((it) => it.key === key);
  const to = applied.find((gr) => gr.items.some((it) => it.key === targetKey));
  if (!from || !item || !to) return;
  from.items.splice(from.items.indexOf(item), 1);
  to.items.splice(to.items.findIndex((it) => it.key === targetKey), 0, item);
  materializeAll();
  saveCustom();
}

function moveGroup(id, dir) {
  const idx = applied.findIndex((gr) => gr.id === id);
  const to = dir === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || to < 0 || to >= applied.length) return;
  [applied[idx], applied[to]] = [applied[to], applied[idx]];
  materializeAll();
  saveCustom();
}

/** Eye toggle: site-wide hidden. Un-hiding removes the flag instead of
 *  storing `hidden: false`, so a fully-reset item disappears from the blob. */
function toggleHidden(key) {
  const o = { ...(draft.items[key] || {}) };
  if (o.hidden === true) delete o.hidden;
  else o.hidden = true;
  if (Object.keys(o).length) draft.items[key] = o;
  else delete draft.items[key];
  saveCustom();
}

/** One compact label input per UI language, tagged with the language name. */
function labelInputs(kind, id, o, placeholder) {
  return UI_LANGUAGES.map(([code, name]) => {
    const dataAttr = kind === "item"
      ? `data-item-label="${attr(code)}" data-row-key="${attr(id)}"`
      : `data-group-label="${attr(code)}" data-group-id="${attr(id)}"`;
    const value = typeof (o.label || {})[code] === "string" ? o.label[code] : "";
    return `<div style="display:flex;gap:.5rem;align-items:center;flex:1;min-width:12rem">
      <span class="muted text-sm" style="flex:0 0 3.6rem">${esc(name)}</span>
      <input ${dataAttr} value="${attr(value)}" placeholder="${attr(placeholder)}" style="flex:1">
    </div>`;
  }).join("");
}

function itemEditor(it, g) {
  const o = draft.items[it.key] || {};
  const options = applied
    .map((gr) => `<option value="${attr(gr.id)}" ${gr.id === g.id ? "selected" : ""}>${esc(gr.label)}</option>`)
    .join("");
  return `<div style="border:1px dashed var(--border);border-radius:.5rem;padding:.6rem .75rem;margin:.25rem 0 .5rem 1.9rem;display:grid;gap:.5rem">
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">${labelInputs("item", it.key, o, it.title)}</div>
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <select data-item-group data-row-key="${attr(it.key)}" aria-label="${attr(t("core.menuConfig.group", "Group"))}">${options}</select>
      <button class="btn" data-item-reset="${attr(it.key)}">${icon("refresh")}${esc(t("core.menuConfig.resetItem", "Reset"))}</button>
      <span class="muted text-sm" style="margin-left:auto">${esc(it.key)}</span>
    </div>
  </div>`;
}

function itemRow(it, g, canManage) {
  const locked = it.key === "dashboard"; // escape hatch: never hidden, never moved
  const editable = canManage && !locked;
  const idx = g.items.indexOf(it);
  const hidden = it.siteHidden === true;
  const drag = editable
    ? `<span class="muted" draggable="true" style="cursor:grab;user-select:none">≡</span>`
    : `<span class="muted" style="width:.9rem"></span>`;
  const title = editable
    ? `<button data-item-edit="${attr(it.key)}" style="flex:1;text-align:left;background:none;border:none;cursor:pointer;color:inherit;padding:.15rem 0;font:inherit${hidden ? ";opacity:.55;text-decoration:line-through" : ""}">${esc(it.title)}</button>`
    : `<span style="flex:1${hidden ? ";opacity:.55;text-decoration:line-through" : ""}">${esc(it.title)}</span>`;
  const arrows = editable
    ? `<button class="icon-btn" data-item-move="up" data-row-key="${attr(it.key)}" ${idx === 0 ? "disabled" : ""} aria-label="Up">${icon("arrow-up")}</button>
       <button class="icon-btn" data-item-move="down" data-row-key="${attr(it.key)}" ${idx === g.items.length - 1 ? "disabled" : ""} aria-label="Down">${icon("arrow-down")}</button>`
    : "";
  const eye = editable
    ? `<button class="icon-btn" data-item-eye="${attr(it.key)}" title="${attr(hidden ? t("core.menuConfig.siteVisible", "Shown to everyone") : t("core.menuConfig.siteHidden", "Hidden for everyone"))}">${icon(hidden ? "eye-off" : "eye")}</button>`
    : "";
  const pencil = editable
    ? `<button class="icon-btn" data-item-edit="${attr(it.key)}" aria-label="Edit">${icon("pencil")}</button>`
    : "";
  const editor = openKey === it.key && editable ? itemEditor(it, g) : "";
  return `<div data-row-key="${attr(it.key)}" style="margin-bottom:.35rem">
    <div draggable="${editable}" style="display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;border:1px solid var(--border);border-radius:.5rem;background:var(--card)">
      ${drag}
      <span class="nav-icon" style="display:inline-flex;width:1.2rem">${icon(it.icon)}</span>
      ${title}
      ${arrows}${eye}${pencil}
    </div>
    ${editor}
  </div>`;
}

function groupPanel(g, gi, canManage) {
  const oc = draft.groups[g.id] || {};
  const labelEditor = openGroup === g.id && canManage
    ? `<div style="border:1px dashed var(--border);border-radius:.5rem;padding:.6rem .75rem;margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap">
        ${labelInputs("group", g.id, oc, g.label)}
      </div>`
    : "";
  const arrows = canManage
    ? `<button class="icon-btn" data-group-move="up" data-group="${attr(g.id)}" ${gi === 0 ? "disabled" : ""} aria-label="Up">${icon("arrow-up")}</button>
       <button class="icon-btn" data-group-move="down" data-group="${attr(g.id)}" ${gi === applied.length - 1 ? "disabled" : ""} aria-label="Down">${icon("arrow-down")}</button>`
    : "";
  const name = canManage
    ? `<button data-group-edit="${attr(g.id)}" style="font-weight:600;background:none;border:none;cursor:pointer;color:inherit;padding:0">${esc(g.label)}</button>`
    : `<span style="font-weight:600">${esc(g.label)}</span>`;
  const pencil = canManage
    ? `<button class="icon-btn" data-group-edit="${attr(g.id)}" aria-label="Edit">${icon("pencil")}</button>`
    : "";
  return `<div class="panel" style="margin-bottom:1rem">
    <div style="display:flex;align-items:center;gap:.35rem">
      ${arrows}
      ${name}
      ${pencil}
      <span class="muted text-sm" style="flex:1;text-align:right">${g.items.length}</span>
    </div>
    ${labelEditor}
    <div style="margin-top:.5rem">${g.items.map((it) => itemRow(it, g, canManage)).join("")}</div>
  </div>`;
}

export default async function menuConfig(c) {
  const canManage = state.menuCanManage === true;
  draft = JSON.parse(JSON.stringify(state.menuCustom || { items: {}, groups: {} }));
  rebuild();

  c.innerHTML = `${pageHead({
    title: t("core.menuConfig.title", "Menu"),
    actions: canManage ? `<button class="btn" data-action="menus-reset-all">${icon("refresh")}${esc(t("core.menuConfig.resetAll", "Reset to defaults"))}</button>` : "",
    crumbs: [{ label: t("core.menuConfig.title", "Menu") }],
  })}
  ${canManage ? "" : `<div class="muted text-sm" style="margin-bottom:.75rem">${esc(t("core.menuConfig.readonlyHint", "Read-only — editing the site menu needs the settings.manage permission."))}</div>`}
  ${applied.map((g, gi) => groupPanel(g, gi, canManage)).join("")}`;
}

// -- events (document-level, registered once; the screen re-renders freely) --

let dragKey = null;

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action],[data-item-edit],[data-item-move],[data-item-eye],[data-item-reset],[data-group-edit],[data-group-move]");
  if (!btn) return;
  const ds = btn.dataset;

  if (ds.action === "menus-reset-all") {
    const yes = await confirmDialog({
      title: t("core.menuConfig.resetAll", "Reset to defaults"),
      description: t("core.menuConfig.resetConfirm", "Clear all custom names, ordering and hiding?"),
      confirmLabel: t("core.menuConfig.resetAll", "Reset to defaults"),
    });
    if (!yes) return;
    try {
      await api("admin-menus/custom", { method: "DELETE" });
      state.menuCustom = { items: {}, groups: {} };
      openKey = openGroup = null;
      await render();
      toast(t("core.msg.saved", "Saved."));
    } catch (err) {
      await alertDialog({ title: t("core.menuConfig.title", "Menu"), description: err.message });
    }
    return;
  }
  if (ds.itemEye !== undefined && ds.itemEye !== "") {
    toggleHidden(ds.itemEye);
    return;
  }
  if (ds.itemEdit !== undefined && ds.itemEdit !== "") {
    openKey = openKey === ds.itemEdit ? null : ds.itemEdit;
    openGroup = null;
    await render();
    return;
  }
  if (ds.itemReset !== undefined && ds.itemReset !== "") {
    delete draft.items[ds.itemReset];
    await saveCustom();
    return;
  }
  if (ds.itemMove && ds.rowKey) {
    moveItem(ds.rowKey, ds.itemMove);
    return;
  }
  if (ds.groupEdit !== undefined && ds.groupEdit !== "") {
    openGroup = openGroup === ds.groupEdit ? null : ds.groupEdit;
    openKey = null;
    await render();
    return;
  }
  if (ds.groupMove && ds.group) {
    moveGroup(ds.group, ds.groupMove);
    return;
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (!el || !el.matches) return;
  if (!el.matches("[data-item-label],[data-item-group],[data-group-label]")) return;
  if (!draft) return;
  const rowKey = el.dataset.rowKey;

  if (el.matches("[data-item-label]") && rowKey) {
    const o = draft.items[rowKey] || (draft.items[rowKey] = {});
    const label = { ...(o.label || {}) };
    const v = el.value.trim();
    if (v) label[el.dataset.itemLabel] = v;
    else delete label[el.dataset.itemLabel];
    if (Object.keys(label).length) o.label = label;
    else delete o.label;
    if (!Object.keys(o).length) delete draft.items[rowKey];
    await saveCustom();
    return;
  }
  if (el.matches("[data-item-group]") && rowKey) {
    draft.items[rowKey] = { ...(draft.items[rowKey] || {}), group: el.value };
    materializeAll();
    await saveCustom();
    return;
  }
  if (el.matches("[data-group-label]")) {
    const gid = el.dataset.groupId;
    const o = draft.groups[gid] || (draft.groups[gid] = {});
    const label = { ...(o.label || {}) };
    const v = el.value.trim();
    if (v) label[el.dataset.groupLabel] = v;
    else delete label[el.dataset.groupLabel];
    if (Object.keys(label).length) o.label = label;
    else delete o.label;
    if (!Object.keys(o).length) delete draft.groups[gid];
    await saveCustom();
  }
});

document.addEventListener("keydown", (e) => {
  const el = e.target;
  // Enter commits a rename without requiring a click elsewhere — the change
  // event (and thus the save) fires on blur, Enter just gets there faster.
  if (el && el.matches && el.matches("[data-item-label],[data-group-label]") && e.key === "Enter") {
    e.preventDefault();
    el.blur();
  }
});

document.addEventListener("dragstart", (e) => {
  const row = e.target?.closest?.("[data-row-key][draggable='true']");
  if (row) {
    dragKey = row.dataset.rowKey;
    try { e.dataTransfer.setData("text/plain", dragKey); } catch { /* some targets */ }
  }
});
document.addEventListener("dragover", (e) => {
  const row = e.target?.closest?.("[data-row-key]");
  if (row && dragKey && row.dataset.rowKey !== dragKey) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const row = e.target?.closest?.("[data-row-key]");
  if (!row || !dragKey) { dragKey = null; return; }
  if (row.dataset.rowKey !== dragKey) {
    e.preventDefault();
    moveBefore(dragKey, row.dataset.rowKey);
  }
  dragKey = null;
});
