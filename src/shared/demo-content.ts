/**
 * demo-content.ts — the ONE definition of the demo content.
 *
 * Fresh installs ship an empty site. The demo articles and the About page are
 * written by `seedDemoContent` (see `api.ts`): the boot chain runs it once for
 * a never-seeded, empty install, the admin Settings screen carries a
 * "Restore demo content" button, and `scripts/seed-demo-content.mjs` calls the
 * same endpoint from a terminal. Every consumer writes **this** content —
 * there is deliberately no second copy in the scripts, because two copies of
 * "the demo" drift into two different demo sites.
 *
 * Pure data: no imports, so both the Worker bundle and plain Node scripts can
 * load it. The shape mirrors what `savePost` accepts per version, and both
 * languages of a piece are written against **one row**: `en` and `zh-CN` are
 * translations of each other (`lang_group`), with per-language slugs
 * (migration 0016) and per-language meta — a category name is prose a reader
 * sees, so "Design" on a Chinese page is exactly the half-translated page this
 * exists to make impossible.
 *
 * ⚠️ The **id is derived per site** (`demo_<siteId>_<key>`, see the writer),
 * not fixed here. `posts.id` is a global primary key; a fixed literal here
 * would make seeding a second site collide with the first (and `savePost`
 * answers 404 for a cross-site id — the MS-1.1 existence oracle). Per-site
 * derivation keeps the write idempotent per site and collision-free across
 * sites.
 */

export const DEMO_LOCALES = ["en", "zh-CN"] as const;

/**
 * The settings key marking "this install has already had its one boot-time
 * seed decision". Declared in `SETTING_DEFS` (site-scoped boolean): the
 * settings screen shows it like any other key, and clearing it re-arms the
 * one-time boot seed. Only the boot hook and the seed flow write it.
 */
export const DEMO_SEED_STAMP = "demo.seeded";

const b = (type: string, text: string) => ({ type, attrs: { text } as { text: string } | { url: string; alt: string } });
// `core/image` is the one block whose attrs are not `{text}` — the renderer
// reads `url`/`alt`. The theme derives a post's cover from the first image in
// its body, so every post that should have a card image starts with one.
// Both languages of a piece share the same photograph: it is the same article.
const img = (url: string, alt: string) => ({ type: "core/image", attrs: { url, alt } as { text: string } | { url: string; alt: string } });
const body = (...items: { type: string; attrs: { text: string } | { url: string; alt: string } }[]) => JSON.stringify(items);

const PHOTO = {
  reading: "https://images.unsplash.com/photo-1481627834876-b7833e8f5570?q=80&w=1200&auto=format&fit=crop",
  desk: "https://images.unsplash.com/photo-1455390582262-044cdead277a?q=80&w=1200&auto=format&fit=crop",
  server: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?q=80&w=1200&auto=format&fit=crop",
  notebook: "https://images.unsplash.com/photo-1517971129774-8a2b38fa128e?q=80&w=1200&auto=format&fit=crop",
  type: "https://images.unsplash.com/photo-1457369804613-52c61a468e7d?q=80&w=1200&auto=format&fit=crop",
};

