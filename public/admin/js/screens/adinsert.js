/**
 * Professional Ad Inserter Management Screen.
 *
 * Implements the full WordPress / DotnetCMS Ad Inserter experience:
 * - 16 Block tabs + Gear/Settings tab
 * - Dark code editor with one-click code presets (AdSense responsive, banner, etc.)
 * - Placement rules: Before/After Post, Content, Paragraphs, Header, Footer
 * - Alignment controls: Center, Float Left/Right, Left, Right
 * - Device targeting: Desktop, Mobile, Tablet, All
 * - Page type targeting: Posts, Pages, Homepage, Category
 * - Live preview simulation & instant save
 */
import { api, scoped, state } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { attr, esc, toast } from "../../ui.js";
import { currentLocale } from "../i18n.js";

const _t = (en, zh) => {
  const l = currentLocale();
  return l && l.toLowerCase().startsWith("zh") ? (zh || en) : en;
};

const TOTAL_BLOCKS = 16;

let currentTab = 1; // 1..16 or "settings"
let blocksData = []; // Array of block objects
let settingsData = {
  enabled: "1",
  min_paragraphs: "1",
  header_code: "",
  footer_code: "",
};
let isSaving = false;

let dirtyBlocks = new Set();

/** Initialize empty block slots (1 to 16) */
function makeDefaultBlock(blockNo) {
  return {
    block_no: blockNo,
    name: `Block ${blockNo}`,
    code: "",
    position: "disabled",
    paragraph_no: 1,
    alignment: "center",
    page_types: "posts",
    device: "all",
    enabled: 0,
  };
}

async function loadAdInsertData() {
  // Load blocks from theme-tables/blocks
  try {
    const res = await api(scoped("theme-tables/blocks?limit=100"));
    const items = Array.isArray(res?.items) ? res.items : [];
    
    blocksData = [];
    for (let i = 1; i <= TOTAL_BLOCKS; i++) {
      const canonicalSlug = `block-${i}`;
      // Robust matching: prioritize exact canonical slug 'block-N', then block_no
      const matches = items.filter((it) => it.slug === canonicalSlug || Number(it.block_no) === i);
      matches.sort((a, b) => {
        if (a.slug === canonicalSlug && b.slug !== canonicalSlug) return -1;
        if (b.slug === canonicalSlug && a.slug !== canonicalSlug) return 1;
        const timeA = Math.max(Number(a.updated_at) || 0, Number(a.created_at) || 0);
        const timeB = Math.max(Number(b.updated_at) || 0, Number(b.created_at) || 0);
        return timeB - timeA;
      });

      if (matches.length > 0) {
        const item = matches[0];
        blocksData.push({
          id: item.id,
          block_no: i,
          name: item.name || `Block ${i}`,
          code: item.code || "",
          position: item.position || "disabled",
          paragraph_no: Number(item.paragraph_no) || 1,
          alignment: item.alignment || "center",
          page_types: item.page_types || "posts",
          device: item.device || "all",
          enabled: Number(item.enabled) ? 1 : 0,
        });
      } else {
        blocksData.push(makeDefaultBlock(i));
      }
    }
  } catch {
    blocksData = Array.from({ length: TOTAL_BLOCKS }, (_, i) => makeDefaultBlock(i + 1));
  }

  // Load global plugin settings
  try {
    const s = await api("extensions/plugins/adinsert/settings");
    for (const row of s?.items ?? []) {
      const k = String(row.key ?? "");
      if (k in settingsData) settingsData[k] = row.value ?? "";
    }
  } catch {
    /* fallback defaults */
  }
}

