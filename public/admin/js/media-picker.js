/**
 * The media picker — the **one** control the admin uses to choose a media file.
 *
 * ## Why one module
 *
 * Three places need "choose a file from the library", and before this module
 * each had its own answer:
 *
 *   - a block's `media` / `media-list` attribute (`block-fields.js`);
 *   - a content custom field of type `media` / `media-multiple` — declared in
 *     `ALLOWED_FIELD_TYPES` since the beginning, with **no control branch** in
 *     the editor, so it silently fell through to a plain text input;
 *   - a theme or plugin setting of the same type (`screens/theme-menu.js`),
 *     which rendered a bare `<input>` with "URL in the media library" as the
 *     only hint.
 *
 * Three copies of "a URL box and a hope" is how a library becomes a list of
 * broken links, and it is the same "declared but never consumed" shape the rest
 * of this repo keeps meeting: the field type existed, the control did not.
 *
 * ## The contract with the callers
 *
 * The picker's job is deliberately small: **put a URL into the input that asked
 * for it, and dispatch `input`.** That means no caller needs new plumbing — a
 * block attribute input already has a listener that writes `attrs[key]`, a
 * settings input already saves on change, and a custom field is read from
 * `[data-meta]` at save time. The control markup is emitted by
 * `mediaFieldHtml()` (the single definition; `architecture.test.mjs` requires
 * `data-media-pick` to appear nowhere else) and the click is handled here by one
 * document-level listener, so importing this module is all a screen has to do.
 *
 * `mediaUrl()` is the single place a `/media/<key>` URL is built, and it must
 * match the read path in `src/index.ts` — that path now checks the key's tenant
 * before serving (AGENTS.md rule 60), so a URL built any other way is a 404.
 *
 * Leaf-ish: imports the state helpers, the UI kit and the dictionary, and
 * nothing else. It is imported by screens, never by another control module.
 */
import { api, scoped } from "./state.js";
import { attr, esc, toast } from "../ui.js";
import { icon } from "../icons.js";
import { t } from "./i18n.js";

/** `/media/<key>` for one R2 object key. Percent-encoded as one segment, which
 *  is what `src/index.ts` decodes and what the media screen already links to. */
export function mediaUrl(objectKey) {
  const key = String(objectKey ?? "");
  return key ? `/media/${encodeURIComponent(key)}` : "";
}

/**
 * Normalise one `media_files` row (or a previously stored value) into the shape
 * every consumer uses.
 *
 * Accepts `object_key` (the row) or `url` (a value already in a field) so the
 * same function can read what the API returned and what the database holds.
 * Returns `null` for anything that is not an object, because a picker that
 * invents an item from junk is worse than one that shows an empty library.
 */
export function mediaItem(row) {
  if (!row || typeof row !== "object") return null;
  const key = row.object_key ?? row.key ?? "";
  const url = key ? mediaUrl(key) : String(row.url ?? "");
  if (!url) return null;
  return {
    id: String(row.id ?? ""),
    url,
    alt: String(row.alt_text ?? row.alt ?? ""),
    filename: String(row.filename ?? ""),
    mimeType: String(row.mime_type ?? ""),
    size: Number(row.size ?? 0) || 0,
  };
}

/** Every usable item in an API payload. A malformed payload yields `[]` rather
 *  than throwing inside a dialog. */
export function mediaItemsFromPayload(payload) {
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  return rows.map(mediaItem).filter(Boolean);
}

const isImage = (mime) => String(mime ?? "").startsWith("image/");

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/** One selectable tile — the same wall-of-pictures the library screen draws,
 *  plus a selection ring and a check badge so "which ones did I pick" is
 *  readable across the whole grid at a glance. The state is announced twice
 *  (class for the eye, `aria-pressed` for the reader) because a border change
 *  alone is invisible to assistive tech. */
export function pickerTileHtml(item, selected, multiple) {
  const isImg = isImage(item.mimeType);
  return `<button type="button" class="media-tile${selected ? " is-selected" : ""}" data-media-id="${attr(item.id)}"
    data-media-url="${attr(item.url)}" data-media-alt="${attr(item.alt)}"
    aria-pressed="${selected ? "true" : "false"}"
    title="${attr(item.filename || item.url)}">
    <span class="media-thumb">${isImg
      ? `<img src="${attr(item.url)}" alt="${attr(item.alt)}" loading="lazy">`
      : `<span class="media-file">${icon("file-text")}</span>`}
      <span class="media-check" aria-hidden="true">${icon("check")}</span>
    </span>
    <span class="media-meta">
      <span class="media-name">${esc(item.filename || item.url)}</span>
      <span class="media-sub">${esc(formatBytes(item.size))}${multiple && selected ? ` · ${esc(t("core.media.picked", "selected"))}` : ""}</span>
    </span>
  </button>`;
}

/** The whole grid, including its empty state. The grid scrolls its own height
 *  so a big library never grows the dialog off-screen. */
