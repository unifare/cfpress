/**
 * Media access policy — the ONE place that decides who may read a media file.
 *
 * ## Why this is a module and not two `if` statements
 *
 * A media file is reachable through two different doors that must agree:
 *
 *   - the front-end read path (`/media/<key>`, in `src/index.ts`), which serves
 *     the bytes; and
 *   - the admin API (`/api/v1/media`, in `src/api.ts`), which lists and edits
 *     the rows.
 *
 * Before this module existed they disagreed by construction: the read path was
 * matched *above* site resolution and served any key out of R2 with no owner
 * check at all, while the list endpoint was already scoped by `site_id`. So a
 * key from site A resolved on site B's host, and for an anonymous visitor. That
 * is the tenant axis of the media table unenforced on its only public door.
 *
 * ## The two axes
 *
 *   - **tenant** — already stored (`media_files.site_id`, migration 0009), but
 *     only enforced on the read path by checking that the object key's
 *     `uploads/{siteId}/` segment matches the site the request resolved to.
 *     The key is the authority here, not a lookup: the segment is written by
 *     `mediaUpload` and never by a client.
 *   - **owner** — `media_files.uploaded_by` (migration 0018). `isolation`
 *     decides how hard it bites.
 *
 * ## Precedence and failure policy
 *
 * One `settings` row per site, `cfpress.media`, holding a JSON object. Anything
 * missing, unreadable or unrecognised resolves to `MEDIA_POLICY_DEFAULTS`,
 * which is the *closed* direction: owner isolation and a required session. A
 * corrupt row must not silently publish a private library.
 *
 * ⚠️ `requireSession` defaults to **on**, and it is the operator's call, not a
 * bug: with it on, an anonymous visitor — which is every reader of the public
 * site — gets 404 for every `/media/<key>`, including the images a published
 * post references. Turning it off (Media screen, or the settings row) keeps the
 * site-ownership check and the owner axis. If the front end ever shows broken
 * images, this switch is the first thing to look at.
 */

import { truthy } from "../shared/features";

/** The single `settings` key holding the per-site media policy. */
export const MEDIA_POLICY_SETTINGS_KEY = "cfpress.media";

/**
 * `"owner"` — a signed-in user sees only the files they uploaded, and an
 *             anonymous request can never establish ownership, so it is denied.
 * `"site"`  — every signed-in user of the site sees the whole site library.
 */
export type MediaIsolation = "owner" | "site";

export interface MediaPolicy {
  isolation: MediaIsolation;
  /** Whether `/media/<key>` demands a signed-in user. */
  requireSession: boolean;
}

/**
 * What an unset (or unreadable) policy means.
 *
 * Both values are the restrictive choice, matching the platform's other
 * "cannot be resolved = closed" rule (`shared/features.ts`). The consequence
 * for `requireSession` is spelled out in this file's header: it 404s media for
 * anonymous readers, so a site whose front end shows images must either leave
 * this on deliberately or turn it off deliberately.
 */
export const MEDIA_POLICY_DEFAULTS: MediaPolicy = { isolation: "owner", requireSession: true };

/** The slice of `Env` needed here. Structural, so test suites can pass a stub. */
export interface MediaPolicyEnv {
  DB: D1Database;
}

/**
 * Read the site's media policy.
 *
 * Unknown `isolation` values fall to the default rather than being accepted —
 * a typo must not widen access. `require_session` accepts the spellings
 * `truthy()` knows, the same set every other boolean setting accepts.
 */
export async function readMediaPolicy(env: MediaPolicyEnv, siteId: string): Promise<MediaPolicy> {
  const raw = await readPolicyRow(env, siteId);
  const isolation: MediaIsolation =
    raw?.isolation === "site" ? "site" : raw?.isolation === "owner" ? "owner" : MEDIA_POLICY_DEFAULTS.isolation;
  const requireSession = raw && "require_session" in raw ? truthy(raw.require_session) : MEDIA_POLICY_DEFAULTS.requireSession;
  return { isolation, requireSession };
}

/** Parse the site's `cfpress.media` row. Unreadable or corrupt reads as
 *  "no site-level opinion", so the declared defaults still apply. */
