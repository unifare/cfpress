/**
 * Media access tests — the two axes `media_files` carries, on both doors.
 *
 * `media_files` is per-site (migration 0009) and, since 0018, per-owner. Before
 * this suite the tenant axis had **no enforcement on the only public door**: the
 * `/media/<key>` branch in `src/index.ts` was matched above site resolution and
 * above authentication, so a key minted for one site was served on another
 * site's host, and for an anonymous visitor. The admin list was already
 * site-scoped, which is exactly why the hole survived — the two doors disagreed
 * and only one of them was ever asserted.
 *
 * So this suite drives the real compiled Worker and checks **both doors agree**,
 * and it asserts the *reason* a read was refused rather than just the status:
 * three independent gates all answer 404, so an assertion that only reads the
 * status passes with any one of them still standing. That is how a deleted guard
 * hides (docs/ARCHITECTURE.md §12, "observation surface").
 *
 * Usage: node tests/suites/media.test.mjs
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

/** Run one section, turning an uncaught throw into a recorded failure. A throw
 *  that escapes `main()` would end the process before the summary line, and the
 *  reverse-validation tool reads "no summary" as "could not tell" — so a real
 *  red would be reported as a broken harness. */
async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) {
    fail++; failures.push(`${title} (threw)`);
    console.log(`  FAIL ${title} threw: ${String((e && e.message) || e).slice(0, 160)}`);
  }
}

/**
 * Bundle one entry point and import it.
 *
 * Parameterised rather than hard-coded to `src/index.ts` because section 11
 * needs `shared/media-store.ts` on its own: the contract being pinned there —
 * "a missing bucket reads as an empty store, not as a throw" — is invisible from
 * the outside wherever a caller has a fallback, which is every caller on the
 * render path.
 */
async function compileEntry(rel) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, rel)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", `bundle-${rel.replace(/[^A-Za-z0-9]/g, "_")}.mjs`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

