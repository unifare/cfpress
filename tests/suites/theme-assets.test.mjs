/**
 * Theme template and asset management test suite:
 * - Listing files for bundled and custom themes
 * - Reading template & asset files
 * - Copying (duplicating) a theme into a new custom theme
 * - Writing/updating custom theme files
 * - Exporting a theme to ZIP
 * - Deleting custom theme files and clean uninstallation
 *
 * Usage: node tests/suites/theme-assets.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { assetsStub } from "../fixtures/_assets-stub.mjs";

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
function checkTruthy(name, v, detail = "") {
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`); }
}
function section(title) { console.log(`\n── ${title} ──────────────────────────────────────────`); }

async function compileWorker() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "theme-assets-bundle.mjs");
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
          const rows = sqlite.prepare(st.sql).all(...st.params);
          return { results: rows ?? [] };
        },
        async run() {
          const res = sqlite.prepare(st.sql).run(...st.params);
          return { success: true, meta: { changes: res.changes } };
        },
      };
      return api;
    },
    async batch(stmts) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };
}

function makeR2() {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        text: async () => new TextDecoder().decode(entry.bytes),
        arrayBuffer: async () => entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength),
        size: entry.bytes.byteLength,
        customMetadata: entry.customMetadata,
      };
    },
    async put(key, body, opts) {
      let bytes;
      if (typeof body === "string") bytes = new TextEncoder().encode(body);
      else if (body instanceof Uint8Array) bytes = body;
      else if (body?.stream) {
        const chunks = [];
        const reader = body.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
      } else if (body instanceof ArrayBuffer) {
        bytes = new Uint8Array(body);
      } else {
        bytes = new Uint8Array(0);
      }
      store.set(key, { bytes, customMetadata: opts?.customMetadata });
      return { key, size: bytes.byteLength };
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", cursor } = {}) {
      const objects = [];
      for (const [k, v] of store.entries()) {
        if (k.startsWith(prefix)) {
          objects.push({ key: k, size: v.bytes.byteLength });
        }
      }
      return { objects, truncated: false };
    },
  };
}

function makeKV() {
  const map = new Map();
  return {
    async get(k) { return map.get(k) ?? null; },
    async put(k, v) { map.set(k, String(v)); },
    async delete(k) { map.delete(k); },
  };
}

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const d1 = makeD1(sqlite);
  const r2 = makeR2();
  const kv = makeKV();
  const worker = await compileWorker();

  const env = {
    DB: d1,
    MEDIA: r2,
    CACHE: kv,
    ASSETS: assetsStub(),
  };

  function cleanup() {
    sqlite.prepare("DELETE FROM admin_sessions WHERE id='sess_admin_test_token'").run();
    sqlite.prepare("DELETE FROM site_users WHERE id='user_super'").run();
    sqlite.prepare("DELETE FROM theme_installs WHERE name='mobai-custom'").run();
    sqlite.prepare("DELETE FROM extension_versions WHERE extension_name='mobai-custom'").run();
  }
  cleanup();

  // Seed admin user and session
  const adminId = "user_super";
  sqlite.prepare(
    "INSERT INTO site_users (id, username, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(adminId, "superadmin", "super@example.com", "hash", "superadmin", "active", 1000, 1000);
  const sessionId = "sess_admin_test_token";
  sqlite.prepare(
    "INSERT INTO admin_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(sessionId, adminId, Math.floor(Date.now() / 1000) + 86400, 1000);

  // Helper for authed API calls
  async function callApi(path, method = "GET", body = null) {
    const headers = {
      Cookie: `cfpress_admin=${sessionId}`,
    };
    if (body !== null && typeof body === "object") {
      headers["Content-Type"] = "application/json";
    }
    const req = new Request(`http://127.0.0.1/api/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return worker.default.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  }

  section("1. List bundled theme files");
  {
    const res = await callApi("extensions/themes/default/files");
    check("status is 200", res.status, 200);
    const data = await res.json();
    check("theme name is default", data.theme, "default");
    check("bundled is true", data.bundled, true);
    checkTruthy("contains files array", Array.isArray(data.files) && data.files.length > 0);
    const paths = data.files.map((f) => f.path);
    checkTruthy("contains theme.json", paths.includes("theme.json"));
    checkTruthy("contains templates/home.html", paths.includes("templates/home.html"));
    checkTruthy("contains templates/parts/header.html", paths.includes("templates/parts/header.html"));
    checkTruthy("contains langs/zh-CN.json", paths.includes("langs/zh-CN.json"));
    checkTruthy("all files marked readonly", data.files.every((f) => f.readonly === true));
  }

  section("2. Read bundled theme file");
  {
    const res = await callApi("extensions/themes/default/file?path=templates/home.html");
    check("read status is 200", res.status, 200);
    const data = await res.json();
    check("file path matches", data.path, "templates/home.html");
    check("readonly is true", data.readonly, true);
    checkTruthy("content contains HTML", typeof data.content === "string" && data.content.length > 50);
  }

  section("3. Write to bundled theme is refused");
  {
    const res = await callApi("extensions/themes/default/file", "PUT", {
      path: "templates/home.html",
      content: "<h1>Hacked</h1>",
    });
    check("refused with 400", res.status, 400);
    const data = await res.json();
    checkTruthy("error explains bundled is read-only", data.error?.includes("read-only"));
  }

  section("4. Copy theme (Duplicate)");
  {
    const res = await callApi("extensions/themes/default/copy", "POST", {
      name: "mobai-custom",
      title: "我的定制墨白",
    });
    check("copy status is 201", res.status, 201);
    const data = await res.json();
    check("copied theme name is mobai-custom", data.name, "mobai-custom");
    check("copied title matches", data.title, "我的定制墨白");
    checkTruthy("copied file count > 0", data.files > 5);

    // Verify D1 records
    const row = sqlite.prepare("SELECT * FROM theme_installs WHERE name='mobai-custom'").get();
    checkTruthy("theme_installs has row", !!row);
    check("active is 0 initially", row.active, 0);

    const ver = sqlite.prepare("SELECT * FROM extension_versions WHERE extension_name='mobai-custom'").get();
    checkTruthy("extension_versions has row", !!ver);
  }

  section("5. Custom theme files list & edit");
  {
    const res = await callApi("extensions/themes/mobai-custom/files");
    check("list status is 200", res.status, 200);
    const data = await res.json();
    check("bundled is false", data.bundled, false);
    checkTruthy("files marked readonly: false", data.files.every((f) => f.readonly === false));

    // Read theme.json in cloned theme
    const mfRes = await callApi("extensions/themes/mobai-custom/file?path=theme.json");
    check("read manifest status is 200", mfRes.status, 200);
    const mfData = await mfRes.json();
    const parsedMf = JSON.parse(mfData.content);
    check("manifest name was updated to mobai-custom", parsedMf.name, "mobai-custom");
    check("manifest title was updated", parsedMf.title, "我的定制墨白");

    // Write a new custom template
    const writeRes = await callApi("extensions/themes/mobai-custom/file", "PUT", {
      path: "templates/landing.html",
      content: "<section>Landing Page Custom Content</section>",
    });
    check("write status is 200", writeRes.status, 200);

    // Read back
    const readBack = await callApi("extensions/themes/mobai-custom/file?path=templates/landing.html");
    check("read back status is 200", readBack.status, 200);
    const readData = await readBack.json();
    check("content matched exactly", readData.content, "<section>Landing Page Custom Content</section>");
  }

  section("6. Export theme to ZIP");
  {
    const res = await callApi("extensions/themes/mobai-custom/export");
    check("export status is 200", res.status, 200);
    check("content-type is zip", res.headers.get("content-type"), "application/zip");
    const buf = await res.arrayBuffer();
    checkTruthy("received non-empty zip bytes", buf.byteLength > 100);

    // Unzip and inspect
    const unzipped = unzipSync(new Uint8Array(buf));
    checkTruthy("unzipped contains theme.json", !!unzipped["theme.json"]);
    checkTruthy("unzipped contains templates/landing.html", !!unzipped["templates/landing.html"]);
    const landingStr = new TextDecoder().decode(unzipped["templates/landing.html"]);
    check("unzipped template content matches", landingStr, "<section>Landing Page Custom Content</section>");
  }

  section("7. Delete file & uninstall custom theme");
  {
    // Essential file protection
    const delMf = await callApi("extensions/themes/mobai-custom/file?path=theme.json", "DELETE");
    check("deleting theme.json is refused (400)", delMf.status, 400);

    // Normal file deletion
    const delLanding = await callApi("extensions/themes/mobai-custom/file?path=templates/landing.html", "DELETE");
    check("delete custom template is 200", delLanding.status, 200);

    // Verify deleted
    const checkDel = await callApi("extensions/themes/mobai-custom/file?path=templates/landing.html");
    check("reading deleted file answers 400 not found", checkDel.status, 400);

    // Uninstall custom theme
    const uninst = await callApi("extensions/themes/mobai-custom", "DELETE");
    check("uninstall status is 200", uninst.status, 200);
    const row = sqlite.prepare("SELECT * FROM theme_installs WHERE name='mobai-custom'").get();
    check("theme_installs record is gone", row ?? null, null);
  }

  cleanup();

  console.log("\n================================================================");
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:", failures);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  console.log("(aborted) harness threw: " + ((e && e.message) || e));
  process.exit(1);
});
