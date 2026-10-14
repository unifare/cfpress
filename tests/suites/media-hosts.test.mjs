/**
 * Third-party image hosts ("图床") — imgbb and postimages.org.
 *
 * Until this feature every upload landed in the install's own R2 bucket.
 * Storage is now a per-site choice (`cfpress.media` → `provider`): `"r2"`
 * (every install that never heard of this keeps working untouched), `"imgbb"`
 * or `"postimages"`. The registry row stays the tenant+owner record and the
 * policy front door either way: remote rows keep a namespaced
 * `uploads/{site}/remote/…` key, content keeps storing `/media/<key>` URLs,
 * and the read path answers a remote row with a 302 to the vendor *after*
 * the same tenant/session/owner decision (rule 60b).
 *
 * The suite has two halves. The first drives the provider module directly
 * with a stubbed `fetch` (mapping, failures, never-throws delete) — no
 * network, no worker. The second drives the real compiled Worker with the
 * same stub: unknown providers are refused, missing keys name the missing
 * secret, vendor failures leave no row, happy paths record redirectable
 * rows, and deletes never touch R2 for remote rows.
 *
 * Usage: node tests/suites/media-hosts.test.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")).href);

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

/** Run one section, turning an uncaught throw into a recorded failure. */
async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) {
    fail++; failures.push(`${title} (threw)`);
    console.log(`  FAIL ${title} threw: ${String((e && e.message) || e).slice(0, 160)}`);
  }
}

async function compile(entry, outName) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", outName);
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
      return {
        body: e,
        httpEtag: '"etag"',
        writeHttpMetadata(h) { h.set("Content-Type", "application/octet-stream"); },
        async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); },
      };
    },
    async put(k, v) {
      let b = v;
      if (v && typeof v.arrayBuffer === "function") b = new Uint8Array(await v.arrayBuffer());
      store.set(k, b);
      return { key: k };
    },
    async delete(k) { store.delete(k); },
    has: (k) => store.has(k),
    keys: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite), MEDIA: makeR2(), CACHE: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    }, ASSETS: assetsStub(),
  };
}

const SITE_A = "mha";
const SITE_B = "mhb";
const HOST_A = "mha.example.com";
const HOST_B = "mhb.example.com";
const POLICY_KEY = "cfpress.media";

