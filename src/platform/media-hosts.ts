/**
 * Third-party image hosts ("图床") — imgbb and postimages.org.
 *
 * ## Why this module exists
 *
 * Every upload used to land in the install's own R2 bucket, and
 * `media_files.object_key` always named an R2 object. Some operators would
 * rather keep bytes off their own bill: a free image host serves the bytes,
 * and CFPress keeps the registry row — the tenant, the owner, the alt text —
 * plus the policy front door. So storage is a per-site choice with three
 * values: `"r2"` (the historical behaviour), `"imgbb"`, `"postimages"`.
 *
 * ## What this module does and does not do
 *
 * It speaks the two vendors' upload APIs and reads one site setting (the
 * provider choice), and nothing else: bytes in, a direct file URL (and a
 * deletion URL when the vendor gives one) out. It never decides policy. The
 * caller (`mediaUpload` in `src/api.ts`) owns the tenant check, the
 * permission gate, the row insert and the error contract; the read path
 * (`src/index.ts`) owns the redirect. A module that uploads *and* records
 * would let a future caller upload without recording (or record without
 * uploading), and those are the two halves of the "row with no bytes" defect
 * that motivated the `arrayBuffer`-before-`put` rule in `mediaUpload`.
 *
 * ## Secrets: site keys first, environment as fallback
 *
 * Both vendors need an API key. The key is entered per site on the Media
 * screen (`cfpress.media.imgbb_key` / `cfpress.media.postimages_key`,
 * declared `sensitive: true` — never echoed back, blank writes keep the
 * stored value), with the install-wide environment secrets (`IMGBB_API_KEY`
 * / `POSTIMAGES_API_KEY` via `wrangler secret put` in production, `.dev.vars`
 * locally) as fallback — exactly like the R2 bucket they replace is
 * install-wide. A key in a readable row would be readable by every site
 * member (`GET settings` returns raw values to anyone passing the site gate),
 * so the read path redacts sensitive values and the write path preserves on
 * empty; the provider *choice* stays per site (`cfpress.media` → `provider`).
 * The effective key is `readMediaKeys()` — site first, env fallback — and it
 * is the only thing upload callers may read.
 *
 * ## postimages.org is reverse-engineered
 *
 * Postimages publishes no official upload documentation; what is implemented
 * here is the account-key endpoint (`https://api.postimage.org/1/upload`,
 * verified live: no key → HTTP 200 with `<error>Invalid API Key</error>`),
 * which takes the same multipart shape as the documented imgbb call. The
 * *website* upload flow (`POST /json` from the homepage) answers automated
 * callers with 403 ("Automated uploads are not allowed via the website.
 * Please use the official API"), so it is deliberately not implemented —
 * a client that scrapes the homepage works until it doesn't, and "until it
 * doesn't" is a Monday morning. If postimages changes its official response
 * shape, the tolerant XML parsing below still extracts whatever direct-URL
 * tag survives, and anything else surfaces as a legible 502 rather than a
 * silent row with no bytes.
 */

/** Where one site's new uploads go. `"r2"` is the historical behaviour. */
export type MediaStorageProvider = "r2" | "imgbb" | "postimages";

import { MEDIA_POLICY_SETTINGS_KEY } from "./media-policy";

/** The closed set — anything else in the config is a typo, not a provider. */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(["r2", "imgbb", "postimages"]);

export function isMediaStorageProvider(v: unknown): v is MediaStorageProvider {
  return typeof v === "string" && KNOWN_PROVIDERS.has(v);
}

/**
 * Read the provider out of a site's `cfpress.media` JSON.
 *
 * Absent (or a non-object, or a non-string `provider`) means `"r2"`: every
 * install that never heard of this feature keeps working exactly as before,
 * with no migration-time backfill to guess anyone's intent. A *present but
 * unknown* value is returned as-is so the caller can refuse it with a legible
 * 400 — silently storing to R2 while the operator believes imgbb has the
 * bytes would be the "answered success, changed nothing" shape this repo
 * keeps paying for.
 */
