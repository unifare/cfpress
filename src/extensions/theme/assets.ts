/**
 * Theme template & asset management: listing, reading, writing, deleting,
 * copying (duplicating), and exporting (packaging to ZIP).
 */
import { zipSync, strToU8 } from "fflate";
import { Env } from "../../shared/types";
import { BUNDLED_THEMES, bundledThemeFile } from "../../shared/bundled";
import { randomId } from "../../shared/crypto";
import { safeZipPath, sha256 } from "../security";
import { validateManifest } from "../contract/validation";

export interface ThemeFileEntry {
  path: string;
  size: number;
  type: "template" | "part" | "asset" | "lang" | "config" | "other";
  readonly: boolean;
}

export interface ThemeFileListResult {
  theme: string;
  title: string;
  version: string;
  bundled: boolean;
  files: ThemeFileEntry[];
}

export interface ThemeFileContentResult {
  theme: string;
  path: string;
  content: string;
  contentType: string;
  readonly: boolean;
}

function classifyPath(p: string): ThemeFileEntry["type"] {
  if (p === "theme.json") return "config";
  if (p.startsWith("templates/parts/")) return "part";
  if (p.startsWith("templates/")) return "template";
  if (p.startsWith("langs/")) return "lang";
  if (p.startsWith("assets/")) return "asset";
  return "other";
}

function resolveContentType(p: string): string {
  if (p.endsWith(".html")) return "text/html;charset=UTF-8";
  if (p.endsWith(".css")) return "text/css;charset=UTF-8";
  if (p.endsWith(".js")) return "text/javascript;charset=UTF-8";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  return "text/plain;charset=UTF-8";
}

function normalizeRelPath(p: string): string {
  const norm = String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!norm || norm.includes("..") || norm.startsWith("/")) {
    throw new Error(`Invalid relative path: "${p}"`);
  }
  return norm;
}

/**
 * List all template & asset files for a given theme.
 * For bundled themes, manifests and declared parts are traversed.
 * For custom/uploaded themes, R2 object store prefix is scanned.
 */
