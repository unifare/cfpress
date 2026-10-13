#!/usr/bin/env node
/**
 * Seed the **local test sites** and bind each one to a test domain.
 *
 * ## Why this exists
 *
 * Multi-site isolation is invisible on a single-site install, and it is
 * invisible again the moment the database is rebuilt — the sites lived only in
 * whatever run created them. This script makes the test topology a thing that
 * can be re-created, the same way `seed-demo-content.mjs` re-creates the
 * articles.
 *
 * The topology it creates (host-based, no path prefixes — that is the cleanest
 * way to demonstrate isolation):
 *
 *   | id      | host               | reached at                          |
 *   |---------|--------------------|-------------------------------------|
 *   | default | cfpress.test       | http://cfpress.test:47913/          |
 *   | shop    | shop.cfpress.test  | http://shop.cfpress.test:47913/     |
 *   | de      | de.cfpress.test    | http://de.cfpress.test:47913/       |
 *
 * The **domains are the single source for the hosts file**: bind them with
 * `node scripts/dev-hosts.mjs add` (needs an elevated shell; it backs the file
 * up first). The port is the dev server's (`CFP_PORT`, default 47913) — the
 * hosts file maps names to addresses, never to ports.
 *
 * Idempotent: an existing site is updated (its `host` re-asserted), a missing
 * one is created. Running it twice converges on the same topology.
 *
 * Local dev only. Usage: node scripts/seed-sites.mjs
 */
const BASE = process.env.CFP_BASE || "http://127.0.0.1:47913";
const USER = process.env.CFP_USER || "admin";
const PASS = process.env.CFP_PASS || "change-me-now";

/**
 * ⚠️ `default` gets a host too. Without it, `resolveSite()` answers *every*
 * unknown host with the default site by falling back — which is correct
 * behaviour, but it means "cfpress.test" and "localhost" would be two names
 * for one site by coincidence. A declared host makes the mapping explicit and
 * lets `dev-hosts verify` check it end to end.
 */
const SITES = [
  { id: "default", name: "Default Site", host: "cfpress.test" },
  { id: "shop-demo", name: "Shop (demo)", host: "shop.cfpress.test" },
  { id: "de-demo", name: "Deutsch (demo)", host: "de.cfpress.test" },
];

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api/v1/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const login = await api("auth/login", {
  method: "POST",
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (login.status >= 400) {
  console.error("login failed", login.status, login.json);
  process.exit(1);
}
console.log(`login ok  (${BASE})`);

const list = await api("sites");
if (list.status >= 400) { console.error("could not list sites", list.status); process.exit(1); }
const existing = new Map((list.json?.items ?? []).map((s) => [s.id, s]));

let failures = 0;
for (const s of SITES) {
  const has = existing.has(s.id);
  const r = has
    ? await api(`sites/${encodeURIComponent(s.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name: s.name, host: s.host }),
      })
    : await api("sites", {
        method: "POST",
        body: JSON.stringify({ id: s.id, name: s.name, host: s.host }),
      });
  const okFlag = r.status < 400;
  if (!okFlag) failures++;
  console.log(`${okFlag ? "ok  " : "FAIL"} ${has ? "update" : "create"} ${s.id.padEnd(8)} ${s.host} -> ${r.status}${okFlag ? "" : " " + JSON.stringify(r.json)}`);
}

// Read the mapping back: this is the list `dev-hosts.mjs` will bind, so it is
// verified here rather than trusted.
const after = await api("sites");
const rows = new Map((after.json?.items ?? []).map((s) => [s.id, s.host]));
console.log("\nverify (sites.host as the router will see it):");
for (const s of SITES) {
  const host = rows.get(s.id);
  const ok = host === s.host;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${s.id.padEnd(8)} -> ${host ?? "(no host)"}${ok ? "" : ` expected ${s.host}`}`);
}

console.log(`\n${SITES.length} site(s) seeded, ${failures} failure(s).`);
if (failures) process.exit(1);
console.log("Next:  node scripts/dev-hosts.mjs add    (binds these domains in the hosts file — needs an elevated shell)");
