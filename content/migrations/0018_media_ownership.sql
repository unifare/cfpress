-- 0018: Media ownership.
--
-- `media_files` has been per-site since 0009, but nothing recorded *who*
-- uploaded a file. Two consequences, both invisible in a single-operator
-- install: every signed-in user saw the whole site's library, and the public
-- `/media/<key>` path was matched in `src/index.ts` *before* site resolution
-- and before any authentication, so a key from one site resolved on another
-- site's host (and for an anonymous visitor).
--
-- This migration adds the owner. The read path is fixed alongside it: the
-- `/media/` branch moved below site resolution, the key's `uploads/{siteId}/`
-- segment must match the resolved site, and the isolation/session policy comes
-- from one place (`src/platform/media-policy.ts`).
--
-- `ADD COLUMN` only. SQLite cannot add a UNIQUE constraint or a composite
-- primary key to an existing table, and neither is wanted: a user may upload
-- the same filename twice.
--
-- Existing rows keep `uploaded_by = NULL` and are *grandfathered*: the
-- isolation filter reads NULL as "uploaded before ownership existed" and keeps
-- those rows visible site-wide. Turning owner isolation on must not make the
-- operator's existing library disappear. That reading of NULL is stated in the
-- read path rather than implied here, and no other platform table uses NULL
-- for it.
ALTER TABLE media_files ADD COLUMN uploaded_by TEXT;

-- The library's new access patterns: "my files" and the per-user count.
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_files(site_id, uploaded_by, created_at);