async function readPolicyRow(env: MediaPolicyEnv, siteId: string): Promise<Record<string, unknown> | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?")
      .bind(siteId, MEDIA_POLICY_SETTINGS_KEY)
      .first<{ value: string | null }>();
    if (row?.value == null) return null;
    const parsed = JSON.parse(String(row.value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * Does this object key belong to this site?
 *
 * `mediaUpload` writes `uploads/{siteId}/{date}/{id}-{name}`, so the second
 * segment *is* the tenant. Checking the key rather than trusting the caller is
 * what stops a key minted for one site from being served on another site's
 * host — the defect this module exists to close.
 */
export function mediaKeyBelongsToSite(key: string, siteId: string): boolean {
  return typeof key === "string" && siteId.length > 0 && key.startsWith(`uploads/${siteId}/`);
}

/**
 * Why a read was refused. Returned rather than collapsed into a boolean so the
 * test suite can assert *which* gate fired — an assertion that only checks
 * "404" passes when any one of three gates is the one still standing, which is
 * exactly how a deleted guard hides (see `docs/ARCHITECTURE.md` §12).
 */
export type MediaDenyReason = "site" | "session" | "owner" | "missing";

/**
 * Decide whether one `/media/<key>` request may be served.
 *
 * Order is fixed so the answer is deterministic: tenant, then session, then
 * owner. `userId` is `null` for an anonymous request.
 *
 * `policy` is optional only so a caller that has already read it — the read
 * path needs it to know whether a session lookup is worth doing — does not pay
 * for the same settings row twice. Omitting it reads it here, so there is still
 * exactly one definition of what the policy means.
 *
 * A key with no `media_files` row is refused under owner isolation: ownership
 * cannot be established for an object nobody recorded, and serving it would be
 * an unauthenticated R2 passthrough again. (Under `isolation: "site"` the row
 * is not consulted at all, so an orphan object stays readable — that mode
 * asserts nothing about ownership.)
 */
export async function mediaReadDecision(
  env: MediaPolicyEnv,
  siteId: string,
  key: string,
  userId: string | null,
  policy?: MediaPolicy
): Promise<{ allow: true } | { allow: false; reason: MediaDenyReason }> {
  if (!mediaKeyBelongsToSite(key, siteId)) return { allow: false, reason: "site" };

  const p = policy ?? (await readMediaPolicy(env, siteId));
  if (p.requireSession && !userId) return { allow: false, reason: "session" };
  if (p.isolation !== "owner") return { allow: true };

  let row: { uploaded_by: string | null } | null = null;
  try {
    row = await env.DB.prepare("SELECT uploaded_by FROM media_files WHERE site_id=? AND object_key=? LIMIT 1")
      .bind(siteId, key)
      .first<{ uploaded_by: string | null }>();
  } catch {
    // An unreadable registry cannot vouch for ownership, so it does not.
    return { allow: false, reason: "missing" };
  }
  if (!row) return { allow: false, reason: "missing" };
  // `NULL` means "uploaded before ownership existed" (migration 0018). Those
  // rows are grandfathered to the whole site: switching isolation on must not
  // make the operator's existing library unreachable, and there is no user to
  // attribute them to that would not be a guess.
  if (row.uploaded_by == null) return { allow: true };
  if (!userId) return { allow: false, reason: "session" };
  if (row.uploaded_by !== userId) return { allow: false, reason: "owner" };
  return { allow: true };
}

/**
 * The `WHERE` fragment implementing the owner axis for list/count queries,
 * with its binds. Empty when isolation is off, so the caller can append it
 * unconditionally and stay correct in both modes.
 *
 * `uploaded_by IS NULL` is the same grandfather clause as above, kept in one
 * place so a list and a read can never disagree about whether a legacy file is
 * visible.
 */
export function mediaOwnerClause(policy: MediaPolicy, userId: string): { sql: string; binds: unknown[] } {
  if (policy.isolation !== "owner") return { sql: "", binds: [] };
  return { sql: " AND (uploaded_by IS NULL OR uploaded_by = ?)", binds: [userId] };
}
