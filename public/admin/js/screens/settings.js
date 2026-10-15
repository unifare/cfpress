/**
 * Screen: Settings — two levels, visually and structurally separated.
 *
 * - **Site settings** (`/settings`): every declared site-scoped key with its
 *   effective value, grouped by prefix. Written per site — switching sites in
 *   the sidebar switches what this panel edits.
 * - **Platform settings** (`/platform-settings`): install-wide keys (where the
 *   admin lives, …). Readable and writable only with `platform.manage`; a role
 *   without it gets a 403, and the panel is simply not shown rather than shown
 *   disabled — a control that says "you may not" is an invitation to ask why.
 */
import { api, scoped, state, adminBase } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc, toast } from "../../ui.js";

/**
 * Write the platform-settings panel, and follow the admin if the prefix moved.
 *
 * `admin.path` is not like the other platform keys: it is a **route**, so the
 * address this SPA was loaded from stops existing the moment the write lands
 * (the old prefix answers 404 on purpose — that is the entire point of the
 * setting). Saving it therefore cannot end at a toast. Without the move below,
 * the operator renames the admin and is left on a page whose every subsequent
 * request 404s — the setting looks broken when it in fact worked.
 *
 * Three things here are load-bearing, and each has a wrong version that looks
 * right:
 *
 *   - **every key is written before anything moves.** The loop used to
 *     `await` and abort on the first rejection, so a rejected prefix silently
 *     skipped every key after it. Failures are collected now.
 *   - **a rejected save never navigates.** The server answers 400 for a prefix
 *     it will not store (no leading `/`, a trailing `/`, the site root). The
 *     address has not changed, so going there would be a 404 — the operator's
 *     one instruction was "do not move me".
 *   - **the hash is carried across.** It is what says which screen is open
 *     (`#/settings`), so the move lands back on Settings rather than on the
 *     dashboard. `replace`, not `assign`: the old address is gone, and a Back
 *     button that lands on it would be both a 404 and a signpost.
 *
 * Exported, and taking its rows as an argument, so the whole decision is
 * drivable from the suite — the DOM stub there does not dispatch clicks, and
 * "the admin is still reachable after the move" is exactly the kind of claim
 * that has to be observed rather than assumed.
 */
