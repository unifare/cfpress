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
  { key: "site.timezone", scope: "site", type: "string", default: "UTC", sensitive: false, inherit: false,
    note: "site timezone, e.g. UTC, Asia/Shanghai, America/New_York" },
  { key: "site.posts_per_page", scope: "site", type: "number", default: "10", sensitive: false, inherit: false,
    note: "number of posts displayed per page on archive and blog lists" },
  { key: "site.date_format", scope: "site", type: "string", default: "YYYY-MM-DD", sensitive: false, inherit: false,
    note: "date display format in templates and feeds" },
  { key: "site.time_format", scope: "site", type: "string", default: "HH:mm:ss", sensitive: false, inherit: false,
    note: "time display format in templates" },
  { key: "seo.titleTemplate", scope: "site", type: "string", default: "%title% | %site%", sensitive: false, inherit: false,
    note: "SEO title template; %title% and %site% are replaced at render time" },
  { key: "seo.description", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "default meta description" },
  { key: "seo.robots", scope: "site", type: "string", default: "index,follow", sensitive: false, inherit: false,
    note: "robots directive for the site's pages" },
  { key: "seo.separator", scope: "site", type: "string", default: "|", sensitive: false, inherit: false,
    note: "title separator (e.g. |, -, •, /)" },
  { key: "seo.og_image", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "default social sharing image URL for OpenGraph and Twitter cards" },
  { key: "seo.twitter_handle", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "Twitter / X handle (e.g. @username)" },
  { key: "seo.schema_type", scope: "site", type: "string", default: "Person", sensitive: false, inherit: false,
    note: "Schema.org entity type (Person or Organization)" },
  { key: "seo.google_verify", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "Google Search Console verification meta code" },
  { key: "seo.bing_verify", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "Bing Webmaster Tools verification meta code" },
  { key: "seo.baidu_verify", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "Baidu Search Resource verification meta code" },
  { key: "seo.indexnow_key", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "IndexNow API key for instant search engine submission" },
  { key: "seo.robots_custom", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "custom directives appended to robots.txt" },
  // -- site: permalinks -------------------------------------------------------
  { key: "permalink.structure", scope: "site", type: "string", default: "/blog/%postname%", sensitive: false, inherit: false,
    note: "permalink structure pattern for posts (e.g. /blog/%postname%, /posts/%postname%, /%year%/%monthnum%/%postname%/, etc.)" },
  { key: "permalink.category_base", scope: "site", type: "string", default: "category", sensitive: false, inherit: false,
    note: "base prefix for category archive URLs" },
  { key: "permalink.tag_base", scope: "site", type: "string", default: "tag", sensitive: false, inherit: false,
    note: "base prefix for tag archive URLs" },
  // -- site: platform behaviour ----------------------------------------------
  { key: "theme.active", scope: "site", type: "string", default: "default", sensitive: false, inherit: false,
    note: "which theme this site renders; written by activate, read by activeTheme()" },
  { key: "cfpress.features", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "feature switches, one JSON object per site (see shared/features.ts)" },
  { key: "cfpress.media", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "media policy overrides (isolation / requireSession) + storage provider choice (provider: r2|imgbb|postimages), see platform/media-policy.ts and platform/media-hosts.ts" },
  { key: "cfpress.media.imgbb_key", scope: "site", type: "string", default: "", sensitive: true, inherit: false,
    note: "imgbb API key for this site's uploads. Sensitive: never echoed back (placeholder instead), and an empty write keeps the stored value" },
  { key: "cfpress.media.postimages_key", scope: "site", type: "string", default: "", sensitive: true, inherit: false,
    note: "postimages.org API key for this site's uploads. Same sensitive contract as the imgbb key" },
  { key: "admin.menu.custom", scope: "site", type: "json", default: "{}", sensitive: false, inherit: false,
    note: "per-site admin menu customisation (nav.js reads it)" },
  { key: "i18n.defaultLocale", scope: "site", type: "string", default: "", sensitive: false, inherit: false,
    note: "legacy: the site's default locale used to be a setting and is now site_locales.is_default; kept declared so an old row cannot be written blind" },
  { key: "members.registration", scope: "site", type: "boolean", default: "0", sensitive: false, inherit: false,
    note: "whether the front end accepts new member registrations on this site. Off by default: a registration form that appears without being switched on is an open door nobody chose to open (batch D)" },
  { key: "demo.seeded", scope: "site", type: "boolean", default: "0", sensitive: false, inherit: false,
    note: "the boot-time demo-seed decision (see shared/demo-content.ts): set once per install, so a user who deletes their content never finds the demo resurrected on the next boot. Clearing it re-arms the one-time seed" },
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