function renderTabs() {
  const tabsHtml = [];
  for (let i = 1; i <= TOTAL_BLOCKS; i++) {
    const b = blocksData[i - 1];
    const isAct = currentTab === i;
    const hasCode = Boolean(b && b.code && b.code.trim());
    const isEnabled = Boolean(b && b.enabled);
    let dotClass = "";
    if (isEnabled && hasCode) dotClass = "ai-dot-active";
    else if (hasCode) dotClass = "ai-dot-hascode";

    tabsHtml.push(`
      <button type="button" class="ai-tab-btn${isAct ? " active" : ""}" data-ai-tab="${i}" title="${esc(b.name)}">
        <span class="ai-tab-num">${i}</span>
        ${dotClass ? `<span class="ai-tab-dot ${dotClass}"></span>` : ""}
      </button>
    `);
  }

  tabsHtml.push(`
    <button type="button" class="ai-tab-btn ai-tab-settings${currentTab === "settings" ? " active" : ""}" data-ai-tab="settings" title="${_t("Global Settings", "全局设置")}">
      ${icon("settings")}<span style="margin-left:4px">${_t("Settings", "全局设置")}</span>
    </button>
  `);

  return `<div class="ai-tabs-bar">${tabsHtml.join("")}</div>`;
}

function renderBlockEditor(b) {
  const isEnabled = Boolean(b.enabled);
  const pages = (b.page_types || "posts").split(",").map((s) => s.trim());

  return `
    <div class="ai-block-panel">
      <!-- Header row: Name, Toggle, Shortcode -->
      <div class="ai-panel-header">
        <div class="ai-name-field">
          <label class="ai-label">${_t("Block Name", "代码块名称")}</label>
          <input type="text" class="ai-input" id="ai-name" value="${attr(b.name)}" placeholder="Block ${b.block_no}">
        </div>

        <div class="ai-header-controls">
          <label class="ai-switch-label">
            <input type="checkbox" id="ai-enabled"${isEnabled ? " checked" : ""}>
            <span class="ai-switch-text">${_t("Enable Block", "启用此广告块")}</span>
          </label>

          <div class="ai-shortcode-pill" title="${_t("Click to copy shortcode", "点击复制短代码")}" data-ai-copy="[adinsert block=&quot;${b.block_no}&quot;]">
            <code>[adinsert block="${b.block_no}"]</code>
            ${icon("copy")}
          </div>
        </div>
      </div>

      <!-- Code editor area -->
      <div class="ai-editor-box">
        <div class="ai-editor-toolbar">
          <span class="ai-editor-title">${icon("code")} ${_t("Ad Code (HTML, JavaScript, CSS, AdSense)", "广告代码 (HTML, JS, CSS, Google AdSense)")}</span>
          <div class="ai-presets">
            <button type="button" class="ai-btn-sm" data-ai-preset="adsense-resp">+ Responsive AdSense</button>
            <button type="button" class="ai-btn-sm" data-ai-preset="adsense-banner">+ 728x90 Leaderboard</button>
            <button type="button" class="ai-btn-sm" data-ai-preset="banner-img">+ Image Banner</button>
            <button type="button" class="ai-btn-sm danger" data-ai-preset="clear">${icon("trash")} ${_t("Clear", "清空")}</button>
          </div>
        </div>
        <textarea id="ai-code" class="ai-code-area" spellcheck="false" placeholder="<!-- ${_t("Paste your ad code here (Google AdSense, Media.net, HTML/JS banner)", "在此粘贴广告代码 (Google AdSense, 图片横幅, HTML/JS)")} -->">${esc(b.code)}</textarea>
      </div>

      <!-- Placement & Targeting Controls -->
      <div class="ai-controls-grid">
        <!-- Card 1: Placement & Insertion -->
        <div class="ai-card">
          <div class="ai-card-title">${icon("route")} ${_t("Insertion Position", "插入位置")}</div>
          <div class="ai-field">
            <select id="ai-position" class="ai-select">
              <option value="disabled"${b.position === "disabled" ? " selected" : ""}>${_t("Disabled (Shortcode only)", "不自动插入 (仅短代码)")}</option>
              <option value="before_post"${b.position === "before_post" ? " selected" : ""}>${_t("Before Post", "文章标题前 (Before Post)")}</option>
              <option value="after_post"${b.position === "after_post" ? " selected" : ""}>${_t("After Post", "文章正文后 (After Post)")}</option>
              <option value="before_content"${b.position === "before_content" ? " selected" : ""}>${_t("Before Content", "正文开头前 (Before Content)")}</option>
              <option value="after_content"${b.position === "after_content" ? " selected" : ""}>${_t("After Content", "正文结尾后 (After Content)")}</option>
              <option value="before_paragraph"${b.position === "before_paragraph" ? " selected" : ""}>${_t("Before Paragraph", "指定段落前 (Before Paragraph)")}</option>
              <option value="after_paragraph"${b.position === "after_paragraph" ? " selected" : ""}>${_t("After Paragraph", "指定段落后 (After Paragraph)")}</option>
              <option value="between_paragraphs"${b.position === "between_paragraphs" ? " selected" : ""}>${_t("Between Paragraphs (%)", "段落间百分比处 (%)")}</option>
              <option value="head"${b.position === "head" ? " selected" : ""}>${_t("Header (<head>)", "页头 (<head>)")}</option>
              <option value="footer"${b.position === "footer" ? " selected" : ""}>${_t("Footer (Before </body>)", "页脚 (Before </body>)")}</option>
            </select>
          </div>

          <div id="ai-para-field" class="ai-field"${b.position.includes("paragraph") ? "" : " style=\"display:none;\""}>
            <label class="ai-label">${_t("Paragraph Number / Position", "段落号 / 相对位置")}</label>
            <input type="number" id="ai-para-no" class="ai-input" min="1" max="100" value="${attr(b.paragraph_no || 1)}">
            <span class="ai-hint">${_t("Specify paragraph number or percentage (for Between Paragraphs)", "输入段落序号 (如第 1、2、3 段) 或百分比")}</span>
          </div>
        </div>

        <!-- Card 2: Alignment & Wrapping -->
        <div class="ai-card">
          <div class="ai-card-title">${icon("layers")} ${_t("Alignment & Style", "对齐方式与样式")}</div>
          <div class="ai-field">
            <select id="ai-alignment" class="ai-select">
              <option value="default"${b.alignment === "default" ? " selected" : ""}>${_t("Default (No wrapping)", "默认 (无包裹)")}</option>
              <option value="center"${b.alignment === "center" ? " selected" : ""}>${_t("Center (Centered container)", "居中对齐 (Center)")}</option>
              <option value="left"${b.alignment === "left" ? " selected" : ""}>${_t("Left (Align left)", "靠左对齐 (Left)")}</option>
              <option value="right"${b.alignment === "right" ? " selected" : ""}>${_t("Right (Align right)", "靠右对齐 (Right)")}</option>
              <option value="float_left"${b.alignment === "float_left" ? " selected" : ""}>${_t("Float Left (Wrap text on right)", "左侧浮动环绕 (Float Left)")}</option>
              <option value="float_right"${b.alignment === "float_right" ? " selected" : ""}>${_t("Float Right (Wrap text on left)", "右侧浮动环绕 (Float Right)")}</option>
            </select>
          </div>
          <span class="ai-hint">${_t("Wraps code with responsive CSS styling & spacing", "通过响应式 CSS 样式与边距包裹广告")}</span>
        </div>

        <!-- Card 3: Page Targeting -->
        <div class="ai-card">
          <div class="ai-card-title">${icon("files")} ${_t("Page Targeting", "投放页面类型")}</div>
          <div class="ai-checkbox-group">
            <label class="ai-check-item">
              <input type="checkbox" name="ai-page-type" value="posts"${pages.includes("posts") ? " checked" : ""}>
              <span>${_t("Posts (Single articles)", "文章详情页 (Posts)")}</span>
            </label>
            <label class="ai-check-item">
              <input type="checkbox" name="ai-page-type" value="pages"${pages.includes("pages") ? " checked" : ""}>
              <span>${_t("Pages (Static pages)", "独立静态页 (Pages)")}</span>
            </label>
            <label class="ai-check-item">
              <input type="checkbox" name="ai-page-type" value="home"${pages.includes("home") ? " checked" : ""}>
              <span>${_t("Homepage", "网站首页 (Homepage)")}</span>
            </label>
            <label class="ai-check-item">
              <input type="checkbox" name="ai-page-type" value="category"${pages.includes("category") ? " checked" : ""}>
              <span>${_t("Categories / Archives", "分类与归档页")}</span>
            </label>
          </div>
        </div>

        <!-- Card 4: Device Targeting -->
        <div class="ai-card">
          <div class="ai-card-title">${icon("monitor")} ${_t("Device Targeting", "目标设备过滤")}</div>
          <div class="ai-pill-selector">
            <label class="ai-pill-item">
              <input type="radio" name="ai-device" value="all"${b.device === "all" ? " checked" : ""}>
              <span>${_t("All Devices", "全部设备 (电脑/手机/平板)")}</span>
            </label>
            <label class="ai-pill-item">
              <input type="radio" name="ai-device" value="desktop"${b.device === "desktop" ? " checked" : ""}>
              <span>${_t("Desktop Only", "仅电脑桌面端 (Desktop)")}</span>
            </label>
            <label class="ai-pill-item">
              <input type="radio" name="ai-device" value="mobile"${b.device === "mobile" ? " checked" : ""}>
              <span>${_t("Mobile Only", "仅移动手机端 (Mobile)")}</span>
            </label>
            <label class="ai-pill-item">
              <input type="radio" name="ai-device" value="tablet"${b.device === "tablet" ? " checked" : ""}>
              <span>${_t("Tablet Only", "仅平板电脑端 (Tablet)")}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Live Simulator / Preview -->
      <div class="ai-card" style="margin-top:1.25rem;">
        <div class="ai-card-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>${icon("eye")} ${_t("Live In-Content Simulator", "正文排版效果实时模拟预览")}</span>
          <button type="button" class="btn outline" id="ai-btn-preview" style="padding:.25rem .75rem;font-size:.8125rem;">${icon("refresh")} ${_t("Refresh Preview", "刷新预览")}</button>
        </div>
        <div class="ai-preview-container" id="ai-preview-box">
          <p class="ai-sim-p">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
          <div class="ai-sim-ad-slot" id="ai-preview-slot">
            ${b.code ? b.code : `<div style="padding:1.5rem;text-align:center;color:#888;border:2px dashed #ccc;border-radius:6px;">${_t("Ad will be displayed here according to alignment & code above.", "在此按照上方代码与对齐方式渲染广告呈现效果。")}</div>`}
          </div>
          <p class="ai-sim-p">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
        </div>
      </div>
    </div>
  `;
}

