/**
 * Plugin notification channels — runtime test (batch 10, step 5).
 *
 * ## What this suite is defending
 *
 * `channels[]` is the third application of the "declare → host renders"
 * pattern (after `tables[].fields[]` and, later, `adminPages[].blocks[]`).
 * A plugin names a channel and its config fields; the *host* performs the
 * delivery. The whole design rests on three properties, and each of them has
 * a plausible way of being wrong:
 *
 *   1. **Declaring is what grants the right.** A plugin that calls `notify()`
 *      with a code it never declared must be refused, not silently served.
 *      The failure mode this prevents is "any plugin can post to any channel,
 *      including one whose credentials another plugin configured".
 *
 *   2. **A configured channel's settings are read, and only those.** The
 *      config read is keyed by the `configSchema` the manifest declared, so
 *      a stored setting with no declaration is not config. This is the same
 *      rule `tableSave` applies to undeclared fields, and the same false-green
 *      family: "I read the row I wrote, not the keys I promised to read".
 *
 *   3. **`dedupKey` means one send, not two.** The naive SELECT-then-send is
 *      racy; the claim is therefore a row INSERT against a partial unique
 *      index, made *before* the send. The assertion that proves it is "the
 *      endpoint was hit exactly once", not "the second call returned deduped"
 *      — a guard that only checks the return value would pass on an
 *      implementation that sent twice and lied about it.
 *
 * ## Why the endpoint is a stub, not a server
 *
 * `fetch` is replaced globally for the duration of the suite. The sandbox
 * cannot spawn a listener, and a real endpoint would make the dedup assertion
 * ("called once") depend on network observation. A counting stub makes the
 * call count a direct fact.
 *
 * Usage: node tests/suites/plugin-channels.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
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

/**
 * Print the summary exactly once, from every exit path.
 *
 * The suite's summary used to live at the end of `main()` only. A throw
 * anywhere before it — a parse error, a missing table — produced a run with
 * **no summary line at all**, which a grep-based checker reads as "nothing
 * failed". That is false-green type 6, and it has already happened twice in
 * this repository. The catch below therefore counts the exception as one
 * failure and still prints the line, marked `(aborted)`.
 */
function summary(aborted = false) {
  console.log(`\n${pass} passed, ${fail} failed${aborted ? " (aborted)" : ""}`);
  if (failures.length) console.log("Failures:", failures.join(", "));
}

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
  const tmp = join(root, ".wrangler", "channel-bundle.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

/**
 * Bundle `runtime.ts` on its own so `pluginApi` is reachable directly.
 *
 * The facade is what a plugin actually holds, and the properties under test
 * (declaration gates the channel; only declared config keys are read) are
 * decided *inside* it. Driving them through HTTP would mean writing a plugin
 * whose only job is to call `notify` from a hook — a lot of machinery to
 * observe something the facade decides on its own.
 */
async function compileModule(rel) {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, rel)],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "channel-mod-" + rel.replace(/[^a-z0-9]/gi, "_") + ".mjs");
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
    async put(k, v) { store.set(k, v); return { key: k }; },
    async delete(k) { store.delete(k); },
    _dump: () => [...store.keys()],
  };
}

function makeEnv(sqlite) {
  const kv = new Map();
  return {
    DB: makeD1(sqlite), MEDIA: makeR2(),
    CACHE: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: assetsStub(),
  };
}

/**
 * Replace `fetch` with a counting stub for the duration of this suite.
 *
 * Restored in `main()`'s `finally`. Returns the calls array so assertions can
 * look at what was actually sent, not just how many times.
 */
function installFetchStub() {
  const real = globalThis.fetch;
  const calls = [];
  let respond = () => new Response("ok", { status: 200 });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return respond(String(url), init);
  };
  return { calls, setResponder: (fn) => { respond = fn; }, restore: () => { globalThis.fetch = real; } };
}

function installPlugin(sqlite, manifest, siteId = "default", enabled = 1) {
  const now = Math.floor(Date.now() / 1000);
  const name = manifest.name;
  sqlite.prepare(
    "INSERT INTO plugin_installs(id,name,title,version,enabled,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,manifest=excluded.manifest,updated_at=excluded.updated_at"
  ).run(`plugin_${name}`, name, manifest.title ?? name, manifest.version ?? "1.0.0", enabled, JSON.stringify(manifest), now, now);
  for (const cap of manifest.permissions ?? []) {
    sqlite.prepare(
      "INSERT OR REPLACE INTO extension_capabilities(extension_type,extension_name,capability,enabled) VALUES(?,?,?,1)"
    ).run("plugin", name, cap);
  }
  return name;
}

