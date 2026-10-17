/**
 * Screen: Tags & Taxonomy Management.
 *
 * Provides complete tag and taxonomy terms lifecycle management across
 * tenants and languages. Supports Core 'tag' and any theme-declared taxonomies.
 */
import { api, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";
import { t } from "../i18n.js";

let selectedTaxonomy = "tag";
let filterLocale = "";
let currentPage = 1;
let pageSize = 15;
let searchQuery = "";
let searchTimer = null;

export function buildTermTree(terms) {
  const byParent = new Map();
  for (const t of terms) {
    const pid = t.parent_id || "";
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(t);
  }
  const result = [];
  function traverse(parentId, depth) {
    const children = byParent.get(parentId) || [];
    for (const child of children) {
      result.push({ ...child, depth });
      traverse(child.id, depth + 1);
    }
  }
  traverse("", 0);
  if (result.length < terms.length) {
    const seen = new Set(result.map((r) => r.id));
    for (const t of terms) {
      if (!seen.has(t.id)) {
        result.push({ ...t, depth: 0 });
        seen.add(t.id);
        traverse(t.id, 1);
      }
    }
  }
  return result;
}

export default async function tags(c) {
  // 1. Fetch available taxonomies for current site (including theme-declared)
  const taxRes = await api(scoped("taxonomies")).catch(() => ({ items: [] }));
  const allTaxonomies = taxRes.items || [];
  // Ensure 'post_tag' or 'tag' is selected by default for Tags screen
  const taxOptions = allTaxonomies.length > 0 ? allTaxonomies : [
    { name: "post_tag", label: "Tags" },
    { name: "category", label: "Categories" },
  ];
  if (selectedTaxonomy === "tag" && taxOptions.some((x) => x.name === "post_tag")) {
    selectedTaxonomy = "post_tag";
  } else if (!taxOptions.some((x) => x.name === selectedTaxonomy)) {
    const tagTax = taxOptions.find((x) => x.name === "post_tag" || x.name === "tag");
    selectedTaxonomy = tagTax?.name || taxOptions[0]?.name || "post_tag";
  }

  // 2. Fetch terms for selected taxonomy (scoped to filterLocale if set)
  let termUrl = `taxonomies/${encodeURIComponent(selectedTaxonomy)}/terms`;
  if (filterLocale) {
    termUrl += `?locale=${encodeURIComponent(filterLocale)}`;
  }
  const termRes = await api(scoped(termUrl)).catch(() => ({ items: [] }));
  const termsList = Array.isArray(termRes.items) ? termRes.items : [];
  const isCategoryTax = selectedTaxonomy === "category" || selectedTaxonomy === "categories";

  // Build tree if category and not searching
  const q = searchQuery.toLowerCase().trim();
  const orderedTerms = isCategoryTax && !q ? buildTermTree(termsList) : termsList.map((t) => ({ ...t, depth: 0 }));

  // Filter terms by search query
  const filteredTerms = q
    ? orderedTerms.filter((tm) => (tm.name && tm.name.toLowerCase().includes(q)) || (tm.slug && tm.slug.toLowerCase().includes(q)))
    : orderedTerms;

  // Pagination calculation
  const total = filteredTerms.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const pagedTerms = filteredTerms.slice(startIdx, endIdx);

  // Available locales
  const siteLocales = state.locales || [];

  const crumbs = [
    { label: t("core.nav.content", "Content") },
    { label: t("core.tags.title", "Tags") },
  ];

  const taxButtons = taxOptions
    .map((x) => {
      const active = x.name === selectedTaxonomy;
      return `<button class="btn ${active ? "primary" : "outline"} sm" data-switch-taxonomy="${attr(x.name)}">${esc(x.label || x.name)}</button>`;
    })
    .join(" ");

  const localeFilterHtml = `
    <div style="display:flex;align-items:center;gap:.5rem">
      <span class="muted text-sm">${esc(t("core.widgets.fieldLocale", "Language"))}:</span>
      <select id="filter-tag-locale" class="sm" data-action="filter-locale" style="padding:.25rem .5rem;border-radius:4px;border:1px solid var(--cf-border);background:var(--cf-card-bg);color:var(--cf-fg)">
        <option value=""${filterLocale === "" ? " selected" : ""}>${esc(t("core.widgets.localeAll", "All languages"))}</option>
        ${siteLocales.map((l) => `<option value="${attr(l)}"${filterLocale === l ? " selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
    </div>
  `;

  const rows = pagedTerms.length === 0
    ? emptyRow(5, searchQuery ? t("core.tags.noMatch", "No tags match your search.") : t("core.tags.empty", "No tags found in this view."))
    : pagedTerms.map((tm) => {
        const localeBadge = tm.locale ? `<span class="badge secondary">${esc(tm.locale)}</span>` : `<span class="badge">${esc(t("core.tags.localeUniversal", "Universal"))}</span>`;
        const themeBadge = tm.declared_by_theme ? `<span class="badge outline" title="${attr(t("core.tags.presetByTheme", "Preset by {theme}", { theme: tm.declared_by_theme }))}" style="font-size:.7rem;margin-left:.35rem">${esc(t("core.tags.preset", "Preset"))}: ${esc(tm.declared_by_theme)}</span>` : "";
        const indent = tm.depth > 0 ? `<span class="muted" style="user-select:none;font-family:monospace;margin-right:.25rem">${"— ".repeat(tm.depth)}</span>` : "";
        return `
          <tr>
            <td>${indent}<strong>${esc(tm.name)}</strong>${themeBadge}</td>
            <td><code>${esc(tm.slug)}</code></td>
            <td>${localeBadge}</td>
            <td><span class="badge">${Number(tm.count || 0)}</span></td>
            <td style="text-align:right">
              <button class="btn outline sm" data-edit-tag="${attr(tm.id)}">${icon("pencil")}${esc(t("core.action.edit", "Edit"))}</button>
              <button class="btn outline danger sm" data-delete-tag="${attr(tm.id)}">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>
            </td>
          </tr>
        `;
      }).join("");

  const parentSelectHtml = isCategoryTax ? `
    <div class="field">
      <label for="tag-parent">${esc(t("core.tags.parent", "Parent Category"))}</label>
      <select id="tag-parent">
        <option value="">${esc(t("core.tags.noParent", "— None (Top Level) —"))}</option>
        ${orderedTerms.map((c) => `<option value="${attr(c.id)}">${"　".repeat(c.depth)}${c.depth > 0 ? "— " : ""}${esc(c.name)}</option>`).join("")}
      </select>
    </div>
  ` : "";

  c.innerHTML = `
    ${pageHead({
      title: t("core.tags.title", "Tags"),
      sub: t("core.tags.sub", "Manage taxonomy terms and multi-language tags"),
      crumbs,
    })}

    <div class="panel" style="margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem">
      <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
        <span class="muted text-sm">${esc(t("core.tags.taxonomy", "Taxonomy"))}:</span>
        ${taxButtons}
      </div>
      ${localeFilterHtml}
    </div>

    <div class="grid2" style="grid-template-columns: 24rem minmax(0, 1fr)">
      <!-- Left: Create Form -->
      <div>
        <div class="panel">
          <div class="card-title" style="margin-bottom:.5rem">${esc(t("core.tags.addNew", "Add New Tag"))}</div>
          <p class="muted text-sm" style="margin-bottom:1rem">${esc(t("core.tags.addHint", "Create a tag or term for this site. Tags can be tied to a specific language or apply universally."))}</p>
          <form id="create-tag-form">
            <div class="field">
              <label class="req" for="tag-name">${esc(t("core.tags.name", "Name"))}</label>
              <input id="tag-name" required placeholder="${attr(t("core.tags.namePlaceholder", "e.g. Cloudflare"))}">
            </div>
            <div class="field">
              <label for="tag-slug">${esc(t("core.content.slug", "Slug"))}</label>
              <input id="tag-slug" placeholder="${attr(t("core.tags.slugAuto", "auto-generated if empty"))}">
              <span class="hint">${esc(t("core.tags.slugHint", "The URL-friendly version of the name, unique within language."))}</span>
            </div>
            ${parentSelectHtml}
            <div class="field">
              <label for="tag-locale">${esc(t("core.widgets.fieldLocale", "Language"))}</label>
              <select id="tag-locale">
                <option value="">${esc(t("core.widgets.localeAll", "All languages (Universal)"))}</option>
                ${siteLocales.map((l) => `<option value="${attr(l)}"${filterLocale === l ? " selected" : ""}>${esc(l)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="tag-desc">${esc(t("core.tags.desc", "Description"))}</label>
              <textarea id="tag-desc" rows="3" placeholder="${attr(t("core.tags.descPlaceholder", "Optional description for archive pages"))}"></textarea>
            </div>
            <button type="submit" class="btn primary" style="width:100%">${icon("plus")}${esc(t("core.tags.createBtn", "Add Tag"))}</button>
          </form>
        </div>
      </div>

      <!-- Right: List Table with Search & Pagination -->
      <div>
        <div class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;gap:.75rem;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:.5rem">
              <div style="position:relative;width:220px">
                <input type="search" id="tag-search-input" value="${attr(searchQuery)}" placeholder="${attr(t("core.tags.searchPlaceholder", "Search tags..."))}" style="padding:.35rem .6rem;padding-left:1.85rem;border-radius:4px;border:1px solid var(--cf-border);background:var(--cf-card-bg);color:var(--cf-fg);width:100%;font-size:.85rem">
                <span style="position:absolute;left:.55rem;top:50%;transform:translateY(-50%);color:var(--cf-muted);pointer-events:none;display:flex">${icon("search")}</span>
              </div>
              ${searchQuery ? `<button class="btn outline sm" id="tag-search-clear" title="${attr(t("core.action.cancel", "Clear"))}">✕</button>` : ""}
            </div>
            <div class="muted text-sm">
              ${esc(t("core.tags.totalCount", "Total: {n} tags", { n: total }))}
            </div>
          </div>

          <div class="table-wrap"><table class="table">
              <thead>
                <tr>
                  <th>${esc(t("core.tags.name", "Name"))}</th>
                  <th>${esc(t("core.content.slug", "Slug"))}</th>
                  <th>${esc(t("core.widgets.fieldLocale", "Language"))}</th>
                  <th>${esc(t("core.tags.count", "Count"))}</th>
                  <th style="text-align:right">${esc(t("core.tags.actions", "Actions"))}</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>

          ${total > 0 ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;flex-wrap:wrap;gap:.75rem">
            <div class="muted text-sm" style="display:flex;align-items:center;gap:.75rem">
              <span>${esc(t("core.tags.pageInfo", "Showing {from}-{to} of {total}", { from: startIdx + 1, to: endIdx, total }))}</span>
              <select id="tag-page-size" class="sm" style="padding:.2rem .4rem;border-radius:4px;border:1px solid var(--cf-border);background:var(--cf-card-bg);color:var(--cf-fg);font-size:.8rem">
                <option value="10"${pageSize === 10 ? " selected" : ""}>10 / ${esc(t("core.tags.perPage", "page"))}</option>
                <option value="15"${pageSize === 15 ? " selected" : ""}>15 / ${esc(t("core.tags.perPage", "page"))}</option>
                <option value="30"${pageSize === 30 ? " selected" : ""}>30 / ${esc(t("core.tags.perPage", "page"))}</option>
                <option value="50"${pageSize === 50 ? " selected" : ""}>50 / ${esc(t("core.tags.perPage", "page"))}</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:.35rem">
              <button type="button" class="btn outline sm" data-tag-page="1" ${currentPage <= 1 ? "disabled" : ""} title="${attr(t("core.tags.firstPage", "First page"))}">«</button>
              <button type="button" class="btn outline sm" data-tag-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""} title="${attr(t("core.tags.prevPage", "Previous page"))}">${icon("chevron-left")}</button>
              <span class="muted text-sm" style="padding:0 .5rem;font-weight:500">${currentPage} / ${totalPages}</span>
              <button type="button" class="btn outline sm" data-tag-page="${currentPage + 1}" ${currentPage >= totalPages ? "disabled" : ""} title="${attr(t("core.tags.nextPage", "Next page"))}">${icon("chevron-right")}</button>
              <button type="button" class="btn outline sm" data-tag-page="${totalPages}" ${currentPage >= totalPages ? "disabled" : ""} title="${attr(t("core.tags.lastPage", "Last page"))}">»</button>
            </div>
          </div>` : ""}
        </div>
      </div>
    </div>
  `;

  // Search input handler with debounce
  const searchInput = c.querySelector("#tag-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const val = e.target.value;
      searchTimer = setTimeout(() => {
        searchQuery = val;
        currentPage = 1;
        render();
        const updated = document.querySelector("#tag-search-input");
        if (updated) {
          updated.focus();
          const l = updated.value.length;
          updated.setSelectionRange(l, l);
        }
      }, 200);
    });
  }

  // Page size select handler
  const pageSizeSel = c.querySelector("#tag-page-size");
  if (pageSizeSel) {
    pageSizeSel.addEventListener("change", (e) => {
      pageSize = Number(e.target.value) || 15;
      currentPage = 1;
      render();
    });
  }

  // Submit handler for create
  const form = document.querySelector("#create-tag-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.querySelector("#tag-name")?.value.trim();
      const slug = document.querySelector("#tag-slug")?.value.trim();
      const locale = document.querySelector("#tag-locale")?.value.trim();
      const description = document.querySelector("#tag-desc")?.value.trim();
      if (!name) return;

      try {
        const parent_id = isCategoryTax ? (document.querySelector("#tag-parent")?.value.trim() || null) : null;
        await api(scoped(`taxonomies/${encodeURIComponent(selectedTaxonomy)}/terms`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, slug, locale, description, parent_id }),
        });
        toast(t("core.tags.created", "Tag created successfully"));
        render();
      } catch (err) {
        toast(err.message || "Failed to create tag", "error");
      }
    });
  }

  // Filter change
  const filterSelect = document.querySelector("#filter-tag-locale");
  if (filterSelect) {
    filterSelect.addEventListener("change", (e) => {
      filterLocale = e.target.value;
      currentPage = 1;
      render();
    });
  }
}

// Delegated click handler for switching taxonomies, edit, delete, and pagination
document.addEventListener("click", async (e) => {
  const switchBtn = e.target.closest("[data-switch-taxonomy]");
  if (switchBtn) {
    selectedTaxonomy = switchBtn.dataset.switchTaxonomy;
    currentPage = 1;
    searchQuery = "";
    render();
    return;
  }

  const pageBtn = e.target.closest("[data-tag-page]");
  if (pageBtn && !pageBtn.disabled) {
    const p = Number(pageBtn.dataset.tagPage);
    if (!Number.isNaN(p)) {
      currentPage = p;
      render();
    }
    return;
  }

  const clearBtn = e.target.closest("#tag-search-clear");
  if (clearBtn) {
    searchQuery = "";
    currentPage = 1;
    render();
    return;
  }

  const editBtn = e.target.closest("[data-edit-tag]");
  if (editBtn) {
    const termId = editBtn.dataset.editTag;
    try {
      const res = await api(scoped(`terms/${encodeURIComponent(termId)}`));
      const cur = res.item;
      if (!cur) return;
      const siteLocales = state.locales || [];
      const isCat = cur.taxonomy === "category" || cur.taxonomy === "categories" || selectedTaxonomy === "category" || selectedTaxonomy === "categories";
      const fields = [
        { name: "name", label: t("core.tags.name", "Name"), value: cur.name, required: true },
        { name: "slug", label: t("core.content.slug", "Slug"), value: cur.slug },
      ];
      if (isCat) {
        const allTermsRes = await api(scoped(`taxonomies/${encodeURIComponent(cur.taxonomy || "category")}/terms`)).catch(() => ({ items: [] }));
        const allTerms = Array.isArray(allTermsRes.items) ? allTermsRes.items : [];
        const tree = buildTermTree(allTerms);
        const exclude = new Set([cur.id]);
        function findKids(pid) {
          for (const item of allTerms) {
            if (item.parent_id === pid) {
              exclude.add(item.id);
              findKids(item.id);
            }
          }
        }
        findKids(cur.id);
        const validParents = tree.filter((c) => !exclude.has(c.id));
        fields.push({
          name: "parent_id",
          label: t("core.tags.parent", "Parent Category"),
          type: "select",
          value: cur.parent_id || "",
          options: [
            { value: "", label: t("core.tags.noParent", "— None (Top Level) —") },
            ...validParents.map((c) => ({
              value: c.id,
              label: `${"　".repeat(c.depth)}${c.depth > 0 ? "— " : ""}${c.name}`,
            })),
          ],
        });
      }
      fields.push(
        {
          name: "locale",
          label: t("core.widgets.fieldLocale", "Language"),
          type: "select",
          value: cur.locale || "",
          options: [
            { value: "", label: t("core.widgets.localeAll", "All languages (Universal)") },
            ...siteLocales.map((l) => ({ value: l, label: l })),
          ],
        },
        { name: "description", label: t("core.tags.desc", "Description"), type: "textarea", value: cur.description || "" },
      );
      const dialogRes = await openDialog({
        title: t("core.tags.editTitle", "Edit Tag"),
        confirmLabel: t("core.action.save", "Save"),
        fields,
      });
      if (!dialogRes) return;
      await api(scoped(`terms/${encodeURIComponent(termId)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dialogRes),
      });
      toast(t("core.tags.updated", "Tag updated successfully"));
      render();
    } catch (err) {
      toast(err.message || "Failed to update tag", "error");
    }
    return;
  }

  const delBtn = e.target.closest("[data-delete-tag]");
  if (delBtn) {
    const termId = delBtn.dataset.deleteTag;
    const ok = await confirmDialog({
      title: t("core.tags.deleteTitle", "Delete this tag?"),
      description: t("core.tags.deleteDesc", "This will unbind the tag from all posts. Posts themselves will not be deleted."),
      confirmLabel: t("core.action.delete", "Delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(scoped(`terms/${encodeURIComponent(termId)}`), { method: "DELETE" });
      toast(t("core.tags.deleted", "Tag deleted"));
      render();
    } catch (err) {
      toast(err.message || "Failed to delete tag", "error");
    }
    return;
  }
});
