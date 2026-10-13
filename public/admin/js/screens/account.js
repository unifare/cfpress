/**
 * Screen: Account — the signed-in user changes their own password / username.
 *
 * Deliberately separate from the Users screen: that one manages *other*
 * accounts (and needs `users.manage`), this one manages *your own*
 * credentials and is available to every signed-in role. The current-password
 * gate is enforced server-side; the client only pre-checks that the two new
 * passwords match so the common typo does not cost a round trip.
 */
import { api, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, esc, toast } from "../../ui.js";
import { t } from "../i18n.js";

export default async function account(c) {
  c.innerHTML = `${pageHead({
    title: t("core.account.title", "Account"),
    sub: t("core.account.sub", "Change your own login credentials. They apply to every site on this install."),
    crumbs: [{ label: t("core.account.title", "Account") }],
  })}
  <div class="panel" style="max-width:34rem">
    <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">${esc(t("core.account.changePassword", "Change password"))}</h2>
    <div class="field"><label for="acc-cur">${esc(t("core.account.currentPassword", "Current password"))}</label>
      <input id="acc-cur" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="acc-new">${esc(t("core.account.newPassword", "New password"))}</label>
      <input id="acc-new" type="password" autocomplete="new-password"></div>
    <div class="field" style="margin-bottom:1rem"><label for="acc-confirm">${esc(t("core.account.confirmPassword", "Confirm new password"))}</label>
      <input id="acc-confirm" type="password" autocomplete="new-password"></div>
    <button class="btn primary" data-action="account-password">${icon("key-round")}${esc(t("core.account.changePassword", "Change password"))}</button>
  </div>
  <div class="panel" style="max-width:34rem;margin-top:1rem">
    <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">${esc(t("core.account.changeUsername", "Change username"))}</h2>
    <div class="field"><label for="acc-user">${esc(t("core.account.username", "Username"))}</label>
      <input id="acc-user" value="${esc(state.user?.username || "")}" autocomplete="username">
      <span class="hint">${esc(t("core.account.usernameHint", "3–32 characters: letters, digits, dot, dash, underscore."))}</span></div>
    <div class="field" style="margin-bottom:1rem"><label for="acc-user-cur">${esc(t("core.account.currentPassword", "Current password"))}</label>
      <input id="acc-user-cur" type="password" autocomplete="current-password"></div>
    <button class="btn primary" data-action="account-username">${icon("user")}${esc(t("core.account.changeUsername", "Change username"))}</button>
  </div>`;
}

/** Map a stable API error code to the translated message. */
function explain(code) {
  const map = {
    wrong_current: t("core.err.wrongCurrent", "The current password is not correct."),
    weak: t("core.err.passwordShort", "The new password must be at least 8 characters."),
    taken: t("core.err.usernameTaken", "That username is already in use."),
    invalid: t("core.err.usernameInvalid", "That username is not allowed."),
  };
  return map[code] || code;
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "account-password") {
    const cur = document.querySelector("#acc-cur")?.value ?? "";
    const next = document.querySelector("#acc-new")?.value ?? "";
    const confirm = document.querySelector("#acc-confirm")?.value ?? "";
    if (next !== confirm) {
      await alertDialog({ title: t("core.account.changePassword", "Change password"), description: t("core.msg.passwordMismatch", "The new passwords do not match.") });
      return;
    }
    try {
      const d = await api("auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: cur, new_password: next }) });
      if (d.error) { await alertDialog({ title: t("core.account.changePassword", "Change password"), description: explain(d.error) }); return; }
      toast(t("core.msg.passwordChanged", "Password changed."));
      document.querySelector("#acc-cur").value = "";
      document.querySelector("#acc-new").value = "";
      document.querySelector("#acc-confirm").value = "";
    } catch (err) { await alertDialog({ title: t("core.account.changePassword", "Change password"), description: explain(err.message) }); }
    return;
  }

  if (btn.dataset.action === "account-username") {
    const wanted = document.querySelector("#acc-user")?.value?.trim() ?? "";
    const cur = document.querySelector("#acc-user-cur")?.value ?? "";
    try {
      const d = await api("auth/username", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: wanted, current_password: cur }) });
      if (d.error) { await alertDialog({ title: t("core.account.changeUsername", "Change username"), description: explain(d.error) }); return; }
      toast(t("core.msg.usernameChanged", "Username changed."));
      document.querySelector("#acc-user-cur").value = "";
      render();
    } catch (err) { await alertDialog({ title: t("core.account.changeUsername", "Change username"), description: explain(err.message) }); }
    return;
  }
});
