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
import { buildTermTree } from "./tags.js";

/** The active language filter (`""` = the site's default language). Kept at
 *  module level so it survives re-renders, like the editor's own state. */
let localeFilter = "";
let categoryFilter = "";

export async function contentList(c, type) {
  const pt = postTypeInfo(type);
  if (state.editing) return editor(c, type);

  // Fetch categories for tree filter
  const catRes = await api(scoped("taxonomies/category/terms")).catch(() => ({ items: [] }));
  const catItems = Array.isArray(catRes.items) ? catRes.items : [];
  const catTree = buildTermTree(catItems);

  const queryParts = [];
  if (localeFilter) queryParts.push("locale=" + encodeURIComponent(localeFilter));
  if (categoryFilter) queryParts.push("category=" + encodeURIComponent(categoryFilter));
  const query = queryParts.length ? "?" + queryParts.join("&") : "";

  const d = await api(scoped(contentPath(type)) + query);
  const items = d.items || [];

  // The filter lists the languages the site serves. `""` is the default —
  // the same rows the server shows when no filter is given.
  const filterOptions = ["", ...((state.locales || []).filter((l) => l !== ""))]
    .map((l) => `<option value="${attr(l)}"${l === localeFilter ? " selected" : ""}>${
      l ? esc(l) : esc(t("core.content.localeDefault", "Default language ({locale})", { locale: state.defaultLocale }))
    }</option>`)
    .join("");

  const catOptions = catTree.map((cat) => {
    const prefix = "　".repeat(cat.depth) + (cat.depth > 0 ? "— " : "");
    return `<option value="${attr(cat.id)}"${cat.id === categoryFilter ? " selected" : ""}>${prefix}${esc(cat.name)}</option>`;
  }).join("");

  const rows = items.map((x) => {
    // A badge per language version the post has; the language whose row is on
    // display (title/slug above) is highlighted. With one version this reads
    // exactly like the old single-locale badge.
    const versions = Array.isArray(x.locales) && x.locales.length ? x.locales : [x.locale].filter(Boolean);
    const localeCell = versions.length
      ? versions.map((l) => `<span class="badge ${l === x.locale ? "primary" : "outline"}">${esc(l)}</span>`).join(" ")
      : `<span class="badge outline">—</span>`;

    const cats = Array.isArray(x.categories) && x.categories.length ? x.categories : [];
    const catCell = cats.length
      ? cats.map((c) => `<span class="badge outline">${esc(c.name || c.slug)}</span>`).join(" ")
      : `<span class="badge outline muted" style="opacity:.6">—</span>`;

    const displayUrl = x.url || (x.slug ? `/${x.slug}` : "/");
    return `<tr>
      <td>
        <div style="font-weight:500">${esc(x.title || t("core.content.untitled", "(untitled)"))}</div>
        <div class="muted text-sm">
          <a href="${attr(displayUrl)}" target="_blank" rel="noopener noreferrer" class="muted text-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:.25rem" title="${attr(t("core.content.view", "View"))}">
            ${esc(displayUrl)}
            ${icon("external", 'style="width:12px;height:12px;opacity:.7"')}
          </a>
        </div>
      </td>
      <td>${catCell}</td>
      <td>${localeCell}</td>
      <td>${statusBadge(x.status)}</td>
      <td class="muted text-sm">${esc(fmtDate(x.updated_at))}</td>
      <td class="actions" style="display:flex;gap:.5rem;align-items:center;justify-content:flex-end">
        <a class="btn outline sm" href="${attr(displayUrl)}" target="_blank" rel="noopener noreferrer" title="${attr(t("core.content.view", "View"))}">${icon("external")}${esc(t("core.content.view", "View"))}</a>
        <button class="btn outline sm" data-edit="${attr(type)}|${attr(x.id)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button>
      </td>
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
  <div class="toolbar" style="margin-bottom:.75rem;display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap">
    <div style="display:flex;gap:.5rem;align-items:center">
      <label class="muted text-sm" for="contentCategory">${esc(t("core.content.category", "Category"))}</label>
      <select id="contentCategory">
        <option value="">${esc(t("core.content.allCategories", "All Categories"))}</option>
        ${catOptions}
      </select>
    </div>
    <div style="display:flex;gap:.5rem;align-items:center">
      <label class="muted text-sm" for="contentLocale">${esc(t("core.content.locale", "Locale"))}</label>
      <select id="contentLocale">${filterOptions}</select>
    </div>
  </div>
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.content.title", "Title"))}</th>
      <th>${esc(t("core.content.categories", "Categories"))}</th>
      <th>${esc(t("core.content.locale", "Locale"))}</th>
      <th>${esc(t("core.content.status", "Status"))}</th>
      <th>${esc(t("core.content.updated", "Updated"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(6, t("core.content.noneYet", "No {type} yet.", { type: pt.plural.toLowerCase() }))}</tbody>
  </table></div>`;
}

document.addEventListener("change", (e) => {
  const catSel = e.target.closest("#contentCategory");
  if (catSel && catSel.value !== categoryFilter) {
    categoryFilter = catSel.value;
    go(state.page);
    return;
  }
  const sel = e.target.closest("#contentLocale");
  if (!sel || sel.value === localeFilter) return;
  localeFilter = sel.value;
  go(state.page);
});
