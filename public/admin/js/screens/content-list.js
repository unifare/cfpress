/**
 * Screen: content list — platform content (posts, pages) and theme-declared
 * custom post types. Delegates to the editor when `state.editing` is set.
 *
 * One row per post. The row shows the site's default language's title (the
 * server pins it; the previous `MIN(locale)` answer was alphabetically lucky),
 * a badge per language version the post actually has, and a language filter —
 * because "does this post have a Chinese version yet" is a question the list
 * must answer, not one the operator discovers by opening every post.
 */
import { api, contentPath, postTypeInfo, scoped, state } from "../state.js";
import { go, pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, emptyRow, esc, fmtDate, statusBadge } from "../../ui.js";
import { editor } from "./editor.js";

/** The active language filter (`""` = the site's default language). Kept at
 *  module level so it survives re-renders, like the editor's own state. */
let localeFilter = "";

export async function contentList(c, type) {
  const pt = postTypeInfo(type);
  if (state.editing) return editor(c, type);

  const query = localeFilter ? "?locale=" + encodeURIComponent(localeFilter) : "";
  const d = await api(scoped(contentPath(type)) + query);
  const items = d.items || [];

  // The filter lists the languages the site serves. `""` is the default —
  // the same rows the server shows when no filter is given.
  const filterOptions = ["", ...((state.locales || []).filter((l) => l !== ""))]
    .map((l) => `<option value="${attr(l)}"${l === localeFilter ? " selected" : ""}>${
      l ? esc(l) : esc(t("core.content.localeDefault", "Default language ({locale})", { locale: state.defaultLocale }))
    }</option>`)
    .join("");

  const rows = items.map((x) => {
    // A badge per language version the post has; the language whose row is on
    // display (title/slug above) is highlighted. With one version this reads
    // exactly like the old single-locale badge.
    const versions = Array.isArray(x.locales) && x.locales.length ? x.locales : [x.locale].filter(Boolean);
    const localeCell = versions.length
      ? versions.map((l) => `<span class="badge ${l === x.locale ? "primary" : "outline"}">${esc(l)}</span>`).join(" ")
      : `<span class="badge outline">—</span>`;
    return `<tr>
      <td><div style="font-weight:500">${esc(x.title || t("core.content.untitled", "(untitled)"))}</div><div class="muted text-sm">/${esc(x.slug || "")}</div></td>
      <td>${localeCell}</td>
      <td>${statusBadge(x.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(x.updated_at))}</td>
      <td class="actions"><button class="btn outline sm" data-edit="${attr(type)}|${attr(x.id)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button></td>
    </tr>`;
  }).join("");

  c.innerHTML = `${pageHead({
    title: pt.plural,
    sub: t("core.content.countOn", "{n} on {site}", {
      n: items.length,
      site: state.sites.find((s) => s.id === state.site)?.name || state.site,
    }),
    actions: `<button class="btn primary" data-new="${attr(type)}">${icon("plus")}${esc(t("core.content.add", "Add {type}", { type: pt.singular }))}</button>`,
    crumbs: [{ label: t("core.nav.content", "Content") }, { label: pt.plural }],
  })}
  <div class="toolbar" style="margin-bottom:.75rem">
    <label class="muted text-sm" for="contentLocale">${esc(t("core.content.locale", "Locale"))}</label>
    <select id="contentLocale">${filterOptions}</select>
  </div>
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.content.title", "Title"))}</th>
      <th>${esc(t("core.content.locale", "Locale"))}</th>
      <th>${esc(t("core.content.status", "Status"))}</th>
      <th>${esc(t("core.content.updated", "Updated"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(5, t("core.content.noneYet", "No {type} yet.", { type: pt.plural.toLowerCase() }))}</tbody>
  </table></div>`;
}

document.addEventListener("change", (e) => {
  const sel = e.target.closest("#contentLocale");
  if (!sel || sel.value === localeFilter) return;
  localeFilter = sel.value;
  go(state.page);
});