// ---------------------------------------------------------------------------
// en
// ---------------------------------------------------------------------------
const HELLO = body(
  img(PHOTO.reading, "安静图书馆里的一排书架与阅读桌"),
  b("core/paragraph",
    "There is a particular kind of quiet that settles over a project once the " +
    "architecture stops fighting you. For two years this site ran on a stack " +
    "where every meaningful change meant negotiating with a framework that had " +
    "its own opinions about how a page should come into being. The publishing " +
    "platform you are reading this on was built to end that negotiation. It " +
    "renders in a single pass, on the edge, in tens of milliseconds, and it " +
    "asks nothing of you but the words."),
  b("core/heading", "Why the edge changes the shape of a CMS"),
  b("core/paragraph",
    "Traditional content management systems assume a machine that stays warm. A " +
    "request arrives, a process wakes, a template is loaded from disk, a " +
    "database connection is borrowed from a pool, and the result is cached in " +
    "memory for the next visitor. The whole design leans on the assumption that " +
    "the server was already there, waiting."),
  b("core/paragraph",
    "An edge runtime inverts that. There is no warm process and no connection " +
    "to borrow. Every request is a cold start that must assemble its own world, " +
    "answer, and disappear. That constraint sounds hostile until you notice " +
    "what it buys: the answer is produced in the city where the reader is " +
    "sitting, and no single machine is holding the whole site hostage."),
  b("core/quote",
    "The fastest request is the one that never had to wake a server to serve it."),
  b("core/heading", "The three constraints that shaped this engine"),
  b("core/paragraph",
    "Everything about the template language follows from three rules, and once " +
    "you accept them the design becomes almost inevitable."),
  b("core/list",
    "No evaluation of user-supplied code. The runtime forbids it, so templates " +
    "are parsed into a syntax tree and interpreted, never executed.\n" +
    "No hidden I/O. A template cannot reach for the network, so every piece of " +
    "data it needs is placed in scope before rendering begins.\n" +
    "No shared mutable state. A render touches only what it was handed, so two " +
    "requests never interfere."),
  b("core/paragraph",
    "The cost is that templates are less expressive than JavaScript, and the " +
    "benefit is that a template can never take the site down. That is a trade " +
    "worth making for something whose entire job is to be reliably available."),
  b("core/heading", "What this means for the people writing"),
  b("core/paragraph",
    "The most interesting consequence is not technical. When rendering is cheap " +
    "and predictable, the shape of the writing changes. You stop thinking about " +
    "the page as a resource to be optimised and start thinking about it as a " +
    "thing to be read. Long-form prose comes back, because there is no longer a " +
    "penalty for it."),
  b("core/code",
    "// A theme is a folder, not an application.\n" +
    "themes/default/\n" +
    "  theme.json\n" +
    "  templates/\n" +
    "    index.html    // the home page\n" +
    "    single.html   // one article\n" +
    "    archive.html  // a list of them"),
  b("core/paragraph",
    "That folder is the whole contract. Drop it in, activate it, and the site " +
    "changes shape without a deploy pipeline, a build step, or a single line of " +
    "JavaScript that anyone has to maintain. The platform handles the rest."),
  b("core/heading", "Where this goes next"),
  b("core/paragraph",
    "Themes that can compile themselves. Templates that can call into a " +
    "sandboxed worker for genuinely dynamic behaviour. A plugin surface that " +
    "lets a third party extend the engine without ever asking for trust. None " +
    "of it is speculative; each piece is a small step from where the code " +
    "already sits."),
  b("core/paragraph",
    "But the foundation matters more than the roadmap. A publishing platform " +
    "earns its keep by being boring in the right places: fast where it should " +
    "be fast, predictable where it should be predictable, and quiet everywhere " +
    "else. Everything else is decoration."),
);

const SECOND = body(
  img(PHOTO.notebook, "书桌上的钢笔与方格纸"),
  b("core/paragraph",
    "A shorter note, included mainly so the archive and the related-articles " +
    "strip have more than one real entry to work with. The engine treats it " +
    "exactly like the longer piece, which is rather the point."),
  b("core/heading", "Small pieces, same machinery"),
  b("core/paragraph",
    "There is no separate code path for a short post. The same template, the " +
    "same scope, the same rendering pass. Whatever the theme does to a long " +
    "article it does to a short one, and if that ever stops being true the " +
    "theme has a bug."),
  b("core/quote", "Uniformity of mechanism, variety of output."),
);

const ABOUT = body(
  b("core/paragraph",
    "This site is a demonstration of a publishing platform built entirely on " +
    "Cloudflare Workers, D1 and R2. There is no origin server and no container " +
    "anywhere in the request path: a page is assembled at the edge, from data " +
    "that lives next to it."),
  b("core/heading", "What is running here"),
  b("core/list",
    "A declarative template engine that interprets themes rather than executing " +
    "them.\nA per-site content model with custom post types and fields declared " +
    "by the theme itself.\nA sandboxed runtime for themes that genuinely need to " +
    "run code."),
  b("core/heading", "About this theme"),
  b("core/paragraph",
    "MOBAI is a reading-first theme. A single centred column, a serif body " +
    "against a sans-serif chrome, and light and dark palettes that were designed " +
    "separately rather than inverted from each other. There is no build step, no " +
    "external font request, and no JavaScript beyond the theme toggle."),
);

