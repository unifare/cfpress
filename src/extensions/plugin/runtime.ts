import { Env } from "../../shared/types";
import { randomId } from "../../shared/crypto";
import { BUNDLED_THEMES, bundledThemeFile } from "../../shared/bundled";
import { isCapability } from "../contract/capabilities";
import type { ChannelMessage, ChannelSendResult } from "../contract/channels";
import { readChannelConfig, deliverNotification } from "./notify";
import { registerPluginMenus, registerPluginTables } from "./menus";

export type ExtensionContext = {
  env: Env;
  request?: Request;
  /**
   * The site this hook is running for.
   *
   * Required whenever `api` is present, because every capability on it is
   * tenant-scoped. It used to be optional and unset at boot, which made a
   * plugin's `readSetting`/`readContent` site-blind: `WHERE key = ?` with no
   * `site_id` returns whichever row the database happens to order first, and
   * `UPDATE settings SET value = ? WHERE key = ?` rewrites **every** site's
   * row with that key. Both are invisible in a single-site install.
   */
  siteId?: string;
  extension?: { type: string; name: string; permissions: string[] };
  /** Capability-gated facade handed to each hook so a plugin cannot touch
   *  anything its manifest did not declare. Bound to the dispatching site. */
  api?: PluginApi;
};
type Hook = (ctx: ExtensionContext, data: any) => Promise<any> | any;
const runtime: { actions: Map<string, Hook[]>; filters: Map<string, Hook[]> } = {
  actions: new Map(),
  filters: new Map(),
};
export function addAction(name: string, fn: Hook) {
  const a = runtime.actions.get(name) || [];
  a.push(fn);
  runtime.actions.set(name, a);
}
export function addFilter(name: string, fn: Hook) {
  const a = runtime.filters.get(name) || [];
  a.push(fn);
  runtime.filters.set(name, a);
}
export async function doAction(name: string, ctx: ExtensionContext, data: any = null) {
  for (const fn of runtime.actions.get(name) || []) await fn(ctx, data);
}
export async function applyFilters(name: string, ctx: ExtensionContext, data: any) {
  let out = data;
  for (const fn of runtime.filters.get(name) || []) out = await fn(ctx, out);
  return out;
}

// ---------------------------------------------------------------------------
// Plugin runtime assembly
// ---------------------------------------------------------------------------
/**
 * Plugins are declarative manifests: they do not ship executable JavaScript
 * (the Workers runtime forbids `eval`/`new Function`, and we would not run
 * arbitrary user code anyway). Instead the manifest names *hooks*, and the
 * host supplies each hook's implementation. This is the whole point of the
 * registry above: it exists so a plugin can claim behaviour without us ever
 * evaluating anything.
 *
 * `HOOK_IMPLS` maps a declared hook name to the host-side behaviour that is
 * attached when the plugin is enabled for a site.
 */

/**
 * The declarable hook list lives in `contract/hooks.ts` — it is a contract
 * (both the validator and this file need it, and they must not see each other).
 * Re-exported here so existing callers keep working.
 */
export { DECLARABLE_HOOKS, type DeclarableHook } from "../contract/hooks";

/** A plugin hook implementation attached by the host. `order` breaks ties. */
type HookImpl = { phase: "action" | "filter"; impl: Hook; order: number };

const HOOK_IMPLS: Record<string, HookImpl> = {
  /**
   * `beforeRender` (action) — fires just before a themed page renders.
   * Nothing is returned; use it for side effects such as cache warming or
   * view counters. Kept cheap: it runs on every front-end request.
   */
  beforeRender: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /**
   * `html` (filter) — last chance to rewrite the rendered document. The
   * canonical use is injecting markup into `<head>`, which is why the SEO
   * plugin declares this hook.
   */
  html: {
    phase: "filter",
    order: 20,
    impl: async (ctx, doc) => {
      if (typeof doc !== "string") return doc;
      const head = await filterHead(ctx as ExtensionContext);
      if (!head) return doc;
      return doc.includes("</head>") ? doc.replace("</head>", `${head}</head>`) : doc;
    },
  },

  /** `head` (filter) — contributes raw markup for `<head>`. */
  head: {
    phase: "filter",
    order: 15,
    impl: async (ctx, doc) => {
      const extra = await filterHead(ctx as ExtensionContext);
      return extra ? `${doc}${extra}` : doc;
    },
  },

  /**
   * `beforeSavePost` (filter) — the payload about to be written. A plugin may
   * normalise fields here. Returning a non-object leaves content untouched.
   */
  beforeSavePost: {
    phase: "filter",
    order: 10,
    impl: async (_ctx, body) => body,
  },

  /** `afterSavePost` (action) — post id + site, for indexing side effects. */
  afterSavePost: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /** `beforeDeletePost` (action) — lets a plugin purge its own derived data. */
  beforeDeletePost: {
    phase: "action",
    order: 10,
    impl: async () => {
      /* host default: intentionally a no-op */
    },
  },

  /** `shortcode` (filter) — receives `{name, attrs, body}`, returns markup. */
  shortcode: {
    phase: "filter",
    order: 10,
    impl: async (_ctx, payload) => payload,
  },
};

