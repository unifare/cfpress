/**
 * Deleting a staff identity takes its memberships with it (batch F, rule 80).
 *
 * ## What this suite is for
 *
 * Batch E split a staff user in two: the install-wide identity (`site_users`)
 * and the per-site memberships (`site_users_sites`, one row per (person, site)).
 * Splitting one row out of another creates a second row that has to die with
 * the first — and nothing here cascades: no FK is declared on the table, and D1
 * enables foreign keys per connection, so SQLite will not remove the membership
 * rows for us.
 *
 * There is no product endpoint that deletes a user, so this suite cannot drive
 * the behaviour through `worker.fetch`. It calls the **real** `deleteUser()`
 * exported by `src/platform/auth.ts`, bundled from source the same way
 * `architecture.test.mjs` reads the source — because the thing under test is
 * the function's effect on the database, not its presence in the file.
 *
 * ## The two directions, both required
 *
 *   1. **Positive**: `deleteUser()` on a person with memberships on two sites
 *      removes the identity row *and* both membership rows, in one call.
 *   2. **Negative control**: a hand-written `DELETE FROM site_users` — the
 *      pre-batch-F shape, and exactly what a future endpoint would write if it
 *      re-derived the delete instead of calling the function — leaves the
 *      membership rows behind. Without this control the positive assertion
 *      could pass because memberships "happen to" be empty already.
 *
 * The suite owns every row it touches (`fdl_*` usernames, two `fdl*` sites) and
 * sweeps at both ends, like the other suites, so it leaves the shared local D1
 * exactly as it found it.
 *
 * Usage: node tests/suites/user-delete.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

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

/**
 * Bundle `src/platform/auth.ts` on its own and import it.
 *
 * The suite needs `deleteUser` as a *callable*, not as a string to grep. Its
 * only dependency on the worker is the `Env` type (erased at build time) and
 * `cloudflare:workers` (marked external, never actually reached by the
 * function under test — it only touches `env.DB`).
 */
async function compileAuth() {
  const esbuild = require("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(root, "src/platform/auth.ts")],
    bundle: true, format: "esm", target: "es2022", write: false,
    platform: "neutral", external: ["cloudflare:workers"], logLevel: "silent",
  });
  const tmp = join(root, ".wrangler", "user-delete-auth.mjs");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href + "?t=" + Date.now());
}

/** A D1-shaped adapter over the real local sqlite, with a real `batch`. */
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

