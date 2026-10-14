/**
 * The R2-backed object store: how it is read, and when it is used at all.
 *
 * ## Two independent gates, and why both are needed
 *
 * **The binding may be absent.** `wrangler.jsonc` declares a `MEDIA` bucket, but
 * nothing on the render path requires it: the two-source rule in
 * `extensions/theme/` already reads an uploaded theme from R2 and falls back to
 * the copy that ships in the worker assets, and `activeTheme` probes both
 * sources so a fresh install picks a theme it can really render. What was never
 * handled is the bucket being absent rather than empty — every read was written
 * `env.MEDIA.get(key)`, which throws a `TypeError` when the binding does not
 * exist, so the assets fallback underneath it was unreachable and the whole site
 * answered `1101` on every page. Reading through `mediaStoreGet` makes "no
 * bucket" mean "no uploaded overrides" instead.
 *
 * **The switch may be off.** `media_store_r2` (see `shared/features.ts`) is a
 * per-site feature switch, **off by default**, editable under Tools -> Features
 * with no redeploy. For *storing*, a deployment that declares the bucket and
 * leaves the switch off behaves exactly like one that never had it. That is
 * deliberate: whether an install stores media is the operator's decision, not a
 * consequence of which bindings happen to be in the config file, and it has to
 * be reversible from the admin.
 *
 * The two are reported separately because they need different fixes — "turn the
 * switch on" versus "add the binding and redeploy" — and a single "storage
 * unavailable" would send an operator to the wrong one.
 *
 * ## What the switch gates, and what it deliberately does not
 *
 * It gates **storing** — the media upload and the extension upload, the two
 * places a new object is created. That is the whole of it, and the boundary is
 * chosen so that turning storage off can never hide or break something that is
 * already there:
 *
 *   - **Not the read path.** `/media/...` and the theme runtime keep working.
 *     An extension installed while the switch was on is part of the site's
 *     rendering; blanking it would be a destructive act dressed up as a
 *     setting. The reads are null-safe and cost nothing when the bucket is
 *     empty, and gating them would mean threading a site id into template
 *     loading, which runs several times per page on the render critical path.
 *   - **Not the media library.** `mediaList` reports the state (`storage`) so
 *     the admin can explain itself, but it does not refuse: rows written while
 *     the switch was on are still real rows, and hiding them would leave an
 *     operator unable to delete a file that is still being served.
 *
 * What an operator sees when the switch is off is therefore "new uploads are
 * refused, everything already stored keeps working" — which is what "stop
 * storing media here" should mean.
 *
 * ## Names
 *
 * Every helper carries the `mediaStore` prefix because `api.ts` already has a
 * `mediaDelete` and a `mediaList` — the admin *routes*, which answer HTTP — and
 * a bare `mediaGet` next to those reads as one family when it is two.
 *
 * Lives in `shared/` because both the admin API and the theme runtime read it,
 * and theme code may not import from `platform/`.
 */
import { Env } from "./types";
import { featureEnabled } from "./features";

/** The switch that decides whether this site's storage is wired up. */
export const MEDIA_STORE_SWITCH = "media_store_r2";

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

/** Operator-facing wording for the switched-off case. */
export const MEDIA_DISABLED =
  "media storage is off for this site — enable `media_store_r2` under Tools, Features";

/**
 * Why storing is refused, in two forms: one for an operator to read, one for
 * the admin screen to branch on.
 *
 * `code` exists because the two refusals need **different advice**, and the
 * screen cannot recover that from `reason` without string-matching English
 * prose — which would silently break the first time the wording changed, and
 * would tell a demo deploy (no bucket) to go and flip a switch that cannot
 * help it. The prose stays for the `503` body, where a human reads it directly.
 */
export type MediaStorageBlock =
  | { available: true; code: null; reason: null }
  | { available: false; code: "no_binding" | "switch_off"; reason: string };

/**
 * The storage state for one site.
 *
 * **The binding is checked first, and that order is the point.** A missing
 * bucket is a hard prerequisite: telling an operator to flip a switch when the
 * bucket does not exist sends them round a loop, because they will flip it and
 * be refused again for the same reason. Naming the binding first is also the
 * only wording that is true for the state a fresh install is most likely in
 * when this fires — a deploy that never declared `r2_buckets` at all.
 *
 * The switch is the second question because it is the one an operator can act
 * on from the admin with no redeploy, and by the time we ask it the bucket is
 * known to exist, so "turn it on" is advice that will actually work.
 */
export async function mediaStorageState(env: Env, siteId: string): Promise<MediaStorageBlock> {
  if (!hasMediaStore(env)) return { available: false, code: "no_binding", reason: MEDIA_UNAVAILABLE };
  if (!(await featureEnabled(env, siteId, MEDIA_STORE_SWITCH)))
    return { available: false, code: "switch_off", reason: MEDIA_DISABLED };
  return { available: true, code: null, reason: null };
}

/**
 * The refusal sentence for this site, or null when storing may proceed.
 *
 * A thin projection of `mediaStorageState` so the two cannot disagree about
 * which gate wins — the write paths only need the sentence, the admin screen
 * needs the code, and both read one decision.
 */
export async function mediaStorageBlocked(env: Env, siteId: string): Promise<string | null> {
  return (await mediaStorageState(env, siteId)).reason;
}

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
