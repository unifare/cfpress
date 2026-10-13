/**
 * The data facade a theme uses to reach its own tables (`host.table(...)`).
 *
 * A theme never sees SQL, never sees a table name, and never sees a `site_id`.
 * It asks for a logical table and gets rows for the current site, with
 * translatable fields already resolved for the locale it asked for.
 *
 * ## The fallback rule, applied in one place
 *
 * Every multi-language read in the system follows "requested locale → the
 * site's default locale → whatever the row holds". This is implemented as two
 * `LEFT JOIN`s on the translation table and a `COALESCE`, not as a second query
 * from the caller: a missing translation is normal, and the cost of getting it
 * wrong is a product page that 500s because nobody translated its name.
 *
 * ## Why the writes are asymmetric
 *
 * When the site serves one language, translatable fields are written to the
 * main table — that is where they live, because no `_i18n` table exists.
 *
 * When it serves several, a translatable field is written to the `_i18n` table
 * for the requested locale, and the main-table column is only updated if the
 * requested locale *is* the site default. The main column is the default
 * language's mirror; letting an English edit overwrite it would silently
 * rewrite the Chinese product name.
 */
import { Env } from "../../shared/types";
import { now } from "../../shared/repo";
import { randomId } from "../../shared/crypto";
import { siteDefaultLocale } from "../../platform/i18n/locale-registry";
import { listThemeTableDefs, resolveThemeTable, type ThemeTableDef } from "./tables";
import { activeTheme } from "./runtime-declarative";

/**
 * Find an extension-owned table by its *logical* name.
 *
 * The active theme is tried first — that is the normal case, and it is the only
 * case where the declaring theme is allowed to *create* rows. Falling back to
 * any declaration the site knows about keeps data reachable after a theme
 * switch (§3.4): the table and its rows survive, so the admin listing must
 * still read them even though the declaring theme is no longer active.
 *
 * This lives here rather than in `api.ts` because it has two callers that must
 * agree: the admin endpoints, and the front-end router (a theme route that
 * declares `resolve.table`). Two copies would eventually disagree about what
 * "the table for this site" means, and the symptom would be an admin page and a
 * public page showing different rows for the same URL.
 */
export async function resolveTableForSite(
  env: Env,
  siteId: string,
  logical: string
): Promise<ThemeTableDef | null> {
  const theme = await activeTheme(env, siteId).catch(() => null);
  if (theme?.name) {
    const def = await resolveThemeTable(env, siteId, theme.name, logical);
    if (def) return def;
  }
  const all = await listThemeTableDefs(env, siteId);
  return all.find((d) => d.logical_name === logical) ?? null;
}

export interface TableRow {
  id: string;
  slug: string;
  site_id: string;
  lang_group: string;
  status: string;
  created_at: number;
  updated_at: number;
  [field: string]: unknown;
}

export interface TableListOptions {
  locale: string;
  limit?: number;
  offset?: number;
  status?: string | null;
  order?: string;
}

/** ORDER BY is a whitelist, never a template interpolation of caller input. */
const ORDER_WHITELIST = new Set(["created_at", "updated_at", "slug", "status"]);

