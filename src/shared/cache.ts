import { Env } from "./types";
import { now } from "./repo";
import { randomId } from "./crypto";
import { featureEnabled } from "./features";

/**
 * Content-cache versioning, per site.
 *
 * The version is a monotonically increasing integer; bumping it invalidates
 * every cached HTML key for that site at once (keys embed the version). Sites
 * are isolated: publishing on `shop` must not drop `default`'s cache.
 *
 * `siteId` is a **required** parameter on every function here. It used to
 * default to `"default"`, which meant a caller that forgot it would silently
 * read and invalidate another site's cache — a bug that is invisible until two
 * sites exist. See `AGENTS.md` rule 7.
 *
 * ── Why the version lives in D1 only ──────────────────────────────────────
 *
 * There used to be a KV mirror here: every bump did an `env.CACHE.put()`, and
 * every read did a `get()` that fell back to D1 and wrote the value back. Both
 * writes are gone, for two independent reasons:
 *
 *  1. **Nothing read it.** `cacheKey()` — the only function that reads the
 *     version on a page render — has no caller, so no cached HTML key is
 *     produced and neither `purgePath()` nor `purgeSite()` is reachable. The
 *     KV mirror was written and never consulted: write amplification with no
 *     reader.
 *  2. **It was not a cache.** The mirror carried `expirationTtl: 86400`, so a
 *     miss fell through to D1 and *wrote back*. The steady state was therefore
 *     **one KV write per site per day forever, per site**, to save one indexed
 *     single-row `SELECT` (measured: `sql_duration_ms: 0.2`, `rows_read: 1`).
 *     A cache whose miss path writes is just a write multiplier.
 *
 * Worse, the invalidation semantics were wrong. `bumpContentCache()` writes
 * **D1 first, KV second**; if the KV `put` throws (KV not provisioned, on a
 * plan that will not accept writes) the whole function rejects, and every one
 * of its callers — `api.ts` post/page/menu saves and `scheduler.ts` — would
 * have surfaced a 500 **after the content had already been written**. The
 * authoritative copy was always D1; the mirror only added a failure mode.
 *
 * ── The mirror is now a switch, not deleted behaviour ─────────────────────
 *
 * `cache_mirror_kv` (defined in `shared/features.ts`) turns the mirror back on.
 * It is read as a **site setting first, a `wrangler.jsonc` `vars` value second,
 * and defaults to off**. Restoring it is a configuration change from the admin,
 * not a code change.
 *
 * Two things keep that from re-introducing the old bugs:
 *
 *  - **The mirror is best-effort.** `bumpContentCache()` writes D1 first and
 *    then mirrors inside a `catch`. A mirror that fails must never fail a save
 *    that has already committed — that was the worst property of the old code,
 *    and it is why the mirror is no longer on the critical path.
 *  - **The switch guards the write, not the read.** `cacheVersion()` still
 *    consults KV first, so a version mirrored while the feature was on does not
 *    become invisible when it is switched off. Turning a cache off should stop
 *    it *writing*, not orphan the entries that already exist.
 *
 * If a real HTML cache is ever wired up, add a KV or Cache API layer *around
 * the rendered page*, where a miss is cheap and a failed write cannot fail the
 * request — not as a mirror of a row this cheap to read.
 *
 * `env.CACHE` stays in `Env` (the binding is still provisioned in
 * `wrangler.jsonc`) so the switch needs no config change to take effect.
 * `tests/suites/multisite.test.mjs` §9 asserts that no KV write happens while
 * the switch is off, so the default cannot silently drift back.
 */
function versionRowId(siteId: string) {
  return `content_version_${siteId}`;
}

/** KV key holding the mirrored content version for a site. */
function versionKvKey(siteId: string) {
  return `cfpress:content-version:${siteId}`;
}

export async function bumpContentCache(env: Env, siteId: string) {
  const id = versionRowId(siteId);
  const row = await env.DB.prepare("SELECT version FROM content_cache_versions WHERE id=?")
    .bind(id)
    .first<any>();
  const version = Number(row?.version || 1) + 1;
  await env.DB.prepare(
    "INSERT INTO content_cache_versions(id,version,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at"
  )
    .bind(id, version, now())
    .run();
  if (await featureEnabled(env, siteId, "cache_mirror_kv")) {
    // Best effort. The D1 write above is authoritative and has committed;
    // a KV failure here must not fail the caller's save.
    try {
      await env.CACHE.put(versionKvKey(siteId), String(version), { expirationTtl: 86400 });
    } catch {
      /* mirror unavailable — D1 remains correct */
    }
  }
  return version;
}

export async function cacheVersion(env: Env, siteId: string) {
  // Read-through only. There is deliberately **no write on the miss path**:
  // that writeback is what made every read a potential KV write, and with the
  // 24h TTL it produced one scheduled write per site per day, forever.
  try {
    const v = await env.CACHE.get(versionKvKey(siteId));
    if (v) return v;
  } catch {
    /* KV unavailable — fall back to the authoritative row */
  }
  const row = await env.DB.prepare("SELECT version FROM content_cache_versions WHERE id=?")
    .bind(versionRowId(siteId))
    .first<any>();
  return String(row?.version || 1);
}

export async function cacheKey(env: Env, path: string, siteId: string) {
  return `cfpress:html:${siteId}:${await cacheVersion(env, siteId)}:${path}`;
}

export async function purgePath(env: Env, path: string, siteId: string) {
  await env.CACHE.delete(`cfpress:html:${siteId}:${await cacheVersion(env, siteId)}:${path}`);
  return randomId();
}

/**
 * Drop every cached HTML page for a site by bumping its version. Cheaper and
 * race-free compared to enumerating keys.
 */
export async function purgeSite(env: Env, siteId: string) {
  return bumpContentCache(env, siteId);
}
