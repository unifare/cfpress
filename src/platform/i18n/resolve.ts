/**
 * Which locale does this request want? (ARCHITECTURE.md §2.6)
 *
 * Priority, highest first:
 *
 *   1. URL path prefix   `/en/about`   — the visitor stated a preference
 *   2. `?lang=`          headless APIs and previews
 *   3. cookie            remembers the last choice
 *   4. the site default  `site_locales.is_default`
 *
 * ## Why `explicit` only means "came from the path"
 *
 * The one behavioural difference between the sources is what happens on a miss.
 * An explicitly prefixed path that does not resolve returns **404** — the
 * visitor asked for English and handing them Chinese is a lie. Every other
 * source is a *hint*, so a miss falls through to another locale: the visitor
 * never asked to be pinned, and a page in the wrong language beats no page.
 *
 * A `?lang=` or cookie value therefore sets the locale but does **not** set
 * `explicit`. Treating them as explicit would turn a stale cookie into a 404
 * on a page that exists — a self-inflicted outage.
 */

/** BCP-47-ish shape: `en`, `zh-CN`, `pt-BR`. Mirrors LOCALE_CODE_RE in security.ts. */
const LOCALE_SEG_RE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

export type LocaleSource = "path" | "query" | "cookie" | "default";

export interface LocaleMatch {
  /** The locale to render with. Always one of `codes` unless `codes` was empty. */
  locale: string;
  /** True only when the URL carried a locale prefix. Controls 404-vs-fallback. */
  explicit: boolean;
  source: LocaleSource;
  /** `path` with any locale prefix removed — the part routes match against. */
  rest: string;
}

export interface ResolveLocaleOptions {
  /** Locale codes this site actually serves. */
  codes: string[];
  /** The site's default locale, used when nothing else matches. */
  defaultLocale: string;
  queryLang?: string | null;
  cookieLang?: string | null;
}

/** True when `code` is a plausible locale code *and* one this site serves. */
export function isKnownLocale(code: string, codes: string[]): boolean {
  return LOCALE_SEG_RE.test(code) && codes.includes(code);
}

export function resolveLocale(path: string, opts: ResolveLocaleOptions): LocaleMatch {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const segs = clean.split("/").filter(Boolean);
  const rest = segs.join("/");

  // 1. explicit path prefix
  const seg0 = segs[0] ?? "";
  if (seg0 && isKnownLocale(seg0, opts.codes)) {
    return { locale: seg0, explicit: true, source: "path", rest: segs.slice(1).join("/") };
  }

  // 2. `?lang=`
  const q = String(opts.queryLang ?? "").trim();
  if (q && isKnownLocale(q, opts.codes)) {
    return { locale: q, explicit: false, source: "query", rest };
  }

  // 3. cookie
  const c = String(opts.cookieLang ?? "").trim();
  if (c && isKnownLocale(c, opts.codes)) {
    return { locale: c, explicit: false, source: "cookie", rest };
  }

  // 4. site default
  return { locale: opts.defaultLocale, explicit: false, source: "default", rest };
}

/** `?lang=zh-CN` from a URL. Returns null when absent or malformed. */
export function langFromUrl(url: URL): string | null {
  const v = String(url.searchParams.get("lang") ?? "").trim();
  return LOCALE_SEG_RE.test(v) ? v : null;
}

/**
 * The visitor's remembered language, from the `cfpress_lang` cookie.
 *
 * Read from the raw header rather than `request.headers.get("cookie")` split by
 * `;` alone: a cookie value may itself contain `=`, so only the *first* `=` in
 * each pair separates name from value.
 */
export function langFromCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== "cfpress_lang") continue;
    const v = decodeURIComponent(part.slice(i + 1).trim());
    return LOCALE_SEG_RE.test(v) ? v : null;
  }
  return null;
}

/** Cookie header value that remembers `code`. */
export function langCookie(code: string, maxAgeDays: number): string {
  const maxAge = Math.max(0, Math.round(maxAgeDays * 86400));
  return `cfpress_lang=${encodeURIComponent(code)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
