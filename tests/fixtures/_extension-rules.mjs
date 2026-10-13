/**
 * Rules about *shipped* extension packages, as functions.
 *
 * These two checks used to live inline in `tests/architecture.test.mjs`, which
 * is fine until a second caller needs the same answer. The second caller is
 * `tests/scaffold.test.mjs`: the documented acceptance criterion for a generated
 * theme is "架构测试过" (passes the architecture test), and the only honest way
 * to claim that is to run the same rule against the generated output.
 *
 * Copying the rule would have been the wrong answer — a copy drifts from the
 * original, and the copy is always the one that is quietly out of date. So the
 * rule is extracted and both callers import it. This is the same reasoning that
 * put `ALLOWED_ADMIN_SCREENS` in `extensions/contract/manifest.ts`: when two
 * places need to agree, share the definition rather than the conclusion.
 *
 * Each function takes the *repository root* rather than assuming it, so a caller
 * can point the rules at a generated tree that is not the repo's own `themes/`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

function read(p) {
  return readFileSync(p, "utf8");
}

function walk(dir, exts) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d)) {
      const abs = join(d, e);
      if (statSync(abs).isDirectory()) go(abs);
      else if (exts.some((x) => e.endsWith(x))) out.push(abs);
    }
  };
  go(dir);
  return out;
}

/**
 * Rule 11 (§10): every key in an extension's language pack must carry its
 * owner's prefix — `theme.{name}.` or `plugin.{name}.`.
 *
 * Without this, two extensions that both define `nav.home` overwrite each other
 * in the merged dictionary, and which one wins depends on load order. That is a
 * heisenbug with no correct fix at the call site.
 *
 * Note this checks the *files* (`langs/*.json`); inline `langs{}` in a manifest
 * is checked by `validateManifest` instead, because it is a different input.
 */
export function langPackProblems(root) {
  const problems = [];
  for (const kind of ["theme", "plugin"]) {
    const baseDir = join(root, "content", kind === "theme" ? "themes" : "plugins");
    if (!existsSync(baseDir)) continue;
    for (const owner of readdirSync(baseDir)) {
      const langDir = join(baseDir, owner, "langs");
      if (!existsSync(langDir) || !statSync(langDir).isDirectory()) continue;
      for (const file of readdirSync(langDir)) {
        if (!file.endsWith(".json")) continue;
        let dict;
        try {
          dict = JSON.parse(read(join(langDir, file)));
        } catch (e) {
          problems.push(`content/${kind}s/${owner}/langs/${file}: invalid JSON (${e.message})`);
          continue;
        }
        const prefix = `${kind}.${owner}.`;
        for (const key of Object.keys(dict)) {
          if (!key.startsWith(prefix) && !key.startsWith("core.")) {
            problems.push(`content/${kind}s/${owner}/langs/${file}: key "${key}" lacks prefix "${prefix}"`);
          }
        }
      }
    }
  }
  return problems;
}

/** Reserved platform columns on every generated table (§6.3). */
const RESERVED_COLUMNS = [
  "id", "site_id", "slug", "lang_group", "status", "created_at", "updated_at",
];

/**
 * Rule 14–17 (§5.3): a shipped theme's declarations must be internally
 * consistent.
 *
 * A theme that declares a template it does not ship, or resolves a route against
 * a table it never declared, fails at *render* time — deep inside a request,
 * with an error that points at the renderer rather than the manifest. Checking
 * it here makes the manifest the single place a theme can be wrong.
 */
