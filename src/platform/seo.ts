import {Env} from "../shared/types";
import {siteInfo,locales,defaultLocale} from "./frontend";
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
 // Rule 58: each locale's URL uses that locale's own slug when it has one.
 const rows=await env.DB.prepare(`SELECT p.type,COALESCE(t.slug,p.slug) AS slug,t.locale,p.updated_at FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.status='published' LIMIT 5000`).bind(siteId).all();
 // The locale homepages get a `lastmod` too: a sitemap that dates only the
 // leaves tells a crawler nothing about when the index changed.
 const newest=await env.DB.prepare(`SELECT MAX(updated_at) AS m FROM posts WHERE site_id=? AND status='published'`).bind(siteId).first<any>();
 const homeMod=newest?.m?`<lastmod>${new Date(Number(newest.m)*1000).toISOString()}</lastmod>`:"";
 const out:string[]=(ls as any[]).map(l=>`<url><loc>${xml(`${url.origin}/${l.code}`)}</loc>${homeMod}</url>`);
 for(const r of rows.results as any[])out.push(`<url><loc>${xml(`${url.origin}/${r.locale}/${r.type==="post"?"blog/":""}${r.slug}`)}</loc><lastmod>${new Date(r.updated_at*1000).toISOString()}</lastmod></url>`);
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${out.join("")}</urlset>`,{headers:{"Content-Type":"application/xml;charset=UTF-8"}})
}
export async function robots(env:Env,request:Request,siteId:string){const u=new URL(request.url);return new Response(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${u.origin}/sitemap.xml\n`,{headers:{"Content-Type":"text/plain;charset=UTF-8"}})}
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
 const rows=await env.DB.prepare(
  `SELECT COALESCE(t.slug,p.slug) AS slug,p.created_at,t.title,t.excerpt
     FROM posts p JOIN post_translations t ON t.post_id=p.id
    WHERE p.site_id=? AND p.type='post' AND p.status='published' AND t.locale=?
    ORDER BY p.created_at DESC LIMIT 50`
 ).bind(siteId,lang).all();
 const items=rows.results as any[];
 const self=`${u.origin}${lang?`/${lang}`:""}/feed.xml`;
 const home=`${u.origin}/${lang}`;
 const body=items.map(r=>{
  const link=`${u.origin}/${lang}/blog/${r.slug}`;
  return `<item><title>${xml(r.title)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid><pubDate>${new Date(Number(r.created_at)*1000).toUTCString()}</pubDate><description>${xml(r.excerpt)}</description></item>`;
 }).join("");
 const built=items.length?new Date(Number(items[0].created_at)*1000).toUTCString():new Date().toUTCString();
 const doc=`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n<title>${xml(s.title)}</title>\n<link>${xml(home)}</link>\n<description>${xml(s.description)}</description>\n<language>${xml(lang)}</language>\n<lastBuildDate>${built}</lastBuildDate>\n<atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>\n${body}\n</channel>\n</rss>\n`;
 return new Response(doc,{headers:{"Content-Type":"application/rss+xml;charset=UTF-8","Cache-Control":"public,max-age=600"}});
}
