import { Env, SessionUser } from "../shared/types";
import { cookieValue, hashPassword, randomId, verifyPassword } from "../shared/crypto";
import { SITE_ROLES, SUPERADMIN_ROLE } from "./permissions";

/**
 * The admin session cookie.
 *
 * Two things about it are load-bearing:
 *
 *   - **The name is `cfpress_admin`, not `cfpress_session`.** When the front-end
 *     member cookie (`cfpress_member`, batch D) arrives, the two must be
 *     distinguishable at a glance and in a `Cookie:` header — a shared generic
 *     name is how "an admin is logged in" and "a member is logged in" get
 *     conflated by the next reader.
 *   - **Its `Path` is the admin prefix, not `/`.** With `Path=/`, every front-end
 *     request carries the admin session — a byte in the headers of pages that
 *     have nothing to do with the admin. Narrowing the path means the cookie is
 *     only ever sent where it is needed, and it is the front-end response the
 *     acceptance check inspects: it must NOT carry `Set-Cookie: cfpress_admin`.
 *
 * `Path` is per-request (the prefix is configurable), so it is passed in rather
 * than read from a constant here — `platform/` does not reach for a settings
 * read on every cookie write.
 */
const SESSION_COOKIE = "cfpress_admin";
const SESSION_TTL = 60 * 60 * 24 * 14;

/**
 * One `Set-Cookie` value for the admin session. `maxAge` 0 is the expiry form.
 *
 * `Path` is the caller's business (the prefix is configurable — see above), so
 * it is a parameter here and never a constant. One writer for the whole cookie
 * because the *three* places that hand one out (login, logout, and the prefix
 * rename) must agree on every attribute: a cookie that differs in one of them
 * is a cookie the browser treats as a different cookie.
 */
function sessionCookie(sessionId: string, cookiePath: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

export async function bootstrapAdmin(env: Env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM site_users").first<{ count: number }>();
  if ((row?.count ?? 0) > 0) return;
  const username = "admin";
  const password = "change-me-now";
  const now = Math.floor(Date.now() / 1000);
  // The first-ever identity owns the install: without `superadmin` it can log
  // in (requireAdmin allows `admin`) but `can()` answers false everywhere —
  // no site membership exists yet, and platform permissions belong to
  // superadmin alone. That was a fresh-install lockout: the owner could sign
  // in and do nothing (no content.write anywhere, no platform.manage to create
  // the next site, and no endpoint that grants superadmin). Upgrades never saw
  // it because migration 0023 promotes the sole existing admin.
  const userId = "user_" + await randomId();
  await env.DB.prepare(
    "INSERT INTO site_users (id, username, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    userId,
    username,
    null,
    await hashPassword(password),
    "superadmin",
    "active",
    now,
    now
  ).run();
  // Memberships are how the UI shows "role here" (`role_here` reads
  // `site_users_sites`, not the install-wide column). Grant the owner an admin
  // membership on every site that already exists (today: the migrated
  // `default`), so the first screen renders with a role, not a blank.
  try {
    const sites = await env.DB.prepare("SELECT id FROM sites WHERE status='active'").all();
    for (const s of ((sites.results as any[]) ?? [])) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO site_users_sites(user_id, site_id, role, created_at) VALUES(?,?,?,?)"
      ).bind(userId, String((s as any).id), "admin", now).run();
    }
  } catch {
    /* sites table missing (pre-0008 database) — superadmin needs no membership */
  }
}

export async function login(env: Env, username: string, password: string, cookiePath = "/admin"): Promise<Response> {
  const user = await env.DB.prepare(
    "SELECT id, username, email, password_hash, role, status FROM site_users WHERE username = ? LIMIT 1"
  ).bind(username).first<any>();

  if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const sessionId = await randomId(24);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, user.id, expires, Math.floor(Date.now() / 1000)).run();

  return new Response(JSON.stringify({ ok: true, user: {
    id: user.id, username: user.username, email: user.email, role: user.role, status: user.status
  }}), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie(sessionId, cookiePath, SESSION_TTL)
    }
  });
}

export async function logout(env: Env, request: Request, cookiePath = "/admin"): Promise<Response> {
  const sid = cookieValue(request, SESSION_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(sid).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie("", cookiePath, 0)
    }
  });
}

