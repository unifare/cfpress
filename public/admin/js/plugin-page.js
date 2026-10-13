/**
 * Plugin-declared admin pages, rendered by the host (ARCHITECTURE.md §5.3).
 *
 * ## Why this file exists
 *
 * A plugin cannot ship executable JavaScript: the Workers runtime forbids
 * `eval`/`new Function`, and loading a third-party module into the host process
 * is exactly what the capability model exists to prevent. So a plugin that
 * wants "its own page" declares *what the page needs* — a `blocks[]` array —
 * and the host draws it. The plugin supplies intent, never code.
 *
 * This is the third application of the same pattern, and deliberately so:
 *
 *   `tables[].fields[]`       → the host generates CRUD forms
 *   `channels[].configSchema` → the host generates settings forms
 *   `adminPages[].blocks[]`   → the host generates whole pages  ← this file
 *
 * ## The exported lists are the contract, not documentation
 *
 * `RENDERED_BLOCK_TYPES` and `RENDERED_CHANNEL_FIELD_TYPES` are read by
 * `tests/architecture.test.mjs` and compared, as *sets*, against
 * `ALLOWED_PAGE_BLOCKS` and `ALLOWED_CHANNEL_FIELD_TYPES` in the contract.
 *
 * The alternative was for the test to parse the `switch` statements below.
 * That is the brittle shape this repository has been bitten by repeatedly: a
 * guard that pattern-matches source text is defeated by writing the same
 * intent a different way (AGENTS.md "同一意图的两种写法"). A guard that parses
 * a switch is guessing at structure it could simply be told.
 *
 * So: **adding a block type means adding it in three places** — the contract,
 * this list, and the renderer — and the mismatch is a test failure rather than
 * a blank panel at HTTP 200. A block type with no renderer is the same class of
 * defect as a template slot that never fills: it looks like data is missing.
 */
import { attr, esc, fmtDate } from "../ui.js";
import { icon } from "../icons.js";

/**
 * The block types this module can draw.
 *
 * Must equal `ALLOWED_PAGE_BLOCKS` in `extensions/contract/manifest.ts`.
 */
export const RENDERED_BLOCK_TYPES = ["table", "stats", "form"];

/**
 * The channel config field types this module has a control for.
 *
 * Must equal `ALLOWED_CHANNEL_FIELD_TYPES` in `extensions/contract/channels.ts`.
 * A declared field type with no control renders an empty input, which reads as
 * "the setting is unset" rather than "the manifest asked for something the
 * admin cannot draw" — so the mismatch is worth failing a test over.
 */
export const RENDERED_CHANNEL_FIELD_TYPES = ["text", "password", "url", "number", "boolean"];

/**
 * The aggregates this module can draw.
 *
 * Must equal `ALLOWED_AGGREGATES` in `extensions/contract/manifest.ts` and the
 * set `tableAggregate` on the server will compute. Three spellings of one
 * closed set is two too many — hence a comparison in
 * `tests/architecture.test.mjs` rather than a comment asking nicely.
 */
export const RENDERED_AGGREGATES = ["count", "sum"];

/** Human labels for the block types, used in the page header and empty states. */
const BLOCK_LABELS = {
  table: "Records",
  stats: "Summary",
  form: "Submit",
};

/**
 * The field declarations for a block's source.
 *
 * The table endpoint answers `{ def: { fields: [...] }, locale, items }`, so
 * the declarations live at `data.def.fields`. A *flat* `data.fields` is also
 * accepted because an aggregate response reuses the same envelope and a future
 * caller may hand the block a narrower payload. Reading only the flat path was
 * the bug that made every `table` and `form` block draw "the table declares no
 * such fields" at HTTP 200 — the columns were declared, shown from the wrong
 * key, and the block looked empty rather than mis-wired.
 */