const EDGE = body(
  img(PHOTO.server, "机房里的一排服务器"),
  b("core/paragraph",
    "A request for a page reaches a data centre that may be a hundred kilometres " +
    "from the reader, or ten. It is answered there, in one pass, and nothing is " +
    "kept warm between requests. That single constraint — no process to reuse, no " +
    "warm cache to lean on — is what makes the rest of this system look the way " +
    "it does."),
  b("core/heading", "What you give up"),
  b("core/list",
    "A long-lived connection to a database you control.\n" +
    "The freedom to run a background job whenever you feel like it.\n" +
    "The assumption that the same machine will answer the next request."),
  b("core/heading", "What you get back"),
  b("core/paragraph",
    "Latency that does not depend on where the reader happens to be standing, and " +
    "a deployment that is a single atomic upload rather than a rolling restart. " +
    "The trade is real and worth naming: you are exchanging the ability to keep " +
    "state in memory for the guarantee that every request starts from the same " +
    "known place."),
  b("core/quote",
    "Every design decision in this codebase can be traced back to a runtime that " +
    "forgets you between requests."),
);

const TEMPLATES = body(
  img(PHOTO.type, "排版中的铅字与手稿"),
  b("core/paragraph",
    "The template language has no arithmetic, no loops you can build yourself, and " +
    "no way to call out to anything. It is deliberately too small to be a " +
    "programming language, because the moment it becomes one, every theme becomes " +
    "an application that has to be maintained."),
  b("core/heading", "Ten helpers, and that is the whole vocabulary"),
  b("core/code",
    "len  default  lower  upper  truncate\n" +
    "join  number  date  contains"),
  b("core/paragraph",
    "Anything that needs a computation happens on the server, before the template " +
    "is handed a value. Reading time, formatted dates, resolved URLs — all of them " +
    "arrive ready to print. The template's only job is to decide what goes where."),
  b("core/heading", "Why this is a feature"),
  b("core/paragraph",
    "A theme that can compute is a theme that can be wrong in ways nobody can see. " +
    "A theme that can only place values can be wrong in exactly one way, and that " +
    "way shows up the first time you render it."),
);

const I18N = body(
  img(PHOTO.desk, "书桌上的钢笔与手稿纸"),
  b("core/paragraph",
    "Content is stored once per language, side by side with the language it is " +
    "written in. Adding a second language is not a migration: the columns for it " +
    "already exist, holding the default language's text until something replaces " +
    "them."),
  b("core/heading", "The rule that keeps it honest"),
  b("core/list",
    "A translation table is never dropped and never emptied.\n" +
    "A main table only ever gains columns; it never loses one.\n" +
    "A field holding prose is translatable; a field holding a number is not."),
  b("core/paragraph",
    "That last rule is the one people argue about, and it is the one that matters " +
    "most. A price is not a sentence. Translating it is not a feature, it is a bug " +
    "waiting to happen at three in the morning."),
);

