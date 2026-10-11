/**
 * Source-level tenant-scope audit.
 *
 * The schema guard proves every table *has* a tenant answer. This one asks the
 * complementary question: does every *query* against a tenant-scoped table
 * actually use that answer? A table can be correctly shaped and still be read
 * install-wide — that is the shape of a multi-site leak, and it is invisible in
 * a single-site install.
 *
 * This is a **report**, not a pass/fail gate. A statement that omits `site_id`
 * is sometimes correct: a migration-wide backfill, a `SELECT COUNT(*)` used as
 * a health probe, or a query whose site filter is added by the caller through
 * `requestSiteId`. So it prints every hit with its file:line for a human to
 * judge, and exits 0 unless `--strict` is passed.
 *
 * Usage:
 *   node tests/tools/_tenant-query-audit.mjs            # report
 *   node tests/tools/_tenant-query-audit.mjs --strict   # fail on any hit
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT_TABLES } from "../../src/extensions/contract/schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STRICT = process.argv.includes("--strict");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Statements worth examining: they name a tenant table as a mutation or read
 * target. Column lists and `PRAGMA` are skipped — they cannot leak rows.
 */
const TARGET_RE = /\b(?:FROM|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/gi;

const allowed = new Set(TENANT_TABLES);
const hits = [];

for (const file of walk(join(ROOT, "src"))) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    TARGET_RE.lastIndex = 0;
    let m;
    while ((m = TARGET_RE.exec(line))) {
      const table = m[1].toLowerCase();
      if (!allowed.has(table)) continue;
      // The statement usually spans lines: `SELECT …` on one line, `FROM
      // <table>` on the next, `WHERE site_id=?` lines below (the post detail
      // GETs were exactly this shape, and the old same-line verb gate made
      // them invisible). A bare `FROM` line therefore gets 2 lines of backward
      // context for the verb; a line that already carries its verb uses a
      // forward-only window. Forward always ends at the end of THIS statement
      // (`.bind(`/`.run(`/`.all(`/`.first(` or `;`) — without the bound, a
      // neighbouring statement's `site_id` bleeds in and a genuine site_id-less
      // statement reads as reviewed.
      const hasVerb = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line);
      const back = hasVerb ? line : lines.slice(Math.max(0, i - 2), i + 1).join(" ");
      const fwd = [];
      for (let j = i; j < Math.min(i + 7, lines.length); j++) {
        fwd.push(lines[j]);
        if (/(\.bind\(|\.run\(|\.all\(|\.first\(|;)/.test(lines[j])) break;
      }
      const window = `${back} ${fwd.join(" ")}`;
      if (/\bsite_id\b/.test(window)) continue;
      hits.push({
        // Normalise to POSIX separators: the report is compared against a
        // verdict table keyed by path, and on Windows `relative()` returns
        // backslashes — so the lookup silently missed every entry and every
        // reviewed statement was announced as NEW. A key that depends on the
        // host's path separator is a key that works on one machine only.
        where: `${relative(ROOT, file).split(/[\\/]/).join("/")}:${i + 1}`,
        table,
        line: line.trim().slice(0, 130),
      });
    }
  });
}

console.log("Tenant-scope audit: statements touching a tenant-scoped table without site_id\n");
if (!hits.length) {
  console.log("  (none)");
} else {
  const pad = Math.max(...hits.map((h) => h.where.length));
  for (const h of hits) {
    console.log(`  ${h.where.padEnd(pad)}  [${h.table}]  ${h.line}`);
  }
}

console.log(`\n${hits.length} statement(s) to review.`);
console.log(
  "Each is *possibly* correct — a global count, a backfill, or a caller-supplied\n" +
  "filter. The point is that a human looks, rather than assuming."
);

/**
 * The batch-6 review verdicts.
 *
 * Every hit is keyed by a primary key (`id` / `post_id` / `menu_id`) that the
 * caller obtained *through* a site-scoped query, or is a deliberate
 * install-wide computation. Recording them here means the next reader starts
 * from "these were judged" rather than re-deciding from scratch — and, more
 * importantly, a **new** hit stands out as the only unreviewed one.
 *
 * The alternative — a `--strict` gate — was rejected: it would force a
 * `site_id` into statements where adding one would be wrong (`theme_installs`
 * is platform-global by design), and a guard that is wrong gets disabled.
 */
const REVIEWED = {
  // `UPDATE posts … WHERE id=?` and `DELETE FROM posts WHERE id=?` used to be
  // listed here. Both now carry `AND site_id = ?` in the statement itself, so
  // they no longer appear as hits at all — a verdict that is no longer needed
  // is a verdict that should be deleted, not left to rot.
  // ⚠️ These keys are `file:line`, so **any edit above a reviewed statement
  // re-keys it**. Batch 16 added the media block to `api.ts` and moved the
  // `theme_installs` update down; `frontend.ts` had already drifted from batch
  // 10's line numbers without anyone noticing. Batch 28 added the Sites
  // `withCounts` aggregate (~52 lines) and shifted the whole uninstall/activate
  // block again — 795→907, 801→913, 1610→1958, 1665→2013. Re-keyed here rather
  // than left as NEW, so the next reader sees only genuinely new statements.
  // Batch D added the front-end API router in `api.ts` (~+58 lines) and moved
  // them once more: 907→912 (drifting to 910 by the time of this edit), 913→918,
  // 1958→2055, 1665→898. Batch E added the users/roles endpoints and moved
  // 2055→2075. Re-keyed again; the statements are unchanged.
  // The isolation fix batch re-keyed again (site-access helpers + per-branch
  // gates ≈ +30 lines above the uninstall block, +22 in auth.ts for the
  // superadmin bootstrap, +16 in scheduler.ts): 912→942, 918→948, 2075→2205,
  // auth.ts 230→252. It also taught the scanner multi-line statements (a bare
  // `FROM` line gets 2 lines of backward context; forward ends at the
  // statement terminator so neighbours' `site_id` cannot bleed in) — which
  // surfaced four genuinely new hits below (708, settings.ts:100,
  // runtime-declarative.ts:300, scheduler.ts:39), each judged here.
  "src/api.ts:708": "UPDATE settings … WHERE id=? — `saveFeature` writes back the row its own `SELECT id FROM settings WHERE site_id=? AND key=?` just read; `id` is the PK of a site-scoped read, same shape as platform/settings.ts:100",
  "src/platform/settings.ts:100": "UPDATE settings … WHERE id=? — `setSetting` writes back the row its own `SELECT id FROM settings WHERE site_id=? AND key=?` just read; the tenant was established by the read",
  "src/extensions/theme/runtime-declarative.ts:300": "FROM posts p JOIN post_translations — `runThemeQuery` assembles its WHERE from the `conditions` array, whose first element is always `p.site_id = ?` (line 277); the predicate is real but constructed, so a line scanner cannot see it — assembled-statement limitation, judged correct",
  "src/shared/scheduler.ts:39": "UPDATE posts … WHERE id=? — the orphan-queue branch: the post row is gone (no tenant left to scope), so the queue row is marked done so it drains instead of retrying forever. The live branch above carries AND site_id=?",
  "src/api.ts:2205": "UPDATE theme_installs … WHERE name IN (SELECT value FROM settings WHERE key='theme.active') — theme_installs is PLATFORM-GLOBAL; `active` means 'some site uses it', so the cross-site subquery is the intent",
  "src/extensions/plugin/notify.ts:108": "UPDATE notification_log … WHERE id=? — the row is this send's own claim, addressed by the PK minted a few lines above for this siteId; ok/error are not identity",
  "src/extensions/theme/runtime-worker.ts:411": "menu_items … WHERE menu_id=? AND site_id=? — ⚠️ rewritten in batch 16: `menu_id` is only unique per site (menus is UNIQUE(site_id,id)), so the earlier `WHERE menu_id=?` leaked another tenant's items onto this site's nav; `site_id` is required, not optional",
  "src/extensions/theme/tables.ts:383": "UPDATE theme_table_defs WHERE id=? — registry row addressed by its own PK",
  "src/extensions/theme/tables.ts:404": "SELECT theme_table_defs … WHERE site_id=? AND owner_type=? AND owner_name=? AND logical_name=? — reads back the mapping this same call just wrote, to repair a recorded i18n_table whose table is gone; fully site-scoped",
  "src/platform/frontend.ts:186": "menu_items … WHERE menu_id=? AND site_id=? — ⚠️ rewritten in batch 16 (see runtime-worker:411): `menu_id` is only unique per site, so the earlier site-blind filter rendered the shop site's nav item on the default site's front page",
  "src/api.ts:942": "SELECT theme_table_defs … WHERE owner_type='theme' AND owner_name=? — theme uninstall gathers every site's generated tables for a theme being removed entirely; owner-scoped by design, no site_id on purpose",
  "src/api.ts:948": "DELETE FROM theme_table_defs WHERE owner_name=? — same uninstall: the theme is leaving the platform, so every site's mapping goes with it",
  "src/api.ts:898": "SELECT settings … WHERE key='theme.active' AND value=? — uninstall's active-site check deliberately scans all sites: the 409 must name every site that still renders this theme",
  "src/platform/admin-menus.ts:268": "DELETE FROM admin_menu_registry WHERE owner_type=? AND owner_name=? — this is `clearOwnerMenusAllSites`, and install-wide is its *name*: an activation interrupted before it wrote `theme.active` leaves menus on sites that no longer select the theme, pointing at tables an uninstall is about to drop. Owner-scoped by design",
  "src/platform/members.ts:166": "DELETE FROM member_sessions WHERE id=? — the logout row is addressed by the session id read from the caller's own cookie (`cookieValue(request, MEMBER_COOKIE)`), which is the PK; there is no site dimension to add, and deleting someone else's id is impossible without already holding it",
  "src/platform/auth.ts:252": "DELETE FROM site_users_sites WHERE user_id=? — `deleteUser` removing *all* of one person's memberships as part of deleting that person. `user_id` is the PK half, and install-wide is the intent: the identity is going away, so every site's grant for it must go too. Adding a site filter here would leave the other memberships orphaned, which is the very defect rule 80 exists to prevent",
};

const unreviewed = hits.filter((h) => !(h.where in REVIEWED));
if (hits.length) {
  console.log(`\nReviewed in batch 6: ${hits.length - unreviewed.length}/${hits.length}`);
  for (const h of hits) {
    if (REVIEWED[h.where]) console.log(`  judged  ${h.where}  ${REVIEWED[h.where]}`);
  }
}
if (unreviewed.length) {
  console.log(`\n⚠️ ${unreviewed.length} statement(s) have NO recorded verdict — review them:`);
  for (const h of unreviewed) console.log(`  NEW  ${h.where}  [${h.table}]`);
} else if (hits.length) {
  console.log("Every hit has a recorded verdict. A new table or query will show up as NEW.");
}

if (STRICT && hits.length) process.exit(1);