function orderClause(order: string | undefined): string {
  const parts = String(order ?? "created_at desc").trim().split(/\s+/);
  const col = ORDER_WHITELIST.has(parts[0]) ? parts[0] : "created_at";
  const dir = String(parts[1] ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return `${col} ${dir}`;
}

/** Fields a caller may write: the declared set, plus the platform's own. */
function writableFields(def: ThemeTableDef): Set<string> {
  const out = new Set<string>(["slug", "status"]);
  for (const f of def.fields) out.add(String(f.key));
  return out;
}

/**
 * Build the read projection.
 *
 * Returns the SQL and the bind list rather than running it, so the same
 * projection can be reused by `list`, `bySlug` and `byId` without three copies
 * of the COALESCE ladder drifting apart.
 */
function readProjection(def: ThemeTableDef): { select: string; join: string } {
  const translatable = new Set(def.translatable);
  const hasI18n = !!def.i18n_table && def.translatable.length > 0;

  // Which declared fields are read straight off the main table.
  //
  // Only the *translatable* ones move out of the main-table projection, and
  // only when a translation table exists to hold them. While the site is
  // monolingual they are ordinary main-table columns — that is where a
  // single-language site stores a product name — so excluding them there would
  // drop most of the row.
  const plain = (hasI18n ? def.fields.filter((f) => !translatable.has(String(f.key))) : def.fields)
    .map((f) => `m.${String(f.key)} AS ${String(f.key)}`);
  const base = ["m.id", "m.site_id", "m.slug", "m.lang_group", "m.status", "m.created_at", "m.updated_at", ...plain];

  if (!hasI18n) {
    return { select: base.join(", "), join: `` };
  }
  const i = def.i18n_table as string;
  const overlaid = def.translatable
    .map((k) => `COALESCE(tr.${k}, dflt.${k}, m.${k}) AS ${k}`)
    .join(", ");
  return {
    select: `${base.join(", ")}, ${overlaid}`,
    join: `LEFT JOIN ${i} tr ON tr.row_id = m.id AND tr.locale = ?
           LEFT JOIN ${i} dflt ON dflt.row_id = m.id AND dflt.locale = ?`,
  };
}

async function defaultLocaleFor(env: Env, def: ThemeTableDef): Promise<string> {
  return await siteDefaultLocale(env, def.site_id);
}

export async function tableList(
  env: Env,
  def: ThemeTableDef,
  opts: TableListOptions
): Promise<TableRow[]> {
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 50)));
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const proj = readProjection(def);
  const where: string[] = ["m.site_id = ?"];
  const binds: unknown[] = [];
  if (proj.join) {
    binds.push(opts.locale, await defaultLocaleFor(env, def));
  }
  binds.push(def.site_id);
  if (opts.status) {
    where.push("m.status = ?");
    binds.push(String(opts.status));
  }
  binds.push(limit, offset);
  const sql = `SELECT ${proj.select} FROM ${def.table_name} m ${proj.join}
               WHERE ${where.join(" AND ")}
               ORDER BY m.${orderClause(opts.order)} LIMIT ? OFFSET ?`;
  try {
    const r = await env.DB.prepare(sql).bind(...(binds as any[])).all();
    return ((r.results as any[]) ?? []) as TableRow[];
  } catch {
    // The registry says there is a translation table but it is not there (a
    // hand-edited database). Degrade to the single-language read rather than
    // failing the page.
    return await tableListPlain(env, def, opts);
  }
}

