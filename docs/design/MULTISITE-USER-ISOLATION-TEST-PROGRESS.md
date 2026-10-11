# Multi-site user isolation — test progress

Companion to [`MULTISITE-USER-ISOLATION-STORIES.md`](MULTISITE-USER-ISOLATION-STORIES.md)
(the 18-story matrix). This file records what is now **behaviourally tested**,
what was **found and fixed** while building the tests, and what is **filed as
an issue** instead. Statuses use the matrix's own scale:

- ✅ behaviourally asserted in `tests/suites/multisite-isolation-matrix.test.mjs`
- 🟡 partially asserted / covered by static audit only (why is stated)
- ❌ not covered (tracked as a gap or an issue)

**Current suite result: 57 passed / 0 failed**
(`node tests/suites/multisite-isolation-matrix.test.mjs`).
Every assertion name carries its `MS-x.y` story id, so
`grep "MS-1.1" tests/suites/multisite-isolation-matrix.test.mjs` answers
"where is this story tested".

---

## 1. Leaks found and fixed while grounding the stories

These were found by *grounding* the matrix against `src/api.ts`, fixed in the
same commit that introduces the assertions catching them.

### 1.1 `GET /redirects` / `GET /rewrites` returned every site's rows (fixed)

`genericTable()`'s `allowed` set listed both tables but its `scoped` set only
named `menus`/`menu_items` — so the site filter was silently skipped and any
staff member could list every site's redirect/rewrite rules.
`src/extensions/contract/schema.ts` declares both tables `tenant: "site"`.
Fix: both added to `scoped`. Asserted by `MS-1.1: GET redirects|rewrites on
site A names only site A's rows` (+ a non-vacuity companion asserting site A's
own row is really present).

Reverse-validated: removing the two names from `scoped` makes exactly those
two assertions red.

### 1.2 Cross-site reads of revisions / autosaves / restore (fixed)

`post_revisions` and `post_autosaves` are derived-tenant tables: they carry no
`site_id` and inherit their tenancy from `post_id → posts.site_id`. The three
handlers filtered on `post_id` alone, so a scoped editor could read another
site's drafts by id:

- `GET /posts/:id/revisions` — now `JOIN posts p … AND p.site_id=?`
- `GET /posts/:id/autosave` — same JOIN
- revision restore read — same JOIN (a foreign revision id now 404s)

Asserted by the three `MS-1.2` assertions plus the restore 404, with a
non-vacuity companion (a revision on the *requested* site does come back, so
the empty result is the filter and not a broken endpoint).

Reverse-validated: reverting to the historical single-bind shape
(`WHERE r.post_id=?` with `.bind(revm[2])`) makes
`MS-1.2: site B's revisions are not readable through site A's request` red.
(First injection attempt kept two binds against one placeholder — the worker
500'd and the empty list passed vacuously; the injection must be the *real*
historical shape, bind count included.)

### 1.3 Suite-level fixture lessons

- A `sites` fixture must set `host`/`path_prefix` — without them the site is
  only ever reachable as the default fallback, and every resolveSite assertion
  would be a tautology.
- A leak probe needs something to leak: site B's post carries a revision
  fixture, otherwise "B's revisions are not readable" passes on an empty table.
- `content_cache_versions` is a global counter (`id='default'`), not a tenant
  table — there is no per-site row to purge; MS-4.3 covers the bump instead.

---

## 2. Per-story status

### §1 Data plane

| Story | Status | Where / why |
|---|---|---|
| MS-1.1 tenant tables answer for one site only | ✅ | `redirects`, `rewrites` per-site lists (the 1.1 fix); `i18n_overrides` write/delete isolation; `terms`/`taxonomies`/`notification_log` asserted **endpoint-less** (entry-point triage — their coverage is `_tenant-query-audit`, and a future endpoint will turn the 404 assertion red) |
| MS-1.2 derived tables resolve through the post's site | ✅ | revisions/autosave cross-site reads + restore 404 + non-vacuity (the 1.2 fix). `seo_meta`, `scheduled_posts` reads, `term_relationships` remain audit-only — see issue 3 |
| MS-1.3 platform tables stay global | 🟡 | `extension_versions`/`users` are asserted *reachable-but-ungated* only via the MS-3.2 findings; no dedicated "platform table visible from every site" assertion yet |
| MS-1.4 site delete: purge/retain axes | ✅ | delete → posts retained, `settings`/`site_locales`/`redirects`/`rewrites`/`i18n_overrides`/`site_users_sites`/the `sites` row purged |
| MS-1.5 orphan identity after site delete | ✅ | a membership on a fresh site, site deleted → identity survives, membership gone, `can()` answers 403 everywhere (no fallback) |

