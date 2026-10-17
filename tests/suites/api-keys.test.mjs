/**
 * API Key authentication + OpenAPI 3.1 specification tests.
 *
 * Covers:
 *   1. GET /api/v1/openapi.json     — OpenAPI 3.1 schema definition export
 *   2. POST /api/v1/auth/api-keys   — Create API key, verify one-time plain token
 *   3. GET /api/v1/auth/api-keys    — List user's keys (hash & raw token hidden)
 *   4. Bearer Token Auth            — Call APIs via Authorization: Bearer cfp_live_...
 *   5. Last used tracking           — api_keys.last_used_at updated on authenticated call
 *   6. Multi-tenant Site Scoping    — Key limited to specific sites blocked on others (403)
 *   7. Permission Scoping           — Key limited to specific scopes blocked on writes (403)
 *   8. Revocation                   — DELETE /api/v1/auth/api-keys/:id immediately revokes (401)
 *
 * Runs against the REAL worker bundle and the REAL local D1.
 *
 * Usage: node tests/suites/api-keys.test.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const require = createRequire(pathToFileURL(join(root, "package.json")));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function summary(tag, aborted = false) {
  const line = `${passed} passed, ${failed} failed`;
  console.log(`\n${line}${aborted ? " (aborted)" : ""}`);
}

process.on("uncaughtException", (e) => {
  failed++;
  console.log(`  FAIL uncaught exception: ${e?.stack || e}`);
  summary("api-keys", true);
  process.exit(1);
});

process.on("unhandledRejection", (e) => {
  failed++;
  console.log(`  FAIL unhandled rejection: ${e?.stack || e}`);
  summary("api-keys", true);
  process.exit(1);
});

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "api-keys-bundle.mjs");
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
        async first(c) {
          const r = sqlite.prepare(st.sql).get(...st.params);
          return c !== undefined && r ? r[c] : (r ?? null);
        },
        async all() {
          return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} };
        },
        async run() {
          const r = sqlite.prepare(st.sql).run(...st.params);
          return { success: true, meta: { changes: r.changes } };
        },
      };
      return api;
    },
    async batch(s) {
      const o = [];
      for (const x of s) o.push(await x.run());
      return o;
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true };
    },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(k) {
      if (!store.has(k)) return null;
      const e = store.get(k);
      return { async text() { return typeof e === "string" ? e : new TextDecoder().decode(e); }, body: e };
    },
    async put(k, v) { store.set(k, v); return { key: k }; },
    async delete(k) { store.delete(k); },
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

async function req(worker, env, path, init = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });
}

async function main() {
  console.log("api-keys & openapi suite\n");

  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);

  // Sweep helper: clean up test keys and test terms created by this suite
  const sweep = () => {
    try {
      sqlite.exec("DELETE FROM api_keys WHERE name LIKE 'test-ai-%'");
      sqlite.exec("DELETE FROM terms WHERE slug LIKE 'ai-tech-%' OR slug LIKE 'edge-cn-%' OR slug LIKE 'edge-en-%' OR slug='ai-tech'");
    } catch {
      /* ignore */
    }
  };

  sweep();

  try {
    // -------------------------------------------------------------------------
    // 1. OpenAPI 3.1 Specification Export
    // -------------------------------------------------------------------------
    const specRes = await req(worker, env, "/api/v1/openapi.json");
    check("GET /api/v1/openapi.json returns 200", specRes.status === 200, `status=${specRes.status}`);
    const spec = await specRes.json();
    check("spec is OpenAPI 3.1.0", spec.openapi === "3.1.0", `openapi=${spec.openapi}`);
    check("spec contains title CFPress REST API", spec.info?.title === "CFPress REST API", `title=${spec.info?.title}`);
    check("spec has BearerAuth security scheme", !!spec.components?.securitySchemes?.BearerAuth, "securitySchemes missing BearerAuth");
    check("spec paths define /posts", !!spec.paths?.["/posts"], "paths missing /posts");
    check("spec paths define /auth/api-keys", !!spec.paths?.["/auth/api-keys"], "paths missing /auth/api-keys");

    // -------------------------------------------------------------------------
    // 2. Unauthenticated and Invalid Bearer Token
    // -------------------------------------------------------------------------
    const badTokenRes = await req(worker, env, "/api/v1/posts", {
      headers: { Authorization: "Bearer cfp_live_invalidtoken12345" },
    });
    check("invalid Bearer token returns 401", badTokenRes.status === 401, `status=${badTokenRes.status}`);

    // -------------------------------------------------------------------------
    // 3. Sign in as admin to manage API keys
    // -------------------------------------------------------------------------
    const loginRes = await req(worker, env, "/admin/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "change-me-now" }),
    });
    const cookie = loginRes.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    check("admin login returns admin session cookie", cookie.startsWith("cfpress_admin="), `cookie=${cookie}`);

    // -------------------------------------------------------------------------
    // 4. Create an API Key (Full access: scopes=["*"], sites=["*"])
    // -------------------------------------------------------------------------
    const createRes = await req(worker, env, "/api/v1/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "test-ai-key-full", scopes: ["*"], sites: ["*"] }),
    });
    check("create API key returns 201", createRes.status === 201, `status=${createRes.status}`);
    const createData = await createRes.json();
    const token = createData.token;
    check("created token starts with cfp_live_", typeof token === "string" && token.startsWith("cfp_live_"), `token=${token}`);
    check("created key record has id and prefix", !!createData.key?.id && !!createData.key?.key_prefix, `key=${JSON.stringify(createData.key)}`);

    // -------------------------------------------------------------------------
    // 5. List API keys
    // -------------------------------------------------------------------------
    const listRes = await req(worker, env, "/api/v1/auth/api-keys", {
      headers: { Cookie: cookie },
    });
    check("list API keys returns 200", listRes.status === 200, `status=${listRes.status}`);
    const listData = await listRes.json();
    const found = (listData.items || []).find((k) => k.name === "test-ai-key-full");
    check("listed keys includes test-ai-key-full", !!found, `items=${JSON.stringify(listData.items)}`);
    check("listed keys do not leak key_hash", found && !("key_hash" in found), "key_hash leaked in list");

    // -------------------------------------------------------------------------
    // 6. Access API using Bearer Token
    // -------------------------------------------------------------------------
    const meRes = await req(worker, env, "/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check("GET /api/v1/auth/me with Bearer token returns 200", meRes.status === 200, `status=${meRes.status}`);
    const meData = await meRes.json();
    check("me user matches admin", meData.user?.username === "admin", `user=${JSON.stringify(meData.user)}`);

    const postsRes = await req(worker, env, "/api/v1/posts?site=default", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check("GET /api/v1/posts with Bearer token returns 200", postsRes.status === 200, `status=${postsRes.status}`);

    // Verify expanded REST endpoints for AI Agents (stats, taxonomies, terms)
    const statsRes = await req(worker, env, "/api/v1/stats?site=default", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check("GET /api/v1/stats with Bearer token returns 200", statsRes.status === 200, `status=${statsRes.status}`);
    const statsData = await statsRes.json();
    check("statsData contains counts object", typeof statsData.counts?.posts === "number");

    const taxRes = await req(worker, env, "/api/v1/taxonomies?site=default", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check("GET /api/v1/taxonomies with Bearer token returns 200", taxRes.status === 200, `status=${taxRes.status}`);

    const createTermRes = await req(worker, env, "/api/v1/taxonomies/category/terms?site=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "AI Tech", slug: "ai-tech-" + Date.now() }),
    });
    check("POST /api/v1/taxonomies/category/terms returns 201", createTermRes.status === 201, `status=${createTermRes.status}`);

    // Verify tag creation with multi-language support (locale & lang_group)
    const createZhTag = await req(worker, env, "/api/v1/tags?site=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "边缘计算", slug: "edge-cn-" + Date.now(), locale: "zh-CN", lang_group: "grp_edge" }),
    });
    check("POST /api/v1/tags with locale zh-CN returns 201", createZhTag.status === 201, `status=${createZhTag.status}`);

    const createEnTag = await req(worker, env, "/api/v1/tags?site=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Edge Computing", slug: "edge-en-" + Date.now(), locale: "en", lang_group: "grp_edge" }),
    });
    check("POST /api/v1/tags with locale en returns 201", createEnTag.status === 201, `status=${createEnTag.status}`);

    // Verify locale-scoped tag listing
    const zhListRes = await req(worker, env, "/api/v1/tags?site=default&locale=zh-CN", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const zhListData = await zhListRes.json();
    const hasZh = (zhListData.items || []).some((t) => t.name === "边缘计算");
    const hasEnInZh = (zhListData.items || []).some((t) => t.name === "Edge Computing");
    check("locale-filtered tag list includes zh tag", hasZh);
    check("locale-filtered tag list excludes other language tag", !hasEnInZh);

    // Verify post creation with tags (auto-bind and auto-create)
    const postWithTagsRes = await req(worker, env, "/api/v1/posts?site=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: "Test Tagging Post",
        slug: "test-tagging-post-" + Date.now(),
        content: "Testing automatic tagging and term relationships",
        status: "published",
        tags: ["边缘计算", "CloudflareAutoTag"],
      }),
    });
    check("POST /api/v1/posts with tags returns 200/201", postWithTagsRes.status === 200 || postWithTagsRes.status === 201, `status=${postWithTagsRes.status}`);

    // Verify terms.count was incremented and auto-created tag exists
    const autoTagRow = sqlite.prepare("SELECT name, count FROM terms WHERE name = ? AND site_id = 'default'").get("CloudflareAutoTag");
    check("auto-created tag exists in terms table", !!autoTagRow, `autoTagRow=${JSON.stringify(autoTagRow)}`);
    check("tag count was incremented for published post", Number(autoTagRow?.count) >= 1, `count=${autoTagRow?.count}`);

    // Verify last_used_at was updated in D1
    const row = sqlite.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(createData.key.id);
    check("api_keys.last_used_at was updated", Number(row?.last_used_at) > 0, `last_used_at=${row?.last_used_at}`);

    // -------------------------------------------------------------------------
    // 7. Multi-tenant Site Scoping
    // -------------------------------------------------------------------------
    const siteScopedRes = await req(worker, env, "/api/v1/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "test-ai-scoped-site", scopes: ["*"], sites: ["some-other-site"] }),
    });
    const siteScopedData = await siteScopedRes.json();
    const siteToken = siteScopedData.token;

    const crossSiteRes = await req(worker, env, "/api/v1/posts?site=default", {
      headers: { Authorization: `Bearer ${siteToken}` },
    });
    check("site-scoped API key blocked on other site (403)", crossSiteRes.status === 403, `status=${crossSiteRes.status}`);

    // -------------------------------------------------------------------------
    // 8. Scope / Permission Scoping
    // -------------------------------------------------------------------------
    const permScopedRes = await req(worker, env, "/api/v1/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "test-ai-readonly", scopes: ["posts.read"], sites: ["*"] }),
    });
    const permScopedData = await permScopedRes.json();
    const readToken = permScopedData.token;

    // Read should succeed
    const readPostRes = await req(worker, env, "/api/v1/posts?site=default", {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    check("permission-scoped key can read (200)", readPostRes.status === 200, `status=${readPostRes.status}`);

    // Write should be forbidden
    const writePostRes = await req(worker, env, "/api/v1/posts?site=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ title: "Forbidden write", content: "test" }),
    });
    check("permission-scoped key forbidden on write (403)", writePostRes.status === 403, `status=${writePostRes.status}`);

    // -------------------------------------------------------------------------
    // 9. Revoke API Key
    // -------------------------------------------------------------------------
    const revokeRes = await req(worker, env, `/api/v1/auth/api-keys/${createData.key.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    check("DELETE /api/v1/auth/api-keys/:id returns 200", revokeRes.status === 200, `status=${revokeRes.status}`);

    const afterRevokeRes = await req(worker, env, "/api/v1/posts?site=default", {
      headers: { Authorization: `Bearer ${token}` },
    });
    check("revoked token immediately returns 401", afterRevokeRes.status === 401, `status=${afterRevokeRes.status}`);

  } finally {
    sweep();
  }

  summary("api-keys");
  process.exit(failed ? 1 : 0);
}

main();
