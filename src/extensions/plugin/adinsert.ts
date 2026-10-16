/**
 * Ad Inserter core implementation for CFPress.
 *
 * Implements WordPress/DotnetCMS Ad Inserter feature parity:
 * - Ad blocks targeting & formatting (Center, Left, Right, Float, Responsive CSS)
 * - Automatic placement: Head, Footer, Before/After Post, Before/After Content,
 *   Before/After Paragraph N, Between Paragraphs (% of content)
 * - Position "disabled": strictly prevents automatic insertion; reserved for shortcodes
 * - Targeting filters: Device (Desktop/Mobile/Tablet), Page types (Posts/Pages/Homepage/Category)
 * - Paragraph requirement gate: min_paragraphs check
 * - Shortcode: [adinsert block="N"]
 */

import { Env } from "../../shared/types";
import type { ExtensionContext } from "./runtime";

export interface AdBlock {
  block_no: number;
  name: string;
  code: string;
  position:
    | "disabled"
    | "head"
    | "footer"
    | "before_post"
    | "after_post"
    | "before_content"
    | "after_content"
    | "before_paragraph"
    | "after_paragraph"
    | "between_paragraphs";
  paragraph_no?: number;
  alignment?: "default" | "center" | "left" | "right" | "float_left" | "float_right";
  page_types?: string; // e.g. "all", "posts", "pages", "home", "category"
  device?: string; // e.g. "all", "desktop", "mobile", "tablet"
  enabled?: number | boolean;
}

export interface AdInsertSettings {
  enabled: boolean;
  min_paragraphs: number;
  header_code: string;
  footer_code: string;
}

/**
 * Format ad code inside a styled container matching the requested alignment.
 * Adds clear responsiveness, centering, margins, and floating clears.
 */
export function formatAdMarkup(code: string, alignment?: string): string {
  if (!code || !code.trim()) return "";
  let style = "";
  switch (alignment) {
    case "center":
      style = "text-align: center; margin: 16px auto; display: flex; flex-direction: column; align-items: center; justify-content: center; clear: both; max-width: 100%; box-sizing: border-box;";
      break;
    case "left":
      style = "text-align: left; margin: 16px 0; clear: both; max-width: 100%; box-sizing: border-box;";
      break;
    case "right":
      style = "text-align: right; margin: 16px 0; clear: both; max-width: 100%; box-sizing: border-box;";
      break;
    case "float_left":
      style = "float: left; margin: 0 16px 14px 0; max-width: 50%; clear: left; box-sizing: border-box;";
      break;
    case "float_right":
      style = "float: right; margin: 0 0 14px 16px; max-width: 50%; clear: right; box-sizing: border-box;";
      break;
    default:
      style = "margin: 12px 0; max-width: 100%; box-sizing: border-box;";
  }
  return `<div class="cfpress-adinsert-block" style="${style}">${code}</div>`;
}

/**
 * Identify client device category (Desktop / Mobile / Tablet) from request headers.
 */
