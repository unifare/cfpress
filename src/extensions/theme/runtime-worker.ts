/**
 * L3 theme sandbox runtime.
 *
 * A theme may declare `"runtime": "worker"` in its manifest. Such a theme
 * ships a real JavaScript Worker (stored in R2 alongside its templates) which
 * is loaded through the **Worker Loader** binding and invoked per request.
 * This gives themes full programming freedom without ever `eval`-ing code in
 * the host isolate: the loaded module runs in its own isolate with its own
 * `env`.
 *
 * Everything in this file exists because of what the feasibility probes
 * actually showed (see `docs/design/THEME-ARCHITECTURE-PLAN.md` §6.0):
 *
 *   1. `loader.load()` **does not throw on bad syntax** — the failure surfaces
 *      on the first `fetch`. So we *warm* every freshly loaded module by making
 *      a probe request before trusting it. Without this, a broken theme would
 *      burn a failed load on every page view.
 *   2. A sub-Worker exception **propagates into the host**. Every call is
 *      wrapped so a crashing theme degrades to the L1 template renderer
 *      instead of taking the site down.
 *   3. **KV/D1/R2 bindings cannot be passed** (`cannot be serialized`). Only
 *      plain values and Fetchers survive. Content therefore reaches the theme
 *      through `env.HOST` — a Fetcher pointing back at the sandboxed theme
 *      API. The permission boundary is *which endpoints that API exposes*,
 *      not which bindings were injected.
 *   4. The sub-Worker's `env` does not inherit host bindings, which gives us
 *      least-privilege by default.
 *   5. **A `WorkerStub` cannot be cached across requests.** It owns a
 *      `WorkerStubChannel` I/O object bound to the request context that created
 *      it, so reusing it throws *"Cannot perform I/O on behalf of a different
 *      request"* on the second request. We therefore cache the R2 **source
 *      text** (a plain string, safe to share) and call `loader.load()` afresh
 *      on every request. `load()` is cheap — workerd reuses the already-compiled
 *      isolate when the source is byte-identical — so this costs almost nothing
 *      while remaining correct.
 */
import { Env } from "../../shared/types";
import { featureEnabled } from "../../shared/features";
import { setting } from "../../platform/frontend";
import { listSites } from "../../platform/sites";
import { siteDefaultLocale, siteLocales } from "../../platform/i18n/locale-registry";
import { resolveMetaByPost } from "../../platform/post-meta";
import { resolveThemeTable } from "./tables";
import { tableBySlug, tableList, tableSave } from "./table-facade";
import { themeFilePrefix, activeTheme, type ActiveTheme } from "./runtime-declarative";

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/** Where a worker-runtime theme's entry module lives inside its package. */
export const DEFAULT_THEME_ENTRY = "worker.js";

