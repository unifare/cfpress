/**
 * Layer ② of the UI dictionary: packs declared by enabled plugins.
 *
 * ## Why inline rather than `langs/{locale}.json`
 *
 * A theme package is exploded into R2 file by file, so a theme's pack is a
 * plain object read. A plugin package is **not** — `uploadExtension` stores it
 * as a zip and stops there. Reading a file out of that zip on every admin
 * request would mean unzipping in the hot path for a handful of strings.
 *
 * Plugins are declarative manifests anyway: they name hooks and the host
 * supplies the implementation. Declaring their strings the same way keeps the
 * whole extension in one auditable file:
 *
 * ```json
 * {
 *   "name": "seo",
 *   "langs": {
 *     "en":    { "plugin.seo.meta.title": "Meta title" },
 *     "zh-CN": { "plugin.seo.meta.title": "页面标题" }
 *   }
 * }
 * ```
 *
 * Keys still carry the `plugin.{name}.` prefix (§10 rule 7); the architecture
 * test scans the shipped `plugins/…/langs/….json` files, and
 * `validateManifest` rejects an inline pack whose keys are unnamespaced.
 */
import { Env } from "../../shared/types";
import { type Pack } from "../../platform/i18n/translate";
import { installedPlugins } from "./runtime";

/** Pull one locale's inline pack out of a manifest. */
export function inlinePackFromManifest(manifest: any, locale: string): Pack | null {
  const langs = manifest?.langs;
  if (!langs || typeof langs !== "object" || Array.isArray(langs)) return null;
  const exact = Object.prototype.hasOwnProperty.call(langs, locale) ? langs[locale] : undefined;
  const chosen =
    exact ??
    (locale.includes("-")
      ? Object.prototype.hasOwnProperty.call(langs, locale.split("-")[0])
        ? langs[locale.split("-")[0]]
        : undefined
      : undefined);
  if (!chosen || typeof chosen !== "object" || Array.isArray(chosen)) return null;
  const out: Pack = Object.create(null) as Pack;
  for (const [k, v] of Object.entries(chosen as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Merge every enabled plugin's pack for `locale`.
 *
 * A plugin whose pack is malformed, or that has none, is skipped rather than
 * failing the request: a missing translation is a cosmetic problem, and a 500
 * on the admin is not.
 */
export async function pluginPackProvider(env: Env, _siteId: string, locale: string): Promise<Pack | null> {
  const plugins = await installedPlugins(env);
  const merged: Pack = Object.create(null) as Pack;
  let found = false;
  for (const p of plugins) {
    const pack = inlinePackFromManifest((p as any).manifest, locale);
    if (!pack) continue;
    found = true;
    for (const [k, v] of Object.entries(pack)) merged[k] = v;
  }
  return found ? merged : null;
}