export function detectDevice(request?: Request): "desktop" | "mobile" | "tablet" {
  if (!request) return "desktop";
  const secMobile = request.headers.get("sec-ch-ua-mobile");
  if (secMobile === "?1") return "mobile";

  const ua = request.headers.get("user-agent") || "";
  if (/ipad|tablet|playbook|silk/i.test(ua)) return "tablet";
  if (/android|mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Check if block matches client device rule.
 */
export function matchDevice(blockDevice?: string, clientDevice?: "desktop" | "mobile" | "tablet"): boolean {
  if (!blockDevice || blockDevice === "all") return true;
  if (!clientDevice) return true;
  return blockDevice.toLowerCase() === clientDevice.toLowerCase();
}

/**
 * Check if block matches requested page type (posts, pages, home, category).
 */
export function matchPageType(
  blockPageType?: string,
  pageKind?: string,
  template?: string,
  path?: string
): boolean {
  if (!blockPageType || blockPageType === "all") return true;
  const allowed = blockPageType
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length || allowed.includes("all")) return true;

  const kind = (pageKind || "").toLowerCase();
  const tpl = (template || "").toLowerCase();
  const p = (path || "").toLowerCase();

  for (const target of allowed) {
    if (target === "posts" || target === "post" || target === "single") {
      if (kind === "single" || kind === "post" || tpl.startsWith("single") || tpl.includes("post")) return true;
    }
    if (target === "pages" || target === "page") {
      if (kind === "page" || tpl.startsWith("page")) return true;
    }
    if (target === "home" || target === "homepage") {
      if (kind === "home" || p === "/" || p === "" || tpl.startsWith("index") || tpl.startsWith("home")) return true;
    }
    if (target === "category" || target === "categories" || target === "archive" || target === "archives") {
      if (kind === "category" || kind === "archive" || kind === "taxonomy" || tpl.includes("category") || tpl.includes("archive")) return true;
    }
  }

  return false;
}

/**
 * Insert ad markup into HTML content by paragraph rules.
 * Strictly ignores disabled position.
 */
export function injectIntoParagraphs(
  html: string,
  adMarkup: string,
  position: AdBlock["position"],
  paragraphNo: number = 1
): string {
  if (!html || !adMarkup || position === "disabled") return html;

  // Match all <p>...</p> tags in the HTML
  const pRegex = /<p\b[^>]*>[\s\S]*?<\/p>/gi;
  const matches: { start: number; end: number; length: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(html)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, length: m[0].length });
  }

  const count = matches.length;
  if (count === 0) {
    // If no <p> tags, place at beginning or end
    if (position === "before_content" || position === "before_paragraph") {
      return `${adMarkup}\n${html}`;
    }
    return `${html}\n${adMarkup}`;
  }

  if (position === "before_content") {
    const first = matches[0];
    return html.slice(0, first.start) + adMarkup + "\n" + html.slice(first.start);
  }

  if (position === "after_content") {
    const last = matches[count - 1];
    return html.slice(0, last.end) + "\n" + adMarkup + html.slice(last.end);
  }

  if (position === "before_paragraph") {
    const targetIdx = Math.max(0, Math.min(count - 1, (paragraphNo || 1) - 1));
    const target = matches[targetIdx];
    return html.slice(0, target.start) + adMarkup + "\n" + html.slice(target.start);
  }

  if (position === "after_paragraph") {
    const targetIdx = Math.max(0, Math.min(count - 1, (paragraphNo || 1) - 1));
    const target = matches[targetIdx];
    return html.slice(0, target.end) + "\n" + adMarkup + html.slice(target.end);
  }

  if (position === "between_paragraphs") {
    // Treat paragraphNo as a percentage (e.g. 50%) or middle paragraph
    const pct = paragraphNo > 0 && paragraphNo <= 100 ? paragraphNo / 100 : 0.5;
    const targetIdx = Math.max(0, Math.min(count - 1, Math.round(count * pct) - 1));
    const target = matches[targetIdx];
    return html.slice(0, target.end) + "\n" + adMarkup + html.slice(target.end);
  }

  return html;
}

/**
 * Read Ad Inserter settings from plugin_settings for the given site.
 */
export async function readAdInsertSettings(env: Env, siteId: string): Promise<AdInsertSettings> {
  const defaults: AdInsertSettings = {
    enabled: true,
    min_paragraphs: 1,
    header_code: "",
    footer_code: "",
  };

  try {
    const r = await env.DB.prepare(
      "SELECT key, value FROM plugin_settings WHERE plugin_id=(SELECT id FROM plugin_installs WHERE name='adinsert' LIMIT 1)"
    ).all();
    const map = new Map<string, string>(
      (((r.results as any[]) ?? []) as any[]).map((row) => [String(row.key), String(row.value ?? "")])
    );

    if (map.has("enabled")) defaults.enabled = map.get("enabled") !== "0";
    if (map.has("min_paragraphs")) defaults.min_paragraphs = Math.max(1, parseInt(map.get("min_paragraphs") || "1", 10) || 1);
    if (map.has("header_code")) defaults.header_code = map.get("header_code") || "";
    if (map.has("footer_code")) defaults.footer_code = map.get("footer_code") || "";
  } catch {
    // Table not populated yet
  }

  return defaults;
}

/**
 * Read all configured Ad Blocks for the given site.
 */