function sourceFields(data) {
  if (Array.isArray(data?.def?.fields)) return data.def.fields;
  if (Array.isArray(data?.fields)) return data.fields;
  return [];
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------
// Each takes `(block, data)` and returns HTML. `data` is whatever the API
// returned for the block's `source` table; a renderer that finds nothing must
// draw an explanation, never an empty box — an empty box and a failed load
// look identical to the person reading the screen.

/**
 * `table` — the rows of one of the plugin's own declared tables.
 *
 * Columns come from the block's `columns[]` list. A column naming a field the
 * table does not declare is skipped rather than rendered as a blank header:
 * the validator rejects that combination at install time, so reaching here with
 * one means the manifest on disk differs from the one in the database, and a
 * silently blank column would hide that.
 */
function renderTableBlock(block, data) {
  const cols = Array.isArray(block.columns) ? block.columns.map(String) : [];
  const rows = Array.isArray(data?.items) ? data.items : [];
  const fields = sourceFields(data);
  const byKey = new Map(fields.map((f) => [String(f.key), f]));
  const shown = cols.filter((c) => byKey.has(c));

  if (!shown.length) {
    return `<div class="panel"><div class="empty">This block lists columns ${esc(
      cols.join(", ") || "(none declared)"
    )}, but the table declares no such fields.</div></div>`;
  }

  const head = shown.map((c) => `<th>${esc(String(byKey.get(c).label || c))}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = shown
        .map((c) => {
          const field = byKey.get(c);
          const value = row[c];
          if (field.type === "boolean") return `<td>${Number(value) ? "Yes" : "No"}</td>`;
          if (field.type === "datetime") return `<td class="muted text-sm">${esc(fmtDate(value))}</td>`;
          return `<td>${esc(value === null || value === undefined ? "—" : String(value))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<div class="table-wrap"><table class="table">
    <thead><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${shown.length}" class="empty">No records yet.</td></tr>`}</tbody>
  </table></div>`;
}

/**
 * `stats` — one aggregate over one of the plugin's own tables.
 *
 * Supported aggregates are exactly the ones the validator accepts
 * (`ALLOWED_AGGREGATES` = `count`, `sum`) and that the API can compute without
 * a query builder. An unknown aggregate is reported as a configuration problem
 * rather than silently shown as a zero — a zero is a *value*, and displaying it
 * for an unsupported operation would be a fabricated number.
 */
function renderStatsBlock(block, data) {
  const aggregate = String(block.aggregate || "count");
  const groupBy = block.groupBy ? String(block.groupBy) : "";
  const label = String(block.label || BLOCK_LABELS.stats);

  const KNOWN = RENDERED_AGGREGATES;
  if (!KNOWN.includes(aggregate)) {
    return `<div class="panel"><div class="empty">"${esc(aggregate)}" is not an aggregate this admin can compute (${esc(
      KNOWN.join(", ")
    )}).</div></div>`;
  }

  // The API returns either a single number or a grouped breakdown. A grouped
  // result with no `groupBy` in the manifest is a mismatch worth naming.
  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (groups) {
    if (!groupBy) {
      return `<div class="panel"><div class="empty">The API returned a grouped result but this block declares no groupBy.</div></div>`;
    }
    const cards = groups
      .map(
        (g) => `<div class="stat">
        <div class="stat-label">${esc(String(g.key ?? "—"))}</div>
        <div class="stat-value">${esc(g.value === null || g.value === undefined ? "—" : String(g.value))}</div>
      </div>`
      )
      .join("");
    return `<div class="stats">${cards || `<div class="empty">No data.</div>`}</div>`;
  }

  // `value` is `null` when there is nothing to add up (SUM over no rows), which
  // is drawn as an em dash — never as 0, which would be a fabricated datapoint.
  const value = data?.value;
  const shown = value === null || value === undefined ? "—" : String(value);
  return `<div class="stats"><div class="stat">
    <div class="stat-label">${esc(label)} · ${esc(aggregate)}${groupBy ? ` by ${esc(groupBy)}` : ""}</div>
    <div class="stat-value">${esc(shown)}</div>
  </div></div>`;
}

/**
 * `form` — a write form onto one of the plugin's own tables.
 *
 * The fields come from the block's `fields[]` list and are resolved against the
 * table's own declarations, so the input types match the column types. The form
 * posts to the same table API the built-in table screens use — it is a second
 * view of one write path, not a second write path.
 */
function renderFormBlock(block, data) {
  const names = Array.isArray(block.fields) ? block.fields.map(String) : [];
  const fields = sourceFields(data);
  const byKey = new Map(fields.map((f) => [String(f.key), f]));
  const shown = names.filter((n) => byKey.has(n));

  if (!shown.length) {
    return `<div class="panel"><div class="empty">This form names fields ${esc(
      names.join(", ") || "(none declared)"
    )}, but the table declares no such fields.</div></div>`;
  }

  const controls = shown
    .map((n) => {
      const f = byKey.get(n);
      const label = esc(String(f.label || n));
      if (f.type === "boolean") {
        return `<div class="field"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" data-pp="${attr(n)}"> ${label}</label></div>`;
      }
      if (f.type === "textarea") {
        return `<div class="field"><label>${label}</label><textarea rows="3" data-pp="${attr(n)}"></textarea></div>`;
      }
      const type = f.type === "number" ? "number" : f.type === "url" ? "url" : "text";
      return `<div class="field"><label>${label}</label><input type="${type}" data-pp="${attr(n)}"${f.required ? " required" : ""}></div>`;
    })
    .join("");

  return `<div class="panel"><form class="pp-form" data-pp-form="${attr(String(block.source ?? ""))}">
    ${controls}
    <div class="actions"><button class="btn primary" type="submit">${icon("save")}${esc(
      String(block.submitLabel || "Submit")
    )}</button></div>
  </form></div>`;
}

/** The renderer table. Keys are exactly `RENDERED_BLOCK_TYPES`. */
const BLOCK_RENDERERS = {
  table: renderTableBlock,
  stats: renderStatsBlock,
  form: renderFormBlock,
};

