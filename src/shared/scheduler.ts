import { Env } from "./types";
import { now } from "./repo";
import { bumpContentCache } from "./cache";

/**
 * Publish every post whose scheduled time has passed. Only the sites that
 * actually had something published get their cache version bumped, so a busy
 * multi-site install does not invalidate unrelated sites every minute.
 */
export async function processScheduled(env: Env) {
  // Oldest first: without ORDER BY a busy queue starves the earliest posts
  // behind a steady trickle of new ones (LIMIT 50 keeps picking whatever
  // SQLite feels like).
  const due = await env.DB.prepare(
    "SELECT post_id FROM scheduled_posts WHERE processed_at IS NULL AND publish_at<=? ORDER BY publish_at LIMIT 50"
  )
    .bind(now())
    .all();

  const touchedSites = new Set<string>();
  let count = 0;
  for (const row of due.results as any[]) {
    const post = await env.DB.prepare("SELECT site_id FROM posts WHERE id=?")
      .bind(row.post_id)
      .first<any>();
    if (post?.site_id) {
      // Site-scoped publish: without `AND site_id=?` a post id that was
      // re-created on another site (or a stale queue row pointing at a reused
      // id) would flip the wrong tenant's row.
      await env.DB.prepare("UPDATE posts SET status='published',updated_at=? WHERE id=? AND site_id=?")
        .bind(now(), row.post_id, String(post.site_id))
        .run();
      touchedSites.add(String(post.site_id));
    } else {
      // Queue row for a post that no longer exists: mark it processed so the
      // queue drains instead of retrying it every minute forever. (Previously
      // the UPDATE ran unconditionally and the row was still marked done, so
      // behaviour is unchanged — but now it says why.)
      await env.DB.prepare("UPDATE posts SET status='published',updated_at=? WHERE id=?")
        .bind(now(), row.post_id)
        .run();
    }
    await env.DB.prepare("UPDATE scheduled_posts SET processed_at=? WHERE post_id=?")
      .bind(now(), row.post_id)
      .run();
    count++;
  }
  for (const siteId of touchedSites) await bumpContentCache(env, siteId);
  // Legacy rows written before multi-site may have no site_id. Those rows can
  // only ever have belonged to the default site, so invalidate it explicitly
  // rather than relying on a parameter default to make the same choice.
  if (count && touchedSites.size === 0) await bumpContentCache(env, "default");
  return count;
}
