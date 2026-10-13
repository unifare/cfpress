/**
 * Platform feature switches — the switch vocabulary and its resolver.
 *
 * ## Why this lives in `shared/` and not in `extensions/contract/`
 *
 * It started in `contract/manifest.ts` as a vocabulary entry, which is where
 * every other declaration lives. That was wrong for one specific reason:
 * `shared/cache.ts` is a consumer, and `shared/` is a **leaf** (§7.3 rule 5) —
 * it may not import `extensions/`. `architecture.test.mjs` caught it:
 *
 *     src/shared/features.ts -> ../extensions/contract/manifest  (reaches extensions/)
 *
 * The three fixes available were: (a) move the consumer out of `shared/`,
 * (b) weaken the layering rule, or (c) move the vocabulary down. (a) is not
 * possible — the content-cache version genuinely belongs to `shared/cache.ts`
 * — and (b) would be the first crack in a rule that exists to stop exactly
 * this. So the vocabulary moved to the leaf. It is imported from
 * `./shared/features` by its two consumers (`api.ts`, which owns the admin
 * endpoints, and `extensions/theme/runtime-worker.ts`, which reads the sandbox
 * switch); `api.ts` sits above `shared/` and `index.ts` is the only file that
 * knows every layer, so both imports are legal and no re-export is needed.
 *
 * ## Why one object, not three constants
 *
 * Each switch has **three readers that must agree**: this resolver, the admin
 * screen that edits it, and the `vars` name in `wrangler.jsonc`. Any one of
 * them spelling the key differently produces a switch that saves fine and does
 * nothing — the "declared but never consumed" defect this repo has fixed five
 * times. So key, var name and default are defined once, per switch, here.
 *
 * ## Precedence, highest first
 *
 *   1. `settings` row `cfpress.features` for this site (set from the admin)
 *   2. `env.<varName>` from `wrangler.jsonc` `vars` (set at deploy time)
 *   3. the switch's `defaultOn` (every switch defaults to off)
 *
 * ## Failure policy
 *
 * Every step is wrapped. A switch that cannot be resolved reads as **off**,
 * which is the safe direction for all three consumers: the KV mirror is
 * skipped, worker themes fall back to the declarative renderer, and the
 * interface-language menu keeps offering every language the platform knows
 * (the documented decoupling of UI language from content language, §2.4).
 * None of them degrades the site. The runtime path is deliberately forgiving
 * because it is on the critical path of every page render, while each consumer
 * still requires an explicit "on" before it does anything.
 *
 * A settings row that is present but does not mention this switch (because it
 * was saved before the switch existed) falls through to step 2, not to the
 * default — otherwise adding a key to the admin would silently disable an
 * already-enabled var.
 */

/** The single `settings` key holding every per-site switch, as one JSON object. */
export const FEATURE_SETTINGS_KEY = "cfpress.features";

/**
 * The slice of `Env` this module needs.
 *
 * Declared structurally rather than importing `Env` from `./types`, because
 * `types.ts` imports nothing and this module must not become the reason it
 * starts to: `Env` names `WorkerLoader` and `R2Bucket` from
 * `@cloudflare/workers-types`, and pulling those in here would couple the
 * switch resolver to the whole platform type surface for the sake of one
 * field. A structural parameter also lets the test suites pass a plain object,
 * which is exactly what they do.
 *
 * Note there is deliberately **no index signature**. Adding one
 * (`[k: string]: unknown`) looks convenient — the `vars` lookup is dynamic —
 * but it makes every real `Env` unassignable, because TypeScript then requires
 * `DB`, `CACHE`, … to each satisfy `unknown`, which structural typing does not
 * do. Reading a var goes through `readVar()` instead.
 */
export interface FeatureEnv {
  DB: D1Database;
}

/** Read a `vars` value by name. Returns undefined when unset, matching the
 *  "no deploy-time opinion" state the precedence rules describe. */
function readVar(env: FeatureEnv, varName: string): unknown {
  return (env as unknown as Record<string, unknown>)[varName];
}

