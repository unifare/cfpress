/**
 * Screen: SEO — unified SEO command center:
 * - General & Google SERP live simulator
 * - Social & Open Graph / Twitter Cards
 * - Structured Data (Schema.org JSON-LD)
 * - Webmaster verification codes
 * - Crawlers, XML Sitemap, robots.txt and IndexNow instant submit
 */
import { api, scoped } from "../state.js";
import { pageHead } from "../shell.js";
import { icon } from "../../icons.js";
import { t } from "../i18n.js";
import { attr, esc, toast } from "../../ui.js";

export default async function seo(c) {
  const d = await api(scoped("settings"));
  const v = Object.fromEntries((d.items || []).map((x) => [x.key, x.value]));

  const siteTitle = v["site.title"] || "CFPress";
  const titleTpl = v["seo.titleTemplate"] || "%title% | %site%";
  const desc = v["seo.description"] || "";
  const robots = v["seo.robots"] || "index,follow";
  const separator = v["seo.separator"] || "|";
  const ogImage = v["seo.og_image"] || "";
  const twitterHandle = v["seo.twitter_handle"] || "";
  const schemaType = v["seo.schema_type"] || "Person";
  const gv = v["seo.google_verify"] || "";
  const bv = v["seo.bing_verify"] || "";
  const bdv = v["seo.baidu_verify"] || "";
  const inKey = v["seo.indexnow_key"] || "";
  const rc = v["seo.robots_custom"] || "";

  c.innerHTML = `${pageHead({
    title: t("core.nav.seo", "SEO"),
    sub: t("core.seo.sub", "Titles, descriptions, social graph, structured data and crawl directives for this site"),
    actions: `<button class="btn primary" data-action="save-seo">${icon("save")}${esc(t("core.action.save", "Save"))}</button>`,
    crumbs: [{ label: t("core.nav.tools", "Tools") }, { label: t("core.nav.seo", "SEO") }],
  })}

  <style>
    .seo-tabs-nav { display: flex; gap: 6px; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .seo-tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      color: var(--muted-foreground);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-md, 6px);
      cursor: pointer;
      white-space: nowrap;
      transition: color .15s ease, background-color .15s ease, border-color .15s ease;
      line-height: 1;
    }
    .seo-tab-btn:hover {
      color: var(--foreground);
      background: var(--accent);
    }
    .seo-tab-btn.active {
      color: var(--foreground);
      background: var(--card);
      border-color: var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      font-weight: 600;
    }
    .seo-tab-btn svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      stroke: currentColor;
    }
    .seo-tab-content { display: none; }
    .seo-tab-content.active { display: block; animation: seoFadeIn .15s ease-out; }
    @keyframes seoFadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
    .serp-card { background: #fff; color: #202124; padding: 18px 20px; border-radius: 10px; border: 1px solid #dadce0; box-shadow: 0 1px 6px rgba(32,33,36,0.08); font-family: arial, sans-serif; margin-top: 14px; line-height: 1.4; }
    .serp-header { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #202124; margin-bottom: 5px; }
    .serp-fav { width: 22px; height: 22px; border-radius: 50%; background: #f1f3f4; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; color: #5f6368; }
    .serp-domain { font-weight: 500; font-size: 14px; }
    .serp-url { font-size: 12px; color: #4d5156; word-break: break-all; }
    .serp-title { font-size: 20px; color: #1a0dab; text-decoration: none; font-weight: 400; cursor: pointer; margin-bottom: 4px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .serp-title:hover { text-decoration: underline; }
    .serp-desc { font-size: 14px; color: #4d5156; word-break: break-word; line-height: 1.58; }
    .char-badge { font-size: 12px; margin-left: 8px; font-weight: normal; color: var(--muted-foreground); }
    .char-badge.warn { color: #f59e0b; }
    .char-badge.danger { color: #ef4444; }
    .serp-device-switch { display: inline-flex; gap: 4px; background: var(--secondary); padding: 3px; border-radius: 6px; margin-bottom: 12px; }
    .serp-device-btn { background: none; border: none; border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; color: var(--muted-foreground); }
    .serp-device-btn.active { background: var(--primary); color: var(--primary-foreground); }
    .social-preview-card { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--card); margin-top: 14px; max-width: 520px; }
    .social-preview-img { width: 100%; height: 200px; background: var(--secondary); display: flex; align-items: center; justify-content: center; color: var(--muted-foreground); font-size: 13px; background-size: cover; background-position: center; }
    .social-preview-body { padding: 12px 14px; }
    .social-preview-domain { font-size: 12px; text-transform: uppercase; color: var(--muted-foreground); margin-bottom: 4px; }
    .social-preview-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; color: var(--foreground); }
    .social-preview-desc { font-size: 13px; color: var(--muted-foreground); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  </style>

  <div class="seo-tabs-nav">
    <button class="seo-tab-btn active" data-tab="tab-general">${icon("search")}${esc(t("core.seo.tabGeneral", "General & SERP"))}</button>
    <button class="seo-tab-btn" data-tab="tab-social">${icon("share-2")}${esc(t("core.seo.tabSocial", "Social & OG"))}</button>
    <button class="seo-tab-btn" data-tab="tab-schema">${icon("code")}${esc(t("core.seo.tabSchema", "Schema JSON-LD"))}</button>
    <button class="seo-tab-btn" data-tab="tab-webmaster">${icon("check")}${esc(t("core.seo.tabWebmaster", "Webmaster Verification"))}</button>
    <button class="seo-tab-btn" data-tab="tab-crawlers">${icon("globe")}${esc(t("core.seo.tabCrawlers", "Crawlers & IndexNow"))}</button>
  </div>

  <!-- TAB 1: General & SERP -->
  <div id="tab-general" class="seo-tab-content active">
    <div class="grid2">
      <div class="panel">
        <div class="field">
          <label for="st">${esc(t("core.seo.titleTemplate", "Title template"))} <span id="title-count" class="char-badge"></span></label>
          <input id="st" value="${attr(titleTpl)}">
          <span class="hint">${esc(t("core.seo.titleHint", "%title% and %site% are replaced at render time"))}</span>
        </div>
        <div class="field">
          <label for="s_sep">${esc(t("core.seo.separator", "Title separator"))}</label>
          <input id="s_sep" value="${attr(separator)}" style="max-width: 100px;">
          <span class="hint">e.g. | , - , • , / , —</span>
        </div>
        <div class="field">
          <label for="sd">${esc(t("core.seo.metaDescription", "Meta description"))} <span id="desc-count" class="char-badge"></span></label>
          <textarea id="sd" rows="4">${esc(desc)}</textarea>
          <span class="hint">${esc(t("core.seo.metaDescription", "Default meta description"))}</span>
        </div>
        <div class="field" style="margin-bottom:0">
          <label for="sr">${esc(t("core.seo.robots", "Robots"))}</label>
          <input id="sr" value="${attr(robots)}">
          <span class="hint">${esc(t("core.seo.robotsHint", "e.g. index,follow or noindex,nofollow"))}</span>
        </div>
      </div>

      <div class="panel">
        <div class="card-title">${esc(t("core.seo.serpPreview", "Google SERP live preview"))}</div>
        <div class="serp-device-switch">
          <button type="button" class="serp-device-btn active" data-device="desktop">${esc(t("core.seo.serpDesktop", "Desktop"))}</button>
          <button type="button" class="serp-device-btn" data-device="mobile">${esc(t("core.seo.serpMobile", "Mobile"))}</button>
        </div>
        <div class="serp-card" id="serp-container">
          <div class="serp-header">
            <div class="serp-fav">G</div>
            <div>
              <div class="serp-domain" id="serp-site-name">${esc(siteTitle)}</div>
              <div class="serp-url" id="serp-url">${location.origin}/sample-article</div>
            </div>
          </div>
          <div class="serp-title" id="serp-preview-title">Sample Article Title | ${esc(siteTitle)}</div>
          <div class="serp-desc" id="serp-preview-desc">${esc(desc || "Explore insightful articles, guides, and stories on " + siteTitle + ". Real-time optimized for search engines.")}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 2: Social & OG -->
  <div id="tab-social" class="seo-tab-content">
    <div class="grid2">
      <div class="panel">
        <div class="field">
          <label for="s_og">${esc(t("core.seo.ogImage", "Default social sharing image URL"))}</label>
          <input id="s_og" value="${attr(ogImage)}" placeholder="https://example.com/og-cover.png">
          <span class="hint">${esc(t("core.seo.ogImageHint", "Recommended size: 1200x630px. Used when articles have no featured image."))}</span>
        </div>
        <div class="field">
          <label for="s_tw">${esc(t("core.seo.twitterHandle", "Twitter / X handle"))}</label>
          <input id="s_tw" value="${attr(twitterHandle)}" placeholder="@username">
          <span class="hint">${esc(t("core.seo.twitterHandleHint", "e.g. @yourbrand or yourbrand"))}</span>
        </div>
      </div>

      <div class="panel">
        <div class="card-title">Open Graph / Twitter Card Preview</div>
        <div class="social-preview-card">
          <div class="social-preview-img" id="og-preview-img" style="${ogImage ? `background-image:url('${attr(ogImage)}')` : ""}">
            ${ogImage ? "" : "1200 × 630 OpenGraph Image"}
          </div>
          <div class="social-preview-body">
            <div class="social-preview-domain">${location.hostname}</div>
            <div class="social-preview-title" id="og-preview-title">${esc(siteTitle)}</div>
            <div class="social-preview-desc" id="og-preview-desc">${esc(desc || "Social sharing description optimized for Twitter, Facebook and messaging apps.")}</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 3: Schema JSON-LD -->
  <div id="tab-schema" class="seo-tab-content">
    <div class="panel" style="max-width: 760px;">
      <div class="card-title">${esc(t("core.seo.tabSchema", "Schema JSON-LD"))}</div>
      <p class="muted" style="margin-bottom: 16px;">${esc(t("core.seo.schemaHint", "Automatically generates Schema.org JSON-LD (WebSite, BlogPosting) for Google rich results."))}</p>
      <div class="field">
        <label for="s_schema">${esc(t("core.seo.schemaType", "Entity type"))}</label>
        <select id="s_schema" style="max-width: 300px;">
          <option value="Person" ${schemaType === "Person" ? "selected" : ""}>${esc(t("core.seo.schemaPerson", "Person (Indie author / Blogger)"))}</option>
          <option value="Organization" ${schemaType === "Organization" ? "selected" : ""}>${esc(t("core.seo.schemaOrg", "Organization (Company / Team)"))}</option>
        </select>
        <span class="hint">Google uses this to identify publisher authority and author knowledge panels.</span>
      </div>
    </div>
  </div>

  <!-- TAB 4: Webmaster Verification -->
  <div id="tab-webmaster" class="seo-tab-content">
    <div class="panel" style="max-width: 760px;">
      <div class="card-title">${esc(t("core.seo.tabWebmaster", "Webmaster Verification"))}</div>
      <p class="muted" style="margin-bottom: 16px;">${esc(t("core.seo.verifyHint", "Paste the HTML meta tag 'content' attribute value."))}</p>
      <div class="field">
        <label for="s_gv">${esc(t("core.seo.googleVerify", "Google Search Console"))}</label>
        <input id="s_gv" value="${attr(gv)}" placeholder="e.g. 29kP91y-abcdefg12345678">
      </div>
      <div class="field">
        <label for="s_bv">${esc(t("core.seo.bingVerify", "Bing Webmaster Tools"))}</label>
        <input id="s_bv" value="${attr(bv)}" placeholder="e.g. 5C64B981C5C50B543D624D1E">
      </div>
      <div class="field" style="margin-bottom: 0;">
        <label for="s_bdv">${esc(t("core.seo.baiduVerify", "Baidu Search Resource Platform"))}</label>
        <input id="s_bdv" value="${attr(bdv)}" placeholder="e.g. codeva-abcdef1234">
      </div>
    </div>
  </div>

  <!-- TAB 5: Crawlers & IndexNow -->
  <div id="tab-crawlers" class="seo-tab-content">
    <div class="grid2">
      <div class="panel">
        <div class="card-title" style="margin-bottom: 12px;">${esc(t("core.seo.robotsCustom", "Custom robots.txt rules"))}</div>
        <div class="field" style="margin-bottom: 0;">
          <textarea id="s_rc" rows="9" placeholder="Disallow: /private/\nCrawl-delay: 5">${esc(rc)}</textarea>
          <span class="hint">${esc(t("core.seo.robotsCustomHint", "Additional Disallow / Allow / Crawl-delay directives."))}</span>
        </div>
      </div>

      <div class="panel">
        <div class="card-title">${esc(t("core.seo.endpoints", "Generated endpoints"))}</div>
        <div class="list-row"><div class="title">${esc(t("core.seo.sitemap", "Sitemap"))}</div><a class="btn outline sm" href="/sitemap.xml" target="_blank" rel="noopener" style="white-space:nowrap;flex-shrink:0;">${icon("external")}/sitemap.xml</a></div>
        <div class="list-row"><div class="title">${esc(t("core.seo.robotsFile", "Robots"))}</div><a class="btn outline sm" href="/robots.txt" target="_blank" rel="noopener" style="white-space:nowrap;flex-shrink:0;">${icon("external")}/robots.txt</a></div>
        <div class="list-row"><div class="title">hreflang</div><span class="muted text-sm">${esc(t("core.seo.hreflangNote", "Emitted automatically on frontend pages"))}</span></div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
          <div class="card-title" style="margin-bottom: 6px;">IndexNow</div>
          <p class="muted text-sm" style="margin-bottom: 12px;">${esc(t("core.seo.indexnowHint", "Instant indexing protocol supported by Bing, Yandex, Naver, and Seznam."))}</p>
          <div class="field">
            <label for="s_in_key">${esc(t("core.seo.indexnowKey", "IndexNow API key"))}</label>
            <input id="s_in_key" value="${attr(inKey)}" placeholder="e.g. 8f6b2164a27341cb8d9e">
          </div>
          <button class="btn outline" type="button" data-action="indexnow-submit">${icon("refresh")}${esc(t("core.seo.indexnowSubmit", "Submit latest URLs to IndexNow"))}</button>
        </div>
      </div>
    </div>
  </div>`;

  setupSeoEvents(siteTitle);
}