interface RuntimePlugin {
  name: string;
  title: string;
  manifest: any;
  permissions: string[];
  hooks: string[];
}

// `booted` memoises the assembly promise per `env`. A WeakMap cannot be
// cleared, so the reset path swaps in a fresh one instead.
let booted = new WeakMap<Env, Promise<RuntimePlugin[]>>();

/** Per-request memo of the enabled plugin set, keyed by env. */
let enabledCache: { env: Env; at: number; rows: RuntimePlugin[] } | null = null;
const ENABLED_TTL_MS = 5_000;

async function loadEnabledPlugins(env: Env): Promise<RuntimePlugin[]> {
  if (enabledCache && enabledCache.env === env && Date.now() - enabledCache.at < ENABLED_TTL_MS) {
    return enabledCache.rows;
  }
  let rows: any[] = [];
  try {
    const r = await env.DB.prepare("SELECT name,title,manifest FROM plugin_installs WHERE enabled=1 ORDER BY title").all();
    rows = (r.results as any[]) ?? [];
  } catch {
    rows = []; // table missing on a very old database
  }
  const out: RuntimePlugin[] = rows.map((r) => {
    let manifest: any = {};
    try {
      manifest = JSON.parse(String(r.manifest ?? "{}"));
    } catch {
      manifest = {};
    }
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
    // Only hooks we actually implement are honoured; unknown names are ignored
    // rather than silently becoming no-ops that look wired up.
    const hooks = Array.isArray(manifest.hooks)
      ? manifest.hooks.map(String).filter((h: string) => h in HOOK_IMPLS)
      : [];
    return { name: String(r.name), title: String(r.title ?? r.name), manifest, permissions, hooks };
  });

  // Converge the menu registry and the table registry with the enabled set.
  // Hooks, menus and tables all come from "which plugins are enabled and what
  // did each declare", so they are materialised at the same moment — a plugin
  // whose `adminMenus` (or `tables[]`) never made it into the database would
  // otherwise be a plugin whose hooks work while its sidebar entry silently
  // never appears, or whose admin page reads a table that does not exist.
  for (const plugin of out) {
    try {
      await registerPluginMenus(env, plugin.name, plugin.manifest?.adminMenus);
    } catch {
      // A menu that cannot be written must not take the request down with it.
    }
    try {
      await registerPluginTables(env, plugin.name, plugin.manifest ?? {});
    } catch {
      // Same reasoning: a table that cannot be created must not 500 the request
      // that happened to boot the runtime. The next boot retries.
    }
  }

  enabledCache = { env, at: Date.now(), rows: out };
  return out;
}

/**
 * Register the host implementations for every enabled plugin. Idempotent per
 * `env`; concurrent callers share one promise so we do not double-register.
 *
 * ## The `api` is built per dispatch, not per boot
 *
 * `pluginApi` binds a `siteId`, and the site is a property of the *request* —
 * one isolate serves several sites, and boot happens before any request. So the
 * facade cannot be constructed here. This function registers a hook that
 * receives the dispatch-time context and builds the facade from it.
 *
 * The previous version spread `{ ...c, ...ctx }`, which let the boot-time `ctx`
 * (no `siteId`) overwrite the dispatch-time one (with `siteId`). Object spread
 * order decided whether plugins were tenant-safe, and it decided "no".
 */