export function pickerGridHtml(items, selectedIds, multiple) {
  if (!items.length) return `<div class="empty">${esc(t("core.media.empty", "No media uploaded yet."))}</div>`;
  const selected = new Set(selectedIds ?? []);
  return `<div class="media-grid media-pick-grid">
    ${items.map((i) => pickerTileHtml(i, selected.has(i.id), multiple)).join("")}
  </div>`;
}

/**
 * A preview for a media value, or a plain rendering of the URL when it is not
 * something an `<img>` can show. Pointing `<img>` at a PDF renders a
 * broken-image box, which reads as "the editor is broken".
 *
 * Exported because the picker has to refresh it **in place** after a pick: the
 * block editor deliberately does not re-render while you type (that would drop
 * focus), so a preview drawn only at render time would not appear until the
 * next structural change — the file you just chose would look like it was not
 * taken.
 */
export function mediaPreviewHtml(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (!isImageUrl(v)) return `<div class="muted text-sm" style="margin-top:.25rem">${esc(v)}</div>`;
  return `<img src="${attr(v)}" alt="" style="max-width:8rem;max-height:8rem;border-radius:.375rem;margin-top:.375rem">`;
}

/**
 * The control markup — **the** definition of "a media field".
 *
 * `inputAttrs` is the caller's addressing (`data-block-attr`, `data-meta`, …),
 * which is the only thing that legitimately differs between the three places
 * that use this: what a value *is* is the same everywhere, where it *goes* is
 * not. `multiple` renders a textarea holding one URL per line, mirroring how a
 * list block already stores its items.
 */
export function mediaFieldHtml({ value = "", multiple = false, label = "", required = false, hint = "", inputAttrs = "" }) {
  const labelHtml = label ? `<label${required ? ' class="req"' : ""}>${esc(label)}</label>` : "";
  const hintHtml = hint ? `<span class="hint">${esc(hint)}</span>` : "";
  const input = multiple
    ? `<textarea ${inputAttrs} placeholder="/media/…">${esc(value ?? "")}</textarea>`
    : `<input ${inputAttrs} value="${attr(value ?? "")}" placeholder="/media/…">`;
  // The preview lives in a slot the picker can refresh without re-rendering the
  // whole screen. A multi-value field has no single thing to preview.
  const preview = multiple ? "" : `<span data-media-preview>${mediaPreviewHtml(value)}</span>`;
  return `<div class="media-field" data-media-field data-media-multiple="${multiple ? "1" : "0"}">
    ${labelHtml}
    ${input}
    ${preview}
    <div class="toolbar" style="margin-top:.375rem">
      <button type="button" class="btn outline sm" data-media-pick>${esc(t("core.media.choose", "Choose from library"))}</button>
    </div>
    ${hintHtml}
  </div>`;
}

/** Is this URL worth previewing as an image? Only image-looking URLs get an
 *  `<img>`: a PDF or a hand-typed typo would render a broken-image box, which
 *  reads as "the editor is broken". */
