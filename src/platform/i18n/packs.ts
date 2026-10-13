/**
 * L2 — the UI dictionary, four layers deep (ARCHITECTURE.md §2.4).
 *
 *   ① core pack       bundled with the platform (`core-pack.ts`)
 *   ② plugin packs    declared inline in an enabled plugin's manifest
 *   ③ theme pack      `langs/{locale}.json` inside the active theme package
 *   ④ DB overrides    `i18n_overrides`, editable from the admin
 *
 * Later layers win. A missing key falls back to the key itself, never to an
 * empty string — see `translate.ts`.
 *
 * ## Why layers ② and ③ arrive through injected providers
 *
 * Reading a theme pack means knowing which theme is active, and that is
 * `extensions/` knowledge. `platform/` may not import `extensions/` (§7.3
 * rule 1), so this module declares a *provider* shape and `index.ts` — the one
 * module allowed to see every layer — injects the implementations at boot.
 *
 * The mechanism is deliberately the same one `contract/hooks.ts` uses for
 * plugin hooks: an interface in the middle, wired once, with a no-op default.
 * With no provider installed the stack is just core + overrides, which is
 * exactly "no theme or plugin is translating anything" — so call sites need no
 * null checks.
 */
import { Env } from "../../shared/types";
import { featureEnabled } from "../../shared/features";
import { CORE_PACKS, CORE_PACK_NAMES } from "./core-pack";
import { platformLocales, siteLocales } from "./locale-registry";
import { createTranslator, packForLocale, parsePack, type Pack, type Translator } from "./translate";

/** Returns the pack for `locale`, or null when this extension has none. */
export type PackProvider = (env: Env, siteId: string, locale: string) => Promise<Pack | null>;

let themeProvider: PackProvider | null = null;
let pluginProvider: PackProvider | null = null;

/**
 * Install the extension pack providers. Called once per request from
 * `index.ts`, right next to `setHostHooks`.
 */
export function setPackProviders(p: { theme?: PackProvider | null; plugin?: PackProvider | null }): void {
  if ("theme" in p) themeProvider = p.theme ?? null;
  if ("plugin" in p) pluginProvider = p.plugin ?? null;
}

