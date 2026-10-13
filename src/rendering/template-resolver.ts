/**
 * WordPress-style template hierarchy resolution.
 *
 * Given a page context (what kind of page, which post type, which slug, ...)
 * produce an ordered candidate list of template names, then load the first
 * one that exists in the active theme.
 */

export interface TemplateContext {
  /** Logical page kind. */
  kind: "front" | "home" | "single" | "page" | "archive" | "category" | "tag" | "taxonomy" | "search" | "404";
  /** Post type for single/archive pages, e.g. "post", "page", "product". */
  postType?: string;
  /** Slug of the object being viewed. */
  slug?: string;
  /** Taxonomy name for taxonomy/category/tag archives. */
  taxonomy?: string;
  /** Term slug for taxonomy archives. */
  term?: string;
  /**
   * An explicitly named template, which wins over the entire hierarchy.
   *
   * A theme route names the template it wants (`routes[].template`). Until this
   * existed the field was *validated* — the architecture test even asserts it
   * is one of the theme's declared `templates[]` — but never read, so a route
   * rendered whatever the hierarchy derived from `kind`/`postType`. That
   * happened to agree for `/products/:slug` (both sides say `single-product`)
   * and would silently disagree for anything else, including every route that
   * resolves a theme-owned table, where there is no post type to derive from
   * and the hierarchy can only reach the generic `archive`/`single`.
   *
   * The hierarchy still follows as a fallback, so naming a template that does
   * not exist degrades to the derived one instead of rendering nothing.
   */
  template?: string;
}

/**
 * Build the ordered candidate list, highest priority first.
 * Mirrors WordPress conventions but uses `.html` instead of `.php`.
 */
export function templateCandidates(ctx: TemplateContext): string[] {
  const out: string[] = [];
  const push = (name: string) => {
    if (!out.includes(name)) out.push(name);
  };

  // An explicit name outranks every derived candidate. It is checked first and
  // then kept in the list, so the reason it was chosen is visible in `tried`.
  if (ctx.template) push(ctx.template);

  switch (ctx.kind) {
    case "front":
      push("front-page");
      push("home");
      push("index");
      break;

    case "home":
      push("home");
      push("front-page");
      push("index");
      break;

    case "single": {
      const type = ctx.postType ?? "post";
      if (ctx.slug) push(`single-${type}-${ctx.slug}`);
      push(`single-${type}`);
      // `single-post` is the convention for the built-in post type.
      if (type === "post") push("single-post");
      push("single");
      push("index");
      break;
    }

    case "page": {
      // Pages resolve: page-{slug} -> page-{id} -> page -> single -> index
      if (ctx.slug) push(`page-${ctx.slug}`);
      push("page");
      push("single");
      push("index");
      break;
    }

    case "archive": {
      const type = ctx.postType ?? "post";
      push(`archive-${type}`);
      push("archive");
      push("index");
      break;
    }

    case "category":
      if (ctx.term) push(`category-${ctx.term}`);
      push("category");
      push("archive");
      push("index");
      break;

    case "tag":
      if (ctx.term) push(`tag-${ctx.term}`);
      push("tag");
      push("archive");
      push("index");
      break;

    case "taxonomy": {
      const tax = ctx.taxonomy ?? "taxonomy";
      if (ctx.term) push(`taxonomy-${tax}-${ctx.term}`);
      push(`taxonomy-${tax}`);
      push("taxonomy");
      push("archive");
      push("index");
      break;
    }

    case "search":
      push("search");
      push("archive");
      push("index");
      break;

    case "404":
      push("404");
      push("index");
      break;
  }

  return out;
}

/** A minimal loader contract so the resolver stays storage-agnostic. */
export interface TemplateLoader {
  /** Return template source, or null when the template does not exist. */
  (name: string): Promise<string | null>;
}

export interface ResolvedTemplate {
  name: string;
  source: string;
  /** The full candidate chain that was tried, for debugging / admin UI. */
  tried: string[];
}

/**
 * Walk the candidate list and return the first template that exists.
 * `fallback` is used only when even `index` is absent, which lets an
 * incomplete theme still render instead of hard-failing.
 */
export async function resolveTemplate(
  ctx: TemplateContext,
  load: TemplateLoader,
  fallback?: () => string
): Promise<ResolvedTemplate | null> {
  const tried = templateCandidates(ctx);
  for (const name of tried) {
    const source = await load(name);
    if (source !== null) return { name, source, tried };
  }
  if (fallback) return { name: "__fallback__", source: fallback(), tried };
  return null;
}

/**
 * Rewrite `{{@section "x"}}` placeholders inside a layout so the renderer can
 * substitute child content. Called by the engine's layout handling.
 */
export function extractSectionNames(source: string): string[] {
  const names: string[] = [];
  const re = /\{\{@section\s+(?:"([^"]+)"|'([^']+)')\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1] ?? m[2]);
  return names;
}
