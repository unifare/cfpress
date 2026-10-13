/**
 * Screen: a declared admin menu (`menu:<id>` pages).
 *
 * Any extension may declare a menu with a `screen` type; the platform renders
 * it. This is the single dispatcher for those pages, which is why it reads from
 * the *unified* menu list rather than from theme menus only — a plugin menu and
 * a theme menu are the same kind of object, and splitting the renderer by owner
 * would mean writing every new screen type twice.
 */
import { api, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast } from "../../ui.js";
import { mediaFieldHtml } from "../media-picker.js";
import { contentList } from "./content-list.js";
import { tableListScreen } from "./table-list.js";
import { tableEditScreen } from "./table-edit.js";

/** Find a declared menu by its id, whatever owner declared it. */
function findMenu(menuId) {
  return (
    state.adminMenus.find((x) => x.menu_id === menuId) ||
    state.themeMenus.find((x) => x.menu_id === menuId) ||
    null
  );
}

function unknownScreen(c, m, menuId) {
  const owner = m.owner_type === "plugin" ? `plugin ${m.owner_name}` : "the active theme";
  c.innerHTML = `${pageHead({
    title: m.label || menuId,
    sub: `Declared by ${owner}`,
    crumbs: [{ label: m.owner_type === "plugin" ? "Extensions" : "From theme" }, { label: m.label || menuId }],
  })}
  <div class="panel">
    <div class="card-title">Screen declaration</div>
    <div class="card-desc" style="margin-bottom:.75rem">CFPress does not have a built-in renderer for this screen type yet.</div>
    <pre class="code">${esc(JSON.stringify({ screen: m.screen, args: m.args }, null, 2))}</pre>
  </div>`;
}

/**
 * One control per declared setting, keyed by the type the manifest declared
 * (`ALLOWED_FIELD_TYPES` — the same closed set the field validator enforces).
 * Every declared type must have a branch here; the architecture test walks
 * the type list against this renderer, so a new type without a branch is a
 * red suite, not a silently text-only form.
 */
function settingControl(x) {
  const name = `data-ts-key="${attr(x.key)}"`;
  const val = x.value ?? "";
  switch (x.type) {
    case "textarea":
    case "richtext":
      return `<textarea ${name} rows="4">${esc(val)}</textarea>`;
    case "number":
      return `<input type="number" ${name} value="${attr(val)}">`;
    case "boolean":
      return `<input type="checkbox" ${name}${String(val) === "true" ? " checked" : ""}>`;
    case "color":
      return `<input type="color" ${name} value="${attr(val)}">`;
    case "date":
      return `<input type="date" ${name} value="${attr(val)}">`;
    case "datetime":
      return `<input type="datetime-local" ${name} value="${attr(val)}">`;
    case "url":
      return `<input type="url" ${name} value="${attr(val)}">`;
    case "email":
      return `<input type="email" ${name} value="${attr(val)}">`;
    case "select":
    {
      const opts = Array.isArray(x.options) ? x.options : [];
      return `<select ${name}>${opts.map((o) => `<option${String(o) === String(val) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    case "media":
    case "media-multiple":
      // The shared control. This used to be a bare text input whose only hint
      // was "URL in the media library" — the author had to know the library
      // existed, find the file, and paste a URL by hand.
      return mediaFieldHtml({
        value: val,
        multiple: x.type === "media-multiple",
        inputAttrs: name,
      });
    case "text":
    default:
      return `<input type="text" ${name} value="${attr(val)}">`;
  }
}

async function extensionSettings(c, m, kind) {
  const owner = m.owner_name;
  const path = kind === "plugin"
    ? `extensions/plugins/${encodeURIComponent(owner)}/settings`
    : `theme/${encodeURIComponent(owner)}/settings`;
  const d = await api(path);
  const fields = d.items || [];
  const title = m.label || (kind === "plugin" ? "Plugin Settings" : "Theme Settings");
  c.innerHTML = `${pageHead({
    title,
    sub: `Declared by ${owner}`,
    actions: `<button class="btn primary" data-save-theme-settings="${attr(owner)}" data-settings-kind="${attr(kind)}">${icon("save")}Save</button>`,
    crumbs: [{ label: kind === "plugin" ? "Extensions" : "Appearance" }, { label: title }],
  })}
  <div class="panel">
    ${fields.map((x) => `<div class="field"><label>${esc(x.label || x.key)}</label>${settingControl(x)}</div>`).join("")
      || `<div class="empty">This ${kind} declares no settings.</div>`}
  </div>`;
}

export default async function themeMenuScreen(c, menuId) {
  const m = findMenu(menuId);
  if (!m) { c.innerHTML = `<div class="panel">Unknown screen.</div>`; return; }
  const args = m.args || {};
  const table = String(args.table || "");

  if (m.screen === "content-list") {
    return contentList(c, String(args.type || menuId));
  }

  // A `table-list` menu opens the generated list; `table-edit` opens the
  // generated form directly. Both are the same table, reached at two depths —
  // which is why the shell's `table:` prefix carries an optional slug.
  if (m.screen === "table-list") {
    return tableListScreen(c, table);
  }
  if (m.screen === "table-edit") {
    return tableEditScreen(c, table, null);
  }

  if (m.screen === "theme-settings") {
    return extensionSettings(c, m, "theme");
  }
  if (m.screen === "plugin-settings") {
    return extensionSettings(c, m, "plugin");
  }

  // Unknown screen type: show the declaration so it is not a dead end.
  unknownScreen(c, m, menuId);
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-save-theme-settings]");
  if (!a) return;
  const owner = a.dataset.saveThemeSettings;
  const kind = a.dataset.settingsKind || "theme";
  const base = kind === "plugin"
    ? `extensions/plugins/${encodeURIComponent(owner)}/settings`
    : `theme/${encodeURIComponent(owner)}/settings`;
  for (const el of document.querySelectorAll("[data-ts-key]")) {
    // A checkbox's `value` never changes — the saved fact is whether it is
    // checked, stored as the string the boolean branch reads back.
    const value = el.type === "checkbox" ? String(el.checked) : el.value;
    await api(base, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: el.dataset.tsKey, value }),
    });
  }
  toast(kind === "plugin" ? "Plugin settings saved" : "Theme settings saved");
});
