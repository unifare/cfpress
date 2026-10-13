/**
 * Theme-owned business tables (ARCHITECTURE.md §2.5.2, §3.3).
 *
 * A theme declares the tables it needs; the platform generates the DDL. The
 * theme never writes `CREATE TABLE` and never sees a table name — it asks for
 * `product` and gets whatever `theme_{theme}_product` resolved to. That is
 * deliberate: a generated table the platform cannot name is a table it cannot
 * migrate, index or clean up.
 *
 * ## Which columns go where
 *
 * The declaration splits a table's fields into two groups:
 *
 *   language-independent (`price`, `stock`, `sku`)
 *       always a column on the main table — one value for every language
 *   `translatable` (`name`, `description`)
 *       a column on the main table *and*, when the site serves more than one
 *       language, a column on `{table}_i18n` keyed by `(row_id, locale)`
 *
 * Both are on the main table because a single-language site must still be able
 * to store a product name. The `_i18n` table is created only once a second
 * language is enabled (§2.5.3 要点三), so a monolingual install has no
 * translation table at all — and "we do not do multi-language" stays a
 * verifiable fact about the database rather than a promise about the code.
 *
 * The main-table column doubles as the *default-language* value. Enabling a
 * second language therefore needs no data migration: the existing value is
 * already the value for the site's default locale.
 *
 * ## Going back to one language
 *
 * The `_i18n` table is never dropped. Disabling a language hides it; it does
 * not destroy the translations written in it (§3.4 — WordPress loses data here,
 * we do not).
 */
import { Env } from "../../shared/types";
import { now } from "../../shared/repo";
import { isMultilingual, siteDefaultLocale } from "../../platform/i18n/locale-registry";

export interface ThemeTableField {
  key: string;
  type: string;
  label?: string;
  required?: boolean;
}

export interface ThemeTableDecl {
  name: string;
  label?: string;
  translatable?: string[];
  fields?: ThemeTableField[];
}

/**
 * Who declared a generated table.
 *
 * A theme and a plugin of the same name are different owners with different
 * data, so this is part of the physical name (`theme_foo_bar` vs
 * `plugin_foo_bar`) and of the registry's unique key. Without it the two would
 * collide on `foo_bar` and the second one to install would read the first one's
 * rows.
 */
export type OwnerType = "theme" | "plugin";

export interface ThemeTableDef {
  id: string;
  site_id: string;
  owner_type: OwnerType;
  /** The theme name or the plugin name, depending on `owner_type`. */
  owner_name: string;
  logical_name: string;
  table_name: string;
  i18n_table: string | null;
  translatable: string[];
  fields: ThemeTableField[];
}

const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const FIELD_KEY_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;

/**
 * Columns the platform owns on every generated table. A declaration that
 * collides with one of these is rejected at install time (`security.ts`), so by
 * the time we get here the list is only used to build the fixed prefix.
 */
export const RESERVED_COLUMNS = [
  "id",
  "site_id",
  "slug",
  "lang_group",
  "status",
  "created_at",
  "updated_at",
] as const;

/**
 * Declared field type → SQLite storage class.
 *
 * The six allowed types come from `ALLOWED_TABLE_FIELD_TYPES` in security.ts.
 * `date` is TEXT (an ISO date sorts correctly as text and is readable in the
 * database) while `datetime` is INTEGER epoch seconds, matching every other
 * timestamp in this schema.
 */
const FIELD_SQL: Record<string, string> = {
  text: "TEXT",
  longtext: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
  date: "TEXT",
  datetime: "INTEGER",
};

export function fieldSqlType(type: string): string {
  return FIELD_SQL[type] ?? "TEXT";
}

/**
 * Generated table name. The prefix is not configurable — an extension that could
 * choose its own table name could collide with a platform table, and there
 * would be no way to tell a generated table from a hand-written one.
 *
 * The owner *type* is in the prefix, not just the name: theme `notify` and
 * plugin `notify` both declaring a `log` table must not resolve to the same
 * table. `theme_` is the prefix that was already in use, so every name
 * generated before plugins existed is still produced by this function.
 */
export function generatedTableName(
  ownerType: OwnerType,
  ownerName: string,
  logicalName: string
): string {
  return `${ownerType}_${sanitise(ownerName)}_${sanitise(logicalName)}`;
}

export function themeTableName(themeName: string, logicalName: string): string {
  return generatedTableName("theme", themeName, logicalName);
}

export function generatedI18nTableName(
  ownerType: OwnerType,
  ownerName: string,
  logicalName: string
): string {
  return `${generatedTableName(ownerType, ownerName, logicalName)}_i18n`;
}

export function themeI18nTableName(themeName: string, logicalName: string): string {
  return generatedI18nTableName("theme", themeName, logicalName);
}

