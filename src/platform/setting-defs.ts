/**
 * The declaration of every settings key - **the single authority** for its
 * scope (platform | site), type, default and sensitivity.
 *
 * This is a **leaf module on purpose**: it imports nothing, so tools can read
 * the declaration without dragging the Worker types in (the same reason
 * `contract/schema.ts` is importable from `tests/tools/_schema-scope.mjs`).
 *
 * The Env-dependent half (the read ladder and the writers) lives in
 * `settings.ts`; this file must never import anything.
 */
export const SETTING_DEFS = [
  // -- site: identity & SEO ---------------------------------------------------
  { key: "site.title", scope: "site", type: "string", default: "CFPress", sensitive: false, inherit: false,
    note: "site title, used by the theme masthead and SEO" },
  { key: "site.description", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "site description" },
  { key: "seo.titleTemplate", scope: "site", type: "string", default: "%title% | %site%", sensitive: false, inherit: false,
    note: "SEO title template; %title% and %site% are replaced at render time" },
  { key: "seo.description", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "default meta description" },
  { key: "seo.robots", scope: "site", type: "string", default: "index,follow", sensitive: false, inherit: false,
    note: "robots directive for the site's pages" },
  // -- site: platform behaviour ----------------------------------------------
  { key: "theme.active", scope: "site", type: "string", default: "default", sensitive: false, inherit: false,
    note: "which theme this site renders; written by activate, read by activeTheme()" },
  { key: "cfpress.features", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "feature switches, one JSON object per site (see shared/features.ts)" },
  { key: "cfpress.media", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "media policy overrides (isolation / requireSession), see platform/media-policy.ts" },
  { key: "admin.menu.custom", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "per-site admin menu customisation (nav.js reads it)" },
  { key: "i18n.defaultLocale", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "legacy: the site's default locale used to be a setting and is now site_locales.is_default; kept declared so an old row cannot be written blind" },
  { key: "members.registration", scope: "site", type: "boolean", default: "0", sensitive: false, inherit: false,
    note: "whether the front end accepts new member registrations on this site. Off by default: a registration form that appears without being switched on is an open door nobody chose to open (batch D)" },
  // -- platform: install-wide ------------------------------------------------
  { key: "admin.path", scope: "platform", type: "string", default: "/admin", sensitive: false, inherit: false,
    note: "the backend's own path prefix (SPA + its API). Changing it hides the admin from scanners; the old path answers 404, never a redirect" },
] as const;

export type SettingDef = (typeof SETTING_DEFS)[number];

/** The declaration for a key, or `undefined` for a key nothing declared. */
export function settingDef(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((d) => d.key === key);
}

export function isDeclaredSetting(key: string): boolean {
  return SETTING_DEFS.some((d) => d.key === key);
}
