/**
 * The R2-backed object store, read through helpers that tolerate its absence.
 *
 * Every normal install has one: `wrangler.jsonc` declares a `MEDIA` bucket, and
 * the admin's media library, uploaded themes and uploaded plugins all live in
 * it. But nothing on the *render* path requires it. The two-source rule in
 * `extensions/theme/` already reads an uploaded theme from R2 and falls back to
 * the copy that ships in the worker assets, so a site whose content is all in D1
 * and whose theme is one of `BUNDLED_THEMES` renders against an empty bucket —
 * that is the stated intent, and `activeTheme` even probes both sources so a
 * fresh install picks a theme it can really render.
 *
 * What was never handled is the bucket being *absent* rather than empty. Every
 * read was written `env.MEDIA.get(key)`, which throws a `TypeError` when the
 * binding does not exist, so the assets fallback underneath it was unreachable
 * and the whole site answered `1101` on every page — with a stack trace pointing
 * at template loading rather than at the missing binding. `MEDIA` was a hard
 * requirement in practice while the code around it was written as though it were
 * not, which is the worst of both: the config says "R2 required", the comments
 * say "a miss here is normal", and the failure mode says neither.
 *
 * Reading through these helpers makes "no bucket" mean "no uploaded overrides" —
 * a deployment that works. Writes are the genuinely unsupported case and say so
 * instead of failing obscurely: an install with no bucket cannot accept an
 * upload, and a `media_files` row pointing at an object that was never written
 * is worse than a refusal.
 *
 * Lives in `shared/` because both the admin API and the theme runtime read it,
 * and theme code may not import from `platform/`. Every name here carries the
 * `mediaStore` prefix because `api.ts` already has a `mediaDelete` and a
 * `mediaList` — the admin *routes*, which answer HTTP — and a bare `mediaGet`
 * next to those reads as one family when it is two.
 */
import { Env } from "./types";

/** True when this deployment declared an R2 `MEDIA` binding. */
export function hasMediaStore(env: Env): boolean {
  return Boolean(env.MEDIA);
}

/**
 * Operator-facing wording for the bucketless case.
 *
 * Shared rather than written at each refusal so the media library, the theme
 * uploader and the plugin uploader all name the same missing thing — the whole
 * point of the message is that it tells an operator which binding to add.
 */
export const MEDIA_UNAVAILABLE =
  "this deployment has no media storage configured (no R2 `MEDIA` binding)";

/**
 * Read one object.
 *
 * Returns null when the key is absent *and* when there is no bucket at all.
 * Callers with a bundled fallback treat the two the same way — that is the whole
 * point of the helper — and callers without one (the `/media/` route) answer
 * 404, which is also correct: with no bucket there is nothing to serve.
 */
export async function mediaStoreGet(env: Env, key: string): Promise<R2ObjectBody | null> {
  if (!env.MEDIA) return null;
  return await env.MEDIA.get(key);
}

/**
 * Write one object.
 *
 * Throws `MediaStoreUnavailable` when there is no bucket. Callers on the admin
 * API turn that into a `503` naming the missing binding; the point is that an
 * operator who tries to upload on a bucketless deploy gets a sentence rather
 * than an `1101`.
 */
export async function mediaStorePut(
  env: Env,
  key: string,
  value: Parameters<R2Bucket["put"]>[1],
  options?: Parameters<R2Bucket["put"]>[2]
): Promise<void> {
  if (!env.MEDIA) throw new MediaStoreUnavailable();
  await env.MEDIA.put(key, value, options);
}

/**
 * Delete one object. A no-op without a bucket.
 *
 * Silent rather than throwing because every caller is deleting a row next, and
 * on a bucketless deploy there is by definition no object behind it — the row is
 * the only thing that exists, and refusing would leave it orphaned.
 */
export async function mediaStoreDelete(env: Env, key: string): Promise<void> {
  if (!env.MEDIA) return;
  await env.MEDIA.delete(key);
}

/**
 * List objects under a prefix. Empty without a bucket.
 *
 * Same reasoning as `mediaStoreDelete`: the only caller sweeps a theme's
 * uploaded files before removing the registry row, and an empty result is the
 * truthful answer on a deploy that never stored any.
 */
export async function mediaStoreList(env: Env, options?: R2ListOptions): Promise<R2Objects> {
  if (!env.MEDIA) return { objects: [], truncated: false, delimitedPrefixes: [] };
  return await env.MEDIA.list(options);
}

/** Raised by the write helpers when this deployment has no `MEDIA` bucket. */
export class MediaStoreUnavailable extends Error {
  constructor() {
    super(MEDIA_UNAVAILABLE);
    this.name = "MediaStoreUnavailable";
  }
}
