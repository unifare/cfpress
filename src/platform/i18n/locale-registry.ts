/**
 * L0 — the platform switch layer (ARCHITECTURE.md §2.2).
 *
 * Two tables with two different jobs:
 *
 *   `locales`       the platform *dictionary* — which language packs this
 *                   deployment knows about at all
 *   `site_locales`  the per-site *switch* — which of them this site exposes,
 *                   and which one it defaults to
 *
 * Keeping them apart is what lets one install run a Chinese site and an English
 * site that advertise different language sets while sharing one dictionary.
 *
 * ## About the one fallback in this file
 *
 * `siteLocales()` falls back to the dictionary when a site has no switch rows.
 * That is deliberate and it is the *only* fallback here. Before this layer
 * existed, every site implicitly saw every row of `locales`; a site created
 * after the migration, or one whose rows were cleared, must keep behaving that
 * way rather than suddenly serving zero languages. The fallback is written as
 * an explicit branch, never as a parameter default — same reasoning as
 * `requestSiteId()` in `api.ts` (§10 rule 4).
 */
import { Env } from "../../shared/types";

export interface PlatformLocale {
  code: string;
  name: string;
  native_name: string | null;
  direction: string;
  enabled: number;
  sort_order: number;
  is_default: number;
}

export interface SiteLocale {
  code: string;
  is_default: number;
  enabled: number;
  sort_order: number;
  name: string | null;
  native_name: string | null;
  direction: string;
}

const CODE_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

/**
 * Terminal fallback, used only when the dictionary itself is empty — i.e. a
 * database so broken that even `locales` has no rows. It exists so callers get
 * a usable string instead of `undefined`; it is not a policy.
 *
 * **Exported so it stays the only one.** A second `"en"` literal somewhere else
 * is a second answer to "what do we say when we know nothing", and the two will
 * drift (rule 23). `tests/tools/_locale-literal.mjs` fails on a new literal
 * outside the i18n layer for exactly this reason.
 */
export const TERMINAL_LOCALE = "en";

export function isLocaleCode(code: unknown): boolean {
  return typeof code === "string" && CODE_RE.test(code);
}

/** The platform dictionary. Includes disabled entries so the admin can show them. */
export async function platformLocales(env: Env): Promise<PlatformLocale[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT code,name,native_name,direction,enabled,sort_order,is_default FROM locales ORDER BY is_default DESC, sort_order, code"
    ).all();
    return ((r.results as any[]) ?? []) as PlatformLocale[];
  } catch {
    return [];
  }
}

/**
 * Locales this site serves, default first. Only enabled rows; disabled ones
 * stay in the database so re-enabling restores the switch without losing its
 * position in the switcher.
 */
export async function siteLocales(env: Env, siteId: string): Promise<SiteLocale[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT sl.code, sl.is_default, sl.enabled, sl.sort_order,
              l.name, l.native_name, l.direction
         FROM site_locales sl
         LEFT JOIN locales l ON l.code = sl.code
        WHERE sl.site_id = ? AND sl.enabled = 1
        ORDER BY sl.is_default DESC, sl.sort_order, sl.code`
    )
      .bind(siteId)
      .all();
    const rows = ((r.results as any[]) ?? []) as SiteLocale[];
    if (rows.length) return rows.map(normalise);
  } catch {
    /* table absent on a pre-0011 database — fall through to the dictionary */
  }
  // Explicit fallback: a site with no switch rows serves the whole dictionary,
  // which is exactly what every site did before this layer existed.
  const all = await platformLocales(env);
  const enabled = all.filter((l) => Number(l.enabled) === 1);
  if (enabled.length) {
    return enabled.map((l) => ({
      code: l.code,
      is_default: l.is_default,
      enabled: 1,
      sort_order: l.sort_order,
      name: l.name ?? null,
      native_name: l.native_name ?? null,
      direction: l.direction ?? "ltr",
    }));
  }
  return [
    { code: TERMINAL_LOCALE, is_default: 1, enabled: 1, sort_order: 0, name: null, native_name: null, direction: "ltr" },
  ];
}

/** Every switch row for a site, disabled included. For the admin languages screen. */
export async function siteLocaleRows(env: Env, siteId: string): Promise<SiteLocale[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT sl.code, sl.is_default, sl.enabled, sl.sort_order,
              l.name, l.native_name, l.direction
         FROM site_locales sl
         LEFT JOIN locales l ON l.code = sl.code
        WHERE sl.site_id = ?
        ORDER BY sl.is_default DESC, sl.sort_order, sl.code`
    )
      .bind(siteId)
      .all();
    return (((r.results as any[]) ?? []) as SiteLocale[]).map(normalise);
  } catch {
    return [];
  }
}