### §2 Entry plane

| Story | Status | Where / why |
|---|---|---|
| MS-2.1 resolveSite priority | ✅ (pre-existing) | `multisite.test.mjs` covers prefix>host>default; the matrix adds a two-prefix + one-host fixture that would catch two-site coincidences |
| MS-2.2 memo reset | ✅ (pre-existing) | `multisite.test.mjs` |
| MS-2.3 no invented site | ✅ (pre-existing) | `multisite.test.mjs` (unknown host → default) |
| MS-2.4 bypassing entries | 🟡 | front member red lines (member cookie on admin API, admin cookie on front) asserted in MS-3.4; no dedicated "direct worker fetch skipping resolveSite" probe |

### §3 Actor plane

| Story | Status | Where / why |
|---|---|---|
| MS-3.1 staff per-site | ✅ (pre-existing) | `multisite.test.mjs`; the matrix re-asserts with single-site fixtures (editor on A only) |
| MS-3.2 platform powers unreachable from a site role | ✅ / 1 gap | create site / list users / create user / grant role from a scoped editor → 403. **Gap found:** `GET /extensions/versions` has no permission gate at all → issue 2 |
| MS-3.3 member–staff separation | ✅ (pre-existing) | rule 77 red lines, re-asserted in the matrix (MS-3.4 block) |
| MS-3.4 members per site | ✅ | member session live on its site's mount, dead on the other site's host, two same-username members on two sites, rule-77 red lines both ways |
| MS-3.5 no-fallback denial | ✅ | MS-1.5's 403-everywhere assertion is exactly this |

### §4 Crossings

| Story | Status | Where / why |
|---|---|---|
| MS-4.1 switcher filters by membership | 🟡 (pre-existing) | admin SPA scope; partially covered by account/multisite suites |
| MS-4.2 counts leak | ✅ (pre-existing) | `?withCounts=1` filters `items` through `accessibleSiteIds` before counts attach (verified while grounding; suite-coverage unchanged) |
| MS-4.3 scheduler is per site | ✅ | `processScheduled` on the real compiled scheduler: three sites' due posts published, per-site cache version bumps, no queue rows left |
| MS-4.4 same slug, three sites | ✅ | shared slug `iso-hello` on A/B/C: front renders each site's own title, no cross-title leak; admin content list on A contains A's post |

---

## 3. Filed issues (not fixed here)

1. **MS-3.2 product decision — a site admin cannot manage its own site's users.**
   `users.manage` is platform-wide, so `GET/POST /users` 403 for site admins.
   The endpoints are safe (superadmin-only), but the product shape is a
   decision: keep as-is (Option A) or add site-scoped `site.users.manage`
   with an explicit `targetSite === siteId` check (Option B).
2. **`GET /extensions/versions` has no permission gate.** Any staff session —
   including a site-scoped editor — gets 200 with the whole platform registry.
   The MS-3.2 assertion accepts either the gap (200) or the fix (403) so it
   does not block the fix landing.
3. **Derived-tenant tables still without behavioural assertions:**
   `seo_meta`, `scheduled_posts` (read path), `term_relationships` — covered
   only by `_tenant-query-audit` static analysis (matrix Appendix B).
4. **`genericTable`'s `plugins`/`themes` entries are dead paths** — neither is
   a real table name (`SELECT * FROM plugins` would throw); they are global
   registry reads that likely never execute. Candidate for removal.

---

## 4. Registration

- `package.json`: `test:multisite-matrix` + the `test` chain (after `user-delete`)
- `tests/run-all.mjs`: after the user-delete suite
- `scripts/cfpress.sh` / `scripts/cfpress.ps1`: `multisite-matrix`
- `launcher-parity`: 62/0 after registration

## 5. How to run

```sh
node tests/suites/multisite-isolation-matrix.test.mjs
# or
npm run test:multisite-matrix
```

The suite compiles the real worker (and the real scheduler) with esbuild,
runs against the local D1 sqlite, and sweeps its own `iso_*` fixtures at both
ends — it is safe to run repeatedly and leaves the demo content alone.
