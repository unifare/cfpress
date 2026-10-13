/**
 * Screen: content editor — title/slug/status panel, block editor, theme-declared
 * custom fields, autosave and revisions.
 *
 * Everything interactive is wired through document-level delegation so a
 * re-render (which replaces the whole subtree) never drops a handler.
 */
import { api, contentPath, postTypeInfo, scoped, state, stopAutosave } from "../state.js";
import { go, pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import {
  addItemAt, appendMediaAt, duplicateBlockAt, insertBlock, locateBlock, moveBlockAt,
  removeBlockAt, removeItemAt, renderBlockAttrs, setAttrAt, setItemAt,
} from "../block-fields.js";
import { mediaFieldHtml, openMediaPicker } from "../media-picker.js";
import { fromLocalInput, toLocalInput } from "../table-form.js";
import { t } from "../i18n.js";
import { alertDialog, attr, confirmDialog, esc, fmtDate, openDialog, toast } from "../../ui.js";

export function newContent(type) {
  state.editing = {
    id: null, slug: "", title: "", excerpt: "", locale: state.defaultLocale,
    status: "draft", content: "[]", meta: {}, publish_at: null,
  };
  state.type = type;
  render();
}

export async function editContent(type, id, wantLocale) {
  const d = await api(scoped(contentPath(type) + "/" + id));
  const items = d.items || [];
  // Rows arrive ordered default-language-first, but "first" must not be the
  // editor's only answer to "which language am I editing": the version bar
  // asks for a specific one, and a shared-row post (one `posts` row, one
  // translation row per language) carries *every* language's content in this
  // one response. Pick the requested language; fall back to the first row.
  const x = (wantLocale ? items.find((i) => i.locale === wantLocale) : null) || items[0] || {};
  state.editing = {
    // `slug_own` is this language's own URL segment (NULL = follows the
    // main-table slug); `slug` is always the row's main-table value.
    id, slug: x.slug_own || x.slug || "", title: x.title || "", excerpt: x.excerpt || "",
    locale: x.locale || state.defaultLocale, status: x.status || "draft",
    content: x.content || "[]", meta: x.meta || {},
    // Carried so the editor can show the existing schedule. It used to be
    // dropped on the floor: opening a scheduled post and saving it silently
    // cancelled the schedule, because `#publishAt` rendered empty and the save
    // sent `publish_at: null`.
    publish_at: x.publish_at ?? null,
  };
  state.type = type;
  render();
}

/**
 * Every language version of this content, or null when there is only one
 * language to worry about.
 *
 * Fetched for the editor's language bar. `versions` carries one entry per
 * *enabled site locale* — including the ones that do not exist yet, because
 * those are exactly what the bar has to offer.
 */
async function loadVersions(id) {
  if (!id) return null;
  // Only trust `state.locales` when it has actually loaded. An empty cache means
  // "not fetched yet", not "monolingual" — conflating the two hid the bar on
  // multilingual sites whose context had not been refreshed, with nothing on
  // screen to explain the omission. When the list is empty we ask the server
  // instead of assuming; the response settles it either way.
  if (Array.isArray(state.locales) && state.locales.length === 1) return null;
  try {
    const g = await api("i18n/translations?id=" + encodeURIComponent(id) + "&site=" + encodeURIComponent(state.site));
    return Array.isArray(g.versions) && g.versions.length > 1 ? g : null;
  } catch {
    return null;
  }
}

/**
 * The language bar: `[ 简体中文 ● ] [ English ○ ]`.
 *
 * Clicking a version that exists switches to editing it; clicking one that does
 * not offers to create it. The two creation modes are the two honest answers to
 * "I want a French version": start from a copy of this one, or start blank.
 * Both produce a real, independently publishable post — each language version is
 * its own `posts` row sharing a `lang_group` (ARCHITECTURE.md §2.3).
 */
function versionBar(group, current) {
  if (!group) return "";
  const chips = group.versions
    .map((v) => {
      const isCurrent = v.locale === current;
      const label = `${esc(v.locale)} ${v.exists ? icon("circle-check") : icon("plus")}`;
      const title = v.exists
        ? (isCurrent
          ? t("core.editor.versionEditing", "{locale} — editing now", { locale: v.locale })
          : t("core.editor.versionSwitch", "{locale} — switch to this version", { locale: v.locale }))
        : t("core.editor.versionMissing", "{locale} — not created yet", { locale: v.locale });
      return `<button class="btn ${isCurrent ? "primary" : "outline"} sm"
        data-lang-version="${attr(v.locale)}"
        data-version-exists="${v.exists ? "1" : "0"}"
        data-version-post="${attr(v.post_id || "")}"
        title="${attr(title)}">${label}</button>`;
    })
    .join("");
  const missing = group.versions.filter((v) => !v.exists).length;
  return `<div class="panel" style="margin-bottom:1rem">
    <div class="card-title">${esc(t("core.content.translations", "Language versions"))}</div>
    <div class="card-desc" style="margin-bottom:.75rem">
      ${missing
        ? esc(t("core.editor.versionsMissing", "{n} still missing — click one to create it.", { n: missing }))
        : esc(t("core.editor.versionsComplete", "Every language this site serves has a version."))}
    </div>
    <div class="toolbar">${chips}</div>
  </div>`;
}

/** Custom-field inputs declared by the active theme for this content type. */
function fieldInputs(type) {
  const fields = state.fields.filter((f) => !f.post_types?.length || f.post_types.includes(type));
  if (!fields.length) return "";
  const x = state.editing.meta || {};
  const inputs = fields.map((f) => {
    const val = esc(x[f.meta_key] ?? "");
    const label = esc(f.label || f.meta_key);
    const key = attr(f.meta_key);
    if (f.field_type === "number") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="number" value="${val}"></div>`;
    if (f.field_type === "boolean") return `<div class="field"><label>${label}</label><select data-meta="${key}"><option value="">—</option><option value="1"${x[f.meta_key] === "1" ? " selected" : ""}>${esc(t("core.editor.yes", "Yes"))}</option><option value="0"${x[f.meta_key] === "0" ? " selected" : ""}>${esc(t("core.editor.no", "No"))}</option></select></div>`;
    if (["textarea", "html", "richtext"].includes(f.field_type)) return `<div class="field"><label>${label}</label><textarea data-meta="${key}">${val}</textarea></div>`;
    if (f.field_type === "date") return `<div class="field"><label>${label}</label><input data-meta="${key}" type="date" value="${val}"></div>`;
    // `media` / `media-multiple` are declared in `ALLOWED_FIELD_TYPES` and had
    // **no branch here at all**, so they fell through to the plain text input
    // below — a declared field type with no control, which is the same shape as
    // the block attributes this batch fixed. They now use the shared control.
    if (f.field_type === "media" || f.field_type === "media-multiple") {
      const multiple = f.field_type === "media-multiple";
      return mediaFieldHtml({
        value: x[f.meta_key] ?? "",
        multiple,
        label: f.label || f.meta_key,
        inputAttrs: `data-meta="${key}"`,
        hint: multiple ? t("core.media.multiHint", "One URL per line") : "",
      });
    }
    return `<div class="field"><label>${label}</label><input data-meta="${key}" value="${val}"></div>`;
  }).join("");
  return `<div class="panel" style="margin-top:1rem">
    <div class="card-title">${esc(t("core.editor.customFields", "Custom fields"))}</div>
    <div class="card-desc" style="margin-bottom:1rem">${esc(t("core.editor.customFieldsHint", "Declared by the active theme for this content type"))}</div>
    ${inputs}
    ${state.locales && state.locales.length > 1
      ? `<div class="muted text-sm" style="margin-top:.75rem">${esc(t("core.editor.customFieldsShared",
          "These fields are shared by every language version of this item. Editing them here changes them for all languages."))}</div>`
      : ""}</div>`;
}

export async function editor(c, type) {
  const x = state.editing;
  let blocks = [];
  try { blocks = JSON.parse(x.content || "[]"); } catch { /* keep empty */ }
  state.blocks = Array.isArray(blocks) ? blocks : [];
  const pt = postTypeInfo(type);
  const group = await loadVersions(x.id);
  state.translations = group;

  // The palette is the renderer's own set, delivered by `GET /api/v1/blocks`
  // (see state.loadContext) — the same `CORE_BLOCKS` array the front end
  // switches on, so the editor can never offer a block the site cannot draw.
  // Never re-list block types here. The same helper draws the palettes inside
  // nesting blocks, so the two cannot diverge either.
  const blockButtons = paletteHtml(null, true);

  // A locale picker rather than a free-text field: content may only be authored
  // in a language the site actually serves, and typing `zh-cn` by hand used to
  // create a translation nothing would ever look up.
  // The locale of an existing row is a **fact**, not a field. Changing it would
  // ask the API to move this version into another language — which is not what
  // "switch language" means. Switching is the version bar's job, and it creates
  // a proper sibling version instead of rewriting this row's identity. So for an
  // existing item the control is read-only and the hint says where to go; for a
  // new item the choice is real, so it stays editable.
  const localeChoices = (state.locales && state.locales.length ? state.locales : [x.locale || state.defaultLocale]);
  const localeOptions = localeChoices
    .map((code) => `<option value="${attr(code)}"${code === x.locale ? " selected" : ""}>${esc(code)}${code === state.defaultLocale ? ` (${esc(t("core.editor.localeDefault", "default"))})` : ""}</option>`)
    .join("");
  const localeHint = x.id
    ? t("core.editor.localeLocked", "This version's language is fixed. Use the language versions above to switch.")
    : t("core.editor.localeHint", "Each language is its own version");
  const localeField = localeChoices.length > 1
    ? `<div class="field"><label for="locale">${esc(t("core.editor.locale", "Locale"))}</label><select id="locale"${x.id ? " disabled" : ""}>${localeOptions}</select><span class="hint">${esc(localeHint)}</span></div>`
    : `<div class="field"><label for="locale">${esc(t("core.editor.locale", "Locale"))}</label><input id="locale" value="${attr(x.locale)}" readonly><span class="hint">${esc(localeHint)}</span></div>`;

  // ⚠️ The status options carry an explicit `value`. Without it the browser uses
  // the option's *text* as the value, so translating the label would write
  // "草稿" into `posts.status` — a translated label turning into a translated
  // database value. The stored identifier stays lowercase English.
  const statusOptions = ["draft", "published", "private", "scheduled"]
    .map((s) => `<option value="${s}"${x.status === s ? " selected" : ""}>${esc(t(`core.status.${s}`, s))}</option>`)
    .join("");

  c.innerHTML = `${pageHead({
    title: `${x.id ? t("core.editor.edit", "Edit") : t("core.editor.add", "Add")} ${pt.singular}`,
    sub: x.id
      ? t("core.editor.subExisting", "Last saved content for {site}", { site: state.site })
      : t("core.editor.subNew", "New content, saved as draft"),
    actions: `<span class="badge secondary" id="saveState">${esc(t("core.editor.ready", "Ready"))}</span>
              <button class="btn outline" data-back="1">${icon("chevron-left")}${esc(t("core.editor.back", "Back"))}</button>`,
    crumbs: [
      { label: t("core.nav.content", "Content") },
      { label: pt.plural },
      { label: x.id ? t("core.editor.edit", "Edit") : t("core.editor.add", "Add") },
    ],
  })}
  ${versionBar(group, x.locale)}
  <div class="grid2">
    <div>
      <div class="panel">
        <div class="field"><label class="req" for="title">${esc(t("core.content.title", "Title"))}</label><input id="title" value="${attr(x.title)}" placeholder="${attr(pt.singular)}"></div>
        <div class="field">
          <label>${esc(t("core.editor.content", "Content"))}</label>
          <div id="blocks" class="blocks"></div>
          <div class="toolbar" style="margin-top:.75rem">${blockButtons}</div>
        </div>
        <div class="field" style="margin-bottom:0"><label for="excerpt">${esc(t("core.editor.excerpt", "Excerpt"))}</label><textarea id="excerpt" placeholder="${attr(t("core.editor.excerptHint", "Short summary shown in listings"))}">${esc(x.excerpt)}</textarea></div>
      </div>
      ${fieldInputs(type)}
    </div>
    <div>
      <div class="panel">
        ${localeField}
        <div class="field"><label for="slug">${esc(t("core.content.slug", "Slug"))}</label><input id="slug" value="${attr(x.slug)}" placeholder="${attr(t("core.editor.slugAuto", "auto from title"))}"><span class="hint">${esc(t("core.editor.slugHint", "URL segment for this language — must be unique within the language"))}</span></div>
        <div class="field"><label for="status">${esc(t("core.editor.status", "Status"))}</label><select id="status">${statusOptions}</select></div>
        <div class="field"><label for="publishAt">${esc(t("core.editor.publishAt", "Publish at"))}</label><input id="publishAt" type="datetime-local" value="${attr(toLocalInput(x.publish_at))}"><span class="hint">${esc(t("core.editor.publishAtHint", "Used when status is scheduled"))}</span></div>
        <button class="btn primary" style="width:100%" data-action="save-content">${icon("save")}${esc(t("core.action.save", "Save"))}</button>
        ${x.id ? `<div class="toolbar" style="margin-top:.5rem">
          <button class="btn outline sm" data-action="revisions">${icon("history")}${esc(t("core.editor.revisions", "Revisions"))}</button>
          <button class="btn outline danger sm" data-action="delete-content">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>
        </div>` : ""}
      </div>
      ${x.id ? `<div class="panel" id="revisions" style="margin-top:1rem;display:none"></div>` : ""}
    </div>
  </div>`;

  drawBlocks();
  if (x.id) {
    stopAutosave();
    state.autosaveTimer = setInterval(doAutosave, 10000);
  }
}

/**
 * The server-declared contract for a block type.
 *
 * `state.blockTypes` is `GET /api/v1/blocks` — the same list the palette is
 * built from, which now carries each type's attributes (see
 * `src/rendering/blocks.ts`). Falling back to "no attributes" rather than to a
 * text field is deliberate: a block whose contract did not load must not look
 * editable, or the editor will happily write a value nothing reads. That is
 * exactly the defect this file used to have — one `<textarea>` per block,
 * `attrs.text` for all twelve types, and six of them rendering empty at 200.
 */
function specOf(type) {
  return (state.blockTypes ?? []).find((b) => b.type === type) || { type, label: type, attrs: [], children: false };
}

/**
 * The insert palette for a container at `path` (top level when `top`).
 *
 * Nesting blocks are offered only at the top level: the renderer would handle
 * deeper nesting, but an editor with unbounded nesting is a UX trap rather than
 * a feature, and "a group inside a group" is not something the palette should
 * invite.
 */
function paletteHtml(path, top) {
  return (state.blockTypes ?? [])
    .filter((b) => (top ? true : !b.children))
    .map((b) => `<button class="btn outline sm" ${
      top
        ? `data-block="${attr(b.type)}"`
        : `data-block-add-to="${attr(path)}" data-block-type="${attr(b.type)}"`
    }>${icon("plus")}${esc(b.label)}</button>`)
    .join("");
}

/** One block, its controls, and — for a container — its children. */
function blockHtml(b, path) {
  const spec = specOf(b.type);
  const body = spec.children
    ? `${(Array.isArray(b.content) ? b.content : []).map((child, i) => blockHtml(child, `${path}.${i}`)).join("")
        || `<div class="empty">${esc(t("core.editor.emptyContainer", "Empty container."))}</div>`}
       <div class="toolbar" style="margin-top:.5rem">${paletteHtml(path, false)}</div>`
    : renderBlockAttrs(spec, b.attrs || {}, path);
  /** A block tool button.
   *
   *  The icon, the label and the data attribute are all passed in, and the
   *  labels are `t(...)` calls **at the call sites** rather than keys routed
   *  through this helper. Two reasons: deriving the second move button's icon
   *  from the first one by string substitution is how "move down" ends up
   *  wearing the "move up" glyph, and the dictionary guard (rule 63) reads
   *  literal keys — a key that only exists as a variable is a key nothing can
   *  check. */
  const tool = (iconName, label, dataName, dataValue) =>
    `<button class="btn ghost sm" data-block-${dataName}="${dataValue}" title="${attr(label)}">${icon(iconName)}</button>`;
  return `<div class="block">
      <div class="blockhead">
        <b>${esc(spec.label)}</b>
        <span class="block-tools">
          ${tool("arrow-up", t("core.editor.moveUp", "Move up"), "move", `${attr(path)}|-1`)}
          ${tool("arrow-down", t("core.editor.moveDown", "Move down"), "move", `${attr(path)}|1`)}
          ${tool("copy", t("core.editor.duplicate", "Duplicate"), "dup", attr(path))}
          ${tool("trash", t("core.editor.remove", "Remove"), "del", attr(path))}
        </span>
      </div>
      ${body}
    </div>`;
}

function drawBlocks() {
  const el = document.querySelector("#blocks");
  if (!el) return;
  el.innerHTML = state.blocks.map((b, i) => blockHtml(b, String(i))).join("")
    || `<div class="empty">${esc(t("core.editor.addBlock", "Add a block to start writing."))}</div>`;
}

/**
 * `addBlock(type)` is the pre-existing `window.*` handler (inserts at the top
 * level); `addBlock(type, path)` inserts into the container at `path`.
 *
 * The tree work itself lives in `block-fields.js` so it can be driven without a
 * DOM — the addressing is where the silent wrong-content bugs live.
 */
export function addBlock(type, path) {
  const spec = specOf(type);
  insertBlock(state.blocks, path ?? null, spec.children ? { type, content: [] } : { type, attrs: {} });
  drawBlocks(); markDirty();
}

/** Run a tree mutation, re-drawing only when it changed something. Typing does
 *  not come through here: re-rendering on every keystroke would drop focus. */
function mutate(fn, ...args) {
  if (fn(state.blocks, ...args)) { drawBlocks(); markDirty(); }
}

function markDirty() {
  const e = document.querySelector("#saveState");
  if (e) { e.textContent = t("core.editor.unsaved", "Unsaved changes"); e.className = "badge warn"; }
}

document.addEventListener("click", async (e) => {
  const n = e.target.closest("[data-new]");
  if (n) { newContent(n.dataset.new); return; }
  const ed = e.target.closest("[data-edit]");
  if (ed) {
    const [t, id] = ed.dataset.edit.split("|");
    editContent(t, id);
    return;
  }
  const add = e.target.closest("[data-block]");
  if (add) { addBlock(add.dataset.block); return; }
  // Nested insert (a palette drawn inside a group/columns container).
  const addTo = e.target.closest("[data-block-add-to]");
  if (addTo) { addBlock(addTo.dataset.blockType, addTo.dataset.blockAddTo); return; }
  const mv = e.target.closest("[data-block-move]");
  if (mv) { const [p, d] = mv.dataset.blockMove.split("|"); mutate(moveBlockAt, p, Number(d)); return; }
  const dup = e.target.closest("[data-block-dup]");
  if (dup) { mutate(duplicateBlockAt, dup.dataset.blockDup); return; }
  const del = e.target.closest("[data-block-del]");
  if (del) { mutate(removeBlockAt, del.dataset.blockDel); return; }
  const itemAdd = e.target.closest("[data-block-item-add]");
  if (itemAdd) { const [p, k] = itemAdd.dataset.blockItemAdd.split("|"); mutate(addItemAt, p, k); return; }
  // Append several picked files at once to a media-list attribute. The item
  // shape comes from the attribute's own declaration, never from a literal
  // here — see `appendMediaAt`.
  const pickMany = e.target.closest("[data-media-pick-many]");
  if (pickMany) {
    const [p, k] = pickMany.dataset.mediaPickMany.split("|");
    const picked = await openMediaPicker({ multiple: true });
    if (!picked || !picked.length) return;
    const field = (specOf(locateBlock(state.blocks, p)?.type).attrs ?? []).find((a) => a.key === k);
    mutate(appendMediaAt, p, k, field?.itemKeys ?? [], picked);
    return;
  }
  const itemDel = e.target.closest("[data-block-item-del]");
  if (itemDel) {
    const [p, k, i] = itemDel.dataset.blockItemDel.split("|");
    mutate(removeItemAt, p, k, Number(i));
    return;
  }
  const back = e.target.closest("[data-back]");
  // No explicit stop here: `go()` stops the autosave, so Back and the sidebar
  // take the same path. Two cleanup paths is how one of them gets forgotten.
  if (back) { go(state.page); return; }
  const act = e.target.closest("[data-action]");
  if (!act) return;
  if (act.dataset.action === "save-content") saveContent();
  if (act.dataset.action === "revisions") showRevisions();
  if (act.dataset.action === "delete-content") deleteContent();
});

/**
 * The locale picker only exists for a **new** item, where choosing the language
 * you are about to author is a real choice. Mirroring it into the editing state
 * is what lets the save read the locale from one place — `state.editing.locale`
 * — instead of from whichever control happens to be on screen. (A `<select>`
 * reports through `change`; relying on `input` alone works in most browsers and
 * silently fails in the rest.)
 */
document.addEventListener("change", (e) => {
  const loc = e.target.closest("#locale");
  if (loc && state.editing) { state.editing.locale = loc.value; markDirty(); }
});

document.addEventListener("input", (e) => {
  // ⚠️ The item branch is checked **first**: a `media-list` row carries both
  // `data-block-attr` (which attribute it belongs to) and `data-block-item`
  // (which entry). Reading it as a scalar attribute would write the item's text
  // over the whole list.
  const item = e.target.closest("[data-block-item]");
  if (item) {
    setItemAt(state.blocks, item.dataset.blockPath, item.dataset.blockAttr, Number(item.dataset.blockItem), item.dataset.itemKey, item.value);
    markDirty();
    return;
  }
  // A scalar block attribute. Which key it writes comes from the markup, which
  // comes from the server's declaration — the editor never decides that an
  // image stores its URL under `url` rather than `text`.
  const field = e.target.closest("[data-block-attr]");
  if (field) { setAttrAt(state.blocks, field.dataset.blockPath, field.dataset.blockAttr, field.value); markDirty(); return; }
  if (e.target.closest("#title, #excerpt, #locale, #slug, #status")) markDirty();
});

async function doAutosave() {
  if (!state.editing?.id) return;
  const body = {
    // The locale is read from the editing state, not from the DOM: it is a fact
    // about the row being edited, and the control that shows it may be
    // read-only (see `editor()`).
    locale: state.editing.locale,
    title: document.querySelector("#title")?.value || "",
    excerpt: document.querySelector("#excerpt")?.value || "",
    content: state.blocks,
  };
  try {
    await api(scoped(contentPath(state.type) + "/" + state.editing.id + "/autosave"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const e = document.querySelector("#saveState");
    if (e) { e.textContent = t("core.editor.autosaved", "Autosaved"); e.className = "badge success"; }
  } catch { /* autosave is best-effort */ }
}

/** Collect theme-declared custom-field values from the editor. */
function collectMeta() {
  const meta = {};
  for (const el of document.querySelectorAll("[data-meta]")) meta[el.dataset.meta] = el.value;
  return meta;
}

export async function saveContent() {
  stopAutosave();
  const titleEl = document.querySelector("#title");
  if (!titleEl.value.trim()) {
    await alertDialog({
      title: t("core.editor.titleRequired", "Title required"),
      description: t("core.editor.titleRequiredDesc", "Give this content a title before saving."),
    });
    titleEl.focus();
    return;
  }
  const body = {
    title: titleEl.value,
    excerpt: document.querySelector("#excerpt").value,
    // From the editing state, not the DOM — see `doAutosave`. A read-only
    // control still has a `value`, but reading identity out of markup is how
    // the "change the language" footgun got in.
    locale: state.editing.locale,
    slug: document.querySelector("#slug").value,
    status: document.querySelector("#status").value,
    // `datetime-local` in, epoch seconds out — the same round trip the generated
    // table forms use (`table-form.js`), so there is one definition of it.
    publish_at: fromLocalInput(document.querySelector("#publishAt")?.value),
    content: state.blocks,
    meta: collectMeta(),
  };
  try {
    await api(scoped(contentPath(state.type) + (state.editing.id ? "/" + state.editing.id : "")), {
      method: state.editing.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast(t("core.msg.saved", "Saved."));
    state.editing = null;
    setTimeout(render, 300);
  } catch (e) {
    toast(e.message, "error");
  }
}

export async function showRevisions() {
  const box = document.querySelector("#revisions");
  box.style.display = "block";
  box.innerHTML = `<div class="card-title">${esc(t("core.editor.revisionHistory", "Revision history"))}</div><div class="muted text-sm">${esc(t("core.msg.loading", "Loading…"))}</div>`;
  try {
    const d = await api(scoped(`${state.type}/${state.editing.id}/revisions`));
    const items = d.items || [];
    box.innerHTML = `<div class="card-title" style="margin-bottom:.75rem">${esc(t("core.editor.revisionHistory", "Revision history"))}</div>
      ${items.map((r) => `<div class="list-row">
        <div><div class="title">v${esc(r.version)}</div><div class="meta">${esc(r.locale)} · ${esc(fmtDate(r.created_at))}</div></div>
        <button class="btn outline sm" data-restore="${attr(r.id)}">${esc(t("core.editor.restore", "Restore"))}</button>
      </div>`).join("") || `<div class="empty">${esc(t("core.editor.noRevisions", "No revisions yet."))}</div>`}`;
  } catch (e) {
    box.innerHTML = `<div class="muted text-sm">${esc(e.message)}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  const lang = e.target.closest("[data-lang-version]");
  if (lang) {
    await switchVersion(lang.dataset.langVersion, lang.dataset.versionExists === "1", lang.dataset.versionPost);
    return;
  }
  const r = e.target.closest("[data-restore]");
  if (!r) return;
  const ok = await confirmDialog({
    title: t("core.editor.restoreTitle", "Restore this revision?"),
    description: t("core.editor.restoreDesc", "The current content will be replaced by the selected revision."),
    confirmLabel: t("core.editor.restore", "Restore"), danger: false,
  });
  if (!ok) return;
  await api(scoped(`${state.type}/${state.editing.id}/revisions/${r.dataset.restore}/restore`), { method: "POST" });
  toast(t("core.editor.revisionRestored", "Revision restored"));
  editContent(state.type, state.editing.id);
});

/**
 * Click a language in the version bar.
 *
 * An existing version is opened for editing. A missing one is created first —
 * and the two ways to create it are genuinely different, so the user is asked
 * rather than guessed at:
 *
 *   copy this version  start from a translation of what is here
 *   start blank        begin empty, for a language you will write fresh
 *
 * Both create an independent draft. Neither overwrites the version you were
 * looking at, which is the property that makes "English is live, Japanese is
 * still being written" possible.
 *
 * Exported for the admin-spa suite: the version bar is a document-level click
 * handler, so the switch behaviour is asserted through this function directly.
 */
export async function switchVersion(locale, exists, postId) {
  const current = state.editing;
  if (!current?.id) return;
  if (exists) {
    // Always re-fetch the requested language's row — including when it is the
    // same `posts` id, because a shared-row post keeps *both* languages'
    // content in one response, and merely relabelling `state.editing.locale`
    // left the previous language's title and blocks on screen under the new
    // language's name. Saving from that screen would overwrite the other
    // language with the wrong content — a 200 that destroys data.
    await editContent(state.type, postId || current.id, locale);
    return;
  }
  const choice = await openDialog({
    title: t("core.editor.createVersion", "Create a {locale} version", { locale }),
    description: t("core.editor.createVersionDesc", "This adds a new draft in the same translation group. The version you are editing is left untouched."),
    confirmLabel: t("core.content.createTranslation", "Create translation"),
    fields: [
      {
        name: "mode",
        label: t("core.editor.createVersionHow", "How should it start?"),
        type: "select",
        options: [
          { value: "copy", label: t("core.editor.copyVersion", "Copy this version as a first draft") },
          { value: "blank", label: t("core.editor.startBlank", "Start empty") },
        ],
      },
    ],
  });
  if (!choice) return;
  try {
    const made = await api("i18n/translations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: current.id, locale, mode: choice.mode || "copy", site: state.site }),
    });
    toast(t("core.editor.versionCreated", "{locale} version created", { locale }));
    await editContent(state.type, made.id);
  } catch (err) {
    await alertDialog({
      title: t("core.editor.versionCreateFailed", "Could not create the {locale} version", { locale }),
      description: err.message,
    });
  }
}

export async function deleteContent() {
  const ok = await confirmDialog({
    title: t("core.editor.deleteTitle", "Delete this content?"),
    description: t("core.editor.deleteDesc", "This permanently removes the item and its translations. Revisions go with it."),
    confirmLabel: t("core.action.delete", "Delete"),
  });
  if (!ok) return;
  stopAutosave();
  await api(scoped(contentPath(state.type) + "/" + state.editing.id), { method: "DELETE" });
  toast(t("core.msg.deleted", "Deleted."));
  state.editing = null;
  go(state.page);
}