export async function siteLocaleCodes(env: Env, siteId: string): Promise<string[]> {
  return (await siteLocales(env, siteId)).map((l) => l.code);
}

/**
 * The site's default locale.
 *
 * `site_locales.is_default` is the single source of truth. Note this is NOT the
 * same thing as `locales.is_default`, which is the *dictionary's* default and
 * says nothing about any particular site.
 */
export async function siteDefaultLocale(env: Env, siteId: string): Promise<string> {
  const rows = await siteLocales(env, siteId);
  const flagged = rows.find((l) => Number(l.is_default) === 1);
  if (flagged) return flagged.code;
  // Rows exist but none is flagged (hand-edited database). First row wins —
  // `siteLocales` already ordered by sort_order then code, so this is stable.
  return rows[0]?.code ?? TERMINAL_LOCALE;
}

/**
 * Does this site serve more than one language?
 *
 * This is the switch that decides whether a theme's `_i18n` tables exist at
 * all (§2.5.3 要点三). Answering it in one function — rather than counting
 * locales at each call site — is what keeps "enabling a second language" from
 * meaning two slightly different things in two places.
 */
export async function isMultilingual(env: Env, siteId: string): Promise<boolean> {
  return (await siteLocales(env, siteId)).length >= 2;
}

/**
 * Resolve the locale a *content* read/write should use, from an optional hint.
 *
 * This is the single definition of the content-locale fallback ladder, and it
 * exists because that ladder had been written out by hand at four call sites
 * (`api.ts` search, revisions read/write, autosave read/write) — each as
 * `|| "en"`. Two of them had already been fixed to consult the site default
 * while the other four still said `"en"`, so the *same* question had two
 * answers in one file. On a site whose default is `zh-CN`, the stragglers read
 * and wrote English rows: the multi-language fact was silently lost at exactly
 * the places nobody re-read.
 *
 * The ladder is deliberately the same shape as `table-facade`'s
 * `COALESCE(tr.x, dflt.x, m.x)` projection:
 *
 *   hint (current locale) -> site default -> terminal locale
 *
 * Notes on the edges:
 *  - A hint that is not a well-formed code is ignored rather than rejected —
 *    a garbage `?locale=` should not 400 a read.
 *  - Unlike `resolveLocale` (which parses a *request*), this does not decide
 *    404-vs-fallback: content reads never 404 on a locale miss.
 *  - It never throws. Callers treat the result as "the best available answer",
 *    which is why the last resort is the terminal locale and not an error.
 */
export async function resolveContentLocale(
  env: Env,
  siteId: string,
  hint?: string | null
): Promise<string> {
  const h = typeof hint === "string" ? hint.trim() : "";
  const enabled = (await siteLocales(env, siteId)).map((l) => l.code);
  if (h && enabled.includes(h)) return h;
  const dflt = await siteDefaultLocale(env, siteId);
  if (enabled.includes(dflt)) return dflt;
  return TERMINAL_LOCALE;
}

export async function enabledLocaleCount(env: Env, siteId: string): Promise<number> {
  return (await siteLocales(env, siteId)).length;
}