export async function bootPluginRuntime(env: Env): Promise<RuntimePlugin[]> {
  const existing = booted.get(env);
  if (existing) return existing;
  const p = loadEnabledPlugins(env).then((plugins) => {
    for (const plugin of plugins) {
      const identity = { type: "plugin", name: plugin.name, permissions: plugin.permissions };
      for (const hook of plugin.hooks) {
        const spec = HOOK_IMPLS[hook];
        if (!spec) continue;
        const bound: Hook = (c, data) =>
          spec.impl(
            {
              // Dispatch-time context wins: it carries the request's siteId.
              ...c,
              env: c?.env ?? env,
              extension: identity,
              api: pluginApi(
                env, "plugin", plugin.name, plugin.permissions, requireSiteId(c),
                // The facade needs the declared channels so `notify()` can
                // refuse one the plugin never asked for (the manifest is the
                // authority), and so it reads only the settings the channel's
                // configSchema declared.
                Array.isArray(plugin.manifest?.channels) ? plugin.manifest.channels : []
              ),
            },
            data
          );
        if (spec.phase === "filter") addFilter(hook, bound);
        else addAction(hook, bound);
      }
    }
    return plugins;
  });
  booted.set(env, p);
  return p;
}

/**
 * The dispatching site, or a hard error.
 *
 * Every dispatch point in `index.ts` resolves a site before firing hooks
 * (`requestSiteId`). If one ever stops doing so, a plugin would silently read
 * the wrong tenant's data — so this fails loudly instead of defaulting, which
 * is the policy §10 rule 6 sets for every other data-access path.
 */
function requireSiteId(ctx: ExtensionContext): string {
  const siteId = ctx?.siteId;
  if (!siteId) throw new Error("plugin hook dispatched without a siteId (§10 rule 6)");
  return siteId;
}

/** Drop memoised state. Used by tests and after plugin enable/disable. */
export function resetPluginRuntime() {
  runtime.actions.clear();
  runtime.filters.clear();
  enabledCache = null;
  // Must be a *new* WeakMap: reusing the old one would hand back the stale
  // assembly promise and the enable/disable change would not take effect.
  booted = new WeakMap<Env, Promise<RuntimePlugin[]>>();
}

/** Enabled plugins and the hooks each one actually got wired to. */
export async function pluginRuntimeStatus(env: Env): Promise<any[]> {
  const plugins = await bootPluginRuntime(env);
  return plugins.map((p) => ({
    name: p.name,
    title: p.title,
    hooks: p.hooks,
    permissions: p.permissions,
  }));
}

// ---------------------------------------------------------------------------
// Host hook behaviours that need database access
// ---------------------------------------------------------------------------

/**
 * Build the `<head>` contribution from enabled plugins that expose SEO-ish
 * settings. Currently derived from `plugin_setting_defs`/`plugin_settings` so
 * the bundled SEO plugin's `title_template` and `default_description` become
 * real output instead of inert configuration rows.
 */
async function filterHead(ctx: ExtensionContext): Promise<string> {
  const name = ctx.extension?.name;
  if (!name) return "";
  // Only plugins whose manifest declared the `html`/`head` hook reach here.
  const allowed = await capabilityAllowed(ctx.env, "plugin", name, "settings.read").catch(() => false);
  if (!allowed) return "";
  try {
    const defs = await ctx.env.DB.prepare(
      "SELECT key, value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1)"
    )
      .bind(name)
      .all();
    const map = Object.fromEntries(((defs.results as any[]) ?? []).map((r) => [r.key, r.value]));
    const out: string[] = [];
    if (map.default_description) {
      out.push(`<meta name="description" content="${escapeAttr(String(map.default_description))}">`);
    }
    return out.join("");
  } catch {
    return "";
  }
}