// ---------------------------------------------------------------------------
// zh-CN — the same six pieces, written as Chinese rather than transliterated.
// A real translation is the only thing that makes the switcher, the per-locale
// feed and the sitemap meaningful; a copy of the English body would pass every
// structural check while proving nothing.
// ---------------------------------------------------------------------------
const HELLO_ZH = body(
  img(PHOTO.reading, "安静图书馆里的一排书架与阅读桌"),
  b("core/paragraph",
    "当一套架构不再和你较劲，项目里会沉淀出一种特别的安静。这个站点曾经跑在一套栈上，" +
    "每一次有意义的改动，都要先和一个对「页面应该如何诞生」有自己主张的框架谈条件。" +
    "两年之后我决定不再谈下去——你现在读到的这个发布平台，就是那次决定的结果。" +
    "它在边缘、在一次渲染里、在几十毫秒内把页面交出去，除了文字，它不向你索取任何东西。"),
  b("core/heading", "为什么「边缘」改变了 CMS 的形状"),
  b("core/paragraph",
    "传统内容管理系统默认有一台保持温热的机器。请求到达，进程醒来，模板从磁盘加载，" +
    "数据库连接从池里借出，结果放进内存留给下一位访客。整套设计都押在同一个假设上：" +
    "服务器本来就在那里等着。"),
  b("core/paragraph",
    "边缘运行时把这个假设翻了过来。没有常驻进程，也没有可以借用的连接。每个请求都是冷启动，" +
    "它必须自己拼装出一个世界、给出答案，然后消失。这个约束听起来充满敌意，" +
    "直到你注意到它换来了什么：答案在读者所在的城市生成，并且没有任何一台机器能挟持整个站点。"),
  b("core/quote", "最快的请求，是那个从来不需要唤醒服务器就能回答的请求。"),
  b("core/heading", "塑造这台引擎的三条约束"),
  b("core/paragraph",
    "模板语言里的一切都从三条规则推导而来。一旦接受它们，设计就变得几乎别无选择。"),
  b("core/list",
    "不执行用户提供的代码。运行时禁止它，所以模板被解析成语法树后被解释，而从不被执行。\n" +
    "不隐藏 I/O。模板不能伸手去够网络，因此它需要的每一份数据都必须在渲染开始前放进作用域。\n" +
    "不共享可变状态。一次渲染只触碰交给它的东西，所以两个请求永远不会互相干扰。"),
  b("core/paragraph",
    "代价是模板的表达能力不如 JavaScript；收益是模板永远不可能把站点搞垮。" +
    "对于一个全部职责就是「稳定可用」的东西来说，这笔交易值得做。"),
  b("core/heading", "这对写作者意味着什么"),
  b("core/paragraph",
    "最有趣的后果并不是技术上的。当渲染变得便宜且可预测，写作的形状会随之改变。" +
    "你不再把页面当成一份需要被优化的资源，而开始把它当成一件要被阅读的东西。" +
    "长文回来了，因为写长文不再有惩罚。"),
  b("core/code",
    "// 主题是一个文件夹，不是一个应用。\n" +
    "themes/default/\n" +
    "  theme.json\n" +
    "  templates/\n" +
    "    index.html    // 首页\n" +
    "    single.html   // 一篇文章\n" +
    "    archive.html  // 一串文章"),
  b("core/paragraph",
    "那个文件夹就是全部契约。放进去、激活它，站点就换了形状——不需要发布流水线，" +
    "不需要构建步骤，也不需要任何人去维护一行 JavaScript。剩下的由平台负责。"),
  b("core/heading", "接下来会往哪里走"),
  b("core/paragraph",
    "能自我编译的主题。可以调用沙箱化 worker 去实现真正动态行为的模板。" +
    "一个让第三方扩展引擎、却永远不必索取信任的插件面。这些都不是空想，" +
    "每一块都只是从代码现在所在的位置迈出的一小步。"),
  b("core/paragraph",
    "但地基比路线图更重要。一个发布平台的立身之本，是在该快的地方快、" +
    "在该可预测的地方可预测、在其余一切地方保持安静。除此之外都是装饰。"),
);

const SECOND_ZH = body(
  img(PHOTO.notebook, "书桌上的钢笔与方格纸"),
  b("core/paragraph",
    "一篇更短的笔记，放在这里主要是为了让归档页和「相关文章」那一条有不止一条真实记录可用。" +
    "引擎对待它的方式和对待长文完全一样——而这正是要点。"),
  b("core/heading", "小的篇章，同一套机器"),
  b("core/paragraph",
    "短文没有单独的代码路径。同一个模板、同一个作用域、同一遍渲染。" +
    "主题对长文做的每一件事，它也对短文做；如果哪天不再是这样，那就是主题有 bug。"),
  b("core/quote", "机制统一，产出多样。"),
);

const ABOUT_ZH = body(
  b("core/paragraph",
    "本站演示了一个完全构建在 Cloudflare Workers、D1 和 R2 之上的发布平台。" +
    "请求路径上没有任何源站服务器，也没有任何容器：页面在边缘组装，用的就是放在它旁边的数据。"),
  b("core/heading", "这里跑着什么"),
  b("core/list",
    "一个声明式模板引擎，它解释主题，而不是执行主题。\n" +
    "一份按站点划分的内容模型，自定义内容类型与字段由主题自己声明。\n" +
    "一个沙箱化运行时，供那些确实需要跑代码的主题使用。"),
  b("core/heading", "关于这个主题"),
  b("core/paragraph",
    "墨白是一份阅读优先的主题。单栏居中，衬线正文配无衬线框架，明暗两套配色是分别设计的，" +
    "而不是互相反相得来。没有构建步骤，没有外部字体请求，" +
    "除了那个明暗切换按钮之外没有多余的 JavaScript。"),
);

