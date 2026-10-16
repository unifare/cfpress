/**
 * Screen: Theme Templates & Assets Manager
 *
 * Full management interface for theme templates, component parts, static
 * stylesheets, JavaScript, locales, and theme manifests.
 */
import { api, scoped, state } from "../state.js";
import { pageHead, go, render } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { alertDialog, confirmDialog, esc, attr, toast } from "../../ui.js";

let currentTheme = null;
let fileTree = [];
let activeFile = null;
let fileContent = "";
let isDirty = false;

export async function themeAssetsScreen(c, themeName) {
  if (!themeName) {
    c.innerHTML = `<div class="panel"><p class="muted">${esc(t("core.themes.noThemeSpecified", "No theme specified."))}</p></div>`;
    return;
  }

  currentTheme = themeName;
  let treeRes;
  try {
    treeRes = await api(scoped(`extensions/themes/${encodeURIComponent(themeName)}/files`));
  } catch (err) {
    c.innerHTML = `<div class="panel">
      <div class="top"><div class="card-title">${esc(t("core.msg.wentWrong", "Something went wrong"))}</div></div>
      <p class="muted">${esc(err.message)}</p>
      <button class="btn outline sm" style="margin-top:.75rem" data-theme-back>${icon("arrow-left")}${esc(t("core.themes.backToThemes", "Back to themes"))}</button>
    </div>`;
    return;
  }

  fileTree = treeRes.files || [];
  const isBundled = !!treeRes.bundled;

  // Select default file if none selected
  if (!activeFile || !fileTree.some((f) => f.path === activeFile.path)) {
    activeFile = fileTree.find((f) => f.path === "templates/home.html") ||
                 fileTree.find((f) => f.path === "templates/index.html") ||
                 fileTree[0] || null;
  }

  if (activeFile) {
    try {
      const fileData = await api(scoped(`extensions/themes/${encodeURIComponent(themeName)}/file?path=${encodeURIComponent(activeFile.path)}`));
      fileContent = fileData.content ?? "";
      isDirty = false;
    } catch {
      fileContent = "";
    }
  }

  renderLayout(c, treeRes, isBundled);
}