function renderGlobalSettings() {
  return `
    <div class="ai-block-panel">
      <div class="ai-card">
        <div class="ai-card-title">${icon("settings")} ${_t("Global Plugin Settings", "插件全局配置")}</div>

        <div class="ai-field" style="margin-bottom:1.5rem;">
          <label class="ai-switch-label">
            <input type="checkbox" id="ai-set-enabled"${settingsData.enabled === "1" ? " checked" : ""}>
            <span class="ai-switch-text" style="font-size:1rem;font-weight:600;">${_t("Enable Ad Inserter Plugin Globally", "全局启用广告插入器插件")}</span>
          </label>
          <span class="ai-hint">${_t("Master switch to enable or pause all ad insertions site-wide", "全站总开关：关闭后将暂停所有广告位置的代码注入")}</span>
        </div>

        <div class="ai-field" style="margin-bottom:1.5rem;">
          <label class="ai-label">${_t("Minimum Paragraphs Count", "文章最少段落数限制")}</label>
          <input type="number" id="ai-set-min-para" class="ai-input" style="max-width:200px;" min="1" max="50" value="${attr(settingsData.min_paragraphs || 1)}">
          <span class="ai-hint">${_t("Posts with fewer paragraphs than this will not have in-paragraph ads inserted.", "当文章总段落数少于此数字时，不自动在段落间插入广告，避免影响短内容阅读")}</span>
        </div>

        <div class="ai-field" style="margin-bottom:1.5rem;">
          <label class="ai-label">${icon("code")} ${_t("Global Header Code (<head>)", "全站页头通用代码 (<head>)")}</label>
          <textarea id="ai-set-header" class="ai-code-area" rows="4" placeholder="<script async src=&quot;https://pagead2.googlesyndication.com/...&quot; crossorigin=&quot;anonymous&quot;></script>">${esc(settingsData.header_code)}</textarea>
          <span class="ai-hint">${_t("Code to be injected before </head> on all frontend pages (e.g. Google AdSense auto-ad tag, Google Tag Manager)", "注入到全站前台页面 </head> 前的代码（例如 Google AdSense 自动广告全局标签、统计脚本等）")}</span>
        </div>

        <div class="ai-field" style="margin-bottom:1.5rem;">
          <label class="ai-label">${icon("code")} ${_t("Global Footer Code (Before </body>)", "全站页尾通用代码 (Before </body>)")}</label>
          <textarea id="ai-set-footer" class="ai-code-area" rows="4" placeholder="<!-- Tracking scripts or pop-up ad scripts -->">${esc(settingsData.footer_code)}</textarea>
          <span class="ai-hint">${_t("Code to be injected before </body> on all frontend pages", "注入到全站前台页面 </body> 前的代码")}</span>
        </div>
      </div>
    </div>
  `;
}

