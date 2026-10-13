/**
 * `npm run make:table -- my-shop product` — add a declared table to a theme.
 * ARCHITECTURE.md §3.2 / §6.3.
 *
 * ## Why this is a separate command rather than part of `make:theme`
 *
 * A table is only worth declaring when there is something to put in it, so a
 * generated theme ships none. But once you *do* want one, two declarations have
 * to agree:
 *
 *   `tables[]`     — the platform generates `theme_{theme}_{name}` from it
 *   `adminMenus[]` — the menu that opens the generated list for it
 *
 * Declaring the table without the menu gives you a table nobody can reach;
 * declaring the menu without the table fails the install ("references table X
 * which is not declared"). Emitting both, together, is the whole point: the
 * generator exists to make the pair impossible to get half-right.
 *
 * The fields default to something a person would actually want
 * (`name` + `description`, both translatable) and are overridable:
 *
 *   npm run make:table -- my-shop product --fields name:text,price:number,sku:text
 *   npm run make:table -- my-shop product --translatable name --label Product
 *
 * `--write` merges the declarations into `theme.json`; without it the snippet is
 * printed for you to place yourself. The default is to print, because rewriting
 * a hand-edited manifest silently is worse than asking.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError, ROOT, assertName, isMain, parseArgs, readJson, titleCase, writeJson,
} from "./_scaffold.mjs";
// The vocabulary is imported, not re-declared. A local copy is how the
// scaffolder and the validator come to disagree about what is allowed — and
// the disagreement only shows up as "the theme it just generated fails to
// install", which reads like a validator bug rather than a scaffold one.
import {
  ALLOWED_TABLE_FIELD_TYPES as ALLOWED_TYPES,
  isProseFieldType,
} from "../src/extensions/contract/manifest.ts";

const HELP = `
Usage: npm run make:table -- <theme> <table> [options]

  <theme>                 theme directory name (e.g. my-shop)
  <table>                 logical table name, lowercase, >= 2 chars (e.g. product)
  --fields a:text,b:number   field declarations (default: name:text,description:longtext)
  --translatable a,b      which fields are per-language (default: all text fields)
  --label "Product"       singular label for the admin screen
  --write                 merge into themes/<theme>/theme.json (default: print only)
  --out <dir>             where the themes live (default: themes/)
`;

/**
 * Read the reserved-column list out of the contract instead of copying it.
 *
 * A copy is how "the generator accepts `site_id` but the platform rejects it"
 * happens — and the author then sees an install failure naming a column they
 * never typed. The list is a flat array of string literals, so reading it is
 * one regex; `tests/suites/scaffold.test.mjs` proves the generated manifest passes the
 * *real* validator, so any drift in the regexes below surfaces there too.
 */
