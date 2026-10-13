/**
 * Block attributes in the editor: the controls, and the tree addressing they
 * need.
 *
 * ## Why this module exists
 *
 * The editor used to render one `<textarea>` per block and write `attrs.text`
 * regardless of type. The renderer reads `url` / `alt` for an image, `items`
 * for a gallery, `html` for raw HTML and nested `content` for group/columns —
 * so **six of the twelve block types produced empty output at HTTP 200** when
 * inserted from the admin. Nothing failed: not the manifest validator, not the
 * architecture suite, not the screen renderer, because the two sides never had
 * to agree on anything.
 *
 * They agree now. The attribute list is declared once in
 * `src/rendering/blocks.ts`, shipped by `GET /api/v1/blocks`, and consumed
 * here. `RENDERED_ATTR_TYPES` is compared against the contract's closed set by
 * `architecture.test.mjs` — a declared type with no branch here degrades to a
 * text input, which is how a declared media field silently becomes a URL box.
 *
 * ## Why the tree helpers live here too
 *
 * A control is only useful if the value it writes lands on the block it was
 * drawn for. Nested blocks (group / columns) mean that is a *path* question,
 * and getting it wrong is invisible in the same way the original defect was:
 * the editor looks right and the content is wrong. So the addressing is a pure
 * function of `(blocks, path)` — no DOM, no state — and
 * `tests/suites/editor-blocks.test.mjs` drives it directly, then feeds the
 * result to the **real renderer**.
 *
 * ## Shape
 *
 * Leaf module: no state, no imports beyond the markup helpers.
 */
import { attr, esc } from "../ui.js";
import { t } from "./i18n.js";
import { mediaFieldHtml } from "./media-picker.js";

/** The attribute types this module renders a control for. Kept in the same
 *  order as `BLOCK_ATTR_TYPES` in `src/rendering/blocks.ts` so a reader can
 *  compare the two lists by eye as well as by test. */
export const RENDERED_ATTR_TYPES = ["text", "textarea", "url", "media", "media-list"];

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * Split `"0.2"` into indices. An empty or malformed path addresses nothing,
 * which is why every helper below returns a falsy value rather than throwing:
 * a stale `data-*` path (a re-render raced a click) must not break the editor.
 */
function pathParts(path) {
  const parts = String(path ?? "").split(".").map((n) => Number(n));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return parts;
}

/** The block at `path`, or `null`. */
export function locateBlock(blocks, path) {
  const parts = pathParts(path);
  if (!parts) return null;
  let list = blocks;
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = Array.isArray(list) ? list[parts[i]] : null;
    if (!parent) return null;
    if (!Array.isArray(parent.content)) return null;
    list = parent.content;
  }
  const block = Array.isArray(list) ? list[parts[parts.length - 1]] : null;
  return block ?? null;
}

/** The array a path's last index lives in, plus that index. */
function holder(blocks, path) {
  const parts = pathParts(path);
  if (!parts) return null;
  let list = blocks;
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = Array.isArray(list) ? list[parts[i]] : null;
    if (!parent) return null;
    if (!Array.isArray(parent.content)) parent.content = [];
    list = parent.content;
  }
  if (!Array.isArray(list)) return null;
  return { list, index: parts[parts.length - 1] };
}

/** Insert `block` at `path` (or at the top level when `path` is null). Returns
 *  the block, or null when the path does not resolve. */
export function insertBlock(blocks, path, block) {
  if (path == null || path === "") { blocks.push(block); return block; }
  const found = holder(blocks, path);
  if (!found) return null;
  const parent = found.list[found.index];
  if (!parent) return null;
  if (!Array.isArray(parent.content)) parent.content = [];
  parent.content.push(block);
  return block;
}

export function removeBlockAt(blocks, path) {
  const found = holder(blocks, path);
  if (!found || found.index >= found.list.length) return false;
  found.list.splice(found.index, 1);
  return true;
}

export function duplicateBlockAt(blocks, path) {
  const found = holder(blocks, path);
  if (!found || found.index >= found.list.length) return false;
  found.list.splice(found.index + 1, 0, JSON.parse(JSON.stringify(found.list[found.index])));
  return true;
}

export function moveBlockAt(blocks, path, delta) {
  const found = holder(blocks, path);
  if (!found) return false;
  const to = found.index + Number(delta);
  if (!Number.isInteger(to) || to < 0 || to >= found.list.length) return false;
  [found.list[found.index], found.list[to]] = [found.list[to], found.list[found.index]];
  return true;
}

/** Write one attribute of the block at `path`. This is the function whose
 *  absence produced the defect: it used to be `attrs.text = value` for every
 *  type, so an image's `url` was never written. */
export function setAttrAt(blocks, path, key, value) {
  const block = locateBlock(blocks, path);
  if (!block || !key) return false;
  if (!block.attrs || typeof block.attrs !== "object") block.attrs = {};
  block.attrs[key] = value;
  return true;
}

/** Write one key of one item of a `media-list` attribute. */
export function setItemAt(blocks, path, key, index, itemKey, value) {
  const block = locateBlock(blocks, path);
  if (!block || !key || !itemKey) return false;
  if (!block.attrs || typeof block.attrs !== "object") block.attrs = {};
  if (!Array.isArray(block.attrs[key])) block.attrs[key] = [];
  const items = block.attrs[key];
  if (!items[index] || typeof items[index] !== "object") items[index] = {};
  items[index][itemKey] = value;
  return true;
}

