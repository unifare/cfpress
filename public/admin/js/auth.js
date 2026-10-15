/**
 * Admin SPA — authentication: the login screen, sign-in and sign-out.
 *
 * `render()` lives in the shell, which must not import this module (that would
 * be a cycle: auth needs `render`, the shell needs the login screen). So the
 * login screen is *injected* into the shell here, once, at import time.
 */
import { adminBase, api, app, loadContext, state } from "./state.js";
import { applyHash, render, setLoginScreen } from "./shell.js";
import { icon } from "../icons.js";
import { alertDialog, esc, setTheme } from "../ui.js";
import { loadMessages, t } from "./i18n.js";

export function renderLogin() {
  app.innerHTML = `<div class="login"><div class="loginbox">
    <span class="brand-mark">${icon("layers")}</span>
    <h1>${esc(t("core.auth.title", "Sign in to CFPress"))}</h1>
    <p class="muted">${esc(t("core.auth.subtitle", "Manage content, themes and sites."))}</p>
    <div class="login-shell">
      <div class="field"><label for="u">${esc(t("core.auth.username", "Username"))}</label><input id="u" value="admin" autocomplete="username"></div>
      <div class="field" style="margin-bottom:0"><label for="p">${esc(t("core.auth.password", "Password"))}</label><input id="p" type="password" value="change-me-now" autocomplete="current-password"></div>
    </div>
    <button class="btn primary" style="width:100%" id="signin">${esc(t("core.action.login", "Sign in"))}</button>
  </div></div>`;

  const submit = () => doLogin();
  app.querySelector("#signin").onclick = submit;
  app.querySelector("#p").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

export async function doLogin() {
  const u = document.querySelector("#u").value;
  const p = document.querySelector("#p").value;
  try {
    // ⚠️ Built from the injected base, not a literal. The login endpoint hangs
    // under the admin prefix (`/{admin.path}/api/v1/auth/login`) — the same
    // prefix `api()` uses — so a configurable prefix needs no special casing
    // here. The absolute `/api/v1/auth/login` was retired with batch C (404).
    const d = await fetch(`${adminBase}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
    // A 429 is the brute-force throttle, not bad credentials — say so, so the
    // operator waits instead of concluding their password is wrong.
    if (d.status === 429) throw new Error(t("core.auth.throttled", "Too many attempts. Wait a few minutes and try again."));
    if (!d.user) throw new Error(t("core.auth.invalid", "Invalid username or password."));
    state.user = d.user;
    // Menu labels are translated server-side and the shell strings client-side;
    // both must be loaded before the first post-login render.
    await Promise.all([loadContext(), loadMessages()]);
    // Not a bare `render()`: a deep link pasted to someone who then has to sign
    // in must still land on the page it names, not on the dashboard. The login
    // screen never touches the hash, so it is still there to be honoured.
    await applyHash();
  } catch (e) {
    await alertDialog({ title: t("core.auth.failed", "Sign-in failed"), description: e.message });
  }
}

export async function logout() {
  try { await api("auth/logout", { method: "POST" }); } catch { /* ignore */ }
  state.user = null;
  renderLogin();
}

/**
 * Force a theme without touching the UI. Used by the verification harness and
 * handy when debugging contrast; not linked from the interface.
 */
export function setThemeForTest(pref) {
  setTheme(pref);
}

document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="logout"]')) logout();
});

setLoginScreen(renderLogin);
