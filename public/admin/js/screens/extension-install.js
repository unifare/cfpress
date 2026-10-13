/**
 * Extension upload — shared by the Themes and Plugins screens.
 *
 * Both screens post a ZIP to the same endpoint shape, so this lives in its own
 * module rather than making one screen depend on the other.
 */
import { api } from "../state.js";
import { render } from "../shell.js";
import { t } from "../i18n.js";
import { alertDialog, toast } from "../../ui.js";

export async function installExtension(file, type) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const d = await api(`extensions/${type}/upload`, { method: "POST", body: fd });
    toast(t("core.ext.installed", "Installed {name} {version}", { name: d.name, version: d.version }));
    render();
  } catch (e) {
    await alertDialog({ title: t("core.ext.installFailed", "Install failed"), description: e.message });
  }
}