function getStyles() {
  return `
    <style id="ai-workbench-styles">
      .ai-workbench { max-width: 1200px; margin: 0 auto; }
      
      /* Strictly constrain all SVG icon dimensions so they never scale up */
      .ai-workbench svg {
        width: 16px !important;
        height: 16px !important;
        max-width: 16px !important;
        max-height: 16px !important;
        display: inline-block;
        vertical-align: middle;
        flex-shrink: 0;
      }

      .ai-tabs-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 8px 8px 0 0; border-bottom: none; }
      .ai-tab-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 36px; padding: 0 10px; font-size: 0.875rem; font-weight: 600; color: var(--text-muted, #64748b); background: var(--bg-subtle, #f8fafc); border: 1px solid var(--border, #cbd5e1); border-radius: 6px; cursor: pointer; white-space: nowrap; transition: all 0.15s ease; }
      .ai-tab-btn:hover { color: var(--text-main, #0f172a); background: var(--bg-hover, #f1f5f9); }
      .ai-tab-btn.active { color: #fff; background: var(--primary, #2563eb); border-color: var(--primary, #2563eb); box-shadow: 0 2px 4px rgba(37,99,235,0.25); }
      .ai-tab-settings { margin-left: auto; width: auto; min-width: auto; padding: 0 14px; gap: 6px; background: var(--bg-card, #fff); }
      .ai-tab-dot { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 50%; }
      .ai-tab-dot.ai-dot-active { background: #10b981; box-shadow: 0 0 4px #10b981; }
      .ai-tab-dot.ai-dot-hascode { background: #f59e0b; }

      .ai-block-panel { background: var(--bg-card, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 0 0 8px 8px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .ai-panel-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 1rem; margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border, #e2e8f0); }
      .ai-name-field { flex: 1; min-width: 200px; max-width: 380px; }
      .ai-header-controls { display: flex; align-items: center; gap: 1rem; }
      .ai-switch-label { display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; user-select: none; }
      .ai-switch-label input[type="checkbox"] { width: 1.125rem; height: 1.125rem; accent-color: var(--primary, #2563eb); }
      .ai-switch-text { font-weight: 500; font-size: 0.9375rem; white-space: nowrap; }
      .ai-shortcode-pill { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.375rem 0.625rem; background: var(--bg-subtle, #f1f5f9); border: 1px solid var(--border, #cbd5e1); border-radius: 6px; cursor: pointer; font-size: 0.8125rem; white-space: nowrap; transition: background 0.15s; }
      .ai-shortcode-pill:hover { background: #e2e8f0; }

      .ai-editor-box { margin-bottom: 1.5rem; border: 1px solid #334155; border-radius: 6px; overflow: hidden; background: #0f172a; }
      .ai-editor-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem 0.75rem; background: #1e293b; border-bottom: 1px solid #334155; }
      .ai-editor-title { color: #cbd5e1; font-size: 0.8125rem; font-weight: 600; display: inline-flex; align-items: center; gap: 0.5rem; }
      .ai-presets { display: flex; gap: 0.375rem; flex-wrap: wrap; }
      .ai-btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; background: #334155; color: #f8fafc; border: 1px solid #475569; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: background 0.15s; }
      .ai-btn-sm:hover { background: #475569; }
      .ai-btn-sm.danger { color: #fca5a5; }
      .ai-btn-sm.danger:hover { background: #7f1d1d; }

      .ai-code-area { width: 100%; min-height: 180px; padding: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.875rem; line-height: 1.5; color: #f8fafc; background: #0f172a; border: none; outline: none; resize: vertical; box-sizing: border-box; }

      .ai-controls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
      .ai-card { background: var(--bg-subtle, #f8fafc); border: 1px solid var(--border, #e2e8f0); border-radius: 6px; padding: 1rem; }
      .ai-card-title { font-size: 0.875rem; font-weight: 600; color: var(--text-main, #0f172a); margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
      .ai-card-title svg { color: var(--primary, #2563eb); }
      .ai-field { margin-bottom: 0.75rem; }
      .ai-label { display: block; font-size: 0.8125rem; font-weight: 500; color: var(--text-muted, #475569); margin-bottom: 0.25rem; }
      .ai-hint { display: block; font-size: 0.75rem; color: var(--text-muted, #64748b); margin-top: 0.25rem; }
      .ai-input, .ai-select { width: 100%; padding: 0.4375rem 0.625rem; font-size: 0.875rem; border: 1px solid var(--border, #cbd5e1); border-radius: 4px; background: var(--bg-card, #fff); color: var(--text-main, #0f172a); box-sizing: border-box; }
      .ai-checkbox-group { display: flex; flex-direction: column; gap: 0.375rem; }
      .ai-check-item { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; cursor: pointer; user-select: none; }
      .ai-pill-selector { display: flex; flex-direction: column; gap: 0.375rem; }
      .ai-pill-item { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; cursor: pointer; user-select: none; }

      .ai-preview-container { padding: 1rem; background: #fff; border: 1px solid var(--border, #e2e8f0); border-radius: 6px; margin-top: 0.5rem; }
      .ai-sim-p { color: #64748b; font-size: 0.875rem; line-height: 1.6; margin: 0.5rem 0; }
      .ai-sim-ad-slot { margin: 1rem 0; min-height: 60px; }

      .ai-sticky-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; align-items: center; gap: 1rem; padding: 0.875rem 1.5rem; background: var(--bg-card, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 8px; margin-top: 1.25rem; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); z-index: 10; }
    </style>
  `;
}