export async function readAdBlocks(env: Env, siteId: string): Promise<AdBlock[]> {
  const blocks: AdBlock[] = [];
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM plugin_adinsert_blocks WHERE site_id=? AND enabled=1 ORDER BY block_no ASC, updated_at DESC"
    )
      .bind(siteId)
      .all();
    const seen = new Set<number>();
    for (const row of (r.results as any[]) ?? []) {
      const bNo = Number(row.block_no || 1);
      if (seen.has(bNo)) continue;
      seen.add(bNo);
      blocks.push({
        block_no: bNo,
        name: String(row.name || ""),
        code: String(row.code || ""),
        position: (row.position as any) || "after_paragraph",
        paragraph_no: Number(row.paragraph_no || 1),
        alignment: (row.alignment as any) || "default",
        page_types: String(row.page_types || "all"),
        device: String(row.device || "all"),
        enabled: Number(row.enabled ?? 1),
      });
    }
  } catch {
    // Table might not exist yet if unmigrated
  }

  return blocks;
}

/**
 * Execute ad insertions on the rendered document for front-end requests.
 */
export async function filterAdInsert(ctx: ExtensionContext, doc: string): Promise<string> {
  if (typeof doc !== "string" || !ctx?.env) return doc;
  const siteId = ctx.siteId;
  if (!siteId) return doc;

  const settings = await readAdInsertSettings(ctx.env, siteId);
  if (!settings.enabled) return doc;

  let out = doc;

  // 1. Inject global Header Code
  if (settings.header_code && !out.includes(settings.header_code)) {
    out = out.includes("</head>") ? out.replace("</head>", `${settings.header_code}\n</head>`) : out;
  }

  // 2. Inject global Footer Code
  if (settings.footer_code && !out.includes(settings.footer_code)) {
    out = out.includes("</body>") ? out.replace("</body>", `${settings.footer_code}\n</body>`) : out;
  }

  // 3. Read active blocks
  const blocks = await readAdBlocks(ctx.env, siteId);
  if (!blocks.length) return out;

  const clientDevice = detectDevice(ctx.request);
  const pageKind = (ctx as any).kind || "single";
  const template = (ctx as any).template || "";
  const path = (ctx as any).path || "";

  // Paragraph count for min_paragraphs gate
  const pCount = (out.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []).length;

  for (const block of blocks) {
    // A. "Disabled" (Shortcode only): strictly skip automatic insertion!
    if (block.position === "disabled") continue;

    // B. Check device targeting
    if (!matchDevice(block.device, clientDevice)) continue;

    // C. Check page type targeting
    if (!matchPageType(block.page_types, pageKind, template, path)) continue;

    // Format ad markup with requested alignment and responsive styling
    const formatted = formatAdMarkup(block.code, block.alignment);
    if (!formatted) continue;

    if (block.position === "head") {
      if (!out.includes(block.code)) {
        out = out.includes("</head>") ? out.replace("</head>", `${block.code}\n</head>`) : out;
      }
    } else if (block.position === "footer") {
      if (!out.includes(block.code)) {
        out = out.includes("</body>") ? out.replace("</body>", `${block.code}\n</body>`) : out;
      }
    } else if (block.position === "before_post") {
      if (out.includes("<article")) {
        out = out.replace(/<article\b[^>]*>/i, (m) => `${formatted}\n${m}`);
      } else if (out.includes("<main")) {
        out = out.replace(/<main\b[^>]*>/i, (m) => `${formatted}\n${m}`);
      }
    } else if (block.position === "after_post") {
      if (out.includes("</article>")) {
        out = out.replace("</article>", `${formatted}\n</article>`);
      } else if (out.includes("</main>")) {
        out = out.replace("</main>", `${formatted}\n</main>`);
      }
    } else {
      // Content & paragraph placements: enforce min_paragraphs requirement
      if (pCount < settings.min_paragraphs) continue;
      out = injectIntoParagraphs(out, formatted, block.position, block.paragraph_no);
    }
  }

  return out;
}

/**
 * Handle shortcode [adinsert block="1"]
 * Works even when position is "disabled".
 */
export async function handleAdInsertShortcode(
  ctx: { env: Env; siteId?: string },
  payload: { name: string; attrs: Record<string, string>; body?: string }
): Promise<any> {
  if (payload.name !== "adinsert") return payload;

  const siteId = ctx.siteId;
  if (!siteId) return payload;
  const blockNo = parseInt(payload.attrs?.block || payload.attrs?.id || "1", 10);

  const blocks = await readAdBlocks(ctx.env, siteId);
  const matched = blocks.find((b) => b.block_no === blockNo);

  if (matched && matched.code) {
    return { ...payload, body: formatAdMarkup(matched.code, matched.alignment) };
  }

  return payload;
}
