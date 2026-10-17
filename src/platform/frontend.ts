import { Env } from "../shared/types";
import { parseBlocks } from "../rendering/blocks";
import { siteLocales, siteDefaultLocale, TERMINAL_LOCALE } from "./i18n/locale-registry";
import { resolveMetaByPost } from "./post-meta";
import { CORE_PACKS } from "./i18n/core-pack";
import { interpolate, packForLocale } from "./i18n/translate";

export function esc(v:unknown){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))}
/**
 * Read one `settings` row for a site.
 *
 * `siteId` is required. It used to default to `"default"`, which made a
 * forgotten argument silently read the wrong site's settings — invisible on a
 * single-site install and wrong the moment a second site exists.
 */
export async function setting(env:Env,key:string,fallback:string,siteId:string){const r=await env.DB.prepare("SELECT value FROM settings WHERE site_id=? AND key=?").bind(siteId,key).first<any>();return r?.value??fallback}
/**
 * Locales this *site* serves, default first.
 *
 * This used to read the global `locales` table and ignore `siteId` entirely
 * (`void siteId`). That was correct while the dictionary was the only concept —
 * every site saw every language — but it made a per-site language switch
 * impossible to express, and it was a silent multi-site bug waiting for the
 * first install that wanted two sites with different language sets.
 *
 * The switch now lives in `site_locales`; the shape returned here is unchanged
 * (`code` / `name` / `is_default`), with `native_name` and `direction` added for
 * language switchers.
 */
export async function locales(env:Env,siteId:string){return await siteLocales(env,siteId)}
/**
 * The site's default locale code.
 *
 * Front-end URLs may omit the locale segment (`/about` instead of
 * `/en/about`), and those paths must resolve against *some* locale.
 * `site_locales.is_default` is the single source of truth for which one — note
 * this is NOT `locales.is_default`, which describes the platform dictionary and
 * says nothing about any particular site.
 */
export async function defaultLocale(env:Env,siteId:string):Promise<string>{return await siteDefaultLocale(env,siteId)}
export async function siteInfo(env:Env,siteId:string){return {title:await setting(env,"site.title","CFPress",siteId),description:await setting(env,"site.description","",siteId),robots:await setting(env,"seo.robots","index,follow",siteId)}}
/**
 * Load one published object by slug (or any column matched by `type`).
 *
 * The stored `content` column is a raw block-JSON string; templates should not
 * have to parse that, so we also expose `html` — the rendered form of the same
 * blocks — mirroring what `@query` results carry. Without this, a template
 * that reads `post.html` on a single-object page silently renders its empty
 * branch while listings work fine, which is a confusing failure mode.
 */
/**
 * Estimate reading time from rendered HTML at a long-form 220 wpm.
 *
 * Done server-side rather than in the theme's runtime because the template
 * language has no arithmetic, and a JS-only estimate shows the reader a
 * placeholder glyph on first paint. Returning a ready-to-print string keeps
 * the template free of both problems.
 */