export function addItemAt(blocks, path, key) {
  const block = locateBlock(blocks, path);
  if (!block || !key) return false;
  if (!block.attrs || typeof block.attrs !== "object") block.attrs = {};
  if (!Array.isArray(block.attrs[key])) block.attrs[key] = [];
  block.attrs[key].push({});
  return true;
}

/**
 * Append picked media to a `media-list` attribute.
 *
 * `itemKeys` is passed in rather than assumed: the item shape belongs to the
 * attribute's declaration (rule 61c), and a control that hardcodes `url`/`alt`
 * here would be the second list this repo keeps finding.
 */
export function appendMediaAt(blocks, path, key, itemKeys, sources) {
  const block = locateBlock(blocks, path);
  if (!block || !key || !Array.isArray(itemKeys) || !itemKeys.length) return false;
  if (!block.attrs || typeof block.attrs !== "object") block.attrs = {};
  if (!Array.isArray(block.attrs[key])) block.attrs[key] = [];
  for (const src of sources ?? []) {
    block.attrs[key].push(Object.fromEntries(itemKeys.map((k) => [k, src?.[k] ?? ""])));
  }
  return true;
}

export function removeItemAt(blocks, path, key, index) {
  const block = locateBlock(blocks, path);
  if (!block || !Array.isArray(block.attrs?.[key])) return false;
  block.attrs[key].splice(index, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A preview for a media value lives in `media-picker.js` — the control owns
 *  what a media value looks like, so there is exactly one answer to it. */

/**
 * A repeatable list of media items (one row per entry).
 *
 * Each row's URL goes through `mediaFieldHtml` — the same control a block's
 * `media` attribute and a settings field use — so "choose a file" behaves
 * identically in all three places. The row also carries the item index and item
 * key, which is what routes the picked value to the right entry rather than
 * over the whole list.
 */
function mediaListControl(field, attrs, path) {
  const keys = Array.isArray(field.itemKeys) ? field.itemKeys : [];
  const items = Array.isArray(attrs?.[field.key]) ? attrs[field.key] : [];
  const [urlKey, ...restKeys] = keys;
  const rows = items.map((item, i) => {
    const urlAttrs = `data-block-path="${attr(path)}" data-block-attr="${attr(field.key)}" data-block-item="${i}" data-item-key="${attr(urlKey)}"`;
    const rest = restKeys.map((k) => `<input data-block-path="${attr(path)}" data-block-attr="${attr(field.key)}"
      data-block-item="${i}" data-item-key="${attr(k)}" value="${attr(item?.[k] ?? "")}"
      placeholder="${attr(k)}" style="flex:1;margin-top:.375rem">`).join("");
    return `<div style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:.625rem">
      <div style="flex:1">
        ${mediaFieldHtml({ value: item?.[urlKey] ?? "", inputAttrs: urlAttrs })}
        ${rest}
      </div>
      <button type="button" class="btn ghost sm" data-block-item-del="${attr(path)}|${attr(field.key)}|${i}" title="Remove">×</button>
    </div>`;
  }).join("");
  return `<div class="field"><label${field.required ? ' class="req"' : ""}>${esc(attrLabel(field))}</label>
    ${rows || `<div class="muted text-sm" style="margin-bottom:.375rem">No items yet.</div>`}
    <div class="toolbar" style="gap:.375rem">
      <button type="button" class="btn outline sm" data-media-pick-many="${attr(path)}|${attr(field.key)}">${esc(t("core.media.choose", "Choose from library"))}</button>
      <button type="button" class="btn ghost sm" data-block-item-add="${attr(path)}|${attr(field.key)}">+ ${esc(t("core.media.addRow", "Add row"))}</button>
    </div></div>`;
}

/**
 * A field's visible label.
 *
 * `label` is what the API ships (translated); `fallback` is the contract's
 * English source string. Reading only `label` rendered an **empty** `<label>`
 * whenever the contract was used directly — which is what the round-trip suite
 * does, and what caught it. Falling back to the key means a control can never
 * render a label nobody can read.
 */
function attrLabel(field) {
  return field.label || field.fallback || field.key || "";
}

/** One attribute's control. */
export function renderBlockAttr(field, attrs, path) {
  const value = attrs?.[field.key];
  const label = `<label${field.required ? ' class="req"' : ""}>${esc(attrLabel(field))}</label>`;
  const common = `data-block-path="${attr(path)}" data-block-attr="${attr(field.key)}"`;
  switch (field.type) {
    case "text":
      return `<div class="field">${label}<input ${common} value="${attr(value ?? "")}"></div>`;
    case "textarea":
      return `<div class="field">${label}<textarea ${common}>${esc(value ?? "")}</textarea></div>`;
    case "url":
      return `<div class="field">${label}<input ${common} type="url" value="${attr(value ?? "")}" placeholder="https://"></div>`;
    case "media":
      // The shared control, not a bespoke URL box: the library, the upload and
      // the preview are the same everywhere (see `media-picker.js`).
      return mediaFieldHtml({ value, label: attrLabel(field), required: field.required, inputAttrs: common });
    case "media-list":
      return mediaListControl(field, attrs, path);
    default:
      // Unreachable while RENDERED_ATTR_TYPES covers the contract. The honest
      // answer if it ever does not is a text input, not a blank field — a
      // missing control must not look like a block with no attributes.
      return `<div class="field">${label}<input ${common} value="${attr(value ?? "")}"></div>`;
  }
}

/** Every declared attribute of one block, in contract order. */
export function renderBlockAttrs(spec, attrs, path) {
  const fields = Array.isArray(spec?.attrs) ? spec.attrs : [];
  if (!fields.length) return "";
  return fields.map((f) => renderBlockAttr(f, attrs, path)).join("");
}
