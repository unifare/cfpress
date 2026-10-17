import {Env} from "../shared/types";
import {siteInfo,locales,defaultLocale,setting} from "./frontend";
import {resolvePostUrl, DEFAULT_PERMALINK_STRUCTURE} from "./permalink";
/**
 * These endpoints are site-scoped.
 *
 * `siteId` is required, and the router only calls these *after* resolving the
 * site (see `src/index.ts`). Previously they ran before site resolution and
 * called `locales(env)` / `siteInfo(env)` without it, so a multi-site install
 * served the default site's sitemap, robots policy and feed on every host.
 */
/** Escape text for XML character data. A slug or title containing `&` would
 *  otherwise produce a document no feed reader will parse. */
function xml(v:unknown){
 return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
}
export async function sitemap(env:Env,request:Request,siteId:string){
 const url=new URL(request.url),ls=await locales(env,siteId);
 const permSetting = await setting(env, "permalink.structure", DEFAULT_PERMALINK_STRUCTURE, siteId);
 // Rule 58: each locale's URL uses that locale's own slug when it has one.
 const rows=await env.DB.prepare(`SELECT p.id,p.type,COALESCE(t.slug,p.slug) AS slug,p.created_at,t.locale,p.updated_at FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.status='published' LIMIT 5000`).bind(siteId).all();
 // The locale homepages get a `lastmod` too: a sitemap that dates only the
 // leaves tells a crawler nothing about when the index changed.
 const newest=await env.DB.prepare(`SELECT MAX(updated_at) AS m FROM posts WHERE site_id=? AND status='published'`).bind(siteId).first<any>();
 const homeMod=newest?.m?`<lastmod>${new Date(Number(newest.m)*1000).toISOString()}</lastmod>`:"";
 const out:string[]=(ls as any[]).map(l=>`<url><loc>${xml(`${url.origin}/${l.code}`)}</loc>${homeMod}</url>`);
 for(const r of rows.results as any[]){
   const postPath = r.type === "post"
     ? resolvePostUrl(permSetting, r, { locale: r.locale, alwaysPrefixLocale: true })
     : `/${r.locale}/${r.slug}`;
   out.push(`<url><loc>${xml(`${url.origin}${postPath.startsWith("/") ? "" : "/"}${postPath}`)}</loc><lastmod>${new Date(r.updated_at*1000).toISOString()}</lastmod></url>`);
 }
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${out.join("")}</urlset>`,{headers:{"Content-Type":"application/xml;charset=UTF-8"}})
}
export async function robots(env:Env,request:Request,siteId:string){
  const u=new URL(request.url);
  const custom = await setting(env, "seo.robots_custom", "", siteId);
  const extra = custom && custom.trim() ? `\n# Custom rules\n${custom.trim()}\n` : "";
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\n${extra}\nSitemap: ${u.origin}/sitemap.xml\n`,{headers:{"Content-Type":"text/plain;charset=UTF-8"}});
}

function attr(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface SeoHeadInput {
  origin?: string;
  path?: string;
  locale?: string;
  title?: string;
  description?: string;
  kind?: string;
  post?: any;
  site?: { title?: string; description?: string; robots?: string; url?: string };
}

/**
 * Generate full standard SEO tags for <head>:
 * - Canonical & Robots directives
 * - Open Graph & Twitter Cards
 * - Webmaster verification tags
 * - Schema.org JSON-LD structured data
 */
export async function renderSeoHead(env: Env, siteId: string, input: SeoHeadInput): Promise<string> {
  const origin = input.origin || "";
  const currentPath = input.path || "/";
  const canonicalUrl = origin ? `${origin}${currentPath.startsWith("/") ? "" : "/"}${currentPath}` : "";
  const p = input.post;
  const s = input.site || {};

  const [
    seoDesc,
    seoRobots,
    ogImageFallback,
    twitterHandle,
    schemaType,
    googleVerify,
    bingVerify,
    baiduVerify,
  ] = await Promise.all([
    setting(env, "seo.description", "", siteId),
    setting(env, "seo.robots", "index,follow", siteId),
    setting(env, "seo.og_image", "", siteId),
    setting(env, "seo.twitter_handle", "", siteId),
    setting(env, "seo.schema_type", "Person", siteId),
    setting(env, "seo.google_verify", "", siteId),
    setting(env, "seo.bing_verify", "", siteId),
    setting(env, "seo.baidu_verify", "", siteId),
  ]);

  const title = (p?.title || input.title || s.title || "").trim();
  const description = (p?.excerpt || p?.description || input.description || seoDesc || s.description || "").trim();
  const robotsDirective = p?.noindex ? "noindex,follow" : (seoRobots || s.robots || "index,follow");
  const postImage = p?.featured_image || p?.cover_image || p?.image || "";
  const shareImage = postImage || ogImageFallback || "";
  const absoluteShareImage = shareImage && origin && !shareImage.startsWith("http")
    ? `${origin}${shareImage.startsWith("/") ? "" : "/"}${shareImage}`
    : shareImage;

  const lines: string[] = [];

  // 1. Basic Meta & Canonical
  if (robotsDirective) lines.push(`<meta name="robots" content="${attr(robotsDirective)}">`);
  if (description) lines.push(`<meta name="description" content="${attr(description)}">`);
  if (canonicalUrl) lines.push(`<link rel="canonical" href="${attr(canonicalUrl)}">`);

  // 2. Open Graph (og:*)
  const isArticle = Boolean(p && p.id && input.kind !== "page");
  lines.push(`<meta property="og:type" content="${isArticle ? "article" : "website"}">`);
  if (title) lines.push(`<meta property="og:title" content="${attr(title)}">`);
  if (description) lines.push(`<meta property="og:description" content="${attr(description)}">`);
  if (canonicalUrl) lines.push(`<meta property="og:url" content="${attr(canonicalUrl)}">`);
  if (s.title) lines.push(`<meta property="og:site_name" content="${attr(s.title)}">`);
  if (input.locale) lines.push(`<meta property="og:locale" content="${attr(input.locale)}">`);
  if (absoluteShareImage) lines.push(`<meta property="og:image" content="${attr(absoluteShareImage)}">`);

  // 3. Twitter Card
  lines.push(`<meta name="twitter:card" content="${absoluteShareImage ? "summary_large_image" : "summary"}">`);
  if (twitterHandle) {
    const handle = twitterHandle.startsWith("@") ? twitterHandle : `@${twitterHandle}`;
    lines.push(`<meta name="twitter:site" content="${attr(handle)}">`);
    lines.push(`<meta name="twitter:creator" content="${attr(handle)}">`);
  }
  if (title) lines.push(`<meta name="twitter:title" content="${attr(title)}">`);
  if (description) lines.push(`<meta name="twitter:description" content="${attr(description)}">`);
  if (absoluteShareImage) lines.push(`<meta name="twitter:image" content="${attr(absoluteShareImage)}">`);

  // 4. Webmaster Verification
  if (googleVerify) lines.push(`<meta name="google-site-verification" content="${attr(googleVerify)}">`);
  if (bingVerify) lines.push(`<meta name="msvalidate.01" content="${attr(bingVerify)}">`);
  if (baiduVerify) lines.push(`<meta name="baidu-site-verification" content="${attr(baiduVerify)}">`);

  // 5. Schema.org JSON-LD
  try {
    const schemaOrg: Record<string, any> = {
      "@context": "https://schema.org",
    };
    if (isArticle) {
      schemaOrg["@type"] = "BlogPosting";
      schemaOrg["headline"] = title;
      if (description) schemaOrg["description"] = description;
      if (canonicalUrl) schemaOrg["mainEntityOfPage"] = { "@type": "WebPage", "@id": canonicalUrl };
      if (absoluteShareImage) schemaOrg["image"] = [absoluteShareImage];
      if (p.created_at) schemaOrg["datePublished"] = new Date(Number(p.created_at) * 1000).toISOString();
      if (p.updated_at) schemaOrg["dateModified"] = new Date(Number(p.updated_at) * 1000).toISOString();
      schemaOrg["author"] = {
        "@type": schemaType === "Organization" ? "Organization" : "Person",
        "name": p.author_name || s.title || "Author",
      };
      schemaOrg["publisher"] = {
        "@type": schemaType === "Organization" ? "Organization" : "Person",
        "name": s.title || "CFPress",
      };
    } else {
      schemaOrg["@type"] = "WebSite";
      schemaOrg["name"] = s.title || "CFPress";
      if (origin) schemaOrg["url"] = origin;
      if (description) schemaOrg["description"] = description;
    }
    lines.push(`<script type="application/ld+json">${JSON.stringify(schemaOrg)}</script>`);
  } catch {}

  return lines.join("\n");
}
/**
 * RSS 2.0 feed for one site, in ONE locale.
 *
 * The bare `/feed.xml` carries the site's **default locale**; `/{locale}/feed.xml`
 * carries that language. A feed is a reading list in one language; interleaving
 * the translations of one article would show a subscriber the same piece twice
 * under two titles.
 *
 * `guid isPermaLink="true"` because the URL is stable (the router derives it
 * from the slug). An aggregator that re-reads the feed matches items by that
 * value, so a permalink guid is what stops every refresh from arriving as a new
 * article.
 *
 * `lastBuildDate` is the newest post's timestamp rather than "now": a feed that
 * claims to have been rebuilt on every request teaches readers to poll it for
 * nothing.
 */
export async function feed(env:Env,request:Request,siteId:string,locale?:string){
 const u=new URL(request.url);
 // An explicit locale (from `/{locale}/feed.xml`) wins; otherwise the site's
 // default language — never a hardcoded one (rule 57).
 const lang=String(locale??"").trim()||await defaultLocale(env,siteId);
 const s=await siteInfo(env,siteId);
 const permSetting = await setting(env, "permalink.structure", DEFAULT_PERMALINK_STRUCTURE, siteId);
 const rows=await env.DB.prepare(
  `SELECT p.id,COALESCE(t.slug,p.slug) AS slug,p.created_at,t.title,t.excerpt
     FROM posts p JOIN post_translations t ON t.post_id=p.id
    WHERE p.site_id=? AND p.type='post' AND p.status='published' AND t.locale=?
    ORDER BY p.created_at DESC LIMIT 50`
 ).bind(siteId,lang).all();
 const items=rows.results as any[];
 const self=`${u.origin}${lang?`/${lang}`:""}/feed.xml`;
 const home=`${u.origin}/${lang}`;
 const body=items.map(r=>{
  const postPath = resolvePostUrl(permSetting, r, { locale: lang, alwaysPrefixLocale: true });
  const link=`${u.origin}${postPath.startsWith("/") ? "" : "/"}${postPath}`;
  return `<item><title>${xml(r.title)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid><pubDate>${new Date(Number(r.created_at)*1000).toUTCString()}</pubDate><description>${xml(r.excerpt)}</description></item>`;
 }).join("");
 const built=items.length?new Date(Number(items[0].created_at)*1000).toUTCString():new Date().toUTCString();
 const doc=`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n<title>${xml(s.title)}</title>\n<link>${xml(home)}</link>\n<description>${xml(s.description)}</description>\n<language>${xml(lang)}</language>\n<lastBuildDate>${built}</lastBuildDate>\n<atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>\n${body}\n</channel>\n</rss>\n`;
 return new Response(doc,{headers:{"Content-Type":"application/rss+xml;charset=UTF-8","Cache-Control":"public,max-age=600"}});
}
