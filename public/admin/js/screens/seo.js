/**
 * Screen: SEO — title template, meta description, robots and the endpoints
 * they drive.
 */
import { api, scoped } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc, toast } from "../../ui.js";

export default async function seo(c) {
  const d = await api(scoped("settings"));
  const v = Object.fromEntries((d.items || []).map((x) => [x.key, x.value]));
  c.innerHTML = `${pageHead({
    title: t("core.nav.seo", "SEO"),
    sub: t("core.seo.sub", "Titles, descriptions and crawl directives for this site"),
    actions: `<button class="btn primary" data-action="save-seo">${icon("save")}${esc(t("core.action.save", "Save"))}</button>`,
    crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.nav.seo", "SEO") }],
  })}
  <div class="grid2">
    <div class="panel">
      <div class="field"><label for="st">${esc(t("core.seo.titleTemplate", "Title template"))}</label><input id="st" value="${attr(v["seo.titleTemplate"] || "%title% | %site%")}"><span class="hint">${esc(t("core.seo.titleHint", "%title% and %site% are replaced at render time"))}</span></div>
      <div class="field"><label for="sd">${esc(t("core.seo.metaDescription", "Meta description"))}</label><textarea id="sd">${esc(v["seo.description"] || "")}</textarea></div>
      <div class="field" style="margin-bottom:0"><label for="sr">${esc(t("core.seo.robots", "Robots"))}</label><input id="sr" value="${attr(v["seo.robots"] || "index,follow")}"><span class="hint">${esc(t("core.seo.robotsHint", "e.g. index,follow or noindex,nofollow"))}</span></div>
    </div>
    <div class="panel">
      <div class="card-title">${esc(t("core.seo.endpoints", "Generated endpoints"))}</div>
      <div class="list-row"><div class="title">${esc(t("core.seo.sitemap", "Sitemap"))}</div><a class="btn outline sm" href="/sitemap.xml" target="_blank" rel="noopener">${icon("external")}/sitemap.xml</a></div>
      <div class="list-row"><div class="title">${esc(t("core.seo.robotsFile", "Robots"))}</div><a class="btn outline sm" href="/robots.txt" target="_blank" rel="noopener">${icon("external")}/robots.txt</a></div>
      <div class="list-row"><div class="title">hreflang</div><span class="muted text-sm">${esc(t("core.seo.hreflangNote", "Emitted on frontend pages"))}</span></div>
    </div>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action !== "save-seo") return;
  for (const [key, id] of [["seo.titleTemplate", "st"], ["seo.description", "sd"], ["seo.robots", "sr"]]) {
    await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value: document.querySelector("#" + id).value }) });
  }
  toast(t("core.seo.saved", "SEO saved"));
});