export interface ThemeWorkerManifest {
  runtime?: "declarative" | "worker";
  /** Entry module path inside the theme package. Defaults to `worker.js`. */
  entry?: string;
  /** Capabilities the theme Worker is granted at the theme API. */
  capabilities?: string[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface LoadedThemeWorker {
  stub: WorkerStub;
  entry: string;
}

/**
 * Cache of theme Worker *source text*, per (env, theme, version).
 *
 * We deliberately cache the string and not the `WorkerStub`: a stub holds a
 * request-scoped I/O channel and cannot be reused across requests (finding #5).
 * Caching the source lets us skip the R2 round-trip while still calling
 * `loader.load()` inside the current request context every time.
 */
const sourceCache = new WeakMap<Env, Map<string, Promise<string | null>>>();

function cacheKeyFor(theme: ActiveTheme): string {
  return `${theme.name}@${theme.version}`;
}

/** The R2 key holding a worker-runtime theme's entry module. */
export function themeWorkerKey(theme: ActiveTheme, entry = DEFAULT_THEME_ENTRY): string {
  return `${themeFilePrefix(theme)}/${entry}`;
}

/**
 * Read the theme's Worker source from R2. Returns null when the theme ships no
 * Worker (i.e. it is a declarative L1/L2 theme).
 */
export async function loadThemeWorkerSource(
  env: Env,
  theme: ActiveTheme,
  entry = DEFAULT_THEME_ENTRY
): Promise<string | null> {
  const obj = await env.MEDIA?.get(themeWorkerKey(theme, entry));
  return obj ? await obj.text() : null;
}

/**
 * Get (and warm) the theme Worker **for the current request**.
 *
 * Returns null when the runtime is unavailable, the theme ships no Worker, or
 * the module fails to boot — in every one of those cases the caller falls back
 * to L1/L2 rendering.
 *
 * The stub is always produced inside the caller's request context. Only the
 * source text is cached, because a `WorkerStub` is request-scoped (finding #5).
 *
 * ## Two gates before the sandbox is touched
 *
 * The first is the missing-binding check that has always been here. The second
 * is the `theme_runtime_worker` switch (`shared/features.ts`), which defaults
 * to off.
 *
 * The switch is **checked before the binding** on purpose. A deploy can have
 * `worker_loaders` configured — a paid account — and still want the runtime
 * off, either to revoke the capability without a redeploy or to isolate a
 * misbehaving theme. Checking the binding first would make "binding present"
 * silently overrule the operator, which is the bug this switch exists to fix.
 *
 * The switch is already resolved when it matters: `featureEnabled()` reads the
 * site's `settings` row directly, so there is no "the switch has not warmed up
 * yet" window and a bad site id degrades to the declared default (off) rather
 * than to "allowed".
 */
export async function getThemeWorker(
  env: Env,
  theme: ActiveTheme,
  siteId: string
): Promise<LoadedThemeWorker | null> {
  // 1. Operator switch. Off by default; a deploy that never set the var and a
  //    site that never touched the admin both land here.
  if (!(await featureEnabled(env, siteId, "theme_runtime_worker"))) return null;

  // 2. Binding availability. Kept as a separate check so the two reasons for
  //    "no sandbox" stay distinguishable in the code and in review.
  if (!env.LOADER) return null; // feature not available on this deploy

  const manifest = theme.manifest as ThemeWorkerManifest;
  if (manifest.runtime !== "worker") return null;

  const entry = manifest.entry ?? DEFAULT_THEME_ENTRY;

  let perEnv = sourceCache.get(env);
  if (!perEnv) {
    perEnv = new Map();
    sourceCache.set(env, perEnv);
  }
  const key = cacheKeyFor(theme) + ":" + entry;
  let pending = perEnv.get(key);
  if (!pending) {
    pending = loadThemeWorkerSource(env, theme, entry);
    perEnv.set(key, pending);
  }
  const source = await pending;
  if (!source) return null;

  let stub: WorkerStub;
  try {
    stub = env.LOADER.load({
      compatibilityDate: "2026-09-01",
      mainModule: "theme.js",
      modules: { "theme.js": source },
      // Only plain values and Fetchers survive this boundary. `HOST` is the
      // sandboxed theme API; the theme never receives DB/MEDIA/CACHE.
      env: {
        CFP_THEME: theme.name,
        CFP_THEME_VERSION: theme.version,
        CFP_SITE: siteId,
        HOST: env.THEME_HOST,
      },
      // Block the theme from reaching the public internet. The host API is
      // still reachable because it is an explicit binding, not global fetch.
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 20 },
    });
  } catch {
    return null;
  }

  // Finding #1: bad syntax surfaces on first use, not at load(). Warm it now —
  // still inside this request's context — so a broken theme is rejected once
  // instead of failing every request.
  try {
    const probe = await invokeThemeWorker(stub, new Request("http://theme/__health"));
    // Drain the body so the runtime completes the invocation.
    await probe.text();
  } catch {
    return null;
  }

  return { stub, entry };
}

/**
 * Drop cached theme Worker source for a theme (call after
 * install/activate/deactivate) so the next request re-reads it from R2.
 */
export function invalidateThemeWorker(env: Env, themeName?: string) {
  const perEnv = sourceCache.get(env);
  if (!perEnv) return;
  if (!themeName) {
    perEnv.clear();
    return;
  }
  for (const k of [...perEnv.keys()]) {
    if (k.startsWith(`${themeName}@`)) perEnv.delete(k);
  }
}

/**
 * Invoke the loaded theme Worker. Isolated so a crashing theme never escapes
 * into the host request path (finding #2).
 */
export async function invokeThemeWorker(stub: WorkerStub, request: Request): Promise<Response> {
  const entry = stub.getEntrypoint();
  // Fetcher-shaped RPC: the loaded module's default export receives the request.
  return (entry as unknown as Fetcher).fetch(request);
}

// ---------------------------------------------------------------------------
// Render path
// ---------------------------------------------------------------------------

export interface ThemeWorkerRequest {
  /** The original incoming request (path + query preserved). */
  request: Request;
  /** Logical template kind, e.g. `single` — lets the Worker pick its own view. */
  kind: string;
  /** Resolved site, so the theme can branch without re-parsing the host. */
  siteId: string;
  /** Everything the L1 scope would contain, as plain JSON for convenience. */
  scope: Record<string, unknown>;
}

/**
 * Try to render a page through the theme's Worker.
 *
 * Returns null whenever the theme should fall back to the declarative
 * renderer: no LOADER binding, non-worker theme, module failed to boot, or an
 * exception/5xx during the call. Callers treat null as "render normally".
 */
export async function tryRenderWithThemeWorker(
  env: Env,
  theme: ActiveTheme,
  input: ThemeWorkerRequest
): Promise<{ html: string; status: number } | null> {
  const loaded = await getThemeWorker(env, theme, input.siteId);
  if (!loaded) return null;

  const url = new URL(input.request.url);
  // Route through a stable internal origin; the theme reads the real path from
  // the request URL it receives.
  const themeReq = new Request(url.toString(), {
    method: "GET",
    headers: {
      // Plain strings only — header values are ByteStrings, so anything put
      // here has to survive Latin-1. That is exactly why there is no scope
      // header: a site whose title, categories or tags are Chinese (or Japanese,
      // or Arabic) would make `JSON.stringify(scope)` unrepresentable and the
      // whole Worker path would fall back to the declarative renderer with no
      // error anywhere. A theme reads state through `env.HOST`, which is a real
      // HTTP response body and carries UTF-8.
      "x-cfpress-kind": input.kind,
      "x-cfpress-site": input.siteId,
      "x-cfpress-theme": theme.name,
    },
  });

  try {
    const res = await invokeThemeWorker(loaded.stub, themeReq);
    // 501 is the theme explicitly saying "I do not handle this route" — the
    // documented way for a worker theme to defer back to the declarative
    // renderer for paths it does not care about.
    if (res.status === 501) return null;
    // A 5xx from the theme means it failed; fall back rather than serve it.
    if (!res.ok && res.status >= 500) return null;
    const html = await res.text();
    if (!html) return null;
    return { html, status: res.status };
  } catch {
    // Finding #2: exceptions propagate from the sub-Worker. Swallow and fall
    // back to declarative rendering.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Theme API (the `env.HOST` the sandbox calls back into)
// ---------------------------------------------------------------------------

/**
 * Capabilities a theme Worker may hold. Kept deliberately small: the narrow
 * surface *is* the security boundary.
 */
export const THEME_API_CAPABILITIES = [
  "content.read",
  "site.read",
  "menu.read",
  "locales.read",
  "table.read",
  "table.write",
] as const;
export type ThemeApiCapability = (typeof THEME_API_CAPABILITIES)[number];

/**
 * Handle a request from a sandboxed theme Worker. The path decides the data;
 * the theme's declared capabilities decide whether it is allowed.
 *
 * Reached at `/__cfpress/theme-api/…` on the host Worker.
 *
 * ## Why `x-cfpress-site` is validated, not trusted
 *
 * The host sets this header when it calls into the sandbox, so in the normal
 * flow it is trustworthy. But this route is matched **before** site resolution
 * and has no auth of its own — so a caller who reaches the host directly can
 * set the header to any value and read another site's data. An unvalidated
 * "which site am I" header is a multi-site hole wearing a trusted name.
 *
 * A header is therefore treated as a **claim**: it must name a site that
 * actually exists. A missing or unknown value is rejected rather than quietly
 * defaulting — silently serving the default site is the exact failure mode
 * this rule exists to prevent (see the `activeTheme()` defect, v0.7.0).
 */
export async function handleThemeApi(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/__cfpress\/theme-api\/?/, "");
  const themeName = request.headers.get("x-cfpress-theme") ?? "";

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json;charset=UTF-8" },
    });