function captureCurrentForm() {
  if (currentTab === "settings") {
    const enEl = document.querySelector("#ai-set-enabled");
    const minEl = document.querySelector("#ai-set-min-para");
    const headEl = document.querySelector("#ai-set-header");
    const footEl = document.querySelector("#ai-set-footer");
    if (enEl) settingsData.enabled = enEl.checked ? "1" : "0";
    if (minEl) settingsData.min_paragraphs = String(minEl.value || 1);
    if (headEl) settingsData.header_code = headEl.value;
    if (footEl) settingsData.footer_code = footEl.value;
  } else {
    const idx = currentTab - 1;
    const b = blocksData[idx];
    if (!b) return;
    const nameEl = document.querySelector("#ai-name");
    const enEl = document.querySelector("#ai-enabled");
    const codeEl = document.querySelector("#ai-code");
    const posEl = document.querySelector("#ai-position");
    const paraEl = document.querySelector("#ai-para-no");
    const alignEl = document.querySelector("#ai-alignment");

    if (nameEl) b.name = nameEl.value.trim() || `Block ${currentTab}`;
    if (enEl) b.enabled = enEl.checked ? 1 : 0;
    if (codeEl) b.code = codeEl.value;
    if (posEl) b.position = posEl.value;
    if (paraEl) b.paragraph_no = Number(paraEl.value) || 1;
    if (alignEl) b.alignment = alignEl.value;

    const checkedPages = [...document.querySelectorAll("input[name='ai-page-type']:checked")].map((el) => el.value);
    b.page_types = checkedPages.join(",") || "posts";

    const devEl = document.querySelector("input[name='ai-device']:checked");
    if (devEl) b.device = devEl.value;

    dirtyBlocks.add(currentTab);
  }
}