const EDGE_ZH = body(
  img(PHOTO.server, "机房里的一排服务器"),
  b("core/paragraph",
    "一个页面请求会到达一个数据中心，它距离读者可能有一百公里，也可能是十公里。" +
    "答案就在那里生成，一遍完成，请求之间不留任何温热的东西。" +
    "正是这唯一一条约束——没有可复用的进程，没有可倚仗的热缓存——决定了这套系统其余部分的模样。"),
  b("core/heading", "你放弃了什么"),
  b("core/list",
    "一条由你掌控的长连接数据库。\n" +
    "想跑后台任务时随时就跑的自由。\n" +
    "「下一个请求还会由同一台机器应答」这个假设。"),
  b("core/heading", "你换回了什么"),
  b("core/paragraph",
    "一种不取决于读者站在哪里的延迟，以及一次原子上传就完成的发布，而不是滚动重启。" +
    "这笔交易是真实的，也值得被说清楚：你交出的是「把状态留在内存里」的能力，" +
    "换来的是「每个请求都从同一个已知位置开始」的保证。"),
  b("core/quote",
    "这份代码里的每一个设计决定，都能追溯到那个「请求之间会把你忘掉」的运行时。"),
);

const TEMPLATES_ZH = body(
  img(PHOTO.type, "排版中的铅字与手稿"),
  b("core/paragraph",
    "这个模板语言没有算术，没有你自己能构造的循环，也没有任何向外调用的方式。" +
    "它被刻意做得小到不成为一种编程语言——因为一旦它成了编程语言，" +
    "每个主题都会变成需要维护的应用。"),
  b("core/heading", "十个 helper，就是全部词汇"),
  b("core/code",
    "len  default  lower  upper  truncate\n" +
    "join  number  date  contains"),
  b("core/paragraph",
    "任何需要计算的东西都在服务器上完成，在模板拿到值之前。阅读时长、格式化日期、" +
    "解析后的 URL——它们到达时就已经可以直接打印。模板唯一的职责是决定什么放在哪里。"),
  b("core/heading", "为什么这是一项特性"),
  b("core/paragraph",
    "一个能计算的主题，就是一个能以没人看得见的方式出错的主题。" +
    "一个只能摆放值的主题，只可能以一种方式出错，而那种方式在你第一次渲染它的时候就会露出来。"),
);

const I18N_ZH = body(
  img(PHOTO.desk, "书桌上的钢笔与手稿纸"),
  b("core/paragraph",
    "内容按语言各存一份，和它写作时所用的语言并排放在一起。增加第二种语言不是一次迁移：" +
    "它需要的列早就存在，只是此刻还装着默认语言的文本，等着被替换。"),
  b("core/heading", "让这件事保持诚实的规则"),
  b("core/list",
    "翻译表永不被删除，也永不被清空。\n" +
    "主表只会增加列，从不失去列。\n" +
    "装散文的字段可翻译；装数字的字段不可翻译。"),
  b("core/paragraph",
    "最后一条争议最大，也最重要。价格不是一句话。翻译它不是什么特性，" +
    "而是一个凌晨三点等着爆发的 bug。"),
);

export interface DemoVersion {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  meta?: Record<string, string>;
}

export interface DemoPiece {
  /** Stable key; the per-site id is `demo_<siteId>_<key>`. */
  key: string;
  /** `savePost`'s kind, singular. */
  kind: "post" | "page";
  versions: Partial<Record<(typeof DEMO_LOCALES)[number], DemoVersion>>;
}

