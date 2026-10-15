import{Env}from "./shared/types";import{handleApi,handleFrontApi,maybeSeedDemoContent}from "./api";import{findContent,contentAlternates,siteInfo,locales,defaultLocale}from "./platform/frontend";import{robots,sitemap,feed}from "./platform/seo";import{seedBundledExtensions,bootPluginRuntime,doAction,applyFilters,renderShortcodes}from "./extensions/plugin/runtime";import{setPluginTableSync}from "./extensions/plugin/menus";import{syncOwnerTables}from "./extensions/theme/tables";import{setHostHooks}from "./extensions/contract/hooks";import{renderThemePage,runThemeQuery,activeTheme,type ThemeRenderOptions}from "./extensions/theme/runtime-declarative";import{tryRenderWithThemeWorker,handleThemeApi}from "./extensions/theme/runtime-worker";import{processScheduled}from "./shared/scheduler";import{resolveSite,siteListMemo,listSites,resetSiteListMemo}from "./platform/sites";
// The media read path's three gates (tenant / session / owner) live in one
// module so this route and the admin media API cannot answer differently.
import{currentUser,loginRequest}from "./platform/auth";import{adminPath,resetAdminPathMemo}from "./platform/settings";import{readMediaPolicy,mediaReadDecision}from "./platform/media-policy";import{isRemoteObjectKey}from "./platform/media-hosts";import{listRoutes,findPostTypeBySlug,listPostTypes}from "./extensions/theme/capabilities";
// Rule 4 forbids `plugin/` from importing `theme/`, so the bundled-theme
// seeder cannot install what it registers. This module is the one place
// allowed to know both layers, so the boot sequence chains them: register the
// theme, then make it *own* what it declares. Without the second half a fresh
// install renders the bundled theme while the theme owns nothing.
import{ensureThemeCapabilities}from "./extensions/theme/capabilities";
import{bootstrapAdmin}from "./platform/auth";
import{resolveLocale,langFromUrl,langFromCookie,langCookie}from "./platform/i18n/resolve";import{setPackProviders}from "./platform/i18n/packs";import{themePackProvider}from "./extensions/theme/packs";import{pluginPackProvider}from "./extensions/plugin/packs";
// A theme-owned table is read through the same facade the admin screens use.
// `resolveTableForSite` lives there precisely so that this route and the
// generated admin list cannot disagree about which physical table a logical
// name means — see the comment on it in `table-facade.ts`.
import{resolveTableForSite,tableBySlug,tableById,tableList}from "./extensions/theme/table-facade";

let booted=false;

/**
 * Render a page, preferring the theme's own Worker when it ships one.
 *
 * A worker-runtime theme gets first crack at every front-end page; anything it
 * cannot or should not handle (no LOADER binding, module failed to boot, 5xx,
 * thrown exception) silently falls through to the declarative renderer, so a
 * broken theme never takes the site down.
 */
async function renderPage(env:Env,o:ThemeRenderOptions,request:Request){
  // The origin a page has to publish about itself — `rel=canonical`, `og:url`,
  // the feed link. Derived here rather than at the nine call sites so `path`
  // and `origin` can never come from two different requests.
  o = { ...o, origin: new URL(request.url).origin, request };
  const theme=await activeTheme(env,o.siteId);
  const viaWorker=await tryRenderWithThemeWorker(env,theme,{
    request,
    kind:String(o.kind),
    siteId:o.siteId,
    scope:{title:o.title,description:o.description,path:o.path,locale:o.locale,postType:o.postType,slug:o.slug,extra:o.extra},
  }).catch((e)=>{
    // A throw here used to be invisible: `.catch(() => null)` fell back to the
    // declarative renderer with no trace, so the site looked like a theme that
    // "just doesn't work". Log it; the page still renders.
    console.error("theme worker render failed, falling back:", e && e.message ? e.message : e);
    return null;
  });
  if(viaWorker)return{html:viaWorker.html,template:`worker:${theme.name}`,tried:[] as string[],status:viaWorker.status};
  const r=await renderThemePage(env,o);
  return{html:r.html,template:r.template,tried:r.tried,status:200,error:r.error};
}

