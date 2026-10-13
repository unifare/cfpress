/**
 * Layer ④-facing lookup: turn a stack of dictionaries into one `__()` function.
 *
 * `packs` is ordered LOW → HIGH priority, mirroring the four-layer model in
 * ARCHITECTURE.md §2.4: core pack, plugin packs, theme packs, database
 * overrides. Lookup walks the array backwards so a later layer wins.
 *
 * Two rules that are easy to get wrong and expensive to debug:
 *
 * 1. **A missing key returns the key itself**, never an empty string. The
 *    fallback is "this text has not been translated", which is a normal state.
 *    It is NOT the same as "the system does not know what this is" — an empty
 *    button is worse than a button labelled `core.action.save`.
 *
 * 2. **Every dictionary read goes through `hasOwnProperty`.** A key arriving
 *    from a request (`?lang=constructor`) would otherwise walk the prototype
 *    chain and return `Object`'s constructor instead of a string. This is the
 *    same class of bug the template engine's `safeGet()` exists to prevent.
 */
export type Pack = Record<string, string>;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Replace `{name}` placeholders. Unknown placeholders are left verbatim. */
export function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    hasOwn(vars, name) ? String(vars[name]) : whole
  );
}

export interface Translator {
  (key: string, vars?: Record<string, unknown>): string;
  /** The locale this translator resolved to. */
  readonly locale: string;
  /** True when at least one pack actually defines `key`. */
  has(key: string): boolean;
}

export function createTranslator(packs: Pack[], locale: string): Translator {
  const lookup = (key: string): string | null => {
    for (let i = packs.length - 1; i >= 0; i--) {
      const p = packs[i];
      if (!p || typeof p !== "object") continue;
      if (!hasOwn(p, key)) continue;
      const v = p[key];
      if (typeof v === "string") return v;
    }
    return null;
  };

  const t = ((key: string, vars?: Record<string, unknown>): string => {
    const raw = lookup(key);
    return raw === null ? key : interpolate(raw, vars);
  }) as Translator;

  Object.defineProperty(t, "locale", { value: locale, enumerable: true });
  t.has = (key: string) => lookup(key) !== null;
  return t;
}

/**
 * Pick the pack for `locale` out of a `{locale: pack}` map.
 *
 * Exact match first, then the base language: a request for `en-GB` should read
 * the `en` pack rather than show raw keys. Going the other way (serving `en-GB`
 * content to an `en` request) is deliberately *not* done — that would let a
 * regional variant masquerade as the base language.
 */
export function packForLocale(packs: Record<string, Pack>, locale: string): Pack | null {
  const code = String(locale ?? "").trim();
  if (!code) return null;
  if (hasOwn(packs, code) && packs[code] && typeof packs[code] === "object") return packs[code];
  const base = code.split("-")[0];
  if (base && hasOwn(packs, base) && packs[base] && typeof packs[base] === "object") {
    return packs[base];
  }
  return null;
}

/** Parse a pack that arrived as text (an R2 object or a DB column). */
export function parsePack(text: string | null | undefined): Pack | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Pack = Object.create(null) as Pack;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Flatten a stack into one dictionary for shipping to a client (the admin SPA
 * fetches its strings once per session). Later layers win.
 *
 * Written as an explicit key loop onto a **null-prototype** target rather than
 * `Object.assign({}, ...packs)`. `Object.assign` copies via `[[Set]]`, so a pack
 * containing a `__proto__` key would reassign the target's prototype instead of
 * adding a property — the same prototype-escape the template engine's
 * `safeGet()` exists to block, reachable here from an uploaded theme file.
 */
export function mergePacks(packs: Pack[]): Pack {
  const out: Pack = Object.create(null) as Pack;
  for (const p of packs) {
    if (!p || typeof p !== "object") continue;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}
