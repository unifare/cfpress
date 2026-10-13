/**
 * The read ladder for custom fields (`post_meta`), and the one place it is
 * defined.
 *
 * `post_meta` gained a language dimension in migration 0019. A value is now
 * written per (post, key, locale), which raises the question every
 * multi-language store has to answer: what does a language that never saved a
 * value display? Scattering that answer across the four read sites is exactly
 * how they drift apart, so the ladder lives here and the readers call it.
 *
 * The ladder, best first:
 *
 *   1. the content locale's own value — what this language saved;
 *   2. the site's default language — a field the editor only filled in the
 *      default language still *says* something on a second-language page, and
 *      an untranslated category name beats an "uncategorised" chip;
 *   3. `''` — rows written before 0019 existed. The migration deliberately
 *      does not backfill them (see its header), so they carry no language, and
 *      they must keep rendering exactly as they did;
 *   4. anything — never show "uncategorised" while some language holds a value.
 *
 * Tie-breaking is by insertion order within a rank, which is SQL's natural
 * return order; the ranks above are what make the choice deterministic.
 */

/** One `post_meta` row, as the read sites fetch it. */
export interface MetaRow {
  post_id: string;
  meta_key: string;
  locale: string | null;
  meta_value: string | null;
}

/** Lower wins. The ladder of the header comment, one number each. */
export function metaLocaleRank(row: Pick<MetaRow, "locale">, locale: string, fallback: string): number {
  const l = String(row.locale ?? "");
  if (locale && l === locale) return 0;
  if (fallback && l === fallback) return 1;
  if (l === "") return 2;
  return 3;
}

/**
 * Resolve a batch of rows into one meta map per post. One query serves a whole
 * listing; this function is what makes that one query behave like the ladder.
 */
export function resolveMetaByPost<T extends MetaRow>(
  rows: T[],
  locale: string,
  fallback: string
): Map<string, Record<string, string>> {
  const best = new Map<string, MetaRow>();
  for (const r of rows) {
    const k = `${r.post_id}\u0000${r.meta_key}`;
    const cur = best.get(k);
    if (!cur || metaLocaleRank(r, locale, fallback) < metaLocaleRank(cur, locale, fallback)) best.set(k, r);
  }
  const out = new Map<string, Record<string, string>>();
  for (const r of best.values()) {
    const bucket = out.get(r.post_id) ?? {};
    bucket[r.meta_key] = String(r.meta_value ?? "");
    out.set(r.post_id, bucket);
  }
  return out;
}