export async function listThemeFiles(env: Env, themeName: string): Promise<ThemeFileListResult> {
  const isBundled = (BUNDLED_THEMES as readonly string[]).includes(themeName);
  let title = themeName;
  let version = "1.0.0";
  let manifest: any = null;

  if (isBundled) {
    const raw = await bundledThemeFile(env, themeName, "theme.json");
    if (raw) {
      try {
        manifest = JSON.parse(raw);
        title = manifest.title || themeName;
        version = manifest.version || "1.0.0";
      } catch {}
    }
  } else {
    const row = await env.DB.prepare(
      "SELECT title, version, manifest FROM theme_installs WHERE name=? LIMIT 1"
    ).bind(themeName).first<any>();
    if (!row) throw new Error(`Theme "${themeName}" not found`);
    title = row.title || themeName;
    version = row.version || "1.0.0";
    try {
      manifest = JSON.parse(String(row.manifest || "{}"));
    } catch {}
  }

  const files: ThemeFileEntry[] = [];

  if (isBundled) {
    const candidates: string[] = ["theme.json"];
    if (manifest) {
      if (Array.isArray(manifest.templates)) {
        for (const t of manifest.templates) candidates.push(`templates/${t}.html`);
      }
      if (Array.isArray(manifest.parts)) {
        for (const p of manifest.parts) candidates.push(`templates/parts/${p}.html`);
      }
      if (Array.isArray(manifest.locales)) {
        for (const loc of manifest.locales) candidates.push(`langs/${loc}.json`);
      }
    }
    // Check known optional assets
    for (const opt of ["assets/style.css", "assets/main.js", "assets/app.css"]) {
      candidates.push(opt);
    }

    const seen = new Set<string>();
    for (const p of candidates) {
      if (seen.has(p)) continue;
      seen.add(p);
      const text = await bundledThemeFile(env, themeName, p);
      if (text !== null) {
        files.push({
          path: p,
          size: new TextEncoder().encode(text).length,
          type: classifyPath(p),
          readonly: true,
        });
      }
    }
  } else {
    if (!env.MEDIA) {
      throw new Error("R2 storage (env.MEDIA) is not configured");
    }
    const prefix = `extensions/themes/${themeName}/${version}/files/`;
    let cursor: string | undefined;
    do {
      const list = await env.MEDIA.list({ prefix, cursor });
      for (const obj of list.objects) {
        const rel = obj.key.slice(prefix.length);
        if (!rel || rel.endsWith("/")) continue;
        files.push({
          path: rel,
          size: obj.size,
          type: classifyPath(rel),
          readonly: false,
        });
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    theme: themeName,
    title,
    version,
    bundled: isBundled,
    files,
  };
}

/**
 * Read a single file's text content.
 */
export async function readThemeFile(
  env: Env,
  themeName: string,
  relPath: string
): Promise<ThemeFileContentResult> {
  const norm = normalizeRelPath(relPath);
  const isBundled = (BUNDLED_THEMES as readonly string[]).includes(themeName);

  if (isBundled) {
    const text = await bundledThemeFile(env, themeName, norm);
    if (text === null) throw new Error(`File "${norm}" not found in theme "${themeName}"`);
    return {
      theme: themeName,
      path: norm,
      content: text,
      contentType: resolveContentType(norm),
      readonly: true,
    };
  }

  if (!env.MEDIA) throw new Error("R2 storage is not configured");
  const row = await env.DB.prepare(
    "SELECT version FROM theme_installs WHERE name=? LIMIT 1"
  ).bind(themeName).first<any>();
  if (!row) throw new Error(`Theme "${themeName}" not found`);

  const key = `extensions/themes/${themeName}/${row.version}/files/${norm}`;
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new Error(`File "${norm}" not found in theme "${themeName}"`);

  const text = await obj.text();
  return {
    theme: themeName,
    path: norm,
    content: text,
    contentType: resolveContentType(norm),
    readonly: false,
  };
}

/**
 * Write or update a single file in a custom theme.
 * Bundled themes are strictly read-only.
 */
export async function writeThemeFile(
  env: Env,
  themeName: string,
  relPath: string,
  content: string
): Promise<{ ok: boolean; path: string; size: number }> {
  const norm = normalizeRelPath(relPath);
  if (!safeZipPath(norm)) throw new Error(`Unsafe file path: "${norm}"`);

  if ((BUNDLED_THEMES as readonly string[]).includes(themeName)) {
    throw new Error(`Bundled theme "${themeName}" is read-only. Please duplicate it first.`);
  }

  if (!env.MEDIA) throw new Error("R2 storage is not configured");
  const row = await env.DB.prepare(
    "SELECT version, manifest FROM theme_installs WHERE name=? LIMIT 1"
  ).bind(themeName).first<any>();
  if (!row) throw new Error(`Theme "${themeName}" not found`);

  const version = row.version || "1.0.0";
  const contentType = resolveContentType(norm);
  const key = `extensions/themes/${themeName}/${version}/files/${norm}`;
  const bytes = new TextEncoder().encode(content);

  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public,max-age=60" },
  });

  // If theme.json was modified, validate and update theme_installs manifest
  if (norm === "theme.json") {
    let manifestObj: any;
    try {
      manifestObj = JSON.parse(content);
    } catch {
      throw new Error("theme.json must be valid JSON");
    }
    validateManifest(manifestObj, "theme");
    await env.DB.prepare(
      "UPDATE theme_installs SET manifest=?, updated_at=? WHERE name=?"
    ).bind(content, Math.floor(Date.now() / 1000), themeName).run();
  }

  return { ok: true, path: norm, size: bytes.length };
}

/**
 * Delete a file from a custom theme.
 * Essential files (theme.json, templates/index.html) cannot be removed.
 */
export async function deleteThemeFile(
  env: Env,
  themeName: string,
  relPath: string
): Promise<{ ok: boolean; path: string }> {
  const norm = normalizeRelPath(relPath);
  if ((BUNDLED_THEMES as readonly string[]).includes(themeName)) {
    throw new Error(`Bundled theme "${themeName}" is read-only.`);
  }
  if (norm === "theme.json") {
    throw new Error("Cannot delete theme.json manifest");
  }
  if (norm === "templates/index.html") {
    throw new Error("Cannot delete essential template templates/index.html");
  }

  if (!env.MEDIA) throw new Error("R2 storage is not configured");
  const row = await env.DB.prepare(
    "SELECT version FROM theme_installs WHERE name=? LIMIT 1"
  ).bind(themeName).first<any>();
  if (!row) throw new Error(`Theme "${themeName}" not found`);

  const key = `extensions/themes/${themeName}/${row.version}/files/${norm}`;
  await env.MEDIA.delete(key);
  return { ok: true, path: norm };
}

