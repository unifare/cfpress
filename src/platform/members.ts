/**
 * Front-end members — the *other* identity, kept apart from the admin's on
 * purpose (§2.1 of `docs/AUTH-ISOLATION-PLAN.md`).
 *
 * ## Two logins, nothing shared
 *
 * | | admin (staff) | member (front end) |
 * |---|---|---|
 * | identity | `site_users` (install-wide) | `members` (**per site**) |
 * | sessions | `admin_sessions` | `member_sessions` |
 * | cookie   | `cfpress_admin` (`Path=<admin prefix>`) | `cfpress_member` (`Path=/`) |
 * | endpoint | `/{admin.path}/api/v1/…` | `/api/v1/front/…` |
 * | role     | `site_users_sites.role` (batch E) | `members.role` |
 *
 * The isolation is **structural, not policy**: the two session tables are
 * different tables, so a member session id is not a valid admin session id —
 * there is nothing to "also check". `currentMember` reads `member_sessions`
 * and `currentUser` reads `admin_sessions`; neither can see the other's rows
 * because neither queries the other's table.
 *
 * The two cookies must stay distinguishable in a raw `Cookie:` header, which
 * is why the names are spelled out rather than derived: an admin and a member
 * signed in on the same browser send both, and a generic name is how the two
 * get conflated by the next reader (the same reasoning as `cfpress_admin`'s
 * own name — see the comment on `SESSION_COOKIE` in `auth.ts`).
 *
 * ## A member belongs to one site
 *
 * Every function here takes a `siteId` and puts it in the WHERE clause. There
 * is deliberately no "member by id" lookup that skips the site: an id from
 * site A must not resolve on site B, and the only way to guarantee that is for
 * the site to be part of the key, not a filter a caller may forget (rule 6).
 */

import { Env } from "../shared/types";
import { cookieValue, hashPassword, randomId, verifyPassword } from "../shared/crypto";
import { getSetting } from "./settings";

/**
 * The front-end member session cookie.
 *
 * `Path=/` is correct *here* — unlike the admin cookie — because a member
 * session is meant to ride along on every page of the site (the header shows
 * "signed in as…", the comment form knows who you are). The admin cookie is
 * narrowed to its prefix precisely so it does *not* do this.
 */
const MEMBER_COOKIE = "cfpress_member";
const SESSION_TTL = 60 * 60 * 24 * 30;

/** The signed-in member, as the front end and the API see them. */
export interface MemberUser {
  id: string;
  siteId: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  status: string;
}

/** Public shape — never includes `password_hash`. */
function publicMember(row: any): MemberUser {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    username: String(row.username),
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    role: String(row.role ?? "member"),
    status: String(row.status ?? "active"),
  };
}

/**
 * The same username rule as the admin's — one spelling of "a name that can be
 * typed, remembered and used in a URL-free context". A second regex here is
 * how the front door ends up accepting something the back door rejects.
 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export function validMemberUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/**
 * Is registration open on this site?
 *
 * Off unless the site turned it on (`members.registration`). The default is
 * declared in `SETTING_DEFS`; this reads through the ladder rather than
 * assuming it, so a site that set the key to `"1"` accepts registrations and a
 * site that never touched it does not.
 */
export async function registrationOpen(env: Env, siteId: string): Promise<boolean> {
  const v = await getSetting(env, siteId, "members.registration");
  return String(v ?? "") === "1" || String(v ?? "").toLowerCase() === "true";
}

/**
 * Register a member on **one site**.
 *
 * Returns `{ ok: true, member, cookie }` on success, or a stable error code
 * the caller maps to a response. The username is unique *within the site*
 * (`idx_members_site_username`), so the same name may exist on two sites —
 * which is the point of a per-site identity, not an accident.
 */
export async function registerMember(
  env: Env,
  siteId: string,
  username: string,
  password: string,
  email: string | null,
): Promise<
  | { ok: true; member: MemberUser; cookie: string }
  | { error: "invalid_username" | "weak_password" | "taken" | "closed" }