function renderLayout(c, themeInfo, isBundled) {
  const categories = {
    template: { label: t("core.themes.templates", "Templates"), items: [] },
    part: { label: t("core.themes.parts", "Parts"), items: [] },
    asset: { label: t("core.themes.assets", "Assets"), items: [] },
    lang: { label: t("core.themes.languages", "Languages"), items: [] },
    config: { label: t("core.themes.config", "Config"), items: [] },
    other: { label: t("core.themes.other", "Other"), items: [] },
  };

  for (const f of fileTree) {
    const cat = categories[f.type] || categories.other;
    cat.items.push(f);
  }

  const fileTreeHtml = Object.entries(categories)
    .filter(([, cat]) => cat.items.length > 0)
    .map(([key, cat]) => `
      <div style="margin-bottom:1rem">
        <div style="font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin-bottom:.35rem;padding:0 .5rem">
          ${esc(cat.label)} (${cat.items.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:1px">
          ${cat.items.map((item) => {
            const isActive = activeFile && activeFile.path === item.path;
            const sizeStr = item.size > 1024 ? `${(item.size / 1024).toFixed(1)} KB` : `${item.size} B`;
            const iconName = item.type === "template" ? "layout" : item.type === "part" ? "component" : item.type === "asset" ? "file-text" : item.type === "lang" ? "languages" : "settings";
            return `
              <button class="nav-item${isActive ? " active" : ""}" data-file-select="${attr(item.path)}" style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:.45rem .6rem;border-radius:var(--radius-sm);text-align:left;border:none;background:${isActive ? "var(--accent)" : "transparent"};cursor:pointer">
                <span style="display:flex;align-items:center;gap:.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${icon(iconName, 'style="width:.9rem;height:.9rem;flex-shrink:0"')}
                  <span style="font-size:.825rem;overflow:hidden;text-overflow:ellipsis">${esc(item.path.replace(/^templates\/|^langs\/|^assets\//, ""))}</span>
                </span>
                <span class="muted" style="font-size:.7rem;flex-shrink:0;margin-left:.5rem">${sizeStr}</span>
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `).join("");

  const headerActions = `
    <div style="display:flex;align-items:center;gap:.5rem">
      <button class="btn outline sm" data-theme-back>${icon("arrow-left")}${esc(t("core.themes.backToThemes", "Back"))}</button>
      <button class="btn outline sm" data-theme-export-zip="${attr(currentTheme)}">${icon("download")}${esc(t("core.themes.exportZip", "Export ZIP"))}</button>
      ${isBundled
        ? `<button class="btn primary sm" data-theme-clone="${attr(currentTheme)}">${icon("copy")}${esc(t("core.themes.duplicateToEdit", "Duplicate to edit"))}</button>`
        : `<button class="btn primary sm" data-file-new>${icon("plus")}${esc(t("core.themes.newFile", "New File"))}</button>`}
    </div>
  `;

  c.innerHTML = `
    ${pageHead({
      title: `${esc(themeInfo.title || currentTheme)} (${esc(currentTheme)})`,
      sub: isBundled
        ? t("core.themes.bundledReadOnlyDesc", "Bundled theme (Read-only). Duplicate this theme to create a customizable copy.")
        : t("core.themes.customEditableDesc", "Custom theme stored in R2. You can directly edit templates, styles, and assets."),
      actions: headerActions,
      crumbs: [
        { label: t("core.nav.appearance", "Appearance") },
        { label: t("core.nav.themes", "Themes") },
        { label: esc(currentTheme) },
      ],
    })}

    <div style="display:grid;grid-template-columns:260px 1fr;gap:1.25rem;align-items:start;margin-top:1rem">
      <!-- Left sidebar: File Tree -->
      <div class="panel" style="padding:.75rem;max-height:calc(100vh - 12rem);overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;padding:0 .5rem">
          <span style="font-weight:600;font-size:.875rem">${esc(t("core.themes.files", "Files"))}</span>
          ${isBundled ? `<span class="badge warning" style="font-size:.65rem">${esc(t("core.themes.readOnly", "Read-only"))}</span>` : ""}
        </div>
        ${fileTreeHtml || `<div class="empty muted text-sm">${esc(t("core.themes.noFiles", "No files found"))}</div>`}
      </div>

      <!-- Right main area: Code Editor -->
      <div class="panel" style="padding:0;overflow:hidden;display:flex;flex-direction:column;min-height:550px">
        ${activeFile ? `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:.75rem 1.25rem;border-bottom:1px solid var(--border);background:var(--muted)">
            <div style="display:flex;align-items:center;gap:.6rem">
              <span style="font-family:monospace;font-size:.875rem;font-weight:600">${esc(activeFile.path)}</span>
              ${activeFile.readonly ? `<span class="badge warning">${esc(t("core.themes.readOnly", "Read-only"))}</span>` : ""}
            </div>
            <div style="display:flex;align-items:center;gap:.5rem">
              ${!activeFile.readonly ? `
                <button class="btn outline danger sm" data-file-delete="${attr(activeFile.path)}">${icon("trash")}${esc(t("core.action.delete", "Delete"))}</button>
                <button class="btn primary sm" data-file-save data-path="${attr(activeFile.path)}" id="btnSaveFile">${icon("check")}${esc(t("core.action.save", "Save"))} <span class="muted" style="font-size:.7rem">(Ctrl+S)</span></button>
              ` : `
                <button class="btn outline sm" data-theme-clone="${attr(currentTheme)}">${icon("copy")}${esc(t("core.themes.duplicateTheme", "Duplicate theme"))}</button>
              `}
            </div>
          </div>
          <div style="flex:1;position:relative">
            <textarea id="themeCodeEditor" data-path="${attr(activeFile.path)}" spellcheck="false" style="width:100%;height:100%;min-height:480px;border:none;outline:none;padding:1rem;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.875rem;line-height:1.5;background:transparent;color:inherit;resize:vertical;box-sizing:border-box">${esc(fileContent)}</textarea>
          </div>
        ` : `
          <div class="empty" style="padding:4rem;text-align:center;color:var(--muted-foreground)">
            ${esc(t("core.themes.selectFileToEdit", "Select a template or asset on the left to inspect or edit."))}
          </div>
        `}
      </div>
    </div>
  `;

  // Attach textarea event listeners
  const editor = document.querySelector("#themeCodeEditor");
  if (editor) {
    editor.addEventListener("input", () => {
      isDirty = true;
    });
    editor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActiveFile();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + "  " + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        isDirty = true;
      }
    });
  }
}

async function saveActiveFile() {
  const editor = document.querySelector("#themeCodeEditor");
  if (!editor) return;
  const filePath = editor.dataset.path || (activeFile && activeFile.path) || "";
  if (!filePath) {
    await alertDialog({
      title: t("core.themes.saveFailed", "Failed to save file"),
      description: t("core.themes.selectFileToEdit", "Select a template or asset on the left to inspect or edit."),
    });
    return;
  }
  if (activeFile && activeFile.readonly) return;

  const content = editor.value;
  try {
    await api(scoped(`extensions/themes/${encodeURIComponent(currentTheme)}/file`), {
      method: "PUT",
      body: { path: filePath, content },
    });
    fileContent = content;
    isDirty = false;
    toast(t("core.themes.fileSaved", "File saved successfully"));
  } catch (err) {
    await alertDialog({
      title: t("core.themes.saveFailed", "Failed to save file"),
      description: err.message,
    });
  }
}

document.addEventListener("click", async (e) => {
  // Back to Themes list
  if (e.target.closest("[data-theme-back]")) {
    go("appearance");
    return;
  }

  // Export Theme to ZIP
  const exp = e.target.closest("[data-theme-export-zip]");
  if (exp) {
    const name = exp.dataset.themeExportZip;
    window.open(scoped(`extensions/themes/${encodeURIComponent(name)}/export`));
    return;
  }

  // Duplicate Theme
  const cln = e.target.closest("[data-theme-clone]");
  if (cln) {
    const srcName = cln.dataset.themeClone;
    const defaultNewName = `${srcName}-copy`;
    const newName = window.prompt(t("core.themes.promptCloneName", "Enter identifier for the new theme (lowercase, numbers, hyphen):"), defaultNewName);
    if (!newName) return;
    let clean = (newName || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!clean || clean.length < 2) clean = `${srcName}-copy`;
    if (clean.length > 32) clean = clean.slice(0, 32);
    const newTitle = window.prompt(t("core.themes.promptCloneTitle", "Enter title for the new theme:"), `${srcName.toUpperCase()} Custom`);

    try {
      await api(scoped(`extensions/themes/${encodeURIComponent(srcName)}/copy`), {
        method: "POST",
        body: { name: clean, title: newTitle || clean },
      });
      toast(t("core.themes.clonedSuccess", "Theme duplicated successfully"));
      state.page = `theme-assets:${clean}`;
      render();
    } catch (err) {
      await alertDialog({
        title: t("core.themes.cloneFailed", "Failed to duplicate theme"),
        description: err.message,
      });
    }
    return;
  }

  // Select File in tree
  const sel = e.target.closest("[data-file-select]");
  if (sel) {
    const p = sel.dataset.fileSelect;
    if (activeFile && activeFile.path === p) return;
    if (isDirty) {
      const ok = await confirmDialog({
        title: t("core.themes.unsavedChangesTitle", "Unsaved changes"),
        description: t("core.themes.unsavedChangesDesc", "You have unsaved changes in this file. Switch anyway?"),
        confirmLabel: t("core.themes.switchAnyway", "Switch anyway"),
      });
      if (!ok) return;
    }
    activeFile = fileTree.find((f) => f.path === p) || null;
    isDirty = false;
    render();
    return;
  }

  // Save File button
  if (e.target.closest("[data-file-save]")) {
    await saveActiveFile();
    return;
  }

  // Delete File button
  const del = e.target.closest("[data-file-delete]");
  if (del) {
    const p = del.dataset.fileDelete;
    const ok = await confirmDialog({
      title: t("core.themes.deleteFileTitle", "Delete this file?"),
      description: t("core.themes.deleteFileDesc", "Are you sure you want to delete {path}?", { path: p }),
      confirmLabel: t("core.action.delete", "Delete"),
    });
    if (!ok) return;

    try {
      await api(scoped(`extensions/themes/${encodeURIComponent(currentTheme)}/file?path=${encodeURIComponent(p)}`), {
        method: "DELETE",
      });
      toast(t("core.themes.fileDeleted", "File deleted"));
      activeFile = null;
      render();
    } catch (err) {
      await alertDialog({
        title: t("core.themes.deleteFailed", "Failed to delete file"),
        description: err.message,
      });
    }
    return;
  }

  // New File button
  if (e.target.closest("[data-file-new]")) {
    const rel = window.prompt(t("core.themes.promptNewFilePath", "Enter new file path (e.g. templates/custom.html or assets/custom.css):"));
    if (!rel) return;
    const norm = rel.trim().replace(/^\/+/, "");
    const initContent = norm.endsWith(".html") ? "<!-- New Template -->\n<div class=\"custom-template\">\n  <h1>{{title}}</h1>\n</div>\n" : "";

    try {
      await api(scoped(`extensions/themes/${encodeURIComponent(currentTheme)}/file`), {
        method: "PUT",
        body: { path: norm, content: initContent },
      });
      toast(t("core.themes.fileCreated", "File created"));
      activeFile = { path: norm, size: initContent.length, type: "template", readonly: false };
      render();
    } catch (err) {
      await alertDialog({
        title: t("core.themes.createFailed", "Failed to create file"),
        description: err.message,
      });
    }
    return;
  }
});
