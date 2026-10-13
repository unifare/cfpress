/**
 * Screen: a plugin-declared admin page (`plugin-page:<id>`, ARCHITECTURE.md §5.3).
 *
 * Reached from a plugin menu that declares `{ screen: "plugin-page:<id>" }`.
 * The page's content comes entirely from the plugin's `adminPages[]`
 * declaration plus the data in the plugin's own tables — this screen knows
 * nothing about any particular plugin, exactly as `table-list` knows nothing
 * about any particular theme's tables.
 *
 * ## Where the declaration comes from
 *
 * From `/api/v1/extensions/plugins`, which already lists every plugin with its
 * manifest. Reading the declaration from the same payload the Plugins screen
 * uses means there is one source of truth for "what did this plugin declare",
 * and a plugin that is disabled stops offering its pages in the same breath.
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { attr, esc, openDialog, toast } from "../../ui.js";
import { renderPluginPage, renderChannelSettings, collectChannelValues } from "../plugin-page.js";

/**
 * Find the page declaration for an id across every enabled plugin.
 *
 * Returns `{ plugin, decl }` or `null`. A menu pointing at a page no plugin
 * declares is a broken menu — the validator rejects that at install time, so
 * reaching here usually means the plugin was disabled after the menu was
 * created — and the screen says so rather than rendering an empty panel.
 */
function findPage(pageId) {
  for (const p of state.plugins ?? []) {
    if (!p?.enabled) continue;
    for (const decl of Array.isArray(p.adminPages) ? p.adminPages : []) {
      if (String(decl?.id ?? "") === pageId) return { plugin: p, decl };
    }
  }
  return null;
}

export async function pluginPageScreen(c, pageId) {
  const id = String(pageId ?? "").trim();
  if (!id) {
    c.innerHTML = `${pageHead({ title: "Plugin page", crumbs: [{ label: "Plugins" }, { label: "Page" }] })}
    <div class="panel"><div class="empty">This screen needs a page id. Declare it as <code>plugin-page:&lt;id&gt;</code> on the menu.</div></div>`;
    return;
  }

  const found = findPage(id);
  if (!found) {
    c.innerHTML = `${pageHead({ title: id, crumbs: [{ label: "Plugins" }, { label: id }] })}
    <div class="panel"><div class="empty">No enabled plugin declares a page with id "${esc(id)}". It may have been disabled.</div></div>`;
    return;
  }

  const { plugin, decl } = found;
  const blocks = Array.isArray(decl.blocks) ? decl.blocks : [];

  // Load the data each block asked for. A block whose table fails to load must
  // not take the page down: the renderer draws an explanation for that block
  // and the others still appear, so the reader can tell which part is missing.
  //
  // A `stats` block asks the same table endpoint for an *aggregate* rather than
  // rows, so the request carries `aggregate`/`field`/`groupBy` from the block.
  // Every block on one source shares the row payload; the stats requests are
  // separate and keyed by source too, so a page that shows both a table and a
  // count of the same table gets both.
  const sources = [...new Set(blocks.map((b) => String(b?.source ?? "")).filter(Boolean))];
  const dataBySource = {};
  await Promise.all(
    sources.map(async (source) => {
      const forSource = blocks.filter((b) => String(b?.source ?? "") === source);
      const statsBlocks = forSource.filter((b) => String(b?.type ?? "") === "stats");
      // Rows are only needed when a non-stats block reads this table; a
      // stats-only page should not pull 100 rows it will never draw.
      const needsRows = forSource.some((b) => String(b?.type ?? "") !== "stats");
      try {
        dataBySource[source] = needsRows
          ? await api(scoped(`theme-tables/${encodeURIComponent(source)}?limit=100`))
          : null;
      } catch {
        dataBySource[source] = null;
      }
      for (const b of statsBlocks) {
        const q = new URLSearchParams({ aggregate: String(b.aggregate ?? "count") });
        if (b.field) q.set("field", String(b.field));
        if (b.groupBy) q.set("groupBy", String(b.groupBy));
        try {
          dataBySource[source] = await api(scoped(`theme-tables/${encodeURIComponent(source)}?${q}`));
        } catch {
          // Leave whatever the row read produced (or null) so the block still
          // renders its own explanation instead of vanishing.
        }
      }
    })
  );

  const channels = Array.isArray(plugin.channels) ? plugin.channels : [];
  const title = String(decl.title || id);
  const actions = channels.length
    ? `<button class="btn outline" data-pp-channels="${attr(plugin.name)}">Configure channels</button>`
    : "";

  c.innerHTML = `${pageHead({
    title,
    sub: `${esc(plugin.title)} · ${blocks.length} block${blocks.length === 1 ? "" : "s"}`,
    actions,
    crumbs: [{ label: "Plugins" }, { label: title }],
  })}
  ${blocks.length ? renderPluginPage(decl, dataBySource) : `<div class="panel"><div class="empty">This page declares no blocks.</div></div>`}`;
}

