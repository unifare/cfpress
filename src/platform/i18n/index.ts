/**
 * Multi-language, four layers (ARCHITECTURE.md §2).
 *
 *   L0  locale-registry  which languages this site serves
 *   L1  (content)        `posts.lang_group` + `post_translations` — see api.ts
 *   L2  packs + translate  the UI dictionary and `__()`
 *   L3  (theme business) `extensions/theme/tables.ts` — generated per theme
 *
 * `resolve.ts` sits across all of them: it answers "which locale is this
 * request asking for", which L0 has to know before L1/L2/L3 can answer
 * anything.
 */
export {
  platformLocales,
  siteLocales,
  siteLocaleRows,
  siteLocaleCodes,
  siteDefaultLocale,
  resolveContentLocale,
  isMultilingual,
  enabledLocaleCount,
  siteServesLocale,
  isLocaleCode,
  upsertPlatformLocale,
  enableSiteLocale,
  disableSiteLocale,
  setSiteDefaultLocale,
  seedSiteLocales,
  type PlatformLocale,
  type SiteLocale,
} from "./locale-registry";

export {
  resolveLocale,
  isKnownLocale,
  langFromUrl,
  langFromCookie,
  langCookie,
  type LocaleMatch,
  type LocaleSource,
  type ResolveLocaleOptions,
} from "./resolve";

export {
  setPackProviders,
  loadUiPacks,
  uiTranslator,
  availableUiLocales,
  availableUiLocaleEntries,
  resolveUiLocale,
  dbOverridePack,
  type PackProvider,
} from "./packs";

export { createTranslator, interpolate, packForLocale, parsePack, mergePacks, type Pack, type Translator } from "./translate";

export { CORE_PACKS, corePackLocales, corePackLocaleEntries, type CoreLocaleEntry } from "./core-pack";
