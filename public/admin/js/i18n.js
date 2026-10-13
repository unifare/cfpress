/**
 * Admin SPA — interface language.
 *
 * Leaf module: imports nothing, so every other module (including `ui.js`,
 * which sits below `state.js`) can depend on it without a cycle.
 *
 * The strings come from `GET /api/v1/i18n/messages`, which returns the whole
 * merged four-layer dictionary (core → plugin → theme → DB overrides) for the
 * resolved UI locale — one request per session, not one per string. The last
 * response is cached in localStorage so the *login* screen renders in the
 * language the user chose previously, before any authenticated request is
 * possible. A fresh browser falls back to the English `fallback` argument
 * every `t()` call carries, which reads correctly everywhere.
 *
 * Menu labels are NOT translated here: the admin-menus API already returns
 * labels translated server-side (see `api.ts`), so switching language
 * re-fetches the context rather than re-translating markup.
 */

let messages = {};
let locale = null;

const LS_KEY = "cfpress.admin.messages";

/**
 * The admin prefix, read straight off the injected global.
 *
 * ⚠️ Deliberately *not* imported from `state.js`: this module is a leaf (nothing
 * may import it and it may import nothing, or `ui.js` — which sits below
 * `state.js` — could not depend on it). Reading `window.CFP_ADMIN_BASE` inline
 * keeps it a leaf while still not hard-coding the prefix. `state.js` derives the
 * same value from the same global; there is one source, two readers.
 */
const ADMIN_BASE =
  (typeof window !== "undefined" && window.CFP_ADMIN_BASE) || "/admin";

/**
 * The interface languages the admin offers in its switcher. NOT a hardcoded
 * list: the server owns this fact (`CORE_PACKS` + `CORE_PACK_NAMES` in
 * core-pack.ts) and ships it on every `i18n/messages` response as
 * `ui_locales`; `loadMessages` applies it below. The array here is only the
 * boot default for the pre-fetch frames (and the offline case) — it mirrors
 * what the server ships today so a cached login screen renders translated.
 * Adding ja/fr = add a core pack + a name entry server-side; nothing in the
 * SPA changes (switcher, account select and the menu editor's label inputs
 * all render from this list at render time).
 */
export let UI_LANGUAGES = [
  ["en", "English"],
  ["zh-CN", "简体中文"],
];

/** Replace the switcher list from a server payload: `[{code,name}]`.
 *  Invalid or empty payloads are ignored (keep whatever we had). */
export function setUiLanguages(list) {
  if (!Array.isArray(list) || !list.length) return;
  const next = [];
  const seen = new Set();
  for (const it of list) {
    const code = typeof it?.code === "string" ? it.code.trim() : "";
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    if (code && name && !seen.has(code)) { next.push([code, name]); seen.add(code); }
  }
  if (!next.length) return;
  // English is the fallback language — keep it first so the switcher always
  // offers a fully translated escape hatch.
  next.sort((a, b) => (a[0] === "en" ? -1 : b[0] === "en" ? 1 : 0));
  UI_LANGUAGES = next;
}

/**
 * Look up a dictionary key. `fallback` is the English source string; when
 * both are missing the key itself is shown (never an empty node).
 *
 * `params` fills `{name}` placeholders, the same syntax the server's
 * `interpolate()` uses — so a string that has to name something ("Last saved
 * content for {site}") can be one dictionary entry instead of a sentence glued
 * together at the call site, which is what makes word order translatable.
 * An unknown placeholder is left verbatim rather than blanked: a visible
 * `{site}` is a bug report, an empty string is a mystery.
 */
export function t(key, fallback, params) {
  const v = messages[key];
  const raw = typeof v === "string" && v ? v : fallback !== undefined ? fallback : key;
  if (!params) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

/** The locale the current dictionary came in for, or null before loading. */
export function currentLocale() {
  return locale;
}

/** Install a dictionary (and remember it for the next session). */
export function setMessages(msgs, loc) {
  messages = msgs && typeof msgs === "object" ? msgs : {};
  locale = typeof loc === "string" && loc ? loc : null;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ locale, messages })); } catch { /* storage full / blocked */ }
}

/** Restore the previous session's dictionary, if any. Called before the
 *  first render so the login screen is translated immediately. */
export function cachedMessages() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (d && d.messages && typeof d.messages === "object") {
      messages = d.messages;
      locale = typeof d.locale === "string" ? d.locale : null;
    }
  } catch { /* corrupt cache — fall back to English */ }
}

/**
 * Fetch the merged dictionary for the resolved UI locale (the server honours
 * the user's saved preference). Returns true when something was loaded.
 */
export async function loadMessages() {
  try {
    const d = await fetch(ADMIN_BASE + "/api/v1/i18n/messages").then((r) => r.json());
    if (d && d.messages && typeof d.messages === "object") {
      setMessages(d.messages, d.locale);
      if (Array.isArray(d.ui_locales)) setUiLanguages(d.ui_locales);
      return true;
    }
  } catch { /* offline / 401 — keep whatever we had */ }
  return false;
}

/**
 * Switch the interface language: persist the preference server-side, load the
 * dictionary for it, and remember it locally. The caller re-renders (and
 * re-fetches the menu context, because labels are translated server-side).
 *
 * ⚠️ **This is the only writer of the preference, and the dictionary reload
 * belongs inside it.** The fact has two client-side readers that refresh on
 * different paths: the header switcher ticks from `currentLocale()` — module
 * state, set only by `setMessages()` — while the Languages screen re-reads
 * `GET i18n/ui-locale` from the server. A caller that POSTs the preference
 * itself updates the server and leaves the tick on the old language until a
 * full page reload, i.e. the two disagree on screen with nothing to explain
 * it. Keeping the write and the reload in one function is what makes that
 * impossible to reintroduce; a caller can still forget to *render*.
 *
 * A refusal **throws**. The server rejects a locale with no pack (400 + the
 * list it does have), and swallowing that reported success while nothing
 * changed — the "declared but never consumed" shape this repo keeps fixing.
 * Both callers handle it: `shell.js` toasts, the Languages screen opens a
 * dialog.
 */
export async function setUiLocale(loc) {
  let res;
  try {
    res = await fetch(ADMIN_BASE + "/api/v1/i18n/ui-locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: loc }),
    });
  } catch {
    throw new Error("the request could not be sent");
  }
  if (!res.ok) {
    let why = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      if (d && d.error) why = String(d.error);
    } catch { /* not a JSON error body — the status is all we have */ }
    throw new Error(why);
  }
  await loadMessages();
}