export function readingTime(html:string, wpm:number, locale:string){
  const text=String(html).replace(/<[^>]*>/g," ").replace(/&[a-z]+;|&#\d+;/gi," ");
  // Counting whitespace-delimited words reports "1 min read" for a long
  // Chinese article, because CJK text has no spaces. CJK characters are
  // counted separately (at a slower ~350/min) and added to the latin words.
  const cjk=(text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)||[]).length;
  const latin=text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g," ").split(/\s+/).filter(Boolean).length;
  const mins=Math.max(1,Math.round(cjk/350+latin/wpm));
  const pack=packForLocale(CORE_PACKS, locale);
  const fmt=pack?.["core.reading_time.format"]||"{mins} min read";
  return interpolate(fmt, { mins });
}
/**
 * A ready-to-print date for a piece of content, in the reader's language.
 *
 * Formatted server-side for the same reason as `readingTime`: the template
 * language has no arithmetic and no locale formatting, and `date()` emits ISO
 * (`2026-10-08`) which is a machine string, not a masthead. The formatter is
 * memoised per locale because constructing an `Intl.DateTimeFormat` measures
 * ~0.15 ms while reusing one is ~0.002 ms — ten rows would otherwise spend
 * 1.5 ms of a free-plan request's 10 ms CPU budget on nothing.
 *
 * `timeZone: "UTC"` keeps the printed day stable regardless of which edge
 * colo renders the page; a blog's publication date should not shift by a day
 * depending on the reader's latitude.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatDate(secs: unknown, locale: string): string {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return "";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
  let fmt = dateFormatters.get(locale);
  if (!fmt) {
    try { fmt = new Intl.DateTimeFormat(locale, opts); }
    // An unusable tag falls back to the platform's one terminal locale rather
    // than to a second hardcoded "en" — one question, one answer (rule 23).
    catch { fmt = new Intl.DateTimeFormat(TERMINAL_LOCALE, opts); }
    dateFormatters.set(locale, fmt);
  }
  return fmt.format(new Date(n * 1000));
}
/**
 * The first image in a piece of content, for use as its cover.
 *
 * Posts have no cover column, and the six field types cannot honestly express
 * one: `text` is classified as prose and is therefore **forced** to be
 * translatable (rule 41), so a cover declared as `text` would ask an editor for
 * one image per language — a URL is language-neutral data, not a sentence. The
 * image is already in the body, as `core/image` or the first item of a
 * `core/gallery`, so it is derived rather than declared.
 *
 * Returns `""` when there is none, so a template can guard with `{{#if}}`
 * instead of rendering a broken `<img>`.
 */
export function coverFrom(content: unknown): string {
  for (const b of parseBlocks(String(content ?? ""))) {
    const a: any = (b as any).attrs || {};
    if ((b as any).type === "core/image" && a.url) return String(a.url);
    if ((b as any).type === "core/gallery" && Array.isArray(a.items)) {
      const first = a.items.find((x: any) => x && x.url);
      if (first) return String(first.url);
    }
  }
  return "";
}
export async function findContent(env:Env,type:string,slug:string,locale:string,siteId:string){
  // The URL segment is per language: `post_translations.slug` when the
  // translation declares one, else the main-table slug. Matching on the
  // COALESCE (never on `p.slug` alone) is rule 58 — a lookup that skips it
  // 404s every language that named its own slug.
  const row=await env.DB.prepare(`SELECT p.*,t.locale,t.title,t.excerpt,t.content,t.slug AS slug_own FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.type=? AND COALESCE(t.slug,p.slug)=? AND t.locale=? AND p.status='published' LIMIT 1`).bind(siteId,type,slug,locale).first<any>();
  if(row){
    row.slug=row.slug_own||row.slug;
    row.html=row.content?renderBlocks(String(row.content)):"";
    row.reading_time=readingTime(row.html,220,locale);
    row.date_display=formatDate(row.created_at,locale);
    row.cover=coverFrom(row.content);
    row.alternates=await contentAlternates(env,siteId,row.id,row.type);
    // A single object carries the same custom fields a listing does: the
    // templates read `post.meta.category` on both, so only one of them having
    // values was a silent half-answer (the article kicker fell back to its
    // generic label while the card next to it named the category). Resolved
    // through the same ladder as the listing — one definition, two readers.
    const dflt=await defaultLocale(env,siteId);
    const mr=await env.DB.prepare("SELECT post_id, meta_key, locale, meta_value FROM post_meta WHERE post_id=?").bind(row.id).all().catch(()=>({results:[] as any[]}));
    row.meta=resolveMetaByPost((mr.results as any[])??[],locale,dflt).get(row.id)??{};
    const tr=await env.DB.prepare("SELECT t.id, t.taxonomy, t.slug, t.name, t.locale FROM terms t JOIN term_relationships r ON r.term_id=t.id WHERE r.post_id=? AND t.site_id=?").bind(row.id,siteId).all().catch(()=>({results:[] as any[]}));
    const allTerms=(tr.results as any[])??[];
    row.terms=allTerms;
    const tagBase=(await setting(env,"permalink.tag_base","tag",siteId)).replace(/^\/+|\/+$/g,"");
    row.tags=allTerms.filter((t:any)=>t.taxonomy==="tag"||t.taxonomy==="post_tag").map((t:any)=>({...t,url:`/${locale}/${tagBase}/${encodeURIComponent(t.slug)}`}));
  }
  return row;
}

