# UI Testing — browser black-box, vision, and the nightly run

This guide covers the three UI layers, how to run them, and how the scheduled run
files its findings.

| Layer | Script | Needs | Answers |
|---|---|---|---|
| **Black-box (deterministic)** | `tests/tools/_ui-blackbox.cjs` | a dev server | status codes, DOM state, cookie scoping, cross-tenant rendering, hash routing, husk renders — the *facts* |
| **Admin functional** | `tests/tools/_ui-admin-functional.cjs` | a dev server | every screen *does its job*: a post created through the editor renders on the front end, a setting saved in the admin changes the site, a hidden sidebar item disappears, a created user can sign in — the *workflows* |
| **Vision + functional (model)** | `tests/tools/_ui-midscene.mjs` | a dev server + `MIDSCENE_MODEL_*` | "does the screen *look* right", "can an operator complete this workflow" — the *judgements* |
| **Runner** | `scripts/run-ui-tests.mjs` | node | starts/stops the dev server, runs all three, files new findings as GitHub issues |

Neither Playwright script is part of `npm test`: both need a live server, and the
model one needs a key that is not part of the repository.

## Quick start

```bash
# one-shot, attaches to a server you started yourself
npx wrangler dev --port 47913 -c wrangler.local.jsonc   # in another shell
node tests/tools/_ui-blackbox.cjs

# or let the runner own the server
npm run test:ui
```

## 1. Black-box (`_ui-blackbox.cjs`)

Ten sections, all real-browser facts:

1. the login gate (unauthenticated UI, API 401, wrong password)
2. the shell boots with no console/page/request/5xx errors
3. every screen in `screens/index.js` renders — including the **husk check**
   (an empty `#content` is a defect a stubbed renderer cannot produce, because
   the stub always returns a non-empty row; slow-but-rendering screens poll up
   to 3 s so a cold D1 cannot fake a husk)
4. the admin cookie does not travel to the front end — `Path` scoping is a
   browser behaviour; a Node `fetch` ignores it and would pass either way
5. the site switcher matches `accessibleSiteIds`, for a superadmin *and* a
   scoped editor
6. URL is page: hash resolves, Back/Forward resolves with it
7. logout then Back renders no data
8. three tenants (path prefix, host, default) each serve their own front end;
   every in-page link stays inside the site's prefix; the feed and sitemap are
   per-site; a miss is a 404 **on that site**
9. unknown admin assets 404 instead of falling through to the front-end router
10. switching the interface language leaves no English fallback in the sidebar

## 2. Admin functional (`_ui-admin-functional.cjs`)

The admin does its job, end to end — every assertion crosses **UI action → API
write → DB row → front-end rendering**, which is the loop a stubbed unit suite
cannot make (it renders from a canned payload, so a save button that writes
nothing still passes).

| § | What it proves |
|---|---|
| 1 | the dashboard reports the site's real numbers |
| 2 | a post created through the editor appears in the list, renders on the front end under its own slug, reopens in the editor, edits reach the front end, and deleting makes the URL a 404 |
| 3 | a page publishes and resolves at its own path |
| 4 | a file uploaded through the media screen is listed, keyed to its tenant, and sized as uploaded |
| 5 | activating a theme from the screen is what the API then reports |
| 6 | a menu built through the screen survives a **full reload** |
| 7 | enabling a language registers it for the site and the front end answers under `/<locale>/` |
| 8 | a site created through the Sites screen appears in its table |
| 9 | a user created from the screen is a member of exactly that site, can sign in, and revoking removes the role |
| 10 | a setting saved through the screen is the value the API reads back, and the front end carries it |
| 11 | the SEO screen's fields round-trip (camelCase keys — `seo.titleTemplate`, one vocabulary) |
| 12 | the features screen shows every declared switch **and** where the value comes from |
| 14 | the audit log records what this run wrote |
| 15 | hiding a sidebar item in menu-config writes the blob **and** the sidebar stops offering it; un-hiding restores it |
| 16 | the URL manager states its empty state honestly |
| 17 | search finds published content |

Excluded by design — the widgets screen, and the plugins registry/enable/
disable/settings, which have their own suites.

