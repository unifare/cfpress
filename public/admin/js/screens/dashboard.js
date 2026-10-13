/**
 * Screen: Dashboard — counts, recent content and what the active theme brings.
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc } from "../../ui.js";

export default async function dashboard(c) {
  const d = await api(scoped("dashboard"));
  const site = state.sites.find((s) => s.id === state.site);

  const stat = (label, value, note) => `<div class="card">
    <div class="card-head"><span class="card-title">${esc(label)}</span>${icon("chart", 'class="nav-icon" style="width:1rem;height:1rem;color:var(--muted-foreground)"')}</div>
    <div class="metric">${esc(value ?? 0)}</div>
    ${note ? `<div class="metric-note">${note}</div>` : ""}
  </div>`;

  const cptCards = state.postTypes
    .map((pt) => `<div class="card">
      <div class="card-head"><span class="card-title">${esc(pt.plural_label || pt.label || pt.name)}</span><span class="badge secondary">CPT</span></div>
      <div class="metric-note" style="margin-top:.75rem">${esc(t("core.dash.cptNote", "Theme-declared content type"))}</div>
      <button class="btn outline sm" style="margin-top:.75rem" data-nav="cpt:${attr(pt.name)}">${esc(t("core.action.open", "Open"))}</button>
    </div>`)
    .join("");

  // The stat cards arrive as data (`cards` from the dashboard API, labels
  // translated server-side, plugins may inject their own). Never re-list
  // stat cards here.
  const cards = (d.cards || []).map((card) => stat(card.label, card.value, card.note)).join("");

  const recent = (d.recent || []).slice(0, 5).map((r) => `<div class="list-row">
      <div><div class="title">${esc(r.title || t("core.content.untitled", "(untitled)"))}</div><div class="meta">${esc(r.type)} · ${esc(r.locale || "—")}</div></div>
      <span class="badge secondary">${esc(r.status)}</span>
    </div>`).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.dashboard", "Dashboard"),
    sub: t("core.dash.sub", "{site} · Cloudflare-native CMS", { site: site?.name || state.site }),
    actions: `<button class="btn outline" data-nav="search">${icon("search")}${esc(t("core.action.search", "Search"))}</button>
              <button class="btn primary" data-nav="posts">${icon("plus")}${esc(t("core.dash.newPost", "New post"))}</button>`,
    crumbs: [{ label: t("core.nav.general", "General") }, { label: t("core.nav.dashboard", "Dashboard") }],
  })}
  <div class="cards cols-4">
    ${cards}
  </div>
  <div class="grid2" style="margin-top:1.25rem;grid-template-columns:minmax(0,1fr) 22rem">
    <div class="panel">
      <div class="card-head" style="margin-bottom:1rem">
        <div><div class="card-title">${esc(t("core.dash.recent", "Recent content"))}</div><div class="card-desc">${esc(t("core.dash.recentSub", "Latest updates across this site"))}</div></div>
        <button class="btn outline sm" data-nav="posts">${esc(t("core.dash.viewAll", "View all"))}</button>
      </div>
      ${recent || `<div class="empty">${esc(t("core.content.empty", "No content yet."))}</div>`}
    </div>
    <div class="panel">
      <div class="card-title">CFPress 0.8.0</div>
      <p class="muted text-sm" style="margin:.5rem 0 0">${esc(t("core.dash.versionDesc", "Multi-site, theme business packages (custom post types, fields, routes, admin menus), declarative template engine, revisions, autosave, multilingual content, R2 media and block editor."))}</p>
      <div class="menu-sep" style="margin:1rem -1.25rem"></div>
      <div class="card-title">${esc(t("core.dash.activeTheme", "Active theme"))}</div>
      <div id="dash-theme" class="muted text-sm" style="margin-top:.5rem">${esc(t("core.msg.loading", "Loading…"))}</div>
    </div>
  </div>
  ${cptCards ? `<div class="panel" style="margin-top:1.25rem">
    <div class="card-title" style="margin-bottom:1rem">${esc(t("core.dash.cptSection", "Content types from the active theme"))}</div>
    <div class="cards">${cptCards}</div>
  </div>` : ""}`;

  // Theme name loads independently so a failure never blanks the dashboard.
  api(scoped("extensions/themes"))
    .then((t2) => {
      const active = (t2.items || []).find((x) => x.active);
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = active ? `${active.title} v${active.version}` : t("core.dash.noTheme", "No theme active");
    })
    .catch(() => {
      const el = document.querySelector("#dash-theme");
      if (el) el.textContent = "—";
    });
}