/**
 * Carry a live session across an admin-prefix rename (`admin.path`).
 *
 * The cookie's `Path` **is** the prefix, so the moment an operator renames the
 * admin their own session becomes invisible to the address they just moved to:
 * a browser only sends `Path=/admin` to `/admin/…`, so every request to
 * `/manage/api/v1/…` arrives without the cookie and answers 401. The operator
 * is signed out by their own rename, at the exact moment the admin moves —
 * and the rename is otherwise entirely successful, which is what makes it
 * read as "the setting does not work".
 *
 * This is a **rename, not a new login**: the session row is untouched and the
 * same id is handed back, scoped to where the admin now lives. The old cookie
 * is expired in the same response, because a cookie is only addressable by
 * name *and* path — `Path=/admin; Max-Age=0` names the old one explicitly, and
 * without it the stale cookie lingers until it expires on its own (harmless
 * here, since `/admin/…` 404s, but a lingering session cookie is not something
 * to leave lying around).
 *
 * Returns the `Set-Cookie` values to append, or `[]` when the path did not
 * move — in which case there is nothing to carry and re-issuing would be a
 * pointless write.
 */
export function rescopeSessionCookie(sessionId: string, fromPath: string, toPath: string): string[] {
  if (!sessionId || fromPath === toPath) return [];
  return [sessionCookie(sessionId, toPath, SESSION_TTL), sessionCookie("", fromPath, 0)];
}

/**
 * The signed-in admin, plus their own UI language.
 *
 * `ui_lang` is a personal preference and is deliberately part of the session
 * identity rather than a site setting: two admins on the same site may read the
 * admin in different languages, and a Chinese owner managing an English-only
 * site must still get a Chinese admin (§2.4 — UI language ≠ content language).
 */