export function mediaProviderOf(raw: unknown): MediaStorageProvider | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "r2";
  const p = (raw as Record<string, unknown>).provider;
  if (p === undefined || p === null || p === "") return "r2";
  return String(p);
}

/** The `uploads/{siteId}/remote/…` namespace remote rows are keyed under. */
export function isRemoteObjectKey(key: string, siteId: string): boolean {
  return (
    typeof key === "string" &&
    siteId.length > 0 &&
    key.startsWith(`uploads/${siteId}/remote/`)
  );
}

/** Name a remote row's key. Same segments as R2 keys plus the `remote/`
 *  discriminator, so `mediaKeyBelongsToSite()` keeps answering from the key
 *  alone and the read path can branch without a database lookup on the R2
 *  hot path. */
export function remoteObjectKey(siteId: string, provider: string, id: string, safeName: string): string {
  return `uploads/${siteId}/remote/${provider}/${id}-${safeName}`;
}

/** What an upload to a vendor returned. `url` is the only required field —
 *  without a direct file URL there is nothing to record, and recording a row
 *  without bytes is the defect this whole module exists to prevent. */
export interface RemoteUploadResult {
  /** Direct file URL (the bytes' address, `https://…`). */
  url: string;
  /** Vendor deletion URL, when the vendor gave one. Best-effort only. */
  deleteUrl: string | null;
  remoteId: string | null;
  width: number | null;
  height: number | null;
}

export interface RemoteUploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** `fetch` is injectable so tests can drive the vendor contract without the
 *  network. Default is the global — the only fetch a Worker has. */
type FetchFn = typeof fetch;

/**
 * What we present as on vendor requests. imgbb's edge filters non-browser
 * callers, so every working uploader (ShareX presets, the API docs' own curl)
 * presents a browser identity. It does not beat an IP flag — code 103 means
 * the *network* is refused whatever the UA says, and that case gets its own
 * actionable error below instead of another header tweak.
 */
const VENDOR_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * One retry, and only where a retry cannot double-store: 429 / 5xx / network
 * throws — statuses where the vendor almost certainly recorded nothing. A 400
 * is a *verdict* (the bytes were examined and refused), so retrying it can
 * only mint a duplicate next to an object nobody recorded the deletion URL
 * for. Intermittent edge filtering plus a flaky uplink is exactly the shape
 * this retries: the first attempt eats the flake, the second usually lands.
 */
async function vendorFetch(fetchFn: FetchFn, url: string, init: RequestInit): Promise<Response> {
  const withUa: RequestInit = {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), "User-Agent": VENDOR_UA },
  };
  try {
    const first = await fetchFn(url, { ...withUa, signal: AbortSignal.timeout(30_000) });
    if (first.status !== 429 && (first.status < 500 || first.status > 504)) return first;
    await new Promise((r) => setTimeout(r, 1500));
    return await fetchFn(url, { ...withUa, signal: AbortSignal.timeout(30_000) });
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchFn(url, { ...withUa, signal: AbortSignal.timeout(30_000) });
  }
}

function fail(provider: string, status: number | string, detail: unknown): never {
  const snippet = String(detail ?? "").slice(0, 160);
  throw new Error(`${provider}: upload failed (${status})${snippet ? `: ${snippet}` : ""}`);
}

/**
 * Upload to imgbb (`https://api.imgbb.com/1/upload`).
 *
 * Documented contract: multipart `image` (binary), key in the query string,
 * optional `name` / `expiration`. Response is JSON with `success: true` and
 * `data.display_url` (the direct file URL), `data.delete_url`, dimensions and
 * an id. Anything else — non-2xx, `success !== true`, no direct URL — throws
 * with the vendor's own message, truncated, so the operator sees *their*
 * answer instead of our paraphrase.
 */