Anything the suite *changes* (a setting value, the language set, the theme, a
sidebar item) is snapshotted first and restored after: a test that leaves the
operator's site in a different state has failed even when every assertion
passed. Fixtures are prefixed `afn` and swept at both ends.

Two behaviours that look like defects and are not — both are recorded in the
suite's comments so the next reader does not chase them:

- **the admin cookie is `Path`-scoped**, so a browser fetch from the admin page
  to `/media/<key>` carries no session and the policy's session gate answers
  404. That is rule 77 working; the credentialed read is `media.test.mjs`' job.
- **the front end answers `Cache-Control: public, max-age=60`**, so a "did my
  edit reach the front end" check must defeat both that and the shared context
  HTTP cache (a unique query parameter does both; the router matches the path,
  never the search).

## 3. Vision + functional (`_ui-midscene.mjs`)

Driven by [MidScene](https://github.com/web-infra-dev/midscene). It needs **any**
OpenAI-compatible vision model:

```bash
setx MIDSCENE_MODEL_API_KEY "sk-..."     # once, persisted for the machine
setx MIDSCENE_MODEL_NAME "qwen-vl-max"   # qwen-vl-max / gpt-4o / glm-4v / doubao-vision …
```

With no key the script prints that instruction and exits **0** — a missing key
is not a red scheduled run.

- **visual suite** — per screen: no error dialog, no blank panel, no stuck
  spinner, every label a real readable word (no raw `core.nav.*` keys, no
  untranslated English fallback)
- **functional suite** — plain-language workflows across seams a selector cannot
  cross: create a site → switch to it → publish a post → the post is reachable
  on that site's front end → clean up

Screenshots land in `.tmp-ui/screens/`, findings in `.tmp-ui/ui-midscene.json`.

## 4. The runner and the schedule

```bash
npm run test:ui            # run, write .tmp-ui/ui-summary.json
npm run test:ui:report     # run, and file new findings as GitHub issues
npm run schedule:ui        # register the daily 09:00 Windows task
```

The runner owns three things a browser script cannot:

- **the dev server**: it starts `wrangler dev` (adopting a healthy one when the
  machine already has it), waits for `/api/v1/health`, and **always** takes it
  down again — including on a thrown runner error
- **the environment**: it clears `HTTP_PROXY`/`HTTPS_PROXY` before starting the
  server. This is not hygiene: with the proxy variables set, `workerd` crash-loops
  on this machine ("The Workers runtime crashed unexpectedly and is being
  restarted"), every request hangs, and every UI check fails against a server
  that only *looks* up
- **the issue tracker**: with `--report` it files one issue per finding,
  deduplicated against the open issue list so a nightly run does not re-file
  yesterday's bug (`label: ui-test` is created on demand)

Findings from the current run:

- https://github.com/unifare/CFCMS/issues/5 — prefixed sites lose their prefix
  in every in-page link
- https://github.com/unifare/CFCMS/issues/6 — the prefixed site's sitemap emits
  URLs that 404

## When to run which

| You changed… | Run |
|---|---|
| `src/index.ts`, the front router, `platform/seo.ts`, `platform/frontend.ts` | black-box §8 + vision (prefix/host/default is where the bugs live) |
| the admin SPA (`public/admin/**`) | black-box §3 + §10, the whole vision suite, and the admin functional suite |
| `platform/auth.ts`, cookies, `platform/permissions.ts` | black-box §1–5b |
| theme templates (`content/themes/**`) | vision + functional |
| anything at all, before a release | `npm run test:ui` (then `--report`) |

## Honest limitations

- The vision suite is **not** deterministic: a model can mis-read a screenshot.
  Its failures are leads for a human, which is why the runner files them as
  issues rather than failing a gate.
- The admin functional suite depends on the SPA's `data-*` hooks
  (`data-new="posts"`, `data-item-eye`, `data-key="site.title"`, …). A screen
  refactor that renames one fails loudly rather than silently — which is the
  point, but it does mean the suite moves with the UI.
- Both assume `admin.path` is still the default `/admin`, and the black-box
  suite pins host-tenancy with `--host-resolver-rules`, so it cannot cover a
  real DNS host.

