/**
 * Two-level settings: **platform** (install-wide) and **site** (per site).
 *
 * ## Why two levels
 *
 * `settings` is site-scoped (`UNIQUE(site_id, key)`) and `deleteSite()` purges
 * it per site — correct for `site.title`, wrong for the backend's own path: a
 * deleted site must not take the admin's configuration with it, and two sites
 * must not be able to disagree about where the admin lives. `platform_settings`
 * is the platform half; `settings` stays the site half.
 *
 * ## The ladder is defined here, and only here
 *
 * `getSetting()` is the single place that answers "what does this key resolve
 * to for this site", per the key's declared `scope`:
 *
 *   - `platform`  → `platform_settings` → the declared default
 *   - `site`      → `settings(site_id)` → the declared default
 *   - `site` with `inherit` → site value → platform value → declared default
 *
 * There is **no implicit cross-level fallback**: a `site` key never borrows the
 * platform value unless it declares `inherit`. That keeps "which level decided
 * this" a property of the declaration instead of a property of the call site.
 *
 * ## Writing
 *
 * `setSetting()` / `setPlatformSetting()` write per the declaration and
 * **reject an undeclared key** rather than ignoring it. A settings key nothing
 * declares is a key nothing can reason about: nobody knows its scope, its
 * default, or whether it is read at all. `tests/tools/_setting-keys.mjs` makes
 * the same demand of every literal in the source.
 */

import { Env } from "../shared/types";
import { SETTING_DEFS, settingDef, isDeclaredSetting } from "./setting-defs";

export { SETTING_DEFS, settingDef, isDeclaredSetting } from "./setting-defs";

/**
 * Every settings key the platform reads or writes, with its scope.
 *
 * `scope: "platform"` — install-wide; one row for the whole install.
 * `scope: "site"`     — per site; `deleteSite()` purges it (see `onSiteDelete`
 *                       in `contract/schema.ts`).
 * `inherit: true`     — a `site` key whose *default* is the platform value,
 *                       so the platform can set a value every site inherits and
 *                       a site can override it. Only meaningful for site keys.
 * `sensitive: true`   — the admin must not echo this value back into a form
 *                       field after it has been set (it is a secret-shaped
 *                       value); a placeholder is shown instead.
 *
 * ⚠️ The declaration is total on purpose. A key that is read or written and is
 * missing here fails `tests/tools/_setting-keys.mjs`, which is what stops
 * "where does this setting live" from being decided ad hoc at the call site.
 */


/**
 * Read one setting through the ladder.
 *
 * `siteId` is required even for platform-scoped keys: every caller already
 * carries it, and an optional parameter is how `frontend.ts`'s old
 * `locale = "default"` bug was born.
 */
export async function getSetting(
  env: Env,
  siteId: string,
  key: string,
): Promise<string | null> {
  const def = settingDef(key);
  if (!def) throw new Error(`undeclared setting key: ${key}`);

  if (def.scope === "platform") {
    const row = await env.DB.prepare("SELECT value FROM platform_settings WHERE key=?").bind(key).first<any>();
    return row?.value ?? (def.default as string | null);
  }

  const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?").bind(siteId, key).first<any>();
  if (row?.value != null) return row.value;
  // `inherit` lets a platform value be the default for every site, with a
  // per-site override on top. Platform-scoped keys never do this.
  if (def.inherit) {
    const p = await env.DB.prepare("SELECT value FROM platform_settings WHERE key=?").bind(key).first<any>();
    if (p?.value != null) return p.value;
  }
  return (def.default as string | null) ?? null;
}

/**
 * Write one site-scoped setting. Rejects an undeclared key, and refuses to
 * write a `platform`-scoped key here — that would silently make it per site.
 */
export async function setSetting(env: Env, siteId: string, key: string, value: string | null): Promise<void> {
  const def = settingDef(key);
  if (!def) throw new Error(`undeclared setting key: ${key}`);
  if (def.scope !== "site") throw new Error(`setting ${key} is ${def.scope}-scoped, not site-scoped`);

  // Match on the **business key**, never on `id`: seeded rows can carry a NULL
  // id (a migration's bare INSERT), and `UPDATE … WHERE id=NULL` affects zero
  // rows without raising — so the write answers 200 and changes nothing. That
  // is the worst shape a settings API can fail in: the caller sees success,
  // the value is unchanged, and only a read-back notices.
  const r = await env.DB.prepare("UPDATE settings SET value=? WHERE site_id=? AND key=?").bind(value, siteId, key).run();
  if (Number(r?.meta?.changes ?? 0) > 0) return;
  await env.DB.prepare("INSERT INTO settings (id, site_id, key, value, autoload) VALUES (?, ?, ?, ?, 1)")
    .bind(await newId(), siteId, key, value).run();
}

/** Read one platform-scoped setting. */
export async function platformSetting(env: Env, key: string): Promise<string | null> {
  const def = settingDef(key);
  if (!def) throw new Error(`undeclared setting key: ${key}`);
  if (def.scope !== "platform") throw new Error(`setting ${key} is ${def.scope}-scoped, not platform-scoped`);
  const row = await env.DB.prepare("SELECT value FROM platform_settings WHERE key=?").bind(key).first<any>();
  return row?.value ?? (def.default as string | null);
}

/**
 * Write one platform-scoped setting. Rejects an undeclared key, and refuses to
 * write a `site`-scoped key here — that would install it across every site.
 */
export async function setPlatformSetting(env: Env, key: string, value: string | null): Promise<void> {
  const def = settingDef(key);
  if (!def) throw new Error(`undeclared setting key: ${key}`);
  if (def.scope !== "platform") throw new Error(`setting ${key} is ${def.scope}-scoped, not platform-scoped`);

  await env.DB.prepare(
    "INSERT INTO platform_settings(key,value,autoload) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

async function newId(): Promise<string> {
  const data = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * The admin's own path prefix, read from the platform setting `admin.path`.
 *
 * Read **once per request**: `index.ts` drops this memo at the top of every
 * fetch (the same pattern as `resetSiteListMemo`), so a change made in the
 * admin is visible on the next request instead of after an isolate recycle,
 * and a burst of requests still costs one query.
 */
const adminPathMemo = new WeakMap<Env, string>();
export function resetAdminPathMemo(env: Env): void { adminPathMemo.delete(env); }
export async function adminPath(env: Env): Promise<string> {
  const hit = adminPathMemo.get(env);
  if (hit != null) return hit;
  // `admin.path` declares a default, so this always resolves to a string: the
  // router cannot branch on `undefined`.
  const value = (await platformSetting(env, "admin.path")) ?? "/admin";
  adminPathMemo.set(env, value);
  return value;
}