/**
 * Open the channel settings dialog for a plugin.
 *
 * Published as a delegated handler rather than an inline `onclick=` so a
 * missing registration cannot silently produce a dead button (rule 21); the
 * event below is bound to a real element in this screen's markup.
 */
async function configureChannels(pluginName) {
  const plugin = (state.plugins ?? []).find((p) => p?.name === pluginName);
  const channels = Array.isArray(plugin?.channels) ? plugin.channels : [];
  if (!channels.length) {
    toast("This plugin declares no channels");
    return;
  }

  // Prefill from what is already stored, so saving does not blank a working
  // configuration. The server returns channel values keyed by their fully
  // qualified setting name.
  let stored = {};
  try {
    const d = await api(`extensions/plugins/${pluginName}/settings`);
    for (const row of d.items ?? []) {
      const key = String(row.key ?? "");
      if (key.startsWith("channel.")) stored[key] = row.value ?? "";
    }
  } catch {
    /* nothing stored yet is not an error */
  }
  const values = {};
  for (const ch of channels) {
    const code = String(ch?.code ?? "");
    values[code] = {};
    for (const f of Array.isArray(ch?.configSchema) ? ch.configSchema : []) {
      const key = String(f?.key ?? "");
      if (key) values[code][key] = stored[`channel.${code}.${key}`] ?? f?.default ?? "";
    }
  }

  const host = document.createElement("div");
  // `openDialog` builds the dialog's own markup, so the channel fields are
  // rendered here as a `bodyHtml` payload rather than as dialog fields: their
  // names are namespaced (`channel.<code>.<key>`), which `openDialog`'s flat
  // `name` model cannot express without two channels that both declare a `url`
  // field colliding on one input.
  const bodyHtml = `<div id="pp-channels">${renderChannelSettings(channels, values)}</div>`;
  const ok = await openDialog({
    title: `${plugin.title || pluginName} channels`,
    description: "Values are stored per plugin and read back by the host when it delivers a notification.",
    confirmLabel: "Save channels",
    bodyHtml,
  });
  if (!ok) return;

  const rootEl = document.querySelector("#pp-channels") ?? host;
  const valuesOut = collectChannelValues(rootEl);

  try {
    for (const [key, value] of Object.entries(valuesOut)) {
      // `key` is already fully qualified (`channel.<code>.<field>`) because the
      // read walked each channel's own panel — exactly the name the server's
      // `readChannelConfig` looks up, so the write round-trips.
      await api(`extensions/plugins/${pluginName}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    }
    toast("Channel settings saved");
  } catch (e) {
    toast(e.message || "Could not save channel settings", "error");
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-pp-channels]");
  if (t) configureChannels(t.dataset.ppChannels);
});

// Write blocks post to the same table API the built-in table screens use.
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-pp-form]");
  if (!form) return;
  e.preventDefault();
  const table = form.dataset.ppForm;
  const payload = {};
  for (const el of form.querySelectorAll("[data-pp]")) {
    const key = el.dataset.pp;
    if (!key) continue;
    payload[key] = el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value;
  }
  try {
    await api(scoped(`theme-tables/${encodeURIComponent(table)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("Submitted");
  } catch (err) {
    toast(err.message || "Could not submit", "error");
  }
});
