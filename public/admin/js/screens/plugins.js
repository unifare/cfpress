/**
 * Screen: Plugins — installed plugins, enable/disable and declared settings.
 *
 * Plugins are declarative: the manifest names hooks, the host provides their
 * implementations. There is no executable plugin code.
 */
import { api } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, attr, emptyRow, esc, openDialog, toast } from "../../ui.js";
import { installExtension } from "./extension-install.js";

export default async function plugins(c) {
  const d = await api("extensions/plugins");
  const items = d.items || [];
  const rows = items.map((x) => `<tr>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <span class="team-logo" style="width:2rem;height:2rem;background:var(--muted);color:var(--muted-foreground)">${icon("puzzle")}</span>
        <div><div style="font-weight:500">${esc(x.title)}</div><div class="muted text-sm">v${esc(x.version)}${x.hooks_wired?.length ? ` · ${esc(t("core.plugins.hooks", "hooks: {list}", { list: x.hooks_wired.join(", ") }))}` : ""}</div></div>
      </div></td>
      <td>${x.enabled ? `<span class="badge success">${esc(t("core.plugins.enabled", "enabled"))}</span>` : `<span class="badge secondary">${esc(t("core.plugins.disabled", "disabled"))}</span>`}</td>
      <td class="actions">
        <button class="btn outline sm" data-plugin-toggle="${attr(x.name)}|${x.enabled ? 1 : 0}">${icon(x.enabled ? "x" : "check")}${esc(t(x.enabled ? "core.plugins.disable" : "core.plugins.enable", x.enabled ? "Disable" : "Enable"))}</button>
        <button class="btn outline sm" data-plugin-settings="${attr(x.name)}">${icon("settings")}${esc(t("core.nav.settings", "Settings"))}</button>
      </td>
    </tr>`).join("");

  c.innerHTML = `${pageHead({
    title: t("core.nav.plugins", "Plugins"),
    sub: t("core.plugins.sub", "{n} installed · declarative hooks, no executable plugin code", { n: items.length }),
    actions: `<label class="btn primary">${icon("upload")}${esc(t("core.plugins.installZip", "Install plugin ZIP"))}<input id="pluginZip" type="file" accept=".zip" hidden></label>`,
    crumbs: [{ label: t("core.nav.system", "System") }, { label: t("core.nav.plugins", "Plugins") }],
  })}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>${esc(t("core.plugins.colPlugin", "Plugin"))}</th><th>${esc(t("core.content.status", "Status"))}</th><th></th></tr></thead>
    <tbody>${rows || emptyRow(3, t("core.plugins.none", "No plugins installed."))}</tbody>
  </table></div>`;

  document.querySelector("#pluginZip").onchange = (e) => installExtension(e.target.files[0], "plugins");
}

export async function pluginSettings(n) {
  let d;
  try { d = await api(`extensions/plugins/${n}/settings`); }
  catch (e) { await alertDialog({ title: t("core.plugins.loadFailed", "Could not load settings"), description: e.message }); return; }
  if (!d.items?.length) { toast(t("core.plugins.noSettings", "This plugin declares no settings")); return; }

  const v = await openDialog({
    title: t("core.plugins.settingsTitle", "{name} settings", { name: n }),
    description: t("core.plugins.settingsDesc", "Values are stored per plugin and validated against its manifest."),
    confirmLabel: t("core.plugins.saveSettings", "Save settings"),
    fields: d.items.map((x) => ({ name: x.key, label: x.label || x.key, value: x.value || "" })),
  });
  if (!v) return;
  try {
    for (const [key, value] of Object.entries(v)) {
      await api(`extensions/plugins/${n}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    }
    toast(t("core.plugins.saved", "Plugin settings saved"));
  } catch (e) { await alertDialog({ title: t("core.plugins.saveFailed", "Could not save"), description: e.message }); }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-plugin-toggle]");
  if (btn) {
    const [name, on] = btn.dataset.pluginToggle.split("|");
    try {
      await api("extensions/plugins/" + name + "/" + (on === "1" ? "disable" : "enable"), { method: "POST" });
      // ⚠️ Not `t` — the local above shadows the dictionary import, and a shadowed
      // `t` here would have been a runtime TypeError on every toggle.
      toast(on === "1" ? t("core.plugins.toggledOff", "Plugin disabled") : t("core.plugins.toggledOn", "Plugin enabled"));
      render();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  const s = e.target.closest("[data-plugin-settings]");
  if (s) await pluginSettings(s.dataset.pluginSettings);
});