/** Layer ④ — the admin's own wording, per site and locale. */
export async function dbOverridePack(env: Env, siteId: string, locale: string): Promise<Pack | null> {
  try {
    const r = await env.DB.prepare(
      "SELECT key,value FROM i18n_overrides WHERE site_id=? AND locale=?"
    )
      .bind(siteId, locale)
      .all();
    const rows = (r.results as any[]) ?? [];
    if (!rows.length) return null;
    const out: Pack = Object.create(null) as Pack;
    for (const row of rows) {
      if (typeof row?.value === "string") out[String(row.key)] = row.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The ordered stack, lowest priority first. Layers that contribute nothing are
 * omitted rather than included as empty objects — an empty pack is
 * indistinguishable from a missing one at lookup time and only costs a loop.
 */
export async function loadUiPacks(env: Env, siteId: string, locale: string): Promise<Pack[]> {
  const packs: Pack[] = [];

  const core = packForLocale(CORE_PACKS, locale);
  if (core) packs.push(core);

  if (pluginProvider) {
    const p = await safeProvider(pluginProvider, env, siteId, locale);
    if (p) packs.push(p);
  }
  if (themeProvider) {
    const t = await safeProvider(themeProvider, env, siteId, locale);
    if (t) packs.push(t);
  }

  const override = await dbOverridePack(env, siteId, locale);
  if (override) packs.push(override);

  return packs;
}

/** Build the `__()` function for one request. */
export async function uiTranslator(env: Env, siteId: string, locale: string): Promise<Translator> {
  return createTranslator(await loadUiPacks(env, siteId, locale), locale);
}

/**
 * Which UI languages exist, with the name the switcher shows.
 *
 * Three sources, unioned — adding a UI language is a DATA operation, never a
 * code change (the Languages screen writes here):
 *
 *   1. bundled core packs        guaranteed complete (`core-pack.ts`)
 *   2. the platform dictionary   any enabled `locales` row; keys without a
 *                                translation fall back to English in the SPA
 *                                (`t()` carries the English source), and are
 *                                filled in over time via the override layer
 *   3. locales with DB overrides an admin already started translating them
 *
 * This is deliberately **not** `site_locales`. UI language and content
 * language are independent (ARCHITECTURE.md §2.4): a Chinese site owner
 * managing an English-only site must be able to read the admin in Chinese
 * even though `zh-CN` is not a language that site serves to visitors.
 * Constraining this list to the site's content locales would make that
 * impossible.
 *
 * This one function is BOTH the switcher list (`ui_locales` on
 * `i18n/messages`) and the validation set (`availableUiLocales` below) —
 * the switcher can never offer what the server would refuse, or refuse
 * what it offers.
 *
 * The `ui_locale_follow_site` switch (off by default) replaces the union with
 * the site's own enabled languages, for operators who want the menu to mirror
 * what the site serves. It is applied inside this function rather than in the
 * SPA precisely so the "one fact" property above survives the switch.
 */
export async function availableUiLocaleEntries(env: Env, siteId: string): Promise<{ code: string; name: string }[]> {
  // Opt-in (`ui_locale_follow_site`, off by default): some operators want the
  // admin's language menu to mirror what the site actually serves, so a site
  // publishing in English alone does not advertise a Chinese admin. The
  // default is the opposite **on purpose** (§2.4) — an English-only site whose
  // owner reads Chinese must still offer Chinese, which is the case the
  // decoupling exists for. The switch is how an operator says "not here".
  //
  // ⚠️ This filter belongs *here*, not in the SPA. `availableUiLocales()` is a
  // projection of this same array, so it is also the validation set for
  // `ui-locale` and the set `resolveUiLocale` checks against. Filtering here
  // keeps "the menu offers X" and "the server accepts X" one fact; filtering in
  // `i18n.js` would leave the server accepting a language the menu no longer
  // shows, and `resolveUiLocale` handing back a locale with no entry in the
  // switcher.
  if (await featureEnabled(env, siteId, "ui_locale_follow_site")) {
    const served = (await siteLocales(env, siteId)).map((l) => ({
      code: l.code,
      name: l.native_name || l.name || l.code,
    }));
    // An empty menu is not a configuration, it is a trap: `resolveUiLocale`
    // would have nothing to fall back to. A site with no switch rows at all
    // (a pre-0011 database) lands exactly here, so fall through instead.
    if (served.length) return sortEnFirst(served);
  }

  const names = new Map<string, string>();
  for (const code of Object.keys(CORE_PACKS)) names.set(code, CORE_PACK_NAMES[code] ?? code);
  try {
    for (const row of await platformLocales(env)) {
      if (row.enabled !== 1) continue;
      const code = String(row.code ?? "");
      if (code && !names.has(code)) names.set(code, String(row.native_name || row.name || code));
    }
  } catch { /* dictionary table absent on a pre-batch-2 database */ }
  try {
    const r = await env.DB.prepare("SELECT DISTINCT locale FROM i18n_overrides WHERE site_id=?")
      .bind(siteId)
      .all();
    for (const row of (r.results as any[]) ?? []) {
      const code = String(row?.locale ?? "");
      if (code && !names.has(code)) names.set(code, code);
    }
  } catch { /* table absent on a pre-0011 database */ }
  return sortEnFirst([...names].map(([code, name]) => ({ code, name })));
}

/** English first — it is the fallback language and the escape hatch. Shared by
 *  both branches above so the menu cannot order itself two different ways. */
function sortEnFirst(entries: { code: string; name: string }[]): { code: string; name: string }[] {
  return entries.sort((a, b) => (a.code === "en" ? -1 : b.code === "en" ? 1 : a.code.localeCompare(b.code)));
}

/** The codes only — what `ui-locale` validation and `resolveUiLocale` check. */
export async function availableUiLocales(env: Env, siteId: string): Promise<string[]> {
  return (await availableUiLocaleEntries(env, siteId)).map((e) => e.code);
}

/**
 * Pick the UI language for a request.
 *
 * Priority: the user's own setting → their cookie → the site's default →
 * whatever the platform ships. The user's preference is honoured even when the
 * site does not serve that language, which is the whole point of the split.
 */
export async function resolveUiLocale(
  env: Env,
  siteId: string,
  opts: { userLang?: string | null; cookieLang?: string | null; defaultLocale: string }
): Promise<string> {
  const available = await availableUiLocales(env, siteId);
  const known = (code: unknown): boolean => {
    const c = String(code ?? "").trim();
    return !!c && available.includes(c);
  };
  if (known(opts.userLang)) return String(opts.userLang).trim();
  if (known(opts.cookieLang)) return String(opts.cookieLang).trim();
  if (known(opts.defaultLocale)) return opts.defaultLocale;
  // The site's default has no pack. Prefer English when it exists (the
  // platform's own authoring language), else take whatever is first.
  if (available.includes("en")) return "en";
  return available[0] ?? "en";
}

/** Re-exported so callers need only one import for the common pair. */
export { parsePack };
export type { Pack, Translator };

async function safeProvider(
  provider: PackProvider,
  env: Env,
  siteId: string,
  locale: string
): Promise<Pack | null> {
  // A provider reads from R2 and from the database. A failure there must not
  // take the admin down with it — the stack simply loses one layer.
  try {
    return await provider(env, siteId, locale);
  } catch {
    return null;
  }
}
