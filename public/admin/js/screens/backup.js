/**
 * Screen: Site Backup & Restore.
 *
 * Full-site data backup, pre-flight safety inspection, merge/clean restoration,
 * and point-in-time rollback snapshots.
 */
import { api, scoped, state } from "../state.js";
import { pageHead, render } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, confirmDialog, emptyRow, esc, fmtDate, toast } from "../../ui.js";
import { t } from "../i18n.js";

/** Transient state for the currently inspected file */
let inspectState = null;

function renderStatsBadge(label, incCount, curCount) {
  return `
    <div style="background:var(--background);border:1px solid var(--border);border-radius:var(--radius-md);padding:.75rem 1rem;flex:1;min-width:140px">
      <div class="muted text-sm" style="margin-bottom:.25rem">${esc(label)}</div>
      <div style="display:flex;align-items:baseline;gap:.5rem">
        <span style="font-size:1.25rem;font-weight:700;color:var(--foreground)">+${incCount}</span>
        <span class="muted text-sm">/ ${esc(t("core.backup.currentStats", "current"))} ${curCount}</span>
      </div>
    </div>`;
}

export default async function backup(c) {
  const site = state.sites.find((s) => s.id === state.site);
  let snapshots = [];

  try {
    const snapRes = await api(scoped("backup/snapshots"));
    snapshots = Array.isArray(snapRes?.items) ? snapRes.items : [];
  } catch {
    snapshots = [];
  }

  const snapshotRows = snapshots.length === 0
    ? emptyRow(5, t("core.backup.noSnapshots", "No snapshots yet. Snapshots are created automatically before restore, or you can create one manually."))
    : snapshots.map((s) => {
        let sum = {};
        try {
          sum = typeof s.summary === "string" ? JSON.parse(s.summary) : (s.summary || {});
        } catch {
          sum = {};
        }

        const isPreRestore = s.trigger_type === "pre_restore";
        const triggerBadge = isPreRestore
          ? `<span class="badge warn">${icon("history")}${esc(t("core.backup.triggerPreRestore", "Pre-restore Auto"))}</span>`
          : `<span class="badge success">${icon("check")}${esc(t("core.backup.triggerManual", "Manual"))}</span>`;

        const summaryBadges = `
          <div style="display:flex;flex-wrap:wrap;gap:.35rem">
            <span class="badge outline" title="${esc(t("core.backup.statPosts", "Posts"))}">${sum.posts ?? 0} ${esc(t("core.nav.posts", "Posts"))}</span>
            <span class="badge outline" title="${esc(t("core.backup.statTerms", "Terms"))}">${sum.terms ?? 0} ${esc(t("core.nav.tags", "Tags"))}</span>
            <span class="badge outline" title="${esc(t("core.backup.statMenus", "Menus"))}">${sum.menus ?? 0} ${esc(t("core.nav.menus", "Menus"))}</span>
            <span class="badge outline" title="${esc(t("core.backup.statWidgets", "Widgets"))}">${sum.widgets ?? 0} ${esc(t("core.nav.widgets", "Widgets"))}</span>
          </div>`;

        return `
          <tr data-snapshot-id="${attr(s.id)}">
            <td style="font-weight:600">
              <div style="display:flex;align-items:center;gap:.5rem">
                ${icon("history")}
                <span>${esc(s.name || s.id)}</span>
              </div>
            </td>
            <td>${triggerBadge}</td>
            <td class="text-sm muted">${esc(fmtDate(s.created_at))}</td>
            <td>${summaryBadges}</td>
            <td>
              <div style="display:flex;gap:.5rem;justify-content:flex-end">
                <button class="btn outline sm" data-snapshot-rollback="${attr(s.id)}" data-snapshot-name="${attr(s.name || s.id)}">
                  ${icon("history")}${esc(t("core.backup.rollbackBtn", "Rollback"))}
                </button>
                <button class="btn outline sm" data-snapshot-download="${attr(s.id)}" title="${attr(t("core.backup.downloadSnapshot", "Download"))}">
                  ${icon("download")}
                </button>
                <button class="btn outline sm destructive" data-snapshot-delete="${attr(s.id)}" data-snapshot-name="${attr(s.name || s.id)}" title="${attr(t("core.backup.deleteSnapshot", "Delete"))}">
                  ${icon("trash")}
                </button>
              </div>
            </td>
          </tr>`;
      }).join("");

  // Inspection section HTML
  let inspectHtml = "";
  if (inspectState && inspectState.report) {
    const r = inspectState.report;
    const inc = r.incoming || {};
    const cur = r.current || {};
    const src = r.source || {};

    inspectHtml = `
      <div class="panel" style="margin-top:1.25rem;border-color:var(--primary);background:var(--card)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem">
          <div>
            <div class="card-title" style="display:flex;align-items:center;gap:.5rem">
              ${icon("circle-check")}
              <span>${esc(t("core.backup.inspectResult", "Pre-flight Inspection Report"))}</span>
            </div>
            <div class="muted text-sm" style="margin-top:.25rem">
              ${esc(t("core.backup.sourceSite", "Source Site"))}: <b>${esc(src.site_id || "unknown")}</b> · 
              ${esc(t("core.backup.exportedAt", "Exported At"))}: <b>${esc(src.exported_at ? fmtDate(src.exported_at) : "—")}</b> · 
              ${esc(t("core.backup.payloadVersion", "Version"))}: <code>v${esc(src.version || 1)}</code>
            </div>
          </div>
          <button class="btn outline sm" data-backup-cancel-inspect>
            ${icon("x")}${esc(t("core.action.cancel", "Cancel"))}
          </button>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem">
          ${renderStatsBadge(t("core.backup.statPosts", "Posts & Pages"), inc.posts || 0, cur.posts || 0)}
          ${renderStatsBadge(t("core.backup.statTerms", "Taxonomies & Terms"), (inc.taxonomies || 0) + (inc.terms || 0), (cur.taxonomies || 0) + (cur.terms || 0))}
          ${renderStatsBadge(t("core.backup.statMenus", "Menus & Items"), (inc.menus || 0) + (inc.menu_items || 0), (cur.menus || 0) + (cur.menu_items || 0))}
          ${renderStatsBadge(t("core.backup.statWidgets", "Widgets"), inc.widgets || 0, cur.widgets || 0)}
          ${renderStatsBadge(t("core.backup.statSettings", "Settings"), inc.settings || 0, cur.settings || 0)}
          ${renderStatsBadge(t("core.backup.statMedia", "Media Records"), inc.media || 0, cur.media || 0)}
        </div>

        <div style="border-top:1px solid var(--border);padding-top:1rem;margin-bottom:1.25rem">
          <label style="font-weight:600;display:block;margin-bottom:.5rem">${esc(t("core.backup.modeLabel", "Restore Mode"))}</label>
          <div style="display:flex;flex-direction:column;gap:.5rem">
            <label style="display:flex;align-items:flex-start;gap:.5rem;cursor:pointer">
              <input type="radio" name="restore-mode" value="merge" checked style="margin-top:.25rem">
              <div>
                <div style="font-weight:600">${esc(t("core.backup.modeMerge", "Smart Merge (Keep existing, update/insert backup items)"))}</div>
              </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:.5rem;cursor:pointer">
              <input type="radio" name="restore-mode" value="clean" style="margin-top:.25rem">
              <div>
                <div style="font-weight:600;color:var(--destructive)">${esc(t("core.backup.modeClean", "Clean Overwrite (Clear all existing site content before restore)"))}</div>
              </div>
            </label>
          </div>
        </div>

        <div style="margin-bottom:1.25rem">
          <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
            <input type="checkbox" id="backup-auto-snapshot" checked>
            <span style="font-weight:500">${esc(t("core.backup.autoSnapshot", "Create automatic safety snapshot before restore (Recommended)"))}</span>
          </label>
        </div>

        <div style="display:flex;gap:1rem;align-items:center">
          <button class="btn primary" data-backup-start-restore>
            ${icon("history")}${esc(t("core.backup.startRestore", "Start Restore"))}
          </button>
        </div>
      </div>`;
  }

  c.innerHTML = `
    ${pageHead({
      title: t("core.backup.title", "Site Backup & Restore"),
      sub: `${t("core.backup.subtitle", "Export complete site data, inspect or restore backups, and manage rollback snapshots.")} · ${esc(site?.name || state.site)}`,
      crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.backup.title", "Backup & Restore") }],
    })}

    <!-- Row 1: Export Card -->
    <div class="panel" style="margin-bottom:1.5rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem">
        <div style="flex:1;min-width:280px">
          <div class="card-title" style="display:flex;align-items:center;gap:.5rem">
            ${icon("download")}
            <span>${esc(t("core.backup.exportTitle", "Export Full Backup"))}</span>
          </div>
          <div class="card-desc" style="margin-top:.35rem">
            ${esc(t("core.backup.exportDesc", "Download a complete JSON backup containing all posts, pages, terms, taxonomies, menus, widgets, redirects, rewrites, settings, and media metadata for this site."))}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.75rem">
            <span class="badge secondary">${icon("file-text")}${esc(t("core.backup.statPosts", "Posts & Pages"))}</span>
            <span class="badge secondary">${icon("layers")}${esc(t("core.backup.statTerms", "Taxonomies & Terms"))}</span>
            <span class="badge secondary">${icon("menu")}${esc(t("core.backup.statMenus", "Menus"))}</span>
            <span class="badge secondary">${icon("package")}${esc(t("core.backup.statWidgets", "Widgets"))}</span>
            <span class="badge secondary">${icon("settings")}${esc(t("core.backup.statSettings", "Settings"))}</span>
            <span class="badge secondary">${icon("image")}${esc(t("core.backup.statMedia", "Media Records"))}</span>
            <span class="badge secondary">${icon("route")}${esc(t("core.backup.statSeo", "SEO & Rewrites"))}</span>
          </div>
        </div>
        <button class="btn primary" data-backup-export style="align-self:center">
          ${icon("download")}${esc(t("core.backup.exportBtn", "Export Backup File (.json)"))}
        </button>
      </div>
    </div>

    <!-- Row 2: Restore & Inspector Card -->
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="card-title" style="display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem">
        ${icon("upload")}
        <span>${esc(t("core.backup.restoreTitle", "Restore & Pre-flight Inspection"))}</span>
      </div>
      <div class="card-desc" style="margin-bottom:1rem">
        ${esc(t("core.backup.restoreDesc", "Upload a CFPress site backup JSON file to inspect contents and restore to current site."))}
      </div>

      <div id="backup-drop-zone" style="border:2px dashed var(--border);border-radius:var(--radius-lg);padding:2rem 1.5rem;text-align:center;background:var(--background);cursor:pointer;transition:all .2s ease">
        <div style="margin-bottom:.5rem;color:var(--muted-foreground)">${icon("upload", 'style="width:36px;height:36px"')}</div>
        <div style="font-weight:600;margin-bottom:.25rem">${esc(t("core.backup.dropZone", "Drag & drop backup JSON file here, or click to select"))}</div>
        <div class="muted text-sm">.json files supported</div>
        <input type="file" id="backup-file-input" accept=".json,application/json" hidden>
      </div>

      ${inspectHtml}
    </div>

    <!-- Row 3: Snapshots Table -->
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;flex-wrap:wrap;gap:1rem">
        <div>
          <div class="card-title" style="display:flex;align-items:center;gap:.5rem">
            ${icon("history")}
            <span>${esc(t("core.backup.snapshotsTitle", "Local Rollback Snapshots"))}</span>
          </div>
          <div class="card-desc" style="margin-top:.25rem">
            ${esc(t("core.backup.snapshotsDesc", "Point-in-time snapshots stored in D1 database for instant 1-click recovery."))}
          </div>
        </div>
        <button class="btn outline sm" data-backup-create-snapshot>
          ${icon("plus")}${esc(t("core.backup.createSnapshot", "Create Safety Snapshot"))}
        </button>
      </div>

      <div class="table-wrap"><table class="table">
        <thead>
          <tr>
            <th>${esc(t("core.backup.snapshotsTitle", "Snapshot Name"))}</th>
            <th>${esc(t("core.backup.type", "Type"))}</th>
            <th>${esc(t("core.backup.date", "Date"))}</th>
            <th>${esc(t("core.backup.incomingStats", "Summary"))}</th>
            <th style="text-align:right">${esc(t("core.action.edit", "Actions"))}</th>
          </tr>
        </thead>
        <tbody>
          ${snapshotRows}
        </tbody>
      </table></div>
    </div>`;

  // Wire drop zone
  const dropZone = c.querySelector("#backup-drop-zone");
  const fileInput = c.querySelector("#backup-file-input");

  if (dropZone && fileInput) {
    dropZone.onclick = () => fileInput.click();

    dropZone.ondragover = (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "var(--primary)";
      dropZone.style.background = "var(--card)";
    };

    dropZone.ondragleave = () => {
      dropZone.style.borderColor = "var(--border)";
      dropZone.style.background = "var(--background)";
    };

    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "var(--border)";
      dropZone.style.background = "var(--background)";
      const file = e.dataTransfer?.files?.[0];
      if (file) handleBackupFile(file);
    };

    fileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) handleBackupFile(file);
    };
  }
}