async function saveAllChanges() {
  if (isSaving) return;
  isSaving = true;
  captureCurrentForm();

  try {
    // 1. Save global plugin settings
    for (const [key, val] of Object.entries(settingsData)) {
      await api("extensions/plugins/adinsert/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: String(val) }),
      });
    }

    // 2. Save active and any modified blocks
    if (typeof currentTab === "number") {
      dirtyBlocks.add(currentTab);
    }

    for (const bNo of dirtyBlocks) {
      const b = blocksData[bNo - 1];
      if (!b) continue;

      const payload = {
        slug: `block-${b.block_no}`,
        block_no: b.block_no,
        name: b.name || `Block ${b.block_no}`,
        code: b.code || "",
        position: b.position || "disabled",
        paragraph_no: Number(b.paragraph_no) || 1,
        alignment: b.alignment || "center",
        page_types: b.page_types || "posts",
        device: b.device || "all",
        enabled: b.enabled ? 1 : 0,
      };

      const res = await api(scoped("theme-tables/blocks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res?.row?.id) b.id = res.row.id;
    }
    dirtyBlocks.clear();

    toast(_t("Ad Inserter settings saved successfully!", "广告插入器配置保存成功！"));
  } catch (err) {
    toast(err.message || _t("Failed to save Ad Inserter settings", "保存配置失败"), "error");
  } finally {
    isSaving = false;
    renderAdInsertView();
  }
}

function updatePreview() {
  const codeEl = document.querySelector("#ai-code");
  const alignEl = document.querySelector("#ai-alignment");
  const slotEl = document.querySelector("#ai-preview-slot");
  if (!slotEl) return;

  const rawCode = codeEl ? codeEl.value : "";
  const align = alignEl ? alignEl.value : "center";

  if (!rawCode.trim()) {
    slotEl.innerHTML = `<div style="padding:1.5rem;text-align:center;color:#888;border:2px dashed #ccc;border-radius:6px;">${_t("No ad code entered yet.", "暂未输入广告代码。")}</div>`;
    return;
  }

  let alignStyle = "";
  if (align === "center") alignStyle = "text-align:center;margin:1rem auto;";
  else if (align === "left") alignStyle = "text-align:left;margin:1rem 0;";
  else if (align === "right") alignStyle = "text-align:right;margin:1rem 0;";
  else if (align === "float_left") alignStyle = "float:left;margin:0 1.25rem 0.75rem 0;";
  else if (align === "float_right") alignStyle = "float:right;margin:0 0 0.75rem 1.25rem;";

  slotEl.innerHTML = `<div style="${alignStyle}">${rawCode}</div>`;
}

function bindEvents(c) {
  // Switch tabs
  c.querySelectorAll("[data-ai-tab]").forEach((btn) => {
    btn.onclick = () => {
      captureCurrentForm();
      const val = btn.dataset.aiTab;
      currentTab = val === "settings" ? "settings" : Number(val);
      renderAdInsertView();
    };
  });

  // Shortcode copy
  const copyBtn = c.querySelector("[data-ai-copy]");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const code = copyBtn.dataset.aiCopy;
      navigator.clipboard?.writeText(code).then(() => {
        toast(_t("Copied to clipboard!", "短代码已复制到剪贴板！"));
      });
    };
  }

  // Presets
  c.querySelectorAll("[data-ai-preset]").forEach((btn) => {
    btn.onclick = () => {
      const preset = btn.dataset.aiPreset;
      const codeEl = c.querySelector("#ai-code");
      if (!codeEl) return;
      if (preset === "adsense-resp") {
        codeEl.value = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX" crossorigin="anonymous"></script>\n<!-- Responsive Ad -->\n<ins class="adsbygoogle"\n     style="display:block"\n     data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"\n     data-ad-slot="1234567890"\n     data-ad-format="auto"\n     data-full-width-responsive="true"></ins>\n<script>\n     (adsbygoogle = window.adsbygoogle || []).push({});\n</script>`;
      } else if (preset === "adsense-banner") {
        codeEl.value = `<ins class="adsbygoogle"\n     style="display:inline-block;width:728px;height:90px"\n     data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"\n     data-ad-slot="1234567890"></ins>\n<script>\n     (adsbygoogle = window.adsbygoogle || []).push({});\n</script>`;
      } else if (preset === "banner-img") {
        codeEl.value = `<a href="https://example.com" target="_blank" rel="noopener sponsored">\n  <img src="https://via.placeholder.com/728x90.png?text=Special+Offer" alt="Advertisement" style="max-width:100%;height:auto;border-radius:4px;" />\n</a>`;
      } else if (preset === "clear") {
        codeEl.value = "";
      }
      updatePreview();
    };
  });

  // Position change toggle
  const posSelect = c.querySelector("#ai-position");
  if (posSelect) {
    posSelect.onchange = () => {
      const isPara = posSelect.value.includes("paragraph");
      const paraField = c.querySelector("#ai-para-field");
      if (paraField) paraField.style.display = isPara ? "" : "none";
    };
  }

  // Preview live button
  const prevBtn = c.querySelector("#ai-btn-preview");
  if (prevBtn) {
    prevBtn.onclick = () => updatePreview();
  }

  // Save button
  const saveBtn = c.querySelector("#ai-save-btn");
  if (saveBtn) {
    saveBtn.onclick = () => saveAllChanges();
  }
}