> {
  if (!(await registrationOpen(env, siteId))) return { error: "closed" };
  const name = String(username ?? "").trim();
  if (!validMemberUsername(name)) return { error: "invalid_username" };
  if (typeof password !== "string" || password.length < 8) return { error: "weak_password" };

  const clash = await env.DB.prepare("SELECT id FROM members WHERE site_id=? AND username=? LIMIT 1")
    .bind(siteId, name)
    .first<any>();
  if (clash) return { error: "taken" };

  const id = "member_" + (await randomId());
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO members (id, site_id, username, email, display_name, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, siteId, name, email ?? null, null, await hashPassword(password), "member", "active", now, now)
    .run();

  const member = await currentMemberById(env, siteId, id);
  const session = await createSession(env, siteId, id);
  return { ok: true, member: member as MemberUser, cookie: session.cookie };
}

/**
 * Sign a member in **on one site**.
 *
 * The lookup is `(site_id, username)`: a member of site A who presents their
 * credentials on site B finds no row, which is the correct answer — the
 * account does not exist there.
 */
export async function loginMember(
  env: Env,
  siteId: string,
  username: string,
  password: string,
): Promise<{ ok: true; member: MemberUser; cookie: string } | { error: "invalid_credentials" }> {
  const row = await env.DB.prepare(
    "SELECT id, site_id, username, email, display_name, password_hash, role, status FROM members WHERE site_id=? AND username=? LIMIT 1"
  )
    .bind(siteId, String(username ?? "").trim())
    .first<any>();
  if (!row || row.status !== "active" || !(await verifyPassword(String(password ?? ""), row.password_hash))) {
    return { error: "invalid_credentials" };
  }
  const session = await createSession(env, siteId, String(row.id));
  return { ok: true, member: publicMember(row), cookie: session.cookie };
}

/** Drop the caller's member session. Idempotent: no cookie is not an error. */
export async function logoutMember(env: Env, request: Request): Promise<{ cookie: string }> {
  const sid = cookieValue(request, MEMBER_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM member_sessions WHERE id=?").bind(sid).run();
  return { cookie: clearCookie() };
}

/**
 * The signed-in member for **this site**, or `null`.
 *
 * The join carries `site_id` in both halves, so a session minted on site A
 * yields nothing when presented on site B even if the cookie somehow survives
 * a cross-host request (cookies are host-scoped, but a shared parent domain or
 * a proxy would defeat that — this does not rely on it).
 */
export async function currentMember(env: Env, request: Request, siteId: string): Promise<MemberUser | null> {
  const sid = cookieValue(request, MEMBER_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(`
    SELECT m.id, m.site_id, m.username, m.email, m.display_name, m.role, m.status
    FROM member_sessions s JOIN members m ON m.id = s.member_id
    WHERE s.id=? AND s.site_id=? AND m.site_id=? AND s.expires_at > ? AND m.status='active'
    LIMIT 1
  `)
    .bind(sid, siteId, siteId, Math.floor(Date.now() / 1000))
    .first<any>();
  return row ? publicMember(row) : null;
}

/**
 * The member gate for `/api/v1/front/…`.
 *
 * Returns the member, or a **401** `Response`. The caller returns it as-is.
 * A 401 (not a 403) is the whole point: presenting an *admin* cookie here must
 * not be treated as "signed in but not allowed" — from the front end's point
 * of view nobody is signed in, because there is no member session.
 */
export async function requireMember(env: Env, request: Request, siteId: string): Promise<MemberUser | Response> {
  const member = await currentMember(env, request, siteId);
  if (!member) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return member;
}

/** Read one member by id, scoped to the site. */
async function currentMemberById(env: Env, siteId: string, id: string): Promise<MemberUser | null> {
  const row = await env.DB.prepare(
    "SELECT id, site_id, username, email, display_name, role, status FROM members WHERE id=? AND site_id=? LIMIT 1"
  )
    .bind(id, siteId)
    .first<any>();
  return row ? publicMember(row) : null;
}

/** Mint a session row and the `Set-Cookie` that carries it. */
async function createSession(env: Env, siteId: string, memberId: string): Promise<{ id: string; cookie: string }> {
  const id = await randomId(24);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO member_sessions (id, site_id, member_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, siteId, memberId, now + SESSION_TTL, now)
    .run();
  return { id, cookie: sessionCookie(id, SESSION_TTL) };
}

function sessionCookie(sid: string, ttl: number): string {
  return `${MEMBER_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${ttl}`;
}

function clearCookie(): string {
  return `${MEMBER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}