export async function currentUser(env: Env, request: Request): Promise<SessionUser | null> {
  const sid = cookieValue(request, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.ui_lang, s.id AS sessionId
    FROM admin_sessions s JOIN site_users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'
    LIMIT 1
  `).bind(sid, Math.floor(Date.now() / 1000)).first<any>();
  return row ?? null;
}

/** Persist an admin's interface language. `null` clears it back to the site default. */
export async function setUserUiLang(env: Env, userId: string, lang: string | null): Promise<void> {
  await env.DB.prepare("UPDATE site_users SET ui_lang=?, updated_at=? WHERE id=?")
    .bind(lang, Math.floor(Date.now() / 1000), userId)
    .run();
}

/**
 * A username that can be typed, remembered and used in a URL-free context.
 * Deliberately stricter than "any non-empty string": the username is shown in
 * the header, sorted in lists and (one day) may appear in author URLs.
 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export function validUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/**
 * Change the caller's own password. The current password is verified *here*,
 * not in the API layer, so every future caller (CLI, API token, a second
 * screen) gets the same gate and none can forget it.
 *
 * Returns `"ok"`, `"wrong_current"`, or `"weak"`.
 */
export async function changePassword(
  env: Env,
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<"ok" | "wrong_current" | "weak"> {
  if (typeof newPassword !== "string" || newPassword.length < 8) return "weak";
  const row = await env.DB.prepare("SELECT password_hash FROM site_users WHERE id=?")
    .bind(userId)
    .first<any>();
  if (!row) return "wrong_current";
  if (!(await verifyPassword(currentPassword, row.password_hash))) return "wrong_current";
  await env.DB.prepare("UPDATE site_users SET password_hash=?, updated_at=? WHERE id=?")
    .bind(await hashPassword(newPassword), Math.floor(Date.now() / 1000), userId)
    .run();
  return "ok";
}

/**
 * Change the caller's own username. Also gated on the current password — the
 * username is half of the login credential, and a hijacked session must not be
 * able to silently lock the real owner out of it.
 *
 * Returns `"ok"`, `"wrong_current"`, `"invalid"`, or `"taken"`.
 */
export async function changeUsername(
  env: Env,
  userId: string,
  currentPassword: string,
  newUsername: string
): Promise<"ok" | "wrong_current" | "invalid" | "taken"> {
  if (typeof newUsername !== "string" || !USERNAME_RE.test(newUsername)) return "invalid";
  const row = await env.DB.prepare("SELECT password_hash FROM site_users WHERE id=?")
    .bind(userId)
    .first<any>();
  if (!row) return "wrong_current";
  if (!(await verifyPassword(currentPassword, row.password_hash))) return "wrong_current";
  const clash = await env.DB.prepare("SELECT id FROM site_users WHERE username=? AND id<>?")
    .bind(newUsername, userId)
    .first<any>();
  if (clash) return "taken";
  await env.DB.prepare("UPDATE site_users SET username=?, updated_at=? WHERE id=?")
    .bind(newUsername, Math.floor(Date.now() / 1000), userId)
    .run();
  return "ok";
}

/**
 * The navigation keys this user hid from the sidebar. Stored as a JSON array
 * in `site_users.menu_prefs`; anything unparseable reads as "nothing hidden" —
 * a corrupt preference must hide the whole admin, not render it empty.
 */
export async function getMenuPrefs(env: Env, userId: string): Promise<string[]> {
  try {
    const row = await env.DB.prepare("SELECT menu_prefs FROM site_users WHERE id=?")
      .bind(userId)
      .first<any>();
    const parsed = JSON.parse(String(row?.menu_prefs ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Persist the hidden-navigation set. Overwrites, never merges. */
export async function setMenuPrefs(env: Env, userId: string, hidden: string[]): Promise<void> {
  await env.DB.prepare("UPDATE site_users SET menu_prefs=?, updated_at=? WHERE id=?")
    .bind(JSON.stringify(hidden), Math.floor(Date.now() / 1000), userId)
    .run();
}

/**
 * Delete a staff identity **and everything that hangs off it**, in one place.
 *
 * ## Why this function exists even though nothing calls it yet
 *
 * Batch E split a staff user in two: the identity (`site_users`, install-wide)
 * and the memberships (`site_users_sites`, one row per (person, site)). The
 * split introduced a second row that must die with the first, and SQLite's
 * `ON DELETE CASCADE` is not available — D1 enables `PRAGMA foreign_keys` per
 * connection and the table has no FK declared, so nothing cascades.
 *
 * There is **no product endpoint that deletes a user**, so this is not a live
 * bug today: the only orphaned memberships in this repository are in test
 * teardowns, which delete `site_users` directly and now also delete
 * `site_users_sites` by hand (four suites do). That is exactly the shape of
 * problem that becomes a real bug the moment a "delete user" button appears —
 * a row keyed by a user id nothing points at is invisible until it makes a
 * *later* user with the same id inherit a stranger's access.
 *
 * So the cleanup is defined **here**, next to the identity it belongs to, and
 * `architecture.test.mjs` pins it: a direct `DELETE FROM site_users` outside
 * this function is a red. A future endpoint calls this; it does not re-derive
 * the two-statement delete and get one of them wrong.
 *
 * Both statements run in one `batch`, in this order: memberships first, then
 * the identity. Neither is observable between the two, so no reader can see a
 * user whose membership rows still exist but whose identity is gone.
 */
export async function deleteUser(env: Env, userId: string): Promise<{ ok: true }> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM site_users_sites WHERE user_id=?").bind(userId),
    env.DB.prepare("DELETE FROM site_users WHERE id=?").bind(userId),
  ]);
  return { ok: true };
}

/**
 * Roles that may hold an admin session at all.
 *
 * Derived from the two sources that define roles — the per-site memberships
 * and the install-wide superadmin — rather than retyped. A hand-written list
 * here is how `superadmin` would be locked out of the very endpoints it exists
 * to reach (rule 78).
 */
const ADMIN_ROLES: ReadonlySet<string> = new Set<string>([...SITE_ROLES, SUPERADMIN_ROLE]);

export async function requireAdmin(env: Env, request: Request): Promise<SessionUser | Response> {
  const user = await currentUser(env, request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // ⚠️ `superadmin` must be in this list. It is a role added by batch E and it
  // outranks every per-site role, so a gate that recognises only the three
  // older values locks the install's owner out of every admin endpoint — the
  // exact failure the migration's backfill exists to prevent, reintroduced one
  // layer up. The list is now derived from `SITE_ROLES` plus the install-wide
  // role rather than retyped, so the next role cannot be forgotten here.
  if (!ADMIN_ROLES.has(user.role)) return Response.json({ error: "Forbidden" }, { status: 403 });
  return user;
}

/**
 * Login with a per-isolate brute-force throttle, plus the JSON response.
 *
 * This is the endpoint a scanner can brute-force, so it is the one that gets
 * throttled. ⚠️ The throttle is **per isolate**: an attacker hitting several
 * isolates in parallel sees a higher limit. It is a speed bump, not a lock;
 * the primary mitigation is that the endpoint is not guessable (it lives
 * under the configurable admin prefix). A D1-backed counter would be shared
 * across isolates if that ever matters.
 */
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 300_000;
const attempts = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();

export async function loginRequest(env: Env, request: Request, cookiePath = "/admin"): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json" };
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const body = (await request.json().catch(() => ({}))) as any;
  const username = String(body?.username ?? "");
  const gate = `${ip}|${username}`;
  const now = Date.now();
  const rec = attempts.get(gate);
  if (rec && rec.blockedUntil > now) {
    return new Response(JSON.stringify({ error: "too many attempts; try again later" }), { status: 429, headers: jsonHeaders });
  }
  const res = await login(env, username, String(body?.password ?? ""), cookiePath);
  if (res.status >= 400) {
    const cur = attempts.get(gate);
    if (!cur || now - cur.firstAt > ATTEMPT_WINDOW_MS) attempts.set(gate, { count: 1, firstAt: now, blockedUntil: 0 });
    else {
      cur.count++;
      if (cur.count >= MAX_ATTEMPTS) { cur.blockedUntil = now + LOCK_MS; attempts.delete(gate); attempts.set(gate, { count: 0, firstAt: now, blockedUntil: cur.blockedUntil }); }
    }
    return res;
  }
  attempts.delete(gate);
  return res;
}
