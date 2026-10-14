-- 0025: Media can live on a third-party image host ("图床").
--
-- Until now every upload landed in the install's own R2 bucket
-- (`env.MEDIA`), and `media_files.object_key` always named an R2 object.
-- Some operators would rather keep bytes off their own bill: free image hosts
-- (imgbb, postimages.org) serve the bytes, and CFPress keeps the registry row
-- — the tenant, the owner, the alt text — plus the policy front door.
--
-- Three new columns, all additive (existing rows keep working untouched):
--
--   - `storage`            — "r2" (every pre-0025 row, by default), "imgbb" or
--                            "postimages". The read and delete paths branch on
--                            this column, never on key shape alone.
--   - `remote_url`         — the host's direct file URL (the bytes' address).
--   - `remote_delete_url`  — the host's deletion URL, if it gave one (imgbb
--                            does; postimages anonymous may not). Best-effort
--                            only: a missing one never blocks the local delete.
--
-- Remote rows still carry a namespaced `object_key`,
-- `uploads/{siteId}/remote/{provider}/{id}-{safe}`. Two reasons, both
-- load-bearing:
--
--   1. `mediaKeyBelongsToSite()` (`platform/media-policy.ts`) reads the tenant
--      off the key's `uploads/{siteId}/` prefix. A remote row keyed any other
--      way would fail the very first gate on the read path.
--   2. The content keeps storing `/media/<key>` URLs (built by the single
--      `mediaUrl()`), so the picker, the renderer and the editor need no new
--      URL shape: the read path answers a remote row with a 302 to
--      `remote_url` *after* the same tenant/session/owner decision every R2
--      row goes through (rule 60b — the policy module stays the only decider).
--
-- *Language*: all three columns are language-**neutral** — identifiers and an
-- address, not sentences. Nothing here touches the content-language side, and
-- `alt_text`/`title` stay the only translatable-adjacent columns (they are
-- language-neutral by design: one alt for every language).
--
-- *Deletion*: `media_files` is `onSiteDelete: "retain"`, and these columns add
-- no new obligation — a retained row keeps pointing at bytes that may outlive
-- the site, exactly like a retained R2 row keeps pointing at its object.

ALTER TABLE media_files ADD COLUMN storage TEXT NOT NULL DEFAULT 'r2';
ALTER TABLE media_files ADD COLUMN remote_url TEXT;
ALTER TABLE media_files ADD COLUMN remote_delete_url TEXT;

CREATE INDEX IF NOT EXISTS idx_media_storage ON media_files(site_id, storage);