export async function uploadToImgbb(
  input: RemoteUploadInput,
  opts: { apiKey: string; expiration?: number; fetchFn?: FetchFn },
): Promise<RemoteUploadResult> {
  const apiKey = String(opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("imgbb: missing API key (enter it on the Media screen, or set IMGBB_API_KEY via `wrangler secret put`)");
  const fetchFn = opts.fetchFn ?? fetch;

  const name = String(input.filename || "upload").slice(0, 120);
  const form = new FormData();
  form.append("image", new Blob([input.bytes as BlobPart], { type: input.mimeType || "application/octet-stream" }), name);
  let url = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}&name=${encodeURIComponent(name)}`;
  if (opts.expiration != null && Number.isFinite(opts.expiration)) {
    url += `&expiration=${Math.floor(opts.expiration)}`;
  }
  let res: Response;
  try {
    res = await vendorFetch(fetchFn, url, { method: "POST", body: form });
  } catch (e) {
    throw new Error(`imgbb: request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body || body.success !== true || !body.data) {
    // Code 103 ("forbidden to use this website") is imgbb's edge refusing the
    // *caller's network*, not the key or the bytes: a wrong key answers JSON
    // `Invalid API v1 key` instead, and the same key uploads fine from an
    // unflagged IP. It flaps per IP reputation (VPN / datacenter / shared
    // egress get flagged; residential usually passes), so the fix is on the
    // network, not in this request — say so instead of a bare 400.
    const code = (body as any)?.error?.code;
    if (code === 103 || code === "103") {
      throw new Error(
        "imgbb: this network is refused by imgbb's bot protection (code 103) — " +
        "the key is fine. Upload from an unflagged network (no VPN/datacenter egress), " +
        "retry later, or switch this site back to R2",
      );
    }
    fail("imgbb", res.status, body?.error?.message ?? body?.error ?? null);
  }
  const d = body.data;
  const direct = String(d.display_url ?? d.url ?? "");
  if (!/^https:\/\//.test(direct)) throw new Error("imgbb: response had no direct image URL");
  return {
    url: direct,
    deleteUrl: typeof d.delete_url === "string" && d.delete_url ? d.delete_url : null,
    remoteId: d.id != null ? String(d.id) : null,
    width: Number.isFinite(Number(d.width)) ? Number(d.width) : null,
    height: Number.isFinite(Number(d.height)) ? Number(d.height) : null,
  };
}

/** First `<tag>…</tag>` whose body has no nested tags (direct values only —
 *  a container tag's inner markup is never a URL). Case-insensitive, tolerant
 *  of attributes, because the vendor's exact casing is not a contract. */
function xmlTag(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<>]*)</${tag}>`, "i").exec(text);
  const v = m ? m[1].trim() : "";
  return v || null;
}

/**
 * Upload to postimages.org (`https://api.postimage.org/1/upload`).
 *
 * Account-key contract, verified live against the endpoint (no key → HTTP 200
 * carrying `<error>Invalid API Key</error>`): multipart `key` + `file` (+
 * `numfiles: "1"`), XML response. The XML is parsed tolerantly — the first
 * surviving direct-URL tag among `direct`, `image`, `url`, `thumb` wins — and
 * an `<error>` element (or HTTP `success="0"`) throws with the vendor's own
 * text. Optional `expire` / `gallery` / `optsize` stay at the platform
 * defaults (permanent, no resize): fewer knobs than the web form offers, on
 * purpose — every knob here is a knob the Media screen would have to explain.
 */