/**
 * Is this a name we are willing to interpolate into DDL?
 *
 * Belt and braces: `validateManifest` already rejects bad names at install
 * time, but this module is also reachable from the admin API and the sandbox
 * facade, and a name that reaches a template-literal `CREATE TABLE` unchecked
 * is an injection. Requiring one of the generated prefixes as well means the
 * check cannot accidentally bless a platform table.
 *
 * Both prefixes are accepted because both an owner type and a logical name are
 * sanitised before they get here: a logical name containing `plugin_` cannot
 * forge the prefix, since the real prefix is always the *owner type*, which
 * comes from `OwnerType` and never from the manifest.
 */
export function isGeneratedExtensionTable(name: string): boolean {
  if (!TABLE_NAME_RE.test(name)) return false;
  return name.startsWith("theme_") || name.startsWith("plugin_");
}

function sanitise(v: string): string {
  return String(v).replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

function mainTableDdl(tableName: string, fields: ThemeTableField[]): string {
  const cols: string[] = [
    "id TEXT PRIMARY KEY",
    "site_id TEXT NOT NULL",
    "slug TEXT NOT NULL",
    "lang_group TEXT NOT NULL",
    ...fields.map((f) => `${f.key} ${fieldSqlType(f.type)}`),
    "status TEXT NOT NULL DEFAULT 'draft'",
    "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
    "UNIQUE(site_id, slug)",
  ];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.join(", ")})`;
}

function i18nTableDdl(tableName: string, translatable: string[]): string {
  const cols: string[] = [
    "row_id TEXT NOT NULL",
    "locale TEXT NOT NULL",
    ...translatable.map((k) => `${k} TEXT`),
    "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
    "PRIMARY KEY (row_id, locale)",
  ];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.join(", ")})`;
}