/**
 * Serve a media object.
 *
 * Deliberately routed **after** site resolution (it used to be matched near the
 * top of the router, before the site was known and before any authentication):
 * the object key carries its tenant in the `uploads/{siteId}/` segment, and
 * nothing about a request may be trusted over that segment. Serving straight
 * out of R2 made a key minted for one site readable on another site's host and
 * readable by an anonymous visitor — the tenant axis of `media_files` had no
 * enforcement on its only public door.
 *
 * Three gates, all answered by `platform/media-policy.ts` so this route and the
 * admin API cannot disagree: the key must belong to the resolved site, the
 * policy may require a session, and under owner isolation the requester must be
 * the uploader (legacy `uploaded_by IS NULL` rows are grandfathered site-wide).
 *
 * Every refusal is a plain 404, never 403: a 403 would confirm that a key
 * exists and belongs to somebody else.
 *
 * `key` comes from the *stripped* path, so a site mounted on a path prefix
 * (`/shop/media/…`) resolves the same key as one on its own host.
 */
async function media(env:Env,request:Request,path:string,siteId:string){
 const raw=path.slice("/media/".length);
 let key:string;
 try{ key=decodeURIComponent(raw); }catch{ return new Response("Not found",{status:404}); }
 if(!key)return new Response("Not found",{status:404});
 // Read the policy first: under `isolation:"site"` with no session requirement
 // there is no user to look up, and this route is on the critical path of every
 // image the site serves.
 const policy=await readMediaPolicy(env,siteId);
 const needUser=policy.requireSession||policy.isolation==="owner";
 const user=needUser?await currentUser(env,request).catch(()=>null):null;
 const decision=await mediaReadDecision(env,siteId,key,user?.id??null,policy);
 if(!decision.allow)return new Response("Not found",{status:404});
 // Third-party bytes: the row (not R2) knows the vendor URL. The redirect
 // happens *after* the same three gates above, so a remote file is exactly
 // as reachable as an R2 file — no more, no less (rule 60b). Only remote
 // keys pay for the row lookup; the R2 hot path below is untouched.
 if(isRemoteObjectKey(key,siteId)){
 const row=await env.DB.prepare("SELECT remote_url FROM media_files WHERE site_id=? AND object_key=? LIMIT 1").bind(siteId,key).first<any>();
 const target=String(row?.remote_url??"");
 // Never redirect to a non-https target: the column is written from vendor
 // responses, and an open redirector here would launder any URL through
 // this install's domain.
 if(!/^https:\/\//.test(target))return new Response("Not found",{status:404});
 return new Response(null,{status:302,headers:{Location:target,"Cache-Control":"public, max-age=3600"}});
 }
 const o=await env.MEDIA?.get(key);
 if(!o)return new Response("Not found",{status:404});
 const h=new Headers();o.writeHttpMetadata(h);h.set("ETag",o.httpEtag);
 return new Response(o.body,{headers:h});
}

function htmlResponse(html:string,template:string,status:number,siteId:string,setCookie?:string|null){
  const h:Record<string,string>={"Content-Type":"text/html;charset=UTF-8","Cache-Control":"public,max-age=60","X-CFPress-Template":template,"X-CFPress-Site":siteId};
  if(setCookie)h["Set-Cookie"]=setCookie;
  return new Response(html,{status,headers:h});
}

/**
 * Does this request path address the front-end API, and under which prefix?
 *
 * Returns the path *relative to the site mount* (`/api/v1/front/…`), or `null`
 * when the path is not a front-API request at all.
 *
 * This is deliberately syntactic — it only recognises the `/api/v1/front/`
 * segment and returns everything from there on. Which *site* it belongs to is
 * `resolveSite`'s job, and the two are kept apart because the front API is
 * reached both ways: on a bare `/api/v1/front/…` (the default site) and on a
 * path-prefixed site (`/shop/api/v1/front/…`). Matching the segment rather
 * than a fixed offset is what lets both work without a second router — the
 * bug this replaces was a first version that only matched the bare path, so a
 * prefixed site could render its login form and never submit it.
 */
function frontApiRelPath(pathname:string):string|null{
  const i=pathname.indexOf("/api/v1/front/");
  if(i<0)return null;
  return pathname.slice(i);
}

/** Match a theme-declared route against a path. `:param` captures a segment. */
function matchRoute(routePath:string,path:string):{params:Record<string,string>}|null{
  if(routePath===path)return{params:{}};
  const rp=routePath.split("/").filter(Boolean),pp=path.split("/").filter(Boolean);
  if(rp.length!==pp.length)return null;
  const params:Record<string,string>={};
  for(let i=0;i<rp.length;i++){
    const seg=rp[i];
    if(seg.startsWith(":")){
      const name=seg.slice(1);
      if(!pp[i])return null;
      params[name]=decodeURIComponent(pp[i]);
    }else if(seg!==pp[i])return null;
  }
  return{params};
}

/**
 * Serve the admin SPA's shell with a server-injected base.
 *
 * The shell (`/admin/index.html`) is authored with `/admin/...` asset URLs and
 * the SPA (`js/state.js`) builds API URLs from `/api/v1/`. Both are correct only
 * while the prefix is exactly `/admin` — the moment an operator moves the admin
 * (that is the whole point of `admin.path`), every one of those absolute URLs
 * points at a prefix that no longer exists, and the SPA loads a blank page with
 * 404s in the console.
 *
 * So the shell is not served as a static file: it is fetched, the three asset
 * paths and a `<script>window.CFP_ADMIN_BASE="…"</script>` tag are substituted,
 * and the result is returned. The SPA reads the global rather than hard-coding
 * the prefix, which is the *only* place the prefix has to be known.
 *
 * The substitutions are anchored on the literal `/admin/` that appears in the
 * shell — and `architecture.test.mjs` asserts the shell still contains those
 * literals, so a shell edited to hard-code something else (or to use a bare
 * relative path that this rewrite does not touch) fails loudly rather than
 * shipping a broken admin.
 */
async function serveAdminIndex(env:Env,adminBase:string,u:URL){
  const res=await env.ASSETS.fetch(new Request(new URL("/admin/index.html",u.origin),{headers:{Accept:"text/html"}}));
  const html=await res.text();
  // `CFP_ADMIN_BASE` is the admin prefix itself, never "", because the SPA
  // builds both its asset and its API URLs from it (`{base}/api/v1/...`) and
  // the admin API lives *under* the prefix. The shell's own `/admin/` asset
  // URLs are rewritten to the prefix for the same reason.
  const rewritten=html
    .replaceAll('"/admin/',`"${adminBase}/`)
    .replace("</head>",`<script>window.CFP_ADMIN_BASE=${JSON.stringify(adminBase)};</script>\n</head>`);
  const h=new Headers(res.headers);
  h.set("Content-Type","text/html;charset=UTF-8");
  // The shell carries the prefix, so it must not be cached across a prefix
  // change; the assets it points at stay cacheable on their own.
  h.set("Cache-Control","no-cache");
  // …and it must not be indexed. `robots.txt` deliberately names no admin
  // prefix (naming the live one would advertise it — see `robots()`), so this
  // header is what keeps compliant bots from listing the login page. It rides
  // the shell because the shell is the only admin URL a bot can reach without
  // a session; the API answers JSON, which is not indexable content.
  h.set("X-Robots-Tag","noindex, nofollow");
  return new Response(rewritten,{status:res.status,headers:h});
}

/**
 * Front-end router.
 *
 * URL shape (after site resolution, one or many sites per install):
 *   /{locale}                  -> theme route for "/" if declared, else home
 *                                 (front-page | home | index)
 *   /{locale}/blog/{slug}      -> single post
 *   /{locale}/{type}/{slug}    -> single of a theme-declared post type
 *   /{locale}/{slug}           -> static page (page-{slug} | page | single | index)
 *   theme route match          -> theme-declared route
 *   anything unmatched         -> 404 template
 *
 * Everything renders through the theme runtime so templates resolve against
 * the WordPress-style hierarchy in `template-resolver.ts`.
 */
export default{async fetch(request:Request,env:Env,ctx:ExecutionContext){
 // The site list is memoised so one request resolves it at most once. The memo
 // is keyed by `env`, which outlives a request, so it has to be dropped here —
 // otherwise a site created in the admin never resolves on the front end until
 // the isolate recycles (see `resetSiteListMemo`).
 resetSiteListMemo(env);resetAdminPathMemo(env);
 if(!booted){booted=true;ctx.waitUntil((async()=>{
   try{
     // Register the bundled themes, *then* install their declarations. The
     // order matters: `ensureThemeCapabilities` resolves the active theme
     // through `theme_installs`, which the seeding call is what creates.
     await seedBundledExtensions(env);
     await ensureThemeCapabilities(env);
     // Demo content ships with the install, not with a terminal script: a
     // fresh database gets the bilingual demo posts and the About page on its
     // first request (the hook decides once, via a settings stamp — it never
     // resurrects content on a site that already has its own). The owner is
     // bootstrapped first because demo posts are staff-authored.
     await bootstrapAdmin(env);
     await maybeSeedDemoContent(env);
   }catch{
     // A failed seed leaves the install exactly as a fresh one was before
     // these calls existed, which is a state the front end already renders.
   }
 })())}
 // Join the two halves of the extension layer.
 //
 // `index.ts` is the only module allowed to import both `theme/` and
 // `plugin/`; the theme layer depends on the `HostHooks` *interface* in
 // `extensions/contract/hooks.ts` and never on the plugin implementation. This
 // is the single place the two are connected, which is what keeps a theme and
 // a plugin independently installable.
 setHostHooks({
   doAction:(name,c,data)=>doAction(name,c,data),
   applyFilters:(name,c,data)=>applyFilters(name,c,data),
   renderShortcodes:(env2,html,siteId)=>renderShortcodes(env2,html,siteId),
   boot:(env2)=>bootPluginRuntime(env2),
 });
 // Same dependency-inversion trick for the UI dictionary. `platform/i18n`
 // owns the *stack* (core → plugin → theme → DB override) but may not import
 // `extensions/` to fetch layers ② and ③, so the two providers are handed over
 // here — the one module allowed to know every layer. Without them the stack is
 // core + overrides, which reads exactly like "nothing is translating".
 setPackProviders({ theme: themePackProvider, plugin: pluginPackProvider });
 // Third application of the same trick: a plugin *declares* `tables[]`, but the
 // DDL generator lives in `theme/tables.ts` and rule 3 forbids `plugin/` from
 // importing `theme/`. So the plugin layer exposes the hook and this module —
 // the only one allowed to know both — supplies the implementation. It fans out
 // over the active sites because a plugin's tables are per site (the registry
 // is keyed by `site_id`), unlike its menus which are install-wide.
 setPluginTableSync(async(env2,pluginName,manifest)=>{
   let total=0;
   for(const site of await listSites(env2)){
     total+=(await syncOwnerTables(env2,"plugin",pluginName,manifest,site.id)).length;
   }
   return total;
 });
 const u=new URL(request.url);
 const adminBase=await adminPath(env);const p=u.pathname;
 if(p===adminBase)return Response.redirect(new URL(adminBase+"/",u.origin).toString(),301);
 // The directory itself: the assets binding serves `/admin/index.html` here.
 // Requesting the index file explicitly would make the binding 307 back to
 // this very path - a redirect loop (found the first time this ran elevated).
 // The directory form is rewritten to the real asset directory (`/admin/`):
 // with a custom prefix the request path (`/manage/`) has no assets behind it.
 // Rewriting to `/admin/` (not `/admin/index.html`) is what avoided the loop.
 if(p===adminBase+"/")return serveAdminIndex(env,adminBase,u);
 // The admin API lives **under** the prefix: the whole API surface is hidden
 // with the admin, not just the login door. The prefix is stripped and the
 // request re-issued at the same path minus the prefix — which is the shape
 // `handleApi` already speaks (`/api/v1/...`). One API implementation, reached
 // by two prefixes; the reconstructed URL must therefore drop `adminBase`
 // exactly, with nothing prepended (prepending `/api` here would double it).
 //
 // ⚠️ `u.search` is carried across, and that is not a detail. The first version
 // rebuilt the URL from `u.origin` alone, so **every query parameter vanished**
 // on the prefixed route: `?site=` (the tenant selector), `?withCounts=1`,
 // `?locale=`, pagination — all silently dropped, on every admin request that
 // used one, while the unprefixed `/api/…` route kept working. The admin is
 // addressed through the prefix, so "some parameters work and others do not"
 // was the whole surface. A route that rewrites a URL has to carry *all* of it,
 // not just the path.
 //
 // ⚠️ Do **not** write a slash-star glob in this comment: `blankComments()` in
 // the architecture suite strips block comments with a non-greedy regex, and a
 // stray opener swallows every line down to the next real close — which blanked
 // this entire routing block and turned six guards red on correct code. Same
 // trap, same line, as the note further down this file.
 if(p===adminBase+"/api/v1/auth/login"&&request.method==="POST")return loginRequest(env,request,adminBase);
 if(p.startsWith(adminBase+"/api/"))return handleApi(env,new Request(new URL(p.slice(adminBase.length)+u.search,u.origin),request));
 if(p.startsWith(adminBase+"/"))return env.ASSETS.fetch(new Request(new URL("/admin"+p.slice(adminBase.length),u.origin),request));
 // ⚠️ 旧入口与旧登录端点一律 404：重定向会把新路径交给扫描器。
 // （admin.path 仍是 /admin 时二者就是本尊，此条不适用。）
 if(adminBase!=="/admin"&&(p==="/admin"||p==="/admin/"))return new Response("Not Found",{status:404});
 if(p==="/api/v1/auth/login")return new Response("Not Found",{status:404});
 if(p.startsWith("/api/"))return handleApi(env,request);
 // Sandboxed theme Workers read data exclusively through this endpoint.
 if(u.pathname.startsWith("/__cfpress/theme-api/"))return handleThemeApi(env,request);
 // The admin SPA and any other static asset belong to the asset layer. This is
 // stated explicitly rather than left to the locale parser, which previously
 // doubled as the asset bail-out — so that removing the locale prefix from the
 // front-end router did not also take `/admin/` down with it.
 //
 // ⚠️ Gated on `adminBase === "/admin"`. With a custom prefix the `/admin/…`
 // assets must **404** exactly like the old `/admin` route does: leaving them
 // served is how the hidden admin stays discoverable — a scanner that finds
 // `/admin/admin.js` has found the admin, prefix or no prefix.
 if(adminBase==="/admin"&&(u.pathname==="/admin"||u.pathname.startsWith("/admin/")))return env.ASSETS.fetch(request);
 // ⚠️ The front-end API is POST-heavy, so it must be routed **before** the
 // method bail-out below — that bail-out sends every non-GET to the asset
 // layer, which is right for a static site and wrong for a login endpoint. The
 // check is done on the *unprefixed* path shape (`/api/v1/front/…`) and on the
 // site-prefixed shape (`/{prefix}/api/v1/front/…`); the site is resolved
 // first so a member authenticates against their own tenant, never the default
 // one. `/api/v1/front/…` with no prefix is the default site.
 {
   const frontRel=frontApiRelPath(u.pathname);
   if(frontRel!==null){
     const sites=await siteListMemo(env);
     const r=await resolveSite(env,u,sites);
     return handleFrontApi(env,request,r.siteId,frontRel);
   }
 }
 if(request.method!=="GET")return env.ASSETS.fetch(request);

 // Resolve which site this request belongs to (host or path prefix).
 const sites=await siteListMemo(env);
 const resolved=await resolveSite(env,u,sites);
 const siteId=resolved.siteId;
 const path=resolved.path;

 // SEO endpoints are per-site: they must be routed *after* site resolution,
 // otherwise `/sitemap.xml` on a second site lists the default site's URLs.
 // They are also more specific than the locale-prefix rules below, so they are
 // matched here by exact path, not by parsing a locale segment.
 if(path==="/sitemap.xml")return sitemap(env,request,siteId);
 if(path==="/robots.txt")return robots(env,request,siteId);
 // `/rss.xml` is an alias: readers and humans both guess at this name, and
 // answering 404 for the more obvious of the two is a needless dead end.
 // The bare feed serves the site's default language; `/{locale}/feed.xml`
 // (routed after locale resolution, below) serves that language's feed.
 if(path==="/feed.xml"||path==="/rss.xml"||path==="/atom.xml")return feed(env,request,siteId);
 // Media is per-site too, and for the same reason: the key embeds its tenant,
 // so the site has to be resolved before the key can be judged. See `media()`.
 if(path.startsWith("/media/"))return media(env,request,path,siteId);

 // Front-end paths may or may not carry a locale prefix. `/{locale}/...` is
 // explicit; anything else is resolved against the site's *default* locale.
 //
 // This used to be a bare regex that bailed out to `env.ASSETS.fetch()` for
 // any path without a two-letter first segment. That made the site's own root
 // URL unreachable — `/` and `/about` were silently served by the static
 // asset layer instead of the theme, which read as "the theme does not work".
 // A URL prefix is a routing concern, so it is decided here, not by whether
 // an unrelated asset happens to exist at that path.
 //
 // The priority order (path → `?lang=` → cookie → site default) and the
 // "explicit prefix means 404, everything else may fall through" rule now live
 // in `platform/i18n/resolve.ts`, because they are language policy rather than
 // routing and the admin API needs the same answers.
 const known=await locales(env,siteId) as any[];
 const knownCodes=known.map(l=>String(l?.code??"")).filter(Boolean);
 const match=resolveLocale(path,{
   codes:knownCodes,
   defaultLocale:await defaultLocale(env,siteId),
   queryLang:langFromUrl(u),
   cookieLang:langFromCookie(request),
 });
 const locale=match.locale;
 // Only a *path* prefix counts as explicit. That is the one case where a miss
 // must 404 instead of falling through to another language.
 const hasLocale=match.explicit;
 const rest=match.rest;
 // Remember an explicit `?lang=` choice so the next request does not need it.
 // A path prefix is already self-describing and gets no cookie.
 const langSetCookie=match.source==="query"?langCookie(locale,365):null;
 const respond=(html:string,template:string,status:number)=>htmlResponse(html,template,status,siteId,langSetCookie);
 // A prefixed feed: `/{locale}/feed.xml` serves that language's feed. The bare
 // `/feed.xml` was answered above (default language) because it is matched by
 // exact path; here the locale prefix has already been consumed.
 if(rest==="feed.xml")return feed(env,request,siteId,locale);
 const site=await siteInfo(env,siteId);
 // Attach plugin hooks once per isolate. The `beforeRender` action itself is
 // fired from `buildScope`, which has the fully-built render scope in hand.
 ctx.waitUntil(bootPluginRuntime(env).catch(()=>[]));

 // Home
 // Sits AFTER the theme-route loop, not before it: a theme may declare
 // `path: "/"` and take over the front page (a shop whose home page IS the
 // shop). When no theme claims the root, `matchRoute("","")` never fires and
 // this fallback runs exactly as it always did — latest posts through the
 // home/index template hierarchy.
 const home=async()=>{
   // The same query a theme-declared route uses, rather than a second, thinner
   // one. `latestPosts` returned only slug/title/excerpt, so a front page could
   // not show a date, a cover or a theme-declared field without the theme
   // declaring a route for `/` — and then `page.title` became the route's title
   // instead of the site's. One listing path means the front page and an
   // archive can never disagree about what a post carries.
   const ps=await runThemeQuery(env,{type:"post",limit:10,order:"created_at desc"},{locale},siteId) as any[];
   const r=await renderPage(env,{
     siteId,locale,path:u.pathname,kind:"home",title:site.title,description:site.description,
     extra:{posts:ps.map((p:any)=>({...p,url:`/${locale}/blog/${p.slug}`}))}
   },request);
   return respond(r.html,r.template,r.status);
 };

 // Theme-declared routes take priority over the built-in fallbacks so a theme
 // can own its own URL space (e.g. /properties/:slug).
 const routes=await listRoutes(env,siteId);
 for(const route of routes){
   const rp=String(route.path||"").replace(/^\//,"");
   const rt=matchRoute(rp,rest);
   if(!rt)continue;
   let query:Record<string,unknown>={};
   try{query=JSON.parse(String(route.query_json||"{}"))}catch{/* ignore */}

  // A route may resolve one object (by slug/id) or list many — from either the
  // post store or a theme-owned table.
  let post:any=null,kind:"single"|"archive"="archive",postType:string|undefined;
  let rows:any[]=[];
  // "This URL addressed one specific object" is tracked separately from `post`.
  // The two used to be conflated: `kind` only became "single" *after* a row had
  // been found, so the `!post && kind==="single"` guard that used to sit below
  // could never fire and `/products/no-such-slug` answered with the archive
  // listing and HTTP 200. A miss and a listing are different answers, and only
  // the router is in a position to tell them apart.
  let wantSingle=false;
  const resolve=route.resolve_json?(()=>{try{return JSON.parse(String(route.resolve_json))}catch{return null}})():null;
  const capture=rt.params.slug||rt.params.id||Object.values(rt.params)[0];

  // A route may resolve rows of a theme-owned table instead of posts (§3.4).
  //
  // This is what makes a declared table reachable on the front end. The table
  // is looked up by its *logical* name through the same facade the generated
  // admin screens use, so the shop front and the admin list can never disagree
  // about which physical table "product" means — two copies of that resolution
  // is exactly how the two views would drift apart.
  const resolveTable=resolve?.table?String(resolve.table):"";
  if(resolveTable){
    const def=await resolveTableForSite(env,siteId,resolveTable);
    // A capture means the URL named one row, so a miss is a 404 — whether or
    // not the table itself could be found.
    if(capture)wantSingle=true;
    if(def&&capture){
      post=resolve.by==="id"
        ?await tableById(env,def,String(capture),locale)
        :await tableBySlug(env,def,String(capture),locale);
      if(post)kind="single";
    }
    if(def&&!post)rows=await tableList(env,def,{locale,limit:Number(query.limit??50)||50});
  }

  if(resolve&&resolve.type){
    postType=String(resolve.type);
    const by=resolve.by==="id"?"id":"slug";
    if(capture){
      wantSingle=true;
      // Rule 58: the URL segment is per language — match the COALESCE, never
      // `p.slug` alone, or every language that named its own slug 404s.
      post=await env.DB.prepare(
        `SELECT p.*,t.locale,t.title,t.excerpt,t.content,t.slug AS slug_own FROM posts p JOIN post_translations t ON t.post_id=p.id
         WHERE p.site_id=? AND p.type=? AND ${by==="id"?"p.id=?":"COALESCE(t.slug,p.slug)=?"} AND t.locale=? AND p.status='published' LIMIT 1`
      ).bind(siteId,postType,capture,locale).first<any>();
      if(post){
        post.slug=post.slug_own||post.slug;
        post.alternates=await contentAlternates(env,siteId,post.id,postType);
        kind="single";
      }
    }
    // No capture for this route -> it is a listing even if it declares a type.
  }

  // A route that named one object and found nothing renders the 404 template.
  // Doing it here rather than after the render avoids building a whole archive
  // page only to discard it and answer 404 with a listing in the body.
  if(wantSingle&&!post){
    const miss=await renderPage(env,{siteId,locale,path:u.pathname,kind:"404",title:"Not Found"},request);
    return respond(miss.html,miss.template,404);
  }

  // Without an explicit resolver, infer the type from the route's first segment.
  if(!postType){
    const pt=await findPostTypeBySlug(env,String(rp.split("/")[0]),siteId);
    if(pt)postType=pt.name;
  }

  // Run the route's declarative query to populate the listing variable. A table
  // route already filled `rows` from its own table; running the post query on
  // top would replace them with an empty list.
  //
  // ⚠️ Only when the route *declared* something to list. `runThemeQuery`
  // defaults to `type: "post", limit: 10`, so an unconditional call made every
  // static route (`/login`, `/register`, `/contact`) pay for a post query whose
  // result no template reads — and, worse, filled `posts` on a page that has no
  // business having one. A route with no `query` and no `resolve` renders the
  // template it named and nothing else.
  const declaredListing=!!route.query_json&&Object.keys(query).length>0;
  if(kind==="archive"&&!resolveTable&&declaredListing){
    const q:Record<string,string|number>={...query,locale:String(query.locale??locale)};
    // `as` names the binding, it is not a query parameter.
    delete q.as;
    if(postType&&!q.type)q.type=postType;
    rows=await runThemeQuery(env,q,{locale,post} as Record<string,unknown>,siteId);
  }

  // Which scope variable the listing lands in.
  //
  // `query.as` is the route-level spelling of the `as` attribute on
  // `{{@query ... as="x"}}` — one concept, one name, so a theme author learns it
  // once. The default `posts` is what every existing theme template iterates.
  // Before this existed the binding was hard-coded, so a template written for a
  // `property` listing (`{{#each properties}}`) silently rendered its `{{else}}`
  // empty branch with HTTP 200 — the shape of failure this whole area produces.
  const listVar=String(query.as??"posts")||"posts";

  // Item links are built from the route's own path, never from a hard-coded
  // `/blog/`. A route exists precisely because the theme owns that URL space,
  // so linking every row to `/blog/<slug>` sent each visitor of `/writing` or
  // `/products` to a 404. Static segments are kept; captures are not.
  const routeBase="/"+rp.split("/").filter(s=>s&&!s.startsWith(":")).join("/");
  const itemUrl=(slug:string)=>`/${locale}${routeBase==="/"?"":routeBase}/${slug}`;

  const r=await renderPage(env,{
    siteId,locale,path:u.pathname,kind,postType,slug:rt.params.slug,
    // The template the route named outranks the hierarchy. Without this a table
    // route has no post type to derive a name from and can only reach the
    // generic `archive`/`single`.
    template:String(route.template||"")||undefined,
    // Title precedence: the resolved object, then the title the theme gave the
    // route, then the template name. Never fall back to the raw query `type` —
    // that is an internal slug ("post"), and leaking it heads the page "post".
    title:post?.title||String(route.title||route.template||"Archive"),
    description:post?.excerpt||undefined,post:post??undefined,
    extra:{
      route:{path:route.path,params:rt.params,query},
      [listVar]:rows.map(p=>({...p,url:itemUrl(String(p.slug??""))})),
    }
  },request);
  return respond(r.html,r.template,r.status);
 }

 // A theme that declared `path: "/"` already answered above; everything else
 // falls back to the built-in home.
 if(!rest)return home();

 // Built-in post permalink
 if(rest.startsWith("blog/")){
   const slug=rest.slice(5);
   const x=await findContent(env,"post",slug,locale,siteId);
   if(x){
     const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"single",postType:"post",slug,title:x.title,description:x.excerpt,post:x},request);
     return respond(r.html,r.template,r.status);
   }
 }

 // Theme-declared custom post types: /{locale}/{rewrite-slug}            -> archive
 //                                /{locale}/{rewrite-slug}/{slug}       -> single
 const segs=rest.split("/").filter(Boolean);
 const ptSlug=segs[0]??"";
 const pt=await findPostTypeBySlug(env,ptSlug,siteId);
 if(pt){
   const ptBase=pt.rewrite_slug??pt.name;

   // Single object.
   if(segs.length===2){
     const x=await findContent(env,pt.name,segs[1],locale,siteId);
     if(x){
       const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"single",postType:pt.name,slug:segs[1],title:x.title,description:x.excerpt,post:x},request);
       return respond(r.html,r.template,r.status);
     }
     // Nested path that is not this CPT -> fall through to pages below.
   }

   // Archive listing (has_archive).
   if(segs.length===1&&pt.has_archive){
     const rows=await runThemeQuery(env,{type:pt.name,limit:50},{locale} as Record<string,unknown>,siteId);
     const r=await renderPage(env,{
       siteId,locale,path:u.pathname,kind:"archive",postType:pt.name,
       title:String(pt.plural_label||pt.label||pt.name),
       extra:{posts:(rows as any[]).map(p=>({...p,url:`/${locale}/${ptBase}/${p.slug}`}))}
     },request);
     return respond(r.html,r.template,r.status);
   }
 }

 // Static page
 const page=await findContent(env,"page",rest,locale,siteId);
 if(page){
   const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"page",postType:"page",slug:rest,title:page.title,description:page.excerpt,post:page},request);
   return respond(r.html,r.template,r.status);
 }

 // Unprefixed path that missed in the default locale: try the site's other
 // locales rather than 404. `/about` should open the About page whether it was
 // authored in `en` or only in `de` — the visitor never asked to be pinned to
 // one language, so falling through is strictly better than a dead end. An
 // *explicitly* prefixed path (`/de/about`) does not get this treatment, since
 // there the reader has stated which language they want.
 if(!hasLocale&&knownCodes.length>1){
   for(const code of knownCodes){
     if(code===locale)continue;
     const alt=await findContent(env,"page",rest,code,siteId);
     if(alt){
       const r=await renderPage(env,{siteId,locale:code,path:u.pathname,kind:"page",postType:"page",slug:rest,title:alt.title,description:alt.excerpt,post:alt},request);
       return respond(r.html,r.template,r.status);
     }
   }
 }

 const r=await renderPage(env,{siteId,locale,path:u.pathname,kind:"404",title:"Not Found"},request);
 return respond(r.html,r.template,r.status===200?404:r.status);
},async scheduled(_event:ScheduledController,env:Env,_ctx:ExecutionContext){await processScheduled(env)}};

export{listPostTypes};
// Test surface: the boot hook is exercised directly by `admin-contract` (the
// stamp / empty-site / non-empty-site predicate cannot be reached through any
// HTTP route — by design, it runs once per install, not per request).
export{maybeSeedDemoContent};
