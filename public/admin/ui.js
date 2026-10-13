/**
 * Admin UI kit — the reusable layer between the design tokens in admin.css
 * and the page screens in admin.js.
 *
 * Provides: theme switching (light/dark/system, persisted), a dialog service
 * replacing native prompt/confirm/alert, toasts, dropdown menus and small
 * render helpers. Everything here is framework-free.
 */
import { icon } from "./icons.js";
// The dictionary is a leaf (it imports nothing), so the UI kit can depend on it
// without creating a cycle — which is what lets the shared pieces below (status
// badges, dialog buttons, the empty-row default) be translated **once** for
// every screen instead of in each of the ten that use them.
import { t } from "./js/i18n.js";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = "cfpress.admin.theme";

/** "light" | "dark" | "system" — what the user picked. */
export function themePref() {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** The theme actually applied right now. A `pref` of `system` resolves via OS. */
export function resolvedTheme() {
  const p = themePref();
  if (p !== "system") return p;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme() {
  const dark = resolvedTheme() === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme();
  document.dispatchEvent(new CustomEvent("cfpress:theme"));
}

/** Keep "system" in sync when the OS preference changes mid-session. */
export function watchSystemTheme() {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themePref() === "system") {
      applyTheme();
      document.dispatchEvent(new CustomEvent("cfpress:theme"));
    }
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;

/**
 * Show a transient message. `kind` is "success" (default) or "error".
 * Replaces the old bare `.toast` div with a mounted host element.
 */
export function toast(msg, kind = "success") {
  let host = document.querySelector("#toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  const glyph = kind === "error" ? "circle-alert" : "circle-check";
  host.innerHTML = `<div class="toast${kind === "error" ? " error" : ""}">${icon(glyph)}<span>${escapeHtml(msg)}</span></div>`;
  const el = host.firstElementChild;
  el.style.display = "flex";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, 2600);
}

// ---------------------------------------------------------------------------
// Dialog service — replaces prompt / confirm / alert
// ---------------------------------------------------------------------------

let dialogHost = null;

function ensureDialogHost() {
  if (!dialogHost) {
    dialogHost = document.createElement("div");
    dialogHost.id = "dialog-host";
    document.body.appendChild(dialogHost);
  }
  return dialogHost;
}

function closeDialog() {
  if (dialogHost) dialogHost.innerHTML = "";
  document.body.style.overflow = "";
}

/**
 * Open a dialog. `fields` is an array of
 *   { name, label, value, type, placeholder, hint, required, options }
 * where `type` is text | password | number | textarea | select | checkbox.
 * Returns a Promise resolving to a values object, or null if cancelled.
 */
export function openDialog({ title, description = "", fields = [], confirmLabel = t("core.action.save", "Save"), danger = false, bodyHtml = "" }) {
  const host = ensureDialogHost();
  const fieldHtml = fields.map((f) => {
    const id = `dlg-${f.name}`;
    const req = f.required ? " req" : "";
    const hint = f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : "";
    let control;
    if (f.type === "textarea") {
      control = `<textarea id="${id}" name="${f.name}" placeholder="${attr(f.placeholder)}">${escapeHtml(f.value ?? "")}</textarea>`;
    } else if (f.type === "select") {
      control = `<select id="${id}" name="${f.name}">${(f.options ?? [])
        .map((o) => {
          const v = typeof o === "string" ? o : o.value;
          const l = typeof o === "string" ? o : o.label;
          return `<option value="${attr(v)}"${String(f.value ?? "") === String(v) ? " selected" : ""}>${escapeHtml(l)}</option>`;
        })
        .join("")}</select>`;
    } else if (f.type === "checkbox") {
      return `<div class="field"><label style="display:flex;align-items:center;gap:.5rem;font-weight:400">
        <input type="checkbox" id="${id}" name="${f.name}"${f.value ? " checked" : ""} style="width:1rem;min-height:0"> ${escapeHtml(f.label)}</label>${hint}</div>`;
    } else {
      control = `<input id="${id}" name="${f.name}" type="${f.type ?? "text"}" value="${attr(f.value ?? "")}" placeholder="${attr(f.placeholder)}">`;
    }
    return `<div class="field"><label for="${id}" class="${req.trim()}">${escapeHtml(f.label)}</label>${control}${hint}</div>`;
  }).join("");

  host.innerHTML = `<div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${attr(title)}">
      <h2>${escapeHtml(title)}</h2>
      ${description ? `<p class="dialog-desc">${escapeHtml(description)}</p>` : ""}
      ${bodyHtml}
      <form id="dlg-form" novalidate>${fieldHtml}</form>
      <div class="dialog-actions">
        <button class="btn outline" id="dlg-cancel" type="button">${escapeHtml(t("core.action.cancel", "Cancel"))}</button>
        <button class="btn ${danger ? "danger" : "primary"}" id="dlg-ok" type="button">${escapeHtml(confirmLabel)}</button>
      </div>
    </div></div>`;

  return new Promise((resolve) => {
    const overlay = host.querySelector(".overlay");
    const form = host.querySelector("#dlg-form");
    const done = (v) => { closeDialog(); resolve(v); };

    const submit = () => {
      const values = {};
      let bad = null;
      for (const f of fields) {
        if (f.type === "checkbox") {
          values[f.name] = form.querySelector(`[name="${f.name}"]`).checked;
          continue;
        }
        const el = form.querySelector(`[name="${f.name}"]`);
        const v = el.value.trim();
        if (f.required && !v) { bad = el; break; }
        values[f.name] = f.type === "number" ? (v === "" ? null : Number(v)) : v;
      }
      if (bad) {
        bad.focus();
        bad.style.borderColor = "var(--destructive)";
        return;
      }
      done(values);
    };

    host.querySelector("#dlg-ok").onclick = submit;
    host.querySelector("#dlg-cancel").onclick = () => done(null);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); submit(); }
    });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onEsc); done(null); }
    });

    const first = form.querySelector("input, textarea, select");
    if (first) first.focus();
  });
}

