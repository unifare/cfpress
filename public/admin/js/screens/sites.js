/**
 * Screen: Sites — multi-site registry with create / edit / delete.
 *
 * Each site owns its own content, settings, media and active theme; routing
 * matches path prefix first, then host.
 *
 * The list is a *management* view, not just a registry dump: every row shows
 * where the site's front end actually is, how much content it holds and which
 * theme it renders with. Three things about that are contracts, and they are
 * all about not asking the wrong question:
 *
 *   - the preview URL is built from the site's **own** prefix or host, never
 *     from the current site's. A shop mounted at `/shop` serves its front end
 *     at `/shop/<locale>`; opening `/` would show the visitor a different site
 *     and call it a preview.
 *   - the counts and the theme arrive in **one** request (`?withCounts=1`).
 *     A per-row fetch is an N+1, and a per-row count computed client-side is
 *     not possible at all — the browser has no database.
 *   - the theme column is the theme the site **chose** (`settings['theme.active']`),
 *     not "which theme would render here". A site that never picked one has an
 *     empty value and says so; borrowing the default's name would make the
 *     column wrong for exactly the sites an operator is trying to tell apart.
 */
import { api, loadContext, state } from "../state.js";
import { go, pageHead, render, switchSite } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

/**
 * Where a site's front end lives.
 *
 * `path` is the prefix with exactly one trailing slash (`/shop/`), `origin` is
 * the scheme+host when the site is keyed by host, and `hasOrigin` tells the two
 * apart — because `""` is a legitimate origin here (the default site is served
 * from whatever host the admin is on) and must not be confused with "no site".
 *
 * The site's `state.defaultLocale` is appended by the caller: an unprefixed
 * request is a redirect to the default language, so linking at the bare prefix
 * would show a redirect rather than the site.
 */
export function siteFrontEnd(s) {
  const prefix = String(s?.path_prefix || "");
  const host = String(s?.host || "");
  if (prefix) {
    const withSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
    return { path: withSlash.replace(/\/+$/, "") + "/", origin: "", hasOrigin: false };
  }
  if (host) return { path: "/", origin: `https://${host}`, hasOrigin: true };
  return { path: "/", origin: "", hasOrigin: false };
}

/** The URL to open for a site, in the language the admin is currently reading. */
function previewUrl(s) {
  const fe = siteFrontEnd(s);
  return `${fe.origin}${fe.path}${state.defaultLocale || ""}`;
}

/**
 * Ask the freshly created site for its languages and offer to pin one as the
 * default. This is the minimal fix for "the new site is an empty shell": it does
 * not try to be a wizard, it just makes the one choice that a site cannot make
 * for itself and that is invisible until the front end renders in the wrong
 * language.
 */
