/**
 * sync-plugins.mjs — discover and register repo plugins from `content/plugins/`
 * into the local development D1 database.
 *
 * Usage: node scripts/sync-plugins.mjs [plugin-name] [--enable]
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGINS_DIR = join(ROOT, "content", "plugins");
const D1_DIR = join(ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");

function findLocalD1() {
  if (!existsSync(D1_DIR)) return null;
  const files = readdirSync(D1_DIR).filter((f) => f.endsWith(".sqlite") && !f.startsWith("metadata"));
  return files.length ? join(D1_DIR, files[0]) : null;
}

export function syncPlugins(targetPluginName = null, autoEnable = false) {
  const dbPath = findLocalD1();
  if (!dbPath) {
    console.error("No local D1 database found under .wrangler/state/v3/d1.");
    return false;
  }

  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);

  const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let installedCount = 0;

  for (const name of dirs) {
    if (targetPluginName && name !== targetPluginName) continue;

    const manifestFile = join(PLUGINS_DIR, name, "plugin.json");
    if (!existsSync(manifestFile)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch (e) {
      console.error(`Invalid JSON in ${manifestFile}:`, e.message);
      continue;
    }

    const title = manifest.title || name;
    const version = manifest.version || "1.0.0";
    const enabled = autoEnable ? 1 : 0;
    const id = `plugin_${name}`;

    db.prepare(`
      INSERT INTO plugin_installs(id, name, title, version, enabled, manifest, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        title = excluded.title,
        version = excluded.version,
        manifest = excluded.manifest,
        updated_at = excluded.updated_at
    `).run(id, name, title, version, enabled, JSON.stringify(manifest), now, now);

    // Register capabilities
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const cap of permissions) {
      try {
        db.prepare(`
          INSERT OR REPLACE INTO extension_capabilities(extension_type, extension_name, capability, enabled)
          VALUES('plugin', ?, ?, 1)
        `).run(name, cap);
      } catch {}
    }

    // Register settings definitions if declared
    if (Array.isArray(manifest.settings)) {
      for (const s of manifest.settings) {
        try {
          db.prepare(`
            INSERT INTO plugin_setting_defs(plugin_name, key, label, type, default_value, options)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(plugin_name, key) DO UPDATE SET
              label = excluded.label,
              type = excluded.type,
              default_value = excluded.default_value
          `).run(name, s.key, s.label || s.key, s.type || "text", String(s.default ?? ""), JSON.stringify(s.options || []));
        } catch {}
      }
    }

    console.log(`✓ Plugin registered: ${name} (${title} v${version})`);
    installedCount++;
  }

  db.close();
  return installedCount > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const enable = process.argv.includes("--enable");
  syncPlugins(target, enable);
}
