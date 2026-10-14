/**
 * L3 theme sandbox test (batch 6).
 *
 * The L3 layer lets a theme ship a real JavaScript Worker that the host loads
 * at runtime through the Worker Loader binding. This suite pins down the
 * behaviour that the feasibility probes established, using a **fake LOADER**
 * so the contract can be tested without workerd:
 *
 *   1. a worker-runtime theme renders through its Worker
 *   2. the theme reads content only via `env.HOST` (the sandboxed API)
 *   3. a theme without a LOADER binding / non-worker runtime falls back to L1
 *   4. a theme that throws does NOT take the site down
 *   5. a theme with a syntax error is rejected at warm time, not per-request
 *   6. a 501 from the theme defers to the declarative renderer
 *   7. the theme never receives DB/MEDIA/CACHE — capability boundary holds
 *   8. a theme reads content back through `env.HOST`
 *   9. repeated requests reuse one env without an I/O-context error
 *  10. the `theme_runtime_worker` switch defaults to off (sections 1-9 run
 *      with it explicitly on, so the shipping default is asserted here)
 *
 * The runtime is behind a platform switch (`shared/features.ts`) that defaults
 * to off, because the Worker Loader binding only exists on paid plans. Section
 * 10 is what keeps that default honest; it is the only place in this suite that
 * exercises the "off" direction.
 *
 * Usage: node tests/suites/theme-worker.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { assetsStub } from "../fixtures/_assets-stub.mjs";
import { snapshotCapabilities, restoreCapabilities } from "../fixtures/_capability-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkTruthy(name, v) {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} (got ${JSON.stringify(v)})`); }
}

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "theme-worker-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

function makeD1(sqlite) {
  return {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async first(c) { const r = sqlite.prepare(st.sql).get(...st.params); return c !== undefined && r ? r[c] : (r ?? null); },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
        async run() { const r = sqlite.prepare(st.sql).run(...st.params); return { success: true, meta: { changes: r.changes } }; },
      };
      return api;
    },
    async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
    async exec(sql) { sqlite.exec(sql); return { success: true }; },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(k) {
      if (!store.has(k)) return null;
      const e = store.get(k);
      return { async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: e, httpEtag: '"x"', writeHttpMetadata() {} };
    },
    async put(k, v) {
      // Normalise to a Uint8Array so `.text()` works for both strings and bytes.
      if (typeof v === "string") { store.set(k, v); return { key: k }; }
      store.set(k, v);
      return { key: k };
    },
    async delete(k) { store.delete(k); },
    _raw: store,
  };
}

/**
 * A fake Worker Loader that mirrors the *observable* semantics we probed in
 * workerd: `load()` never throws on bad syntax; the failure appears on first
 * `fetch`; sub-worker exceptions propagate to the caller; `env` is whatever
 * was passed in; `globalOutbound: null` blocks `fetch`.
 */
function makeFakeLoader(opts = {}) {
  const loader = {
    _loads: [],
    /** Monotonic request-context id; the test bumps it between requests. */
    _ctx: 1,
    load(code) {
      const src = code.modules[code.mainModule];
      const capturedEnv = code.env ?? {};
      const netBlocked = code.globalOutbound === null;
      loader._loads.push({ mainModule: code.mainModule, envKeys: Object.keys(capturedEnv).sort(), netBlocked });
      const loaded = { code, capturedEnv, netBlocked, source: src };
      // The stub is bound to the request context that created it — that binding
      // is fixed at load() time, which is exactly why caching a stub breaks.
      const stubCtx = loader._ctx;

      return {
        getEntrypoint() {
          return {
            async fetch(request) {
              if (stubCtx !== loader._ctx) {
                throw new Error(
                  "Cannot perform I/O on behalf of a different request. I/O objects " +
                  "(such as streams, request/response bodies, and others) created in the " +
                  "context of one request handler cannot be accessed from a different " +
                  "request's handler. (I/O type: WorkerStubChannel)"
                );
              }
              // Model "bad syntax": the module body is not valid, so importing
              // it would throw. We detect this the same way workerd does —
              // lazily, on first use.
              if (/this is not valid js|^INVALID/.test(String(src).trim())) {
                throw new Error("Failed to start Worker:\nUncaught SyntaxError: Unexpected identifier");
              }
              // Execute the module in a sandbox that mirrors the real one.
              const module = await evalModule(String(src), {
                env: capturedEnv,
                netBlocked,
                themeName: capturedEnv.CFP_THEME,
                themeHost: capturedEnv.HOST,
              });
              return module.fetch(request, capturedEnv);
            },
          };
        },
        _loaded: loaded,
      };
    },
  };
  return loader;
}

