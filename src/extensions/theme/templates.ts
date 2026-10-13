/**
 * Theme template rendering — now a thin adapter over `theme-runtime.ts`.
 *
 * Historically this module did literal `{{token}}` replacement against four
 * fixed filenames. It now delegates to the real template engine, so themes get
 * conditions, loops, includes, inheritance and content queries.
 *
 * The legacy placeholder names (`{{site.title}}`, `{{content}}`, ...) are still
 * produced by the engine's scope, so existing theme packages keep working.
 */
import { Env } from "../../shared/types";
import { renderBlocks } from "../../platform/frontend";
import { renderThemePage, type ThemeRenderOptions } from "./runtime-declarative";

export interface RenderThemeTemplateOptions {
  locale: string;
  /** Template name, or a page kind such as `index` / `single` / `page`. */
  template: string;
  title: string;
  description?: string;
  content?: string;
  path: string;
  /** Required — see `ThemeRenderOptions.siteId`. */
  siteId: string;
}

/** Map the legacy `template` string onto a hierarchy context. */
function contextFor(template: string) {
  switch (template) {
    case "index":
      return { kind: "home" as const };
    case "single":
      return { kind: "single" as const, postType: "post" };
    case "page":
      return { kind: "page" as const, postType: "page" };
    case "archive":
      return { kind: "archive" as const, postType: "post" };
    case "search":
      return { kind: "search" as const };
    case "404":
      return { kind: "404" as const };
    default:
      // A theme may name a concrete template; treat it as a single view.
      return { kind: "single" as const, postType: template };
  }
}

export async function renderThemeTemplate(
  env: Env,
  o: RenderThemeTemplateOptions
): Promise<Response> {
  const ctx = contextFor(o.template);
  const opts: ThemeRenderOptions = {
    locale: o.locale,
    path: o.path,
    title: o.title,
    description: o.description,
    siteId: o.siteId,
    ...ctx,
  };
  // Legacy callers pass pre-rendered HTML in `content`; expose both the raw
  // JSON (for `{{@query}}`-style templates) and the rendered HTML under the
  // historical `{{content}}` token.
  const extra: Record<string, unknown> = {};
  if (o.content !== undefined) {
    extra["content"] = o.content ? renderBlocks(o.content) : "";
    extra["content_raw"] = o.content;
  }
  (opts as any).extra = extra;

  const result = await renderThemePage(env, opts);
  return new Response(result.html, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public,max-age=60",
      "X-CFPress-Template": result.template,
    },
  });
}

/** Render and return the raw result, for callers that need the metadata. */
export async function renderThemedPage(env: Env, o: ThemeRenderOptions) {
  return renderThemePage(env, o);
}