async function tableListPlain(
  env: Env,
  def: ThemeTableDef,
  opts: TableListOptions
): Promise<TableRow[]> {
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 50)));
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const where: string[] = ["site_id = ?"];
  const binds: unknown[] = [def.site_id];
  if (opts.status) {
    where.push("status = ?");
    binds.push(String(opts.status));
  }
  binds.push(limit, offset);
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM ${def.table_name} WHERE ${where.join(" AND ")}
       ORDER BY ${orderClause(opts.order)} LIMIT ? OFFSET ?`
    )
      .bind(...(binds as any[]))
      .all();
    return ((r.results as any[]) ?? []) as TableRow[];
  } catch {
    return [];
  }
}

export async function tableBySlug(
  env: Env,
  def: ThemeTableDef,
  slug: string,
  locale: string
): Promise<TableRow | null> {
  return await tableOne(env, def, "m.slug = ?", slug, locale);
}

export async function tableById(
  env: Env,
  def: ThemeTableDef,
  id: string,
  locale: string
): Promise<TableRow | null> {
  return await tableOne(env, def, "m.id = ?", id, locale);
}

async function tableOne(
  env: Env,
  def: ThemeTableDef,
  predicate: string,
  value: string,
  locale: string
): Promise<TableRow | null> {
  const proj = readProjection(def);
  const binds: unknown[] = [];
  if (proj.join) binds.push(locale, await defaultLocaleFor(env, def));
  binds.push(def.site_id, value);
  try {
    const r = await env.DB.prepare(
      `SELECT ${proj.select} FROM ${def.table_name} m ${proj.join}
       WHERE m.site_id = ? AND ${predicate} LIMIT 1`
    )
      .bind(...(binds as any[]))
      .first<any>();
    return r ? (r as TableRow) : null;
  } catch {
    try {
      const r = await env.DB.prepare(
        `SELECT * FROM ${def.table_name} WHERE site_id = ? AND ${predicate} LIMIT 1`
      )
        .bind(def.site_id, value)
        .first<any>();
      return r ? (r as TableRow) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Insert or update one row, keyed by `(site_id, slug)`.
 *
 * Unknown keys are dropped rather than rejected: a theme that sends an extra
 * property should not fail the save, but it must not be able to name a column
 * either — that is what keeps a caller's JSON from becoming DDL.
 *
 * ## `slug` may be derived, but the derivation is the caller's job
 *
 * A row is slug-addressable, so a save with no slug is meaningless — and the
 * built-in table screens always supply one, because the author types it. A
 * plugin page's `form` block, however, offers only the fields the *manifest*
 * declared; a plugin cannot be forced to declare a `slug` field, and asking it
 * to would leak the platform's addressing scheme into every plugin's schema.
 * So the *API* derives a slug from the submitted content before calling here
 * (`deriveSlug` below), and this function still refuses a slugless save: the
 * requirement is real, the caller is what changed. A function that silently
 * invented a slug would make `tableSave` non-deterministic for every legacy
 * caller that forgot one.
 */
export async function tableSave(
  env: Env,
  def: ThemeTableDef,
  data: Record<string, unknown>,
  locale: string
): Promise<TableRow> {
  const allowed = writableFields(def);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (allowed.has(k)) clean[k] = v;
  }
  const slug = String(clean.slug ?? "").trim();
  if (!slug) throw new Error("slug is required");

  const defaultLocale = await defaultLocaleFor(env, def);
  const multilingual = !!def.i18n_table && def.translatable.length > 0;
  const translatableSet = new Set(def.translatable);

  const existing = await env.DB.prepare(
    `SELECT id FROM ${def.table_name} WHERE site_id=? AND slug=? LIMIT 1`
  )
    .bind(def.site_id, slug)
    .first<any>();

  const ts = now();
  const id = existing?.id ? String(existing.id) : `ttr_${await randomId()}`;

  // -- main table --------------------------------------------------------
  const mainCols: string[] = [];
  const mainVals: unknown[] = [];
  for (const [k, v] of Object.entries(clean)) {
    if (k === "slug") continue;
    if (multilingual && translatableSet.has(k) && locale !== defaultLocale) continue;
    mainCols.push(k);
    mainVals.push(normaliseValue(v));
  }
  if (existing?.id) {
    const sets = mainCols.map((c) => `${c} = ?`);
    sets.push("updated_at = ?");
    await env.DB.prepare(`UPDATE ${def.table_name} SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...(mainVals as any[]), ts, id)
      .run();
  } else {
    const cols = ["id", "site_id", "slug", "lang_group", "created_at", "updated_at", ...mainCols];
    const vals: unknown[] = [id, def.site_id, slug, id, ts, ts, ...mainVals];
    await env.DB.prepare(
      `INSERT INTO ${def.table_name}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`
    )
      .bind(...(vals as any[]))
      .run();
  }

  // -- translation table -------------------------------------------------
  if (multilingual) {
    const trCols: string[] = [];
    const trVals: unknown[] = [];
    for (const [k, v] of Object.entries(clean)) {
      if (!translatableSet.has(k)) continue;
      trCols.push(k);
      trVals.push(v === undefined || v === null ? null : String(v));
    }
    if (trCols.length) {
      const allCols = ["row_id", "locale", ...trCols];
      const allVals: unknown[] = [id, locale, ...trVals];
      await env.DB.prepare(
        `INSERT INTO ${def.i18n_table}(${allCols.join(", ")},created_at,updated_at)
         VALUES(${allCols.map(() => "?").join(", ")},?,?)
         ON CONFLICT(row_id,locale) DO UPDATE SET
           ${trCols.map((c) => `${c} = excluded.${c}`).join(", ")},
           updated_at = excluded.updated_at`
      )
        .bind(...(allVals as any[]), ts, ts)
        .run();
    }
  }

  const saved = await tableById(env, def, id, locale);
  if (!saved) throw new Error(`saved row could not be read back: ${def.logical_name}/${slug}`);
  return saved;
}