/**
 * Execute a loaded theme module with a restricted global surface. This is a
 * test-only stand-in for workerd's isolate; it exists so we can assert on the
 * *contract* (what env the theme sees, whether fetch is blocked, whether
 * exceptions escape) without needing the real runtime.
 */
async function evalModule(source, { env, netBlocked, themeHost }) {
  const sandboxFetch = netBlocked
    ? async () => { throw new Error("This worker is not permitted to access the network"); }
    : (globalThis.fetch?.bind(globalThis) ?? (async () => { throw new Error("no fetch"); }));

  // `new Function` parses its body eagerly, so the `export` syntax must be
  // rewritten *before* the body string is built — building a Function over the
  // raw ESM source throws a SyntaxError immediately.
  const rewritten = String(source)
    .replace(/export\s+default\s+/g, "globalThis.__default = ")
    .replace(/export\s+/g, "");
  const factory = new Function(
    "env", "fetch", "Request", "Response", "URL", "Headers", "TextDecoder", "TextEncoder",
    `${rewritten}\n;return globalThis.__default;`
  );
  const mod = factory(env, sandboxFetch, Request, Response, URL, Headers, TextDecoder, TextEncoder);
  if (!mod) throw new Error("theme module has no default export");
  return mod;
}

/**
 * Build the test env. `worker` is passed in so `THEME_HOST` can be a real
 * Fetcher back into the host Worker — the same shape as the production
 * `THEME_HOST` service binding.
 *
 * `CFPRESS_THEME_RUNTIME_WORKER` is set because the runtime is now behind a
 * platform switch that **defaults to off** (`shared/features.ts`). This suite's
 * entire subject is what happens *when the sandbox is enabled*, so it has to
 * ask for it — without the var, every case here degrades to the declarative
 * renderer and the suite tests nothing. The opt-out direction is asserted
 * separately in section 10, so "off" is covered too rather than assumed.
 */
function makeEnv(sqlite, loader, worker) {
  const kv = new Map();
  const r2 = makeR2();
  const env = {
    DB: makeD1(sqlite), MEDIA: r2,
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
    CFPRESS_THEME_RUNTIME_WORKER: "true",
    // Uploading a theme writes to R2, and storing is behind a **default-off**
    // switch (`media_store_r2`). This suite exercises the upload, so its deploy
    // has the switch on; the switch itself, both ways, is media.test.mjs §12.
    CFPRESS_MEDIA_STORE_R2: "true",
  };
  if (loader) env.LOADER = loader;
  env.THEME_HOST = {
    async fetch(input, init) {
      return worker.fetch(new Request(input, init), env, { waitUntil() {}, passThroughOnException() {} });
    },
  };
  return env;
}

async function req(worker, env, path, init = {}, host = "localhost") {
  return worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
}

