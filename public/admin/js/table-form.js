/**
 * Generated admin forms for theme-owned tables (ARCHITECTURE.md §3.5).
 *
 * The promise of a declarative table is that a theme gets a working list and
 * edit form **without shipping admin code**. That only holds if the form is
 * built from `tables[].fields[]` rather than hand-written per theme — so this
 * module is the single place a declared field type becomes an input control,
 * and the single place a control's value becomes a value the API will accept.
 *
 * Keeping the two directions (`fieldControl` and `collectForm`) in one file is
 * deliberate: a field type added to one but not the other produces a form that
 * renders and then silently drops what the user typed.
 *
 * Not a screen. It lives outside `js/screens/` because two screens use it, and
 * screens may not import each other.
 */
import { attr, esc } from "../ui.js";

/** The six types `ALLOWED_TABLE_FIELD_TYPES` accepts, mapped to a control. */
const CONTROL = {
  text: "text",
  longtext: "textarea",
  number: "number",
  boolean: "checkbox",
  date: "date",
  datetime: "datetime-local",
};

/** epoch seconds → the `YYYY-MM-DDTHH:MM` a `datetime-local` input expects. */
export function toLocalInput(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The inverse. `datetime` columns are INTEGER epoch seconds everywhere else. */
export function fromLocalInput(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function isTruthy(v) {
  return v === 1 || v === "1" || v === true || v === "true";
}

/** One labelled control for a declared field. */
export function fieldControl(field, value) {
  const key = String(field.key);
  const label = String(field.label || field.key);
  const type = String(field.type || "text");
  const control = CONTROL[type] || "text";
  const required = field.required ? " required" : "";

  if (control === "textarea") {
    return `<div class="field"><label>${esc(label)}</label><textarea data-tf="${attr(key)}" rows="4"${required}>${esc(value ?? "")}</textarea></div>`;
  }
  if (control === "checkbox") {
    return `<div class="field"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" data-tf="${attr(key)}"${isTruthy(value) ? " checked" : ""}> ${esc(label)}</label></div>`;
  }
  if (control === "datetime-local") {
    return `<div class="field"><label>${esc(label)}</label><input type="datetime-local" data-tf="${attr(key)}" value="${attr(toLocalInput(value))}"${required}></div>`;
  }
  return `<div class="field"><label>${esc(label)}</label><input type="${control}" data-tf="${attr(key)}" value="${attr(value ?? "")}"${required}></div>`;
}

/**
 * Read a form back into an API payload.
 *
 * Only declared fields are collected. The API would filter them anyway
 * (`writableFields`), but doing it here means a stray `data-tf` in some future
 * markup cannot become a write.
 */
export function collectForm(root, fields) {
  const out = {};
  const controls = new Map();
  for (const el of root.querySelectorAll("[data-tf]")) controls.set(el.dataset.tf, el);

  for (const field of fields) {
    const key = String(field.key);
    const el = controls.get(key);
    if (!el) continue;
    const type = String(field.type || "text");
    if (type === "boolean") out[key] = el.checked ? 1 : 0;
    else if (type === "number") out[key] = el.value === "" ? null : Number(el.value);
    else if (type === "datetime") out[key] = fromLocalInput(el.value);
    else out[key] = el.value === "" ? null : el.value;
  }
  return out;
}

/** A short, readable rendering of one stored value for the list view. */
export function formatValue(field, value) {
  if (value === undefined || value === null || value === "") return "—";
  const type = String(field.type || "text");
  if (type === "boolean") return isTruthy(value) ? "Yes" : "No";
  if (type === "datetime") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : String(value);
  }
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** A `slug` control is always present but is not a declared field. */
export function slugControl(value) {
  return `<div class="field"><label>Slug</label><input type="text" data-tf="slug" value="${attr(value ?? "")}" required></div>`;
}

export function statusControl(value) {
  const current = String(value ?? "draft");
  const options = ["draft", "publish", "private"];
  return `<div class="field"><label>Status</label><select data-tf="status">${options
    .map((o) => `<option value="${attr(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`)
    .join("")}</select></div>`;
}