let containerMount = null;

function renderAdInsertView() {
  if (!containerMount) return;
  const isSettings = currentTab === "settings";
  const b = typeof currentTab === "number" ? blocksData[currentTab - 1] : null;

  containerMount.innerHTML = `
    ${getStyles()}
    <div class="ai-workbench">
      ${pageHead({
        title: _t("Ad Inserter", "广告插入器"),
        sub: _t("Professional ad management, multi-block placement & code insertion", "专业广告管理工作台，多代码块精准位置投放与全站注入"),
        actions: `<button type="button" class="btn primary" id="ai-save-btn" style="min-width:140px;">${icon("save")} ${_t("Save Settings", "保存配置")}</button>`,
        crumbs: [{ label: _t("Extensions", "扩展") }, { label: _t("Ad Inserter", "广告插入器") }],
      })}

      ${renderTabs()}
      ${isSettings ? renderGlobalSettings() : renderBlockEditor(b || makeDefaultBlock(1))}

      <div class="ai-sticky-actions">
        <span class="ai-hint" style="margin-right:auto;">
          ${isSettings ? _t("Configuring global hooks & options", "正在配置全站全局代码与选项") : `${_t("Editing Block", "当前正在编辑代码块")} ${currentTab} (${b?.name || "Untitled"})`}
        </span>
        <button type="button" class="btn primary" onclick="document.querySelector('#ai-save-btn')?.click()">
          ${icon("save")} ${_t("Save Settings", "保存配置")}
        </button>
      </div>
    </div>
  `;

  bindEvents(containerMount);
}

export default async function adinsertScreen(c) {
  containerMount = c;
  c.innerHTML = `<div class="panel" style="text-align:center;padding:2rem;"><div class="spinner"></div><div style="margin-top:0.75rem;color:#64748b;">${_t("Loading Ad Inserter...", "正在载入广告插入器...")}</div></div>`;
  await loadAdInsertData();
  renderAdInsertView();
}