export const DEMO_CONTENTS: DemoPiece[] = [
  {
    key: "hello",
    kind: "post",
    versions: {
      en: {
        meta: { category: "Design", tags: "long read,design systems,typography" },
        slug: "hello-world",
        title: "Hello World",
        excerpt: "A publishing platform built to end the negotiation with its own framework.",
        content: HELLO,
      },
      "zh-CN": {
        meta: { category: "设计", tags: "长文,设计系统,字体排印" },
        slug: "ni-hao-shi-jie",
        title: "你好，世界",
        excerpt: "一个为了终结与自身框架的谈判而建成的发布平台。",
        content: HELLO_ZH,
      },
    },
  },
  {
    key: "second",
    kind: "post",
    versions: {
      en: {
        meta: { category: "Life", tags: "notebooks,workflow" },
        slug: "second-post",
        title: "Second Post",
        excerpt: "A shorter note about uniformity of mechanism and variety of output.",
        content: SECOND,
      },
      "zh-CN": {
        meta: { category: "生活", tags: "笔记,工作流" },
        slug: "di-er-pian",
        title: "第二篇",
        excerpt: "一篇更短的笔记：机制统一，产出多样。",
        content: SECOND_ZH,
      },
    },
  },
  {
    key: "edge",
    kind: "post",
    versions: {
      en: {
        meta: { category: "Technology", tags: "edge,architecture,long read" },
        slug: "rendering-at-the-edge",
        title: "Rendering at the edge, one pass at a time",
        excerpt: "A runtime that forgets you between requests is not a limitation to work around. It is the design.",
        content: EDGE,
      },
      "zh-CN": {
        meta: { category: "技术", tags: "边缘计算,架构,长文" },
        slug: "zai-bian-yuan-xuan-ran",
        title: "在边缘一次渲染",
        excerpt: "一个在请求之间把你忘掉的运行时，不是需要绕开的限制，它就是设计本身。",
        content: EDGE_ZH,
      },
    },
  },
  {
    key: "templates",
    kind: "post",
    versions: {
      en: {
        meta: { category: "Technology", tags: "templates,constraints" },
        slug: "a-template-language-small-enough-to-reason-about",
        title: "A template language small enough to reason about",
        excerpt: "Ten helpers, no arithmetic, and no way to call out. That is the whole vocabulary, on purpose.",
        content: TEMPLATES,
      },
      "zh-CN": {
        meta: { category: "技术", tags: "模板语言,约束" },
        slug: "ke-yi-tui-qiao-de-mo-ban-yu-yan",
        title: "小到可以推敲的模板语言",
        excerpt: "十个 helper，没有算术，也无法向外调用。这就是全部词汇，而且是刻意的。",
        content: TEMPLATES_ZH,
      },
    },
  },
  {
    key: "i18n",
    kind: "post",
    versions: {
      en: {
        meta: { category: "Design", tags: "i18n,data modelling" },
        slug: "two-languages-one-row",
        title: "Two languages, one row",
        excerpt: "Adding a language should not be a migration, and a price should never be translated.",
        content: I18N,
      },
      "zh-CN": {
        meta: { category: "设计", tags: "国际化,数据建模" },
        slug: "liang-zhong-yu-yan-tong-yi-xing",
        title: "两种语言，同一行",
        excerpt: "增加一种语言不该是一次迁移，而价格永远不该被翻译。",
        content: I18N_ZH,
      },
    },
  },
  {
    key: "about",
    kind: "page",
    versions: {
      en: {
        slug: "about",
        title: "About",
        excerpt: "What this site is, and what it is running on.",
        content: ABOUT,
      },
      "zh-CN": {
        slug: "guan-yu",
        title: "关于",
        excerpt: "本站是什么，以及它跑在什么之上。",
        content: ABOUT_ZH,
      },
    },
  },
];

export interface DemoMenuItem {
  title: string;
  url: string;
  locale?: string;
  target?: string;
}

export interface DemoMenu {
  id: string;
  name: string;
  location: string;
  items: DemoMenuItem[];
}

export const DEMO_MENUS: DemoMenu[] = [
  {
    id: "header",
    name: "Header Navigation",
    location: "header",
    items: [
      { title: "首页", url: "/zh-CN", locale: "zh-CN" },
      { title: "文章", url: "/zh-CN/blog", locale: "zh-CN" },
      { title: "关于", url: "/zh-CN/guan-yu", locale: "zh-CN" },
      { title: "Home", url: "/en", locale: "en" },
      { title: "Articles", url: "/en/blog", locale: "en" },
      { title: "About", url: "/en/about", locale: "en" },
    ],
  },
  {
    id: "footer",
    name: "Footer Navigation",
    location: "footer",
    items: [
      { title: "首页", url: "/zh-CN", locale: "zh-CN" },
      { title: "归档", url: "/zh-CN/blog", locale: "zh-CN" },
      { title: "关于本站", url: "/zh-CN/guan-yu", locale: "zh-CN" },
      { title: "Home", url: "/en", locale: "en" },
      { title: "Archive", url: "/en/blog", locale: "en" },
      { title: "About Us", url: "/en/about", locale: "en" },
    ],
  },
];
