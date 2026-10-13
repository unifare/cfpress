-- 0022: Front-end members — a second identity that is per site by construction.
--
-- ## Why this is not `site_users`
--
-- `site_users` is *install-wide* (a platform table: one row for the whole
-- install), and batch E adds a per-site role on top of it. That is the right
-- shape for staff: one person, one account, managing several sites.
--
-- A front-end member is the opposite question. "This reader registered on the
-- shop site" is not a statement about the install; it is a row that belongs to
-- one site and must not exist on any other. Modelling it as a role on
-- `site_users` would mean a member of site A is a row the platform can see
-- from site B — isolation by *policy* rather than by *storage*. So `members`
-- carries `site_id` and a member registered on A simply does not exist on B.
-- That is §10 rule 6 (tenant) applied to the one table where it is most
-- tempting to skip.
--
-- ## The two logins share nothing
--
-- Separate table (`members` vs `site_users`), separate session table
-- (`member_sessions` vs `admin_sessions`), separate cookie
-- (`cfpress_member` vs `cfpress_admin`), separate endpoint prefix
-- (`/api/v1/front/…` vs `/{admin.path}/api/v1/…`). The id spaces are distinct
-- tables, so a member session id is not a valid admin session id *by
-- construction* — the injector scenario that swaps them has to fail, and it
-- does, because there is nothing to swap: `currentMember` reads
-- `member_sessions` and `currentUser` reads `admin_sessions`.
--
-- ## Why the password uses the same hash format
--
-- `shared/crypto.ts` is the platform's one password implementation
-- (`pbkdf2$<iterations>$salt$hash`, count embedded). A member password and a
-- staff password are different credentials but not different cryptography;
-- writing a second hasher is how "the front door is weaker than the back door"
-- starts. The 25k iteration count is sized against the Workers free plan's
-- 10 ms CPU budget — see the comment on `PBKDF2_ITERATIONS`, do not raise it.
--
-- ## onSiteDelete
--
-- Both tables are `purge`: a member account is site-local identity, meaningless
-- without its site, exactly like `site_locales`. (Deleting a site must not
-- destroy an author's *content*, which is why `posts` is `retain`; it must not
-- leave behind login rows that resolve to nothing.)
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  username TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Login is by (site, username) — a member of site A and a member of site B may
-- pick the same name without colliding, and the lookup is always scoped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_site_username ON members(site_id, username);
CREATE INDEX IF NOT EXISTS idx_members_site_status ON members(site_id, status);

-- `member_sessions` carries `site_id` as well, even though it could reach the
-- site through `member_id`. Two reasons, and the second is the deciding one:
--
--   - the session lookup is always "this member, on this site", so the column
--     is on the index path anyway;
--   - `deleteSite()` purges per-site rows with a uniform
--     `DELETE FROM <table> WHERE site_id=?` over the declared purge list. A
--     table with no `site_id` cannot be in that loop, so it would need a
--     bespoke deletion step — a second place to forget. A derived-tenant table
--     is right when the local column would be *redundant* (a join table); here
--     it would be *load-bearing*.
CREATE TABLE IF NOT EXISTS member_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_sessions_member ON member_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_member_sessions_site ON member_sessions(site_id);
