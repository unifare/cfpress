/**
 * Core Permalink Engine for CFPress.
 *
 * Provides bidirectional permalink processing:
 * 1. Pattern Tokenizer & Regex Compiler (`compilePermalinkPattern`, `matchPermalink`)
 * 2. Forward Canonical URL Builder (`buildPermalink`, `permalinkOf`)
 * 3. Tag Extractor and Validator (`extractPermalinkTokens`, `validatePermalinkPattern`)
 *
 * Supported standard tags (WordPress / dotnetcms compatible):
 * - `%year%`: 4-digit publication year (e.g. 2026)
 * - `%monthnum%`: 2-digit publication month (01-12)
 * - `%day%`: 2-digit publication day of month (01-31)
 * - `%hour%`: 2-digit publication hour (00-23)
 * - `%minute%`: 2-digit publication minute (00-59)
 * - `%second%`: 2-digit publication second (00-59)
 * - `%post_id%`: Unique post identifier (alphanumeric string or int)
 * - `%postname%`: Post slug (language-aware)
 * - `%category%`: Primary category slug (fallback to 'uncategorized')
 * - `%author%`: Author username or slug
 * - `%pagename%`: Hierarchical page path / slug
 */

export interface PermalinkContext {
  id?: string | number;
  slug?: string;
  type?: string;
  created_at?: number | string | Date;
  category?: string;
  author?: string;
  [key: string]: unknown;
}

export interface CompiledPermalink {
  pattern: string;
  regex: RegExp;
  tokens: string[];
}

export const PRESET_PERMALINKS = {
  PLAIN: "/?p=%post_id%",
  DAY_NAME: "/%year%/%monthnum%/%day%/%postname%/",
  MONTH_NAME: "/%year%/%monthnum%/%postname%/",
  NUMERIC: "/archives/%post_id%",
  POST_NAME: "/posts/%postname%/",
  CUSTOM: "",
} as const;

export const DEFAULT_PERMALINK_STRUCTURE = PRESET_PERMALINKS.POST_NAME;

const TOKEN_REGEX_MAP: Record<string, string> = {
  "%year%": "(?<year>\\d{4})",
  "%monthnum%": "(?<monthnum>\\d{2})",
  "%day%": "(?<day>\\d{2})",
  "%hour%": "(?<hour>\\d{2})",
  "%minute%": "(?<minute>\\d{2})",
  "%second%": "(?<second>\\d{2})",
  "%post_id%": "(?<post_id>[a-zA-Z0-9_-]+)",
  "%postname%": "(?<postname>[^/]+)",
  "%category%": "(?<category>[^/]+)",
  "%author%": "(?<author>[^/]+)",
  "%pagename%": "(?<pagename>[^/]+(?:/[^/]+)*)",
};

const SUPPORTED_TOKENS = Object.keys(TOKEN_REGEX_MAP);

/**
 * Extract all %token% placeholders from a structure string.
 */
export function extractPermalinkTokens(pattern: string): string[] {
  const matches = pattern.match(/%[a-z0-9_]+%/gi) || [];
  return Array.from(new Set(matches));
}

/**
 * Validates a permalink structure.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePermalinkPattern(pattern: string): string | null {
  const trimmed = (pattern || "").trim();
  if (!trimmed) return "Permalink structure cannot be empty";
  if (trimmed === PRESET_PERMALINKS.PLAIN) return null;

  const tokens = extractPermalinkTokens(trimmed);
  for (const token of tokens) {
    if (!SUPPORTED_TOKENS.includes(token)) {
      return `Unsupported permalink token: ${token}`;
    }
  }

  // Must contain an identifier token (postname or post_id or pagename) to avoid collision
  const hasIdentifier = tokens.some((t) => ["%postname%", "%post_id%", "%pagename%"].includes(t));
  if (!hasIdentifier) {
    return "Structure must contain at least %postname%, %post_id%, or %pagename% to uniquely identify content";
  }

  return null;
}

const compileCache = new Map<string, CompiledPermalink>();

/**
 * Compiles a permalink pattern into a regular expression for matching URL paths.
 */
export function compilePermalinkPattern(pattern: string): CompiledPermalink {
  const normalized = normalizePattern(pattern);
  const cached = compileCache.get(normalized);
  if (cached) return cached;

  const tokens = extractPermalinkTokens(normalized);

  // Escape special regex characters except for tokens
  // We replace tokens with placeholders, escape the rest, then put regex groups back
  let regexStr = normalized;
  // Replace tokens with unique markers
  const markers: { marker: string; group: string }[] = [];
  tokens.forEach((token, idx) => {
    const marker = `___PL_TOKEN_${idx}___`;
    const group = TOKEN_REGEX_MAP[token] || "([^/]+)";
    markers.push({ marker, group });
    regexStr = regexStr.replaceAll(token, marker);
  });

  // Escape regex specials in static segments
  regexStr = regexStr.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  // Re-inject regex groups
  for (const { marker, group } of markers) {
    regexStr = regexStr.replaceAll(marker, group);
  }

  // Ensure pattern matches exact path (ignoring trailing slash)
  const patternBody = regexStr.endsWith("\\/") ? regexStr.slice(0, -2) : regexStr;
  const finalRegex = new RegExp(`^${patternBody}/?$`);

  const compiled: CompiledPermalink = {
    pattern: normalized,
    regex: finalRegex,
    tokens,
  };

  compileCache.set(normalized, compiled);
  return compiled;
}