export async function findContentById(env:Env,type:string,id:string,locale:string,siteId:string){
  const row=await env.DB.prepare(`SELECT p.*,t.locale,t.title,t.excerpt,t.content,t.slug AS slug_own FROM posts p JOIN post_translations t ON t.post_id=p.id WHERE p.site_id=? AND p.type=? AND p.id=? AND t.locale=? AND p.status='published' LIMIT 1`).bind(siteId,type,id,locale).first<any>();
  if(row){
    row.slug=row.slug_own||row.slug;
    row.html=row.content?renderBlocks(String(row.content)):"";
    row.reading_time=readingTime(row.html,220,locale);
    row.date_display=formatDate(row.created_at,locale);
    row.cover=coverFrom(row.content);
    row.alternates=await contentAlternates(env,siteId,row.id,row.type);
    const dflt=await defaultLocale(env,siteId);
    const mr=await env.DB.prepare("SELECT post_id, meta_key, locale, meta_value FROM post_meta WHERE post_id=?").bind(row.id).all().catch(()=>({results:[] as any[]}));
    row.meta=resolveMetaByPost((mr.results as any[])??[],locale,dflt).get(row.id)??{};
    const tr=await env.DB.prepare("SELECT t.id, t.taxonomy, t.slug, t.name, t.locale FROM terms t JOIN term_relationships r ON r.term_id=t.id WHERE r.post_id=? AND t.site_id=?").bind(row.id,siteId).all().catch(()=>({results:[] as any[]}));
    const allTerms=(tr.results as any[])??[];
    row.terms=allTerms;
    const tagBase=(await setting(env,"permalink.tag_base","tag",siteId)).replace(/^\/+|\/+$/g,"");
    row.tags=allTerms.filter((t:any)=>t.taxonomy==="tag"||t.taxonomy==="post_tag").map((t:any)=>({...t,url:`/${locale}/${tagBase}/${encodeURIComponent(t.slug)}`}));
  }
  return row;
}
/**
 * The other language versions of the same piece of content, for `hreflang`.
 *
 * Membership is `lang_group` — the same tie the translations endpoint uses —
 * so alternates can never list a language the group does not have. URLs use
 * each version's own slug (rule 58), and the shape matches the sitemap's
 * `/{locale}[/{type}/]/{slug}` convention so a crawler sees one story.
 */
export async function contentAlternates(env:Env,siteId:string,postId:string,type:string){
  const r=await env.DB.prepare(`SELECT t.locale,COALESCE(t.slug,p.slug) AS slug FROM post_translations t JOIN posts p ON p.id=t.post_id WHERE p.site_id=? AND p.type=? AND p.lang_group=(SELECT lang_group FROM posts WHERE id=? AND site_id=?) AND p.status='published' ORDER BY t.locale`).bind(siteId,type,postId,siteId).all();
  return ((r.results as any[])??[]).map(x=>({locale:String(x.locale),url:`/${x.locale}${type==="post"?"/blog/":"/"}${x.slug}`}));
}
/**
 * The site's language switcher: one entry per locale the *site* declares,
 * pointing at the same page in each language.
 *
 * Deliberately built only from the list a caller already resolved site-scoped —
 * a switcher that offers a language the site has not enabled 404s on click
 * (§10 rule 6: no site-blind fallbacks). `restPath` is the page path with any
 * locale prefix already removed (`resolveLocale(...).rest`).
 *
 * `alternates` is `contentAlternates`' output for the object being rendered,
 * and it is what makes the switcher correct on an *article*. Swapping the
 * locale segment is right for a listing — one path, several translations of
 * it — but migration 0016 made the slug per language, so on a translated piece
 * `/en/blog/<zh-slug>` is a 404 and a path-swapping switcher offers a dead
 * link on exactly the pages a reader is most likely to switch on. Where a
 * translation exists its own URL is the only honest target; where it does not,
 * the locale-swapped path stays the fallback and 404s, which is the truth
 * about that piece in that language.
 */