/** Parse and inspect a dropped or selected backup JSON file */
async function handleBackupFile(file) {
  try {
    toast(t("core.backup.inspecting", "Inspecting backup file..."));
    const text = await file.text();
    const payload = JSON.parse(text);

    const report = await api(scoped("backup/inspect"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    inspectState = { file, payload, report };
    render();
  } catch (err) {
    toast(err.message || "Failed to parse backup JSON file", "error");
  }
}

/** Trigger browser file download from JSON payload */
function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Delegated event listeners
// ---------------------------------------------------------------------------

document.addEventListener("click", async (e) => {
  // 1. One-click Export
  const exportBtn = e.target.closest("[data-backup-export]");
  if (exportBtn) {
    exportBtn.disabled = true;
    toast(t("core.backup.exporting", "Exporting backup..."));
    try {
      const data = await api(scoped("backup/export"), { method: "POST" });
      const nowStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = data.filename || `cfpress-backup-${state.site}-${nowStr}.json`;
      const payload = data.backup || data;
      downloadJsonFile(filename, payload);
      toast(t("core.backup.exportBtn", "Export completed!"));
    } catch (err) {
      toast(err.message || "Export failed", "error");
    } finally {
      exportBtn.disabled = false;
    }
    return;
  }

  // 2. Cancel Inspection
  const cancelInspect = e.target.closest("[data-backup-cancel-inspect]");
  if (cancelInspect) {
    inspectState = null;
    render();
    return;
  }

  // 3. Start Restore
  const startRestore = e.target.closest("[data-backup-start-restore]");
  if (startRestore && inspectState) {
    const modeEl = document.querySelector('input[name="restore-mode"]:checked');
    const autoSnapEl = document.querySelector("#backup-auto-snapshot");
    const mode = modeEl?.value || "merge";
    const autoSnapshot = autoSnapEl ? autoSnapEl.checked : true;

    if (mode === "clean") {
      const ok = await confirmDialog({
        title: t("core.backup.modeClean", "Clean Overwrite Warning"),
        description: t("core.backup.confirmClean", "WARNING: Clean overwrite will permanently delete existing posts, pages, categories, menus, and widgets on this site before restoring. Are you sure you want to proceed?"),
        confirmLabel: t("core.action.delete", "Overwrite & Restore"),
      });
      if (!ok) return;
    }

    startRestore.disabled = true;
    toast(t("core.backup.restoring", "Restoring data..."));
    try {
      await api(scoped("backup/restore"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: inspectState.payload,
          options: { mode, autoSnapshot },
        }),
      });
      toast(t("core.backup.restoreSuccess", "Site data restored successfully!"));
      inspectState = null;
      render();
    } catch (err) {
      toast(err.message || "Restore failed", "error");
      startRestore.disabled = false;
    }
    return;
  }

  // 4. Create Manual Snapshot
  const createSnapBtn = e.target.closest("[data-backup-create-snapshot]");
  if (createSnapBtn) {
    const defaultName = `Snapshot ${new Date().toLocaleTimeString()}`;
    const name = window.prompt(t("core.backup.snapshotNamePlaceholder", "Snapshot name or description (optional)"), defaultName);
    if (name === null) return;

    createSnapBtn.disabled = true;
    toast(t("core.backup.creatingSnapshot", "Creating snapshot..."));
    try {
      await api(scoped("backup/snapshots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || defaultName, trigger_type: "manual" }),
      });
      toast(t("core.backup.snapshotsTitle", "Snapshot created successfully!"));
      render();
    } catch (err) {
      toast(err.message || "Failed to create snapshot", "error");
    } finally {
      createSnapBtn.disabled = false;
    }
    return;
  }

  // 5. Rollback Snapshot
  const rollbackBtn = e.target.closest("[data-snapshot-rollback]");
  if (rollbackBtn) {
    const id = rollbackBtn.dataset.snapshotRollback;
    const name = rollbackBtn.dataset.snapshotName || id;

    const ok = await confirmDialog({
      title: t("core.backup.rollbackBtn", "Rollback"),
      description: t("core.backup.confirmRollback", "Roll back current site to snapshot \"{name}\"? Current unsaved changes may be overwritten.", { name }),
      confirmLabel: t("core.backup.rollbackBtn", "Rollback"),
    });
    if (!ok) return;

    rollbackBtn.disabled = true;
    toast(t("core.backup.rollingBack", "Rolling back..."));
    try {
      await api(scoped(`backup/snapshots/${id}/restore`), { method: "POST" });
      toast(t("core.backup.rollbackSuccess", "Site rolled back to snapshot successfully!"));
      render();
    } catch (err) {
      toast(err.message || "Rollback failed", "error");
      rollbackBtn.disabled = false;
    }
    return;
  }

  // 6. Download Snapshot
  const downloadBtn = e.target.closest("[data-snapshot-download]");
  if (downloadBtn) {
    const id = downloadBtn.dataset.snapshotDownload;
    try {
      const snap = await api(scoped(`backup/snapshots/${id}/download`));
      const payload = typeof snap.data === "string" ? JSON.parse(snap.data) : snap.data;
      const filename = `snapshot-${state.site}-${id}.json`;
      downloadJsonFile(filename, payload);
    } catch (err) {
      toast(err.message || "Failed to download snapshot", "error");
    }
    return;
  }

  // 7. Delete Snapshot
  const deleteBtn = e.target.closest("[data-snapshot-delete]");
  if (deleteBtn) {
    const id = deleteBtn.dataset.snapshotDelete;
    const name = deleteBtn.dataset.snapshotName || id;

    const ok = await confirmDialog({
      title: t("core.backup.deleteSnapshot", "Delete Snapshot"),
      description: t("core.backup.confirmDeleteSnapshot", "Are you sure you want to delete this snapshot?"),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!ok) return;

    try {
      await api(scoped(`backup/snapshots/${id}`), { method: "DELETE" });
      toast(t("core.backup.deleteSnapshot", "Snapshot deleted"));
      render();
    } catch (err) {
      toast(err.message || "Failed to delete snapshot", "error");
    }
    return;
  }
});