export async function uploadToPostimages(
  input: RemoteUploadInput,
  opts: { apiKey: string; fetchFn?: FetchFn },
): Promise<RemoteUploadResult> {
  const apiKey = String(opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("postimages: missing API key (enter it on the Media screen, or set POSTIMAGES_API_KEY via `wrangler secret put`)");
  const fetchFn = opts.fetchFn ?? fetch;

  const form = new FormData();
  form.append("key", apiKey);
  form.append("file", new Blob([input.bytes as BlobPart], { type: input.mimeType || "application/octet-stream" }), String(input.filename || "upload"));
  form.append("numfiles", "1");
  let res: Response;
  try {
    res = await vendorFetch(fetchFn, "https://api.postimage.org/1/upload", {
      method: "POST",
      body: form,
    });
  } catch (e) {
    throw new Error(`postimages: request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) fail("postimages", res.status, text);
  const err = xmlTag(text, "error");
  if (err || /success="0"/.test(text)) throw new Error(`postimages: ${err ?? "upload rejected"}`);
  const direct = xmlTag(text, "direct") ?? xmlTag(text, "image") ?? xmlTag(text, "url") ?? xmlTag(text, "thumb");
  if (!direct || !/^https:\/\//.test(direct)) throw new Error("postimages: response had no direct image URL");
  return {
    url: direct,
    deleteUrl: xmlTag(text, "delete_url") ?? xmlTag(text, "deleteurl") ?? xmlTag(text, "delete"),
    remoteId: xmlTag(text, "id"),
    width: null,
    height: null,
  };
}

/**
 * Remove a remote object through the vendor's deletion URL. Best-effort by
 * contract: it returns whether the vendor confirmed, and it **never throws** —
 * a remote host being down must not block the local delete (the row is ours;
 * the bytes are theirs). Callers log the `false`, they do not branch on it.
 */
export async function deleteRemoteImage(
  provider: MediaStorageProvider,
  deleteUrl: string | null,
  fetchFn?: FetchFn,
): Promise<boolean> {
  if (!deleteUrl || !/^https:\/\//.test(deleteUrl)) return false;
  try {
    const res = await vendorFetch(fetchFn ?? fetch, deleteUrl, { method: "GET" });
    // imgbb answers its deletion URL with a 200 page; anything 2xx–3xx counts.
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

/** What the Media screen needs to render its storage panel — and nothing it
 *  must not see. The provider *choice* is per site; whether each vendor key
 *  is configured is a boolean, because the keys themselves must never leave
 *  the server (`GET settings` redacts sensitive values to anyone passing the
 *  site gate, so a key in a readable row is a key in many hands). */
export interface MediaStorageStatus {
  provider: MediaStorageProvider;
  imgbbKey: boolean;
  postimagesKey: boolean;
}

export interface MediaHostKeys {
  imgbb: string;
  postimages: string;
}

type KeyEnv = {
  DB: D1Database;
  IMGBB_API_KEY?: string;
  POSTIMAGES_API_KEY?: string;
};

/**
 * The effective vendor keys for one site: the site's own setting first, the
 * install-wide environment secret as fallback. Either layer may be empty —
 * the caller turns "both empty" into a 400 naming the missing secret, never
 * a 500, and never a silent R2 upload.
 */
export async function readMediaKeys(env: KeyEnv, siteId: string): Promise<MediaHostKeys> {
  let siteImgbb = "";
  let sitePostimages = "";
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE site_id=? AND key IN ('cfpress.media.imgbb_key','cfpress.media.postimages_key')")
      .bind(siteId)
      .all();
    for (const r of ((rows.results as any[]) ?? [])) {
      if (r.key === "cfpress.media.imgbb_key") siteImgbb = String(r.value ?? "");
      if (r.key === "cfpress.media.postimages_key") sitePostimages = String(r.value ?? "");
    }
  } catch {
    /* an unreadable settings table means no site keys; env fallback applies */
  }
  const envImgbb = String(env.IMGBB_API_KEY ?? "").trim();
  const envPostimages = String(env.POSTIMAGES_API_KEY ?? "").trim();
  return {
    imgbb: siteImgbb.trim() || envImgbb,
    postimages: sitePostimages.trim() || envPostimages,
  };
}

export async function readMediaStorage(env: KeyEnv, siteId: string): Promise<MediaStorageStatus> {
  let provider: MediaStorageProvider = "r2";
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?")
      .bind(siteId, MEDIA_POLICY_SETTINGS_KEY)
      .first<{ value: string | null }>();
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value)) as unknown;
      const p = mediaProviderOf(parsed && typeof parsed === "object" ? parsed : {});
      if (isMediaStorageProvider(p)) provider = p;
    }
  } catch {
    provider = "r2";
  }
  const keys = await readMediaKeys(env, siteId);
  return {
    provider,
    imgbbKey: keys.imgbb.length > 0,
    postimagesKey: keys.postimages.length > 0,
  };
}
