/**
 * `npm run make:plugin -- my-seo` — generate a plugin skeleton.
 * ARCHITECTURE.md §5.5.
 *
 * ## What a plugin *is*, in one paragraph
 *
 * A plugin ships **no executable JavaScript**. It is a manifest plus (optionally)
 * assets, and it is stored as a zip that the platform never unpacks. The
 * Workers runtime forbids `eval` / `new Function` / dynamic `import()` of user
 * code, so "run the plugin's code" is not a thing this platform can do — and it
 * would not want to. Instead the manifest *names hooks*, and the host supplies
 * each hook's implementation (see `contract/hooks.ts` and `plugin/runtime.ts`).
 *
 * That single constraint explains the two shapes an author finds surprising:
 *
 *   `hooks` is a list of **names**, validated against `DECLARABLE_HOOKS`. A name
 *   the host does not implement is now an install error rather than a silent
 *   no-op.
 *
 *   `langs` is **inline**, because there is no unpacked directory to read a
 *   `langs/{locale}.json` from. Themes ship files; plugins declare.
 */
import { join } from "node:path";
import {
  CliError, ROOT, assertName, isMain, parseArgs, report, titleCase, writeTree,
} from "./_scaffold.mjs";

const HELP = `
Usage: npm run make:plugin -- <name> [options]

  <name>            plugin name, e.g. my-seo (lowercase, 2-64 chars)
  --out <dir>       where to create it (default: plugins/)
  --force           overwrite files that already exist
  --title "..."     display title (default: derived from the name)
`;

/**
 * The whole plugin, as data. Separated from the CLI so the emitted manifest can
 * be validated by a test without spawning a process; see `_scaffold.mjs`.
 *
 * `permissions` are capabilities the admin approves at install time; every
 * platform call the plugin makes is gated on one. Asking for `content.write`
 * when the plugin only reads settings is how a plugin gets denied at install.
 */
export function pluginFiles({ name, title }) {
  const manifest = {
    name,
    title,
    version: "0.1.0",
    author: "",
    description: `${title} — a CFPress plugin. Edit this before shipping.`,
    permissions: ["content.read", "settings.read", "settings.write"],
    hooks: ["beforeRender", "html"],
    adminMenus: [
      {
        id: `${name}-settings`,
        label: `${title} Settings`,
        icon: "settings",
        screen: "plugin-settings",
        capability: "settings.read",
      },
    ],
    settings: [
      { key: "enabled", label: "Enabled", type: "boolean", default: "true" },
      { key: "note", label: "Note", type: "text", default: "" },
    ],
    // Inline, not a `langs/` directory: a plugin package is never unpacked, so
    // there is nowhere to read a file from. Keys carry the `plugin.<name>.`
    // prefix for the same reason themes do — an unnamespaced key collides with
    // any other extension that happens to pick the same name, and load order
    // decides the winner.
    langs: {
      en: {
        [`plugin.${name}.admin.title`]: `${title} Settings`,
        [`plugin.${name}.admin.description`]: "Configure how this plugin behaves.",
      },
      "zh-CN": {
        [`plugin.${name}.admin.title`]: `${title} 设置`,
        [`plugin.${name}.admin.description`]: "配置该插件的行为。",
      },
    },
  };

  const readme = `# ${title}

A CFPress plugin. Declarative only — no executable JavaScript ships in a plugin
package, because the Workers runtime forbids evaluating user code. Behaviour is
requested by **naming hooks** in \`plugin.json\`; the host supplies the
implementation.

## Declared surface

| Field | Value | Notes |
|---|---|---|
| \`permissions\` | \`content.read\`, \`settings.read\`, \`settings.write\` | Approved at install time. Remove what you do not use — an over-broad plugin can be denied. |
| \`hooks\` | \`beforeRender\`, \`html\` | Must be names from \`DECLARABLE_HOOKS\`; anything else fails the install. |
| \`adminMenus\` | \`${name}-settings\` | Opens the settings screen generated from \`settings[]\`. |
| \`settings\` | \`enabled\`, \`note\` | Rendered as a form; keys must be declared before they can be written. |
| \`langs\` | \`en\`, \`zh-CN\` | Inline, because a plugin zip is never unpacked. |

## Install

\`\`\`bash
# Package and upload through the admin, or:
curl -X POST "$BASE/api/v1/extensions/plugins/upload" -b cookies.txt -F "file=@${name}.zip"
curl -X POST "$BASE/api/v1/extensions/plugins/${name}/enable" -b cookies.txt
\`\`\`

Enabling registers the declared menu for **every site** at once: a plugin has a
single install-wide enabled flag, not a per-site one. See ARCHITECTURE.md §4.4.
`;

  return { manifest, files: { "plugin.json": JSON.stringify(manifest, null, 2) + "\n", "README.md": readme } };
}

export function main(argv, io = console) {
  try {
    const args = parseArgs(argv);
    // `--help` is a successful request (exit 0, stdout); a missing argument is
    // a usage error (exit 1, stderr).
    if (args.help || args.h) {
      io.log(HELP.trim());
      return 0;
    }
    if (!args._.length) {
      io.error(HELP.trim());
      return 1;
    }

    const name = assertName(args._[0], "plugin");
    const title = String(args.title || titleCase(name));
    const outRoot = String(args.out || join(ROOT, "content", "plugins"));
    const dir = join(outRoot, name);

    const { files } = pluginFiles({ name, title });
    const result = writeTree(dir, files, { force: !!args.force });

    report("plugin", name, dir, result, [
      `Package it:  cd ${outRoot} && zip -r ${name}.zip ${name}`,
      `Enable it:   curl -X POST "$BASE/api/v1/extensions/plugins/${name}/enable" -b cookies.txt`,
      "",
      "Behaviour is requested by naming hooks — a plugin never ships runnable code.",
      "Ask only for the capabilities you use; over-broad plugins get denied at install.",
    ], io);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.error(`\n  error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