async function main() {
  const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) { console.error("Local D1 not found."); process.exit(2); }
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) { console.error("Local D1 sqlite not found."); process.exit(2); }
  const sqlite = new DatabaseSync(join(d1Dir, files[0]));
  const env = { DB: makeD1(sqlite) };
  const { deleteUser } = await compileAuth();

  const SITE_A = "fdla";
  const SITE_B = "fdlb";
  const U1 = "fdl_multi";   // memberships on both sites
  const U2 = "fdl_solo";    // one membership

  // -- sweep (both ends): only rows this suite owns ------------------------
  // The sweep is written to survive an *earlier aborted run* of this same
  // suite, not just a clean start. If a previous run died between section 2
  // and its cleanup, `user_fdl_solo`'s membership row outlives its identity —
  // and the subquery below would then find no identity to match, missing it.
  // So orphaned `user_fdl*` membership rows are swept by id prefix directly.
  const sweep = () => {
    for (const sql of [
      "DELETE FROM site_users_sites WHERE user_id LIKE 'user\\_fdl%' ESCAPE '\\'",
      "DELETE FROM site_users_sites WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\')",
      "DELETE FROM admin_sessions WHERE user_id LIKE 'user\\_fdl%' ESCAPE '\\'",
      "DELETE FROM admin_sessions WHERE user_id IN (SELECT id FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\')",
      "DELETE FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\'",
      `DELETE FROM site_locales WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM settings WHERE site_id IN ('${SITE_A}','${SITE_B}')`,
      `DELETE FROM sites WHERE id IN ('${SITE_A}','${SITE_B}')`,
    ]) { try { sqlite.exec(sql); } catch { /* table may not exist yet */ } }
  };
  sweep();

  console.log("1. setup: two sites and a person who is a member of both");
  const now = Math.floor(Date.now() / 1000);
  for (const id of [SITE_A, SITE_B]) {
    sqlite.prepare("INSERT INTO sites(id,name,status,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, id, "active", 0, now, now);
  }
  const mkUser = (id, username) => {
    sqlite.prepare("INSERT INTO site_users(id,username,email,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, username, null, "x", "editor", "active", now, now);
  };
  const u1Id = "user_fdl_multi";
  const u2Id = "user_fdl_solo";
  mkUser(u1Id, U1);
  mkUser(u2Id, U2);
  sqlite.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)").run(u1Id, SITE_A, "editor", now);
  sqlite.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)").run(u1Id, SITE_B, "author", now);
  sqlite.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)").run(u2Id, SITE_A, "editor", now);

  check("the identity rows exist", sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\'").get().n, 2);
  check("the person on two sites has two membership rows",
    sqlite.prepare("SELECT site_id, role FROM site_users_sites WHERE user_id=? ORDER BY site_id").all(u1Id).map((r) => [r.site_id, r.role]),
    [[SITE_A, "editor"], [SITE_B, "author"]]);

  console.log("\n2. the negative control: a hand-written identity delete leaves the memberships behind");
  // This is the pre-batch-F shape — and the shape a future endpoint writes if it
  // re-derives the delete instead of calling `deleteUser`. If this assertion
  // ever stops holding, the positive test below proves nothing.
  sqlite.prepare("DELETE FROM site_users WHERE id=?").run(u2Id);
  check("the identity is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE id=?").get(u2Id).n, 0);
  check("but its membership row is orphaned (this is the defect rule 80 prevents)",
    sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=?").get(u2Id).n, 1);
  // Clean the orphan so it cannot be mistaken for `deleteUser`'s doing.
  sqlite.prepare("DELETE FROM site_users_sites WHERE user_id=?").run(u2Id);

  console.log("\n3. deleteUser() removes the identity AND every membership");
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=?").get(u1Id).n;
  check("the person has memberships before the delete (non-vacuity)", before, 2);

  const res = await deleteUser(env, u1Id);
  check("deleteUser reports success", res, { ok: true });
  check("the identity row is gone", sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE id=?").get(u1Id).n, 0);
  check("and so is every membership row",
    sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=?").get(u1Id).n, 0);

  console.log("\n4. the delete does not reach across people");
  // `deleteUser` must be addressed by the identity it is given — a stray
  // `WHERE`-less DELETE would clear the table and still pass section 3.
  //
  // If section 3 failed because `deleteUser` left the memberships behind, u1's
  // rows are still here. Clear them *first*: a regression must be reported as a
  // failure in every section (each with its own line), not abort section 4 with
  // a `UNIQUE constraint failed` that masks the later assertions.
  sqlite.exec("DELETE FROM site_users_sites WHERE user_id = '" + u1Id + "'");
  mkUser(u2Id, U2);
  sqlite.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)").run(u2Id, SITE_B, "editor", now);
  await deleteUser(env, "user_fdl_absent");   // a person who does not exist
  check("deleting a non-existent id removes nothing",
    sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\'").get().n, 1);
  check("and leaves the surviving person's membership intact",
    sqlite.prepare("SELECT site_id FROM site_users_sites WHERE user_id=? ORDER BY site_id").all(u2Id).map((r) => r.site_id),
    [SITE_B]);
  await deleteUser(env, u2Id);
  check("deleting them removes their membership too",
    sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=?").get(u2Id).n, 0);

  console.log("\n5. the two statements are one atomic unit (a real batch, not two awaits)");
  // `deleteUser` builds one `DB.batch([...])`. Drive it with a batch recording
  // its arguments: if the implementation were two independent `.run()` calls,
  // this spy would see zero batches and two runs — and the intermediate state
  // (identity gone, memberships present) would be observable to a reader.
  // Same self-cleaning as section 4: if the earlier deletes leaked rows, drop
  // them so this section still reaches its own assertions.
  sqlite.exec("DELETE FROM site_users_sites WHERE user_id IN ('" + u1Id + "','" + u2Id + "')");
  sqlite.exec("DELETE FROM site_users WHERE id IN ('" + u1Id + "','" + u2Id + "')");
  mkUser(u1Id, U1);
  sqlite.prepare("INSERT INTO site_users_sites(user_id,site_id,role,created_at) VALUES(?,?,?,?)").run(u1Id, SITE_A, "editor", now);
  let batchCalls = 0, topLevelRuns = 0, batchSize = 0, inBatch = false;
  const spyD1 = {
    prepare(sql) {
      const st = { sql, params: [] };
      const api = {
        bind(...a) { st.params = a; return api; },
        async run() {
          // Count only *top-level* runs. A correct `batch` executes its own
          // statements through this adapter; counting those would report the
          // implementation as "running statements outside the batch", which is
          // what a batch is supposed to do.
          if (!inBatch) topLevelRuns++;
          const r = sqlite.prepare(st.sql).run(...st.params);
          return { success: true, meta: { changes: r.changes } };
        },
        async first() { return sqlite.prepare(st.sql).get(...st.params) ?? null; },
        async all() { return { results: sqlite.prepare(st.sql).all(...st.params), success: true, meta: {} }; },
      };
      return api;
    },
    async batch(stmts) {
      batchCalls++; batchSize = stmts.length;
      inBatch = true;
      try { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
      finally { inBatch = false; }
    },
  };
  await deleteUser({ DB: spyD1 }, u1Id);
  check("the delete goes through exactly one batch()", batchCalls, 1);
  check("the batch carries both statements", batchSize, 2);
  check("and nothing was executed outside it", topLevelRuns, 0);
  check("the person is fully gone after that one call",
    [sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE id=?").get(u1Id).n,
     sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id=?").get(u1Id).n],
    [0, 0]);

  console.log("\ncleanup");
  sweep();
  check("the suite's own fixtures are gone",
    [sqlite.prepare("SELECT COUNT(*) AS n FROM site_users WHERE username LIKE 'fdl\\_%' ESCAPE '\\'").get().n,
     sqlite.prepare("SELECT COUNT(*) AS n FROM site_users_sites WHERE user_id LIKE 'user_fdl%'").get().n,
     sqlite.prepare("SELECT COUNT(*) AS n FROM sites WHERE id IN (?1,?2)").get(SITE_A, SITE_B).n],
    [0, 0, 0]);

  summary();
  process.exit(fail ? 1 : 0);
}

/** The summary is printed even when main() throws — a suite that dies halfway
 *  must never be mistaken for a suite that passed (the sixth false-green). */
function summary(note) {
  const suffix = note ? ` (${note})` : "";
  console.log(`\n${pass} passed, ${fail} failed${suffix}`);
  if (failures.length) console.log("Failed: " + failures.join(", "));
}

try {
  await main();
} catch (e) {
  fail++; failures.push(`harness threw: ${(e && e.message) || e}`);
  console.error(e);
  summary("aborted");
  process.exit(2);
}
