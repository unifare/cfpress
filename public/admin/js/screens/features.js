/**
 * Screen: Features — platform capability switches.
 *
 * Three switches, all **off by default**:
 *
 *   cache_mirror_kv         mirror the content-cache version into KV
 *   theme_runtime_worker    run `runtime: "worker"` themes in the sandbox
 *                           (needs a paid plan + the `worker_loaders` binding)
 *   ui_locale_follow_site   offer only this site's languages in the admin
 *                           interface-language menu
 *
 * The first two gate a paid Cloudflare feature; the third changes a documented
 * default (§2.4 decouples the interface language from the site's languages, so
 * an English-only site whose owner reads Chinese still offers Chinese).
 * Turning it on is how an operator says "not here".
 *
 * Three things this screen refuses to hide:
 *
 *  1. **Provenance.** A value comes from the site's own setting, from
 *     `wrangler.jsonc` `vars`, or from the declared default. Those look
 *     identical if all you render is a checkbox, and only the first is
 *     something the operator can change here — so the source is labelled on
 *     every row and "Reset to inherited" is offered when a site overrides.
 *
 *  2. **What happens when it is off.** "Off" is not "broken": every feature
 *     degrades to a working fallback. The description says which fallback,
 *     because a switch whose consequence is invisible gets flipped blindly.
 *
 *  3. **Consequences that cost money.** `theme_runtime_worker` needs
 *     `worker_loaders` configured on the account. Turning it on without the
 *     binding changes nothing, and saying so here is cheaper than the support
 *     question later.
 *
 * Requires `settings.manage`; the write goes through the normal settings row,
 * so it is per-site and takes effect on the next request with no redeploy.
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast, confirmDialog } from "../../ui.js";

const SOURCE_LABEL = {
  site: "set for this site",
  var: "from wrangler config",
  default: "platform default",
};

/** Reads are cheap but not free; render from state once loaded so the row
 *  markup and the click handler cannot disagree about a switch's value. */
let current = null;

export default async function features(c) {
  const d = await api(scoped("features"));
  current = d;
  const site = state.sites.find((s) => s.id === state.site);
  const items = d.items || [];

  const rows = items
    .map((x) => {
      const overridden = x.source === "site";
      return `<div class="panel" style="margin-bottom:1rem" data-feature-row="${attr(x.key)}">
        <div style="display:flex;gap:1rem;align-items:flex-start;justify-content:space-between">
          <div style="flex:1;min-width:0">
            <div class="card-title" style="margin-bottom:.25rem">${esc(x.label)}</div>
            <div class="muted text-sm">key <code>${esc(x.key)}</code> · ${esc(SOURCE_LABEL[x.source] || x.source)}${
              overridden
                ? ` <button class="btn outline sm" data-feature-reset="${attr(x.key)}" style="margin-left:.5rem">Reset to inherited</button>`
                : ""
            }</div>
            <div class="muted text-sm" style="margin-top:.35rem">
              Deploy fallback <code>${esc(x.var)}</code> · default <b>${x.default_on ? "on" : "off"}</b>
              ${x.inherited && x.inherited.source === "var" ? ` · config says <b>${x.inherited.enabled ? "on" : "off"}</b>` : ""}
            </div>
          </div>
          <button class="btn ${x.enabled ? "primary" : "outline"}"
                  data-feature-toggle="${attr(x.key)}"
                  data-feature-on="${x.enabled ? "1" : "0"}"
                  aria-pressed="${x.enabled ? "true" : "false"}"
                  style="flex:0 0 auto">
            ${icon(x.enabled ? "check" : "x")}${x.enabled ? "On" : "Off"}
          </button>
        </div>
      </div>`;
    })
    .join("");

  c.innerHTML = `${pageHead({
    title: "Features",
    sub: `Platform capability switches · ${site?.name || state.site}`,
    crumbs: [{ label: "Tools" }, { label: "Features" }],
  })}
  <div class="panel" style="margin-bottom:1rem">
    <div class="card-desc">These switches are stored per site and take effect on the next request — no redeploy. A site with no stored value inherits the wrangler config, then the platform default. All default to <b>off</b>.</div>
  </div>
  ${rows || `<div class="panel"><div class="empty">No feature switches are declared.</div></div>`}
  <p class="muted text-sm">Turning <code>cache_mirror_kv</code> off stops the mirror being written. Values already mirrored stay readable, so switching it off never orphans cached entries — and switching it on cannot resurrect a stale one, because the authoritative version lives in the database either way.</p>
  <p class="muted text-sm"><code>ui_locale_follow_site</code> off is the platform default: the interface-language menu offers every language the platform knows, so an English-only site whose owner reads Chinese can still read the admin in Chinese. Turning it on narrows that menu to the languages this site serves — and with it the set the server will accept, because the menu and the validation set are one definition.</p>`;
}

async function saveFeature(key, value) {
  // `value: null` means "drop this site's override and inherit".
  const res = await api(scoped("features"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  return res;
}

document.addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-feature-toggle]");
  if (toggle) {
    const key = toggle.dataset.featureToggle;
    const wasOn = toggle.dataset.featureOn === "1";
    try {
      await saveFeature(key, wasOn ? false : true);
      toast(`${key} turned ${wasOn ? "off" : "on"}`);
      await rerender();
    } catch (err) {
      toast(err.message || "Could not update feature", "error");
    }
    return;
  }

  const reset = e.target.closest("[data-feature-reset]");
  if (reset) {
    const key = reset.dataset.featureReset;
    const okToReset = await confirmDialog({
      title: "Reset to inherited value",
      description: `${key} will stop being overridden for this site and fall back to the wrangler config, then the platform default.`,
      confirmLabel: "Reset",
    });
    if (!okToReset) return;
    try {
      await saveFeature(key, null);
      toast(`${key} reset to inherited`);
      await rerender();
    } catch (err) {
      toast(err.message || "Could not reset feature", "error");
    }
  }
});

/**
 * Re-render through the shell instead of reloading the page.
 *
 * A saved value is not necessarily the applied value: the server resolves the
 * site setting, then the var, then the default, and only it knows which one
 * won. Re-reading through the same `render()` the shell uses means the button
 * can never show a state the runtime disagrees with. The previous version did
 * `location.reload()`, which achieved the same thing by throwing away the whole
 * admin — including which nav groups were open.
 */
async function rerender() {
  const { state } = await import("../state.js");
  const { render } = await import("../shell.js");
  await render();
  void state;
}

export { current };
