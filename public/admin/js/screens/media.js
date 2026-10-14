/**
 * Screen: media library — the R2 objects for the current site.
 *
 * Three things shape this screen:
 *
 *  1. **It is the library's own view, so it must show the same objects the
 *     picker does.** `mediaUrl()` / `mediaItem()` come from `media-picker.js`
 *     rather than being re-derived here: the read path checks the key's tenant
 *     before serving (rule 60), so a second way of building the URL is a second
 *     way to build a 404. `architecture.test.mjs` enforces it.
 *
 *  2. **The list endpoint already paginates, searches and filters by MIME
 *     prefix.** `page` / `limit` / `q` / `type` were all there; the screen was
 *     showing the first page and nothing else, which meant a library of 60 files
 *     silently looked like a library of 50.
 *
 *  3. **Alt text is the one field worth editing in place.** It is what a screen
 *     reader announces and what the picker offers as a default, and making the
 *     author open a dialog to fix one word is how alt text stays empty.
 *
 * The view state (`view`) is deliberately screen-local: it describes what this
 * screen is currently showing, and it survives a re-render so that uploading a
 * file does not throw you back to page one of an unfiltered list.
 */
import { api, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { mediaItem, mediaUrl } from "../media-picker.js";
import { t } from "../i18n.js";
import { attr, confirmDialog, esc, toast } from "../../ui.js";

/** How many tiles per request. The endpoint caps `limit` at 100. */
export const MEDIA_PAGE_LIMIT = 24;

let view = { q: "", type: "", page: 1, items: [], total: 0 };

/** The query string the list endpoint understands.
 *
 *  Exported so the shape is checkable without a browser — the one thing that
 *  must not drift is that `type` is a MIME **prefix** (`image/`), because the
 *  server matches it with `LIKE 'image/%'`. */
export function mediaQuery({ q = "", type = "", page = 1, limit = MEDIA_PAGE_LIMIT } = {}) {
  const parts = [`page=${Math.max(1, Number(page) || 1)}`, `limit=${limit}`];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (type) parts.push(`type=${encodeURIComponent(type)}`);
  return parts.join("&");
}

/** Pagination facts from a list payload — the arithmetic lives in one place so
 *  "is there another page" cannot disagree with "how many are there". */
export function mediaPageInfo(payload) {
  const page = Math.max(1, Number(payload?.page) || 1);
  const limit = Math.max(1, Number(payload?.limit) || MEDIA_PAGE_LIMIT);
  const total = Math.max(0, Number(payload?.total) || 0);
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total };
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/** One tile. The tile IS the thumbnail: the picture fills a square, the three
 *  actions ride in a glass overlay that fades in on hover/focus, and the
 *  metadata is two quiet lines under the picture. Rows are what the API
 *  returns, so `mediaItem()` normalises them (and refuses a row it cannot
 *  name, rather than rendering a broken tile). */
export function mediaTileHtml(row) {
  const m = mediaItem(row);
  if (!m) return "";
  const isImg = m.mimeType.startsWith("image/");
  const name = m.filename || m.url;
  const label = (k, d) => attr(t(k, d));
  return `<figure class="media-tile" data-media-row="${attr(m.id)}">
    <div class="media-thumb">${isImg
      ? `<img src="${attr(m.url)}" alt="${attr(m.alt)}" loading="lazy">`
      : `<span class="media-file">${icon("file-text")}</span>`}
      <div class="media-actions">
        <button type="button" class="icon-btn" data-copy="${attr(m.url)}" title="${label("core.media.copyUrl", "URL")}" aria-label="${label("core.media.copyUrl", "URL")}">${icon("copy")}</button>
        <a class="icon-btn" href="${attr(m.url)}" target="_blank" rel="noopener" title="${label("core.media.open", "Open")}" aria-label="${label("core.media.open", "Open")}">${icon("external")}</a>
        <button type="button" class="icon-btn danger" data-media-del="${attr(m.id)}|${attr(name)}" title="${label("core.action.delete", "Delete")}" aria-label="${label("core.action.delete", "Delete")}">${icon("trash")}</button>
      </div>
    </div>
    <figcaption class="media-meta">
      <div class="media-name" title="${attr(name)}">${esc(name)}</div>
      <div class="media-sub">${esc(formatBytes(m.size))} · ${esc(m.mimeType || "—")}</div>
    </figcaption>
    <input class="media-alt" data-media-alt="${attr(m.id)}" value="${attr(m.alt)}"
      placeholder="${attr(t("core.media.altPlaceholder", "alt text"))}"
      aria-label="${attr(t("core.media.alt", "Alt text"))}">
  </figure>`;
}

export function mediaGridHtml(items) {
  const list = items ?? [];
  if (!list.length) {
    return `<div class="media-empty">${icon("image")}
      <div>${esc(t("core.media.empty", "No media uploaded yet."))}</div>
      <span class="text-sm">${esc(t("core.media.dropHint", "Drop files here to upload"))}</span>
    </div>`;
  }
  return list.map(mediaTileHtml).join("");
}

/** The grid + its footer, as one string — used both for the first paint and for
 *  "load more", so the two can never disagree about the footer's arithmetic.
 *  The upload tile is a first-class grid member: the affordance to add more
 *  lives where the files are, not only in the header. */
export function mediaBodyHtml(items, info) {
  const shown = (items ?? []).length;
  const add = t("core.media.addMedia", "Upload files");
  return `<div id="media-grid" class="media-grid">
    <button type="button" class="media-tile media-upload-tile" data-media-upload="1" title="${attr(add)}" aria-label="${attr(add)}">${icon("upload")}<span>${esc(add)}</span></button>
    ${mediaGridHtml(items)}
  </div>
  <div class="toolbar" style="margin-top:1rem;align-items:center">
    <span class="muted text-sm">${esc(t("core.media.showing", "Showing {shown} of {total}", { shown, total: info.total }))}</span>
    ${info.hasMore
      ? `<button type="button" class="btn outline sm" data-media-more="1">${esc(t("core.media.loadMore", "Load more"))}</button>`
      : ""}
  </div>`;
}

/** Fetch one page and fold it into the view. `append` is what "load more" does. */
async function load({ append = false } = {}) {
  const page = append ? view.page + 1 : 1;
  const d = await api(scoped(`media?${mediaQuery({ q: view.q, type: view.type, page })}`));
  const items = d.items || [];
  const info = mediaPageInfo({ ...d, page });
  // `storage` rides the same payload (`{provider, imgbbKey, postimagesKey}` —
  // booleans, never the keys themselves), so the storage panel below needs no
  // second fetch and no new endpoint. Absent on old responses: default site.
  view = { ...view, page: info.page, total: info.total, items: append ? [...view.items, ...items] : items, storage: d.storage ?? { provider: "r2", imgbbKey: false, postimagesKey: false } };
  return info;
}

/**
 * Where this site's new uploads go — the one screen that can answer it.
 *
 * Three options, one choice, stored per site in `cfpress.media` → `provider`
 * (the secrets themselves live in the environment and never transit this
 * screen). Files already in the library stay where they are: the choice only
 * governs the next upload, so flipping it cannot strand anything.
 *
 * The pending choice lives in module state, not in the DOM: the screen
 * re-renders on every filter change, and a selection kept in an element would
 * be the thing that gets forgotten on the next keystroke. It is keyed by site,
 * because the choice is per site — a pending imgbb for site A must not leak
 * into site B's panel after a switch.
 */
let pendingProvider = null; // { site, value } | null
const PROVIDERS = ["r2", "imgbb", "postimages"];

function pendingFor(site) {
  return pendingProvider && pendingProvider.site === site ? pendingProvider.value : null;
}

function storagePanelHtml(storage) {
  const s = storage ?? { provider: "r2", imgbbKey: false, postimagesKey: false };
  const current = pendingFor(state.site) ?? s.provider ?? "r2";
  const card = (id) => {
    const selected = current === id;
    const keyed = id === "imgbb" ? s.imgbbKey === true : id === "postimages" ? s.postimagesKey === true : null;
    return `<button type="button" class="media-storage-opt${selected ? " is-selected" : ""}"
      data-storage-pick="${attr(id)}" aria-pressed="${selected ? "true" : "false"}">
      <span class="media-storage-name">${esc(t(`core.media.storage${id === "r2" ? "R2" : id === "imgbb" ? "Imgbb" : "Postimages"}`, id))}</span>
      <span class="media-storage-desc">${esc(t(`core.media.storage${id === "r2" ? "R2" : id === "imgbb" ? "Imgbb" : "Postimages"}Desc`, ""))}</span>
      <span class="media-storage-state">${selected
        ? `<span class="badge default">${esc(t("core.media.storageActive", "In use"))}</span>`
        : keyed === false ? `<span class="badge warn">${esc(t("core.media.storageKeyMissing", "Server key missing"))}</span>` : ""}</span>
    </button>`;
  };
  // Key fields are `type=password` and round-trip redacted: the server never
  // echoes a stored key (the read answers `""`), and an empty write keeps the
  // stored value — so "save" with untouched fields cannot delete a key, and
  // the key itself is never in the DOM except while being typed.
  const keyField = (id, key) => `<div class="field" style="margin-bottom:.5rem">
      <label for="storage-key-${attr(id)}">${esc(t(`core.media.storage${id === "imgbb" ? "Imgbb" : "Postimages"}Key`, id))}</label>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input id="storage-key-${attr(id)}" type="password" data-storage-key="${attr(key)}" autocomplete="off" style="flex:1"
          placeholder="${attr(keyed(id) ? t("core.media.storageKeySet", "Saved — leave blank to keep it") : t("core.media.storageKeyEmpty", "Paste the API key here"))}">
        ${keyed(id) ? `<button type="button" class="btn outline sm" data-storage-clear="${attr(key)}">${esc(t("core.media.storageKeyClear", "Clear"))}</button>` : ""}
      </div>
    </div>`;
  const keyed = (id) => id === "imgbb" ? s.imgbbKey === true : s.postimagesKey === true;
  return `<div class="panel" style="margin-bottom:.75rem" data-storage-panel="1">
    <div class="card-title">${esc(t("core.media.storageTitle", "Storage"))}</div>
    <div class="muted text-sm" style="margin-bottom:.75rem">${esc(t("core.media.storageDesc", "Where new uploads go. This site only — files already in the library stay where they are."))}</div>
    <div class="media-storage-grid" role="group" aria-label="${attr(t("core.media.storageTitle", "Storage"))}">${PROVIDERS.map(card).join("")}</div>
    <div class="media-storage-keys">
      ${keyField("imgbb", "cfpress.media.imgbb_key")}
      ${keyField("postimages", "cfpress.media.postimages_key")}
    </div>
    <div style="margin-top:.75rem">
      <button type="button" class="btn primary sm" data-storage-save="1">${esc(t("core.media.storageSave", "Save storage"))}</button>
    </div>
  </div>`;
}

async function saveStorage() {
  // The provider falls back to what the server reports: saving only keys
  // (without touching the choice) must keep the current provider, not reset
  // it to r2.
  const provider = pendingFor(state.site) ?? view.storage?.provider ?? "r2";
  // Keys are write-only here: only non-empty inputs travel. An untouched
  // (empty) field is omitted, and the server additionally preserves on empty —
  // so saving the provider choice alone can never delete a stored key.
  const keys = {};
  for (const el of document.querySelectorAll("[data-storage-key]")) {
    const v = String(el.value ?? "").trim();
    if (v) keys[el.dataset.storageKey] = v;
  }
  try {
    // Read-modify-write on the `cfpress.media` JSON: the blob also carries
    // `isolation` / `require_session`, and a blind write of `{provider}` alone
    // would silently drop the policy. Two admins racing here last-writer-wins;
    // that is the same contract every other JSON-blob setting in this admin
    // already has.
    const d = await api(scoped("settings"));
    const row = (d.items || []).find((x) => x.key === "cfpress.media");
    let merged = {};
    try { merged = row?.value ? JSON.parse(row.value) : {}; } catch { merged = {}; }
    if (!merged || typeof merged !== "object" || Array.isArray(merged)) merged = {};
    merged.provider = provider;
    await api(scoped("settings"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "cfpress.media", value: JSON.stringify(merged) }),
    });
    for (const [key, value] of Object.entries(keys)) {
      await api(scoped("settings"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    }
    pendingProvider = null;
    toast(t("core.media.storageSaved", "Storage saved"));
    render();
  } catch (err) {
    toast(err.message || "Could not save storage", "error");
  }
}

export default async function media(c) {
  let info;
  try {
    info = await load();
  } catch (e) {
    c.innerHTML = `${pageHead({ title: t("core.media.title", "Media") })}
      <div class="panel"><div class="muted">${esc(e.message)}</div></div>`;
    return;
  }

  const filter = (value, label) =>
    `<option value="${attr(value)}"${view.type === value ? " selected" : ""}>${esc(label)}</option>`;

  c.innerHTML = `${pageHead({
    title: t("core.media.title", "Media"),
    sub: t(info.total === 1 ? "core.media.subOne" : "core.media.subMany", "{n} files in this site's library", { n: info.total }),
    actions: `<label class="btn primary">${icon("upload")}${esc(t("core.media.upload", "Upload"))}<input id="upload" type="file" multiple hidden></label>`,
    crumbs: [{ label: t("core.nav.content", "Content") }, { label: t("core.media.title", "Media") }],
  })}
  <div class="toolbar" style="margin-bottom:.75rem">
    <input id="media-q" value="${attr(view.q)}" placeholder="${attr(t("core.msg.searchPlaceholder", "Search…"))}" style="flex:1">
    <select id="media-type">
      ${filter("", t("core.media.filterAll", "All types"))}
      ${filter("image/", t("core.media.filterImages", "Images"))}
      ${filter("application/", t("core.media.filterDocuments", "Documents"))}
    </select>
  </div>
  ${storagePanelHtml(view.storage)}
  <div id="media-drop" class="media-drop">
    <div class="media-drop-hint muted text-sm">${esc(t("core.media.dropHint", "Drop files here to upload"))}</div>
    ${mediaBodyHtml(view.items, info)}
  </div>`;

  const uploadInput = document.querySelector("#upload");
  if (uploadInput) uploadInput.onchange = (e) => uploadFiles([...e.target.files]);

  // The drop zone is the whole panel, because the target a user aims at is
  // "somewhere on this screen" rather than a 3-pixel border.
  const drop = document.querySelector("#media-drop");
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      uploadFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  // Search is applied on a short debounce so typing does not fire a request per
  // keystroke, and both filters reset to page one — a filter that kept the old
  // page number would show an empty screen for a non-empty library.
  let searchTimer = null;
  const requery = () => { view = { ...view, page: 1 }; render(); };
  const q = document.querySelector("#media-q");
  if (q) q.addEventListener("input", () => { view = { ...view, q: q.value.trim() }; clearTimeout(searchTimer); searchTimer = setTimeout(requery, 250); });
  const type = document.querySelector("#media-type");
  if (type) type.addEventListener("change", () => { view = { ...view, type: type.value }; requery(); });
}

/** Upload every dropped/selected file, then show the newest first.
 *
 *  One request per file rather than a batch: the endpoint takes one object, and
 *  a partial failure should keep the files that did land instead of rolling the
 *  whole drop back. Failures are counted and reported, not swallowed. */
async function uploadFiles(files) {
  const list = files.filter(Boolean).slice(0, 20);
  if (!list.length) return;
  let ok = 0;
  const failed = [];
  for (const f of list) {
    const fd = new FormData();
    fd.append("file", f);
    try { await api(scoped("media"), { method: "POST", body: fd }); ok++; }
    catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  if (ok) toast(t("core.media.uploaded", "Uploaded"));
  if (failed.length) toast(failed[0], "error");
  render();
}

// ---------------------------------------------------------------------------
// Delegated actions. Registered once, at module load, because the screen is
// re-rendered on every filter change and per-render wiring would have to be
// repeated (and would be the thing that gets forgotten).
// ---------------------------------------------------------------------------

document.addEventListener("click", async (e) => {
  // Storage choice: one panel, no form submit. The pending value lives in
  // module state (see above), so this only flips the ring and the Save
  // button — the write happens in `saveStorage()`.
  const pick = e.target.closest("[data-storage-pick]");
  if (pick) {
    pendingProvider = { site: state.site, value: pick.dataset.storagePick };
    document.querySelectorAll("[data-storage-pick]").forEach((b) => {
      const on = b === pick;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const save = document.querySelector("[data-storage-save]");
    if (save) save.disabled = false;
    return;
  }
  const saveStorageBtn = e.target.closest("[data-storage-save]");
  if (saveStorageBtn) { await saveStorage(); return; }

  // Clearing is its own action, not "save an empty field": a blank input keeps
  // the key (the read never echoed it), so removing one needs an explicit
  // signal. The server implements this as `value: null` -> delete the row.
  const clearBtn = e.target.closest("[data-storage-clear]");
  if (clearBtn) {
    const key = clearBtn.dataset.storageClear;
    const sure = await confirmDialog({
      title: t("core.media.storageKeyClearTitle", "Remove this API key?"),
      description: t("core.media.storageKeyClearDesc", "Uploads to this host will stop working until a key is entered again. Files already uploaded stay where they are."),
      confirmLabel: t("core.media.storageKeyClear", "Clear"),
    });
    if (!sure) return;
    try {
      await api(scoped("settings"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: null }),
      });
      toast(t("core.media.storageKeyCleared", "Key removed"));
      render();
    } catch (err) { toast(err.message || "Could not clear the key", "error"); }
    return;
  }

  // The upload tile is part of the grid, so it survives "load more" without a
  // rebind — a delegated click just presses the header's hidden input.
  const up = e.target.closest("[data-media-upload]");
  if (up) { document.querySelector("#upload")?.click(); return; }

  const cp = e.target.closest("[data-copy]");
  if (cp) {
    try {
      await navigator.clipboard.writeText(new URL(cp.dataset.copy, location.origin).href);
      toast(t("core.media.urlCopied", "URL copied"));
    } catch { toast(t("core.media.copyFailed", "Could not copy"), "error"); }
    return;
  }

  const more = e.target.closest("[data-media-more]");
  if (more) {
    more.disabled = true;
    try {
      const info = await load({ append: true });
      const body = document.querySelector("#media-grid");
      if (body) {
        body.outerHTML = mediaBodyHtml(view.items, info);
      } else {
        render();
      }
    } catch (err) { toast(err.message, "error"); more.disabled = false; }
    return;
  }

  const del = e.target.closest("[data-media-del]");
  if (del) {
    const [id, name] = del.dataset.mediaDel.split("|");
    const sure = await confirmDialog({
      title: t("core.media.deleteTitle", "Delete this file?"),
      description: t("core.media.deleteDesc", "The file is removed from storage as well. Anything still pointing at its URL will break."),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!sure) return;
    try {
      await api(scoped(`media/${encodeURIComponent(id)}`), { method: "DELETE" });
      toast(t("core.msg.deleted", "Deleted."));
      view = { ...view, items: view.items.filter((r) => String(r.id) !== String(id)), total: Math.max(0, view.total - 1) };
      render();
    } catch (err) { toast(`${name}: ${err.message}`, "error"); }
  }
});

/** Alt text saves on `change` (which is blur or Enter), not on every keystroke:
 *  a PATCH per character would be a request per character. */
document.addEventListener("change", async (e) => {
  const alt = e.target.closest("[data-media-alt]");
  if (!alt) return;
  const id = alt.dataset.mediaAlt;
  const before = view.items.find((r) => String(r.id) === String(id))?.alt_text ?? "";
  if (alt.value === before) return;
  try {
    await api(scoped(`media/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: alt.value }),
    });
    const row = view.items.find((r) => String(r.id) === String(id));
    if (row) row.alt_text = alt.value;
    toast(t("core.media.altSaved", "Alt text saved"));
  } catch (err) {
    alt.value = before;
    toast(err.message, "error");
  }
});