/**
 * Delete a whole row, **including every language's translation of it**.
 *
 * This is the "the content no longer exists" operation, not "hide/remove one
 * language". The two are different requests and the table cannot tell them
 * apart from an id alone — so they get two functions rather than one with a
 * flag (`tableDeleteTranslation` below does the locale-scoped one).
 *
 * ## Why the sidecar delete looks unscoped (and is not)
 *
 * `{table}_i18n` has **no `site_id` column** — it is keyed
 * `(row_id, locale)` and reaches the site only through `row_id`, whose
 * ownership lives in the main table. So "scope this by site" cannot be
 * expressed on the sidecar directly.
 *
 * That is a real design constraint, not a licence to skip the check: the main
 * row is deleted with `AND site_id = ?`, so if `id` belonged to another site
 * the sidecar now deletes *that* site's translations. The fix is to resolve
 * ownership **before** touching either table — see the guard below.
 */
export async function tableDelete(env: Env, def: ThemeTableDef, id: string): Promise<void> {
  // Resolve ownership first. `_i18n` has no `site_id` of its own, so this is
  // the only place the site check can actually happen — and it must happen
  // before the sidecar delete, or that delete is unreachable-by-scope and the
  // two halves disagree about which row they are removing.
  const owned = await env.DB.prepare(
    `SELECT id FROM ${def.table_name} WHERE id = ? AND site_id = ?`
  )
    .bind(id, def.site_id)
    .first<any>();
  if (!owned) return; // not this site's row — nothing to delete, nothing to leak

  // Sidecar first: if this fails we abort with the main row still present, so
  // the operation is retryable and never leaves dangling translations.
  if (def.i18n_table) {
    await env.DB.prepare(`DELETE FROM ${def.i18n_table} WHERE row_id = ?`)
      .bind(id)
      .run()
      .catch((e: unknown) => {
        const msg = String((e as Error)?.message ?? e);
        // A missing sidecar means there is nothing to delete — treat as done.
        if (/no such table/i.test(msg)) return;
        throw e;
      });
  }
  await env.DB.prepare(`DELETE FROM ${def.table_name} WHERE id = ? AND site_id = ?`)
    .bind(id, def.site_id)
    .run();
}

/**
 * Delete one language's translation of a row, keeping the row and its other
 * languages. Returns the number of translation rows removed.
 *
 * Ownership is re-checked against the main table for the same reason as
 * `tableDelete`: the sidecar cannot scope itself to a site.
 *
 * Unlike `tableDelete`, this does **not** refuse the default locale. Removing
 * the default locale's translation is a legitimate "make this language fall
 * back" edit — the main table still holds the default value (§2.5.3), so the
 * row keeps rendering. Refusing it here would invent a rule the schema does not
 * have.
 */
export async function tableDeleteTranslation(
  env: Env,
  def: ThemeTableDef,
  id: string,
  locale: string
): Promise<number> {
  if (!def.i18n_table) return 0;
  const owned = await env.DB.prepare(
    `SELECT id FROM ${def.table_name} WHERE id = ? AND site_id = ?`
  )
    .bind(id, def.site_id)
    .first<any>();
  if (!owned) return 0;
  const r = await env.DB.prepare(`DELETE FROM ${def.i18n_table} WHERE row_id = ? AND locale = ?`)
    .bind(id, locale)
    .run();
  return Number((r as any)?.meta?.changes ?? 0);
}

function normaliseValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * One aggregate over an owner's own table, for a plugin page's `stats` block.
 *
 * ## Why this is server-side and template-free
 *
 * The block declares `{aggregate, field?, groupBy?}`. Both the aggregate *name*
 * and the *column* are attacker-adjacent (they arrive from a manifest, which
 * arrives from an uploaded zip), so neither may be interpolated into SQL. The
 * aggregate is a closed set and the column must be one the table actually
 * declares — anything else returns `null` rather than a query, and the caller
 * reports "cannot compute" instead of a fabricated zero.
 *
 * ## `sum` returns null, not 0, on an empty table
 *
 * `SELECT SUM(x)` over no rows is SQL `NULL`, which means "no rows to add up"
 * — not the number zero. Reporting 0 would be inventing a data point. The
 * renderer already draws a value verbatim, so `null` surfaces as "—".
 */
