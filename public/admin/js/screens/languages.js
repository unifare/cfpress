/**
 * Screen: Languages — the L0 site switch and the L2 interface-language choice.
 *
 * These two live on one page because they are constantly confused, and the
 * confusion is expensive: they answer different questions.
 *
 *   Site languages     which languages this site *serves to visitors* (L0).
 *                      Enabling a second one is the event that makes theme
 *                      `_i18n` tables exist at all.
 *   Interface language which language *you* read the admin in (L2). It is a
 *                      personal preference, it is independent of the site's
 *                      languages, and a Chinese owner of an English-only site
 *                      is a normal configuration — not an error.
 *
 * All actions are `data-*` + document-level delegation rather than inline
 * `onclick=`, so nothing here needs a new `WINDOW_HANDLERS` registration (see
 * AGENTS.md rule 22).
 */
import { api, loadContext, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { loadMessages, setUiLocale } from "../i18n.js";
import { icon } from "../../icons.js";
import { alertDialog, attr, confirmDialog, emptyRow, esc, openDialog, toast } from "../../ui.js";

/**
 * Re-read the admin context after the site's languages change, then re-render.
 *
 * `state.locales` is what the editor reads to decide whether to show the
 * language-version bar and a locale picker. Changing the switch without
 * refreshing it left the editor believing the site was still monolingual: the
 * bar simply never appeared, and nothing on screen explained why. The switch is
 * admin-wide state, so every mutation of it has to go through here.
 *
 * Also the refresh path for the *interface* language, which is why
 * `reloadDictionary` exists: `setUiLocale()` already reloads the dictionary for
 * the new locale, so that caller passes `false` rather than fetching it twice.
 * What neither can skip is `loadContext()` — menu labels are translated
 * server-side, so the sidebar keeps the old language until the context is
 * re-read.
 */
async function afterLanguageChange({ reloadDictionary = true } = {}) {
  await loadContext();
  // The UI-language switcher list is data-driven (AGENTS.md rule 40): a newly
  // added language must reach `UI_LANGUAGES` immediately, not after the next
  // full page load.
  if (reloadDictionary) await loadMessages();
  render();
}

export default async function languages(c) {
  const d = await api("i18n/locales");
  const ui = await api("i18n/ui-locale");

  const items = Array.isArray(d.items) ? d.items : [];
  const uiLocales = Array.isArray(d.ui_locales) ? d.ui_locales : [];
  const enabled = new Set(Array.isArray(d.enabled) ? d.enabled : []);
  const siteDefault = d.default || "—";
  const multilingual = d.multilingual === true;

  // What this deployment knows about, from two sources that both have to be
  // offered here: the platform dictionary (`locales` — what an admin added,
  // which is what the panel's title used to mean) and the packs bundled with
  // the code (`core_entries`). A fresh install seeds the dictionary with `en`
  // alone, so with only the first source this panel was empty on every new
  // deployment and Chinese had to be typed into the dialog by hand — while the
  // platform was shipping a complete zh-CN pack. Dictionary rows win on a code
  // collision: they carry an admin's own wording.
  const known = new Map();
  for (const l of Array.isArray(d.core_entries) ? d.core_entries : []) known.set(l.code, l);
  for (const l of Array.isArray(d.dictionary) ? d.dictionary : []) known.set(l.code, l);
  state.languages = { ...d, known: [...known.values()] };

  const rows = items
    .map((l) => {
      const isDefault = Number(l.is_default) === 1;
      const isOn = Number(l.enabled) === 1;
      return `<tr>
        <td><code>${esc(l.code)}</code></td>
        <td style="font-weight:500">${esc(l.native_name || l.name || l.code)}</td>
        <td class="muted text-sm">${esc(l.name || "—")}</td>
        <td>${l.direction === "rtl" ? `<span class="badge">RTL</span>` : `<span class="muted text-sm">LTR</span>`}</td>
        <td>${isDefault ? `<span class="badge success">default</span>` : `<span class="muted">—</span>`}</td>
        <td>${isOn ? `<span class="badge success">enabled</span>` : `<span class="badge">disabled</span>`}</td>
        <td class="actions">
          ${isDefault ? "" : `<button class="btn outline sm" data-lang-default="${attr(l.code)}">${icon("check")}Make default</button>`}
          ${isOn
            ? `<button class="btn outline danger sm" data-lang-disable="${attr(l.code)}">${icon("x")}Disable</button>`
            : `<button class="btn outline sm" data-lang-enable="${attr(l.code)}">${icon("plus")}Enable</button>`}
        </td>
      </tr>`;
    })
    .join("");

  // Dictionary entries the site does not expose yet. Offering them here is what
  // makes "the platform knows this language" and "this site serves it" visibly
  // two different things.
  const available = [...known.values()]
    .filter((l) => !items.some((s) => s.code === l.code))
    .map((l) => `<tr>
        <td><code>${esc(l.code)}</code></td>
        <td style="font-weight:500">${esc(l.native_name || l.name || l.code)}</td>
        <td class="muted text-sm">${esc(l.name || "—")}</td>
        <td class="actions"><button class="btn outline sm" data-lang-enable="${attr(l.code)}">${icon("plus")}Enable for this site</button></td>
      </tr>`)
    .join("");

  const uiOptions = (uiLocales.length ? uiLocales : ["en"])
    .map((code) => `<option value="${attr(code)}"${code === ui.locale ? " selected" : ""}>${esc(code)}</option>`)
    .join("");

  c.innerHTML = `${pageHead({
    title: "Languages",
    sub: "What this site serves, and what you read the admin in",
    actions: `<button class="btn primary" data-action="add-language">${icon("plus")}Add language</button>`,
    crumbs: [{ label: "System" }, { label: "Languages" }],
  })}

  <div class="panel">
    <div class="card-title">Site languages (${items.length})</div>
    <p class="muted text-sm" style="margin:.35rem 0 .75rem">
      These are the languages visitors can reach on this site. ${multilingual
        ? `More than one is enabled, so themes that declare translatable tables have their <code>_i18n</code> companions.`
        : `Only one is enabled, so no theme translation tables are created — the site is single-language in the database, not just in the markup.`}
    </p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Code</th><th>Name</th><th>English name</th><th>Direction</th><th>Default</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || emptyRow(7, "No languages configured.")}</tbody>
    </table></div>
  </div>

  <div class="panel" style="margin-top:1rem">
    <div class="card-title">Your interface language</div>
    <p class="muted text-sm" style="margin:.35rem 0 .75rem">
      Applies to the admin only, and only to you. It is deliberately not tied to the
      site's languages — managing an English-only site in Chinese is fine, so this menu
      is the admin's own list and not the table above. To offer <b>only this site's
      languages</b> here instead, turn on <code>ui_locale_follow_site</code> under
      Tools → Features.
    </p>
    <div class="row" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <select id="ui-locale-select" class="input" style="max-width:14rem">${uiOptions}</select>
      <button class="btn" data-action="save-ui-locale">${icon("check")}Save</button>
      <span class="muted text-sm">current: <code>${esc(ui.locale || "—")}</code>${
        ui.user_preference ? "" : " (site default)"
      }</span>
    </div>
  </div>

  ${
    available
      ? `<div class="panel" style="margin-top:1rem">
    <div class="card-title">Platform dictionary — not enabled here</div>
    <p class="muted text-sm" style="margin:.35rem 0 .75rem">
      Languages this deployment knows about but this site does not expose.
    </p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Code</th><th>Name</th><th>English name</th><th></th></tr></thead>
      <tbody>${available}</tbody>
    </table></div>
  </div>`
      : ""
  }

  <div class="panel" style="margin-top:1rem">
    <div class="card-title">How the four layers relate</div>
    <p class="muted text-sm" style="margin:.5rem 0 0">
      <b>L0 · site languages</b> — this page. The switch.<br>
      <b>L1 · content languages</b> — each post and page has one row per language, sharing a translation group.
      Use the language bar in the editor.<br>
      <b>L2 · interface language</b> — the admin's own wording: core packs, then plugin and theme packs,
      then any override saved in the database.<br>
      <b>L3 · theme business data</b> — a theme declares which of its own fields are translatable.
      A <code>_i18n</code> table is created for it only once this site serves two or more languages.
    </p>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const enable = e.target.closest("[data-lang-enable]");
  if (enable) {
    const code = enable.dataset.langEnable;
    // Both sources, or a bundled language would be enabled under its own code
    // as its display name (`native_name` would become "zh-CN") — the row is
    // written from whatever is found here.
    const known = (state.languages?.known || []).find((l) => l.code === code);
    try {
      await api("i18n/locales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name: known?.name || code, native_name: known?.native_name || known?.name || code, direction: known?.direction || "ltr" }),
      });
      toast(`${code} enabled`);
      await afterLanguageChange();
    } catch (err) {
      await alertDialog({ title: `Could not enable ${code}`, description: err.message });
    }
    return;
  }

  const disable = e.target.closest("[data-lang-disable]");
  if (disable) {
    const code = disable.dataset.langDisable;
    const ok = await confirmDialog({
      title: `Disable ${code} for this site?`,
      description: "Content and translations written in it are kept. It stops being served and offered.",
      confirmLabel: "Disable",
    });
    if (!ok) return;
    try {
      await api("i18n/locales/" + encodeURIComponent(code), { method: "DELETE" });
      toast(`${code} disabled`);
      await afterLanguageChange();
    } catch (err) {
      await alertDialog({ title: `Could not disable ${code}`, description: err.message });
    }
    return;
  }

  const makeDefault = e.target.closest("[data-lang-default]");
  if (makeDefault) {
    const code = makeDefault.dataset.langDefault;
    try {
      await api("i18n/locales/" + encodeURIComponent(code), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: true }),
      });
      toast(`${code} is now the default`);
      await afterLanguageChange();
    } catch (err) {
      await alertDialog({ title: "Could not change the default", description: err.message });
    }
    return;
  }

  const add = e.target.closest('[data-action="add-language"]');
  if (add) {
    const v = await openDialog({
      title: "Add a language",
      description: "Adds it to the platform dictionary and enables it for this site.",
      confirmLabel: "Add language",
      fields: [
        { name: "code", label: "Locale code", required: true, placeholder: "zh-CN", hint: "BCP-47: en, zh-CN, pt-BR" },
        { name: "native_name", label: "Name in that language", required: true, placeholder: "简体中文" },
        { name: "name", label: "English name", placeholder: "Simplified Chinese" },
      ],
    });
    if (!v) return;
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/.test(v.code)) {
      await alertDialog({ title: "Invalid locale code", description: "Use a BCP-47 shape such as en, zh-CN or pt-BR." });
      return;
    }
    try {
      await api("i18n/locales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: v.code, name: v.name || v.native_name, native_name: v.native_name }),
      });
      toast(`${v.code} added`);
      await afterLanguageChange();
    } catch (err) {
      await alertDialog({ title: "Could not add the language", description: err.message });
    }
    return;
  }

  const saveUi = e.target.closest('[data-action="save-ui-locale"]');
  if (saveUi) {
    const sel = document.getElementById("ui-locale-select");
    const locale = sel ? sel.value : "";
    if (!locale) return;
    try {
      // ⚠️ `setUiLocale()` is the **only** writer of this preference, and this
      // used to POST here directly instead. That left `i18n.js`'s module-level
      // locale on the *old* value, and the header switcher renders its tick
      // from it (`nav.js` → `currentLocale()`), so the two disagreed: this
      // panel re-read the server and showed the new language, while the top
      // dropdown kept ticking the old one until a full page reload. Same write,
      // two refresh paths, one of them missing.
      await setUiLocale(locale);
      await afterLanguageChange({ reloadDictionary: false });
      toast("Interface language saved");
    } catch (err) {
      await alertDialog({ title: "Could not save", description: err.message });
    }
  }
});