  const claimed = String(request.headers.get("x-cfpress-site") ?? "").trim();
  if (!claimed) {
    return json({ error: "site_not_specified", hint: "x-cfpress-site header is required" }, 400);
  }
  const known = await listSites(env);
  if (!known.some((s) => s.id === claimed)) {
    return json({ error: "unknown_site", site: claimed }, 404);
  }
  const siteId = claimed;

  // The theme header is a claim too, and a weaker one than the site: without
  // this check a caller could name *any installed* theme and inherit its
  // capabilities. A sandbox may only speak for the theme actually serving this
  // site — `themeCapabilities()` looks up capabilities by name alone, so the
  // binding has to happen here.
  const active = await activeTheme(env, siteId).catch(() => null);
  if (!active?.name || active.name !== themeName) {
    return json(
      { error: "theme_not_active", theme: themeName, site: siteId },
      403
    );
  }

  const caps = await themeCapabilities(env, themeName);
  const allow = (cap: ThemeApiCapability) => caps.includes(cap);

  const deny = () => json({ error: "capability_not_granted", theme: themeName }, 403);

  try {
    // -- site ------------------------------------------------------------
    if (rest === "site") {
      if (!allow("site.read")) return deny();
      const row = await env.DB.prepare(
        "SELECT key, value FROM settings WHERE site_id=? AND key IN ('site.title','site.description')"
      )
        .bind(siteId)
        .all();
      const map = Object.fromEntries(((row.results as any[]) ?? []).map((r) => [r.key, r.value]));
      return json({
        siteId,
        title: map["site.title"] ?? "CFPress",
        description: map["site.description"] ?? "",
      });
    }

    // -- locales ---------------------------------------------------------
    //
    // The site's *enabled* locales, not the platform dictionary. A theme
    // rendering a language switcher must only offer languages this site
    // actually serves; the dictionary is what the machine knows, which is a
    // different question (§2.2).
    if (rest === "locales") {
      if (!allow("locales.read")) return deny();
      const items = await siteLocales(env, siteId);
      return json({
        items: items.map((l) => ({
          code: l.code,
          name: l.native_name ?? l.name ?? l.code,
          is_default: l.is_default,
          direction: l.direction,
        })),
        default: await siteDefaultLocale(env, siteId),
      });
    }

    // -- menu ------------------------------------------------------------
    if (rest === "menu") {
      if (!allow("menu.read")) return deny();
      const locale = url.searchParams.get("locale") || (await siteDefaultLocale(env, siteId));
      const m = await env.DB.prepare("SELECT id FROM menus WHERE location='header' AND site_id=? LIMIT 1").bind(siteId).first<any>().catch(() => null);
      if (!m) return json({ items: [] });
      const items = await env.DB.prepare(
        "SELECT title, url, target FROM menu_items WHERE menu_id=? AND site_id=? AND (locale IS NULL OR locale=?) ORDER BY sort_order, id"
      )
        .bind(m.id, siteId, locale)
        .all();
      return json({ items: items.results ?? [] });
    }

    // -- content listing -------------------------------------------------
    if (rest === "content") {
      if (!allow("content.read")) return deny();
      const type = url.searchParams.get("type") ?? "post";
      const locale = url.searchParams.get("locale") || (await siteDefaultLocale(env, siteId));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
      const rows = await env.DB.prepare(
        `SELECT p.id, p.slug, p.type, p.created_at,
                t.locale, t.title, t.excerpt
         FROM posts p JOIN post_translations t ON t.post_id = p.id
         WHERE p.site_id = ? AND p.type = ? AND p.status = 'published' AND t.locale = ?
         ORDER BY p.created_at DESC LIMIT ?`
      )
        .bind(siteId, type, locale, limit)
        .all();
      return json({ items: rows.results ?? [] });
    }

    // -- single content --------------------------------------------------
    const single = rest.match(/^content\/([^/]+)$/);
    if (single) {
      if (!allow("content.read")) return deny();
      const slug = decodeURIComponent(single[1]);
      const locale = url.searchParams.get("locale") || (await siteDefaultLocale(env, siteId));
      const type = url.searchParams.get("type") ?? "post";
      // Note: `meta` lives in `post_meta`, not on `posts` — selecting it from
      // the posts table is a SQL error, so it is fetched separately.
      const row = await env.DB.prepare(
        `SELECT p.id, p.slug AS slug_default, COALESCE(t.slug, p.slug) AS slug, p.type, p.created_at, p.updated_at,
                t.locale, t.title, t.excerpt, t.content
         FROM posts p JOIN post_translations t ON t.post_id = p.id
         WHERE p.site_id = ? AND p.type = ? AND COALESCE(t.slug, p.slug) = ? AND t.locale = ? AND p.status = 'published'
         LIMIT 1`
      )
        .bind(siteId, type, slug, locale)
        .first<any>();
      if (!row) return json({ error: "not_found" }, 404);
      row.meta = await postMetaMap(env, row.id, locale, await siteDefaultLocale(env, siteId));
      return json({ item: row });
    }

    // -- theme-owned tables (§2.5.3) -------------------------------------
    //
    // `host.table('product')` on the sandbox side lands here. The theme names a
    // *logical* table; the platform resolves it to the generated name and
    // scopes it to this site and this theme. A theme asking for a table it did
    // not declare gets 404, not another theme's data.
    const tableList0 = rest.match(/^table\/([a-z][a-z0-9_]{0,63})$/);
    if (tableList0) {
      const def = await resolveThemeTable(env, siteId, themeName, tableList0[1]);
      if (!def) return json({ error: "unknown_table", table: tableList0[1] }, 404);
      const locale = url.searchParams.get("locale") || (await siteDefaultLocale(env, siteId));
      if (request.method === "GET") {
        if (!allow("table.read")) return deny();
        const items = await tableList(env, def, {
          locale,
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
          status: url.searchParams.get("status"),
        });
        return json({ items, locale, multilingual: !!def.i18n_table });
      }
      if (request.method === "POST") {
        if (!allow("table.write")) return deny();
        let body: any;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        try {
          const row = await tableSave(env, def, body ?? {}, locale);
          return json({ item: row, locale }, 201);
        } catch (e) {
          return json({ error: "save_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }, 400);
        }
      }
    }
    const tableRow = rest.match(/^table\/([a-z][a-z0-9_]{0,63})\/([^/]+)$/);
    if (tableRow) {
      if (!allow("table.read")) return deny();
      const def = await resolveThemeTable(env, siteId, themeName, tableRow[1]);
      if (!def) return json({ error: "unknown_table", table: tableRow[1] }, 404);
      const locale = url.searchParams.get("locale") || (await siteDefaultLocale(env, siteId));
      const row = await tableBySlug(env, def, decodeURIComponent(tableRow[2]), locale);
      if (!row) return json({ error: "not_found" }, 404);
      return json({ item: row, locale });
    }

    return json({ error: "unknown_endpoint", path: rest }, 404);
  } catch (e) {
    return json({ error: "theme_api_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
}

/** Custom fields for a post, resolved for the requesting language. */
async function postMetaMap(env: Env, postId: string, locale: string, fallback: string): Promise<Record<string, string>> {
  try {
    const r = await env.DB.prepare("SELECT post_id, meta_key, locale, meta_value FROM post_meta WHERE post_id=?").bind(postId).all();
    return resolveMetaByPost((r.results as any[]) ?? [], locale, fallback).get(postId) ?? {};
  } catch {
    return {}; // table absent on a pre-0008 database
  }
}

/** Read a theme's declared the-API capabilities from its install manifest. */
export async function themeCapabilities(env: Env, themeName: string): Promise<string[]> {
  if (!themeName) return [];
  try {
    const row = await env.DB.prepare("SELECT manifest FROM theme_installs WHERE name=? LIMIT 1").bind(themeName).first<any>();
    if (!row) return [];
    const manifest = JSON.parse(String(row.manifest ?? "{}"));
    const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [];
    // Only capabilities we actually expose are honoured.
    return declared.filter((c: string) => (THEME_API_CAPABILITIES as readonly string[]).includes(c));
  } catch {
    return [];
  }
}

/** Is this site's active theme a worker-runtime theme? */
export async function activeThemeIsWorker(env: Env, siteId: string): Promise<boolean> {
  try {
    // Resolve through `activeTheme` so this agrees with the renderer. Reading
    // the setting directly would disagree whenever the setting is absent and
    // `activeTheme` had to pick an installed theme instead.
    const theme = await activeTheme(env, siteId);
    const row = await env.DB.prepare("SELECT manifest FROM theme_installs WHERE name=? LIMIT 1").bind(theme.name).first<any>();
    if (!row) return false;
    const manifest = JSON.parse(String(row.manifest ?? "{}"));
    return manifest.runtime === "worker";
  } catch {
    return false;
  }
}