function escapeAttr(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function installedPlugins(env: Env) {
  const r = await env.DB.prepare("SELECT * FROM plugin_installs WHERE enabled=1 ORDER BY title").all();
  return r.results as any[];
}
export async function installedThemes(env: Env) {
  const r = await env.DB.prepare("SELECT * FROM theme_installs ORDER BY active DESC,title").all();
  return r.results as any[];
}
export async function seedBundledExtensions(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const plugin = { name: "example", title: "Example Plugin", version: "1.0.0", permissions: ["content.read"], hooks: ["beforeRender"] };
  await env.DB
    .prepare(`INSERT OR IGNORE INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind("plugin_example", "example", plugin.title, plugin.version, 0, JSON.stringify(plugin), now, now)
    .run()
    .catch(() => {});
  // Bundled themes are registered from their real `theme.json`, read out of
  // the worker assets — the very copy the front end renders from. The old
  // hard-coded manifest drifted silently from what actually renders: the
  // registry said "CFPress Default" while every page said 墨白 MOBAI, and the
  // templates[] list activation applied came from that fiction too.
  // Upsert (not INSERT OR IGNORE) because nothing else may write these rows:
  // `uploadExtension` refuses bundled names, so this stays the authority.
  for (const name of BUNDLED_THEMES) {
    let manifest: any = null;
    try {
      const raw = await bundledThemeFile(env, name, "theme.json");
      if (raw) manifest = JSON.parse(raw);
    } catch {
      manifest = null;
    }
    if (!manifest?.name) continue;
    await env.DB
      .prepare(`INSERT INTO theme_installs(id,name,title,version,active,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`)
      .bind(`theme_${name}`, name, String(manifest.title ?? name), String(manifest.version ?? "1.0.0"), name === "default" ? 1 : 0, JSON.stringify(manifest), now, now)
      .run()
      .catch(() => {});
  }
}
export async function shortcode(env: Env, name: string, attrs: any, content: string, siteId?: string) {
  const row = await env.DB.prepare("SELECT enabled,config FROM shortcodes WHERE name=?").bind(name).first<any>();
  // A registered `shortcode` filter runs even when the row is absent, so a
  // plugin can own a shortcode without a database row of its own.
  const filtered = await applyFilters("shortcode", { env, siteId }, { name, attrs, body: content, enabled: !!row?.enabled });
  if (filtered && typeof filtered === "object" && "body" in filtered && filtered.body !== content) {
    return String((filtered as any).body);
  }
  if (!row?.enabled) return content;
  if (name === "site_title") {
    // Was `SELECT value FROM settings WHERE key='site.title'` with no site
    // filter — every site rendered whichever title the database returned first.
    if (!siteId) return "CFPress";
    const s = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key='site.title'").bind(siteId).first<any>();
    return s?.value || "CFPress";
  }
  if (name === "year") return String(new Date().getFullYear());
  return content;
}
export async function renderShortcodes(env: Env, html: string, siteId?: string) {
  let out = html;
  const re = /\[([a-zA-Z0-9_-]+)(?:\s+([^\]]+))?\](.*?)\[\/\1\]|\[([a-zA-Z0-9_-]+)\]/gs;
  for (const m of [...out.matchAll(re)]) {
    const name = m[1] || m[4],
      body = m[3] || "";
    out = out.replace(m[0], await shortcode(env, name, {}, body, siteId));
  }
  return out;
}
export async function capabilityList(env: Env, type: string, name: string) {
  const rows = await env.DB.prepare("SELECT capability,enabled FROM extension_capabilities WHERE extension_type=? AND extension_name=? ORDER BY capability").bind(type, name).all();
  return rows.results as any[];
}
export async function capabilityAllowed(env: Env, type: string, name: string, capability: string) {
  if (!isCapability(capability)) return false;
  const row = await env.DB.prepare("SELECT enabled FROM extension_capabilities WHERE extension_type=? AND extension_name=? AND capability=?").bind(type, name, capability).first<any>();
  return row?.enabled === 1;
}

/**
 * Capability-gated API surface handed to every plugin hook as `ctx.api`.
 *
 * Every method is **tenant-scoped**. `siteId` is a required constructor
 * argument rather than something the plugin passes per call, so a plugin cannot
 * forget it — the class of bug this replaced was three separate site-blind
 * queries, each of which looked correct in isolation.
 */
export interface PluginApi {
  identity: { type: string; name: string };
  /** The site this facade is bound to. Exposed so a plugin can key its own data. */
  siteId: string;
  has(cap: string): boolean;
  readSetting(key: string): Promise<string | null>;
  writeSetting(key: string, value: string): Promise<void>;
  readContent(id: string): Promise<any>;
  readPluginSetting(key: string): Promise<string | null>;
  log(message: string): Promise<void>;
  /**
   * Deliver a notification through a channel this plugin declared.
   *
   * The host performs the send — the plugin names the channel and supplies the
   * message; see `contract/channels.ts` for why it cannot be the other way
   * round. The channel's configuration is read from this plugin's settings, so
   * a plugin never handles its own credentials.
   *
   * Never throws: a delivery failure is a value. The caller is typically a hook
   * on a request path, where an exception would turn "the endpoint was down"
   * into a failed page render.
   */
  notify(channel: string, message: ChannelMessage): Promise<ChannelSendResult>;
}

export function pluginApi(
  env: Env,
  type: string,
  name: string,
  permissions: string[],
  siteId: string,
  /**
   * The channels this plugin declared. Defaulted to `[]` rather than required,
   * because every existing caller constructs a facade for something that has no
   * channels, and the correct behaviour there is "no channel is declared" —
   * which is what an empty list produces.
   */
  channels: any[] = []
): PluginApi {
  if (!siteId) {
    // Unreachable through the dispatcher (it supplies the request's site), and
    // deliberately fatal rather than defaulted: a default here is exactly how
    // the original site-blind queries stayed hidden for two batches.
    throw new Error("pluginApi requires a siteId (§10 rule 6: no defaults)");
  }
  const allow = (cap: string) => permissions.includes(cap);
  const deny = (cap: string): never => {
    throw new Error(`Capability denied: ${cap}`);
  };
  return {
    identity: { type, name },
    siteId,
    has: (cap: string) => allow(cap),
    async readSetting(key: string) {
      if (!allow("settings.read")) deny("settings.read");
      const row = await env.DB
        .prepare("SELECT value FROM settings WHERE site_id=? AND key=?")
        .bind(siteId, key)
        .first<any>();
      return row?.value ?? null;
    },
    async writeSetting(key: string, value: string) {
      if (!allow("settings.write")) deny("settings.write");
      // Upsert rather than blanket UPDATE. The previous form
      // (`UPDATE settings SET value=? WHERE key=?`) rewrote the row for every
      // site in the install that shared the key.
      await env.DB
        .prepare(
          "INSERT INTO settings(id,site_id,key,value,autoload) VALUES(?,?,?,?,1) " +
          "ON CONFLICT(site_id,key) DO UPDATE SET value=excluded.value"
        )
        .bind(`set_${siteId}_${key}`.replace(/[^A-Za-z0-9_]/g, "_"), siteId, key, value)
        .run();
    },
    async readContent(id: string) {
      if (!allow("content.read")) deny("content.read");
      // Scoped by site: without it a plugin could read another tenant's
      // unpublished content by guessing an id.
      return await env.DB
        .prepare("SELECT * FROM posts WHERE id=? AND site_id=?")
        .bind(id, siteId)
        .first();
    },
    async readPluginSetting(key: string) {
      if (!allow("settings.read")) deny("settings.read");
      const row = await env.DB
        .prepare("SELECT value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1) AND key=?")
        .bind(name, key)
        .first<any>();
      return row?.value ?? null;
    },
    async log(message: string) {
      try {
        // `admin_activity` is the real audit table; the previous name
        // (`activity_log`) never existed, and the swallowed error below meant
        // every plugin log line was silently discarded.
        await env.DB
          .prepare("INSERT INTO admin_activity(id,user_id,action,entity_type,entity_id,meta,created_at) VALUES(?,?,?,?,?,?,?)")
          .bind(await randomId(), null, "plugin_log", "plugin", name, JSON.stringify({ site: siteId, message: String(message).slice(0, 500) }), Math.floor(Date.now() / 1000))
          .run();
      } catch {
        /* logging must never break a request */
      }
    },
    async notify(channel: string, message: ChannelMessage): Promise<ChannelSendResult> {
      // Declaring a channel is what grants the right to use it: the manifest is
      // the authority, so a plugin cannot reach a channel it never asked for
      // even if it guesses the code. The declared `configSchema` also decides
      // which stored settings are read — an undeclared setting is not config.
      const declared = channels.find((c) => String(c?.code) === channel);
      if (!declared) {
        return { ok: false, error: `plugin "${name}" does not declare channel "${channel}"` };
      }
      const keys = (Array.isArray(declared.configSchema) ? declared.configSchema : [])
        .map((f: any) => String(f?.key ?? ""))
        .filter(Boolean);
      const config = await readChannelConfig(env, name, channel, keys);
      return await deliverNotification(env, siteId, name, channel, config, {
        title: String(message?.title ?? ""),
        content: String(message?.content ?? ""),
        payload: (message?.payload && typeof message.payload === "object") ? message.payload : {},
        dedupKey: message?.dedupKey ? String(message.dedupKey) : undefined,
      });
    },
  };
}

/** Kept as an alias so earlier call sites keep compiling. */
export const capabilityFacade = pluginApi;