export function langNav(rows:unknown[],currentLocale:string,restPath:string,alternates?:unknown[]){
  const rest=String(restPath??"").replace(/^\/+|\/+$/g,"");
  const own=new Map<string,string>();
  for(const a of (alternates as any[])??[]){
    const code=String(a?.locale??"");const url=String(a?.url??"");
    if(code&&url)own.set(code,url);
  }
  return (rows as any[]).map((l)=>({
    code:String(l.code),
    name:String(l.name??l.code),
    current:String(l.code)===currentLocale,
    url:own.get(String(l.code))??`/${l.code}${rest?"/"+rest:""}`,
  }));
}
// `latestPosts` used to live here and returned only slug/title/excerpt. The
// front page now runs the same query a theme route does (`runThemeQuery`), so
// there is one listing path rather than two that can disagree about what a post
// carries — and a listing that cannot show a date or a cover is not a listing
// anyone wants.
/**
 * Navigation items for one declared menu location. Rule 73 (菜单位置解析必须
 * 确定性): when two menus claim the same location, `ORDER BY id` picks a
 * stable winner — the previous `LIMIT 1` without ordering returned whatever
 * SQLite felt like, so the nav could flip between requests on a site with
 * two header menus.
 *
 * The lookup keeps `site_id = ?` on purpose (§10 rule 6, no site-blind
 * fallbacks): a site with no menu for a location renders no menu, which is
 * correct; finding "any" menu would be cosmetic on a single-site install and
 * a data leak on a multi-site one.
 *
 * ⚠️ `menu_id` is only unique **per site** (`UNIQUE(site_id, id)` on `menus`).
 * Two sites can both have a menu called `primary`, so filtering by `menu_id`
 * alone pulls in the other tenant's items — the menu row being site-scoped
 * does not disambiguate the items; the items carry `site_id` too, so use it.
 */
export async function menusForLocation(env:Env,siteId:string,location:string,locale:string){
  let m:any=null;
  try{
    m=await env.DB.prepare("SELECT id FROM menus WHERE location=? AND site_id=? ORDER BY id LIMIT 1").bind(location,siteId).first<any>();
  }catch{/* menus predates the site_id column on an unmigrated install */}
  if(!m)return[];
  const r=await env.DB.prepare("SELECT * FROM menu_items WHERE menu_id=? AND site_id=? AND (locale IS NULL OR locale='' OR locale=?) ORDER BY sort_order,id").bind(m.id,siteId,locale).all();
  return r.results as any[];
}

/**
 * One widget instance rendered to HTML. Rule 74: every read is site-scoped —
 * `widget_instances` went install-wide → per-site in 0020 because the only
 * read path that existed had no tenant filter and every site's sidebar showed
 * every site's widgets.
 *
 * Locale semantics mirror `menu_items`: `locale=''` renders in every
 * language, a specific locale renders only on that language's pages. No
 * cross-language fallback on purpose — a widget that says "关注公众号" must
 * not appear on the English pages just because nobody wrote an English body.
 */