function isImageUrl(url) {
  const v = String(url ?? "").trim();
  return /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(v);
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

let dialogHost = null;
function ensureHost() {
  if (dialogHost && document.body.contains(dialogHost)) return dialogHost;
  dialogHost = document.createElement("div");
  dialogHost.id = "media-picker-host";
  document.body.appendChild(dialogHost);
  return dialogHost;
}

/**
 * Open the picker. Resolves with the chosen items (or `null` when cancelled),
 * and also calls `onPick` — callers that live inside a delegated listener use
 * the callback, callers that can `await` use the return value.
 */
export async function openMediaPicker({ multiple = false, accept = "image/*", onPick = null } = {}) {
  const host = ensureHost();
  let items = [];
  const selected = new Map(); // id -> item
  let query = "";
  let type = "";
  let busy = false;

  let resolveOuter = () => {};
  const done = new Promise((r) => { resolveOuter = r; });
  const close = (result) => {
    host.innerHTML = "";
    if (result && onPick) onPick(result);
    resolveOuter(result);
  };

  const draw = () => {
    const grid = host.querySelector("#mp-grid");
    if (grid) grid.innerHTML = pickerGridHtml(items, [...selected.keys()], multiple);
    const count = host.querySelector("#mp-count");
    if (count) {
      count.textContent = selected.size && multiple
        ? t("core.media.selectedCount", "{n} selected", { n: selected.size })
        : `${items.length} ${t("core.media.files", "files")}`;
    }
    const confirm = host.querySelector("#mp-ok");
    if (confirm) confirm.disabled = selected.size === 0;
  };

  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: "60" });
      if (query) params.set("q", query);
      if (type) params.set("type", type);
      const payload = await api(scoped(`media?${params}`));
      items = mediaItemsFromPayload(payload);
    } catch (e) {
      items = [];
      toast(e.message, "error");
    }
    draw();
  };

  host.innerHTML = `<div class="overlay">
    <div class="dialog dialog-wide" role="dialog" aria-modal="true" aria-label="${attr(t("core.media.choose", "Choose from library"))}">
      <h2>${esc(t("core.media.choose", "Choose from library"))}</h2>
      <p class="dialog-desc">${esc(t("core.media.pickHint", "Pick a file already in this site's library, or upload a new one."))}</p>
      <div class="toolbar" style="margin-bottom:.25rem">
        <input id="mp-search" placeholder="${attr(t("core.action.search", "Search"))}" style="flex:1">
        <select id="mp-type" aria-label="${attr(t("core.media.filterAll", "All types"))}">
          <option value="">${esc(t("core.media.filterAll", "All types"))}</option>
          <option value="image/">${esc(t("core.media.filterImages", "Images"))}</option>
          <option value="application/">${esc(t("core.media.filterDocuments", "Documents"))}</option>
        </select>
        <label class="btn outline sm" style="margin:0">${esc(t("core.action.upload", "Upload"))}
          <input id="mp-file" type="file" ${multiple ? "multiple" : ""} accept="${attr(accept)}" hidden>
        </label>
        <span class="muted text-sm" id="mp-count"></span>
      </div>
      <div id="mp-grid"></div>
      <div class="dialog-actions">
        <button class="btn outline" id="mp-cancel" type="button">${esc(t("core.action.cancel", "Cancel"))}</button>
        <button class="btn primary" id="mp-ok" type="button">${esc(t("core.media.use", "Use selected"))}</button>
      </div>
    </div></div>`;

  const overlay = host.querySelector(".overlay");
  host.querySelector("#mp-cancel").onclick = () => close(null);
  host.querySelector("#mp-ok").onclick = () => close([...selected.values()]);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });

  host.querySelector("#mp-grid").addEventListener("click", (e) => {
    const tile = e.target.closest("[data-media-id]");
    if (!tile) return;
    const id = tile.dataset.mediaId;
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (!multiple) { selected.clear(); selected.set(id, item); }
    else if (selected.has(id)) selected.delete(id);
    else selected.set(id, item);
    draw();
  });

  // Search is applied server-side (`GET /api/v1/media?q=`) so the library is not
  // silently truncated to the first page the dialog happened to load.
  let searchTimer = null;
  host.querySelector("#mp-search").addEventListener("input", (e) => {
    query = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 200);
  });
  host.querySelector("#mp-type").addEventListener("change", (e) => {
    type = e.target.value;
    load();
  });

  host.querySelector("#mp-file").onchange = async (e) => {
    const files = [...(e.target.files ?? [])];
    if (!files.length || busy) return;
    busy = true;
    const confirm = host.querySelector("#mp-ok");
    if (confirm) confirm.textContent = t("core.media.uploading", "Uploading…");
    try {
      for (const f of files.slice(0, multiple ? 12 : 1)) {
        const fd = new FormData();
        fd.append("file", f);
        await api(scoped("media"), { method: "POST", body: fd });
      }
      await load();
      // Uploads are almost always meant to be used, so a single upload is
      // pre-selected — the common path is "add a picture to this block".
      if (!multiple && items.length) {
        const newest = items[0];
        selected.clear();
        selected.set(newest.id, newest);
        draw();
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      busy = false;
      const btn = host.querySelector("#mp-ok");
      if (btn) btn.textContent = t("core.media.use", "Use selected");
    }
  };

  await load();
  return done;
}

/**
 * One document-level listener, registered on import.
 *
 * A shared control cannot rely on each screen wiring it: the three call sites
 * live in three modules, and "forgot to wire it" would look exactly like a
 * button that does nothing — the failure mode AGENTS.md rule 23 is about.
 */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-media-pick]");
  if (!btn) return;
  e.preventDefault();
  const wrapper = btn.closest("[data-media-field]");
  if (!wrapper) return;
  const input = wrapper.querySelector("input, textarea");
  if (!input) return;
  const multiple = wrapper.dataset.mediaMultiple === "1";

  const picked = await openMediaPicker({ multiple });
  if (!picked || !picked.length) return;
  if (multiple) {
    const existing = String(input.value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const item of picked) if (!existing.includes(item.url)) existing.push(item.url);
    input.value = existing.join("\n");
  } else {
    input.value = picked[0].url;
  }
  // Let the value flow through whatever listener the caller already has: a
  // block attribute writes `attrs[key]`, a settings input saves on change, a
  // custom field is read from `[data-meta]` at save time. No new plumbing.
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // ...and refresh the preview in place. The editor does not re-render on every
  // keystroke (that would drop focus), so without this the file you just chose
  // would show no thumbnail until the next structural change.
  const slot = wrapper.querySelector("[data-media-preview]");
  if (slot && !multiple) slot.innerHTML = mediaPreviewHtml(input.value);
});