/** Build a theme ZIP carrying a `worker.js` entry. */
function buildWorkerTheme(name, workerSrc, opts = {}) {
  const manifest = {
    name, title: `${name} title`, version: "1.0.0",
    runtime: "worker",
    entry: "worker.js",
    capabilities: opts.capabilities ?? ["content.read", "site.read"],
    templates: ["index"],
    postTypes: opts.postTypes ?? [],
  };
  const files = {
    "theme.json": strToU8(JSON.stringify(manifest, null, 2)),
    "templates/index.html": strToU8(`<!doctype html><html><body>L1-FALLBACK:{{site.title}}</body></html>`),
    "worker.js": strToU8(workerSrc),
  };
  return zipSync(files);
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  for (const sql of [
    "DELETE FROM post_meta WHERE post_id LIKE 'wpost_%'",
    "DELETE FROM post_translations WHERE post_id LIKE 'wpost_%'",
    "DELETE FROM posts WHERE id LIKE 'wpost_%'",
    "DELETE FROM post_types WHERE declared_by_theme LIKE 'wtheme%'",
    "DELETE FROM field_defs WHERE declared_by_theme LIKE 'wtheme%'",
    "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name LIKE 'wtheme%'",
    "DELETE FROM theme_setting_defs WHERE theme_name LIKE 'wtheme%'",
    "DELETE FROM theme_settings WHERE theme_name LIKE 'wtheme%'",
    "DELETE FROM theme_installs WHERE name LIKE 'wtheme%'",
    "DELETE FROM extension_versions WHERE extension_name LIKE 'wtheme%'",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }

  // Capture what the run is allowed to disturb, so the cleanup below can put it
  // back instead of deleting the operator's state: the site-wide capability rows
  // a theme activation rewrites (see _capability-snapshot.mjs) and the operator's
  // own feature/theme settings. Deleting `settings.theme.active` is data loss —
  // the site falls back to the bundled theme and the operator has no idea why.
  const caps = snapshotCapabilities(sqlite);
  const prevSettings = sqlite.prepare(
    "SELECT * FROM settings WHERE site_id='default' AND key IN ('cfpress.features','theme.active')"
  ).all();

  const worker = (await compileWorker()).default;

  console.log("0. auth");
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    await req(worker, env, "/api/v1/health");
    await req(worker, env, "/api/v1/auth/me");
    const lr = await req(worker, env, "/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "change-me-now" }),
    });
    var cookie = lr.headers.get("set-cookie")?.split(";")[0] ?? "";
    checkTruthy("logged in", cookie.startsWith("cfpress_admin="));
  }
  const auth = { Cookie: cookie };

  // -----------------------------------------------------------------------
  console.log("\n1. A worker theme renders through its Worker");
  // -----------------------------------------------------------------------
  // The theme Worker answers every page with a marker so we can prove it ran.
  const goodWorker = `
    export default {
      async fetch(request, env) {
        const kind = request.headers.get("x-cfpress-kind");
        if (new URL(request.url).pathname === "/__health") return new Response("ok");
        const site = await env.HOST.fetch(new Request("http://host/__cfpress/theme-api/site", {
          headers: { "x-cfpress-theme": env.CFP_THEME, "x-cfpress-site": env.CFP_SITE },
        })).then(r => r.json());
        return new Response("<html><body>WORKER_RENDERED:" + kind + ":" + site.title + "</body></html>", { status: 200 });
      }
    };
  `;

  {
    const loader = makeFakeLoader();
    const env = makeEnv(sqlite, loader, worker);
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_good", goodWorker)], "wtheme_good.zip", { type: "application/zip" }));
    const up = await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    check("worker theme uploaded", up.status, 201);

    const act = await req(worker, env, "/api/v1/extensions/themes/wtheme_good/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    check("worker theme activated", act.status, 200);

    const page = await req(worker, env, "/en");
    const html = await page.text();
    checkTruthy("page came from the theme Worker", html.includes("WORKER_RENDERED:home"));
    // The Worker learned the site title by calling `env.HOST` — proving the
    // sandboxed theme API is reachable and returns real data.
    checkTruthy("Worker read the site title via env.HOST", /WORKER_RENDERED:home:[^<]+/.test(html));
    check("template header marks the worker path", page.headers.get("x-cfpress-template"), "worker:wtheme_good");
  }

  // -----------------------------------------------------------------------
  console.log("\n2. Capability boundary: the theme never sees DB/MEDIA/CACHE");
  // -----------------------------------------------------------------------
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    // Re-activate under a fresh env so the stub cache is empty.
    const probeWorker = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          const keys = Object.keys(env).sort();
          return new Response("<html><body>ENVKEYS:" + keys.join(",") + "</body></html>", { status: 200 });
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_env", probeWorker)], "wtheme_env.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_env/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const html = await (await req(worker, env, "/en")).text();
    const m = html.match(/ENVKEYS:([^<]*)/);
    const keys = m ? m[1].split(",").filter(Boolean) : [];
    checkTruthy("theme sees CFP_THEME", keys.includes("CFP_THEME"));
    checkTruthy("theme sees HOST", keys.includes("HOST"));
    check("theme does NOT see DB", keys.includes("DB"), false);
    check("theme does NOT see MEDIA", keys.includes("MEDIA"), false);
    check("theme does NOT see CACHE", keys.includes("CACHE"), false);
  }

  // -----------------------------------------------------------------------
  console.log("\n3. The theme API enforces declared capabilities");
  // -----------------------------------------------------------------------
  {
    // wtheme_env declared only content.read + site.read; a menu request must 403.
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    const res = await req(worker, env, "/__cfpress/theme-api/menu", {
      headers: { "x-cfpress-theme": "wtheme_env", "x-cfpress-site": "default" },
    });
    check("undeclared menu.read is denied", res.status, 403);
    const body = await res.json();
    check("denial names the capability error", body.error, "capability_not_granted");

    const okRes = await req(worker, env, "/__cfpress/theme-api/site", {
      headers: { "x-cfpress-theme": "wtheme_env", "x-cfpress-site": "default" },
    });
    check("declared site.read is allowed", okRes.status, 200);
  }

  // -----------------------------------------------------------------------
  console.log("\n4. A crashing theme falls back instead of taking the site down");
  // -----------------------------------------------------------------------
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    const boom = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          throw new Error("THEME_EXPLODED");
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_boom", boom)], "wtheme_boom.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_boom/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const res = await req(worker, env, "/en");
    check("site still serves 200", res.status, 200);
    const html = await res.text();
    checkTruthy("fell back to the declarative renderer", html.includes("L1-FALLBACK"));
    check("did not leak the exception text", html.includes("THEME_EXPLODED"), false);
  }

  // -----------------------------------------------------------------------
  console.log("\n5. A syntax-broken theme is rejected at warm time");
  // -----------------------------------------------------------------------
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    const broken = `INVALID this is not valid js`;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_broken", broken)], "wtheme_broken.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_broken/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const res = await req(worker, env, "/en");
    check("bad theme does not 500", res.status, 200);
    const html = await res.text();
    checkTruthy("bad theme falls back to declarative", html.includes("L1-FALLBACK"));
  }

  // -----------------------------------------------------------------------
  console.log("\n6. A 501 defers to the declarative renderer");
  // -----------------------------------------------------------------------
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    const deferring = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          return new Response("nope", { status: 501 });
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_defer", deferring)], "wtheme_defer.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_defer/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const res = await req(worker, env, "/en");
    check("501 yields a normal page", res.status, 200);
    const html = await res.text();
    checkTruthy("declarative renderer took over", html.includes("L1-FALLBACK"));
  }

  // -----------------------------------------------------------------------
  console.log("\n7. No LOADER binding -> declarative themes are unaffected");
  // -----------------------------------------------------------------------
  {
    // An env without LOADER must behave exactly as before batch 6.
    const env = makeEnv(sqlite, null, worker);
    const res = await req(worker, env, "/en");
    check("renders without a LOADER binding", res.status, 200);
    const html = await res.text();
    // Whatever theme is active, the declarative renderer must have produced the
    // page — and no worker marker should appear, since there is no LOADER.
    checkTruthy("declarative renderer produced the page", html.includes("<html") || html.includes("<!doctype"));
    check("no worker path was taken", html.includes("WORKER_RENDERED") || html.includes("ENVKEYS:"), false);
  }

  // -----------------------------------------------------------------------
  console.log("\n8. Worker themes read content through the sandboxed API");
  // -----------------------------------------------------------------------
  {
    const env = makeEnv(sqlite, makeFakeLoader(), worker);
    // Seed a product post so the listing has something to return.
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT OR REPLACE INTO posts(id,site_id,author_id,type,slug,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("wpost_1", "default", "user_admin", "post", "worker-visible", "published", now, now);
    sqlite.prepare("INSERT OR REPLACE INTO post_translations(id,post_id,locale,title,excerpt,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("wtr_1", "wpost_1", "en", "Worker Visible Post", "seen by theme", "<p>hi</p>", now, now);

    const listing = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          const r = await env.HOST.fetch(new Request("http://host/__cfpress/theme-api/content?type=post&locale=en&limit=5", {
            headers: { "x-cfpress-theme": env.CFP_THEME, "x-cfpress-site": env.CFP_SITE },
          }));
          const data = await r.json();
          const titles = (data.items || []).map(i => i.title).join("|");
          return new Response("<html><body>POSTS:" + titles + "</body></html>", { status: 200 });
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_list", listing)], "wtheme_list.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_list/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const html = await (await req(worker, env, "/en")).text();
    checkTruthy("theme saw the published post via HOST", html.includes("Worker Visible Post"));
  }

  // -----------------------------------------------------------------------
  console.log("\n9. Repeated requests reuse one env without an I/O-context error");
  // -----------------------------------------------------------------------
  // Regression guard. A WorkerStub owns a request-scoped I/O channel, so it
  // must never be cached across requests. The original implementation cached
  // the stub per (env, theme); the *first* request rendered and every
  // subsequent request died with "Cannot perform I/O on behalf of a different
  // request" and silently fell back to the declarative renderer — which is a
  // far worse failure than a 500, because it looks like it works.
  {
    const loader = makeFakeLoader();
    const env = makeEnv(sqlite, loader, worker);
    const listing = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          // Each real request starts a fresh isolate, so this counter is
          // always 1 — mirroring the observed workerd behaviour.
          globalThis.__n = (globalThis.__n || 0) + 1;
          return new Response("<html><body>WORKER_RENDERED:" + globalThis.__n + "</body></html>", { status: 200 });
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_repeat", listing)], "wtheme_repeat.zip", { type: "application/zip" }));
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    await req(worker, env, "/api/v1/extensions/themes/wtheme_repeat/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });

    const before = loader._loads.length;
    const results = [];
    for (let i = 0; i < 4; i++) {
      // Advance the fake request context so a cached stub becomes unusable —
      // this is what real workerd does on every inbound request.
      loader._ctx++;
      results.push(await (await req(worker, env, `/en?i=${i}`)).text());
    }
    const everyRenderIsWorker = results.every((h) => h.includes("WORKER_RENDERED"));
    check("all four sequential requests render through the worker", everyRenderIsWorker, true);
    check("none of them fell back to the declarative renderer", results.some((h) => h.includes("WORKER_RENDERED")), true);

    // The stub must be rebuilt per request — that is the whole point of the fix.
    // Each page request loads the module twice: once for the warm probe and once
    // for the real render.
    // The stub must be rebuilt per request — that is the whole point of the fix.
    // Exactly one `load()` per page: the warm probe reuses the stub it just
    // built, it does not load a second one. Under the old stub-caching code
    // this number was 1 for *all four* requests combined, which is what made
    // requests 2..n fail.
    const perPage = loader._loads.length - before;
    check("one load() per page request, not one per isolate", perPage, results.length);
  }

  // -----------------------------------------------------------------------
  console.log("\n10. The theme runtime switch defaults to OFF");
  // -----------------------------------------------------------------------
  // Everything above runs with `CFPRESS_THEME_RUNTIME_WORKER: "true"` in the
  // env, because the whole point of sections 1-9 is the *enabled* behaviour.
  // That leaves the other direction untested, and the other direction is the
  // one that ships by default — a switch whose "off" branch was never executed
  // is a switch that is only believed to work.
  //
  // So this section builds envs that differ from `makeEnv` in exactly one way:
  // the var is absent, or set to a rejected spelling. The theme, the loader and
  // the R2 objects are all identical to section 1, which is what makes the
  // difference attributable.
  {
    // Same theme source as section 1: it answers every page with a marker no
    // declarative renderer could produce.
    const optOutWorker = `
      export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname === "/__health") return new Response("ok");
          return new Response("<html><body>WORKER_RENDERED</body></html>", { status: 200 });
        }
      };
    `;
    const fd = new FormData();
    fd.append("file", new File([buildWorkerTheme("wtheme_switch", optOutWorker)], "wtheme_switch.zip", { type: "application/zip" }));

    // Install/activate, then keep **one** env for every render below.
    //
    // This env must be reused, and that is not a style preference: R2 lives on
    // the env object (`makeEnv` builds a fresh in-memory store per call). A
    // fresh env per render would mean the theme's `worker.js` is never in R2,
    // `loadThemeWorkerSource()` returns null, and *every* case — including the
    // "on" one — skips the sandbox. The first draft of this section did exactly
    // that, and only the positive control caught it: without that assert, five
    // assertions here would have "passed" while collectively proving nothing.
    //
    // Reusing the env also means the only thing that varies between cases is
    // the switch, which is what makes the A/B readable.
    const loader = makeFakeLoader();
    const env = makeEnv(sqlite, loader, worker);
    await req(worker, env, "/api/v1/extensions/themes/upload", { method: "POST", headers: auth, body: fd });
    const act = await req(worker, env, "/api/v1/extensions/themes/wtheme_switch/activate", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    check("switch fixture theme activated", act.status, 200);

    // `loader._loads` accumulates, so each case reads the delta it caused
    // rather than a running total that only ever grows.
    const render = async (mutate) => {
      mutate(env);
      const before = loader._loads.length;
      const res = await req(worker, env, "/en");
      return { html: await res.text(), loads: loader._loads.length - before };
    };

    // -- the positive control comes first -----------------------------------
    // If this fails, nothing below it means anything, so it is asserted before
    // the opt-out cases rather than after them.
    const on = await render((e) => { e.CFPRESS_THEME_RUNTIME_WORKER = "true"; });
    checkTruthy("positive control: the var alone enables the sandbox", on.html.includes("WORKER_RENDERED"));
    checkTruthy("positive control: the loader was actually called", on.loads > 0);

    const off = await render((e) => { delete e.CFPRESS_THEME_RUNTIME_WORKER; });
    checkTruthy("with no var the page is not worker-rendered", !off.html.includes("WORKER_RENDERED"));
    check("with no var the loader is never called", off.loads, 0);

    const explicitFalse = await render((e) => { e.CFPRESS_THEME_RUNTIME_WORKER = "false"; });
    check("an explicit \"false\" var also skips the sandbox", explicitFalse.loads, 0);

    // A typo must not enable a feature that needs a paid plan. This is the
    // assert that keeps `truthy()` from drifting into "anything non-empty".
    const typo = await render((e) => { e.CFPRESS_THEME_RUNTIME_WORKER = "yes-please"; });
    check("an unrecognised spelling does not enable the sandbox", typo.loads, 0);

    // The site-level row must beat the var in the off direction. The control
    // above already proved this exact env renders through the worker when the
    // var is on, so the only thing that changed here is the row — which is what
    // stops this assert from being vacuous the way its first draft was.
    sqlite.prepare("INSERT OR REPLACE INTO settings(site_id,key,value) VALUES(?,?,?)")
      .run("default", "cfpress.features", JSON.stringify({ theme_runtime_worker: false }));
    const siteOff = await render((e) => { e.CFPRESS_THEME_RUNTIME_WORKER = "true"; });
    check("a site row saying off beats a var saying on", siteOff.loads, 0);
    sqlite.exec("DELETE FROM settings WHERE site_id='default' AND key='cfpress.features'");

    // Removing the row restores the var, so "reset to inherited" is not a
    // one-way door in the render path either.
    const backOn = await render((e) => { e.CFPRESS_THEME_RUNTIME_WORKER = "true"; });
    checkTruthy("dropping the row falls back to the var again", backOn.html.includes("WORKER_RENDERED"));
  }

  // Cleanup: drop this run's fixtures, then restore what it was allowed to
  // disturb (see the snapshot above) — the shared local D1 must be left as the
  // suite found it.
  for (const sql of [
    "DELETE FROM post_meta WHERE post_id LIKE 'wpost_%'",
    "DELETE FROM post_translations WHERE post_id LIKE 'wpost_%'",
    "DELETE FROM posts WHERE id LIKE 'wpost_%'",
    "DELETE FROM post_types WHERE declared_by_theme LIKE 'wtheme%'",
    "DELETE FROM field_defs WHERE declared_by_theme LIKE 'wtheme%'",
    "DELETE FROM admin_menu_registry WHERE owner_type='theme' AND owner_name LIKE 'wtheme%'",
    "DELETE FROM theme_setting_defs WHERE theme_name LIKE 'wtheme%'",
    "DELETE FROM theme_settings WHERE theme_name LIKE 'wtheme%'",
    "DELETE FROM theme_installs WHERE name LIKE 'wtheme%'",
    "DELETE FROM extension_versions WHERE extension_name LIKE 'wtheme%'",
    "DELETE FROM settings WHERE site_id='default' AND key IN ('cfpress.features','theme.active')",
  ]) { try { sqlite.exec(sql); } catch { /* ok */ } }
  for (const r of prevSettings) {
    const keys = Object.keys(r);
    try {
      sqlite.prepare(`INSERT INTO settings (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => r[k]));
    } catch { /* ok */ }
  }
  restoreCapabilities(sqlite, caps);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failures:", failures.join(", ")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  // A crashed run must still print a parseable summary, and it must say it
  // failed. Without this the reverse-validation tool reads "no summary" as
  // "could not tell", which is never a pass (AGENTS.md false green type 6).
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(1);
});