async function compileWorker() {
  return compileEntry("src/index.ts");
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

/** R2 stand-in with the full surface the media route touches (`get` must return
 *  `body`, `httpEtag` and `writeHttpMetadata`, or the route throws on a hit). */
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
    DB: makeD1(sqlite),
    MEDIA: makeR2(),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

const SITE_A = "mta";
const SITE_B = "mtb";
const HOST_A = "mta.example.com";
const HOST_B = "mtb.example.com";
const EDITOR = { username: "media-editor", password: "media-editor-pw-1" };
const AUTHOR = { username: "media-author", password: "media-author-pw-1" };
const POLICY_KEY = "cfpress.media";

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  // Log before the first `await`: see features.test.mjs for why this line is
  // load-bearing for the reverse-validation worker threads.
  console.log(`Using local D1: ${join(d1Dir, files[0])}\n`);

  // Idempotent cleanup, both ends. Prefix-delete the policy rows so an injected
  // defect that writes `cfpress.media-typo` cannot leave a row that fails the
  // *next* run at a line unrelated to the first failure.
  const cleanup = () => {
    for (const sql of [
      `DELETE FROM media_files WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM settings WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM settings WHERE key LIKE '${POLICY_KEY}%' AND site_id='default'`,
      `DELETE FROM menus WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM sites WHERE id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM site_users_sites WHERE user_id IN (SELECT id FROM site_users WHERE username IN ('${EDITOR.username}','${AUTHOR.username}'))`,
      `DELETE FROM site_users WHERE username IN ('${EDITOR.username}','${AUTHOR.username}')`,
    ]) { try { sqlite.exec(sql); } catch { /* table may not exist on a fresh db */ } }
  };
  cleanup();

  const env = makeEnv(sqlite);
  const worker = (await compileWorker()).default;
  const req = (path, init = {}, host = "localhost") =>
    worker.fetch(new Request(`http://${host}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
  const json = (cookie) => ({ Cookie: cookie, "Content-Type": "application/json" });

  let adminCookie = "";
  let editorCookie = "";
  let authorCookie = "";
  const login = async (username, password) => {
    const r = await req("/admin/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    return r.headers.get("set-cookie")?.split(";")[0] ?? "";
  };
  const upload = async (cookie, site, name, mime = "image/png") => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], name, { type: mime }));
    const r = await req(`/api/v1/media?site=${site}`, { method: "POST", headers: { Cookie: cookie }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const list = async (cookie, site, extra = "") =>
    (await req(`/api/v1/media?site=${site}${extra}`, { headers: { Cookie: cookie } })).json();
  // ⚠️ `?site=` is not optional here. Without it the row lands on the default
  // site and every policy assertion below reads the *default* policy instead —
  // which is exactly the shape that let section 10 pass while its `UPDATE`
  // matched zero rows. The site is part of the request, always.
  const setPolicy = (cookie, site, value) =>
    req(`/api/v1/settings?site=${site}`, {
      method: "POST", headers: json(cookie),
      body: JSON.stringify({ key: POLICY_KEY, value: JSON.stringify(value) }),
    });
  /** The public read path. `encodeURIComponent` on the key mirrors what the
   *  editor stores in a block's `url`, so the round trip is the real one. */
  const readMedia = (key, host, cookie) =>
    req(`/media/${encodeURIComponent(key)}`, cookie ? { headers: { Cookie: cookie } } : {}, host);

  await section("0. setup: two sites, two non-admin users", async () => {
    await req("/api/v1/health");
    adminCookie = await login("admin", "change-me-now");
    checkTruthy("admin signed in", adminCookie.startsWith("cfpress_admin="));

    for (const [id, host, name] of [[SITE_A, HOST_A, "Media A"], [SITE_B, HOST_B, "Media B"]]) {
      const r = await req("/api/v1/sites", { method: "POST", headers: json(adminCookie), body: JSON.stringify({ id, name, host }) });
      check(`${id} created`, r.status, 201);
    }
    // `editor` is the only non-admin role that holds `media.write` (0007), so it
    // is the role that can prove the *owner* gate rather than the permission
    // gate. `author` holds no media permission at all and proves that gate.
    //
    // Membership is per site (batch E, rule 78), so a user created on `mta` can
    // only act on `mta` until they are granted `mtb` as well. This suite uses
    // both sites with the *same* two users, so each is created on `mta` and then
    // granted `mtb` through the per-site role endpoint — the same two steps a
    // real operator takes in the Users screen.
    const userIds = {};
    for (const [u, role] of [[EDITOR, "editor"], [AUTHOR, "author"]]) {
      const r = await req(`/api/v1/users?site=${SITE_A}`, { method: "POST", headers: json(adminCookie), body: JSON.stringify({ ...u, role }) });
      checkTruthy(`${role} user created`, r.status < 300);
      userIds[u.username] = (await r.json()).id;
      const g = await req(`/api/v1/users/${userIds[u.username]}/sites/${SITE_B}?site=${SITE_A}`, {
        method: "PUT", headers: json(adminCookie), body: JSON.stringify({ role }),
      });
      checkTruthy(`${role} granted on the second site`, g.status < 300);
    }
    editorCookie = await login(EDITOR.username, EDITOR.password);
    authorCookie = await login(AUTHOR.username, AUTHOR.password);
    checkTruthy("editor signed in", editorCookie.startsWith("cfpress_admin="));
    checkTruthy("author signed in", authorCookie.startsWith("cfpress_admin="));
  });

  // -------------------------------------------------------------------------
  // This section is the regression guard for the site-list memo. It must run
  // **before** the sites exist: the memo in `platform/sites.ts` is keyed by
  // `env`, and `env` outlives a request, so without a per-request reset the list
  // resolved here would be reused for every later request in this process and
  // `mta`/`mtb` would never resolve — their media would 404 as "another site's
  // key" while the admin listed it happily.
  // -------------------------------------------------------------------------
  await section("1. a site created after a front-end request still resolves", async () => {
    const before = await readMedia("uploads/nope/x.png", HOST_A);
    check("the site does not exist yet, so nothing is served", before.status, 404);

    const created = await req("/api/v1/sites", { method: "POST", headers: json(adminCookie), body: JSON.stringify({ id: "mtmemo", name: "Memo", host: "mtmemo.example.com" }) });
    check("a site created after that request", created.status, 201);
    const after = await req("/media/nothing-here.png", {}, "mtmemo.example.com");
    // The status is 404 either way (there is no such object); what matters is
    // that the request reached the site-aware branch at all, which the
    // `uploads/{siteId}/` gate proves in section 3.
    check("and the front end still answers", after.status, 404);
    sqlite.exec("DELETE FROM settings WHERE site_id='mtmemo'");
    sqlite.exec("DELETE FROM sites WHERE id='mtmemo'");
  });

  await section("2. upload records the owner and files the key under the site", async () => {
    const a = await upload(adminCookie, SITE_A, "admin-shot.png");
    check("upload accepted", a.status, 201);
    check("the key is namespaced by site", a.body.url.startsWith("/media/uploads%2Fmta%2F"), true);
    const row = sqlite.prepare("SELECT site_id, uploaded_by, object_key FROM media_files WHERE id=?").get(a.body.id);
    check("row carries the site", row.site_id, SITE_A);
    checkTruthy("row carries the uploader (not NULL)", typeof row.uploaded_by === "string" && row.uploaded_by.length > 0);
    const admin = sqlite.prepare("SELECT id FROM site_users WHERE username='admin'").get();
    check("the uploader is the signed-in user", row.uploaded_by, admin.id);
    check("the object key's tenant segment matches", row.object_key.startsWith(`uploads/${SITE_A}/`), true);

    const b = await upload(editorCookie, SITE_A, "editor-shot.png");
    check("the editor may also upload (media.write)", b.status, 201);
    const editor = sqlite.prepare("SELECT id FROM site_users WHERE username=?").get(EDITOR.username);
    const bRow = sqlite.prepare("SELECT uploaded_by FROM media_files WHERE id=?").get(b.body.id);
    check("the editor's upload is attributed to the editor", bRow.uploaded_by, editor.id);

    const bogus = await upload(adminCookie, "nosuchsite", "x.png");
    check("uploading into a site that does not exist is refused", bogus.status, 400);
  });

  await section("3. the tenant gate: a key is only served by its own site", async () => {
    const a = await upload(adminCookie, SITE_A, "tenant.png");
    const key = decodeURIComponent(a.body.url.slice("/media/".length));

    const own = await readMedia(key, HOST_A, adminCookie);
    check("its own site serves it", own.status, 200);
    checkTruthy("and serves the bytes", (await own.arrayBuffer()).byteLength > 0);

    const cross = await readMedia(key, HOST_B, adminCookie);
    check("another site's host does not", cross.status, 404);
    check("even for a signed-in user", (await cross.text()), "Not found");

    // The gate is on the *key*, not on the host: a key that claims the other
    // site is refused on this host too.
    const foreign = await readMedia(`uploads/${SITE_B}/2026-01-01/x.png`, HOST_A, adminCookie);
    check("a key naming another tenant is refused on this host", foreign.status, 404);
  });

  // -------------------------------------------------------------------------
  // Three gates all answer 404, so this section opens them one at a time and
  // asserts on the moment each is the *only* one left standing. An assertion
  // that only reads the status while all three are closed passes with any one
  // of them still in place — which is how a deleted guard hides.
  // -------------------------------------------------------------------------
  await section("4. the session gate is the policy's, and the tenant gate is separate", async () => {
    const a = await upload(adminCookie, SITE_A, "session.png");
    const key = decodeURIComponent(a.body.url.slice("/media/".length));

    check("an anonymous reader gets nothing under the default policy", (await readMedia(key, HOST_A, null)).status, 404);
    check("the uploader does", (await readMedia(key, HOST_A, adminCookie)).status, 200);

    // Owner isolation off ⇒ the session requirement is the only gate left, so
    // this is the assertion that observes it.
    await setPolicy(adminCookie, SITE_A, { isolation: "site", require_session: true });
    check("with owner isolation off, an anonymous read is still refused", (await readMedia(key, HOST_A, null)).status, 404);
    check("while any signed-in reader of the site is served", (await readMedia(key, HOST_A, editorCookie)).status, 200);

    // Turning it off lets that same anonymous request through — which is what
    // makes the assertion above about *this* switch rather than about a gate
    // next door.
    await setPolicy(adminCookie, SITE_A, { isolation: "site", require_session: false });
    const wrote = sqlite.prepare("SELECT value FROM settings WHERE site_id=? AND key=?").get(SITE_A, POLICY_KEY);
    checkTruthy("the policy write landed on this site (non-vacuity)", !!wrote && JSON.parse(wrote.value).isolation === "site");
    check("with require_session off, anonymous reads are served", (await readMedia(key, HOST_A, null)).status, 200);

    // Now both sites are permissive, so the tenant gate is the only thing left
    // between a key and another site's host.
    await setPolicy(adminCookie, SITE_B, { isolation: "site", require_session: false });
    const crossStill = await readMedia(key, HOST_B, null);
    check("another site's host still refuses the key, with every other gate open", crossStill.status, 404);

    await setPolicy(adminCookie, SITE_A, { isolation: "owner", require_session: true });
    await setPolicy(adminCookie, SITE_B, { isolation: "owner", require_session: true });
  });

  await section("5. the owner gate — hard isolation, administrators included", async () => {
    const adminFile = await upload(adminCookie, SITE_A, "owned-by-admin.png");
    const editorFile = await upload(editorCookie, SITE_A, "owned-by-editor.png");
    const kAdmin = decodeURIComponent(adminFile.body.url.slice("/media/".length));
    const kEditor = decodeURIComponent(editorFile.body.url.slice("/media/".length));

    check("the admin reads their own file", (await readMedia(kAdmin, HOST_A, adminCookie)).status, 200);
    check("the editor reads their own file", (await readMedia(kEditor, HOST_A, editorCookie)).status, 200);
    check("the admin does NOT read the editor's file", (await readMedia(kEditor, HOST_A, adminCookie)).status, 404);
    check("the editor does NOT read the admin's file", (await readMedia(kAdmin, HOST_A, editorCookie)).status, 404);
    // Non-vacuity: the two keys above are distinguishable only by their owner,
    // so if the owner filter were deleted these two assertions would flip while
    // the first two stayed green. That is the pair that has to exist.
  });

  await section("6. legacy rows (uploaded_by IS NULL) stay visible site-wide", async () => {
    // A row written before migration 0018 has no owner. Turning isolation on
    // must not make the operator's existing library unreachable, and there is
    // no user to attribute it to that would not be a guess.
    const key = `uploads/${SITE_A}/2026-01-01/legacy.png`;
    sqlite.prepare(
      "INSERT INTO media_files (id, site_id, object_key, filename, mime_type, size, alt_text, title, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run("mf_legacy_probe", SITE_A, key, "legacy.png", "image/png", 4, "", "legacy.png", null, 1);
    await env.MEDIA.put(key, new Uint8Array([1, 2, 3, 4]));

    check("the admin can read a legacy file", (await readMedia(key, HOST_A, adminCookie)).status, 200);
    check("so can the editor", (await readMedia(key, HOST_A, editorCookie)).status, 200);
    check("an anonymous reader still cannot", (await readMedia(key, HOST_A, null)).status, 404);
  });

  await section("7. the library lists what the reader can actually fetch", async () => {
    const adminList = await list(adminCookie, SITE_A);
    const editorList = await list(editorCookie, SITE_A);
    const names = (d) => d.items.map((i) => i.filename).sort();

    checkTruthy("the admin's library excludes the editor's files", !names(adminList).includes("owned-by-editor.png"));
    checkTruthy("the editor's library excludes the admin's files", !names(editorList).includes("owned-by-admin.png"));
    checkTruthy("both see the legacy file", names(adminList).includes("legacy.png") && names(editorList).includes("legacy.png"));
    checkTruthy("each sees their own", names(adminList).includes("owned-by-admin.png") && names(editorList).includes("owned-by-editor.png"));
    check("the list reports its isolation mode", adminList.isolation, "owner");

    // The dashboard card must agree with the list, or the number is one nobody
    // can reconcile with the screen.
    const dash = await (await req(`/api/v1/dashboard?site=${SITE_A}`, { headers: { Cookie: adminCookie } })).json();
    const card = dash.cards.find((c) => c.key === "media");
    check("the dashboard media card equals the list total", card.value, adminList.total);

    const search = await list(adminCookie, SITE_A, "&q=owned-by-admin");
    check("filename search narrows the list", search.items.map((i) => i.filename), ["owned-by-admin.png"]);
    const typed = await list(adminCookie, SITE_A, "&type=image/");
    checkTruthy("a mime prefix filter is honoured", typed.items.every((i) => String(i.mime_type).startsWith("image/")));
    const none = await list(adminCookie, SITE_A, "&type=application/pdf");
    check("a filter that matches nothing returns nothing", none.items.length, 0);
    const paged = await list(adminCookie, SITE_A, "&limit=1&page=2");
    check("paging is applied", paged.items.length, 1);
    check("and total counts the whole set, not the page", paged.total, adminList.total);
    check("another site's library is separate", (await list(adminCookie, SITE_B)).items.length, 0);
  });

  await section("8. editing a row's language-neutral fields", async () => {
    const f = await upload(adminCookie, SITE_A, "alt.png");
    const id = f.body.id;
    const editorFile = await upload(editorCookie, SITE_A, "alt-other.png");

    const okRes = await req(`/api/v1/media/${id}?site=${SITE_A}`, {
      method: "PATCH", headers: json(adminCookie), body: JSON.stringify({ alt_text: "A description", title: "Titled" }),
    });
    check("the owner may edit", okRes.status, 200);
    const row = sqlite.prepare("SELECT alt_text, title FROM media_files WHERE id=?").get(id);
    check("alt_text persisted", row.alt_text, "A description");
    check("title persisted", row.title, "Titled");

    const notOwner = await req(`/api/v1/media/${editorFile.body.id}?site=${SITE_A}`, {
      method: "PATCH", headers: json(adminCookie), body: JSON.stringify({ alt_text: "hijack" }),
    });
    check("a non-owner is refused", notOwner.status, 403);
    const untouched = sqlite.prepare("SELECT alt_text FROM media_files WHERE id=?").get(editorFile.body.id);
    check("and nothing was written", untouched.alt_text, "");

    // The author holds no media permission at all — a different gate from the
    // owner one above, and the reason a `can()` short-circuit for admins means
    // this probe user must not be an admin.
    const noPerm = await req(`/api/v1/media/${editorFile.body.id}?site=${SITE_A}`, {
      method: "PATCH", headers: json(authorCookie), body: JSON.stringify({ alt_text: "nope" }),
    });
    check("a user without media.write is refused", noPerm.status, 403);

    const otherSite = await req(`/api/v1/media/${id}?site=${SITE_B}`, {
      method: "PATCH", headers: json(adminCookie), body: JSON.stringify({ alt_text: "cross" }),
    });
    check("an id belonging to another site is not found", otherSite.status, 404);

    const empty = await req(`/api/v1/media/${id}?site=${SITE_A}`, {
      method: "PATCH", headers: json(adminCookie), body: JSON.stringify({}),
    });
    check("a PATCH with nothing to change is refused", empty.status, 400);
  });

  await section("9. deleting removes the object before the row", async () => {
    const f = await upload(adminCookie, SITE_A, "doomed.png");
    const id = f.body.id;
    const key = sqlite.prepare("SELECT object_key FROM media_files WHERE id=?").get(id)?.object_key;
    checkTruthy("the object is in R2", env.MEDIA.has(key));

    const notOwner = await req(`/api/v1/media/${id}?site=${SITE_A}`, { method: "DELETE", headers: { Cookie: editorCookie } });
    check("a non-owner cannot delete it", notOwner.status, 403);
    checkTruthy("and the object survives", env.MEDIA.has(key));

    const del = await req(`/api/v1/media/${id}?site=${SITE_A}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    check("the owner can", del.status, 200);
    check("the row is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM media_files WHERE id=?").get(id)?.n, 0);
    checkTruthy("and so is the object", !env.MEDIA.has(key));
    // Order matters: the row is the only thing that names the object, so
    // deleting it first would strand the bytes with nothing left to find them.
    check("the deleted file no longer reads", (await readMedia(key, HOST_A, adminCookie)).status, 404);
  });

  await section("10. an unreadable policy fails closed", async () => {
    const f = await upload(adminCookie, SITE_A, "closed.png");
    const key = decodeURIComponent(f.body.url.slice("/media/".length));
    // A corrupt row must not read as "no policy" in the permissive direction:
    // both defaults are the restrictive choice.
    const corrupted = sqlite.prepare("UPDATE settings SET value=? WHERE site_id=? AND key=?").run("{not json", SITE_A, POLICY_KEY);
    // Non-vacuity: without this the three assertions below would pass on the
    // *default* policy even if the row they mean to corrupt did not exist —
    // which is precisely how they passed before `setPolicy` learned to send
    // `?site=`.
    check("a policy row really was corrupted (non-vacuity)", Number(corrupted.changes), 1);
    check("a corrupt policy row still refuses an anonymous read", (await readMedia(key, HOST_A, null)).status, 404);
    check("and still refuses a non-owner", (await readMedia(key, HOST_A, editorCookie)).status, 404);
    check("while the owner is unaffected", (await readMedia(key, HOST_A, adminCookie)).status, 200);
    sqlite.exec(`DELETE FROM settings WHERE site_id='${SITE_A}' AND key LIKE '${POLICY_KEY}%'`);
  });

  // -------------------------------------------------------------------------
  // Section 11 guards the *deployment* shape, not a media rule.
  //
  // `MEDIA` is optional in `Env`, and every R2 access goes through
  // `shared/media-store.ts`. Before that it was required, and a deploy which
  // omitted the bucket answered `1101` on every page: `env.MEDIA.get(...)` threw
  // inside template loading, above the assets fallback that exists precisely to
  // make "nothing was ever uploaded" work. No suite noticed, because every suite
  // builds its env with `makeR2()` — the absent binding was unrepresentable in
  // the harness, which is why the failure only ever appeared in production.
  // -------------------------------------------------------------------------
  await section("11. a deploy with no R2 bucket renders, and refuses to store", async () => {
    // 11a — the helper contract, asserted directly. The render path cannot show
    // it: every one of its callers has a fallback, so once the callers are
    // fixed a throw and an empty store both end in a rendered page. The
    // difference only exists at this layer.
    const store = await compileEntry("src/shared/media-store.ts");
    const bucketless = makeEnv(sqlite);
    delete bucketless.MEDIA;

    check("hasMediaStore is false with no binding", store.hasMediaStore(bucketless), false);
    check("reading a key is null, not a throw", await store.mediaStoreGet(bucketless, "uploads/x/y.png"), null);
    check("listing is empty, not a throw", (await store.mediaStoreList(bucketless)).objects.length, 0);
    let deleteThrew = false;
    try { await store.mediaStoreDelete(bucketless, "uploads/x/y.png"); } catch { deleteThrew = true; }
    check("deleting is a no-op, not a throw", deleteThrew, false);
    let putError = null;
    try { await store.mediaStorePut(bucketless, "uploads/x/y.png", new Uint8Array([1])); }
    catch (e) { putError = e; }
    check("writing refuses, and says which binding is missing",
      [putError?.name, String(putError?.message).includes("R2 `MEDIA` binding")],
      ["MediaStoreUnavailable", true]);

    // 11b — the same bucketless env through the real Worker. This is the shape
    // the production deploy actually had, and the page is what was 1101.
    const reqNoBucket = (path, init = {}, host = "localhost") =>
      worker.fetch(new Request(`http://${host}${path}`, init), bucketless, { waitUntil() {}, passThroughOnException() {} });

    // A thrown exception is reported as data rather than allowed to abort the
    // section. Without this the guard for a throwing render path reads as
    // "section 11 threw", which names no assertion and hides every check below
    // it — and a throwing render path is exactly the defect being guarded.
    const attempt = async (path, init = {}) => {
      try {
        const r = await reqNoBucket(path, init, HOST_A);
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { status: 0, body: "", threw: String((e && e.message) || e) };
      }
    };

    const home = await attempt("/");
    check("the front page does not throw out of fetch", home.threw ?? null, null);
    check("the front page still renders", home.status, 200);
    check("and it is a page, not a Worker exception", /<!doctype html/i.test(home.body), true);
    check("with no 1101 anywhere in it", /error code: 1101/.test(home.body), false);

    // Storing is the case that genuinely needs the bucket, and it has to name
    // the missing binding rather than surface a TypeError as a 500.
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "no-bucket.png", { type: "image/png" }));
    const up = await attempt(`/api/v1/media?site=${SITE_A}`, { method: "POST", headers: { Cookie: adminCookie }, body: fd });
    check("an upload without a bucket is refused with 503", up.status, 503);
    check("and the refusal names the missing binding",
      String(up.body).includes("R2 `MEDIA` binding"), true);

    // The read door cannot become a 200 (nowhere for an object to have come
    // from) and must not become a 500.
    const read = await attempt(`/media/${encodeURIComponent(`uploads/${SITE_A}/2026-01-01/none.png`)}`);
    check("and the media read path answers 404, not 500", read.status, 404);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failed: " + failures.join(", "));
  cleanup();
  sqlite.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Harness error:", (e && e.message) || e);
  console.error(String((e && e.stack) || "").split("\n").slice(0, 8).join("\n"));
  // A crashed run must still print a parseable summary, and it must say it
  // failed. Without this the reverse-validation tool reads "no summary" as
  // "could not tell", which is never a pass (ARCHITECTURE §12).
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(2);
});
