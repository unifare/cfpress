# CFPress

**A WordPress-style CMS that runs entirely on Cloudflare's edge — and never executes third-party code.**

[![License: AGPL-3.0 + Commercial](https://img.shields.io/badge/license-AGPL--3.0%20%2B%20Commercial-blue.svg)](LICENSE)
[![Platform: Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-28%20suites-brightgreen.svg)](package.json)

**Live demo → [cfpress-demo.2aass.workers.dev](https://cfpress-demo.2aass.workers.dev)**

Front end and admin, both running on Cloudflare's free tier — no server, no container, no
build step. The [admin](https://cfpress-demo.2aass.workers.dev/admin/) signs in with the
first-login default described under [Quick start](#quick-start). It is a public sandbox:
everything in it is demo content and may be reset without notice.

![The CFPress front page, running the shipped 墨白 MOBAI theme](assets/screenshots/hero.jpg)

CFPress is a self-hosted content management system built on Cloudflare Workers, D1, R2 and KV.
It gives you what you expect from WordPress — themes, plugins, multi-site, multilingual
content, members, a media library, a block editor — without a server to maintain, and
without the extension model that makes WordPress installs a standing security target.

---

## What it looks like

Every screenshot in this README is a real capture of a local `wrangler dev` run: 24 migrations
applied, demo content seeded in two languages, five images uploaded into R2, three sites served
from one Worker. Nothing here is a mockup.

**Dark mode is not a second set of pages.** The theme declares its colours once, as tokens; the
whole site — front page, article, admin-adjacent surfaces — follows.

![The same front page in dark mode](assets/screenshots/hero-dark.jpg)

**Articles are rendered server-side, in a single pass.** Code blocks, pull quotes, images and
tags all come out of the same declarative template. The engine has no way to run anything else —
which is the point.

![A rendered article](assets/screenshots/post.jpg)

**The admin is sixteen modules in one Worker.** Content, media, themes, plugins, languages,
sites, users, SEO, menus, widgets, redirects, activity — no separate service, no build step in
the repository.

![The admin dashboard](assets/screenshots/admin-dashboard.png)

**One row, two languages.** The switcher at the top of the editor is the post's language
versions. Each locale gets its own slug, its own URL, its own feed entry — not a translated
copy stored in a plugin's side table.

![The block editor, with the language-version switcher at the top](assets/screenshots/admin-editor.png)

---

## Why CFPress

### Third-party code never runs

WordPress's plugin model lets any plugin execute arbitrary PHP inside your request path.
That single design decision is the root cause of most of its security record.

CFPress makes the opposite choice. **Extensions are data, not code.** A theme is a package
of declarative templates rendered by a restricted engine; a plugin is a manifest that
declares capabilities. An uploaded extension ZIP is stored — it is never executed by the
Worker. There is no hook that hands your request to someone else's program.

The cost is real and worth stating plainly: declarative theming is less expressive than
arbitrary PHP. If you need a plugin to do something the manifest vocabulary cannot express,
CFPress will not let you hack it in. That is the trade being made, on purpose.

A theme can also declare the *business capabilities* it needs — custom post types, routes,
custom fields, blocks — and CFPress materialises them at install time. The theme describes
what the site is; it does not run code to make it so.

![A theme declaring custom post types, routes, fields and blocks](assets/screenshots/admin-themes.png)

### Multi-site and multilingual are built in, not bolted on

In WordPress, multilingual sites need a third-party plugin and multi-site needs a network
configuration. In CFPress both are first-class at the database level:

- **Content languages** are translation rows per locale, each with its own slug. `/en/blog/hello`
  and `/zh-CN/blog/ni-hao` can be the same post.
- **Explicit locale prefixes 404 rather than silently serving another language** — a missing
  translation is a missing page, not a surprise.
- `hreflang` alternates, per-locale feeds and per-locale sitemaps are emitted by the platform.
- **Sites** are isolated at the storage layer: every table carries an ownership declaration,
  every query is scoped by `site_id`, and deleting a site leaves no registry residue.

Three sites, one Worker. Routing matches a request by path prefix first (longest match wins),
then by host; content, settings, menus, media and the active theme are all stored per site.

![Three sites on one Worker](assets/screenshots/admin-sites.png)

Four language layers, kept independent on purpose: the languages the *site* serves, the
languages a *piece of content* is written in, the language of the *admin interface*, and the
languages a *theme's business data* is translated into. Running an English-only site with a
Chinese admin is a normal configuration here, not a workaround.

![The four language layers](assets/screenshots/admin-languages.png)

### A complete CMS inside Cloudflare's free tier

Workers + D1 + R2 + KV all have free allowances. CFPress is built to run inside them:
no paid binding is required, and the one optional capability that needs a paid plan
(a sandbox for themes that ship their own Worker) is off by default and degrades cleanly
when absent. A free-plan deploy is a working CMS that declines that one theme flavour —
not a broken one.

---

## Quick start

```bash
git clone https://github.com/unifare/cfpress.git
cd cfpress
npm install
```

Create the two account-scoped resources, then record their ids:

```bash
npx wrangler d1 create cfpress
npx wrangler kv namespace create CACHE
```

Write the returned ids into a gitignored **`wrangler.ids.json`**:

```json
{
  "REPLACE_WITH_D1_DATABASE_ID": "<id from `wrangler d1 create`>",
  "REPLACE_WITH_KV_NAMESPACE_ID": "<id from `wrangler kv namespace create`>"
}
```

Start the dev server:

```bash
npm run dev
```

The dev server listens on **47913** (not wrangler's default 8787 — 8787 collides with every
other Wrangler project on the machine, and two `wrangler dev` instances fighting over one
local D1 is how you get `SQLITE_BUSY` with no obvious cause). Override with `CFP_PORT`.

Open `http://localhost:47913/admin/` and sign in.

> **On first boot the Worker creates a single administrator account with a publicly known
> default password. Change it immediately — before the site is reachable from the internet.**
> Passwords are stored as PBKDF2 hashes and the plaintext is never persisted, but a default
> that is written in a public repository is not a secret. Sessions are signed cookies with a
> 14-day TTL.

### Deploy

```bash
npm run db:migrate   # apply migrations to the remote D1
npm run deploy       # build the local config and deploy
```

Migrations must run **before** deploy: new code writes new columns, and a missing column is a
500. The reverse order is harmless.

Two commands refuse to do the wrong thing on purpose. `deploy` will not run while the
generated config still contains `REPLACE_WITH_...` placeholders — deploying with those does not
fail loudly, it produces a Worker whose database binding points nowhere. And `wrangler.local.jsonc`
is *generated*, never hand-edited; it is derived from the committed `wrangler.jsonc` plus your
`wrangler.ids.json`.

---

## What's in the box

| Area | What you get |
|---|---|
| **Content** | Posts and pages, categories, tags, a block editor, revisions, autosave, scheduled publishing on a 5-minute cron |
| **Media** | R2-backed library, a shared picker, ownership scoping per site |
| **Multi-site** | Storage-level site isolation, per-site settings, per-site user roles |
| **Languages** | Content languages, UI languages, per-locale slugs, `hreflang`, per-locale feeds and sitemaps |
| **Members** | Front-end registration and accounts, separate from admin identity |
| **Access control** | `admin` / `editor` / `author` capability matrix, enforced server-side |
| **Themes** | Declarative template engine, packaged as ZIP, stored in R2, shipped with 3 examples |
| **Plugins** | Manifest-declared capabilities, declared settings schema, notification channels |
| **Search** | Search API over published content, plus an admin search screen |
| **Caching** | Content-cache versioning, invalidated automatically when content changes |

---

## How it compares

| | CFPress | WordPress | Ghost | Strapi |
|---|---|---|---|---|
| Runtime | Cloudflare edge (Workers) | PHP + a server | Node + a server | Node + a server |
| Server to maintain | none | yes | yes | yes |
| Cost to run a small site | free tier | VPS or hosting | VPS or hosted plan | VPS or hosted plan |
| Third-party code executes | **never** | yes (PHP plugins) | yes (Node) | yes (Node) |
| Multi-site | built in | network config | not built in | not built in |
| Multilingual content | built in, per-locale slugs | plugin | partial | plugin |
| Data store | D1 (SQLite) + R2 + KV | MySQL | MySQL | Postgres/MySQL |

Not a like-for-like benchmark — it is a comparison of shapes. CFPress is the right choice when
you want a CMS with no server and a smaller attack surface. It is the wrong choice when you need
the WordPress plugin ecosystem, because that ecosystem is precisely what it refuses to run.

---

## Architecture

The Worker source is layered, and the layers only depend rightward:

```
shared  <-  platform  <-  rendering  <-  extensions  <-  index.ts
```

| Layer | Responsibility |
|---|---|
| `src/shared/` | Primitives with no domain knowledge: crypto, cache versioning, feature switches |
| `src/platform/` | Domain services: auth, sites, members, i18n, media policy, admin menus |
| `src/rendering/` | The declarative template engine and the block renderer |
| `src/extensions/` | Theme and plugin contracts, manifest validation, the plugin runtime |
| `src/index.ts` | Request routing and composition |

```
content/          what gets loaded into a running install
  themes/           shipped themes (default, prism, fixture)
  plugins/          shipped plugins (notify)
  migrations/       ordered D1 migration stream
public/admin/     the no-build admin SPA, served as static assets
scripts/          scaffolder, deploy helpers, the launcher pair
tests/            28 suites — see below
```

### Tests

```bash
npm test                    # every suite
sh scripts/cfpress.sh test  # the launcher, one suite per process
```

The suites are behavioural and architectural, not unit tests: they assert the invariants the
system is supposed to hold — layer boundaries, tenant isolation, per-language URL resolution,
cache invalidation, manifest validation, the admin SPA's contract. Several are *reverse-validated*
by injection tools under `tests/tools/`, because a guard that has never been seen to go red is
indistinguishable from no guard at all.

### The launcher

`scripts/cfpress.sh` (POSIX sh) and `scripts/cfpress.ps1` (Windows PowerShell) wrap the common
commands into one entry point with a numeric menu. A parity suite fails if the two ever drift apart.

```bash
sh scripts/cfpress.sh            # interactive menu
sh scripts/cfpress.sh dev        # start the dev server
sh scripts/cfpress.sh migrate:local
sh scripts/cfpress.sh test       # each suite in its own process
sh scripts/cfpress.sh doctor     # environment report
```

---

## Writing a theme

A theme is a directory with a `theme.json` manifest, `templates/` and optional `langs/`:

```
content/themes/mytheme/
  theme.json
  templates/
    index.html
    single.html
    page.html
    404.html
    parts/
      layout.html
      header.html
      footer.html
  langs/
    en.json
    zh-CN.json
```

Templates are declarative HTML with a small, deliberately restricted expression language —
placeholders, `@extends` / `@section` / `@include` / `@query`, and ten helpers
(`len`, `default`, `lower`, `upper`, `truncate`, `join`, `number`, `date`, `contains`).
There is no arithmetic and no arbitrary code. Scaffold one with:

```bash
npm run make:theme
```

## Writing a plugin

A plugin is a manifest that declares what it needs. It can own database tables, contribute admin
menus, expose settings with a declared schema, and send notifications over channels. It cannot
run code in the request path. Scaffold one with:

```bash
npm run make:plugin
```

---

## Project status

Pre-1.0. The core is complete and running: multi-site, multilingual, members, media, themes,
plugins, scheduled publishing, search. APIs may still change before 1.0.

This repository ships the runtime, the admin interface, the shipped themes and plugins, and the
test suites. The project's internal design documents — the architecture record, the change
contract, and the development handover — are maintained privately and are not part of this
distribution.

---

## License

CFPress is licensed under the **GNU Affero General Public License v3.0**, with a **commercial
license available** as an alternative. See [LICENSE](LICENSE) for the full AGPL text and
[COMMERCIAL.md](COMMERCIAL.md) for when you need the commercial option.

In short:

- **Free under AGPL-3.0** for running your own site, internal systems, evaluation, study, and any
  project that is itself AGPL-3.0.
- **Commercial license required** if you offer CFPress to third parties as a hosted service
  without releasing your modifications, or embed it in a closed-source product.

The AGPL adds one obligation over the plain GPL: if you run a *modified* version as a network
service, you must offer the corresponding source to that service's users. Running it unmodified
as your own site carries no such obligation beyond keeping the notices intact.

Contributions require agreeing to the [CLA](CLA.md) — that is what makes the dual license
possible, since the project must hold sufficient rights to offer a commercial option at all.

## Trademarks

CFPress is not affiliated with, endorsed by, or sponsored by Cloudflare, Inc. or the WordPress
Foundation. "Cloudflare" and "WordPress" are trademarks of their respective owners and are used
here only to describe what this software runs on and what it is comparable to.
