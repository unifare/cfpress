/**
 * Screen: Permalinks — configuration for post and archive URL structures.
 *
 * Provides WordPress / dotnetcms style structure presets:
 * - Plain: /?p=123
 * - Day and name: /%year%/%monthnum%/%day%/%postname%/
 * - Month and name: /%year%/%monthnum%/%postname%/
 * - Numeric: /archives/%post_id%
 * - Post name: /posts/%postname%/
 * - Custom Structure with tag chips
 */
import { api, scoped } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc, toast } from "../../ui.js";

const PRESETS = [
  { id: "plain", label: "Plain (朴素)", pattern: "/?p=%post_id%", example: "/?p=123" },
  { id: "day_name", label: "Day and name (日期和名称)", pattern: "/%year%/%monthnum%/%day%/%postname%/", example: "/2026/03/22/sample-post/" },
  { id: "month_name", label: "Month and name (月份和名称)", pattern: "/%year%/%monthnum%/%postname%/", example: "/2026/03/sample-post/" },
  { id: "numeric", label: "Numeric (数字型)", pattern: "/archives/%post_id%", example: "/archives/123" },
  { id: "post_name", label: "Post name (文章名)", pattern: "/posts/%postname%/", example: "/posts/sample-post/" },
  { id: "custom", label: "Custom Structure (自定义结构)", pattern: "", example: "e.g. /%category%/%postname%/" },
];

const AVAILABLE_TAGS = [
  "%year%",
  "%monthnum%",
  "%day%",
  "%hour%",
  "%minute%",
  "%second%",
  "%post_id%",
  "%postname%",
  "%category%",
  "%author%",
  "%pagename%",
];

export default async function urls(c) {
  const d = await api(scoped("settings"));
  const v = Object.fromEntries((d.items || []).map((x) => [x.key, x.value]));

  const currentPattern = v["permalink.structure"] || "/posts/%postname%/";
  const categoryBase = v["permalink.category_base"] || "category";
  const tagBase = v["permalink.tag_base"] || "tag";

  // Match preset or mark as custom
  const matchedPreset = PRESETS.find((p) => p.pattern && p.pattern === currentPattern);
  const selectedPresetId = matchedPreset ? matchedPreset.id : "custom";

  const renderPresetRadio = (preset) => {
    const checked = selectedPresetId === preset.id ? "checked" : "";
    return `
      <label class="list-row" style="cursor:pointer;display:flex;align-items:center;gap:.75rem;padding:.75rem 0">
        <input type="radio" name="permalink_preset" value="${attr(preset.id)}" data-pattern="${attr(preset.pattern)}" ${checked}>
        <div style="flex:1">
          <div style="font-weight:500">${esc(preset.label)}</div>
          <div class="muted text-sm" style="font-family:monospace">${esc(preset.example)}</div>
        </div>
      </label>
    `;
  };

  const renderTags = () => AVAILABLE_TAGS.map((tag) => `
    <button type="button" class="btn outline sm" style="font-family:monospace;margin:.2rem" data-action="insert-tag" data-tag="${attr(tag)}">
      ${esc(tag)}
    </button>
  `).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.urls", "Permalinks"),
    sub: t("core.permalink.sub", "Configure URL structures for posts, pages and taxonomy archives"),
    actions: `<button class="btn primary" data-action="save-permalinks">${icon("save")}${esc(t("core.action.save", "Save"))}</button>`,
    crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.nav.urls", "Permalinks") }],
  })}
  <div class="grid2" style="grid-template-columns:2fr 1fr">
    <div class="panel">
      <div class="card-title" style="margin-bottom:1rem">${esc(t("core.permalink.commonSettings", "Common Settings"))}</div>
      <div style="margin-bottom:1.5rem">
        ${PRESETS.map(renderPresetRadio).join("")}
      </div>

      <div class="field" style="margin-top:1.5rem">
        <label for="custom_structure">${esc(t("core.permalink.customStructure", "Custom Structure"))}</label>
        <input id="custom_structure" style="font-family:monospace" value="${attr(currentPattern)}">
      </div>

      <div class="field" style="margin-top:1rem">
        <label class="muted text-sm">${esc(t("core.permalink.availableTags", "Available tags (click to insert)"))}:</label>
        <div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.5rem">
          ${renderTags()}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="card-title" style="margin-bottom:1rem">${esc(t("core.permalink.optional", "Optional Bases"))}</div>
      <div class="card-desc" style="margin-bottom:1rem">${esc(t("core.permalink.optionalDesc", "Prepend custom prefixes to your category and tag archive URLs."))}</div>

      <div class="field">
        <label for="category_base">${esc(t("core.permalink.categoryBase", "Category base"))}</label>
        <input id="category_base" placeholder="category" value="${attr(categoryBase)}">
      </div>

      <div class="field">
        <label for="tag_base">${esc(t("core.permalink.tagBase", "Tag base"))}</label>
        <input id="tag_base" placeholder="tag" value="${attr(tagBase)}">
      </div>
    </div>
  </div>`;
}

document.addEventListener("change", (e) => {
  if (e.target.name === "permalink_preset") {
    const pattern = e.target.dataset.pattern;
    const input = document.querySelector("#custom_structure");
    if (input && pattern) {
      input.value = pattern;
    }
  }
});

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;

  if (a.dataset.action === "insert-tag") {
    const tag = a.dataset.tag;
    const input = document.querySelector("#custom_structure");
    if (input && tag) {
      input.value += (input.value.endsWith("/") ? "" : "/") + tag + "/";
      input.focus();
      // Select Custom Radio
      const customRadio = document.querySelector('input[name="permalink_preset"][value="custom"]');
      if (customRadio) customRadio.checked = true;
    }
    return;
  }

  if (a.dataset.action === "save-permalinks") {
    const structure = document.querySelector("#custom_structure")?.value || "/posts/%postname%/";
    const categoryBase = document.querySelector("#category_base")?.value || "category";
    const tagBase = document.querySelector("#tag_base")?.value || "tag";

    await Promise.all([
      api(scoped("settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "permalink.structure", value: structure }),
      }),
      api(scoped("settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "permalink.category_base", value: categoryBase }),
      }),
      api(scoped("settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "permalink.tag_base", value: tagBase }),
      }),
    ]);

    toast(t("core.permalink.saved", "Permalink settings saved"));
  }
});