export interface TableAggregateResult {
  aggregate: string;
  field: string | null;
  groupBy: string | null;
  /** Present when no `groupBy` was requested. */
  value: number | null;
  /** Present when `groupBy` was requested. */
  groups: Array<{ key: string; value: number | null }> | null;
}

const AGGREGATES = new Set(["count", "sum"]);

export async function tableAggregate(
  env: Env,
  def: ThemeTableDef,
  opts: { aggregate: string; field?: string | null; groupBy?: string | null; status?: string | null }
): Promise<TableAggregateResult | null> {
  const aggregate = String(opts.aggregate || "");
  if (!AGGREGATES.has(aggregate)) return null;

  const declared = new Set(def.fields.map((f) => String(f.key)));
  // Only a declared numeric column may be summed. `count` needs no column.
  const field = opts.field ? String(opts.field) : null;
  if (aggregate === "sum") {
    if (!field || !declared.has(field)) return null;
    const spec = def.fields.find((f) => String(f.key) === field);
    if (spec && String(spec.type ?? "text") !== "number") return null;
  }

  const groupBy = opts.groupBy ? String(opts.groupBy) : null;
  if (groupBy && !declared.has(groupBy)) return null;

  const expr = aggregate === "count" ? "COUNT(*)" : `SUM(m.${field})`;
  // `status` is a platform column on every generated table, so it is filtered
  // the same way `tableList` filters it. Dropping it here would make an
  // aggregate silently ignore the caller's selection — a count over
  // `status=draft` that counted everything is a number that looks right.
  const where = ["m.site_id = ?"];
  const binds: unknown[] = [def.site_id];
  if (opts.status) {
    where.push("m.status = ?");
    binds.push(String(opts.status));
  }
  const whereSql = where.join(" AND ");

  try {
    if (groupBy) {
      const r = await env.DB.prepare(
        `SELECT m.${groupBy} AS k, ${expr} AS v FROM ${def.table_name} m
         WHERE ${whereSql} GROUP BY m.${groupBy} ORDER BY m.${groupBy}`
      )
        .bind(...(binds as any[]))
        .all();
      return {
        aggregate,
        field,
        groupBy,
        value: null,
        groups: ((r.results as any[]) ?? []).map((row) => ({
          key: row?.k === null || row?.k === undefined ? "—" : String(row.k),
          value: row?.v === null || row?.v === undefined ? null : Number(row.v),
        })),
      };
    }
    const row = await env.DB.prepare(
      `SELECT ${expr} AS v FROM ${def.table_name} m WHERE ${whereSql}`
    )
      .bind(...(binds as any[]))
      .first<any>();
    return {
      aggregate,
      field,
      groupBy: null,
      value: row?.v === null || row?.v === undefined ? null : Number(row.v),
      groups: null,
    };
  } catch {
    return null;
  }
}

/**
 * Derive a slug for a save that arrived without one.
 *
 * Used by the plugin-page `form` write path, where the offered fields come from
 * the manifest's `form.fields[]` and never include the platform's `slug`. The
 * derivation is deliberately dull — first non-empty prose-ish field, slugged,
 * with a short random suffix so two rows with the same label do not collide on
 * a key that is a UNIQUE `(site_id, slug)`.
 *
 * A slug derived from *content* is not stable across edits, which is why this
 * is only used when the caller supplied none: the built-in screens keep their
 * explicit, author-chosen slug, and an update that wants to address an existing
 * row still must pass the slug it was given.
 */
export function deriveSlug(def: ThemeTableDef, data: Record<string, unknown>): string {
  const allowed = new Set(def.fields.map((f) => String(f.key)));
  let source = "";
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!allowed.has(k)) continue;
    const s = String(v ?? "").trim();
    if (s) { source = s; break; }
  }
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // A random tail keeps two same-labelled rows from fighting over one slug.
  const tail = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${tail}` : `row-${tail}`;
}