async function existingColumns(env: Env, tableName: string): Promise<string[]> {
  try {
    const r = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
    return ((r.results as any[]) ?? []).map((c) => String(c.name));
  } catch {
    return [];
  }
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .bind(tableName)
      .first<any>();
    return !!r;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sync: manifest declaration → database
// ---------------------------------------------------------------------------

export interface SyncTableResult {
  logical: string;
  table: string;
  i18nTable: string | null;
  created: boolean;
  i18nCreated: boolean;
  addedColumns: string[];
}

/**
 * Materialise every `tables[]` declaration of one extension owner for one site.
 *
 * Idempotent by construction: `CREATE TABLE IF NOT EXISTS` plus an
 * `ALTER TABLE ADD COLUMN` pass for fields added to the manifest since the last
 * activation. Columns are never dropped — a removed field is very likely a
 * mistake, and a dropped column is not recoverable.
 *
 * `ownerType` decides the physical prefix, so a theme's `log` and a plugin's
 * `log` are two tables. Everything else here — the field filtering, the
 * translatable resolution, the `_i18n` decision — is shared, which is the point:
 * plugin tables get the multilingual treatment by default rather than by a
 * second implementation that would drift.
 */
export async function syncOwnerTables(
  env: Env,
  ownerType: OwnerType,
  ownerName: string,
  manifest: any,
  siteId: string
): Promise<SyncTableResult[]> {
  const decls: ThemeTableDecl[] = Array.isArray(manifest?.tables) ? manifest.tables : [];
  if (!decls.length) return [];

  const multilingual = await isMultilingual(env, siteId);
  const ts = now();
  const out: SyncTableResult[] = [];

  for (const decl of decls) {
    const logical = String(decl?.name ?? "");
    if (!TABLE_NAME_RE.test(logical)) continue;

    const fields = (Array.isArray(decl.fields) ? decl.fields : [])
      .filter((f) => f && FIELD_KEY_RE.test(String(f.key)))
      .filter((f) => !(RESERVED_COLUMNS as readonly string[]).includes(String(f.key)))
      .map((f) => ({ key: String(f.key), type: String(f.type ?? "text"), label: f.label, required: !!f.required }));

    // A translatable key that names no declared field would create an `_i18n`
    // column nothing ever writes. `validateManifest` rejects it at install; this
    // is the second line of defence for a manifest that arrived another way.
    const fieldKeys = new Set(fields.map((f) => f.key));
    const translatable = (Array.isArray(decl.translatable) ? decl.translatable : [])
      .map((k) => String(k))
      .filter((k) => fieldKeys.has(k));

    const tableName = generatedTableName(ownerType, ownerName, logical);
    const i18nName = generatedI18nTableName(ownerType, ownerName, logical);

    const existed = await tableExists(env, tableName);
    await env.DB.prepare(mainTableDdl(tableName, fields)).run();

    // Fields added to the manifest since the table was created.
    const addedColumns: string[] = [];
    if (existed) {
      const have = new Set(await existingColumns(env, tableName));
      for (const f of fields) {
        if (have.has(f.key)) continue;
        await env.DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${f.key} ${fieldSqlType(f.type)}`).run();
        addedColumns.push(f.key);
      }
    }

    // The translation table exists only when the site serves ≥2 languages.
    let i18nCreated = false;
    if (multilingual && translatable.length) {
      const i18nExisted = await tableExists(env, i18nName);
      await env.DB.prepare(i18nTableDdl(i18nName, translatable)).run();
      i18nCreated = !i18nExisted;
      if (i18nExisted) {
        const have = new Set(await existingColumns(env, i18nName));
        for (const k of translatable) {
          if (have.has(k)) continue;
          await env.DB.prepare(`ALTER TABLE ${i18nName} ADD COLUMN ${k} TEXT`).run();
          addedColumns.push(`i18n.${k}`);
        }
      }
    }

    // Record the mapping. `i18n_table` is only set when the table really exists,
    // so the facade never tries to join a table that is not there.
    const i18nTable = multilingual && translatable.length ? i18nName : null;
    await env.DB.prepare(
      `INSERT INTO theme_table_defs(id,site_id,owner_type,owner_name,logical_name,table_name,i18n_table,translatable,fields_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id,owner_type,owner_name,logical_name) DO UPDATE SET
         table_name=excluded.table_name,
         i18n_table=COALESCE(excluded.i18n_table, theme_table_defs.i18n_table),
         translatable=excluded.translatable,
         fields_json=excluded.fields_json,
         updated_at=excluded.updated_at`
    )
      .bind(
        `ttd_${sanitise(siteId)}_${sanitise(ownerType)}_${sanitise(ownerName)}_${sanitise(logical)}`,
        siteId,
        ownerType,
        ownerName,
        logical,
        tableName,
        i18nTable,
        JSON.stringify(translatable),
        JSON.stringify(fields),
        ts,
        ts
      )
      .run();

    // Repair the mapping we just wrote: if a sidecar is named, it must exist.
    //
    // `i18n_table` is sticky on purpose — `COALESCE` keeps the name when this
    // sync is monolingual, so that disabling a language hides the translations
    // instead of re-seeding them from the main table on the way back. But that
    // makes the column a claim that can outlive its table: a test fixture that
    // drops generated tables, or an operator tidying up by hand, leaves a row
    // naming a sidecar that is gone. The facade trusts the column, and its
    // failure mode is `no such table: …_i18n` on the first write — a
    // schema-shaped error for a stale row, which is how this was found.
    //
    // So: whatever the column says, make it true. `CREATE TABLE IF NOT EXISTS`
    // is idempotent, so the normal path costs one statement and no behaviour
    // changes.
    const recorded = await env.DB.prepare(
      "SELECT i18n_table FROM theme_table_defs WHERE site_id=? AND owner_type=? AND owner_name=? AND logical_name=?"
    ).bind(siteId, ownerType, ownerName, logical).first<{ i18n_table: string | null }>();
    if (recorded?.i18n_table && translatable.length) {
      await env.DB.prepare(i18nTableDdl(recorded.i18n_table, translatable)).run();
    }

    out.push({ logical, table: tableName, i18nTable, created: !existed, i18nCreated, addedColumns });
  }

  return out;
}

/**
 * Re-run the multilingual decision for every table a site already knows about,
 * for **every owner type**. A plugin's tables need translations for the same
 * reason a theme's do, so this deliberately does not filter on `owner_type`:
 * one pass over the registry keeps the two paths from diverging.
 *
 * Called when a language is enabled or disabled: the manifests have not
 * changed, but the answer to "does this site need `_i18n` tables" has. Tables
 * are created for declarations that now need one; none is ever dropped.
 */
export async function refreshThemeTableI18n(env: Env, siteId: string): Promise<string[]> {
  const multilingual = await isMultilingual(env, siteId);
  if (!multilingual) return [];
  const defaultLocale = await siteDefaultLocale(env, siteId);
  const created: string[] = [];
  let defs: ThemeTableDef[] = [];
  try {
    defs = (await listThemeTableDefs(env, siteId)) as ThemeTableDef[];
  } catch {
    return [];
  }
  const ts = now();
  for (const def of defs) {
    if (def.i18n_table || !def.translatable.length) continue;
    // Derive the sidecar name from the canonical function, not by appending
    // `_i18n` to the stored table name. Both happen to agree today, but they
    // are two expressions of one rule (§10 rule 30): if the naming scheme ever
    // changes, the hand-rolled one silently produces a name the resolver does
    // not know. `generatedI18nTableName` is the function everything else calls.
    const i18nName = generatedI18nTableName(def.owner_type, def.owner_name, def.logical_name);
    const existed = await tableExists(env, i18nName);
    await env.DB.prepare(i18nTableDdl(i18nName, def.translatable)).run();
    if (!existed) created.push(i18nName);
    await env.DB.prepare("UPDATE theme_table_defs SET i18n_table=?, updated_at=? WHERE id=?")
      .bind(i18nName, ts, def.id)
      .run();
    // Seed the site's default locale from the main table, so the first read in
    // the default language sees what was already there before the switch.
    await seedI18nFromMain(env, def.table_name, i18nName, def.translatable, defaultLocale);
  }
  return created;
}

/**
 * Copy main-table translatable columns into `_i18n` for `locale`.
 *
 * Only inserts rows that do not exist yet, so a value edited in the translation
 * table is never overwritten by the stale main-table copy. `lang_group` is used
 * as the group key so a future per-language-row model stays compatible; today a
 * generated row's `lang_group` equals its `id`.
 */
async function seedI18nFromMain(
  env: Env,
  tableName: string,
  i18nName: string,
  translatable: string[],
  locale: string
): Promise<void> {
  try {
    const cols = translatable.join(", ");
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${i18nName}(row_id,locale,${cols},created_at,updated_at)
       SELECT m.id, ?, ${translatable.map((k) => `m.${k}`).join(", ")}, m.created_at, m.updated_at
         FROM ${tableName} m`
    )
      .bind(locale)
      .run();
  } catch {
    /* a table with no rows yet, or a shape the platform did not generate */
  }
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

/**
 * Every generated table this site knows about, optionally narrowed to one owner.
 *
 * `ownerName` alone is not enough to narrow: theme `notify` and plugin `notify`
 * are different owners, so a caller that knows which it wants must say so. The
 * two-argument form is kept for theme callers, which is every caller that
 * existed before plugins, and it means "themes with this name".
 */
export async function listOwnerTableDefs(
  env: Env,
  siteId: string,
  owner?: { type: OwnerType; name: string }
): Promise<ThemeTableDef[]> {
  try {
    if (owner) {
      const r = await env.DB.prepare(
        "SELECT * FROM theme_table_defs WHERE site_id=? AND owner_type=? AND owner_name=? ORDER BY logical_name"
      )
        .bind(siteId, owner.type, owner.name)
        .all();
      return ((r.results as any[]) ?? []).map(hydrate);
    }
    const r = await env.DB.prepare(
      "SELECT * FROM theme_table_defs WHERE site_id=? ORDER BY owner_type, owner_name, logical_name"
    )
      .bind(siteId)
      .all();
    return ((r.results as any[]) ?? []).map(hydrate);
  } catch {
    return [];
  }
}

export async function listThemeTableDefs(
  env: Env,
  siteId: string,
  themeName?: string
): Promise<ThemeTableDef[]> {
  return await listOwnerTableDefs(
    env,
    siteId,
    themeName ? { type: "theme", name: themeName } : undefined
  );
}

/**
 * Resolve an owner's *logical* table name to its generated one.
 *
 * Scoped to the owner on purpose: an extension may only reach its own tables,
 * and the lookup is where that is enforced rather than at each call site.
 * `ownerType` is required rather than defaulted to `"theme"` — a default here
 * would mean a plugin calling the theme-shaped overload reads the theme's table
 * of the same name and gets an empty result, which looks like "no data" rather
 * than "wrong table" (§10 rule 6: no defaulted scoping parameter).
 */
export async function resolveOwnerTable(
  env: Env,
  siteId: string,
  ownerType: OwnerType,
  ownerName: string,
  logicalName: string
): Promise<ThemeTableDef | null> {
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM theme_table_defs WHERE site_id=? AND owner_type=? AND owner_name=? AND logical_name=?"
    )
      .bind(siteId, ownerType, ownerName, logicalName)
      .first<any>();
    return r ? hydrate(r) : null;
  } catch {
    return null;
  }
}

export async function resolveThemeTable(
  env: Env,
  siteId: string,
  themeName: string,
  logicalName: string
): Promise<ThemeTableDef | null> {
  return await resolveOwnerTable(env, siteId, "theme", themeName, logicalName);
}

function hydrate(r: any): ThemeTableDef {
  // `owner_type` is read defensively rather than trusted: this row also exists
  // in databases created before migration 0014, and a hydration that returned
  // `undefined` for it would make `generatedI18nTableName` produce
  // `undefined_foo_bar` — a name that is plausible enough to be queried.
  const ownerType: OwnerType = r.owner_type === "plugin" ? "plugin" : "theme";
  const ownerName = String(r.owner_name ?? r.theme_name ?? "");
  return {
    id: String(r.id),
    site_id: String(r.site_id),
    owner_type: ownerType,
    owner_name: ownerName,
    logical_name: String(r.logical_name),
    table_name: String(r.table_name),
    i18n_table: r.i18n_table ? String(r.i18n_table) : null,
    translatable: safeJsonArray(r.translatable),
    fields: safeJsonArray(r.fields_json),
  };
}

function safeJsonArray(v: unknown): any[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