export function themeManifestProblems(root) {
  const themesRoot = join(root, "content", "themes");
  const themeDirs = existsSync(themesRoot)
    ? readdirSync(themesRoot).filter((d) => statSync(join(themesRoot, d)).isDirectory())
    : [];

  const problems = [];
  for (const name of themeDirs) {
    const dir = join(themesRoot, name);
    const manifestPath = join(dir, "theme.json");
    if (!existsSync(manifestPath)) continue; // optional for fixtures

    let manifest;
    try {
      manifest = JSON.parse(read(manifestPath));
    } catch (e) {
      problems.push(`content/themes/${name}/theme.json: invalid JSON (${e.message})`);
      continue;
    }

    const templates = Array.isArray(manifest.templates) ? manifest.templates : [];
    const tableNames = new Set(
      (Array.isArray(manifest.tables) ? manifest.tables : []).map((t) => String(t?.name ?? ""))
    );

    // Declared template must exist, either flat or under templates/parts.
    //
    // A worker-runtime theme renders from its own code, so `templates[]` there is
    // a statement about *which kinds it handles*, not a file listing. Only a
    // declarative theme's template list is a file contract — checking a worker
    // theme against the filesystem would report failures it can never fix.
    const tplDir = join(dir, "templates");
    const isWorkerTheme = manifest.runtime === "worker";
    if (templates.length && existsSync(tplDir) && !isWorkerTheme) {
      const present = new Set();
      for (const f of walk(tplDir, [".html"])) {
        const base = f.slice(f.indexOf(`${sep}templates${sep}`) + `${sep}templates${sep}`.length);
        present.add(base.split(sep).join("/").replace(/\.html$/, ""));
      }
      for (const t of templates) {
        if (!present.has(t)) {
          problems.push(`content/themes/${name}: declares template "${t}" but ships no templates/${t}.html`);
        }
      }
    }

    // A declared locale must have a pack. `manifest.locales[]` is otherwise a
    // claim nothing reads: `contract/validation.ts` checks only that each code
    // is BCP-47-shaped, and no runtime consumer exists, so a theme can advertise
    // a Chinese version it does not ship and every
    // `{{default(theme.strings.x, "English literal")}}` in it renders the
    // literal. A missing translation and an absent one then look identical —
    // on the site and in every other test.
    //
    // The scaffold's manifest comment has always promised this check; it did not
    // exist until now, which is why the comment read as coverage.
    for (const code of Array.isArray(manifest.locales) ? manifest.locales : []) {
      if (!existsSync(join(dir, "langs", `${String(code)}.json`))) {
        problems.push(`content/themes/${name}: declares locale "${code}" but ships no langs/${code}.json`);
      }
    }

    // A route resolving against a table must declare that table.
    for (const r of Array.isArray(manifest.routes) ? manifest.routes : []) {
      const tbl = r?.resolve?.table;
      if (tbl && !tableNames.has(String(tbl))) {
        problems.push(
          `themes/${name}: route "${r.path}" resolves table "${tbl}" which is not declared in tables[]`
        );
      }
    }

    // A route's template must be declared — and it must also *exist*, because
    // the renderer now selects it by name ahead of the hierarchy. Same worker
    // exemption as above: a worker theme's route templates are names its code
    // understands.
    if (!isWorkerTheme) {
      for (const r of Array.isArray(manifest.routes) ? manifest.routes : []) {
        if (r?.template && templates.length && !templates.includes(r.template)) {
          problems.push(
            `themes/${name}: route "${r.path}" uses template "${r.template}" not listed in templates[]`
          );
        }
      }
    }

    // translatable entries must name declared fields.
    for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
      const fieldKeys = new Set(
        (Array.isArray(t?.fields) ? t.fields : []).map((f) => String(f?.key ?? ""))
      );
      for (const k of Array.isArray(t?.translatable) ? t.translatable : []) {
        if (!fieldKeys.has(String(k))) {
          problems.push(
            `themes/${name}: table "${t.name}" marks "${k}" translatable but has no such field`
          );
        }
      }
    }

    // Tables must not use reserved platform column names.
    for (const t of Array.isArray(manifest.tables) ? manifest.tables : []) {
      for (const f of Array.isArray(t?.fields) ? t.fields : []) {
        if (RESERVED_COLUMNS.includes(String(f?.key ?? ""))) {
          problems.push(
            `themes/${name}: table "${t.name}" field "${f.key}" collides with a reserved column`
          );
        }
      }
    }
  }
  return problems;
}
