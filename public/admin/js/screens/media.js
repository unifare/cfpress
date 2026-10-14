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

let view = { q: "", type: "", page: 1, items: [], total: 0, storage: null };

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
 *  lives where the files are, not only in the header.
 *
 *  `storage` is optional and defaults to "fine", because the two call sites that
 *  matter (the first paint and "load more") must pass the same value or the tile
 *  would vanish on page two. The tile is dropped entirely when uploads are
 *  refused: an affordance that opens a picker whose every file then fails is
 *  worse than no affordance. */
export function mediaBodyHtml(items, info, storage = null) {
  const shown = (items ?? []).length;
  const add = t("core.media.addMedia", "Upload files");
  const canUpload = !mediaStorageOff(storage);
  return `<div id="media-grid" class="media-grid">
    ${canUpload
      ? `<button type="button" class="media-tile media-upload-tile" data-media-upload="1" title="${attr(add)}" aria-label="${attr(add)}">${icon("upload")}<span>${esc(add)}</span></button>`
      : ""}
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
  view = { ...view, page: info.page, total: info.total, storage: d.storage ?? null, items: append ? [...view.items, ...items] : items };
  return info;
}

/** The storage state when uploads are refused, or `null` when they are fine.
 *
 *  An **absent** state reads as fine on purpose. The field is newer than the
 *  endpoint, and a screen that treated "I was not told" as "storage is off"
 *  would invent a refusal — the one failure mode worse than not explaining. */
export function mediaStorageOff(storage) {
  return storage && storage.available === false ? storage : null;
}

/** The advice for a refusal, in the operator's language.
 *
 *  `code` picks the sentence, because the two refusals need different fixes:
 *  "turn the switch on" (Tools -> Features, no redeploy) versus "add the R2
 *  binding and redeploy". Showing the wrong one sends the operator round a
 *  loop — which is why the server sends a code rather than only prose. */
export function mediaStorageHint(state) {
  if (state?.code === "no_binding") {
    return t(
      "core.media.storageOffBinding",
      "This deployment declares no MEDIA bucket, so there is nowhere to store files. Add the R2 binding and redeploy — turning the switch on will not help on its own."
    );
  }
  return t(
    "core.media.storageOffSwitch",
    "Uploads are refused until you turn on the media_store_r2 switch under Tools, Features. Files already uploaded keep working."
  );
}

/** The banner that says uploads are off, and why. Empty when they are not. */
export function mediaStorageNoticeHtml(storage) {
  const off = mediaStorageOff(storage);
  if (!off) return "";
  return `<div class="panel" data-media-storage-off="${attr(off.code || "unknown")}" style="margin-bottom:.75rem">
    <div class="card-title">${esc(t("core.media.storageOff", "Media storage is off for this site"))}</div>
    <div class="muted text-sm" style="margin-top:.35rem">${esc(mediaStorageHint(off))}</div>
  </div>`;
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

  // Uploads refused? Then the header control is not a control — it is a label
  // that opens a picker whose every file would fail. It becomes inert text, and
  // the banner below says which fix applies.
  const off = mediaStorageOff(view.storage);

  c.innerHTML = `${pageHead({
    title: t("core.media.title", "Media"),
    sub: t(info.total === 1 ? "core.media.subOne" : "core.media.subMany", "{n} files in this site's library", { n: info.total }),
    actions: off
      ? `<span class="btn outline" aria-disabled="true" title="${attr(mediaStorageHint(off))}">${icon("upload")}${esc(t("core.media.upload", "Upload"))}</span>`
      : `<label class="btn primary">${icon("upload")}${esc(t("core.media.upload", "Upload"))}<input id="upload" type="file" multiple hidden></label>`,
    crumbs: [{ label: t("core.nav.content", "Content") }, { label: t("core.media.title", "Media") }],
  })}
  ${mediaStorageNoticeHtml(view.storage)}
  <div class="toolbar" style="margin-bottom:.75rem">
    <input id="media-q" value="${attr(view.q)}" placeholder="${attr(t("core.msg.searchPlaceholder", "Search…"))}" style="flex:1">
    <select id="media-type">
      ${filter("", t("core.media.filterAll", "All types"))}
      ${filter("image/", t("core.media.filterImages", "Images"))}
      ${filter("application/", t("core.media.filterDocuments", "Documents"))}
    </select>
  </div>
  <div id="media-drop" class="media-drop">
    <div class="media-drop-hint muted text-sm">${esc(off ? mediaStorageHint(off) : t("core.media.dropHint", "Drop files here to upload"))}</div>
    ${mediaBodyHtml(view.items, info, view.storage)}
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
 *  whole drop back. Failures are counted and reported, not swallowed.
 *
 *  The storage check is here, at the single choke point both doors reach (the
 *  picker and the drop zone), rather than at each: the server refuses anyway,
 *  but a per-file 503 toast says "503" twenty times where one sentence about
 *  the switch is the actual answer. */
async function uploadFiles(files) {
  const list = files.filter(Boolean).slice(0, 20);
  if (!list.length) return;
  if (mediaStorageOff(view.storage)) {
    toast(t("core.media.storageOffToast", "Media storage is off — see the notice above"), "error");
    return;
  }
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
        body.outerHTML = mediaBodyHtml(view.items, info, view.storage);
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