/** Yes/no confirmation — replaces `confirm()`. */
export async function confirmDialog({ title, description = "", confirmLabel = t("core.action.delete", "Delete"), danger = true }) {
  const host = ensureDialogHost();
  host.innerHTML = `<div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${attr(title)}">
      <h2>${escapeHtml(title)}</h2>
      ${description ? `<p class="dialog-desc">${escapeHtml(description)}</p>` : ""}
      <div class="dialog-actions">
        <button class="btn outline" id="dlg-cancel" type="button">${escapeHtml(t("core.action.cancel", "Cancel"))}</button>
        <button class="btn ${danger ? "danger" : "primary"}" id="dlg-ok" type="button">${escapeHtml(confirmLabel)}</button>
      </div>
    </div></div>`;
  return new Promise((resolve) => {
    const overlay = host.querySelector(".overlay");
    const done = (v) => { closeDialog(); resolve(v); };
    host.querySelector("#dlg-ok").onclick = () => done(true);
    host.querySelector("#dlg-cancel").onclick = () => done(false);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(false); });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onEsc); done(false); }
    });
    host.querySelector("#dlg-ok").focus();
  });
}

/** Informational dialog — replaces `alert()`. */
export async function alertDialog({ title, description = "", confirmLabel = t("core.action.ok", "OK") }) {
  const host = ensureDialogHost();
  host.innerHTML = `<div class="overlay">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${attr(title)}">
      <h2>${escapeHtml(title)}</h2>
      ${description ? `<p class="dialog-desc">${escapeHtml(description)}</p>` : ""}
      <div class="dialog-actions"><button class="btn primary" id="dlg-ok" type="button">${escapeHtml(confirmLabel)}</button></div>
    </div></div>`;
  return new Promise((resolve) => {
    const overlay = host.querySelector(".overlay");
    const done = () => { closeDialog(); resolve(true); };
    host.querySelector("#dlg-ok").onclick = done;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(); });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onEsc); done(); }
    });
    host.querySelector("#dlg-ok").focus();
  });
}

// ---------------------------------------------------------------------------
// Dropdown menus
// ---------------------------------------------------------------------------

let openMenu = null;

/** Close any open dropdown. Called on outside click and on navigation. */
export function closeMenus() {
  if (openMenu) { openMenu.hidden = true; openMenu = null; }
  document.querySelectorAll(".menu").forEach((m) => { m.hidden = true; });
}

/**
 * Toggle a dropdown by element id. Every dropdown is a `.dropdown` container
 * holding a `.menu`; only one stays open at a time.
 */
export function toggleMenu(id) {
  const menu = document.getElementById(id);
  if (!menu) return;
  const wasOpen = openMenu === menu;
  closeMenus();
  if (!wasOpen) {
    menu.hidden = false;
    openMenu = menu;
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown")) closeMenus();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/** Alias used throughout the page screens. */
export const esc = escapeHtml;

/** Escape a value for use inside a double-quoted HTML attribute. */
export function attr(s = "") {
  return escapeHtml(s);
}

/** Format a unix-seconds timestamp the way the admin displays dates. */
export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Relative time ("3h ago") for activity-style lists. */
export function fmtRelative(ts) {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(ts);
}

/** Map a content status to the badge style used in tables. */
export function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  const kind = s === "published" ? "success" : s === "draft" ? "secondary" : s === "scheduled" ? "warn" : s === "private" ? "outline" : "secondary";
  // The stored value is the lowercase identifier and stays that way — only the
  // label is translated, so no query ever depends on the interface language.
  const label = s ? t(`core.status.${s}`, s) : t("core.status.unknown", "Unknown");
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}

export function emptyRow(colspan, msg = t("core.msg.nothingHere", "Nothing here yet.")) {
  return `<tr><td colspan="${colspan}" class="empty">${escapeHtml(msg)}</td></tr>`;
}