export async function savePlatformSettings(rows) {
  const failed = [];
  for (const { key, value } of rows) {
    try {
      await api("platform-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    } catch (err) {
      failed.push(`${key}: ${err?.message || err}`);
    }
  }
  if (failed.length) {
    toast(t("core.msg.wentWrong", "Something went wrong") + ": " + failed.join(", "), "error");
    // Nothing was stored, so nothing moved — and the value the operator typed
    // is *not* where the admin is. The one request in this state is "do not
    // move me", so the refusal has to stop the flow here rather than fall
    // through to the navigation below.
    return { failed, moved: null };
  }
  toast(t("core.settings.platformSaved", "Platform settings saved"));
  // Every write landed, so the prefix the operator asked for is the prefix the
  // server now routes: the endpoint stores the value verbatim and refuses
  // anything it would not store, so "what was asked for" and "what is stored"
  // are the same string. Reading it off the rows keeps the whole decision —
  // where the admin lives — in one place.
  const wanted = rows.find((r) => r.key === "admin.path")?.value;
  const moved = wanted != null && String(wanted) !== adminBase ? String(wanted) : null;
  if (moved) {
    const hash = typeof location === "undefined" ? "" : location.hash || "";
    // `replace`, not `assign`: the old address is gone, and a Back button that
    // lands on it would be both a 404 and a signpost back to the admin.
    if (typeof location !== "undefined" && typeof location.replace === "function") location.replace(moved + "/" + hash);
  }
  return { failed, moved };
}

function groupPanel(title, count, rows, dataAttr) {
  return `<div class="panel" style="margin-bottom:1rem">
      <div class="card-title" style="text-transform:capitalize">${esc(title)}</div>
      <div class="card-desc" style="margin-bottom:1rem">${esc(t("core.settings.count", "{n} setting(s)", { n: count }))}</div>
      ${rows.map((x) => `<div class="field"><label>${esc(x.key)}</label><input ${dataAttr}="${attr(x.key)}" value="${attr(x.value ?? "")}"></div>`).join("")}
    </div>`;
}

export default async function settings(c) {
  const d = await api(scoped("settings"));
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  // Group keys by their prefix (e.g. "seo.titleTemplate" -> "seo").
  const groups = {};
  for (const x of items) {
    const g = String(x.key).includes(".") ? String(x.key).split(".")[0] : "general";
    (groups[g] ||= []).push(x);
  }
  const sections = Object.entries(groups).map(([g, rows]) => groupPanel(g, rows.length, rows, "data-key")).join("");

  // Platform settings are a *separate* level and a separate permission. A role
  // without `platform.manage` gets a 403 here; the panel is omitted instead of
  // rendered disabled, because a disabled control for something you can never
  // change is noise, not permission UI.
  let platformPanel = "";
  try {
    const p = await api("platform-settings");
    const rows = p.items || [];
    // Editable, unconditionally: this read already required `platform.manage`
    // (anything else gets a 403, caught below), and the write re-checks it per
    // request — so a read that succeeded IS the capability proof. Gating on a
    // role string here (`role === "admin"`) did exactly the wrong thing in both
    // directions: the install owner is `superadmin`, not `admin`, so they got a
    // disabled panel for settings only they may change — while a per-site
    // `admin` without `platform.manage` got an enabled one whose saves the
    // server rejects. Capability, not title.
    platformPanel = `<div class="panel" style="margin-bottom:1rem;border:1px solid var(--border)">
      <div class="card-title">${esc(t("core.settings.platform", "Platform settings"))}</div>
      <div class="card-desc" style="margin-bottom:1rem">${esc(t("core.settings.platformDesc", "Install-wide. These apply to every site and are not affected by deleting one."))}</div>
      ${rows.map((x) => `<div class="field"><label>${esc(x.key)}</label><input data-pkey="${attr(x.key)}" value="${attr(x.value ?? "")}"></div>`).join("")}
      ${rows.length ? `<button class="btn primary sm" data-action="save-platform-settings">${icon("save")}${esc(t("core.settings.savePlatform", "Save platform settings"))}</button>` : ""}
    </div>`;
  } catch {
    // No `platform.manage`: the panel is not for this role.
  }

  c.innerHTML = `${pageHead({
    title: t("core.nav.settings", "Settings"),
    sub: t("core.settings.sub", "Stored per site · {site}", { site: site?.name || state.site }),
    actions: `<button class="btn primary" data-action="save-settings">${icon("save")}${esc(t("core.settings.saveAll", "Save all"))}</button>`,
    crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.nav.settings", "Settings") }],
  })}
  ${sections || `<div class="panel"><div class="empty">${esc(t("core.settings.noneYet", "This site has no settings yet."))}</div></div>`}
  ${platformPanel}
  <div class="panel" style="margin-bottom:1rem">
    <div class="card-title">${esc(t("core.settings.seedDemo.title", "Demo content"))}</div>
    <div class="card-desc" style="margin-bottom:1rem">${esc(t("core.settings.seedDemo.desc", "Write the bilingual demo articles and the About page for this site. Fixed per-site ids — safe to re-run, it updates instead of duplicating."))}</div>
    <button class="btn sm" data-action="seed-demo">${icon("refresh")}${esc(t("core.settings.seedDemo.run", "Restore demo content"))}</button>
  </div>
  <p class="muted text-sm">${esc(t("core.settings.storedPerSite", "Site settings are stored per site. Switch sites from the sidebar to edit another one."))}</p>`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  if (a.dataset.action === "save-settings") {
    for (const el of document.querySelectorAll("[data-key]")) {
      await api(scoped("settings"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: el.dataset.key, value: el.value }) });
    }
    toast(t("core.settings.saved", "Settings saved"));
    return;
  }
  if (a.dataset.action === "save-platform-settings") {
    // The rows are read out of the DOM here and the whole save is handed to
    // `savePlatformSettings`, which also decides whether the browser has to
    // follow the admin to a new address.
    const rows = [];
    for (const el of document.querySelectorAll("[data-pkey]")) rows.push({ key: el.dataset.pkey, value: el.value });
    await savePlatformSettings(rows);
    return;
  }
  if (a.dataset.action === "seed-demo") {
    // One request per piece: the demo is written piece by piece so a single
    // click never concentrates the whole seed in one request (relevant on the
    // free plan's per-request CPU budget). A failure reports what failed
    // instead of dying silently mid-run — the writes are idempotent, so
    // re-clicking resumes rather than duplicates.
    if (!confirm(t("core.settings.seedDemo.confirm", "Restore the demo content? This writes the demo articles and the About page (fixed ids)."))) return;
    let written = 0;
    const failed = [];
    for (const key of ["hello", "second", "edge", "templates", "i18n", "about"]) {
      try {
        const r = await api(scoped("seed-demo"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
        if (r.written) written += r.written;
        if (r.failed) failed.push(...r.failed);
      } catch (err) {
        failed.push(`${key}: ${err?.message || err}`);
      }
    }
    if (failed.length) {
      toast(t("core.settings.seedDemo.done", "Demo content written: {written} version(s)", { written }) + " — " + failed.join(", "));
    } else {
      toast(t("core.settings.seedDemo.done", "Demo content written: {written} version(s)", { written }));
    }
  }
});