/** True when `code` is one of the locales this site serves. */
export async function siteServesLocale(env: Env, siteId: string, code: string): Promise<boolean> {
  return (await siteLocaleCodes(env, siteId)).includes(code);
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/** Add or update one dictionary entry. */
export async function upsertPlatformLocale(
  env: Env,
  entry: {
    code: string;
    name: string;
    native_name?: string | null;
    direction?: string;
    enabled?: number;
    sort_order?: number;
    is_default?: number;
  }
): Promise<void> {
  const ts = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO locales(code,name,native_name,direction,enabled,sort_order,is_default)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name,
       native_name=COALESCE(excluded.native_name, locales.native_name),
       direction=excluded.direction,
       enabled=excluded.enabled,
       sort_order=excluded.sort_order`
  )
    .bind(
      entry.code,
      entry.name,
      entry.native_name ?? null,
      entry.direction ?? "ltr",
      entry.enabled === undefined ? 1 : entry.enabled,
      entry.sort_order === undefined ? 0 : entry.sort_order,
      entry.is_default === undefined ? 0 : entry.is_default
    )
    .run();
  void ts;
}

/**
 * Turn a locale on for a site. When it becomes the only enabled locale it is
 * also made the default, so a site can never be left with locales but no
 * default.
 */
export async function enableSiteLocale(
  env: Env,
  siteId: string,
  code: string,
  opts?: { isDefault?: boolean; sortOrder?: number }
): Promise<void> {
  if (!isLocaleCode(code)) throw new Error(`invalid locale code: ${code}`);
  const existing = await siteLocaleRows(env, siteId);
  const row = existing.find((l) => l.code === code);
  const makeDefault = opts?.isDefault === true || existing.length === 0 || !existing.some((l) => Number(l.enabled) === 1);
  await env.DB.prepare(
    `INSERT INTO site_locales(site_id,code,is_default,enabled,sort_order)
     VALUES(?,?,?,1,?)
     ON CONFLICT(site_id,code) DO UPDATE SET enabled=1, sort_order=excluded.sort_order`
  )
    .bind(siteId, code, makeDefault ? 1 : row ? Number(row.is_default) : 0, opts?.sortOrder ?? row?.sort_order ?? existing.length)
    .run();
  if (makeDefault) await setSiteDefaultLocale(env, siteId, code);
}

/**
 * Turn a locale off for a site.
 *
 * The row is disabled, not deleted, and the content is never touched. Turning a
 * language off hides it; it does not destroy the translations written in it.
 * The last enabled locale cannot be disabled — a site with zero languages has
 * no valid default and no way back through the UI.
 */
export async function disableSiteLocale(env: Env, siteId: string, code: string): Promise<void> {
  const rows = await siteLocaleRows(env, siteId);
  const enabled = rows.filter((l) => Number(l.enabled) === 1);
  if (enabled.length <= 1 && enabled.some((l) => l.code === code)) {
    throw new Error("cannot disable the site's only enabled language");
  }
  await env.DB.prepare("UPDATE site_locales SET enabled=0, is_default=0 WHERE site_id=? AND code=?")
    .bind(siteId, code)
    .run();
  // If the default just went away, promote whatever is left.
  if (rows.some((l) => l.code === code && Number(l.is_default) === 1)) {
    const next = enabled.find((l) => l.code !== code);
    if (next) await setSiteDefaultLocale(env, siteId, next.code);
  }
}

/** Make `code` the site's default. Clears the flag on every other row. */
export async function setSiteDefaultLocale(env: Env, siteId: string, code: string): Promise<void> {
  if (!isLocaleCode(code)) throw new Error(`invalid locale code: ${code}`);
  await env.DB.prepare("UPDATE site_locales SET is_default=0 WHERE site_id=?").bind(siteId).run();
  await env.DB.prepare("UPDATE site_locales SET is_default=1, enabled=1 WHERE site_id=? AND code=?")
    .bind(siteId, code)
    .run();
}

/**
 * Give a site its initial switch rows. Called when a site is created, so the
 * "no rows → serve the dictionary" fallback stays a safety net rather than the
 * normal path.
 */
export async function seedSiteLocales(env: Env, siteId: string): Promise<void> {
  const all = await platformLocales(env);
  const enabled = all.filter((l) => Number(l.enabled) === 1);
  const list = enabled.length
    ? enabled
    : [{ code: TERMINAL_LOCALE, name: "English", native_name: "English", direction: "ltr", enabled: 1, sort_order: 0, is_default: 1 } as PlatformLocale];
  const fallbackDefault = list.find((l) => Number(l.is_default) === 1)?.code ?? list[0].code;
  for (const l of list) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO site_locales(site_id,code,is_default,enabled,sort_order)
       VALUES(?,?,?,1,?)`
    )
      .bind(siteId, l.code, l.code === fallbackDefault ? 1 : 0, l.sort_order ?? 0)
      .run();
  }
}

function normalise(l: any): SiteLocale {
  return {
    code: String(l.code),
    is_default: Number(l.is_default) === 1 ? 1 : 0,
    enabled: Number(l.enabled) === 1 ? 1 : 0,
    sort_order: Number(l.sort_order) || 0,
    name: l.name ?? null,
    native_name: l.native_name ?? null,
    direction: l.direction ?? "ltr",
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