async function renderWidget(env:Env,siteId:string,locale:string,w:any):Promise<string|null>{
  let cfg:any={};try{cfg=JSON.parse(String(w.config||"{}"))}catch{}
  const title=w.title?`<h6 class="widget-title">${esc(String(w.title))}</h6>`:"";
  const slot=esc(String(w.sidebar||"sidebar"));
  const wid=esc(String(w.id||""));
  const type=String(w.widget_type||"text").replace(/^core\./,"");

  if(type==="text") return `<section class="widget widget-text" data-slot="${slot}" data-widget="${wid}">${title}<p>${esc(String(cfg.body||""))}</p></section>`;
  if(type==="html") return `<section class="widget widget-html" data-slot="${slot}" data-widget="${wid}">${title}${String(cfg.body||"")}</section>`;
  if(type==="recent-posts"){
    const n=Math.min(20,Math.max(1,Math.round(Number(cfg.count||5))));
    const r=await env.DB.prepare("SELECT p.slug, COALESCE(t.title,p.slug) AS title FROM posts p LEFT JOIN post_translations t ON t.post_id=p.id AND t.locale=? WHERE p.site_id=? AND p.type='post' AND p.status='published' ORDER BY p.created_at DESC LIMIT ?").bind(locale,siteId,n).all();
    const lis=((r.results as any[])??[]).map(x=>`<li><a href="/${locale}/blog/${esc(String(x.slug))}">${esc(String(x.title))}</a></li>`).join("");
    return `<section class="widget widget-recent" data-slot="${slot}" data-widget="${wid}">${title}<ul class="widget-list">${lis}</ul></section>`;
  }
  // menu — the widget pins a menu by id; the items carry site_id (rule 6).
  if(type==="menu"){
    const r=await env.DB.prepare("SELECT title,url FROM menu_items WHERE site_id=? AND menu_id=? AND (locale IS NULL OR locale='' OR locale=?) ORDER BY sort_order,id").bind(siteId,String(cfg.menu_id||""),locale).all();
    const lis=((r.results as any[])??[]).map(x=>`<li><a href="${esc(String(x.url))}">${esc(String(x.title))}</a></li>`).join("");
    return `<section class="widget widget-menu" data-slot="${slot}" data-widget="${wid}">${title}<ul class="widget-list">${lis}</ul></section>`;
  }
  // search — interactive site search widget
  if(type==="search"){
    const ph=esc(String(cfg.placeholder||"Search..."));
    return `<section class="widget widget-search" data-slot="${slot}" data-widget="${wid}">${title}<form role="search" method="get" action="/search" class="search-form"><input type="search" name="q" placeholder="${ph}" class="search-field" /><button type="submit" class="search-submit">Search</button></form></section>`;
  }
  // categories — list of taxonomy categories
  if(type==="categories"||type==="category"||String(w.widget_type)==="core.categories"){
    const catBase=(await setting(env,"permalink.category_base","category",siteId)).replace(/^\/+|\/+$/g,"");
    const r=await env.DB.prepare("SELECT slug, name, count FROM terms WHERE site_id=? AND (taxonomy='category' OR taxonomy='categories') AND (locale='' OR locale=?) ORDER BY name").bind(siteId,locale).all<any>().catch(()=>({results:[]}));
    const terms=((r.results as any[])??[]);
    const showCount=cfg.show_count===undefined||cfg.show_count===null||Number(cfg.show_count)===1||cfg.show_count===true;
    const localePrefix=locale?`/${locale}`:"";
    const lis=terms.map(x=>{
      const countHtml=showCount?` <span class="count">(${Number(x.count||0)})</span>`:"";
      return `<li><a href="${localePrefix}/${catBase}/${esc(String(x.slug))}">${esc(String(x.name))}</a>${countHtml}</li>`;
    }).join("");
    const content=lis
      ? `<ul class="widget-list">${lis}</ul>`
      : `<p class="empty-categories" style="font-size:.85rem;color:var(--muted,#888);margin:.5rem 0;">No categories found.</p>`;
    return `<section class="widget widget-categories" data-slot="${slot}" data-widget="${wid}">${title}${content}</section>`;
  }
  // tag-cloud — dynamic tag cloud widget supporting i18n & theme taxonomies
  if(type==="tag-cloud"||type==="tags"||String(w.widget_type)==="core.tag-cloud"){
    const tax=String(cfg.taxonomy||"tag").trim()||"tag";
    const maxCount=Math.min(100,Math.max(1,Math.round(Number(cfg.count||30))));
    const orderBy=String(cfg.order_by||"count")==="name"?"name ASC":"count DESC, name ASC";
    const tagBase=(await setting(env,"permalink.tag_base","tag",siteId)).replace(/^\/+|\/+$/g,"");
    const r=await env.DB.prepare(`SELECT id, name, slug, count FROM terms WHERE site_id=? AND (taxonomy=? OR taxonomy='tag' OR taxonomy='post_tag') AND (locale='' OR locale=?) AND count>0 ORDER BY ${orderBy} LIMIT ?`).bind(siteId,tax,locale,maxCount).all<any>().catch(()=>({results:[]}));
    const terms=((r.results as any[])??[]);
    if(terms.length===0){
      return `<section class="widget widget-tag-cloud" data-slot="${slot}" data-widget="${wid}">${title}<p class="empty-tag-cloud">No tags found.</p></section>`;
    }
    const counts=terms.map(t=>Number(t.count||1));
    const minC=Math.min(...counts);
    const maxC=Math.max(...counts);
    const spread=maxC-minC||1;
    const tagsHtml=terms.map(t=>{
      const c=Number(t.count||1);
      const weight=1+Math.round(((c-minC)/spread)*4);
      const fontSize=12+Math.round(((c-minC)/spread)*8);
      const href=`/${locale}/${tagBase}/${encodeURIComponent(t.slug)}`;
      return `<a href="${esc(href)}" class="tag-cloud-link tag-link-${esc(String(t.id))} tag-weight-${weight}" style="font-size: ${fontSize}px;" title="${esc(String(t.name))} (${c})">${esc(String(t.name))} <span class="count">(${c})</span></a>`;
    }).join(" ");
    return `<section class="widget widget-tag-cloud" data-slot="${slot}" data-widget="${wid}">${title}<div class="tagcloud cf-tag-cloud">${tagsHtml}</div></section>`;
  }
  // custom widget — rendered via custom_widget_types template
  if(String(w.widget_type).startsWith("custom.")){
    const cType=await env.DB.prepare("SELECT template FROM custom_widget_types WHERE site_id=? AND type=? LIMIT 1").bind(siteId,w.widget_type).first<any>();
    if(cType && cType.template){
      let rendered=String(cType.template);
      for(const [k,v] of Object.entries(cfg)){
        const valStr=esc(String(v??""));
        rendered=rendered.replace(new RegExp(`{{\\s*${k}\\s*}}`,"g"),valStr).replace(new RegExp(`{{\\s*settings\\.${k}\\s*}}`,"g"),valStr);
      }
      return `<section class="widget widget-custom" data-slot="${slot}" data-widget="${wid}">${title}${rendered}</section>`;
    }
  }
  // theme widget / block
  if(String(w.widget_type).startsWith("theme.")){
    const bName=String(w.widget_type).replace(/^theme\./,"");
    const tb=await env.DB.prepare("SELECT template FROM theme_blocks WHERE site_id=? AND name=? LIMIT 1").bind(siteId,bName).first<any>();
    if(tb && tb.template){
      return `<section class="widget widget-theme" data-slot="${slot}" data-widget="${wid}">${title}${String(tb.template)}</section>`;
    }
  }
  // plugin widget: adinsert
  if(type==="plugin.adinsert" || String(w.widget_type)==="plugin.adinsert"){
    const blockNo=Math.max(1,Math.round(Number(cfg.block_no||1)));
    try{
      const blk=await env.DB.prepare("SELECT code, alignment FROM plugin_adinsert_blocks WHERE site_id=? AND block_no=? AND enabled=1 LIMIT 1").bind(siteId,blockNo).first<any>();
      if(blk && blk.code){
        let style="margin: 12px 0; max-width: 100%; box-sizing: border-box;";
        if(blk.alignment==="center"){
          style="text-align: center; margin: 16px auto; display: flex; flex-direction: column; align-items: center; justify-content: center; clear: both; max-width: 100%; box-sizing: border-box;";
        }else if(blk.alignment==="left"){
          style="text-align: left; margin: 16px 0; clear: both; max-width: 100%; box-sizing: border-box;";
        }else if(blk.alignment==="right"){
          style="text-align: right; margin: 16px 0; clear: both; max-width: 100%; box-sizing: border-box;";
        }else if(blk.alignment==="float_left"){
          style="float: left; margin: 0 16px 14px 0; max-width: 50%; clear: left; box-sizing: border-box;";
        }else if(blk.alignment==="float_right"){
          style="float: right; margin: 0 0 14px 16px; max-width: 50%; clear: right; box-sizing: border-box;";
        }
        return `<section class="widget widget-adinsert" data-slot="${slot}" data-widget="${wid}">${title}<div class="cfpress-adinsert-block" style="${style}">${blk.code}</div></section>`;
      }
    }catch{}
  }
  return null;
}

