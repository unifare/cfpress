// Upload + activate a theme on a running `wrangler dev` host, authenticating as
// the bootstrap admin. Usage: node scripts-upload-theme.mjs [themeDir] [base]
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

const themeDir = process.argv[2] ?? "content/themes/default";
const base = process.argv[3] ?? "http://127.0.0.1:47913";
const siteId = process.argv[4] ?? "default";

async function walk(dir, root = dir, out = []) {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) await walk(full, root, out);
    else out.push({ full, rel: relative(root, full).split(sep).join("/") });
  }
  return out;
}

async function adminCookie() {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "change-me-now" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const raw = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")])[0];
  const cookie = raw.split(";")[0];
  console.log(`login ok -> ${cookie.slice(0, 32)}...`);
  return cookie;
}

const cookie = await adminCookie();
const files = await walk(themeDir);
const zipEntries = {};
for (const f of files) zipEntries[f.rel] = new Uint8Array(await readFile(f.full));
const zipped = zipSync(zipEntries, { level: 6 });

const name = JSON.parse(await readFile(join(themeDir, "theme.json"), "utf8")).name;

const form = new FormData();
form.append("name", name);
form.append("file", new Blob([zipped], { type: "application/zip" }), `${name}.zip`);

let res = await fetch(`${base}/api/v1/extensions/themes/upload`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
console.log(`upload ${themeDir} -> ${res.status} ${(await res.text()).slice(0, 300)}`);

res = await fetch(`${base}/api/v1/extensions/themes/${encodeURIComponent(name)}/activate?site=${encodeURIComponent(siteId)}`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ siteId }),
});
console.log(`activate ${name} @ ${siteId} -> ${res.status} ${(await res.text()).slice(0, 600)}`);