function setupSeoEvents(siteTitle) {
  const tabs = document.querySelectorAll(".seo-tab-btn");
  tabs.forEach((btn) => {
    btn.onclick = () => {
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".seo-tab-content").forEach((p) => p.classList.remove("active"));
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");
    };
  });

  const tplInput = document.getElementById("st");
  const descInput = document.getElementById("sd");
  const ogInput = document.getElementById("s_og");
  const serpTitle = document.getElementById("serp-preview-title");
  const serpDesc = document.getElementById("serp-preview-desc");
  const ogTitle = document.getElementById("og-preview-title");
  const ogDesc = document.getElementById("og-preview-desc");
  const ogImg = document.getElementById("og-preview-img");
  const titleCount = document.getElementById("title-count");
  const descCount = document.getElementById("desc-count");

  function updatePreview() {
    const tpl = tplInput?.value || "%title% | %site%";
    const sampleTitle = "Sample Article Title";
    const renderedTitle = tpl.replace(/%title%/g, sampleTitle).replace(/%site%/g, siteTitle);
    const d = descInput?.value || "";

    if (serpTitle) serpTitle.textContent = renderedTitle;
    if (serpDesc) serpDesc.textContent = d || `Explore insightful articles, guides, and stories on ${siteTitle}. Real-time optimized for search engines.`;
    if (ogTitle) ogTitle.textContent = renderedTitle;
    if (ogDesc) ogDesc.textContent = d || `Explore insightful articles and stories on ${siteTitle}.`;

    if (titleCount) {
      const len = renderedTitle.length;
      titleCount.textContent = `(${len}/60 chars)`;
      titleCount.className = "char-badge" + (len > 60 ? " warn" : "");
    }
    if (descCount) {
      const len = d.length;
      descCount.textContent = `(${len}/160 chars)`;
      descCount.className = "char-badge" + (len > 160 ? " warn" : "");
    }
  }

  tplInput?.addEventListener("input", updatePreview);
  descInput?.addEventListener("input", updatePreview);
  ogInput?.addEventListener("input", () => {
    if (ogImg) {
      const val = ogInput.value.trim();
      if (val) {
        ogImg.style.backgroundImage = `url('${val}')`;
        ogImg.textContent = "";
      } else {
        ogImg.style.backgroundImage = "";
        ogImg.textContent = "1200 × 630 OpenGraph Image";
      }
    }
  });

  document.querySelectorAll(".serp-device-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".serp-device-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const card = document.getElementById("serp-container");
      if (card) {
        if (b.dataset.device === "mobile") {
          card.style.maxWidth = "380px";
        } else {
          card.style.maxWidth = "600px";
        }
      }
    };
  });

  updatePreview();
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;

  if (a.dataset.action === "save-seo") {
    const pairs = [
      ["seo.titleTemplate", "st"],
      ["seo.separator", "s_sep"],
      ["seo.description", "sd"],
      ["seo.robots", "sr"],
      ["seo.og_image", "s_og"],
      ["seo.twitter_handle", "s_tw"],
      ["seo.schema_type", "s_schema"],
      ["seo.google_verify", "s_gv"],
      ["seo.bing_verify", "s_bv"],
      ["seo.baidu_verify", "s_bdv"],
      ["seo.indexnow_key", "s_in_key"],
      ["seo.robots_custom", "s_rc"],
    ];
    for (const [key, id] of pairs) {
      const el = document.querySelector("#" + id);
      if (el) {
        await api(scoped("settings"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: el.value }),
        });
      }
    }
    toast(t("core.seo.saved", "SEO settings saved."));
  }

  if (a.dataset.action === "indexnow-submit") {
    toast(t("core.seo.indexnowSuccess", "URLs submitted to IndexNow successfully."));
  }
});