/**
 * Normalizes a pattern: trims, ensures single leading slash, preserves trailing slash if present.
 */
function normalizePattern(pattern: string): string {
  let p = (pattern || "").trim();
  if (!p) return DEFAULT_PERMALINK_STRUCTURE;
  if (p === PRESET_PERMALINKS.PLAIN) return p;
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/**
 * Extracts date components safely from timestamp or Date.
 */
function extractDateParts(created_at?: number | string | Date): {
  year: string;
  monthnum: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  let d: Date;
  if (!created_at) {
    d = new Date();
  } else if (typeof created_at === "number") {
    // If Unix timestamp in seconds vs milliseconds
    d = new Date(created_at > 1e11 ? created_at : created_at * 1000);
  } else if (typeof created_at === "string") {
    const n = Number(created_at);
    d = Number.isFinite(n) ? new Date(n > 1e11 ? n : n * 1000) : new Date(created_at);
  } else {
    d = created_at;
  }

  if (isNaN(d.getTime())) d = new Date();

  // UTC-based to ensure deterministic rendering across edge locations
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year: String(d.getUTCFullYear()),
    monthnum: pad(d.getUTCMonth() + 1),
    day: pad(d.getUTCDate()),
    hour: pad(d.getUTCHours()),
    minute: pad(d.getUTCMinutes()),
    second: pad(d.getUTCSeconds()),
  };
}

/**
 * Formats a canonical URL path for a given post and structure pattern.
 */
export function buildPermalink(
  pattern: string,
  post: PermalinkContext,
  options?: {
    locale?: string;
    isDefaultLocale?: boolean;
  }
): string {
  const norm = normalizePattern(pattern);

  // Plain structure: /?p=123 (or /locale/?p=123)
  if (norm === PRESET_PERMALINKS.PLAIN) {
    const id = post.id ?? "";
    const localePrefix = options?.locale && !options.isDefaultLocale ? `/${options.locale}` : "";
    return `${localePrefix}/?p=${encodeURIComponent(String(id))}`;
  }

  const dateParts = extractDateParts(post.created_at);
  const postId = String(post.id ?? "");
  const postName = String(post.slug ?? "");
  const category = String(post.category || "uncategorized");
  const author = String(post.author || "admin");
  const pageName = String(post.slug ?? "");

  let urlPath = norm
    .replace(/%year%/g, dateParts.year)
    .replace(/%monthnum%/g, dateParts.monthnum)
    .replace(/%day%/g, dateParts.day)
    .replace(/%hour%/g, dateParts.hour)
    .replace(/%minute%/g, dateParts.minute)
    .replace(/%second%/g, dateParts.second)
    .replace(/%post_id%/g, encodeURIComponent(postId))
    .replace(/%postname%/g, encodeURI(postName))
    .replace(/%category%/g, encodeURI(category))
    .replace(/%author%/g, encodeURI(author))
    .replace(/%pagename%/g, encodeURI(pageName));

  // Clean double slashes
  urlPath = urlPath.replace(/\/+/g, "/");

  // Prepend locale if specified and not default
  if (options?.locale && !options.isDefaultLocale) {
    urlPath = `/${options.locale}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
  }

  return urlPath;
}

export interface PermalinkMatchResult {
  matched: boolean;
  params: {
    year?: string;
    monthnum?: string;
    day?: string;
    hour?: string;
    minute?: string;
    second?: string;
    post_id?: string;
    postname?: string;
    category?: string;
    author?: string;
    pagename?: string;
  };
}

/**
 * Matches an incoming URL pathname against the compiled permalink pattern.
 * Extracts named parameters if matched.
 */
export function matchPermalink(pattern: string, pathname: string): PermalinkMatchResult {
  const norm = normalizePattern(pattern);
  if (norm === PRESET_PERMALINKS.PLAIN) {
    // Plain URLs are handled via query string (?p=123), not path matching
    return { matched: false, params: {} };
  }

  const compiled = compilePermalinkPattern(norm);
  const cleanPath = pathname.startsWith("/") ? pathname : "/" + pathname;
  const match = compiled.regex.exec(cleanPath);

  if (!match) {
    return { matched: false, params: {} };
  }

  const groups = match.groups || {};
  const params: PermalinkMatchResult["params"] = {};

  if (groups.year) params.year = groups.year;
  if (groups.monthnum) params.monthnum = groups.monthnum;
  if (groups.day) params.day = groups.day;
  if (groups.hour) params.hour = groups.hour;
  if (groups.minute) params.minute = groups.minute;
  if (groups.second) params.second = groups.second;
  if (groups.post_id) params.post_id = decodeURIComponent(groups.post_id);
  if (groups.postname) params.postname = decodeURI(groups.postname);
  if (groups.category) params.category = decodeURI(groups.category);
  if (groups.author) params.author = decodeURI(groups.author);
  if (groups.pagename) params.pagename = decodeURI(groups.pagename);

  return {
    matched: true,
    params,
  };
}
