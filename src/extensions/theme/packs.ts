/**
 * Layer ③ of the UI dictionary: the active theme's language pack.
 *
 * Themes ship `langs/{locale}.json` next to their templates, and the uploader
 * unpacks every theme file into R2 under `…/files/` (see `uploadExtension` in
 * api.ts). So the pack is one R2 read away — no bundling, no build step, and
 * editing a translation is a re-upload rather than a redeploy.
 *
 * Plugins cannot do this: only themes get their files unpacked (a plugin's
 * package is stored as a zip and never exploded), which is why plugin packs are
 * declared inline in the manifest instead — see `extensions/plugin/packs.ts`.
 *
 * This lives in `extensions/` and is injected into `platform/i18n/packs.ts` by
 * `index.ts`. `platform/` may not import `extensions/` (§7.3 rule 1), and the
 * theme pack inherently requires knowing which theme is active — that is
 * extension knowledge.
 */
import { Env } from "../../shared/types";
import { parsePack, type Pack } from "../../platform/i18n/translate";
import { activeTheme, themeFilePrefix } from "./runtime-declarative";
import { bundledThemeFile } from "../../shared/bundled";

/** R2 key holding a theme version's pack for `locale`. */
export function themePackKey(theme: { name: string; version: string }, locale: string): string {
  return `${themeFilePrefix(theme as any)}/langs/${locale}.json`;
}

export async function themePackProvider(env: Env, siteId: string, locale: string): Promise<Pack | null> {
  const theme = await activeTheme(env, siteId);
  if (!theme?.name) return null;
  const obj = await env.MEDIA.get(themePackKey(theme, locale));
  // Uploaded themes keep their pack in R2; bundled themes ship `langs/` inside
  // the worker assets (same two-source rule as template loading).
  const raw = obj ? await obj.text() : await bundledThemeFile(env, theme.name, `langs/${locale}.json`);
  if (!raw) return null;
  return parsePack(raw);
}