/**
 * Draw one page from its declaration plus the data its blocks asked for.
 *
 * `blocks` is the manifest's `adminPages[].blocks[]`; `dataBySource` maps a
 * block's `source` to the API payload for that table. A block whose source has
 * no data still renders — with its own explanation — because a missing panel
 * among present ones reads as "the plugin is broken", and the person looking at
 * it cannot tell which half failed.
 */
export function renderPluginPage(decl, dataBySource = {}) {
  const blocks = Array.isArray(decl?.blocks) ? decl.blocks : [];
  return blocks
    .map((block, i) => {
      const type = String(block?.type ?? "");
      const draw = BLOCK_RENDERERS[type];
      if (!draw) {
        // Should be unreachable: the validator rejects unknown block types and
        // `tests/architecture.test.mjs` compares this module's list against the
        // contract. Still handled, because "unreachable" is a claim about today.
        return `<div class="panel"><div class="empty">Block ${i + 1} has type "${esc(
          type
        )}", which this admin cannot render.</div></div>`;
      }
      const source = String(block?.source ?? "");
      return draw(block, dataBySource[source]);
    })
    .join("");
}

/**
 * Render a channel's configuration controls from its `configSchema[]`.
 *
 * Returns `{ html, keys }`: the markup, and the field keys it drew. The caller
 * needs `keys` to decide which settings to read and write, and returning them
 * from the same function that drew the controls is what keeps "what I drew" and
 * "what I save" from drifting apart.
 */
export function renderChannelConfig(schema, values = {}) {
  const fields = Array.isArray(schema) ? schema : [];
  const keys = [];
  const html = fields
    .map((f) => {
      const key = String(f?.key ?? "");
      if (!key) return "";
      const type = String(f?.type ?? "text");
      keys.push(key);
      const label = esc(String(f?.label || key));
      const value = values[key] ?? f?.default ?? "";
      const required = f?.required ? " required" : "";
      const hint = f?.hint ? `<span class="hint">${esc(String(f.hint))}</span>` : "";

      if (type === "boolean") {
        const on = value === true || value === 1 || value === "1" || value === "true";
        return `<div class="field"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" data-ch="${attr(
          key
        )}"${on ? " checked" : ""}> ${label}</label>${hint}</div>`;
      }
      // `password` and `url` are `<input type=...>` with a distinct type so the
      // browser can mask / validate them; unknown types deliberately fall back
      // to `text` rather than throwing, because the validator already rejected
      // anything not in the closed set and a hard failure here would take down
      // the whole settings screen over one bad field.
      const inputType = type === "password" ? "password" : type === "url" ? "url" : type === "number" ? "number" : "text";
      return `<div class="field"><label>${label}</label><input type="${inputType}" data-ch="${attr(
        key
      )}" value="${attr(value)}"${required}>${hint}</div>`;
    })
    .join("");
  return { html, keys };
}

/**
 * Render the whole settings form for a plugin's declared channels.
 *
 * One form, one save: a plugin with two channels gets two sections in one
 * dialog rather than two round-trips. Values are keyed `channel.<code>.<key>`,
 * matching what `readChannelConfig` looks up on the server — the namespace is
 * the wire format, so it is spelled in exactly one place per side.
 */
export function renderChannelSettings(channels, values = {}) {
  const list = Array.isArray(channels) ? channels : [];
  if (!list.length) return "";
  return list
    .map((ch) => {
      const code = String(ch?.code ?? "");
      const { html } = renderChannelConfig(ch?.configSchema, values[code] ?? {});
      // The panel carries the channel code, and the inputs inside inherit its
      // scope when values are read back. Without it, two channels that both
      // declare a `url` field produce two inputs with the same `data-ch` key
      // and only the first is ever read — so the second channel's endpoint was
      // silently unconfigurable.
      return `<div class="panel" data-ch-scope="${attr(code)}"><div class="panel-head">
        <h3>${esc(String(ch?.label || code))}</h3>
        <span class="muted text-sm">${esc(code)}</span>
      </div>${html || `<div class="empty">This channel declares no configuration.</div>`}</div>`;
    })
    .join("");
}

/**
 * Read a rendered channel form back into `{ "<code>.<key>": value }`.
 *
 * Values are read **per channel panel**, not from a flat query, so two channels
 * declaring the same field name each get their own value. The returned keys are
 * fully qualified (`channel.<code>.<field>`) because that is the shape
 * `readChannelConfig` on the server looks up — the namespace is the wire
 * format, and spelling it here is what makes the write round-trip.
 */
export function collectChannelValues(root) {
  const out = {};
  for (const panel of root.querySelectorAll("[data-ch-scope]")) {
    const code = panel.dataset.chScope;
    if (!code) continue;
    for (const el of panel.querySelectorAll("[data-ch]")) {
      const key = el.dataset.ch;
      if (!key) continue;
      const value = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
      out[`channel.${code}.${key}`] = value;
    }
  }
  return out;
}
