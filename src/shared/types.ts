export interface Env {
  DB: D1Database;
  /**
   * This install's object bucket. **Optional**: an install without R2 serves
   * third-party-hosted media and bundled themes only. Every reader already
   * treats a miss as "fall through to the next source" (bundled assets), so
   * `?.` slots into the existing shape — but every *writer* must refuse
   * loudly instead (see `mediaUpload` / `uploadExtension`): silently dropping
   * bytes the row claims exist is the defect this repo keeps paying for.
   */
  MEDIA?: R2Bucket;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  /** Worker Loader — loads L3 theme Workers at runtime. Optional: absent on
   *  older deploys, and the runtime degrades to L1/L2 rendering when missing. */
  LOADER?: WorkerLoader;
  /** Fetcher pointing back at this Worker, handed to theme Workers so they can
   *  read content through the sandboxed theme API rather than raw bindings. */
  THEME_HOST?: Fetcher;

  /**
   * Deploy-time fallback for the platform feature switches. Optional — an
   * unset var means "no deploy-time opinion", which is *not* the same as
   * `"false"`: the per-site admin setting sits above this layer, and the
   * declared default sits below it. See `src/shared/features.ts`.
   *
   * These names are the `varName` fields of `FEATURE_SWITCHES`
   * (`shared/features.ts`). They are spelled out here rather than
   * derived because `Env` is an interface — it has no way to be computed from
   * data — and `tests/suites/architecture.test.mjs` cross-checks the two so a
   * rename cannot silently desynchronise them.
   */
  CFPRESS_CACHE_MIRROR_KV?: string;
  CFPRESS_THEME_RUNTIME_WORKER?: string;
  CFPRESS_UI_LOCALE_FOLLOW_SITE?: string;

  /**
   * Third-party image-host ("图床") API keys, one per vendor for the whole
   * install — exactly like the R2 bucket they replace is install-wide. They
   * are the *fallback*: a site key entered on the Media screen
   * (`cfpress.media.imgbb_key` / `cfpress.media.postimages_key`) wins for
   * that site, because one operator's key must not be every site's key.
   * A key in a site `settings` row would be readable by every site member
   * (`GET settings` returns raw values to anyone passing the site gate), so
   * the read path redacts sensitive values and the write path keeps a blank
   * write — see `sensitive` in `platform/setting-defs.ts`.
   *
   * Configure locally in `.dev.vars` (gitignored), in production with
   * `wrangler secret put IMGBB_API_KEY` / `wrangler secret put
   * POSTIMAGES_API_KEY`. Deliberately **not** in `wrangler.jsonc` `vars`:
   * that file is committed, and `architecture.test.mjs` fails a var no
   * switch declares. Absent means "that provider is not configured" — an
   * upload naming it answers 400 naming the missing secret, never a 500.
   */
  IMGBB_API_KEY?: string;
  POSTIMAGES_API_KEY?: string;
}
export interface User {
  id: string;
  username: string;
  email?: string | null;
  role: string;
  status: string;
}

export interface SessionUser extends User {
  sessionId: string;
  apiKeyId?: string;
  scopes?: string[];
  sites?: string[];
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