/**
 * Duplicate an entire theme (bundled or custom) into a new custom theme.
 */
export async function copyTheme(
  env: Env,
  srcThemeName: string,
  destThemeName: string,
  destTitle: string,
  userId: string
): Promise<{ ok: boolean; name: string; title: string; files: number }> {
  const cleanName = String(destThemeName || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(cleanName)) {
    throw new Error("New theme identifier must be 2-32 lowercase characters (a-z, 0-9, _, -)");
  }
  if ((BUNDLED_THEMES as readonly string[]).includes(cleanName)) {
    throw new Error(`"${cleanName}" conflicts with a bundled theme name`);
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM theme_installs WHERE name=? LIMIT 1"
  ).bind(cleanName).first<any>();
  if (existing) {
    throw new Error(`Theme "${cleanName}" already exists`);
  }

  if (!env.MEDIA) throw new Error("R2 storage is not configured");

  // Read all source files
  const list = await listThemeFiles(env, srcThemeName);
  if (!list.files.length) {
    throw new Error(`Source theme "${srcThemeName}" has no files`);
  }

  const fileMap: Record<string, Uint8Array> = {};
  const version = "1.0.0";
  const nowTs = Math.floor(Date.now() / 1000);

  for (const f of list.files) {
    const fileRes = await readThemeFile(env, srcThemeName, f.path);
    let body = fileRes.content;
    if (f.path === "theme.json") {
      try {
        const m = JSON.parse(body);
        m.name = cleanName;
        m.title = destTitle || cleanName;
        m.version = version;
        body = JSON.stringify(m, null, 2);
      } catch {}
    }
    const bytes = new TextEncoder().encode(body);
    fileMap[f.path] = bytes;

    const r2Key = `extensions/themes/${cleanName}/${version}/files/${f.path}`;
    await env.MEDIA.put(r2Key, bytes, {
      httpMetadata: { contentType: resolveContentType(f.path), cacheControl: "public,max-age=300" },
    });
  }

  // Build ZIP package in memory using fflate
  const zipInput: Record<string, Uint8Array> = {};
  for (const [p, b] of Object.entries(fileMap)) {
    zipInput[p] = b;
  }
  const zipBytes = zipSync(zipInput);
  const checksum = await sha256(zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer);
  const packageKey = `extensions/themes/${cleanName}/${version}/${checksum}.zip`;

  await env.MEDIA.put(packageKey, zipBytes, {
    httpMetadata: { contentType: "application/zip", cacheControl: "private, max-age=0" },
    customMetadata: { type: "theme", name: cleanName, version },
  });

  const manifestStr = new TextDecoder().decode(fileMap["theme.json"] ?? strToU8("{}"));
  let validatedManifest: any;
  try {
    validatedManifest = validateManifest(JSON.parse(manifestStr), "theme");
  } catch (err: any) {
    throw new Error(`Manifest validation failed: ${err.message}`);
  }

  // Insert extension_versions & theme_installs
  await env.DB.prepare(
    "INSERT INTO extension_versions(id,extension_type,extension_name,version,package_key,checksum,manifest,installed_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(await randomId(), "theme", cleanName, version, packageKey, checksum, manifestStr, nowTs).run();

  await env.DB.prepare(
    `INSERT INTO theme_installs(id,name,title,version,active,manifest,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET title=excluded.title,version=excluded.version,manifest=excluded.manifest,updated_at=excluded.updated_at`
  ).bind(`theme_${cleanName}`, cleanName, destTitle || cleanName, version, 0, manifestStr, nowTs, nowTs).run();

  return {
    ok: true,
    name: cleanName,
    title: destTitle || cleanName,
    files: list.files.length,
  };
}

/**
 * Package an entire theme into a ZIP buffer for export/download.
 */
export async function exportThemeZip(env: Env, themeName: string): Promise<Uint8Array> {
  const list = await listThemeFiles(env, themeName);
  if (!list.files.length) throw new Error(`Theme "${themeName}" has no files`);

  const zipInput: Record<string, Uint8Array> = {};
  for (const f of list.files) {
    const fileRes = await readThemeFile(env, themeName, f.path);
    zipInput[f.path] = new TextEncoder().encode(fileRes.content);
  }

  return zipSync(zipInput);
}
