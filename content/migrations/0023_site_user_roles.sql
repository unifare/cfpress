-- 0023: Per-site roles for staff — one identity, many site memberships.
--
-- ## The shape
--
-- `site_users` stays what it is: the **install-wide identity** (one row = one
-- person). What changes is where "what may this person do" is answered. It used
-- to be one column, `site_users.role`, which is a single answer for an install
-- that can hold many sites — so an `editor` on the shop site was an `editor`
-- everywhere, and there was no way to express "owner here, author there".
--
-- `site_users_sites(user_id, site_id, role)` is that missing answer: one row per
-- (person, site) membership. A person with no row for a site has **no access to
-- that site** — the absence is the denial, not a fallback to a global role.
-- (That is §10 rule 6 again: the tenant is a column, and a query that does not
-- filter on it reads every tenant's rows.)
--
-- ## Why a join table rather than `site_users.site_id`
--
-- Staff are not members. A member belongs to one site by construction (see
-- `members`, migration 0022); a staff person is the opposite case — the same
-- person writes on three sites, and forcing one `site_id` per account would
-- mean three accounts for one human. So the identity stays install-wide and the
-- *membership* becomes the per-site thing. The plan calls this the
-- "WordPress-multisite shape": one user, N roles.
--
-- ## The backfill is load-bearing, not a nicety
--
-- Every existing install has `site_users.role` populated and no membership
-- rows. Without a backfill, the first request after this migration finds no row
-- for anyone and denies everything — a CMS that locks its own owner out. So the
-- migration inserts, for **every** existing user × **every** existing site, one
-- row carrying that user's current role. That preserves today's behaviour
-- exactly ("this role, on every site") and makes the new model a superset.
--
-- `admin` maps to `admin` on each site, not to a new install-wide superuser:
-- the new `superadmin` role is opt-in (see below) precisely so this migration
-- cannot silently widen anyone's access.
--
-- ## `superadmin`
--
-- A role value that `can()` short-circuits for every site, including sites
-- created *after* the user was made superadmin. It exists because a membership
-- row per site has no answer for "the site that does not exist yet" — and the
-- first admin must be able to manage the Sites screen itself. It is granted
-- deliberately (by editing `site_users.role`, or by this migration for the
-- bootstrap owner if they are still the only admin) and is never implied by a
-- per-site `admin`.
CREATE TABLE IF NOT EXISTS site_users_sites (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_site_users_sites_site ON site_users_sites(site_id);
CREATE INDEX IF NOT EXISTS idx_site_users_sites_user ON site_users_sites(user_id);

-- Backfill: grant every existing user their current role on every existing
-- site. `sites` is the tenant registry, so this is exactly "the sites that
-- exist right now".
INSERT OR IGNORE INTO site_users_sites(user_id, site_id, role, created_at)
SELECT u.id, s.id, u.role, CAST(strftime('%s','now') AS INTEGER)
FROM site_users u
CROSS JOIN sites s
WHERE u.status = 'active';

-- The bootstrap owner becomes superadmin **only if they are the sole
-- administrator**. On an install with several admins, picking one to be
-- install-wide would be an access decision this migration is not entitled to
-- make; on the single-admin install that is every real upgrade path, the one
-- admin must retain the ability to create the next site.
UPDATE site_users
SET role = 'superadmin'
WHERE role = 'admin'
  AND (SELECT COUNT(*) FROM site_users WHERE role = 'admin') = 1;