const realFetch = globalThis.fetch.bind(globalThis);
async function withStubFetch(stub, fn) {
  globalThis.fetch = stub;
  try { return await fn(); }
  finally { globalThis.fetch = realFetch; }
}
const pngBytes = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function imgbbOkStub(seen) {
  return async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({
      success: true, status: 200,
      data: {
        id: "abc123", display_url: "https://i.ibb.co/abc123/shot.png",
        url: "https://i.ibb.co/abc123/shot.png",
        delete_url: "https://ibb.co/abc123/deltoken",
        width: "1", height: "1", size: "70",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

function postimagesOkStub(seen) {
  return async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?><data success="1" status="200">` +
      `<id>xyz</id><url>https://postimg.cc/xyz</url>` +
      `<direct>https://i.postimg.cc/xyz/shot.png</direct>` +
      `<delete_url>https://postimg.cc/delete/xyz</delete_url></data>`,
      { status: 200, headers: { "Content-Type": "application/xml" } });
  };
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  // Log before the first `await`: see features.test.mjs for why this line is
  // load-bearing for the reverse-validation worker threads.
  console.log(`Using local D1: ${join(d1Dir, files[0])}\n`);

  const cleanup = () => {
    for (const sql of [
      `DELETE FROM media_files WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM settings WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM sites WHERE id IN ('${SITE_A}','${SITE_B}')`,
    ]) { try { sqlite.exec(sql); } catch { /* table may not exist on a fresh db */ } }
  };
  cleanup();

  const hosts = await compile("src/platform/media-hosts.ts", "media-hosts-unit.mjs");
  const worker = (await compile("src/index.ts", "media-hosts-bundle.mjs")).default;
  const env = makeEnv(sqlite);
  const req = (path, init = {}, host = "localhost") =>
    worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
  const json = (cookie) => ({ Cookie: cookie, "Content-Type": "application/json" });

  await section("0. setup: two sites, one admin", async () => {
    await req("/api/v1/health");
    const login = async (username, password) => {
      const r = await req("/admin/api/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      return r.headers.get("set-cookie")?.split(";")[0] ?? "";
    };
    env.__adminCookie = await login("admin", "change-me-now");
    checkTruthy("admin signed in", String(env.__adminCookie).startsWith("cfpress_admin="));
    for (const [id, host, name] of [[SITE_A, HOST_A, "Hosts A"], [SITE_B, HOST_B, "Hosts B"]]) {
      const r = await req("/api/v1/sites", { method: "POST", headers: json(env.__adminCookie), body: JSON.stringify({ id, name, host }) });
      check(`${id} created`, r.status, 201);
    }
  });
  const adminCookie = () => env.__adminCookie;
  const upload = async (site, name, mime = "image/png") => {
    const fd = new FormData();
    fd.append("file", new File([pngBytes()], name, { type: mime }));
    const r = await req(`/api/v1/media?site=${site}`, { method: "POST", headers: { Cookie: adminCookie() }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const setProvider = (site, value) =>
    req(`/api/v1/settings?site=${site}`, {
      method: "POST", headers: json(adminCookie()),
      body: JSON.stringify({ key: POLICY_KEY, value: JSON.stringify(value) }),
    });
  const rowById = (id) => sqlite.prepare("SELECT id, site_id, object_key, storage, remote_url, remote_delete_url, uploaded_by FROM media_files WHERE id=?").get(id);
  const readMedia = (key, host, cookie) =>
    req(`/media/${encodeURIComponent(key)}`, cookie ? { headers: { Cookie: cookie } } : {}, host);

  await section("1. provider resolution is total and closed", async () => {
    check("absent config means r2", hosts.mediaProviderOf(undefined), "r2");
    check("empty object means r2", hosts.mediaProviderOf({}), "r2");
    check("r2 stays r2", hosts.mediaProviderOf({ provider: "r2" }), "r2");
    check("imgbb resolves", hosts.mediaProviderOf({ provider: "imgbb" }), "imgbb");
    check("postimages resolves", hosts.mediaProviderOf({ provider: "postimages" }), "postimages");
    // Present-but-unknown is returned as-is so the caller can refuse it: a
    // typo that silently landed in R2 would be "answered success, stored
    // elsewhere".
    check("unknown stays unknown (caller refuses)", hosts.mediaProviderOf({ provider: "s3" }), "s3");
    check("the guard admits the closed set", [hosts.isMediaStorageProvider("r2"), hosts.isMediaStorageProvider("imgbb"), hosts.isMediaStorageProvider("postimages"), hosts.isMediaStorageProvider("s3")], [true, true, true, false]);
    check("remote keys stay namespaced by site", hosts.remoteObjectKey(SITE_A, "imgbb", "id1", "a.png"), `uploads/${SITE_A}/remote/imgbb/id1-a.png`);
    check("and the namespace test answers from the key alone",
      [hosts.isRemoteObjectKey(`uploads/${SITE_A}/remote/imgbb/x`, SITE_A), hosts.isRemoteObjectKey(`uploads/${SITE_A}/2026-01-01/x`, SITE_A), hosts.isRemoteObjectKey(`uploads/${SITE_B}/remote/imgbb/x`, SITE_A)],
      [true, false, false]);
  });

  await section("2. imgbb mapping, against a stubbed vendor", async () => {
    const seen = [];
    const r = await withStubFetch(imgbbOkStub(seen), () =>
      hosts.uploadToImgbb({ bytes: pngBytes(), filename: "shot.png", mimeType: "image/png" }, { apiKey: "k" }));
    check("the direct URL is display_url", r.url, "https://i.ibb.co/abc123/shot.png");
    check("the deletion URL is kept", r.deleteUrl, "https://ibb.co/abc123/deltoken");
    check("dimensions are numbers", [r.width, r.height], [1, 1]);
    checkTruthy("the key travels in the query string", seen[0]?.url.includes("key=k"));
    await withStubFetch(async () => new Response(JSON.stringify({ success: false, status: 400, error: { message: "bad key" } }), { status: 200 }), async () => {
      let msg = "";
      try { await hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "bad" }); }
      catch (e) { msg = String((e && e.message) || e); }
      check("a vendor refusal throws with their message", msg.includes("bad key"), true);
    });
    await withStubFetch(async () => new Response(JSON.stringify({ success: false, status: 400, error: { message: "You have been forbidden to use this website.", code: 103 } }), { status: 400 }), async () => {
      let msg = "";
      try { await hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "good-key-flagged-network" }); }
      catch (e) { msg = String((e && e.message) || e); }
      check("code 103 names the network, not the key", msg.includes("bot protection") && !msg.includes("missing API key"), true);
    });
    let missing = "";
    try { await hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "" }); }
    catch (e) { missing = String((e && e.message) || e); }
    check("a missing key throws before any request", missing.includes("IMGBB_API_KEY"), true);
    // Flake tolerance: 429/5xx/network errors get exactly one retry, a 400
    // verdict never does (retrying a refusal could double-store beside an
    // object nobody recorded the deletion URL for).
    let tries = 0;
    const flaky = await withStubFetch(async () => (++tries === 1
      ? new Response("slow down", { status: 429 })
      : new Response(JSON.stringify({ success: true, status: 200, data: { id: "r", display_url: "https://i.ibb.co/r/x.png", delete_url: null, width: "1", height: "1" } }), { status: 200 })), () =>
      hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "k" }));
    check("a 429 is retried once and then succeeds", [flaky.url, tries], ["https://i.ibb.co/r/x.png", 2]);
    let verdicts = 0;
    await withStubFetch(async () => { verdicts++; return new Response("forbidden page", { status: 400 }); }, async () => {
      try { await hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "k" }); }
      catch { /* a 400 is a verdict, not a flake */ }
    });
    check("a 400 is not retried", verdicts, 1);
    let ua = "";
    await withStubFetch(async (url, init) => {
      const hdrs = init?.headers;
      ua = String((hdrs && typeof hdrs === "object" && !(hdrs instanceof Headers) ? hdrs["User-Agent"] : hdrs instanceof Headers ? hdrs.get("User-Agent") : "") ?? "");
      return new Response(JSON.stringify({ success: true, status: 200, data: { id: "r", display_url: "https://i.ibb.co/r/x.png", delete_url: null, width: "1", height: "1" } }), { status: 200 });
    }, () => hosts.uploadToImgbb({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "k" }));
    checkTruthy("vendor requests carry a browser UA (default Worker UA gets edge-filtered)", ua.includes("Mozilla"));
  });

  await section("3. postimages mapping, against a stubbed vendor", async () => {
    const seen = [];
    const r = await withStubFetch(postimagesOkStub(seen), () =>
      hosts.uploadToPostimages({ bytes: pngBytes(), filename: "shot.png", mimeType: "image/png" }, { apiKey: "k" }));
    check("the direct tag wins over viewer/thumb tags", r.url, "https://i.postimg.cc/xyz/shot.png");
    check("the deletion URL is kept", r.deleteUrl, "https://postimg.cc/delete/xyz");
    checkTruthy("the key travels as a form field, not in query", !seen[0]?.url.includes("key="));
    await withStubFetch(async () => new Response(`<?xml version="1.0"?><data success="0" status="403"><error>Invalid API Key.</error></data>`, { status: 200 }), async () => {
      let msg = "";
      try { await hosts.uploadToPostimages({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "bad" }); }
      catch (e) { msg = String((e && e.message) || e); }
      check("an error document throws with their text", msg.includes("Invalid API Key"), true);
    });
    let missing = "";
    try { await hosts.uploadToPostimages({ bytes: pngBytes(), filename: "x.png", mimeType: "image/png" }, { apiKey: "" }); }
    catch (e) { missing = String((e && e.message) || e); }
    check("a missing key throws before any request", missing.includes("POSTIMAGES_API_KEY"), true);
  });

  await section("4. remote delete never throws", async () => {
    check("a 200 confirms", await hosts.deleteRemoteImage("imgbb", "https://ibb.co/x/del", async () => new Response("ok", { status: 200 })), true);
    check("a 500 does not", await hosts.deleteRemoteImage("imgbb", "https://ibb.co/x/del", async () => new Response("no", { status: 500 })), false);
    check("a missing URL does not", await hosts.deleteRemoteImage("imgbb", null), false);
    check("a throwing fetch does not", await hosts.deleteRemoteImage("imgbb", "https://ibb.co/x/del", async () => { throw new Error("down"); }), false);
  });

  await section("5. an unknown provider is refused, and stores nothing", async () => {
    await setProvider(SITE_A, { provider: "s3" });
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0;
    const r = await upload(SITE_A, "nope.png");
    check("unknown provider is a 400, not a silent R2 upload", r.status, 400);
    checkTruthy("the message names the value", String(r.body.error || "").includes("s3"));
    check("no row was minted", sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0, before);
    await setProvider(SITE_A, {});
  });

  await section("6. a configured provider without its key names the secret", async () => {
    await setProvider(SITE_A, { provider: "imgbb" });
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0;
    const r = await upload(SITE_A, "nokey.png");
    check("missing key is a 400", r.status, 400);
    checkTruthy("naming IMGBB_API_KEY", String(r.body.error || "").includes("IMGBB_API_KEY"));
    check("no row was minted", sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0, before);
  });

  await section("7. imgbb happy path records a redirectable row", async () => {
    await setProvider(SITE_A, { provider: "imgbb" });
    env.IMGBB_API_KEY = "test-key";
    const r = await withStubFetch(imgbbOkStub([]), () => upload(SITE_A, "remote-shot.png"));
    check("upload accepted", r.status, 201);
    check("the URL is still the policy-fronted /media/ URL", r.body.url.startsWith("/media/uploads%2Fmha%2Fremote%2Fimgbb%2F"), true);
    const row = rowById(r.body.id);
    check("the row names its storage", row.storage, "imgbb");
    check("and the vendor URL", row.remote_url, "https://i.ibb.co/abc123/shot.png");
    check("and the deletion URL", row.remote_delete_url, "https://ibb.co/abc123/deltoken");
    check("and R2 never saw the bytes", env.MEDIA.keys().filter((k) => String(k).includes("remote")).length, 0);
    const key = decodeURIComponent(r.body.url.slice("/media/".length));
    const hit = await readMedia(key, HOST_A, adminCookie());
    check("the uploader's session is redirected to the vendor", hit.status, 302);
    check("at the vendor URL", hit.headers.get("location"), "https://i.ibb.co/abc123/shot.png");
    const anon = await readMedia(key, HOST_A);
    check("an anonymous read is still refused", anon.status, 404);
    const other = await readMedia(key, HOST_B, adminCookie());
    check("another site's host still refuses the key", other.status, 404);
    delete env.IMGBB_API_KEY;
  });

  await section("8. postimages happy path, and vendor failures leave no row", async () => {
    await setProvider(SITE_A, { provider: "postimages" });
    env.POSTIMAGES_API_KEY = "test-key";
    const r = await withStubFetch(postimagesOkStub([]), () => upload(SITE_A, "remote-post.png"));
    check("upload accepted", r.status, 201);
    const row = rowById(r.body.id);
    check("the row names its storage", row.storage, "postimages");
    const key = decodeURIComponent(r.body.url.slice("/media/".length));
    const hit = await readMedia(key, HOST_A, adminCookie());
    check("redirected", hit.status, 302);
    check("at the direct tag", hit.headers.get("location"), "https://i.postimg.cc/xyz/shot.png");
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0;
    const bad = await withStubFetch(async () => new Response("boom", { status: 500 }), () => upload(SITE_A, "doomed.png"));
    check("a vendor 500 is a 502", bad.status, 502);
    check("and no row was minted", sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE site_id=?").get(SITE_A)?.n ?? 0, before);
    delete env.POSTIMAGES_API_KEY;
  });

  await section("9. deleting a remote row never touches R2", async () => {
    const row = sqlite.prepare("SELECT id, object_key FROM media_files WHERE site_id=? AND storage='imgbb' LIMIT 1").get(SITE_A);
    checkTruthy("a remote row exists to delete", Boolean(row));
    let remoteHit = 0;
    const del = await withStubFetch(async () => { remoteHit++; return new Response("ok", { status: 200 }); }, () =>
      req(`/api/v1/media/${row.id}?site=${SITE_A}`, { method: "DELETE", headers: { Cookie: adminCookie() } }));
    check("delete accepted", del.status, 200);
    check("the vendor was asked", remoteHit, 1);
    check("the row is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE id=?").get(row.id)?.n, 0);
    check("R2 was not asked (nothing remote-shaped was ever stored)", env.MEDIA.keys().filter((k) => String(k).includes("remote")).length, 0);
  });

  await section("10. the redirect never leaves https", async () => {
    await setProvider(SITE_A, { provider: "imgbb" });
    env.IMGBB_API_KEY = "test-key";
    const r = await withStubFetch(imgbbOkStub([]), () => upload(SITE_A, "tamper.png"));
    check("upload accepted", r.status, 201);
    const key = decodeURIComponent(r.body.url.slice("/media/".length));
    sqlite.prepare("UPDATE media_files SET remote_url='http://evil.example/x.png' WHERE id=?").run(r.body.id);
    const hit = await readMedia(key, HOST_A, adminCookie());
    check("a non-https target is a 404, never a redirect", hit.status, 404);
    check("with no Location header", hit.headers.get("location"), null);
    delete env.IMGBB_API_KEY;
  });

  await section("11. the list reports storage without leaking keys", async () => {
    await setProvider(SITE_A, { provider: "imgbb" });
    const plain = await (await req(`/api/v1/media?site=${SITE_A}`, { headers: { Cookie: adminCookie() } })).json();
    check("provider reported", plain.storage?.provider, "imgbb");
    check("key presence reported as booleans", [typeof plain.storage?.imgbbKey, typeof plain.storage?.postimagesKey], ["boolean", "boolean"]);
    checkTruthy("no key material in the payload", !JSON.stringify(plain).includes("test-key"));
    env.IMGBB_API_KEY = "test-key";
    const keyed = await (await req(`/api/v1/media?site=${SITE_A}`, { headers: { Cookie: adminCookie() } })).json();
    check("a configured key reads true", keyed.storage?.imgbbKey, true);
    delete env.IMGBB_API_KEY;
  });

  await section("12. r2 without any configuration is untouched", async () => {
    await setProvider(SITE_A, {});
    const r = await upload(SITE_A, "local-shot.png");
    check("upload accepted", r.status, 201);
    const row = rowById(r.body.id);
    check("storage defaults to r2", row.storage, "r2");
    check("no remote URL recorded", row.remote_url, null);
    const key = decodeURIComponent(r.body.url.slice("/media/".length));
    const hit = await readMedia(key, HOST_A, adminCookie());
    check("bytes served, not redirected", hit.status, 200);
  });

  await section("13. site keys win, are never echoed, and survive empty writes", async () => {
    await setProvider(SITE_A, { provider: "imgbb" });
    // No env keys in this suite's stub env: the site key alone must suffice.
    const setKey = await req(`/api/v1/settings?site=${SITE_A}`, {
      method: "POST", headers: json(adminCookie()),
      body: JSON.stringify({ key: "cfpress.media.imgbb_key", value: "site-key-1" }),
    });
    check("site key accepted", setKey.status, 200);
    const listed = await (await req(`/api/v1/media?site=${SITE_A}`, { headers: { Cookie: adminCookie() } })).json();
    check("configured reads true from the site key alone", listed.storage?.imgbbKey, true);
    const raw = await (await req(`/api/v1/settings?site=${SITE_A}`, { headers: { Cookie: adminCookie() } })).json();
    const keyRow = (raw.items || []).find((x) => x.key === "cfpress.media.imgbb_key");
    check("the key value is redacted on read", keyRow?.value, "");
    const r = await withStubFetch(imgbbOkStub([]), () => upload(SITE_A, "site-key-shot.png"));
    check("upload with the site key accepted", r.status, 201);
    check("row recorded under imgbb", rowById(r.body.id)?.storage, "imgbb");
    // An empty write keeps the stored key: forms round-trip what they display
    // (""), and must not delete the secret as a side effect of saving.
    await req(`/api/v1/settings?site=${SITE_A}`, {
      method: "POST", headers: json(adminCookie()),
      body: JSON.stringify({ key: "cfpress.media.imgbb_key", value: "" }),
    });
    const again = await (await req(`/api/v1/media?site=${SITE_A}`, { headers: { Cookie: adminCookie() } })).json();
    check("empty write preserves the stored key", again.storage?.imgbbKey, true);
    const r2 = await withStubFetch(imgbbOkStub([]), () => upload(SITE_A, "site-key-shot-2.png"));
    check("uploads still work after the empty write", r2.status, 201);
  });

  await section("14. env keys are the fallback when the site has none", async () => {
    await setProvider(SITE_B, { provider: "postimages" });
    env.POSTIMAGES_API_KEY = "env-key-1";
    const listed = await (await req(`/api/v1/media?site=${SITE_B}`, { headers: { Cookie: adminCookie() } })).json();
    check("configured reads true from the env fallback", listed.storage?.postimagesKey, true);
    const r = await withStubFetch(postimagesOkStub([]), () => upload(SITE_B, "env-key-shot.png"));
    check("upload with the env key accepted", r.status, 201);
    check("row recorded under postimages", rowById(r.body.id)?.storage, "postimages");
    delete env.POSTIMAGES_API_KEY;
  });

  console.log("\ncleanup");
  cleanup();
  check("the suite's rows are gone (media)",
    sqlite.prepare(`SELECT COUNT(*) AS n FROM media_files WHERE site_id IN ('${SITE_A}','${SITE_B}')`).get()?.n, 0);
  check("the suite's rows are gone (settings)",
    sqlite.prepare(`SELECT COUNT(*) AS n FROM settings WHERE site_id IN ('${SITE_A}','${SITE_B}')`).get()?.n, 0);
  check("the suite's rows are gone (sites)",
    sqlite.prepare(`SELECT COUNT(*) AS n FROM sites WHERE id IN ('${SITE_A}','${SITE_B}')`).get()?.n, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
}

try {
  await main();
} catch (e) {
  fail++; failures.push(`harness threw: ${(e && e.message) || e}`);
  console.error(e);
  console.log(`\n${pass} passed, ${fail} failed (aborted)`);
  process.exit(2);
}