async function guideDefaultLanguage(siteId, siteName) {
  let d = null;
  try {
    // `?site=` is read from `state`, and the site we just made is not the
    // current one, so it has to be named explicitly — otherwise this would set
    // the default language on the site the operator was already on.
    d = await api(`i18n/locales?site=${encodeURIComponent(siteId)}`);
  } catch {
    return; // no languages endpoint, or no permission: the site still works.
  }
  const codes = Array.isArray(d?.enabled) ? d.enabled : [];
  const current = String(d?.default || "");
  const options = codes.filter((c) => c !== current);
  if (!options.length) {
    await alertDialog({
      title: t("core.sites.nextTitle", "Site “{name}” is ready", { name: siteName }),
      description: t("core.sites.noLanguages", "This site has no languages enabled yet."),
    });
    return;
  }
  // `openDialog` accepts `type: "select"` with `options`, but it has no
  // `cancelLabel` — its cancel button always reads "Cancel", and passing an
  // unknown key would be silently dropped (a declared-but-unread field is the
  // shape this codebase keeps getting bitten by). So the dialog keeps the
  // generic wording and the *decision* is the only thing it asks for.
  const chosen = await openDialog({
    title: t("core.sites.nextTitle", "Site “{name}” is ready", { name: siteName }),
    description: t("core.sites.nextDesc", "It starts empty, in a language nobody has chosen yet. Set its default language now — the front end renders unprefixed URLs in it, and a site without one answers in whatever language happens to sort first."),
    confirmLabel: t("core.sites.nextSetLanguage", "Set default language"),
    fields: [
      {
        name: "code",
        label: t("core.sites.nextSetLanguage", "Set default language"),
        type: "select",
        value: options[0],
        options: options.map((code) => ({ value: code, label: code })),
      },
    ],
  });
  if (chosen?.code !== undefined && String(chosen.code) !== current) {
    try {
      // The per-locale route resolves the site from `?site=`, so the request has
      // to carry it — a bare `i18n/locales/<code>` would set the default on the
      // site the admin is currently on, which is not the one just created.
      await api(`i18n/locales/${encodeURIComponent(chosen.code)}?site=${encodeURIComponent(siteId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: true }),
      });
      toast(t("core.sites.nextDone", "Default language set to {code}", { code: chosen.code }));
    } catch (err) {
      await alertDialog({ title: t("core.sites.updateFailed", "Could not update site"), description: err.message });
    }
  }
  await loadContext();
  render();
}

export default async function sites(c) {
  // One request carries every row's counts and theme — see the module header.
  const d = await api("sites?withCounts=1");
  state.sites = d.items || [];
  const rows = state.sites.map((s) => {
    const n = s.counts || {};
    const counts = t("core.sites.counts", "{posts} posts · {pages} pages · {media} media", {
      posts: Number(n.posts) || 0,
      pages: Number(n.pages) || 0,
      media: Number(n.media) || 0,
    });
    return `<tr>
      <td><code>${esc(s.id)}</code>${s.id === state.site ? ` <span class="badge default">${esc(t("core.sites.current", "current"))}</span>` : ""}</td>
      <td style="font-weight:500">${esc(s.name)}</td>
      <td class="muted text-sm">${esc(s.host || "—")}</td>
      <td class="muted text-sm">${esc(s.path_prefix || "—")}</td>
      <td class="muted text-sm">${esc(counts)}</td>
      <td>${
        s.theme
          // Clicking the badge re-reads the *current* site's context first, so
          // the Themes screen lists what this site can activate — a badge that
          // navigated without switching would answer for the wrong tenant.
          ? `<button class="badge" data-site-theme="${attr(s.id)}" title="${attr(t("core.nav.themes", "Themes"))}">${icon("palette")}${esc(s.theme)}</button>`
          : `<span class="muted text-sm">${esc(t("core.sites.noTheme", "No theme yet"))}</span>`
      }</td>
      <td>${s.is_default ? `<span class="badge success">${esc(t("core.sites.default", "default"))}</span>` : `<span class="muted">—</span>`}</td>
      <td class="actions">
        <a class="btn outline sm" href="${attr(previewUrl(s))}" target="_blank" rel="noopener">${icon("external")}${esc(t("core.sites.view", "View site"))}</a>
        <button class="btn outline sm" data-site-edit="${attr(s.id)}">${icon("pencil")}${esc(t("core.editor.edit", "Edit"))}</button>
        ${s.id === state.site ? "" : `<button class="btn outline sm" data-switch-site="${attr(s.id)}">${icon("arrow-right")}${esc(t("core.sites.switch", "Switch"))}</button>`}
        ${s.is_default ? "" : `<button class="btn outline danger sm" data-site-del="${attr(s.id)}">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>`}
      </td>
    </tr>`;
  }).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.sites", "Sites"),
    sub: t("core.sites.sub", "Each site has its own content, settings, media and active theme"),
    actions: `<button class="btn primary" data-action="new-site">${icon("plus")}${esc(t("core.sites.add", "Add site"))}</button>`,
    crumbs: [{ label: t("core.nav.system", "System") }, { label: t("core.nav.sites", "Sites") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr>
      <th>${esc(t("core.sites.colId", "ID"))}</th>
      <th>${esc(t("core.sites.colName", "Name"))}</th>
      <th>${esc(t("core.sites.colHost", "Host"))}</th>
      <th>${esc(t("core.sites.colPrefix", "Path prefix"))}</th>
      <th>${esc(t("core.sites.colContent", "Content"))}</th>
      <th>${esc(t("core.sites.colTheme", "Theme"))}</th>
      <th>${esc(t("core.sites.colDefault", "Default"))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows || emptyRow(8, t("core.sites.none", "No sites."))}</tbody>
  </table></div>
  <div class="panel" style="margin-top:1rem">
    <div class="card-title">${esc(t("core.sites.routing", "How routing works"))}</div>
    <p class="muted text-sm" style="margin:.5rem 0 0">${esc(t("core.sites.routingDesc", "A request is matched to a site by path prefix first (longest match wins), then by host. Anything unmatched falls back to the default site. Content, settings, menus, media and the active theme are all stored per site."))}</p>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (a?.dataset.action === "new-site") {
    const v = await openDialog({
      title: t("core.sites.addTitle", "Add a site"),
      description: t("core.sites.addDesc", "A site is isolated: its own content, settings and theme."),
      confirmLabel: t("core.sites.createSite", "Create site"),
      fields: [
        { name: "id", label: t("core.sites.fieldId", "Site ID"), required: true, placeholder: "shop", hint: t("core.sites.idHint", "Lowercase letters, digits, - or _") },
        { name: "name", label: t("core.sites.fieldName", "Site name"), required: true, placeholder: "Shop" },
        { name: "host", label: t("core.sites.fieldHost", "Host"), placeholder: "shop.example.com", hint: t("core.sites.hostHint", "Optional. Matches the request host.") },
        { name: "path_prefix", label: t("core.sites.fieldPrefix", "Path prefix"), placeholder: "/shop", hint: t("core.sites.prefixHint", "Optional. Longest prefix wins.") },
      ],
    });
    if (!v) return;
    if (!/^[a-z0-9_-]+$/.test(v.id)) { await alertDialog({ title: t("core.sites.badId", "Invalid site ID"), description: t("core.sites.badIdDesc", "Use only lowercase letters, digits, - and _.") }); return; }
    try {
      await api("sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: v.id, name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast(t("core.sites.created", "Site created"));
      await loadContext();
      render();
      // The minimal "what now" for a site that was just created: it exists, it
      // is empty, and nothing has told it which language its front end speaks.
      await guideDefaultLanguage(v.id, v.name);
    } catch (err) { await alertDialog({ title: t("core.sites.createFailed", "Could not create site"), description: err.message }); }
  }

  // A theme badge opens the Themes screen for *that* site. Switching context
  // first is what makes the screen's "Activate here" buttons mean this site.
  const st = e.target.closest("[data-site-theme]");
  if (st) {
    await switchSite(st.dataset.siteTheme);
    await go("themes");
    return;
  }

  const ed = e.target.closest("[data-site-edit]");
  if (ed) {
    const s = state.sites.find((x) => x.id === ed.dataset.siteEdit);
    if (!s) return;
    const v = await openDialog({
      title: t("core.sites.editTitle", "Edit “{name}”", { name: s.name }),
      confirmLabel: t("core.sites.saveChanges", "Save changes"),
      fields: [
        { name: "name", label: t("core.sites.fieldName", "Site name"), value: s.name, required: true },
        { name: "host", label: t("core.sites.fieldHost", "Host"), value: s.host || "", placeholder: "shop.example.com" },
        { name: "path_prefix", label: t("core.sites.fieldPrefix", "Path prefix"), value: s.path_prefix || "", placeholder: "/shop" },
      ],
    });
    if (!v) return;
    try {
      await api("sites/" + s.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v.name, host: v.host || null, path_prefix: v.path_prefix || null }) });
      toast(t("core.sites.updated", "Site updated"));
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.sites.updateFailed", "Could not update site"), description: err.message }); }
  }

  const del = e.target.closest("[data-site-del]");
  if (del) {
    const ok = await confirmDialog({
      title: t("core.sites.deleteTitle", "Delete site “{name}”?", { name: del.dataset.siteDel }),
      description: t("core.sites.deleteDesc", "Its content is preserved in the database but becomes unreachable."),
      confirmLabel: t("core.sites.deleteSite", "Delete site"),
    });
    if (!ok) return;
    try {
      await api("sites/" + del.dataset.siteDel, { method: "DELETE" });
      toast(t("core.sites.deleted", "Site deleted"));
      if (state.site === del.dataset.siteDel) state.site = "default";
      await loadContext();
      render();
    } catch (err) { await alertDialog({ title: t("core.sites.deleteFailed", "Could not delete site"), description: err.message }); }
  }
});
