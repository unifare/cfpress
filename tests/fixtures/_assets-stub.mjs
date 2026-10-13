/**
 * A REAL disk-reading stand-in for the Worker's ASSETS binding.
 *
 * ## Why this exists
 *
 * Every suite's env used to stub ASSETS as `fetch() -> new Response("asset")`.
 * That was fine while ASSETS only served the admin SPA, but since bundled
 * themes ship through the same binding (`src/shared/bundled.ts` reads
 * `https://bundled.local/themes/<name>/<path>` via `env.ASSETS.fetch`), a
 * fake stub turns "the bundled theme renders out of the box" into a claim
 * nothing can falsify — and, worse, a stub returning 200 for EVERYTHING makes
 * the fallback look like it works even when the file is missing. A stub that
 * cannot go red is not a test (the fake-green lesson, HANDOVER §12).
 *
 * This stub serves real files from the repo's `public/` directory — the same
 * directory wrangler uploads as assets — so:
 *   - `public/themes/**` (synced from `content/themes/**` by
 *     `scripts/sync-bundled-themes.mjs`) is genuinely readable at runtime;
 *   - a missing file yields a real 404, and the runtime's own fallback logic
 *     has to cope with it;
 *   - the admin SPA paths used by index.ts (`env.ASSETS.fetch(request)`) are
 *     served from disk too.
 *
 * Usage: `ASSETS: assetsStub()` in the env harness, replacing the fake.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** MIME types for the extensions the runtime actually reads. Unknown -> octet-stream. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function serveFromDisk(pathname) {
  // The assets pipeline maps the URL path onto `public/` 1:1. Reject anything
  // that would resolve outside it — the same refusal the real binding applies.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel.length === 0) return null;
  const abs = resolve(PUBLIC_ROOT, rel);
  if (abs !== PUBLIC_ROOT && !abs.startsWith(PUBLIC_ROOT + sep)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  return new Response(readFileSync(abs), {
    status: 200,
    headers: { "content-type": MIME[ext] || "application/octet-stream" },
  });
}

export function assetsStub() {
  return {
    async fetch(input) {
      // The binding is called two ways: with a Request object (index.ts
      // forwarding /admin to assets) and with a plain URL string
      // (bundledThemeFile). Normalise both to a pathname.
      let pathname;
      try {
        if (typeof input === "string") pathname = new URL(input).pathname;
        else pathname = new URL(input.url).pathname;
      } catch {
        return new Response("bad assets request", { status: 400 });
      }
      const res = serveFromDisk(pathname);
      return res || new Response("asset not found: " + pathname, { status: 404 });
    },
  };
}