function reservedColumns() {
  const src = readFileSync(join(ROOT, "src/extensions/contract/manifest.ts"), "utf8");
  const block = src.match(/export const RESERVED_COLUMNS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

/** Same shapes `contract/manifest.ts` enforces; see the note above. */
const TABLE_RE = /^[a-z][a-z0-9_]{1,63}$/;
const FIELD_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;

/**
 * The two declarations, as data.
 *
 * `tables[]` is what makes the platform generate `theme_{theme}_{name}`;
 * `adminMenus[]` is the menu that opens its generated list. They are produced
 * together because declaring one without the other is exactly the half-right
 * state this command exists to prevent: a table nobody can reach, or a menu the
 * install rejects for referencing a table that was never declared.
 */
export function tableDeclarations({ tableName, fieldsSpec, translatableSpec, label }) {
  const RESERVED = reservedColumns();

  if (!TABLE_RE.test(tableName)) {
    throw new CliError(
      `invalid table name "${tableName}": lowercase, at least 2 characters, no dashes (e.g. "product")`
    );
  }

  const fields = String(fieldsSpec).split(",").map((chunk) => {
    const [key, type = "text"] = String(chunk).trim().split(":");
    return { key: String(key || "").trim(), type: String(type).trim() };
  });

  for (const f of fields) {
    if (!FIELD_RE.test(f.key)) throw new CliError(`invalid field key "${f.key}"`);
    if (RESERVED.includes(f.key)) {
      throw new CliError(
        `field "${f.key}" collides with a reserved column (${RESERVED.join(", ")}) — the platform owns those`
      );
    }
    if (!ALLOWED_TYPES.includes(f.type)) {
      throw new CliError(
        `unsupported field type "${f.type}" for "${f.key}" (allowed: ${ALLOWED_TYPES.join(", ")})`
      );
    }
  }
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new CliError("duplicate field key");

  /**
   * Default translatable set: every prose field, derived from the same
   * classification the validator enforces (`isProseFieldType`).
   *
   * `price` must not be translated and `name` must be — a shop that translates
   * its price charges a different amount per language. So the default is
   * deliberately conservative and the flag is there when the guess is wrong.
   *
   * The predicate is imported rather than re-spelled as `type === "text" || …`:
   * a generated theme that got this wrong would be rejected at install by the
   * validator, so the two must agree by construction.
   */
  const defaultTranslatable = fields.filter((f) => isProseFieldType(f.type)).map((f) => f.key);
  const translatable = translatableSpec
    ? String(translatableSpec).split(",").map((s) => s.trim()).filter(Boolean)
    : defaultTranslatable;
  for (const k of translatable) {
    if (!fields.some((f) => f.key === k)) {
      throw new CliError(`--translatable "${k}" names no declared field`);
    }
  }

  const resolvedLabel = String(label || titleCase(tableName));

  return {
    tableDecl: {
      name: tableName,
      label: resolvedLabel,
      translatable,
      fields: fields.map((f) => ({ key: f.key, type: f.type, label: titleCase(f.key) })),
    },
    menuDecl: {
      id: `${tableName.replace(/_/g, "-")}-list`,
      label: resolvedLabel,
      icon: "box",
      screen: "table-list",
      args: { table: tableName },
    },
  };
}

export function main(argv, io = console) {
  try {
    const args = parseArgs(argv);
    // `--help` is a successful request (exit 0, stdout); missing operands are a
    // usage error (exit 1, stderr).
    if (args.help || args.h) {
      io.log(HELP.trim());
      return 0;
    }
    if (args._.length < 2) {
      io.error(HELP.trim());
      return 1;
    }

    const themeName = assertName(args._[0], "theme");
    const tableName = String(args._[1]);
    const outRoot = String(args.out || join(ROOT, "content", "themes"));
    const themeDir = join(outRoot, themeName);

    const { tableDecl, menuDecl } = tableDeclarations({
      tableName,
      fieldsSpec: args.fields || "name:text,description:longtext",
      translatableSpec: args.translatable,
      label: args.label,
    });

    if (!args.write) {
      // Indent by two spaces so the snippet drops into `theme.json` at the right
      // level. `JSON.stringify(..., 2).split("\n").join("\n  ")` — not
      // `.replace(/\n/g, "  ")`, which collapses the whole object onto one line.
      const indent = (v) => "  " + JSON.stringify(v, null, 2).split("\n").join("\n  ");
      io.log(`
Add these two declarations to themes/${themeName}/theme.json — both halves, or
the menu opens a table the install does not create:

  "tables": [
${indent(tableDecl)},
    ...existing tables
  ]

and inside "adminMenus":

${indent(menuDecl)}

Re-run with --write to merge them automatically.
`);
      return 0;
    }

    const manifestPath = join(themeDir, "theme.json");
    if (!existsSync(manifestPath)) {
      throw new CliError(`no theme.json at ${manifestPath} — run "npm run make:theme -- ${themeName}" first`);
    }

    const manifest = readJson(manifestPath);
    manifest.tables = Array.isArray(manifest.tables) ? manifest.tables : [];
    manifest.adminMenus = Array.isArray(manifest.adminMenus) ? manifest.adminMenus : [];

    if (manifest.tables.some((t) => t?.name === tableName)) {
      throw new CliError(`theme already declares a table named "${tableName}"`);
    }
    if (manifest.adminMenus.some((m) => m?.id === menuDecl.id)) {
      throw new CliError(`theme already declares a menu with id "${menuDecl.id}"`);
    }

    manifest.tables.push(tableDecl);
    manifest.adminMenus.push(menuDecl);
    writeJson(manifestPath, manifest);

    io.log(`
  theme.json updated → ${manifestPath}

  + tables[]      "${tableName}" (${tableDecl.fields.length} fields, ${tableDecl.translatable.length} translatable)
  + adminMenus[]  "${menuDecl.id}" → table-list

  Re-activate the theme to materialise the table:

    curl -X POST "$BASE/api/v1/extensions/themes/${themeName}/activate?site=default" -b cookies.txt

  Then open the admin: the menu appears under "From theme", and its list and form
  are generated from the fields above — no admin code.
`);
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