/**
 * Write one channel setting row, the way the settings API would.
 *
 * `plugin_settings` is `(plugin_id, key) → value` and nothing else — there is
 * no surrogate `id` and no timestamp. The key here is the `channel.<code>.<f>`
 * shape `readChannelConfig` looks up.
 */
function setChannelSetting(sqlite, pluginName, key, value) {
  sqlite.prepare(
    "INSERT INTO plugin_settings(plugin_id,key,value) " +
    "VALUES((SELECT id FROM plugin_installs WHERE name=? LIMIT 1), ?, ?) " +
    "ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value"
  ).run(pluginName, key, value);
}

const CHANNEL_MANIFEST = {
  name: "notifyprobe",
  title: "Notify Probe",
  version: "1.0.0",
  permissions: ["settings.read", "settings.write"],
  channels: [
    {
      code: "webhook",
      label: "Webhook",
      configSchema: [
        { key: "url", label: "Endpoint URL", type: "url", required: true },
        { key: "secret", label: "Signing secret", type: "password" },
      ],
    },
  ],
};

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found. Run `npx wrangler dev` once."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));

  const CLEANUP = [
    "DELETE FROM notification_log WHERE plugin_name LIKE 'notifyprobe%'",
    "DELETE FROM plugin_settings WHERE plugin_id IN (SELECT id FROM plugin_installs WHERE name LIKE 'notifyprobe%')",
    "DELETE FROM plugin_setting_defs WHERE plugin_name LIKE 'notifyprobe%'",
    "DELETE FROM extension_capabilities WHERE extension_name LIKE 'notifyprobe%'",
    "DELETE FROM extension_versions WHERE extension_name LIKE 'notifyprobe%'",
    "DELETE FROM plugin_installs WHERE name LIKE 'notifyprobe%'",
  ];
  for (const sql of CLEANUP) { try { sqlite.exec(sql); } catch { /* ok */ } }

  const stub = installFetchStub();
  const worker = (await compileWorker()).default;
  const env = makeEnv(sqlite);
  const mod = await compileModule("src/extensions/plugin/runtime.ts");

  try {
    console.log("0. the runtime module exports a facade");
    checkTruthy("pluginApi is exported", typeof mod.pluginApi === "function");

    const name = installPlugin(sqlite, CHANNEL_MANIFEST);
    setChannelSetting(sqlite, name, "channel.webhook.url", "https://hooks.example.test/abc");
    setChannelSetting(sqlite, name, "channel.webhook.secret", "s3cr3t");
    // A second, *undeclared* key with the channel prefix. If the config reader
    // returned everything it found rather than the declared keys, this value
    // would appear in the request body — and a stray row would have become
    // configuration. That is the assertion, so the row has to exist.
    setChannelSetting(sqlite, name, "channel.webhook.not_declared", "SHOULD-NOT-LEAK");

    const api = mod.pluginApi(env, "plugin", name, CHANNEL_MANIFEST.permissions, "default", CHANNEL_MANIFEST.channels);

    // ---------------------------------------------------------------------
    console.log("\n1. a declared channel delivers, and reads only declared config");
    // ---------------------------------------------------------------------
    stub.calls.length = 0;
    const r1 = await api.notify("webhook", { title: "Hello", content: "Body", payload: { n: 1 } });
    check("send reports ok", r1.ok, true);
    check("send is not deduped", r1.deduped ?? false, false);
    check("endpoint called exactly once", stub.calls.length, 1);
    const sent = stub.calls[0];
    check("posted to the configured url", sent.url, "https://hooks.example.test/abc");
    check("used POST", sent.init.method, "POST");
    check("content-type is json", sent.init.headers["content-type"], "application/json");
    check("envelope identifies the site", sent.body.source.site, "default");
    check("envelope identifies the plugin", sent.body.source.plugin, name);
    check("envelope identifies the channel", sent.body.source.channel, "webhook");
    check("title carried through", sent.body.title, "Hello");
    check("content carried through", sent.body.content, "Body");
    check("payload carried through unmodified", sent.body.payload, { n: 1 });
    checkTruthy("an envelope timestamp is present", typeof sent.body.sentAt === "string" && sent.body.sentAt.length > 0);
    // The load-bearing negative: the undeclared setting row exists in the
    // database, and the request must not contain its value.
    check("undeclared setting does not leak into the request", JSON.stringify(sent.body).includes("SHOULD-NOT-LEAK"), false);

    // ---------------------------------------------------------------------
    console.log("\n2. an undeclared channel is refused, not served");
    // ---------------------------------------------------------------------
    stub.calls.length = 0;
    const r2 = await api.notify("mail", { title: "x", content: "y" });
    check("undeclared channel fails", r2.ok, false);
    checkTruthy("the error names the plugin", String(r2.error).includes(name));
    checkTruthy("the error names the channel", String(r2.error).includes("mail"));
    check("no request was made for an undeclared channel", stub.calls.length, 0);

    // An unsupported code that the *manifest* declares is the contract/impl
    // divergence case: it validates at install time only if it is in
    // HOST_CHANNEL_CODES, so reaching send at all means the tables disagree.
    const bogus = mod.pluginApi(env, "plugin", name, CHANNEL_MANIFEST.permissions, "default", [{ code: "carrier_pigeon", configSchema: [] }]);
    const r2b = await bogus.notify("carrier_pigeon", { title: "x", content: "y" });
    check("a declared-but-unimplemented channel fails", r2b.ok, false);
    checkTruthy("the error says there is no implementation", /no host implementation/.test(String(r2b.error)));

    // ---------------------------------------------------------------------
    console.log("\n3. bad configuration is a value, never a throw");
    // ---------------------------------------------------------------------
    // A channel with no url configured: the send must report the reason.
    sqlite.prepare(
      "UPDATE plugin_settings SET value='' WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name=? LIMIT 1) AND key='channel.webhook.url'"
    ).run(name);
    stub.calls.length = 0;
    const r3 = await api.notify("webhook", { title: "t", content: "c" });
    check("missing url fails", r3.ok, false);
    checkTruthy("the error mentions the url", /url/.test(String(r3.error)));
    check("nothing was sent without a url", stub.calls.length, 0);

    // A non-http(s) scheme must be refused before `fetch` sees it.
    setChannelSetting(sqlite, name, "channel.webhook.url", "file:///etc/passwd");
    stub.calls.length = 0;
    const r4 = await api.notify("webhook", { title: "t", content: "c" });
    check("non-http url fails", r4.ok, false);
    checkTruthy("the error names the scheme", /file:/.test(String(r4.error)));
    check("fetch was never reached with a file: url", stub.calls.length, 0);

    // A syntactically invalid url is a different branch from a wrong scheme.
    setChannelSetting(sqlite, name, "channel.webhook.url", "not a url at all");
    const r5 = await api.notify("webhook", { title: "t", content: "c" });
    check("invalid url fails", r5.ok, false);
    checkTruthy("the error mentions validity", /valid URL/.test(String(r5.error)));

    // The endpoint being down is the case the try/catch exists for. Throwing
    // here would turn "the webhook is unreachable" into a 500 on the page
    // render that fired the hook.
    setChannelSetting(sqlite, name, "channel.webhook.url", "https://hooks.example.test/abc");
    stub.setResponder(() => { throw new Error("ECONNREFUSED"); });
    let threw = null;
    let r6 = null;
    try { r6 = await api.notify("webhook", { title: "t", content: "c" }); } catch (e) { threw = e; }
    check("a failing endpoint does not throw", threw, null);
    check("a failing endpoint reports failure", r6?.ok, false);
    checkTruthy("the transport error is preserved", /ECONNREFUSED/.test(String(r6?.error)));
    stub.setResponder(() => new Response("ok", { status: 200 }));

    // A non-2xx response is also a failure with the status in the message.
    stub.setResponder(() => new Response("nope", { status: 503 }));
    const r7 = await api.notify("webhook", { title: "t", content: "c" });
    check("a 5xx is a failure", r7.ok, false);
    checkTruthy("the status is reported", /503/.test(String(r7.error)));
    stub.setResponder(() => new Response("ok", { status: 200 }));

    // Failures are recorded, not discarded. A channel that silently drops its
    // errors is indistinguishable from one that was never called, so the
    // ledger has to carry the reason. (Asserted here rather than at the end
    // because section 4 clears this plugin's ledger rows.)
    const failedRows = sqlite.prepare(
      "SELECT error FROM notification_log WHERE plugin_name=? AND ok=0"
    ).all(name);
    checkTruthy("failed sends are recorded in the ledger", failedRows.length > 0);
    checkTruthy("a recorded failure carries its error text",
      failedRows.some((r) => typeof r.error === "string" && r.error.length > 0));

    // ---------------------------------------------------------------------
    console.log("\n4. dedupKey sends once");
    // ---------------------------------------------------------------------
    stub.setResponder(() => new Response("ok", { status: 200 }));
    sqlite.prepare("DELETE FROM notification_log WHERE plugin_name=?").run(name);
    stub.calls.length = 0;
    const key = "digest-2026-09-29";
    const d1 = await api.notify("webhook", { title: "Daily", content: "1", dedupKey: key });
    const d2 = await api.notify("webhook", { title: "Daily", content: "1", dedupKey: key });
    check("first send succeeds", d1.ok, true);
    check("first send is not deduped", d1.deduped ?? false, false);
    check("second send is deduped", d2.deduped, true);
    // The assertion that actually proves the claim-before-send shape: a
    // "SELECT then send then INSERT" implementation returns `deduped: true`
    // here too, but has already called the endpoint a second time.
    check("the endpoint was hit exactly once for a repeated key", stub.calls.length, 1);

    // A different key is a different message.
    stub.calls.length = 0;
    const d3 = await api.notify("webhook", { title: "Daily", content: "2", dedupKey: "digest-2026-09-30" });
    check("a different key is not deduped", d3.deduped ?? false, false);
    check("a different key sends", stub.calls.length, 1);

    // No key means no dedup: two identical calls both send. The absence of a
    // key is a deliberate "always send", not an error.
    stub.calls.length = 0;
    await api.notify("webhook", { title: "Same", content: "Same" });
    await api.notify("webhook", { title: "Same", content: "Same" });
    check("no key means both sends go out", stub.calls.length, 2);

    // The dedup claim is tenant-scoped. A key reused by another *site* is a
    // different message, so the partial unique index must include site_id —
    // this is the assertion that would catch a key missing `site_id` from the
    // index, which would silently make one site's digest suppress another's.
    setChannelSetting(sqlite, name, "channel.webhook.url", "https://hooks.example.test/abc");
    const otherSiteApi = mod.pluginApi(env, "plugin", name, CHANNEL_MANIFEST.permissions, "othersite", CHANNEL_MANIFEST.channels);
    stub.calls.length = 0;
    const d4 = await otherSiteApi.notify("webhook", { title: "Daily", content: "1", dedupKey: key });
    check("the same key on another site still sends", d4.deduped ?? false, false);
    check("another site produced a send", stub.calls.length, 1);
    // And the mirror image: re-sending from the *default* site is still deduped
    // even though another site has since used the same key. A key that leaked
    // across sites would make this second call send.
    stub.calls.length = 0;
    const d5 = await api.notify("webhook", { title: "Daily", content: "1", dedupKey: key });
    check("the original site is still deduped after another site used the key", d5.deduped, true);
    check("nothing was sent for the still-deduped key", stub.calls.length, 0);

    // ---------------------------------------------------------------------
    console.log("\n5. the send ledger records the outcome");
    // ---------------------------------------------------------------------
    const ledger = sqlite.prepare("SELECT ok,dedup_key,error FROM notification_log WHERE plugin_name=? ORDER BY created_at").all(name);
    checkTruthy("the ledger has rows", ledger.length > 0);
    checkTruthy("a successful send is recorded ok=1", ledger.some((r) => r.ok === 1));
    checkTruthy("the dedup key is stored on the claim", ledger.some((r) => r.dedup_key === key));
    // A repeated key from the *same* site must not add a second row: the claim
    // that lost the race *is* the existing row, and writing another would put
    // the duplicate the key exists to prevent into the ledger even though it
    // never reached the endpoint. The other site's row is a different claim and
    // is expected, so the count is scoped to this site.
    const keyRows = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM notification_log WHERE plugin_name=? AND site_id=? AND dedup_key=?"
    ).get(name, "default", key);
    check("a repeated key does not add a ledger row on the same site", keyRows.n, 1);
    check("the other site did claim the same key", sqlite.prepare(
      "SELECT COUNT(*) AS n FROM notification_log WHERE plugin_name=? AND site_id=? AND dedup_key=?"
    ).get(name, "othersite", key)?.n, 1);

    // ---------------------------------------------------------------------
    console.log("\n6. the channel config read is scoped to its plugin");
    // ---------------------------------------------------------------------
    // A second plugin with the *same* channel and key prefix must not read the
    // first plugin's credentials. Without the `plugin_id` filter in
    // `readChannelConfig` this is exactly what would happen, and the leak is
    // invisible in a single-plugin install.
    const otherName = installPlugin(sqlite, { ...CHANNEL_MANIFEST, name: "notifyprobe_two", title: "Notify Probe Two" });
    const otherApi = mod.pluginApi(env, "plugin", otherName, CHANNEL_MANIFEST.permissions, "default", CHANNEL_MANIFEST.channels);
    stub.calls.length = 0;
    const r8 = await otherApi.notify("webhook", { title: "t", content: "c" });
    check("a plugin with no url of its own has nothing to send to", r8.ok, false);
    checkTruthy("it reports the missing url", /url/.test(String(r8.error)));
    check("the other plugin's url was not used", stub.calls.length, 0);
  } finally {
    stub.restore();
    for (const sql of CLEANUP) { try { sqlite.exec(sql); } catch { /* ok */ } }
  }

  summary();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  fail++;
  failures.push("(suite threw)");
  summary(true);
  process.exit(1);
});