/**
 * Enabled widgets of a site, rendered and grouped by sidebar. The keys are
 * the sidebar ids the theme declares (`sidebars[]` in its manifest); a
 * sidebar with no widgets has no key, so templates can `{{#if …}}` on it.
 */
export async function widgetGroups(env:Env,siteId:string,locale:string):Promise<Record<string,string>>{
  let rows:any[]=[];
  try{
    const r=await env.DB.prepare("SELECT * FROM widget_instances WHERE site_id=? AND enabled=1 AND (locale='' OR locale=?) ORDER BY sidebar,sort_order,id").bind(siteId,locale).all();
    rows=(r.results as any[])??[];
  }catch{/* pre-0020 install without the rebuilt table */}
  const groups:Record<string,string>={};
  for(const w of rows){
    const html=await renderWidget(env,siteId,locale,w).catch(()=>null);
    if(!html)continue;
    const sb=String(w.sidebar||"sidebar");
    groups[sb]=(groups[sb]||"")+html;
  }
  return groups;
}
export function renderBlocks(content:string){
 return parseBlocks(content).map((b:any)=>{const a=b.attrs||{};switch(b.type){
 case"core/paragraph":return`<p>${esc(a.text||"")}</p>`;case"core/heading":return`<h2>${esc(a.text||"")}</h2>`;case"core/list":return`<ul>${String(a.text||"").split(/\n/).filter(Boolean).map((x:string)=>`<li>${esc(x)}</li>`).join("")}</ul>`;
 case"core/image":return a.url?`<figure><img src="${esc(a.url)}" alt="${esc(a.alt||"")}" loading="lazy"></figure>`:"";
 case"core/gallery":return`<div class="gallery">${(Array.isArray(a.items)?a.items:[]).map((x:any)=>`<img src="${esc(x.url||"")}" alt="${esc(x.alt||"")}" loading="lazy">`).join("")}</div>`;
 case"core/quote":return`<blockquote>${esc(a.text||"")}</blockquote>`;case"core/code":return`<pre><code>${esc(a.text||"")}</code></pre>`;
 case"core/button":return`<p><a class="wp-button" href="${esc(a.url||"#")}">${esc(a.text||"Button")}</a></p>`;case"core/separator":return`<hr>`;
 case"core/html":return String(a.html||"");case"core/group":return`<div class="wp-group">${(b.content||[]).map((x:any)=>renderBlocks(JSON.stringify([x]))).join("")}</div>`;
 case"core/columns":return`<div class="wp-columns">${(b.content||[]).map((x:any)=>`<div>${renderBlocks(JSON.stringify([x]))}</div>`).join("")}</div>`;default:return"";}}).join("");
}
