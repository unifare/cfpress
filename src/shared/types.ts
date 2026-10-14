export interface Env {
  DB: D1Database;
  /**
   * Object storage for the media library and for uploaded themes/plugins.
   *
   * Optional, and read through `shared/media-store.ts` rather than directly.
   * `wrangler.jsonc` declares it, so every normal install has one — but the
   * render path does not need it: a bundled theme's files come from `ASSETS`,
   * and `activeTheme` probes both sources. Declaring it required made the whole
   * site answer `1101` on a deploy that omitted the bucket, for a capability the
   * renderer never used.
   *
   * Having the binding is not the same as using it. `media_store_r2` — a feature
   * switch, off by default and per site — decides whether this deployment's
   * storage is actually wired up; see `shared/media-store.ts`. A deployment that
   * declares the bucket but leaves the switch off behaves exactly like one that
   * never had it, which is what lets the switch be the operator's answer rather
   * than the config file's.
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
  CFPRESS_MEDIA_STORE_R2?: string;

  /**
   * How often a deployment that has declared itself a public demo restores its
   * demo content, in minutes.
   *
   * Deliberately **not** a feature switch, and deliberately not a key in
   * `wrangler.jsonc`. A switch is a capability the admin can also toggle per
   * site; this is a property of the *deployment*, and it is the one setting a
   * visitor with admin access must not be able to switch off — an interval
   * stored as a site setting would be editable by the very people it exists to
   * clean up after. Absent on every normal install, which is exactly what keeps
   * the reset dormant (see `maybeResetDemoContent` in `api.ts`).
   */
  CFPRESS_DEMO_RESET_MINUTES?: string;
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
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
