export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
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