export interface FeatureSwitch {
  /** The key inside the `cfpress.features` settings object. */
  key: string;
  /** `wrangler.jsonc` `vars` key used as the deploy-time fallback. */
  varName: string;
  /** Used when neither a settings row nor a var is present. */
  defaultOn: boolean;
  /** One-line description, shown in the admin. */
  label: string;
}

export const FEATURE_SWITCHES: readonly FeatureSwitch[] = [
  {
    key: "cache_mirror_kv",
    varName: "CFPRESS_CACHE_MIRROR_KV",
    defaultOn: false,
    label: "Mirror the content-cache version into KV",
  },
  {
    key: "theme_runtime_worker",
    varName: "CFPRESS_THEME_RUNTIME_WORKER",
    defaultOn: false,
    label: "Run theme Workers in the sandbox (requires a paid plan)",
  },
  {
    key: "ui_locale_follow_site",
    varName: "CFPRESS_UI_LOCALE_FOLLOW_SITE",
    defaultOn: false,
    label: "Offer only this site's languages in the admin interface-language menu",
  },
] as const;

/** Look up one switch by key. Throws on an unknown key — a typo here would
 *  otherwise silently read "off" forever, which is the failure mode this whole
 *  definition exists to prevent. */
export function featureSwitch(key: string): FeatureSwitch {
  const found = FEATURE_SWITCHES.find((s) => s.key === key);
  if (!found) throw new Error(`unknown feature switch: ${key}`);
  return found;
}

/** Accept the spellings that reach us from a JSON body, a query string, or a
 *  `vars` value. Anything unrecognised is false — a typo must not enable a
 *  paid feature. */
export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes";
  }
  return false;
}

/** Read one switch for one site. See the precedence note above. */
export async function featureEnabled(env: FeatureEnv, siteId: string, key: string): Promise<boolean> {
  const def = featureSwitch(key); // throws on an unknown key, by design

  const parsed = await readSiteRow(env, siteId);
  if (parsed && key in parsed) return truthy(parsed[key]);

  const fromVar = readVar(env, def.varName);
  if (fromVar !== undefined && fromVar !== null && fromVar !== "") return truthy(fromVar);

  return def.defaultOn;
}

/**
 * Read every switch at once, for the admin screen.
 *
 * `source` records *why* each value is what it is, so the screen can say so
 * rather than showing a checkbox with no provenance — "off because nobody set
 * anything" and "off because the operator turned it off" look identical
 * otherwise, and only one of them is worth acting on.
 */
export async function featureSnapshot(
  env: FeatureEnv,
  siteId: string
): Promise<Record<string, { enabled: boolean; source: "site" | "var" | "default"; raw: unknown }>> {
  const parsed = await readSiteRow(env, siteId);
  const out: Record<string, { enabled: boolean; source: "site" | "var" | "default"; raw: unknown }> = {};
  for (const s of FEATURE_SWITCHES) {
    if (parsed && s.key in parsed) {
      out[s.key] = { enabled: truthy(parsed[s.key]), source: "site", raw: parsed[s.key] };
      continue;
    }
    const v = readVar(env, s.varName);
    if (v !== undefined && v !== null && v !== "") {
      out[s.key] = { enabled: truthy(v), source: "var", raw: v };
      continue;
    }
    out[s.key] = { enabled: s.defaultOn, source: "default", raw: s.defaultOn };
  }
  return out;
}

/**
 * The value a switch takes with no site row: the `vars` value if set, else the
 * declared default. Lets the admin offer "reset to inherit" and preview what
 * that would produce without a second round trip.
 */
export function inheritedValue(env: FeatureEnv, s: FeatureSwitch): { enabled: boolean; source: "var" | "default" } {
  const v = readVar(env, s.varName);
  if (v !== undefined && v !== null && v !== "") return { enabled: truthy(v), source: "var" };
  return { enabled: s.defaultOn, source: "default" };
}

/** Parse the site's `cfpress.features` row. Unreadable or corrupt reads as
 *  "no site-level opinion" so the deploy-time layer still applies. */
async function readSiteRow(env: FeatureEnv, siteId: string): Promise<Record<string, unknown> | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?")
      .bind(siteId, FEATURE_SETTINGS_KEY)
      .first<{ value: string | null }>();
    if (row?.value == null) return null;
    const parsed = JSON.parse(String(row.value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
