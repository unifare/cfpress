/**
 * Screen: AI & API Keys — Developer & AI Agent open platform console.
 *
 * Provides:
 *   1. OpenAPI 3.1 live gateway status & schema links.
 *   2. Machine-to-machine API key creation, site/scope boundaries & revocation.
 *   3. Interactive code examples (cURL, JS, Python) for AI Agents (Cursor, Dify, Claude).
 *   4. Full English and Chinese (zh-CN) localization via t().
 */
import { api, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { alertDialog, confirmDialog, emptyRow, esc, fmtDate, fmtRelative, openDialog, toast } from "../../ui.js";
import { t } from "../i18n.js";

export default async function apiKeys(c) {
  let keys = [];
  try {
    const res = await api("auth/api-keys");
    keys = Array.isArray(res?.items) ? res.items : Array.isArray(res?.keys) ? res.keys : [];
  } catch {
    keys = [];
  }

  const activeSiteName = state.sites.find((s) => s.id === state.site)?.name || state.site || "default";
  const openApiUrl = `${window.CFP_ADMIN_BASE ? window.CFP_ADMIN_BASE.replace(/\/admin.*$/, "") : ""}/api/v1/openapi.json`;

  const hostOrigin = (typeof location !== "undefined" && location.origin) ? location.origin : "http://localhost";
  const rows = keys.length === 0
    ? emptyRow(6, t("core.apiKeys.noKeys", "No API keys created yet."))
    : keys.map((k) => {
        const sitesList = Array.isArray(k.sites) && !k.sites.includes("*") ? k.sites.join(", ") : t("core.apiKeys.allSites", "All sites (*)");
        const scopesList = Array.isArray(k.scopes) && !k.scopes.includes("*") ? k.scopes.join(", ") : t("core.apiKeys.allPermissions", "Full access (*)");
        return `
        <tr>
          <td style="font-weight:600">
            <div style="display:flex;align-items:center;gap:.5rem">
              ${icon("key-round")}
              <span>${esc(k.name)}</span>
            </div>
          </td>
          <td><code style="font-size:.85rem;background:var(--accent);padding:.2rem .4rem;border-radius:var(--radius)">${esc(k.key_prefix || k.keyPrefix)}...</code></td>
          <td><span class="badge outline">${esc(sitesList)}</span></td>
          <td><span class="badge secondary">${esc(scopesList)}</span></td>
          <td>${esc(fmtDate(k.created_at || k.createdAt))}</td>
          <td>${esc(k.last_used_at ? fmtRelative(k.last_used_at) : t("core.apiKeys.neverUsed", "Never"))}</td>
          <td style="text-align:right">
            <button class="btn outline sm danger" data-action="revoke-api-key" data-id="${esc(k.id)}" data-name="${esc(k.name)}">
              ${icon("trash")}${esc(t("core.action.revoke", "Revoke"))}
            </button>
          </td>
        </tr>`;
      }).join("");

  c.innerHTML = `${pageHead({
    title: t("core.apiKeys.title", "AI & API Keys"),
    sub: t("core.apiKeys.sub", "Create API keys for AI assistants, agents, or remote scripts to access CFPress APIs."),
    crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.apiKeys.title", "AI & API Keys") }],
  })}
  
  <div style="display:flex;flex-direction:column;gap:1.5rem">
    <!-- Top Open Gateway Status Banner -->
    <div class="panel" style="background:var(--card);border:1px solid var(--border)">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:1rem">
        <div style="display:flex;align-items:center;gap:.75rem">
          <div style="width:2.5rem;height:2.5rem;border-radius:var(--radius);background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center">
            ${icon("sparkles")}
          </div>
          <div>
            <div style="font-weight:600;font-size:1rem;display:flex;align-items:center;gap:.5rem">
              <span>${esc(t("core.apiKeys.gatewayTitle", "OpenAPI 3.1 REST API Gateway"))}</span>
              <span class="badge success">${esc(t("core.apiKeys.statusActive", "Live & Ready"))}</span>
            </div>
            <div class="muted text-sm" style="margin-top:.25rem">
              ${esc(t("core.apiKeys.gatewayDesc", "Standardized REST API with Bearer token authentication. Ready for Cursor, Claude, GPTs, and Dify integrations."))}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:.5rem;align-items:center">
          <button class="btn outline sm" data-action="copy-openapi-url" data-url="${esc(openApiUrl)}">
            ${icon("copy")}${esc(t("core.apiKeys.copyUrl", "Copy OpenAPI URL"))}
          </button>
          <a class="btn outline sm" href="${openApiUrl}" target="_blank" rel="noopener">
            ${icon("external")}${esc(t("core.apiKeys.viewOpenApi", "View OpenAPI Spec"))}
          </a>
        </div>
      </div>
    </div>

    <!-- API Keys Management Table -->
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <div>
          <h2 style="font-size:1rem;font-weight:600;margin:0 0 .25rem">${esc(t("core.apiKeys.tableTitle", "Active API Keys"))}</h2>
          <div class="muted text-sm">${esc(t("core.apiKeys.tableSub", "Manage programmatic access tokens and scope restrictions."))}&nbsp;(${esc(keys.length)} ${esc(t("core.apiKeys.totalKeys", "total"))})</div>
        </div>
        <button class="btn primary" data-action="new-api-key">
          ${icon("plus")}${esc(t("core.apiKeys.createBtn", "Create Key"))}
        </button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>${esc(t("core.apiKeys.name", "Name"))}</th>
              <th>${esc(t("core.apiKeys.prefix", "Prefix"))}</th>
              <th>${esc(t("core.apiKeys.sites", "Allowed Sites"))}</th>
              <th>${esc(t("core.apiKeys.scopes", "Scopes"))}</th>
              <th>${esc(t("core.apiKeys.created", "Created"))}</th>
              <th>${esc(t("core.apiKeys.lastUsed", "Last used"))}</th>
              <th style="width:5rem;text-align:right">${esc(t("core.action.actions", "Actions"))}</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Integration Examples and Quick Guide -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(28rem, 1fr));gap:1.5rem">
      <div class="panel">
        <h3 style="font-size:.95rem;font-weight:600;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem">
          ${icon("code")}${esc(t("core.apiKeys.quickStartTitle", "Quick API Call Example (cURL)"))}
        </h3>
        <p class="muted text-sm" style="margin-bottom:.75rem">
          ${esc(t("core.apiKeys.quickStartSub", "Pass your API Key in the Authorization header to call any authorized CFPress API:"))}
        </p>
        <pre style="background:var(--accent);padding:1rem;border-radius:var(--radius);overflow-x:auto;font-size:.85rem;line-height:1.4"><code># 1. ${esc(t("core.apiKeys.exampleAuthMe", "Verify Identity"))}
curl -X GET "${esc(hostOrigin)}/api/v1/auth/me" \\
  -H "Authorization: Bearer cfp_live_YOUR_KEY"

# 2. ${esc(t("core.apiKeys.exampleListPosts", "List Posts for Site"))} "${esc(activeSiteName)}"
curl -X GET "${esc(hostOrigin)}/api/v1/posts?site=${esc(state.site || "default")}" \\
  -H "Authorization: Bearer cfp_live_YOUR_KEY"</code></pre>
      </div>

      <div class="panel">
        <h3 style="font-size:.95rem;font-weight:600;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem">
          ${icon("sparkles")}${esc(t("core.apiKeys.agentGuideTitle", "AI Agent Setup (Cursor / Dify / Claude)"))}
        </h3>
        <ul style="padding-left:1.25rem;font-size:.875rem;color:var(--muted-foreground);display:flex;flex-direction:column;gap:.6rem;line-height:1.4">
          <li>
            <strong style="color:var(--foreground)">Cursor / Windsurf (.cursorrules):</strong><br>
            ${esc(t("core.apiKeys.cursorHint", "Add the OpenAPI Spec URL to your AI instructions. The agent can query posts, create content, or deploy themes directly."))}
          </li>
          <li>
            <strong style="color:var(--foreground)">Dify / FastGPT Custom Tool:</strong><br>
            ${esc(t("core.apiKeys.difyHint", "Import /api/v1/openapi.json in Dify Tools, select 'Bearer' auth with your API Key, and your AI workflow can publish posts automatically."))}
          </li>
          <li>
            <strong style="color:var(--foreground)">Custom GPTs / Claude Projects:</strong><br>
            ${esc(t("core.apiKeys.gptsHint", "Paste /api/v1/openapi.json into Custom Actions. Set Authentication to Bearer with your secret key."))}
          </li>
        </ul>
      </div>
    </div>
  </div>`;
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "copy-openapi-url") {
    const url = btn.dataset.url || "";
    try {
      await navigator.clipboard.writeText(url);
      toast(t("core.apiKeys.copiedToast", "OpenAPI URL copied to clipboard!"));
    } catch {
      prompt(t("core.apiKeys.copyManual", "Copy OpenAPI URL:"), url);
    }
    return;
  }

  if (btn.dataset.action === "new-api-key") {
    const siteOptions = [
      { value: "*", label: t("core.apiKeys.allSites", "All sites (*)") },
      ...state.sites.map((s) => ({ value: s.id, label: `${s.name || s.id} (${s.id})` })),
    ];

    const scopeOptions = [
      { value: "*", label: t("core.apiKeys.allPermissions", "Full access (*)") },
      { value: "posts.read", label: t("core.apiKeys.scopeReadPosts", "Read Posts Only (posts.read)") },
      { value: "posts.write", label: t("core.apiKeys.scopeWritePosts", "Write & Publish Posts (posts.write)") },
    ];

    const vals = await openDialog({
      title: t("core.apiKeys.createTitle", "Create API Key"),
      description: t("core.apiKeys.createSub", "Generate an API Key for an external AI Agent or integration."),
      fields: [
        { name: "name", label: t("core.apiKeys.keyName", "Key name"), placeholder: "e.g. Cursor / Claude / Dify", required: true },
        { name: "site", label: t("core.apiKeys.siteScope", "Site Scope"), type: "select", options: siteOptions, value: "*" },
        { name: "scope", label: t("core.apiKeys.permissionScope", "Permissions"), type: "select", options: scopeOptions, value: "*" },
      ],
      confirmLabel: t("core.action.create", "Create"),
    });
    if (!vals || !vals.name) return;

    try {
      const sites = vals.site === "*" ? ["*"] : [vals.site];
      const scopes = vals.scope === "*" ? ["*"] : [vals.scope];

      const res = await api("auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: vals.name, sites, scopes }),
      });
      if (res.error) {
        await alertDialog({ title: t("core.apiKeys.createTitle", "Create API Key"), description: res.error });
        return;
      }
      const token = res.token || res.key?.token || "";
      await openDialog({
        title: t("core.apiKeys.createdTitle", "API Key Created"),
        description: t("core.apiKeys.createdHint", "Copy your API key now. You will not be able to see it again!"),
        confirmLabel: t("core.action.ok", "OK"),
        fields: [],
        bodyHtml: `
          <div style="margin:1rem 0">
            <input type="text" readonly value="${esc(token)}" id="new-token-val" style="width:100%;font-family:monospace;padding:.6rem .75rem;background:var(--accent);border:1px solid var(--border);border-radius:var(--radius);font-size:.9rem;user-select:all" onclick="this.select()">
          </div>
          <div class="muted text-sm" style="color:var(--destructive)">
            ${esc(t("core.apiKeys.warningSecret", "Keep this secret safe. Do not commit it to public repositories or expose it client-side."))}
          </div>
        `,
      });
      render();
    } catch (err) {
      await alertDialog({ title: t("core.apiKeys.createTitle", "Create API Key"), description: err.message });
    }
    return;
  }

  if (btn.dataset.action === "revoke-api-key") {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const ok = await confirmDialog({
      title: t("core.apiKeys.revokeTitle", "Revoke API Key"),
      description: t("core.apiKeys.revokeConfirm", `Are you sure you want to revoke the key "${name}"? Any agent using it will immediately lose access.`),
      confirmLabel: t("core.action.revoke", "Revoke"),
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await api(`auth/api-keys/${id}`, { method: "DELETE" });
      if (res.error) {
        await alertDialog({ title: t("core.apiKeys.revokeTitle", "Revoke API Key"), description: res.error });
        return;
      }
      toast(t("core.apiKeys.revokedToast", "API key revoked."));
      render();
    } catch (err) {
      await alertDialog({ title: t("core.apiKeys.revokeTitle", "Revoke API Key"), description: err.message });
    }
    return;
  }
});
