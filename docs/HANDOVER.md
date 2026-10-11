# CFPress (CFCMS) 交接文档

> 更新时间：2026-10-11 (GMT+8) ｜ 交接基线：**AUTH 批次 F —— 契约与守卫收尾（规则 80）+ `user-delete` 行为套件**
> （本仓库同时有两份活动计划：`docs/MENUS-WIDGETS-SITES-PLAN.md`（批次 26–28，**26/27/28 全部完成**）
> 与 `docs/AUTH-ISOLATION-PLAN.md`（批次 A–F，**A/B/C/D/E/F 全部完成**）。两套编号**互相独立**，勿混。
> 批次 F：`CHANGE-CONTRACT.md` 新增**三个维度**（18 前台/后台分离、19 后台前缀隐身、20 每站点角色）
> + 交织矩阵补 4 行 + §3.10–§3.12 三份清单 + §5 补 6 个真实案例 + §6 三行机器强制 + §8
> 「三条边界的由来」（18–20 为什么是"一直在、加第二实例才暴露"）；`AGENTS.md` DoD 同步（17→20 维）
> + 新铁律 3b「守卫锚在**消费**上，不是**提及**上」；**新增规则 80**（`deleteUser` 两行一次 batch 删，
> 身份和成员行一起死）+ 注入 1 场景；`_tenant-query-audit` 新语句写**书面裁决**。
> **本轮追加**：`tests/suites/user-delete.test.mjs`（**驱动真函数打真数据库**，含 negative control 与
> batch 原子性 spy；反向变异证明 4 条断言各自会红）+ 入四张表；基线 **25 套件 / 1734 条**。
> 上一条交接基线：批次 E2 —— staff 按站点（UI 与切面，规则 79）：`users` 屏「角色」列改为
> **本站角色**（读端点新加的 `role_here`/`sites`/`site`，不再渲染安装级 `role`）+ superadmin 标为跨站
> + 「其他站点」逐站点名 + **站点-角色编辑器**（只发变化的行，`role:null` 撤权）+ 站点切换器按角色
> 过滤**钉住**（E1 的 `GET sites` 已过滤）+ 中英词典 19 key（并删掉过时的 `viewer` 角色词条）。
> 上一条交接基线：批次 E1 —— staff 按站点：`site_users_sites(user_id, site_id, role)`（迁移 0023，
> **带平移**）+ `can(env,user,perm,siteId)` 站点感知（**`siteId` 必填**，无回退到全局 role）+ 全部
> **31 个** `requirePermission` 调用点补 `siteId` + 站点列表按成员过滤 + 新增
> `PUT users/:id/sites/:siteId`；规则 78 钉住；顺带修掉 `requireAdmin` 硬编码角色列表漏掉
> `superadmin` 的真实缺陷（升级即锁死 owner）。
> 上一条交接基线：批次 D —— 前台会员：`members`（**按站点**）+ `member_sessions` 两张新表 +
> `/api/v1/front/{auth/*,me}` + `src/platform/members.ts`；主题 `login`/`register` 模板 +
> `member` 作用域 + 中英词典；**两套身份的隔离是结构性的**（不同表/不同 cookie 名/不同端点族），
> 规则 77 钉住；顺带修掉带前缀站点**走不通前台 API** 的真实缺陷（站点解析早于 API 层 + 非 GET 兜底吞掉 POST）。
> （批次 C —— 后台隐身：前缀可配 + cookie 收紧 + SPA base 注入（规则 75）。
> 批次 26 菜单管理落地 + 菜单位置确定性（规则 73）；批次 25 拒绝必须带出口：主题强制卸载（规则 72）；
> 批次 24 后台多语言：列表按默认语言取代表行 + 语言过滤/版本徽标 + 编辑器语言切换重新取数（规则 71）；
> 批次 23 post_meta 语言维度（B5）+ 列表 reading_time + /blog 归档路由 + 单页字段修复；
> 批次 22 双语内容上线、注册行不等于安装（规则 69）、启动链自动安装主题声明；
> 批次 21 默认主题的中文版与切换器、文章页切换器读翻译自己的 URL、中英双语演示内容、规则 25；
> 批次 20 journal 主题从产品移除 + 测试夹具主题不再被发布到线上；
> 批次 19 主题卸载：读错层级 + 不可能成功的按钮；批次 18 界面语言偏好：一个写者两个读者；
> 批次 16 Track 0 + B1 + A3 + B3 媒体隔离 / 块 attrs 契约 / 统一媒体控件 / 编辑器界面翻译；
> 批次 15 数据驱动后台；批次 14 多语言 URL——slug 按语言 + hreflang + 按语言 feed + 规则 56–59；
> 批次 13 mobai 主题 + RSS；批次 12 写入路径修复 + journal 主题；批次 11 平台功能开关。
> 批次 10 及更早见下方各节与 `docs/history/`。）
> 读者：接下来接手本项目的开发者或 AI 会话。**先读本文，再读 `docs/ARCHITECTURE.md`，改代码前读 `AGENTS.md`。**
>
> ⚠️ 批次 16 已完成 **Track 0**（媒体隔离）、**B1**（块 attrs 契约）、**A3**（统一媒体控件）、**B3**（编辑器界面翻译）。
> 其余（A4 媒体屏升级、B4 多语言编辑体验）仍待做；**B5 `post_meta` 语言维度已在批次 23 落地**。
> 未完成项见 `docs/design/MEDIA-EDITOR-PLAN.md`（已定稿，含四条轨道的完整拆分与已拍板语义）。
> ⚠️ 本轮的批次过程文档在 `docs/history/HANDOVER-PLUGIN-BATCH.md`（已降级为批次存档，只记步骤 1–6 的细节）。
> 每日工作日志在 `.workbuddy-ai/memory/YYYY-MM-DD.md`（gitignore，本机才有）。

---

## 1. 项目是什么

**CFPress / CFCMS** — 跑在 Cloudflare 全家桶上的 WordPress 式 CMS：

| 组件 | 用途 |
|---|---|
| Workers | 全部服务端逻辑（无 Node 服务器） |
| D1 (SQLite) | 内容与配置 |
| R2 | 主题模板包、媒体、扩展 zip |
| KV | 会话、缓存镜像（**镜像默认关**，见功能开关） |
| Static Assets | 后台 SPA（`public/admin/`） |

- 仓库：`https://github.com/unifare/CFCMS`（public，分支 `main`，许可证 AGPL-3.0）
- 版本：v0.7.0 → 目标 v0.8.0
- **线上**：`https://cfpress.2aass.workers.dev`（免费计划，账号 `2aass@proton.me`）
  ——所有 `wrangler` 命令必须带 `-c wrangler.local.jsonc`。该文件是**生成物**：
  `wrangler.jsonc`（提交，`REPLACE_WITH_*` 占位符）+ `wrangler.ids.json`（gitignore，真 id，
  **唯一手写的那份**）→ `node scripts/make-local-config.mjs`。`npm run dev|deploy|db:migrate*`
  与两个启动器都会先自动生成，所以日常路径不用记 flag。详见 §11.7 与「批次 17」。
- **后台首登**：`admin` / `change-me-now`（bootstrap 自动建号；**公开站点，上生产前必须改密**）
- dev 端口 **47913**（跨项目约定，env `CFP_PORT` 可覆盖）
- ⚠️ 沙箱代理放行 `api.cloudflare.com` 但**拦截 `*.workers.dev`**——线上站点无法在沙箱内 HTTP
  验证，部署成功靠 `wrangler deploy` 输出 + `wrangler deployments list` + GraphQL analytics 证明

## 2. 提交脉络

```
6b09051  CFCMS v0.7.0 — 初始代码
1aeffa2  Add AGPL-3.0 license
265d03c  Layer src/ into shared/platform/rendering/extensions + enforce architecture
03ae88d  Add handover document
d6e2239  Split the admin SPA into modules + add structure tests
48edc41  Multi-language: four layers (L0-L3) + theme-owned tables
a1ac8e3  Unify admin menus into one registry + generate table screens from declarations
33f6369  Add theme/plugin scaffolders + make declared routes actually drive rendering
fb2b012  Add eshop sample theme, its test suite, and the three dev docs (batch 4)
3ccd66b  Admin UI language (en/zh) + account self-service + site menu editor  (batch 5)
959f423  Review: multi-language invariants (batch 6 review)
83e65ed  Fix the four multi-language defects the review found (batch 6)
36720a1  Rule 41: every data field carries a language dimension (batch 7)
...      (batches 8–9: 见 ARCHITECTURE.md §8 路线图)
576fe6a  Delete retired themes/plugins + fix the 11th false green (batch 10 step 1)
34c0bc9  Owner-agnostic own tables: rebuild theme_table_defs with owner_type (step 2)
bcc856c  Channel contract + plugin page contract + rules 48–51 (steps 3+4)
9487b40  Channel runtime: webhook impl + dedup ledger + PluginApi.notify (step 5)
9fd19db  Admin renderer: plugin-page blocks + channel settings form (step 6)
(batch 10 steps 7+8: plugins/notify sample + plugin-pages suite + injectors — 见 §5)
0aa6ed6  Opt-out feature switches: KV cache mirror + theme Worker sandbox (batch 11)
622bcce  Fix savePost: PUT with an id now creates when the row is missing
6a53ba7  Dashboard fields (recent/published) + deletePost site-ownership check
9e9dde5  PBKDF2 120k→25k (free-plan 10ms CPU) + handleApi top-level try/catch
f312143  journal theme (modern blog) + listing dates + CJK reading time
0f2bd7f  mobai theme (墨白) + RSS feed + cover images + theme.strings for templates
a81e5e0  Re-key tenant audit verdicts after the mobai batch
7581387  Per-language slugs + hreflang + per-locale feeds + rules 56-59  ← 批次 14
60f9a24  Dropdown check mark: show only on the active row
176331b  Data-driven admin: block palette, dashboard cards, typed settings forms  ← 批次 15 基线
(batch 16 Track 0: media ownership + isolation, and the site-list memo fix — 见 §5)
(batch 16 Track B1: the block attribute contract, and the editor's per-type controls — 见 §5)
(batch 16 Track A3: one media control for blocks, custom fields and settings — 见 §5)
(batch 16 Track B3: the content editor in every interface language — 见 §5)
(batch 16 Track B4 part 1: the editor's timer, its schedule round trip and its locale identity — 见 §5)
(batch 16 Track A4: the media library screen — tiles, search, inline alt text, delete — 见 §5)
129c077  mobai 并入 default（捆绑主题只有一个名字）+ plugin-pages §8 夹具修正
21e7018  Bundled themes ship through Worker assets + rule 66 — 清库后开箱即用，部署不再逐个 r2 object put
(the Languages screen offers the bundled languages: `core_entries` — 见 §5 批次 5 与 §6b)
```

**批次 16 Track 0（媒体隔离地基）**：`media_files` 自 0009 起就有 `site_id`，但
**它的唯一公开门没有执行它**——`/media/<key>` 在 `src/index.ts` 里于**站点解析之前**、
**鉴权之前**匹配并直接从 R2 取对象，于是 A 站铸的 key 在 B 站域名下 200、未登录访客也 200。
后台列表早已按站点收窄，**恰恰因为另一扇门是对的，这个洞活过了所有既有断言**。
本批次补齐两轴（租户 + 所有者）并让两扇门走同一份策略；顺带修掉一个"新建站点在前台解析不到"
的 memo 缺陷。详见 §5 与 `AGENTS.md` 规则 60。

**批次 11（`0aa6ed6`，平台功能开关）**：`src/shared/features.ts` 单一定义
（`FEATURE_SWITCHES`：key/varName/defaultOn/label），优先级 站点 settings 行 →
`wrangler.jsonc` vars → `defaultOn`，解析不了=关。三个开关都默认关：
`cache_mirror_kv`（KV 写入镜像）、`theme_runtime_worker`（主题 Worker 沙箱，
**检查必须在绑定之前**）、`ui_locale_follow_site`（**打开**后后台界面语言菜单只列本站启用的
语言；默认关=维持 §2.4 的解耦）。后台 Tools → Features 屏 + `GET/POST /api/v1/features`。
规则 52–55。

> ⚠️ **批次 11 留了一个两批次没被发现的漂移（`eb5f70b` 修）**：`vars` 块只加进了
> `wrangler.jsonc`，而**所有命令跑的是 `wrangler.local.jsonc`**——于是线上 Worker 根本没有
> `vars`，三层优先级只剩两层。隐形的原因是**漏一个 var 和写 `"false"` 解析结果都是"关"**。
> 现在 `architecture.test.mjs` 双向断言 `varName` ↔ `wrangler.jsonc` 的 `vars` 键，
> `tests/tools/_config-parity.mjs`（进 `npm run gate`）守两份配置的同构，反向验证各一条。
> 详见 §11.7。

**批次 12（写入路径修复 + journal 主题）**：三个「200 + 内容错」真缺陷——
①`savePost` 对带 id 的 PUT 只 UPDATE（SQLite 零行更新不报错→孤儿翻译行，**判据必须是
查询结果不是入参形状**）；②`deletePost` 不校验站点归属（A 站可删 B 站文章）；③dashboard
漏发 `recent`/`published` 且 media 计数漏租户。外加 `handleApi` 顶层 try/catch（异常逃逸成
平台错误页 → 客户端只见 "Request failed"）与 **PBKDF2 迭代 120000→25000**（免费计划单请求
10ms CPU，实测 120k≈22ms 会在写库前被杀——症状是 `site_users` 恒 0、登录报 "Request failed"；
迭代数写在 hash 串里，以后调高不破坏旧密码）。同批交付 `journal` 现代博客主题（39 条套件）、
列表日期 `date_display`（Intl 按 locale 记忆化）、`readingTime` CJK 按字计。

**批次 13（`0f2bd7f`，mobai 主题 + RSS）**：设计稿→主题 `content/themes/mobai`（杂志式中文博客，
明暗两套、零构建零外链）。平台补 **RSS**（`/feed.xml`，原平台只有 sitemap/robots）与
`cover`（从正文第一个 `core/image` 派生——字段类型无法诚实表达 URL，`text` 被规则 41 强制可翻译）。
`theme.strings` 把主题自己的语言包暴露给模板（前端文案不再硬编码）。**顺带抓到
`x-cfpress-scope` ByteString 缺陷**：站点标题/分类含中文时 worker 主题整条路径静默退化
（请求头是 Latin-1）——该头只写不读，删除而非编码，回退路径改为 `console.error` 原因。

**批次 14（`7581387`，多语言 URL）**：slug 按语言（迁移 0016：`post_translations.slug`，
NULL=跟随主表 `posts.slug`=默认语言值；**DROP 全局 UNIQUE 索引**，唯一性改为写路径按语言
检查 409；读一律 `COALESCE(t.slug,p.slug)`，规则 58）；hreflang（`lang_group` 兄弟版本 +
x-default）；`/{locale}/feed.xml`；`lang_nav` 切换器进 scope。规则 56–59 + 四道架构守卫 +
`_locale-url-inject.mjs` + `npm run gate`（纯 node 直调，刻意不含 tsc——lib.dom 上游噪音
淹没退出码）。**锁定教训**：publish-only 的 PUT 曾把 URL 改名成 entityId
（`tSlug || entityId` 兜底是 CREATE-only）。

**批次 15（`176331b`，数据驱动后台）**：①编辑器块面板从 `CORE_BLOCKS` 下发
（原硬编码 9 种 vs 渲染器 12 种——gallery/button/columns 一直插不出来），
`GET /api/v1/blocks`（原本零消费的端点）升级为翻译后形状；②Dashboard 统计卡为 API 下发的
`cards` 数组，插件经 **`dashboardCards` filter** 注入；③声明式设置表单按
`ALLOWED_FIELD_TYPES` 出类型感知控件，`options` 终于被持久化（迁移 0017——校验器一直接受
却从不存储）。三道新守卫（SPA 禁块名字面量 / dashboard 禁 stat 硬编码 / 13 类型逐个有 case）
+ `_skeleton-inject` 3 个新场景（23 场景 0 问题）。

**批次 16 Track 0（媒体隔离地基）—— ✅ 本轮完成**

起点是用户提的四条诉求（编辑器跟进 / 多语言体验 / 统一媒体控件 / 站点与用户隔离）。
勘察后先出方案（`docs/design/MEDIA-EDITOR-PLAN.md`，四条轨道），本轮只做 **Track 0**，
因为其余三条都依赖它。

| 项 | 状态 |
|---|---|
| 迁移 `0018_media_ownership.sql`：`media_files.uploaded_by` + `(site_id, uploaded_by, created_at)` 索引；`contract/schema.ts` 的 note 同步 | ✅ |
| `src/platform/media-policy.ts`：媒体访问策略的**唯一定义**（`isolation` / `require_session`，站点设置行 `cfpress.media`，解析不了=安全侧）+ `mediaKeyBelongsToSite` + `mediaReadDecision`（**返回拒绝原因**）+ `mediaOwnerClause` | ✅ |
| `/media/` 读取分支**移到站点解析之后**（与 sitemap/robots 同层），三闸门：key 属本站 / 策略要求时会话 / owner 隔离下必须是上传者；拒绝**一律 404** | ✅ |
| `api.ts`：上传写 `uploaded_by` + 校验站点真实存在；列表支持 `q`/`type`/`page`/`limit`/`total` 并按策略收窄；新增 `PATCH`（alt/title）与 `DELETE`（**先删 R2 对象再删行**）；dashboard 的媒体计数走同一条 owner 子句 | ✅ |
| **顺带修掉的第四个真缺陷**：`platform/sites.ts` 的站点列表 memo 注释写着"per-request"，实际以 `env`（isolate）为键且从不清理 → **新建站点在前台解析不到**（host 与 path 前缀都落到默认站）。修法：入口每请求 `resetSiteListMemo(env)` | ✅ |
| 新套件 `tests/suites/media.test.mjs`（69 条）+ 登记进四处注册表（`package.json` / `run-all.mjs` / `cfpress.sh` / `cfpress.ps1`） | ✅ |
| 新守卫（`architecture.test.mjs`，3 条）：`/media/` 分支必须在 `await resolveSite(` **之后**（**结构**判据，行为测试看不见它）+ 读取路径必须走 `mediaReadDecision` | ✅ |
| 新注入工具 `tests/tools/_media-inject.mjs`（**7 场景**，全部"注入→具名断言变红→还原→哈希一致"） | ✅ |
| `_tenant-query-audit.mjs` 重新键位（`api.ts:1357→1584`、`frontend.ts:145→186`，后者是批次 10 起就漂了的陈旧键） | ✅ |
| 规则 60 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**本轮的三条关键判断**（都写进了 `AGENTS.md` 规则 60）：

1. **三条闸门都答 404 ⇒ 断言必须盯"哪一条"**。`mediaReadDecision` 因此返回
   `site`/`session`/`owner`/`missing` 而不是布尔；套件把三条闸门**逐条单独打开**再断言。
   只在三条全关时断言"404"的写法，删掉任何一条都不会变红——这正是本仓库反复踩的
   "观测面"层假绿（§12）。
2. **守卫必须是结构的**。把 `/media/` 分支挪回站点解析之前，只要所有站点恰好都是默认站，
   行为测试全绿。所以守卫解析 `index.ts` 里两个锚点的**先后顺序**，注入场景 7 验证它。
3. **默认值本身是产品决定**。`require_session` 默认**开**（用户选定"站点校验 + 要求会话"）：
   未登录访客取不到媒体 ⇒ 前台 `<img>` 会 404。它被实现为站点设置而不是常量，
   就是为了让这个选择**可逆**，并且排障第一站就是它。`AGENTS.md` 规则 60e 明写了这一点。

**批次 17（部署配置改为生成）—— ✅ 本轮完成**

起点是上一批修 `vars` 漂移时留下的问题：`wrangler.local.jsonc` 是**手工维护**的 gitignore
文件，所以"两份配置同构"这条不变式**只能在本地守**，而且启动器与它说的根本不是一回事。

| 项 | 状态 |
|---|---|
| `wrangler.ids.json`（gitignore）：占位符名 → 真 id，**这条链上唯一手写的东西** | ✅ |
| `scripts/make-local-config.mjs`：导出纯函数 `renderLocalConfig(模板文本, ids)`；**文本替换**而非 JSON 序列化（保住注释）；幂等（无变化不写）；`--check` / `--print` | ✅ |
| `_config-parity.mjs` 重写：**重算再逐字节比对**（不再比键集），另加"模板无 id 形状值"泄漏守卫、ids ↔ 占位符双向对齐；缺文件时明确 **n/a 不是 pass** | ✅ |
| `package.json`：`dev`/`deploy`/`db:migrate*` 全部 `-c wrangler.local.jsonc`；新增 `config`、`predev`、`predeploy` 先跑生成器 | ✅ |
| 两个启动器：`CONFIG` 指向**生成物**，新增 `ensure_config`/`Invoke-EnsureConfig`（dev/deploy/migrate 前必跑），全部 `-c`；新增 `config` 动作与 `cfg` 菜单快捷键；`doctor`/`version` 报三份文件 | ✅ |
| 顺带修掉的**泄漏**：启动器原本 `wrangler deploy` **不带 `-c`**（= 部署占位符那份），拒绝信息还叫运营者**编辑被 git 跟踪的 `wrangler.jsonc`** —— 照做下一次 commit 就公开在用的数据库 id | ✅ |
| 顺带修掉的陈旧路径：ps1 `doctor` 读 `site\migrations`（该目录早已不存在）→ 恒报 `0 file(s)`，而 sh 报 18 | ✅ |
| `launcher-parity` §8b（+5 条）：每条 wrangler 命令必须带 `-c`（**锚在调用 `npx`/`Invoke-Npx` 上**，否则拒绝信息与进度行会假红）+ 读配置前必须先重新生成 | ✅ |
| `_launcher-inject.mjs` +2 场景（→18）；`_skeleton-inject.mjs` 两个配置场景改用新断言名（→48） | ✅ |

**这一批的两个教训**：

1. **"两份保持一致"守不住，要让它不可表达**。只断言"两份一致"仍然允许两份存在，也就允许
   再次漂移；生成之后，"不一致"没有写法。守卫因此改成**重算再比对**——它连"手改本地文件"
   都抓得住，而键集比较连值被改成 `"true"` 都看不见。
2. **守卫要扫"调用"，不要扫"子命令"**。`launcher-parity` 的第一版匹配 `wrangler deploy`
   子串，立刻在**拒绝信息**（`npx wrangler d1 create`，是建议）和**进度行**
   （`head1 "wrangler deploy"`）上假红。两个启动器只经 `npx`/`Invoke-Npx` 调 wrangler，
   锚在包装器上才是精确判据。**写守卫时先问：我匹配的是行为，还是提到这个行为的文本？**

**新基线**：**23 套件 + `_schema-scope`，24 项 / 1240 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`_tenant-query-audit` 每条命中都有裁决；`_media-inject` 7/7 场景有效。

**AUTH 计划批次 C（后台隐身：前缀可配 + cookie 收紧 + SPA base）—— ✅ 本轮完成**

来自 `docs/AUTH-ISOLATION-PLAN.md`（与 MENUS 计划的批次编号互相独立）。目标：把**整个后台**
（SPA + 资产 + API + 登录端点）挪到一个可配、猜不到的前缀，并让后台会话 cookie 只在该前缀下发送。

**改了什么**

1. **cookie 收紧**（`src/platform/auth.ts`）：`SESSION_COOKIE` 改名 `cfpress_session` →
   **`cfpress_admin`**；`login`/`logout`/`loginRequest` 接受 `cookiePath`，`Set-Cookie` 的
   `Path` 从写死的 `/` 改为**当前后台前缀**（`Path=/` 会把后台会话带上每个前台请求；
   名字要与批次 D 的 `cfpress_member` 区分）。
2. **前缀路由 + SPA base**（`src/index.ts`）：新增 `serveAdminIndex()`——不再把
   `/admin/index.html` 当静态文件直出，而是取回后**重写三处 `/admin/…` 资产路径**并注入
   `<script>window.CFP_ADMIN_BASE="…"</script>`；**后台 API 整套挂前缀之下**
   （`if(p.startsWith(adminBase+"/api/"))return handleApi(env, 剥前缀的 request)`——原来只有
   登录端点被特殊处理，其余落在 ASSETS 分支 404）；`/admin/*` 静态兜底加 `adminBase==="/admin"`
   门控，自定义前缀时旧资产也 404。
3. **SPA 全面改读注入的 base**：`state.js` 导出 `adminBase`（读 `window.CFP_ADMIN_BASE`）；
   `i18n.js`（leaf，不能 import state.js，故内联读同一个全局）两处 fetch 改用它；
   `auth.js` 登录 fetch 改用它，并区分 429（限流）与凭据错。
4. **测试**：`admin-spa` 新增规则 75 节（5 条，源码无裸绝对 URL / shell 锚点 / 两模块读全局 /
   运行时请求全带前缀）；`admin-contract` 新增 §0b/§0c（cookie Path / 旧登录 404 / 前台不
   Set-Cookie / 连错 6 次 429 / **把 `admin.path` 移到 `/manage`** 后新前缀可用且旧前缀连
   资产全 404，`finally` 里通过已移动的前缀改回）；`architecture` 新增规则 75 节（7 条结构守卫）；
   12 个套件的 cookie 名断言批量改 `cfpress_admin`。
5. **规则 75**（三处同步：AGENTS.md + ARCHITECTURE.md §10 + architecture.test.mjs）。

**验证**：`architecture` **154/0**（147→154，规则 75 节 7 条）；`admin-contract` **105/0**
（88→105，§0b/§0c 十七条）；`admin-spa` **79/0**（74→79，规则 75 节 5 条）；**24 套件逐个跑
/ 0 失败**（合计 **1548** + 26 = **1574**）；`tsc --noEmit` src/ 0 错误；
`_skeleton-inject` **80 场景 / 0 问题**（+3 batch-C 场景 +2 architecture 结构场景）。
**真实浏览器验收**（Chromium 驱动真 dev server）：shell 加载 / base 注入 / SPA 登录并渲染 /
所有 API 调用都在前缀下 / 无未捕获错误——**前缀默认与移到 `/manage` 两种情形各 5/5 通过**。

> ⚠️ **本轮踩到的坑（值得记）**：在 `src/index.ts` 的 `//` 行注释里写了 `` `/admin/*` ``，
> 其中 `/*` 让 `architecture.test.mjs` 的 `blankComments()`（非贪婪 `/\/\*[\s\S]*?\*\//g`）
> 一路吞到后文 `catch{/* ignore */}` 的 `*/`，**把整段路由抹成空白**——media 守卫的两个锚点
> 都变 `-1`，报「非空性」失败。代码是对的，是**注释里的字符**弄瞎了守卫。已记进 AGENTS.md。

**批次 E2（staff 按站点：UI 与切面，规则 79）—— ✅ 本轮完成**

E1 只修了**服务端**那半；E2 是**客户端**那半，它的失败方式不一样：**服务端不再读 `site_users.role`，
而仍然在渲染它的屏不会报任何错**。

1. **`users` 屏的「角色」列改为「本站角色」（`role_here`），安装级 `role` 从站点角色位挪开**。
   这是本批的真实缺陷：E1 之后 `x.role`（安装级身份列）不再是"在这里能做什么"的答案，屏上却还印着
   它——一个安装级角色是 `author`、却是**当前站点 `admin`** 的账号渲染成 "author"，而这是运维唯一
   用来判断"谁能做什么"的屏。端点早把 `role_here` + `sites` 映射 + 回声的 `site` 都发过来了，屏没读。
   - `superadmin` 单独一个徽标（`All sites`），**不当站点角色**：跨全站、排在所有成员行之上、
     不可从本站屏授予（端点 400，规则 78d）。
   - 「其他站点」列**逐个点名**（`default: Author · …`），没有其余站点时写「仅本站」——**空白格与
     渲染失败外观上无从区分**。
2. **站点-角色编辑器**（`data-user-roles`）：对话框列出**每个站点**及该人在其上的角色，选项含
   「无角色（无法打开）」＝撤权（`role: null`）。**只发变化的行**：端点没有"整表覆盖"形态，重写一行
   "本来就是那个值"的行在结果里看不见、在活动日志里却是真的。部分失败按部分失败报告（点名失败的
   那个请求 + 重读表格显示**实际落库**的样子）。
3. **站点切换器按角色过滤**——E1 的 `GET sites` 已按 `accessibleSiteIds` 过滤，所以 `state.sites`
   天然只含该用户有成员行的站点，**切换器不用改**。E2 的任务是**把这个事实钉住**：改成硬编码列表，
   被过滤掉的站点就会重新出现在切换器里、点下去 403（本批要消掉的"先给后拒"）。

**中英词典**：新增 19 个 key（**两个包都加**，架构守卫双向查对等），并**删掉过时的
`core.users.roleViewer` 与 `core.users.sub`**——`viewer` 这个角色在本产品的 `role_permissions` 里
根本不存在（规范是 admin/editor/author），下拉里留着它等于让人建一个零权限账号。顺手修了计划的
验证矩阵里**重复的 B/C 两行**（历史复制粘贴残留）。

**一处与计划的偏差（记录）**：计划写"`users` 屏加'站点-角色'编辑"，未指明**谁**能编辑。E1 把
`users.manage` 定为 install 级（只有 `superadmin`），所以定稿是**保持 superadmin-only**（受限的
站点管理员管内容、不管账号），**不新增一条没人要求的授权规则**。`admin-contract` §18 已断言 scoped
editor 打 `GET users` → 403，即这条约束在 UI 侧也成立。

**验证**：`architecture` **203/0**（195→203，规则 79 节 8 条）；`admin-spa` **87/0**（79→87，
"users 屏按站点显示角色" 8 条）；`i18n` **75/0**；`tsc --noEmit` src/ 0 错误；`_skeleton-inject`
**98 场景 / 0 问题**（新增 4 个历史形状场景，其中 2 个第一版守卫**没变红**，见下）。

**新基线**：**24 套件 / 1713 条 + `_schema-scope` 26 = 1739 条 / 0 失败**；`tsc` src/ 0 错误。

> ⚠️ **两条新守卫第一版是摆设，反向验证抓住的**（本轮的"能渲染是最强的假绿"换了个位置）：
> 1. `superadmin` 不在站点角色选项里——第一版写 `!/value:\s*"superadmin"/`，但源码里**根本没有这个
>    字面量**：选项是 `SITE_ROLE_VALUES.map(r => ({ value: r, … }))`。把 `superadmin` 塞进那个
>    数组（真正的泄漏路径）**它的守卫不会红**。修：钉住集合闭集 + 钉住"选项派生自该集合"。
> 2. 「读成员映射」第一版写 `/x\.sites|\.sites\s*\|\|/`，而屏里**另有**一处合法的 `.sites`（编辑器
>    对话框的初值），所以删掉渲染那一列**守卫仍绿**。修：锚到真正渲染它的调用
>    `otherSitesText(x.sites, …)`。
> **规律：守卫要锚在「消费」上，不在「出现」上**——同一条规律第三次出现（前两次在规则 69/78）。

**批次 E1（staff 按站点：权限接线）—— ✅ 上轮完成**

计划 `docs/AUTH-ISOLATION-PLAN.md` 批次 E 的一半（E1）。批次 D 分开了**身份**，这一批分开**权限**：
旧的 `can(env, user, permission)` 读一列 `site_users.role`，于是店铺站的 `editor` 到处都是 `editor`，
"此人能否**在此**发布"从来没被问过。地基换成 `site_users_sites(user_id, site_id, role)`——**一行一个
(人, 站)，行的缺席就是拒绝**。

**三条硬决定**（写进 `src/platform/permissions.ts` 头注 + `docs/ARCHITECTURE.md` 规则 78）：

1. **`siteId` 是必填参数**，不是「可选带默认」。可选会让某个调用点**悄悄**重问站点盲问题——而那个
   问题**仍然有答案**（它读到某人的一行），缺陷因此能通过评审。必填则编译器点名每一处必须表态"哪个
   站点"。守卫读签名，**同时拒绝** `siteId?: string` 与 `siteId: string = "…"`（后者 `=` 在类型之后，
   只匹配 `siteId\s*=` 会漏）。
2. **两类权限**：`PLATFORM_PERMISSIONS = {platform.manage, users.manage, extensions.manage}`
   （install 级，只有 `superadmin` 有）；其余按站点。**建/改/删站点改判 `platform.manage`**——站点还
   不存在时没有成员行可满足，按站点判是个无解的题。
3. **绝不回退到 `site_users.role`**。回退正是「从站点移除」变成「仍然有访问」的方式：成员行没了、
   回退照答、移除看起来生效而什么都没变。`superadmin` 是唯一有意的例外，且**首先**短路（它是"尚不
   存在的站点"的答案）。查成员表也必须**带站点过滤**：只留表、丢掉站点的查询形态合法、返回一行、
   **只是错的那行**。

**改动面**：迁移 `0023_site_user_roles.sql`（建表 + **平移** + 唯一 admin 提升 `superadmin`）；
`contract/schema.ts`（`site_users_sites` 声明为站点表）；`permissions.ts` 重写
（`can`/`requirePermission`/`accessibleSiteIds`/`siteRolesFor`/`SITE_ROLES`/`SUPERADMIN_ROLE`）；
`auth.ts`（见下）；`api.ts`（全部 **31 个** `requirePermission` 调用点补 `siteId`；`GET sites` 按成员
过滤；`users` GET 返 `sites` 映射 + `role_here`；`users` POST 同时写 `site_users` 与
`site_users_sites`；新增 `PUT users/:id/sites/:siteId` 授/撤站点角色）。

**基线级真实缺陷**（规则 78a 主角）：**`requireAdmin` 的硬编码角色列表漏掉 `superadmin`**。迁移
把唯一管理员提升为 `superadmin` 后，`admin-contract` §0b 立刻红——owner 被锁在**每一个**后台端点
之外。修复：`ADMIN_ROLES` 从 `SITE_ROLES` + `SUPERADMIN_ROLE` **派生**。规律：任何"允许哪些角色"
的集合都要**派生**自角色清单，写死的集合会在加新角色时静默过期。

**验收（`admin-contract.test.mjs` §18，31 条）**：A 站 editor 打 B 站 `content.write` → **403**；
同一请求在 superadmin 手上 → **200**（对照，证明 403 是权限而不是"路由坏了"或"缺 post type"）；
`GET sites` 只列成员站点（superadmin 列全部）；`platform.manage`/`users.manage` 对 scoped 用户即使
在自己站点也 **403**；`PUT users/:id/sites/:siteId` 授权后立即可写、撤权后立即 403（**无回退**）；
`users` 列表带 `role_here` + `sites` 契约；`superadmin` 不能从站点屏授予（400）。

> ⚠️ **每站点权限一落地，漏 `?site=` 的测试夹具立刻红**（本轮踩到）：`media.test.mjs` 在 `mta`/`mtb`
> 操作，却用 `POST /api/v1/users`（不带 `site=`）建 editor → 成员行落在 default → 在该站 403。
> 修：建在 `mta` 再 `PUT users/:id/sites/mtb` 授权（正是真实操作的两步）。**规律：`can` 一旦
> 站点感知，任何"建个用户然后去别的站点用它"的夹具都必须显式授权。**
>
> ⚠️ **`site_users_sites` 无级联 → 直接 `DELETE FROM site_users` 的测试留孤儿成员行**：四个套件的
> 清理已补 `DELETE FROM site_users_sites WHERE user_id IN (…)`。产品侧**没有**删用户端点，所以孤儿
> 只在测试里出现。**批次 F 已把清理立起来**：`platform/auth.ts` 的 `deleteUser(env, userId)`
> 两行一次 `batch` 删（成员行在前、身份在后），定义在身份旁边——失败形态不是"留一行"（没人指向
> 它时不可见），而是"后来复用同一 id 的用户继承陌生人的访问"。规则 80 钉住（含"`src/` 内不许
> 第二处裸删身份"）；加删用户端点时**调用它**，不要重新推导一半。

**批次 F（契约与守卫收尾）—— ✅ 上轮完成（2026-10-11）**

计划 `docs/AUTH-ISOLATION-PLAN.md` 批次 F。前三批（C/D/E）各自把一条**从前隐身的边界**
暴露出来（后台前缀可配、第二套身份、第二个租户）。F 是把这些边界**写进契约**，让下一个人
知道"它这一轮适不适用"：

1. **契约从 17 维扩到 20 维**。新增的三条（18 前台/后台分离、19 后台前缀隐身、20 每站点角色）
   **不是新坑**——它们在"只有一个实例"时全部**隐身**（一个身份 / 一个入口 / 一个租户），
   加第二实例才从"不存在"变成"必须回答"。契约 §8 专门解释这件事，并给出**共同规律**：
   *加第二实例时最该做的不是写代码，是先问"哪些从前只有一个的东西，现在有了两个"*。
2. **每条新增一个"什么时候适用"的判据**：契约 §2 补 4 行交织、§3 补 §3.10（新身份面）/
   §3.11（改权限判断）/§3.12（改后台入口）三份清单——写清"改了 X 就必须看它"，
   否则下一个人会在一条不适用的维度上写"已覆盖"，而真正适用的那条被跳过。
3. **新铁律 3b「守卫锚在消费上，不是提及上」**。批次 E2 的两条守卫**第一版都是死的**
   （一条锚在子串，`x.sites` 匹配到一处无关的读；一条锚在距离窗口，而 `state.sites.find(...)`
   自己就满足了窗口）。**是反向验证抓到的，不是评审抓到的**——所以铁律 3 是它的验证手段，
   不是可选项。写进契约 §0 与 `AGENTS.md`。

**规则 80（身份和它的成员行一起死）**：批次 E 把 staff 用户拆成身份（`site_users`）与成员行
（`site_users_sites`）——**把一行从另一行里拆出来，就会生出一行必须跟着第一行一起死的行**，
而这里没有级联。新增 `deleteUser()` 两行一次 `batch` 删。守卫**不看调用点，看函数体**：
只删 `site_users` 的写法在调用点读起来一模一样，却把孤儿重新引入。守卫额外跨整个 `src/`
词法禁止第二处裸 `DELETE FROM site_users`（测试清理里内联删除合法；管的是产品代码）。

**验证**：`architecture` **208/0**（203→208，规则 80 节 5 条）；`_schema-scope` **26/0**（确认三张
新表两轴齐，无需改动）；`_skeleton-inject` **99 场景 / 0 问题**（新增规则 80 场景，确认变红）；
`_residue-guard` **14 套件全部 `DB unchanged`**；`_tenant-query-audit` **每个 hit 都有裁决**
（新语句已写）；`tsc --noEmit` src/ 0 错误。

**基线**：**24 套件 / 1718 条 + `_schema-scope` 26 = 1744 条 / 0 失败**；`tsc` src/ 0 错误。

**`user-delete` 套件（批次 F 的行为验证）—— ✅ 本轮完成（2026-10-11）**

批次 F 的 `deleteUser()` 上文只有**静态守卫**（规则 80 读函数体、词汇禁第二处裸删）。用户要求
"自己去实际测试"——补一个**驱动真实函数打真实数据库**的套件 `tests/suites/user-delete.test.mjs`：

1. **反向验证的套件也需要反向验证**。先写 **negative control**：手写 `DELETE FROM site_users`
   （批次 F 之前的产品形状、也是"未来端点重新推导一半"会写的形状）→ 断言成员行**确实**变孤儿。
   没有这一步，正向断言可能在"成员行本来就空"时假绿。
2. **调用真函数**：`esbuild` 单独 bundle `src/platform/auth.ts`（external `cloudflare:workers`），
   拿到真的 `deleteUser` 调它——测的是它对数据库的**效果**，不是它在文件里的字符串。
3. **原子性用 spy 证明**：一个记录 `batchCalls`/`batchSize`/`topLevelRuns` 的 D1 适配器（用
   `inBatch` 标志区分"batch 内部执行"与"顶层执行"）。若实现是两次独立 `.run()`，spy 会看到
   0 batch / 2 run——中间态（身份没了、成员行还在）对读者可见。
4. **套件要能自愈**：本地 D1 是**跨套件共享**的，上一次跑崩在 cleanup 之前会留下孤儿成员行。
   sweep 因此**按 id 前缀直接删孤儿**（不靠"身份还在"的子查询，否则找不到孤儿）；且每个 section
   在 `mkUser` 前先清自己的行——**真回归应在每个 section 各报一条失败**，而不是在 section 4 被
   `UNIQUE constraint failed` 打断、把后面几个断言藏掉。

**反向验证（套件本身）**：把 `deleteUser` 变异成"只删身份"（批次 F 之前的形状）→ 套件在
section 3/4/5 **各报失败共 4 条**（`and so is every membership row` / `deleting them removes their
membership too` / `the batch carries both statements` / `the person is fully gone after that one call`），
**不中断、summary 照常打印**；恢复后 16/0。**硬化前**同一变异会 `UNIQUE constraint failed` 中断。

**入四张表**（维度 16）：`package.json`（`test:user-delete` + `test` 链）、`tests/run-all.mjs`、
`scripts/cfpress.sh`、`scripts/cfpress.ps1`。守卫 `launcher-parity` **62/0**；反向验证：
改名注册键 → 守卫报 `no suite name is listed only by .sh/.ps1` 两条（**指名道姓、不中断**）；
整条删除 → 再加报 `every tests/**/*.test.mjs on disk is in the launcher table` 与
`every suite in npm test is in the launcher table` 三条。

⚠️ **踩坑（本轮实测）**：Python **文本模式写入会把整个文件转成 CRLF**，而 `cfpress.sh` 被
`.gitattributes` 钉成 LF——`SUITES="…"\n` 的解析正则匹配不到 `"\r\n`，守卫报"table not found"
（**看起来像守卫坏了，其实是变异方法污染了被测文件**）。改脚本一律**二进制模式**（`'rb'`/`'wb'`），
改完 `python -c "print(open(p,'rb').read().count(b'\r\n'))"` 确认为 0。

**新基线**：**25 套件 / 1734 条 + `_schema-scope` 26 = 1760 条 / 0 失败**；`tsc` src/ 0 错误。

**验证**：`architecture` **195/0**（180→195，规则 78 节 15 条）；`admin-contract` **192/0**
（161→192，§18 三十一条）；`media` **71/0**（69→71，两站点成员授权）；`_schema-scope` **26/0**；
`tsc --noEmit` src/ 0 错误；`_skeleton-inject` **94 场景 / 0 问题**（新增 6 个历史形状场景）。

**新基线**：**24 套件 / 1696 条 + `_schema-scope` 26 = 1722 条 / 0 失败**；`tsc` src/ 0 错误。

**批次 D（前台会员：两套身份结构性分离）—— ✅ 上轮完成**

计划 `docs/AUTH-ISOLATION-PLAN.md` 批次 D。前台要有自己的身份（读者能注册、登录、留言），
而它与后台身份的隔离**必须由构造保证**，不是由某个"记得写"的检查把门——否则「member cookie
能不能打后台端点」这件事就取决于某一行代码有没有被漏掉。

**两套登录从存储到 cookie 完全分离**

| | 后台 staff | 前台 member |
|---|---|---|
| 身份表 | `site_users`（install 级） | **`members`（按 `site_id`）** |
| 会话表 | `admin_sessions` | **`member_sessions`** |
| cookie | `cfpress_admin`，`Path=<后台前缀>` | **`cfpress_member`，`Path=/`** |
| 端点 | `{前缀}/api/v1/…` | **`/api/v1/front/…`** |
| 密码哈希 | `shared/crypto.ts`（PBKDF2 25k） | 同一份实现 |

「毫无关联」的落地方式就是**不同的表 + 不同的 cookie 名 + 不同的端点族**：两个会话表是
不同的表，因此 member 会话 id 天然不是合法 admin 会话 id（**没有东西可交换**）；
`currentMember` 读 `member_sessions`、`currentUser` 读 `admin_sessions`，互不可见——
**隔离是构造性的，不是策略性的**。

**改了什么**

1. **迁移 `0022_front_members.sql`**：`members`（PK + `site_id NOT NULL` + `UNIQUE(site_id, username)`）
   与 `member_sessions`（PK + **`site_id NOT NULL`**）。⚠️ `member_sessions` 带 `site_id` 走过一次
   设计反转：初版按派生租户声明（可由 `member_id` 推出），`_schema-scope` 立刻报缺列；真正的
   原因是 `deleteSite()` 用统一的 `DELETE FROM <table> WHERE site_id=?` 遍历 purge 清单，
   **没有 `site_id` 的表进不了循环**。规律：派生根租户表只在局部列**冗余**时才对（连接表）。
2. **`src/platform/members.ts`**（新）：`registerMember`/`loginMember`/`logoutMember`/`currentMember`/
   `requireMember`。每个函数都要 `siteId` 并把它放进 WHERE（连接的两半都带）；`publicMember`
   永不暴露 `password_hash`；注册受 `members.registration`（**站点级**设置，默认关）控制。
3. **`/api/v1/front/{auth/register,auth/login,auth/logout,me}`**（`src/api.ts`）：
   `closed` → 403、凭证错 → 401、`me` 无会话 → 401。**⚠️ 真实缺陷（先于测试发现）**：
   带前缀站点 `/accm/api/v1/front/…` 404，两个根因——(a) 站点解析原先放在 `routeFrontApi` 内部，
   而 API 层运行在站点解析**之前**，永远只解析到 default；(b) `if(request.method!=="GET")→ASSETS`
   的兜底在站点解析之前，把所有 POST 送进静态资源层。修复：抽出 `handleFrontApi(env,request,siteId,
   resolvedPath)`，由 `index.ts` 的 `frontApiRelPath()` 识别路径、**先 resolveSite** 再调用。
4. **主题侧（D2）**：`content/themes/default/templates/{login,register}.html` + `theme.json` 路由 +
   `parts/styles.html` 的 `.auth` 样式 + 中英词典各 18 键；`parts/header.html` 加登录/账户入口。
   `ThemeRenderOptions` 新增可选 `request`，`buildScope` 输出 `member`（走 `currentMember`，
   **绝不**是后台解析器）。
5. **静态主题路由不再跑无约束查询**：不声明 `query`/`resolve` 的路由（`/login`、`/register`）
   原先仍执行 `runThemeQuery` 的默认 `type:"post", limit:10`，为一个不读它的模板白付一次查询。

**红线验收（`admin-contract.test.mjs` §17，35 条）**：member cookie 打后台 API → **401**；
admin cookie 打 `/front/me` → **401**；A 站 member 在 B 站登录失败（`invalid_credentials`）；
注册关时 **403**；带前缀站点可注册且加入该站；登出后会话失效；响应体不含 `password_hash`。

**比看上去严重得多的缺陷**（规则 77 主角）：如果把 `member_sessions` 与 `admin_sessions` 合成
一张表（"加个 role 不就行了"），member 会话 id 就**天然是**合法 admin 会话 id，红线只能靠一个
"记得写"的检查维持——而那正是本批次存在的理由。规则 77 因此断言的是**代码结构**（两个解析器
各读各的表、cookie 名不同、两表带 `site_id`），不是运行时行为。

> ⚠️ **本轮踩到的坑（值得记）**：`blankComments()` 陷阱**第三次**。我在 `src/api.ts` 新写的
> 注释里三处写了 `/front/*`，每个 `/*` 吞掉后文直到某个 `*/`，`api.ts` 变成 31 个 `/*` / 28 个 `*/`
> → 规则 76a 的 `GROUP BY site_id` 锚点「不存在」。此后加了**注释标记平衡守卫**（architecture 2 条），
> 它立刻又抓到 3 处潜伏的同型问题：`validation.ts`（`langs/*.json`）、`packs.ts`
> （`plugins/*\/langs/*.json`，两个 `/*`）、`runtime-worker.ts`（`/__cfpress/theme-api/*`）。
> **项目约定：注释里写通配一律用 `…`（U+2026），不写 `*`。**

**验证**：`architecture` **180/0**（163→180，规则 77 节 17 条）；`admin-contract` **161/0**
（133→161，§17 三十五条含两条红线）；`theme-default` **64/0**（51→64，§8b 十条 + §9 三张模板）；
`_schema-scope` **26/0**（新表两轴分类与真库一致）；`_tenant-query-audit` 全部命中已裁决；
`tsc --noEmit` src/ 0 错误；`_skeleton-inject` 重跑（新增 4 个历史形状场景）。

**当时基线**：**24 套件 / 1648 条 + `_schema-scope` 26 = 1674 条 / 0 失败**；`tsc` src/ 0 错误。
（批次 E1 后升至 **1696 + 26 = 1722**；批次 E2 后升至 **1713 + 26 = 1739**。）

**批次 28（站点屏管理深度 + 还债）—— ✅ 已完成**

体检结论是「站点可用但浅」：CRUD 全通，但一行站点信息里**看不到它的前台在哪、有多少内容、
用什么主题**，新建的站点还是个没有任何语言选择的空壳。§3.2 的还债（`deleteSite` 清
`theme_table_defs`/`admin_menu_registry`）**早已由 `91664e0` 完成**，所以本轮做的是 §3.1 + §3.3。

**改了什么**

1. **`GET sites?withCounts=1`**（`src/api.ts`）：一次聚合给出每站的 posts/pages/media 计数与它
   选定的主题。计数是**每个度量一条 `GROUP BY site_id` 查询**（成本与站点数无关，不是 N+1），
   媒体计数走 `readMediaPolicy` + `mediaOwnerClause`——和媒体列表、仪表盘卡片同一口径，
   否则「这里数出来 5、库里只显示 3」没人能对账。**不带 `withCounts` 时 payload 逐字节不变**
   （`counts`/`theme` 完全不出现），因为站点切换器与 `themes.js` 都读这个端点。
2. **主题列读 `settings['theme.active']`，不读 `activeTheme()`**：后者答的是「该用什么渲染」、
   会探测 R2 并按「装了就算数」命名主题，用于报表会把**没选过主题的站点标成有主题**。
   未选 = 空字符串（不是 `null`，也不借默认站点的名字）。
3. **`public/admin/js/screens/sites.js`**：每行新增前台预览链接（`siteFrontEnd()` 按**该站点自己的**
   `path_prefix` → `/shop/<locale>`、`host` → `https://host/<locale>`、否则 `/<locale>`）、
   内容概况列、主题徽标（点击先 `switchSite` 再 `go("themes")`，这样「在此站点激活」才指对租户）；
   新建站点成功后弹「下一步」引导设默认语言（读 `i18n/locales?site=<新站>`，PATCH 同一个 `?site=`）。
4. **修掉一个根因 bug**：`createSite` **从未调用** `seedSiteLocales`，而该函数自己的 doc 写着
   "Called when a site is created"。新站点因此**没有任何 `site_locales` 行、没有默认语言**，
   一辈子骑在「无行 → 服务整个字典」的兜底上——这正是「新站点是空壳、语言没人选过」的来源，
   也是它一直隐身的理由（**服务出来的语言列表两种情况下完全一样**）。断言因此读**表里的行**。
5. **规则 76**（三处同步：AGENTS.md + ARCHITECTURE.md §10 + architecture.test.mjs，6 条结构守卫）。

**验证**：`admin-contract` **133/0**（105→133，§16 二十三条 + §15b 五条）；`architecture` **161/0**
（154→161，规则 76 节 6 条 + 规则 75b 的 `u.search` 1 条）；`tsc --noEmit` src/ 0 错误；
`_skeleton-inject` **84 场景 / 0 问题**（新增 4 个历史形状场景：`COUNT` 丢 `GROUP BY` /
主题改走 `activeTheme()` / 新建站点不播语言行 / **前缀挂载丢 query**）；
**真浏览器验收** 12/12（站点屏：计数一次请求 + 每行真三元组 + 预览链接按各自前缀/host +
主题徽标 + 点击切站点上下文跳主题屏 + 无未捕获错误），批次 C 验收回归 5/5。

> ⚠️ **本轮抓到的最有价值的一个缺陷**：`src/index.ts` 把后台 API 挂到前缀下时，重建 URL
> **只用了 `u.origin`，把 `u.search` 丢了** —— 经前缀进来的请求**所有查询参数全丢**
> （`?site=`/`?withCounts=1`/`?locale=`/分页），而 `/api/*` 那条因为拿的是原始 request
> 照常工作。**没有一个请求会报错**：`?site=` 掉了就是「当前站点」= 默认值，于是租户选择器
> 静默解析到错的站点。单测没抓到（它们自己在带前缀的路径上构造请求），是**真浏览器验收**
> 里站点屏的计数列空着才暴露的。已修（`+u.search`）并补三层守卫。

> ⚠️ 另一个反复出现的坑：**行注释里写 `/*`**（哪怕只是 `/api/*` 这种通配写法描述）会让
> `architecture.test.mjs` 的 `blankComments()` 一路吞到后文某个 `*/`，**把整段代码抹成空白**
> ——本轮在 `src/index.ts` 同一个位置**第二次**触发了它（6 条守卫在正确的代码上变红）。
> 自查：`(src.match(/\/\*/g)||[]).length === (src.match(/\*\//g)||[]).length`。

> ⚠️ 顺手确认：**不带 `GROUP BY site_id` 的 `COUNT`** 是最像对的错答案——它给出平台总数，
> 每一行都是个像样的数字，**只有第二个站点存在时**才能看出它错。单站点安装里 100% 假绿。

> ⚠️ 顺手确认：**不带 `GROUP BY site_id` 的 `COUNT`** 是最像对的错答案——它给出平台总数，
> 每一行都是个像样的数字，**只有第二个站点存在时**才能看出它错。单站点安装里 100% 假绿。

**批次 27（小工具站点隔离 + 前台接线）—— ✅ 上轮完成**

批次 26 体检的延续：小工具是三无（无内容编辑、无删改、**前台零接线**），且
`widget_instances` 建表时**没有 site_id**、唯一读路径连租户过滤都没有——多站点下每个
站点的侧栏会显示所有站点的小工具（规则 6 泄漏的菜单孪生）。本批次一次修完三件事。

**改了什么**

1. **迁移 0020**：重建 `widget_instances`（site_id + locale，旧行归 default，与 0009
   同哲学），索引 (site_id, sidebar, sort_order)；契约 `tenant: "site"`。本地与远端均已应用。
2. **API 补齐**：GET/POST/PUT/DELETE 全 scoped；config 按类型校验（text/html→body、
   recent-posts→count 1–20、menu→menu_id 必须属本站点）；新端点 `theme/sidebars`。
3. **前台接线（核心）**：`platform/frontend.ts widgetGroups()`（site+enabled+locale 过滤，
   locale 语义同 menu_items：`''`=全语言、指定语言只在该语言页面渲染，**故意不跨语言
   回退**）；渲染 text(esc)/html(原文，仅管理员可写)/recent-posts(按语言标题+前台 URL)/
   menu(复用菜单条目查询)；`buildScope` 输出 `widgets.<sidebar>`（无则无键）；
   layout.html 加 sidebar 区、footer.html 加 widgets 区，styles.html 补样式；
   theme.json 声明 `sidebars[]`（sidebar+footer）。
   → **规则 74**，三处同步。
4. **小工具屏重写**：按声明侧栏分组卡片，每卡类型徽标/标题/语言徽标/启停/上下移/编辑/
   删除（确认对话框）；对话框按类型出字段（正文 textarea/数量/菜单选择）；全部 scoped。

**验证**：`architecture` **141/0**（136→141，规则 74 节 5 条）；`admin-contract` **80/0**
（70→80，§14 十条）；`theme-integration` **134/0**（119→134，§12 独立站点 widgetest
端到端 15 条：四类型渲染 + 禁用不出现 + 异语言不出现 + default 站点小工具不泄漏）；
`_skeleton-inject` **73 场景 / 0 问题**。**24 套件逐个跑 / 0 失败**（合计 1495 + 26 = 1521）。

**批次 26（菜单管理 + 位置确定性）—— ✅ 上轮完成**

用户报告**菜单 / 小工具 / 站点没有实现**。实测三个功能是三种不同的"半成品"：菜单=底子在
（表/API/前台渲染）但后台只能看不能管、`menu()` 取 header 菜单 `LIMIT 1` **无 ORDER BY**
（两个 header 菜单时导航随 SQLite 心情翻转）；小工具=三无（方案批次 27，见
`docs/MENUS-WIDGETS-SITES-PLAN.md`）；站点=CRUD 全通但管理浅（批次 28）。本批次做菜单。

**改了什么**

1. **规则 73（菜单位置解析必须确定性）**：`menu()` 重写为 `menusForLocation(env, siteId,
   location, locale)`，`ORDER BY id LIMIT 1`——最小 id 稳定获胜；位置集合来自**激活主题
   manifest 的 `menuLocations[]`**（`buildScope` 渲染时直读，**不落库、不需要重新激活**——
   区别于 routes[] 的注册机制，rule 69 的坑这里天然不存在）；输出 `menu.<id>` +
   `menu.<id>_html`，`menu.primary*` 保留为 header 别名（旧模板兼容）。default 主题声明
   header+footer 两个位置，footer.html 消费 `menu.footer_html`。
2. **菜单管理 API 补齐**：`PUT/DELETE menus/:id`（删除连带删条目）、`PUT menus/:id/items`
   （批量重排：服务端先验每个 id 属于本站点本菜单再写）、`PUT/DELETE menu_items/:id`
   （嵌套仅一层：父必须同菜单、非自身、无父级；删父条目子条目升级为顶级）；全部 site-scoped。
3. **菜单屏重写**（`public/admin/js/screens/menus.js`）：左列菜单列表（新建/改名/换位置/
   删除带确认），右列条目树——添加条目（自定义链接/文章/页面选择器，URL 按前台形状
   `/{locale}/blog/{slug}` 计算）、行内编辑（标题/URL/语言/上级）、HTML5 拖拽重排（同父级内，
   一次 PUT 提交全序列）、逐条删除。新增 `theme/menu-locations` 端点供 SPA 拿声明位置。
   → **规则 73**，三处同步（AGENTS.md + ARCHITECTURE §10 + architecture.test.mjs 4 条）。

**验证**：`architecture` **136/0**（132→136）；`admin-contract` **70/0**（59→70，§13 菜单
契约 11 条）；`theme-integration` **119/0**（106→119，§11 独立站点 menutest 上双 header
菜单确定性获胜 + footer 位置渲染 + 二次渲染一致）；`_skeleton-inject` **71 场景 / 0 问题**
（LIMIT 1 无排序 + 渲染器硬编码 header——两条历史形状；单行锚点教训：注入器只用
`before[0]`，多行锚点要写成单行）。**24 套件全部逐个跑过 / 0 失败**（合计 1465 + 26）。

**批次 25（主题强制卸载）—— ✅ 上轮完成**

用户拿着本地管理界面报告：测试残留主题（Acct Theme / admtheme / detheme…）**"主题又是删除不了"**。
实测：这些主题各被一个残留站点占用着（`settings.theme.active` 逐站点），点「卸载」弹的是
**死胡同对话框**——"仍被以下站点激活，请先在那里停用"，而界面上没有任何出口。409 的语义是对的
（正在渲染的主题不许静默消失），**错的是拒绝不带出口**——与死锚点、不可达对话框同族：
一句真实但没用的真话。

**改了什么**

1. **`uninstallTheme` 加 `?force=1`**：不带 force 照样 409（权威不变）；带 force 先把每个
   占用站点的 `theme.active` 改回**捆绑默认主题**（规则 66 保证可渲染——回落永远是能渲染的
   站点），再走同一条卸载清理（能力/菜单/设置/生成表/R2 本来就按主题名全局删）。
2. **主题屏**：占用卡片的「卸载」改为**确认对话框**（列出站点 + 说明回落 +
   "停用并卸载"），确认后带 `?force=1`。词典：`core.themes.stillActive`（死胡同文案，
   唯一调用点随之消失）替换为 `core.themes.forceDesc` / `core.themes.forceConfirm`（两包对齐）。
   → **规则 72**（拒绝必须带出口），三处同步。

**验证**：`theme-integration` **106/0**（101→106：占用中 force=1 → 200 + 占用站点回落
default + 主题真没了，再重建状态验证非强制路径不变）；`architecture` **132/0**（+2）；
`_skeleton-inject` **69 场景 / 0 问题**（force 被无视——历史形状逐字）。

**顺带用新出口清掉了本地残留**（acct/shop/de/adm 的 4 个残留主题 force 卸载、5 个残留站点
删除——下次跑套件它们会回来，这是套件共享本地 D1 的已知行为，不是缺陷）。

**批次 24（后台多语言：列表代表行 + 版本徽标 + 编辑器切换取数）—— ✅ 本轮完成**

起点是用户的两句话：**"列表按站点默认语言取代表行，并允许按语言过滤"** 与
**"编辑器里语言切换后，内容部件的语言还是没有切换过去"**。第二句量出来是一个
**比看上去严重得多的缺陷**（规则 71，批次 24 的主角）。

| 用户的观察 | 实测根因 |
|---|---|
| 中文文章不在后台列表 | `listPosts` 故意每 post 一行，代表行取 `MIN(locale)`——**字典序**，`en` 只是字母表巧合，与"站点默认语言"无关 |
| 编辑器切换语言后内容不跟着切 | 共享行形态（一个 `posts` id、每语言一行翻译）把**所有语言的内容**装进 `GET posts/{id}` 的一个响应；版本条点击后**只改 `state.editing.locale`**，标题和块还是上一个语言的。**在这种状态下点保存，会把上一个语言的内容写进另一个语言的行**——200 + 静默毁数据 |

**改了什么**

1. **`listPosts`**：代表行 = `siteDefaultLocale`（`?locale=` 显式过滤仍可用）；每行附
   `locales`（该文实际拥有的语言集合）；**被过滤语言没有行的文章仍然列出**（标题空 +
   徽标说明有哪些语言）——静默吞行就是"中文版丢了"的温床。
2. **单篇 GET**（posts/pages + 自定义类型两处）：`items[0]` = 默认语言行
   （`ORDER BY CASE WHEN t.locale=? THEN 0 ELSE 1 END`），不再"哪个翻译排最前就是哪个"。
3. **`editor.js`**：`editContent(type, id, wantLocale)` 在语言行里挑匹配行；
   `switchVersion` 对已存在版本**总是重新取数**（同 `posts` id 也不例外——共享行形态
   恰恰需要它）。改名形状 `current.locale = locale; render()` 被结构性禁止（规则 71b）。
4. **`content-list.js`**：语言过滤下拉（站点启用语言，默认项 = 站点默认语言）+
   每行**版本徽标**（`en ✓ zh-CN ✓`，当前展示语言高亮）；词典补
   `core.content.localeDefault`（两包对齐，仍 413+ 键）。
→ **规则 71**（语言切换是取数，不是改名），三处同步。

**验证**

- `admin-contract` **59/0**（54→59，§12：默认语言代表行 + `locales` 集合 + 显式过滤 +
  未翻译行不被吞——构造了默认语言 ≠ 字母序第一的站点让两个答案可观测地不同）；
  `admin-spa` **63/0**（56→63，版本条切换后标题/块/徽标来自目标语言的行 + 列表徽标/过滤）；
  `architecture` **130/0**（+3，规则 71）。
- `_skeleton-inject` **68 场景 / 0 问题**（新增 4：编辑器只改名【历史形状逐字】/
  列表钉死语言 / 丢 `locales` / 列表只显示行自己的语言）。
- `tsc --noEmit --skipLibCheck` 0 错误。

**新基线**：**24 套件 / 1430 条 + `_schema-scope` 26 = 1456 条 / 0 失败**；`tsc` src/ 0 错误。

**批次 23（post_meta 语言维度 + reading_time + /blog 归档）—— ✅ 本轮完成**

起点是用户引用批次 22 的两条「仍未修」并点名：**"这个要做。另外文章列表没有中文的文章列表？"**
先量后动，量出来三件事里**两件半已经存在**，还额外量出**两个同族静默缺陷**：

| 用户的问题 | 实测答案 |
|---|---|
| 文章列表没有中文的？ | **存在**——`/zh-CN` 首页「最新文章」网格与「最近发布」榜单都显示 5 篇中文文章。缺的是**归档路由**：`/en/archive`、`/zh-CN/archive`、`/blog`、`/zh-CN/blog`、`/zh-CN/tag/design` 全部 404（主题带了 `archive.html` 却没有任何路由指向它）；导航「文章/专题/榜单/关于」全是**页内锚点**，且 `#sec-topics` 指向一个**不存在的 id**（死锚点） |
| post_meta 跨语言共享 | 属实。迁移 0019 重建表（SQLite 改不了 PK） |
| 列表 reading_time | 做了——**且推翻了自己上一批的结论**（见下） |

**额外量出的两个缺陷（同一族：声明了、模板读了、没人喂）**

1. **`findContent`（单页）从来没挂过 meta**——线上文章 kicker 恒是 "Long read · CFPress"，
   而 `single.html` 读 `{{post.meta.category}}`。列表卡片有分类名、文章页没有，HTTP 200。
2. 死锚点 `#sec-topics`：指向不存在 id 的链接不报错、不 404，**只是什么都不做**。

**改了什么**

1. **迁移 0019**（`post_meta` 加 locale 维度，B5）：SQLite 不能 ALTER PK → 重建表
   （`PRIMARY KEY(post_id, meta_key, locale)`），旧行全部落 `locale=''`。
2. **读阶梯唯一定义** `platform/post-meta.ts`（`resolveMetaByPost` / `metaLocaleRank`）：
   本语言（0）→ 站点默认语言（1）→ `''` 遗留行（2）→ 任意（3）。**遗留行故意不回填**
   （0019 头部注释记录原因）——回填替用户决定归属，而第 2 层已让未重新保存的数据照原样渲染。
   三个读者（列表 `attachMeta` / 单页 `findContent` / 主题 Worker `postMetaMap`）+ admin 的
   语言行展开全部走它；写入（`savePost` meta upsert）绑定本次保存的 locale。
   → **规则 70**（AGENTS.md / ARCHITECTURE §10 / architecture.test.mjs 三处同步）。
3. **列表 `reading_time`**：`runThemeQuery` 给每行 `it.reading_time = readingTime(it.html, 220, locale)`。
   **勘误**：批次 22 文档写"逐行 renderBlocks 会撞 10ms CPU"——**错的**。`attachMeta`
   本来就逐行渲染 `html`（卡片要用），reading_time 只是对已渲染 HTML 的字符串扫描，
   没有第二遍渲染。一个错误结论让一个字段缺席了两批。
4. **`/blog` 归档路由**：`theme.json` 声明 `routes[]`（`/blog` → `archive` 模板，query 取
   `type:post, limit:50, created_at desc`）→ 激活/启动时 upsert 进 `theme_routes` → 路由器按语言匹配。
   `matchRoute` 要求段数相等，所以 `/blog` 路由**遮不住**内置 `/blog/{slug}` 单篇处理（在其后）。
   `itemUrl` 用 `/{locale}{routeBase}/{slug}`，归档卡片的链接自动是 `/zh-CN/blog/<中文 slug>`。
   归档标题从 `theme.strings.archive.title` 读（两包各 +1 键，57 键对齐）。
5. **导航修复**：「文章」改为常驻 `/{locale}/blog` 链接；「专题/榜单/关于」保留为首页锚点，
   并给标签 aside 补上 `id="sec-topics"`（死锚点 = 不报错的坏链接）。
6. **播种脚本双语化 meta**：en `Design/Life/Technology` + 英文标签，zh-CN `设计/生活/技术`
   + 中文标签；**删掉批次 21「共享字段按站点默认语言写」的权宜限制**。

**验证（本地全部实测）**

- `/zh-CN` 首页分类 `设计 9 / 生活 4 / 技术 7`（en：`Design 6 / Life 3 / Technology 6`）；
  首页 reading_time 标记 14/12；`/zh-CN/blog` → 「全部文章」5 卡、链接 `/zh-CN/blog/<中文 slug>`；
  文章 kicker 「设计 · CFPress」（原 "Long read"）；`id="sec-topics"` 恰一次。
- 阶梯第 2 层实测：删掉 zh 行后中文单页回落显示英文值。
- `tsc --noEmit` src/ 0 错误；`locale-url` **36/0**（30→36，§1b 六条新断言）。

**本轮学到的一条**

- **错误结论比没有结论更持久**：10ms CPU 的成本分析看起来像测量，于是 reading_time
  缺席了整整两批没人质疑。量它只花了一分钟——`attachMeta` 的循环就在那里。

**线上部署与验证（2026-10-11）**

- `migrations apply --remote`（0019 ✅）→ `deploy`（6 个主题资产更新、三条 `CFPRESS_*` binding 可见）。
- **部署后 `/zh-CN/blog` 404**：新声明的 `routes[]` 只在**激活**时 upsert 进 `theme_routes`，而
  `ensureThemeCapabilities` 的计数谓词看到主题**已拥有**能力行就跳过——它是"从零修复"，不是"增量同步"。
  管理员重新激活后返回 `"routes":1`，归档立即生效。**运行事实：主题清单新增声明（routes/blocks/…）
  在既有安装上需要重新激活该主题**（新安装不受影响——boot 链从零装）。
- 播种前实测旧 `''` 行照旧渲染（中文页仍显示 Design/Life/Technology）——**阶梯第 2 层在线上成立**；
  重新播种 12×200 后 `/zh-CN` 显示 设计/生活/技术。
- 线上终验 **17 项全过**：`/zh-CN/blog` 与 `/en/blog` 各 5 卡（中文卡用中文 slug：`/zh-CN/blog/ni-hao-shi-jie`）、
  文章 kicker `设计 · CFPress` / `Design · CFPress`（原 "Long read"）、导航双语言指向 `/blog`、
  `id="sec-topics"` 恰一次、`/zh-CN/feed.xml` 5 条。

**新基线**：**24 套件 / 1415 条 + `_schema-scope` 26 = 1441 条 / 0 失败**；
`_skeleton-inject` **64 场景 / 0 问题**（本轮新增 5 条）；`tsc --noEmit` src/ 0 错误。

**批次 22（双语内容上线 + 注册行不等于安装）—— ✅ 本轮完成**

批次 21 的收尾是用户的第三个选择：**"本地 + 线上都做"**。本地那一半已完成并验证，
这一轮补线上，**而线上立刻暴露了一个真缺陷**。

| 检查项 | 线上（播种前） | 线上（播种后） |
|---|---|---|
| `/` 与 `/zh-CN` | 200，但都是"还没有发布任何内容" | 200，**各 5 篇**，标题各按语言 |
| 切换器 | 已有（`en / zh-CN`） | 已有，且**文章页指向译文自己的 slug** |
| 中文主题文案 | 已生效 | 已生效 |
| `/zh-CN/feed.xml` | 空 | **5 条**，中文标题 + 中文 slug |
| `/sitemap.xml` | 只有 2 条语言首页 | **14 条**（7 en + 7 zh-CN，各自 slug） |
| hreflang / canonical | 首页级 | 文章级三件套（en / x-default / zh-CN）+ 按语言 canonical |
| 分类 / 标签 | — | **未分类**（播种 12 次 200，`post_meta` 一行没写） |

**真缺陷：一行 `theme_installs` 让主题能渲染，不让它拥有任何东西。**

`GET theme/fields` 线上返回 `{"items":[]}`，而主题正在服务每一个页面——包括中文页、
切换器、feed、sitemap。手工 `POST extensions/themes/default/activate` 立刻返回
`"fields":2`，字段才登记上。根因：`seedBundledExtensions`（`extensions/plugin/runtime.ts`）
只 upsert 注册行 + 清单，**从不调用 `applyThemeCapabilities`**。激活是**用户动作**，
全新安装里没有这个动作；`activeTheme()` 又会 `ORDER BY active DESC, installed_at ASC`
回退并探测可加载的 `index.html`，所以主题**照样渲染**，只是库里的声明面全空。

后果不是"前台坏了"，是**前台全对、后台全哑**：没有声明字段 → 编辑器一个自定义字段都不显示，
`savePost` 的 `fieldExists` 闸门把每个 `meta` 原样丢掉（HTTP 200、零报错、零写入）。
**表象像内容问题，根因是主题从来没被安装过。**

**修法（规则 69）**

- `ensureThemeCapabilities`（`extensions/theme/capabilities.ts`）：逐站点解析活动主题，
  声明了可计数的能力却**一行都不拥有**时才安装。
- 接到 `index.ts` 的 boot 块：`await seedBundledExtensions(env)` **之后**跟
  `await ensureThemeCapabilities(env)`。**顺序是断言不是细节**——后者经 `theme_installs`
  解析活动主题，而那行正是前者创建的；反过来它会在自己本该修复的那次启动上读到空注册表。
- 为什么不能放进 seeder：**规则 4 禁止 `plugin/` import `theme/`**。`index.ts` 是唯一允许
  同时知道两层的模块，链就接在那里。
- 判据是**数行**，不是版本戳：戳记「主题 X 版本 V 装过」必须被任何删除能力行的人作废，
  而**套件共享同一个本地 D1、正是故意删这些行的** → 戳记会拒绝修复它唯一存在的理由。
- 计数**镜像清理面**：`clearThemeCapabilities` 从五张表 DELETE + 经注册表 API 清菜单，
  所以「已拥有」要问全这六处；漏一处 = 同一主题上"已装"与"未装"给出两个答案。
- 已知并写在注释里：只声明 `settings[]`/`tables[]` 的主题在计数表里不占行 → 每次启动重跑
  （全是幂等 upsert，可接受），**不是**隐藏行为。

**行为验证（结构断言证不了这条）**

套件本来就给本地留下了**正好是破损状态**：`theme.active='default'` 而
`post_types`/`taxonomies`/`field_defs`/`theme_routes`/`theme_blocks`/`admin_menu_registry`
**全为 0**。于是无需人为制造：重启 dev server 让 isolate 全新启动 → **不发任何激活请求** →
`field_defs` 自己回来（`category` / `tags`，`declared_by_theme='default'`），
`GET theme/fields` 返回 2 项。**这是修复成立与否的唯一判据。**

**本轮学到的一条**

- **"注册"和"安装"是两个动作，而其中一个没有触发者。** 规则 66 解决了分发渠道，
  于是所有人都以为"主题装好了"——因为前台确实渲染了。**能渲染是最强的假绿**：
  它让声明面为空这件事完全不可见，直到有人真的去写一个字段。

**仍未修（与批次 21 相同，本轮实测确认）→ 批次 23 已全部修掉**

- ~~**列表页没有 `reading_time`**~~ **批次 23 已修**：`runThemeQuery` 现在给每行
  `it.reading_time = readingTime(it.html, 220, locale)`。**上面"逐行 `renderBlocks` 会撞
  10ms CPU"的说法是错的**——`attachMeta` 本来就逐行渲染 `html`（列表卡片要用），
  reading_time 只是对**已渲染的 HTML 做一次字符串扫描**，没有第二遍渲染。这条论断
  原样保留在这里，是因为"看起来像成本分析的错误结论"恰恰是它让一个字段缺席了两批。
- ~~**`post_meta` 没有语言维度**~~ **批次 23 已修**：迁移 0019 重建表
  （`PRIMARY KEY(post_id, meta_key, locale)`），读阶梯唯一定义 `platform/post-meta.ts`
  （本语言 → 站点默认 → `''` 遗留行 → 任意），写入带语言，规则 70。

**顺带修正**：§6 的套件表把批次 20 已删除的 `theme-journal` 还列着，且若干套件条数是
批次 19 的数字。**已全部改为本轮实测值**（这条本身也是"文档比代码活得久"的又一次实例）。
另外 `AGENTS.md` 功能开关一节原写"这是本仓库第十三种假绿的形状"——那个形状从未进过
§12 的表，编号对不上；已改为不编号、直接指回那一族的判据。本轮把这次发现记为
**§12 的第 14 条**（与第 12 条同层：观测面——"分发渠道的守卫看不见主题有没有安装"），
`AGENTS.md` 与 `docs/ARCHITECTURE.md` §12 的计数同步为**十五种**。

**新基线**：**24 套件 + `_schema-scope` = 1432 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`_skeleton-inject` **59 场景 / 0 问题**（本轮新增 2 条，各配一个注入场景）；
`_locale-url-inject` 4/4；`_config-parity` 7/7。

**批次 21（中文版 / 切换器 / 中文内容）—— ✅ 已完成**

起点是用户的一句话：**"默认主题要加入中文的版的和切换的地方。和中文的文章和页面"**。
先量后动，量出来的结论是：**前两件已经在产品里了，第三件真的没有。**

| 检查项 | 线上 | 本地（改动前） |
|---|---|---|
| 语言切换器 | **已有** `<nav class="lang-nav">en / zh-CN</nav>` | **不显示** |
| 中文主题文案 | **已生效**（`首页`/`文章`/`专题`/`订阅`） | — |
| `/zh-CN` | 200 | **404** |
| 文章 / 页面 | **0 篇**（"还没有发布任何内容"） | 0 篇（只有测试套件残留） |

语言包逐键比对：`en.json` 56 键 / `zh-CN.json` 56 键，无缺键、无多键，
模板用到的 56 个键**全部命中**（唯一同值项 `footer.robots` = `robots.txt`，属正确）。
**所以"中文的版"和"切换的地方"不缺代码，缺的是数据。**

| 项 | 结论 |
|---|---|
| 切换器为什么不显示 | `siteLocales()` 的 SQL 是 `WHERE sl.site_id=? AND sl.enabled=1`。本地 `site_locales` 里 `zh-CN` 是 `enabled=0` → 平台只拿到 1 项 → **按设计不给 `lang_nav`**（一项不是切换器） |
| 线上为什么有 | 线上两个语言都是 enabled，所以切换器一直是对的 |
| **真正的缺口** | **没有任何内容**。`scripts/seed-demo-content.mjs` 只写 `locale:"en"` |
| **切换器的真缺陷** | 它**只换 locale 段**。列表页对（一个路径多份翻译），**文章页错**——migration 0016 起 slug 按语言，`/en/blog/<zh-slug>` 是 404。`post.alternates` 早就算好了每个语言自己的 URL（hreflang 在用），切换器却没读 |

**改了什么**

1. `langNav()`（`src/platform/frontend.ts`）新增可选参数 `alternates`：有该语言版本就用**它自己的 URL**，
   没有才退回换段。`buildScope` 传入 `post.alternates`，且**必须在 hreflang 那一段把该属性换成
   带 origin 的副本之前**读——注释写在这里，因为顺序错了不会报错，只会把绝对 URL 塞进导航。
2. `scripts/seed-demo-content.mjs` 重写为**双语播种**：5 篇文章 + 关于页，每篇写两次、
   同一个 post id（共享行形态），中英各用自己的 slug，中英各自成篇（不是把英文正文抄一遍——
   抄一遍能过所有结构断言却什么也证明不了）。
3. 规则 25 落地：`locales[]` 声明的每种语言**必须**有 `langs/<code>.json`。
   这条规则**是被一句注释暴露的**——`scripts/make-theme.mjs` 的清单里一直写着
   "The architecture test checks it against `langs/` so 'declared but not shipped' fails loudly"，
   而**那个检查从来没存在过**。`locales[]` 只被校验了 BCP-47 形状，`src/` 里没有任何消费点。
4. 数据侧：本地启用 `zh-CN`（`POST i18n/locales`）、清掉套件残留的测试站点与内容、
   重新激活 `default` 主题（`field_defs` 才会重新登记 `category`/`tags`）。

**本轮学到的两条（都是"看起来对了"的形状）**

- **写在注释里的规则不是规则，而且比没有注释更糟**：注释说"架构测试会检查"，
  读的人就不再检查了。规则 25 就这样缺席了整整一批。
- **`savePost` 会静默丢掉未声明的 meta**（`.catch(()=>{})` + `fieldExists` 判据）。
  本地 `field_defs` 被套件清空后，播种照样 **12 次 200**，而 `post_meta` 一行没写、
  页面分类标签全是"未分类"。**HTTP 200 再一次和"写进去了"无关。**

**仍未修（本轮实测，未动）→ 批次 23 已全部修掉**

- ~~**列表页没有 `reading_time`**~~ **批次 23 已修**（同上一节的勘误：reading_time 是对
  已渲染 HTML 的字符串扫描，不是第二遍 `renderBlocks`，10ms CPU 的顾虑不成立）。
- ~~**`post_meta` 没有语言维度**~~ **批次 23 已修**（迁移 0019 + 规则 70）。

**新基线**：**25 套件 + `_schema-scope`，1427 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`_skeleton-inject` **57 场景 / 0 问题**（本轮新增 2 条，各配一个注入场景）；
`_locale-url-inject` 4/4；`_config-parity` 7/7。

**批次 20（journal 从产品移除 + 测试夹具主题不再被发布）—— ✅ 已完成**

起点是用户的两句话：**"Journal 这个是什么。要删除。另外 fixture 是什么鬼"**。
第一句是产品决定，第二句在查证时翻出一个**真的线上泄漏**。

| 项 | 结论 |
|---|---|
| `Journal` 是什么 | 与 `default`（墨白）并列的**第二套自带主题**（`BUNDLED_THEMES`）。"未使用"= 没有站点选它；"无法卸载"= 文件在 `content/themes/journal/`、随 Worker assets 分发，R2 里没有安装包，端点一律 400（规则 66） |
| 要真的删掉 | 只能**从产品移除**（删目录 + 移出 `BUNDLED_THEMES` + 同步 + 改测试/文档 + 部署），捆绑主题没有"装了但不显示"的状态 |
| `fixture` 是什么 | **测试夹具主题**：套件拿它验证主题系统（声明/模板自洽、菜单注册、表生成）。架构测试的注释写着它 "not shipped as a product theme" |
| ⚠️ **但它确实被发布到了线上（真缺陷）** | 同步脚本把**整个** `content/themes/` 复制进 `public/themes/`，而 `wrangler deploy` 会把 `public/` 原样上传。实测 `https://cfpress.2aass.workers.dev/themes/fixture/theme.json` → **HTTP 200** |

**根因（规则 66b/66e）**：`architecture.test.mjs` 断言的是"**两棵树逐文件、逐字节一致**"。
`content/themes/` 里本来就有**不该发布**的目录（夹具），所以这个不变量是错的——
它把**泄漏钉成了正确**：夹具在 `public/themes/` 里存在得越久，套件越是绿的。
**"两个集合必须相等"这类断言，要先问清"它们凭什么相等"。**

| 修法 | 状态 |
|---|---|
| `content/themes/journal/`（11 文件）+ `public/themes/journal/` 删除；`BUNDLED_THEMES = ["default"]` | ✅ |
| `sync-bundled-themes.mjs`：复制集**从 `BUNDLED_THEMES` 推导**（新增 `readBundledThemeNames()`，解析源文件，与架构测试**共用同一份解析**），不再遍历 `content/themes/`；空名单 / 缺 `theme.json` 一律抛错而不是警告 | ✅ |
| `architecture.test.mjs` 规则 66 节重钉：`public/themes` **恰好等于** `BUNDLED_THEMES` 的文件（逐字节）+ **非捆绑目录绝不进 `public/`** + 同步脚本复制集**读 `BUNDLED_THEMES`** 且**不遍历整目录**（13 → **18 条**断言） | ✅ |
| 注入场景 +2（→**55**）：**夹具泄漏进 `public/themes`**（注入工具新增 `creates` 形态——"断言不存在"的守卫需要一个"不存在"来制造，字符串替换做不到）、**同步退回整目录镜像** | ✅ |
| 套件/注册表同步：删 `theme-journal.test.mjs`；`run-all.mjs`、`package.json`（`test` 链 + `test:journal`）、`scripts/cfpress.sh`、`scripts/cfpress.ps1` 四处表格同步 | ✅ |
| `admin-spa` 的捆绑主题场景改用「捆绑但**不在本站激活**」的 `default`（唯一捆绑主题，所以要让本站激活的是别的主题） | ✅ |
| 文档：`AGENTS.md` 规则 66a/66b/**66e**、`ARCHITECTURE.md` §10 规则 66、本文件 | ✅ |

**顺带修掉一个"验证器本身坏了"**：`_fixture-inject-verify.mjs` 的
`import("./theme-fixture.test.mjs")` 自仓库重组（`a604c63`）起就指向 `tests/tools/`，
而套件在 `tests/suites/` → **每次都 `ERR_MODULE_NOT_FOUND`**，被 `suiteOnce()` 记成
`summary: "<threw>"`，驱动器随即以 "baseline is already red" 退出。
**主题夹具的 10 个反向验证场景因此长期跑不起来**，而它的输出读起来像"树是红的"。
改成 `../suites/` 后：**10 场景 / 0 从未变红 / 0 中止 / 0 注入失败 / 0 还原失败**。

**这一批的三个教训**：

1. **"两个集合相等"的断言，要先问"它们凭什么相等"**。`public/themes` 与
   `content/themes` 相等曾经是**正确的巧合**（那时每个目录都该发布），
   夹具一进来就变成**泄漏的证明**。守卫要断言**规则**（发布集 = `BUNDLED_THEMES`），
   不要断言**当下的巧合**。
2. **豁免必须是排除，不是纳入**。`EXEMPT = new Set(["fixture"])` 写在测试里、
   注释还写着"not shipped"，但**没有任何一处拿它去排除发布**——声明先于运行时，
   只不过这次声明在**测试注释**里。**规则写在注释里 = 规则不存在。**
3. **验证器自己也会坏，而它坏起来像"树坏了"**。一个 `import` 路径写错，
   整套反向验证静默停摆，输出还指向别处。**工具的失败信息必须指向工具自己**
   （`summary: "<threw>"` 现在会被读成 harness 问题，而不是 tree 问题）。

**新基线**：**24 套件 + `_schema-scope`，25 项 / 1425 条 / 0 失败**（套件 1399 + `_schema-scope` 26）；
`tsc --noEmit` src/ 0 错误；`_skeleton-inject` **55 场景 0 问题**；
`_fixture-inject-verify` 10/10 场景有效；`_config-parity` 7/7；`_locale-url-inject` 4/0；
`_launcher-inject` 18 场景（**5 个 PS1 锚点陈旧 SKIP，先于本批存在**）；
`_tenant-query-audit` 3 条无裁决（`src/api.ts:814/820`、`admin-menus.ts:268`，来自 `fa313e7`，先于本批存在）。

**批次 19（主题卸载：两条报错，一个是设计，一个是屏幕在说谎）—— ✅ 已完成**

起点是用户的两条报错：`"journal" ships with the product and cannot be uninstalled` 与
`still active on: acct`，以及"现在的主题也不是他们"。

| 项 | 结论 |
|---|---|
| `journal` 卸不掉 | **设计如此**：`BUNDLED_THEMES = default / journal` 的模板经 Worker assets 分发（规则 66），没有 R2 包可删、下次 deploy 又回来，所以端点一律 400 |
| `still active on: acct` | **守卫是对的**：`settings` 里 `site_id='acct'` 的 `theme.active` 就是那个主题。判据**逐站点**（`theme_installs.active` 是全局标志，不可信） |
| `acct` 是什么 | **测试残留**：套件共享本地 D1，留下 4 个测试站点（`acct`/`adm`/`shop`/`de`）+ 4 个测试主题（`accttheme`/`admtheme`/`shoptheme`/`detheme`），每个都把自己的主题激活在自己站点上 |
| ⚠️ **屏幕在说谎（真缺陷）** | 主题卡对**所有**不在本站激活的主题都写"未使用"，卸载按钮不带站点 → 那句"仍被以下站点激活：X"的**预防性对话框永远不可达** → 点下去必然拿到 409，而屏幕上刚说没人用它 |

**根因（规则 68a）**：`GET extensions/themes` 的按站点占用表 `active_by_site` 在**响应根**上，
而 `themes.js` 读的是 `x.active_by_site`（每个 item 上）——**恒为 `undefined`**。
`undefined` 不报错、不抛异常、不发失败请求，屏幕只是**说错话**。payload 一直带着这个事实。

| 修法 | 状态 |
|---|---|
| `themes.js` 从响应根读 `d.active_by_site`（`others` 现在真的算出 `["acct"]`） | ✅ |
| 端点补 `items[].bundled`（规则 68b），屏幕对捆绑主题改显示"随 CFPress 一起提供，无法卸载"，**不再给一个必然失败的按钮** | ✅ |
| `admin-spa` +5（51→**56**）：用**真 payload 形状**渲染主题屏，断言卡片点名站点 + 按钮带站点 + 本站激活的主题没有卸载按钮 + 捆绑主题没有卸载按钮 | ✅ |
| `admin-contract` +3（51→**54**）：`bundled` 必须与端点的拒绝**逐条一致**（一个事实两个读者，断言它们一致） | ✅ |
| 注入场景 +2（→**53**） | ✅ |
| 真浏览器实测：卡片显示"亦被使用于：acct"；点卸载弹"仍被以下站点激活：acct，请先在那里停用"，**不发任何 DELETE 请求**；`journal` 卡片没有卸载按钮 | ✅ |

**顺带修掉两个"测试改写了运营者设置"的副作用**（都是同一形状：套件把一个人的偏好当成自己的状态）：

- `_i18n-browser.cjs` 为了断言英文，会把界面语言强制成 `en` **并留在那里**。现在开头记住
  `user_preference`，结尾原样放回（`(interface language restored to "zh-CN")`）。
- `i18n.test.mjs` 的幂等清理把非 `en` 的 `ui_lang` 置 `NULL`（为了断言确定性），
  于是跑一次套件，运营者的后台就变回英文。现在**快照 + 原样放回**（与该套件已有的
  `theme_routes`/`admin_menu_registry`/`site_locales`/`locales`/`theme.active` 五样同一纪律）。

**这一批的教训**：

1. **读错层级的字段是"静默错话"**，它和"声明先于运行时"是**镜像**：那边是字段没人读，
   这边是读了不存在的地方。两者都不报错，都只能靠**拿真 payload 渲染**来发现。
2. ⚠️ **守卫必须能看见缺陷**。捆绑标记那条断言第一次钉在 `admin-spa` 上，注入删掉端点字段后
   **没红**——SPA 套件用的是**自造 payload**，看不见端点改动。改端点的缺陷要由真的调端点的
   套件观察。注入工具把它报成 `scenario INVALID`，**这是它在干活**。
3. **一个只有唯一可能结果（被拒）的按钮，是错误制造机**。端点在同一个响应里知道答案，
   就下发它；让屏幕去解释，而不是让运营者去撞。

### 批次 18（界面语言偏好：一个写者、两个读者）—— ✅ 本轮完成

起点是用户的一句报告：**"Your interface language 是 en，但是下拉的还是勾选的 zh"**，
以及"停用 zh-CN 后语言下拉里还是有中文"。两件事、两个答案。

**先回答概念**（三个东西各管一件事，实测数字见下）：

| | 管什么 | 数据源 | 停用 zh-CN 会变吗 |
|---|---|---|---|
| Languages → **Site languages** | 站点**对外服务**哪些语言（L0） | `i18n/locales`（`locales` 表的 enabled 行） | **会**——这是被停用的那个列表 |
| Languages → **Your interface language** | **你**读后台用哪种语言（L2） | `GET i18n/ui-locale` → `resolveUiLocale`（用户偏好 → cookie → 站点默认 → en） | **不会**——它按用户存（`site_users.ui_lang`） |
| 后台顶部**语言下拉** | 同 L2，只是另一个渲染位置 | `currentLocale()`（`i18n.js` 模块状态，由 `GET i18n/messages` 的 `locale` 写入） | **不会**——除非开 `ui_locale_follow_site` |

实测（本地 dev，zh-CN 已从站点停用）：`GET i18n/ui-locale` → `{"locale":"en","user_preference":"en","available":["en","zh-CN"]}`；
`GET i18n/messages` → `locale=en`，`ui_locales=[{en,English},{zh-CN,简体中文}]`。
**"站点不服务中文、界面菜单仍然提供中文"是设计内的解耦**（§2.4）；要让界面菜单跟着站点收窄，
开 `ui_locale_follow_site`（规则 52–55，默认关）。

**然后是缺陷**（用户看到的"两个位置不一致"是真的）：

| 项 | 状态 |
|---|---|
| 根因：Languages 屏的 Save **自己** POST `i18n/ui-locale`，再 `toast()` + `render()`，**一次字典重载都没有** | ✅ 定位 |
| 后果：服务端已存新语言、面板重新读到新语言，而顶部下拉的勾选读的是 `i18n.js` 的**模块状态**——它只在 `loadMessages()` 里被写。于是**两个读者显示两个答案，直到整页刷新** | ✅ 复现 |
| 为什么以前没人发现：两个端点都由同一个 `resolveUiLocale` 解析，**curl 两次都拿到正确答案**；服务端完全一致，分歧**只在浏览器里** | ✅ |
| 修法：`setUiLocale()` 成为**唯一写者**，且**字典重载写在它内部**；Languages 屏改调它（`reloadDictionary:false` 只为省掉一次重复拉取，`loadContext()` 仍必须——菜单标签在服务端翻译） | ✅ |
| 顺带修掉的死代码：`setUiLocale()` 原本 `catch {}` **吞掉** POST 失败，于是两个调用点的错误分支**永不可达**——"保存成功"的提示配着一个没变的语言。现在被拒（400 无语言包）**抛错**，`shell.js` 弹 toast（新键 `core.msg.uiLocaleFailed`，两包同步），Languages 屏弹对话框 | ✅ |
| 守卫：`admin-spa` +7（→51）——**单写者扫描**（只有 `js/i18n.js` 能写这个偏好）+ 写者必须重载字典 + 运行时"保存后顶部勾选跟着走、不需要刷新" + "被拒绝时不改语言"。后两条要 fetch 桩能表达 400，为此给桩加了 `__status` 标记 | ✅ |
| 注入场景 +3（→51）：① 屏幕自己写偏好 ② 写者不再重载字典 ③ 被拒的切换被吞掉 | ✅ |
| 真浏览器验收 `_i18n-browser.cjs` **§8**（+8 条）：面板与顶部勾选在改动前一致 → 点 Save → **不刷新**断言勾选跟到 zh-CN + 侧栏真的变中文 + POST 是 200 → 切回 en | ✅ |

**这一批的教训**：

1. **"同一个事实有两个前端读者"是缺陷的温床，而它躲得过服务端的一切检查。** 服务端只有
   一个答案，两个读者各自缓存、各自刷新，差异**只存在于渲染出来的界面里**。所以规则 67
   把"唯一写者 + 写者自己刷新"写成硬规则：**读者可以各自缓存，写者只能有一个。**
2. ⚠️ **反向验证注入的必须是历史真实形状，不是"看起来差不多"的形状。** §8 的第一次反向验证
   **通过了**——因为我注入的是「自己 POST + `afterLanguageChange()`」，而
   `afterLanguageChange()` 默认就会重载字典。真实的旧代码是「自己 POST + `toast()` + `render()`」，
   一行重载都没有。换成真实形状后立刻红：`tick="en"` 而面板是 `zh-CN`——**与用户报告逐字一致**。
   **注入前先 `git diff` 看一眼自己删掉的是什么。**
3. **吞掉的错误 = 永不可达的错误分支。** `catch {}` 让两个调用点里的 `alertDialog`/`toast`
   变成装饰，而"保存成功"的提示会盖在没变的语言上。凡是"调用方写了错误处理"的地方，
   都要问一句：**被调用方真的会抛吗？**

### 批次 16 Track B1（块 attrs 契约）—— ✅ 本轮完成

**起点是一个用户看得见、而所有守卫都看不见的缺陷**：编辑器给**所有**块写 `attrs.text`，
渲染器按类型读**不同**的属性——`core/image`→`url`+`alt`、`gallery`→`items`、
`html`→`html`、`group`/`columns`→嵌套 `content`、`button`→`url`+`text`。
于是 **12 种块里有 6 种从后台插入后前台渲染为空**：**HTTP 200、零异常、零 5xx**。
这是「声明先于运行时」缺陷族的**第八例**，且是**没有任何守卫**的一例——
清单校验器查声明，架构测试查结构，`admin-spa.test.mjs` 从不打开编辑器屏幕。

| 项 | 状态 |
|---|---|
| `src/rendering/blocks.ts`：`CORE_BLOCKS` 升级为**契约**（每块声明 `attrs[{key,type,labelKey,fallback,required?}]`、`children?`、`media-list` 的 `itemKeys`）+ `BLOCK_ATTR_TYPES` 闭集合 + `blockSpec`/`blockAttrKeys` | ✅ |
| `GET /api/v1/blocks` 下发属性清单（标签按 UI 语言翻译，`itemKeys` 从契约转发） | ✅ |
| **新** `public/admin/js/block-fields.js`（叶子模块）：属性类型 → 控件的**唯一**映射（`RENDERED_ATTR_TYPES` + `renderBlockAttr(s)`）+ **块树的寻址与变更纯函数**（`locateBlock`/`insertBlock`/`setAttrAt`/`setItemAt`/`moveBlockAt`/…） | ✅ |
| `screens/editor.js`：逐属性出控件、写入**声明过的键**（不再恒写 `text`）；`group`/`columns` 渲染嵌套容器与内层面板；块标题用服务端翻译后的 label | ✅ |
| 新套件 `tests/suites/editor-blocks.test.mjs`（**40 条**）：契约 → 控件 → 写入的键 → **真实渲染器 markup** 的**往返**断言 + 嵌套寻址 + **§8 刻意的反向对照** | ✅ |
| 架构守卫（`architecture.test.mjs`，+9 条，规则 61）：**解析** `renderBlocks` 每个 case 体的 `a.<key>` 读取集合并与声明比对 / 每个声明块都有 case / `RENDERED_ATTR_TYPES` == `BLOCK_ATTR_TYPES` 且每种类型都有分支 / 每个 `media-list` 都声明 `itemKeys` | ✅ |
| `_skeleton-inject.mjs` 新增 **5 个场景**（渲染器读未声明的属性 / 契约改名 / 控件丢分支 / 导出清单漂移 / 丢 `itemKeys`）→ **28 场景 0 问题** | ✅ |
| `admin-contract.test.mjs` +7 条：调色板下发 `attrs`（类型/必填/翻译标签/`itemKeys`/容器标记） | ✅ |
| 规则 61 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**本轮抓到的两类东西**（都值得单独记）：

1. **元守卫的盲区：`check(name, condition, detail)` 的 condition 传字面量恒为真。**
   我在新守卫里写成 `check(name, JSON.stringify(a), JSON.stringify(b))`——把期望值与实际值
   当成了条件与详情。**架构套件全绿**，是 `_skeleton-inject` 的"导出清单漂移"场景报
   `did NOT go red` 才发现的。修法两层：修正那一条，并把元守卫从"禁集合当条件"
   扩到"**禁字面量当条件**"（字符串/模板/数组/对象/`true`）。
   ⚠️ 元守卫只扫 `architecture.test.mjs` 自己，**其它套件里同样的拼法只能靠注入工具抓**。
2. **"声明了但没人读"的反向：契约自己漏了一半。** `media-list` 的条目键原本由 `api.ts`
   在出口处附加，契约本身不描述条目形状——于是**只用契约**（不经过 API）渲染控件时，
   画廊字段渲染成一个**没有任何输入框**的空字段。修法是把 `itemKeys` 声明在属性上（61c）。
   **判据**：一个控件如果需要调用方告诉它"你由什么组成"，那部分组成就还没被声明。

**新基线**：**24 套件 + `_schema-scope`，25 项 / 1296 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 28/28 场景有效；`_tenant-query-audit` 每条命中都有裁决
（`api.ts` 的 `theme_installs` 一条随行号移到 `:1610`）。

### 批次 16 Track A3（统一媒体控件）—— ✅ 本轮完成

**起点是"多媒体管理和上传要全平台统一的控件"这条诉求。** 勘察发现需要它的地方有**三处**，
而其中**两处根本没有实现**：

| 消费点 | 之前 |
|---|---|
| 块的 `media` / `media-list` 属性 | 一个 URL 文本框（Track B1 之前连渲染都不对） |
| 内容自定义字段的 `media` / `media-multiple` | **`ALLOWED_FIELD_TYPES` 里一直有这两种，编辑器却没有分支** → 静默掉进默认文本框 |
| 主题/插件设置的 `media` / `media-multiple` | 一个 placeholder 写着 "URL in the media library" 的裸文本框 |

| 项 | 状态 |
|---|---|
| **新** `public/admin/js/media-picker.js`：`mediaUrl()`（唯一构造 `/media/<key>`）/ `mediaItem()`+`mediaItemsFromPayload()`（归一化）/ `mediaFieldHtml()`（**唯一的控件标记**）/ `pickerTileHtml`/`pickerGridHtml`（可测的网格）/ `openMediaPicker()`（搜索 + 网格 + **上传** + 单选/多选 + 取消） | ✅ |
| 控件职责收窄成"**把 URL 写进发起请求的 input 并派发 `input`/`change`**"——三个消费点因此**零新接线**（块属性有监听、设置表单 change 即存、自定义字段保存时读 `[data-meta]`）；交互由 `media-picker.js` **自己**注册一个 document 级委托，屏幕只要 import 就可用 | ✅ |
| `block-fields.js` 的 `media` 分支改用 `mediaFieldHtml`；`media-list` 每行走同一个控件 + 一个"从媒体库多选追加"按钮（`appendMediaAt` 按属性**声明的 `itemKeys`** 落值） | ✅ |
| `screens/editor.js` 自定义字段新增 `media` / `media-multiple` 分支（**补上从未存在的控件**） | ✅ |
| `screens/theme-menu.js` 的 media 分支改用同一控件（保留 `case` 标签，设置表单的类型守卫仍绿） | ✅ |
| `screens/media.js` 的三处手拼 `/media/` URL 收敛到 `mediaUrl()` | ✅ |
| 新套件 `tests/suites/media-picker.test.mjs`（**31 条**）：URL 形状（**编码后能被读取路径解回同一个 key**）/ 归一化（行与已存值两种输入）/ 坏 payload 不炸对话框 / 控件两种形态与转义 / **"选择器给的 URL，真实渲染器画得出来"** 的闭环（图片与画廊）/ 三个消费点都走共享控件 | ✅ |
| 架构守卫（+5 条，规则 62）：`data-media-field` / `data-media-pick` / `/media/${encodeURIComponent` **各只出现在 `media-picker.js`**（都配非空断言） | ✅ |
| `_skeleton-inject.mjs` +3 场景（屏幕自造控件 / 屏幕手拼 URL / URL 不再编码 key）→ **31 场景 0 问题** | ✅ |
| **真浏览器验收 `tests/tools/_media-picker-browser.cjs`（25 条，连跑两次全绿、自清理）**：真 Chromium 里登录 → 编辑器加图片块 → 打开对话框 → **在对话框里上传** → 选中 → URL 落进字段 → **保存后确认它写在 `url` 而不是 `text`** → 会话内可取到对象、匿名被拒 → 取消路径 | ✅ |
| 规则 62 写进 `AGENTS.md` + `ARCHITECTURE.md` §10；`core-pack.ts` 新增 8 个 `core.media.*`（en+zh 同步） | ✅ |

**浏览器验收当场抓到的一个真 UX 缺陷**：选完文件后**没有预览**。
块编辑器为了不丢焦点刻意不在每次输入时重渲染，而预览原本只在渲染时画一次——
于是"刚选好的图看起来没被采纳"。修法：控件里留一个 `[data-media-preview]` 槽，
选择器写值后就地刷新它（`mediaPreviewHtml`）。**这类缺陷只有真浏览器点一遍才会现形**，
Node 侧断言"标记里含有 `<img>`"永远是对的——因为它检查的是模板，不是交互。

**本轮最重要的一条**：**`check()` 现在要求条件是真正的布尔值**。
这个文件在**两个批次里累计三次**写出恒真断言——集合当条件、`JSON.stringify(...)` 当条件、
以及**数组当条件而把期望值放进了 detail**（正是本轮那次：`check("…", controlOwners, ["…/media-picker.js"])`）。
两次都是 `_skeleton-inject` 报 `did NOT go red` 才发现的，架构套件当时**全绿**。
词法模式只能禁"想到的拼法"，所以修法落在 `check()` 本身：**不是布尔就抛 `TypeError`**，
把这一整类变成一声巨响。词法守卫保留，作为更早、更友好的一层网。

**新基线**：**25 套件 + `_schema-scope`，26 项 / 1335 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 31/31 场景有效。

### 批次 16 Track B3（编辑器界面翻译）—— ✅ 本轮完成

**起点是"多语言用户体验就差的很"最直白的那一层**：编辑器（`screens/editor.js`）是最后一个
**完全没有词典**的大屏——把界面语言切成简体中文，从页头到保存按钮到对话框，**每一个字都还是英文**。

| 项 | 状态 |
|---|---|
| `core-pack.ts` 新增 **~90 个键 ×2 语言**（`core.editor.*` / `core.status.*` / `core.content.*` 补充），**两个语言包同步扩** | ✅ |
| **SPA 的 `t()` 支持 `{name}` 插值**（与服务端 `interpolate()` 同一套语法）——"Last saved content for {site}" 这类句子因此是**一条词条**，而不是在调用点拼字符串（拼出来的语序不可翻译） | ✅ |
| `screens/editor.js` **全量接 `t()`**：页头/面包屑、语言版本条、自定义字段、Locale/Status/Publish at、块工具提示、空态、修订历史、**四个对话框**、toast、自动保存状态 | ✅ |
| `screens/content-list.js` 一并翻译（编辑器是从它进去的；只翻一半会更割裂） | ✅ |
| **`ui.js` 的共享字符串**：`statusBadge` / `emptyRow` 默认文案 / 三个对话框的 `confirmLabel` / Cancel 按钮——**一处改，十个屏幕受益** | ✅ |
| `state.js` 的 `postTypeInfo` 翻译内建的 Post/Page 标签（主题声明的 CPT 标签是主题作者的话，不翻译） | ✅ |
| 架构守卫（+6 条，规则 63）：SPA 的每个 `t("…")` 字面量键都在**每个**语言包里 / 两个语言包键集相同 / `core.editor.*` 每个键都有调用点 / 三条非空断言 | ✅ |
| `_skeleton-inject.mjs` +3 场景（键名写错 / 只加到一个语言包 / 编辑器键失去调用点）→ **34 场景 0 问题** | ✅ |
| **真浏览器验收**：`_i18n-browser.cjs` §7（切 zh-CN 打开编辑器：标签是中文、**无英文残留**、**option 值仍是标识符**、切回英文恢复）→ **29 条全绿** | ✅ |
| 规则 63 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**本轮抓到的四件事**：

1. **`<option>` 不写显式 `value` 时，浏览器拿文本当值** —— 编辑器原本的状态下拉就是这样。
   把标签翻译成中文会**把 `草稿` 写进 `posts.status`**：一个翻译动作变成一次数据损坏。
   修法是显式 `value="${s}"`，并在真浏览器里断言"值仍是标识符、标签已是中文"。
   **这是"翻译"这类改动特有的危险面：它同时碰显示与数据。**
2. **`core.nav.features` 被侧栏引用了 11 个批次，却从未声明** —— Features 菜单项在每种语言下
   都回退成英文。新守卫第一次运行就抓到了。
3. **`_admin-menus-browser.cjs` 一直是坏的**（与 B3 无关）：它的夹具主题声明了散文字段
   `name` 却没写 `translatable`，规则 41 落地后上传被校验器拒绝，于是**第 5 节之后全线失败**，
   而症状看起来像"生成式表格屏幕坏了"。修好夹具后 31 条全绿。
   **一条跑不起来的验收脚本，比没有验收脚本更误导。**
4. **`_i18n-browser.cjs` 的 `browser.close()` 原本卡在第 5、6 节之间** —— 任何新加在其后的章节
   都会对着已关闭的浏览器跑，报错却指向新章节里的辅助函数。已挪到脚本末尾。

**新基线**：**25 套件 + `_schema-scope`，26 项 / 1341 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 34/34 场景有效；
三个浏览器验收脚本全绿（i18n 29 / 菜单 31 / 媒体控件 25）。

### 批次 16 Track B4（多语言编辑体验）第 1 部分 —— ✅ 本轮完成

**起点**：方案文档里 B4 列了三条，其中两条是**静默缺陷**，一条是**语义陷阱**。
本轮把三条都修了，并补上了让它们**不需要浏览器就能验证**的覆盖。

| 项 | 状态 |
|---|---|
| **自动保存定时器泄漏**：原来只在 `Back` 与保存成功两条路径里 `clearInterval`，**从侧栏离开编辑器**（走 `shell.go()`）会把定时器留在后台，每 10 秒照旧 POST 一次自动保存——用户在看别的屏幕。零失败、写入不可见 | ✅ |
| **`publish_at` 被丢掉**：`editContent` 不读 `publish_at`，`#publishAt` 恒渲染为空 → "打开一篇已排期的文章再保存" = **静默取消排期**。改用 `table-form.js` 的 `toLocalInput`/`fromLocalInput`（一处定义） | ✅ |
| **`#locale` 身份陷阱**：已存在条目的语言是**事实**，不是可编辑字段——改它等于要求 API 把这一行搬去另一种语言。现在已存在条目渲染为 `disabled`，提示指向语言版本条；**新建**条目仍可自由选语言（那是真选择） | ✅ |
| `stopAutosave()` 成为**唯一定义**（`state.js`），`go()` / `switchSite()` 都调用；编辑器不再自己 `clearInterval` | ✅ |
| 保存/自动保存改从 `state.editing.locale` 读语言（不从 DOM 读身份）；`<select>` 走 `change` 委托回写 | ✅ |
| **`admin-spa.test.mjs` 首次渲染编辑器屏幕**（19 → **29 条**）：新增"新条目 / 已存在条目"两节，逐条断言**排期往返**、**`#locale` 不可编辑**、**编辑会起定时器而导航会停它**。编辑器此前**不被任何套件渲染**（它不在 `SCREENS` 里，是内容列表委托过去的）——三条缺陷正是因此才活了这么久 | ✅ |
| 架构守卫 +3（规则 64）：只有 `state.js` 清定时器 / 它确实导出了 `stopAutosave` / 导航确实调了它 | ✅ |
| `_skeleton-inject.mjs` +1 场景（屏幕重新手写 `clearInterval`）→ **35 场景 0 问题** | ✅ |
| 规则 64 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**一个当场发生的自我验证**：写规则 64 的第一条守卫时，我又把**数组**当成了 `check()` 的条件
（就是这个文件里已经犯过三次的那个错），而上一轮刚加的**布尔类型守卫直接抛了 `TypeError`**——
错误当场暴露，而不是留成一条恒真的绿。守卫抓到了写守卫的人。

**本轮踩到的测试时序陷阱**：`newContent` / `editContent` 调用 `render()` 时**没有 await**
（它们由点击处理器调用，那里没人在等），所以测试读 DOM 必须让渲染链结算一次，
否则读到的是**空容器**——而症状看起来像"这个控件不存在"。已在测试里加 `settle()` 并注明原因。

**新基线**：**25 套件 + `_schema-scope`，26 项 / 1354 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 35/35 场景有效。

**B4 剩余**：多语言编辑体验里"自定义字段跨语言共享"的**标注**（需要 B5 的 `post_meta.locale` 列
先落地，否则标了也不准）。

### 批次 16 Track A4（媒体屏升级）—— ✅ 本轮完成

**起点**：媒体屏是一张表格，而且**只显示第一页**——列表接口的 `page` / `limit` / `q` / `type`
一直都在，屏幕一个都没用，于是 60 个文件看起来就是 50 个。

| 项 | 状态 |
|---|---|
| 表格 → **瓦片网格**（缩略图 + 文件名 + 大小 + MIME）。表格行能显示文件名和字节数，**显示不出那张图**，而"哪一张才对"是这个屏唯一要回答的问题 | ✅ |
| **搜索**（服务端 `q`，250ms 防抖）+ **类型筛选**（`image/` / `application/`，服务端 MIME 前缀匹配）；两者都重置到第 1 页 | ✅ |
| **分页**：`Load more` 累加（不是翻页），页脚显示"已显示 N / 共 M"。分页算术只有一处（`mediaPageInfo`） | ✅ |
| **拖拽上传**（整个面板是投放区，拖拽时高亮）+ 多选上传；逐个文件一个请求，**部分失败保留成功的那些**并报出失败项 | ✅ |
| **alt 文字就地编辑**（`change` 时 PATCH，不是每次按键）——它是屏幕阅读器念的内容，也是选择器给的默认值，为一个词开对话框就是 alt 永远空着的原因 | ✅ |
| **删除**（确认对话框；先删对象再删行由服务端保证） | ✅ |
| 复用 `mediaUrl()` / `mediaItem()`：媒体屏与选择器必须看到**同一批对象、同一个 URL 构造**（规则 62） | ✅ |
| **整个媒体屏接入词典**（20 个 `core.media.*` 键 ×2 语言）——顺手把"未翻译屏幕"的名单缩短一格 | ✅ |
| `admin-spa.test.mjs` +15 条（29 → **44**）：查询串形状与编码、分页算术（含空 payload 不产出 `NaN`）、瓦片标记走共享 URL 构造、垃圾行不产出瓦片、空库空态、页脚计数、屏幕工具栏/投放区/上传控件 | ✅ |
| `_media-picker-browser.cjs` +9 条（25 → **34**，连跑两次绿）：媒体屏工具栏、两次上传成瓦片、缩略图走共享 URL、搜索收窄、**alt 就地编辑真的落库**、删除真的移除、自清理 | ✅ |
| `admin.css` 新增 `.media-grid` / `.media-tile` / `.media-drop` 等，全部用既有 oklch 令牌（跟随明暗主题） | ✅ |
| 规则 65 写进 `AGENTS.md` + `ARCHITECTURE.md` §10 | ✅ |

**浏览器验收当场抓到三个真缺陷**（全部与 A4 无关，是被它顺手照出来的）：

1. **`scoped("media&page=1")` —— 把查询串当路径**：产出 `media&page=1?site=default`，**不匹配任何路由**。
   媒体屏因此直接显示错误面板；**媒体选择器的搜索**同样 404，但那个 404 被吞成空列表，
   于是搜索框看起来像"没有结果"。两个调用点都犯过。修在 `scoped()` 本身：**直接抛错**。
2. **`theme_table_defs.i18n_table` 可以比它的表活得久** → 首次写入报
   `no such table: theme_menusbrowser_menuitem_i18n`。成因链：这个字段的粘性**是有意的**
   （禁用语言要隐藏翻译，不是重新播种），而测试夹具会 drop 生成的表却留下注册行。
   修法：**同步要修复它自己写下的映射**——回读 `i18n_table`，非空就 `CREATE TABLE IF NOT EXISTS`。
   `_schema-scope.mjs` +5 条把这条不变量钉住（+ 模拟"侧表消失后重新同步"）。
   ⚠️ 这条**只有**把夹具的 `translatable` 补对之后才会暴露——之前上传被校验器拒绝，
   整段代码从来没被执行到。
3. **我自己写的一条竞态断言**：对话框的列表是异步加载的，我在 `.overlay` 出现后立刻读网格内容。
   已改成等加载落地再断言。

**新基线**：**25 套件 + `_schema-scope`，26 项 / 1374 条 / 0 失败**；`tsc --noEmit` src/ 0 错误；
`npm run gate` 四项全绿；`_skeleton-inject` 35/35 场景有效；
**三个浏览器验收全绿**（多语言 29 / 菜单 31 / 媒体 34×2）。

`265d03c`：**目录分层 + 架构红线机器强制 + 运行时清单校验**（37 文件、+2827/−122）。

`d6e2239`：把 `public/admin/admin.js` 从 1514 行单文件拆成入口 + 4 个基础模块 +
18 个屏幕模块，新增 `tests/suites/admin-spa.test.mjs`。纯前端重构，`src/` 一行未动。

`48edc41`：**批次 2 —— 多语言四层（L0/L1/L2/L3）全部落地**，并把原属批次 3 的
「主题自有表」部分（DDL 生成 + 注册表 + facade + 沙箱端点）一起做了。
顺带修掉三个只在真实交互下才暴露的缺陷（见 §5 批次 2 与 §8 坑位 11–13）。

`fb2b012`（+`33f6369`，批次 4）：**脚手架三件套 + `contract/` 拆分 + 路由消费契约 +
eshop 范例主题 + 三份开发文档**。生成器全部可被 import（本机沙箱无法 spawn 子进程），
`tests/suites/scaffold.test.mjs` 68 条用真实校验器与真实模板引擎跑生成物。发现并修掉
"声明先于运行时"缺陷族的两例（`routes[].resolve.table`、`routes[].template`）。

本轮：**批次 5 —— 后台界面语言 + 账户自助 + 菜单配置**。后台 SPA 全面接入 L2 四层
字典（en/zh-CN 核心包约 90 key ×2），语言切换器持久化到 `site_users.ui_lang`；
扩展菜单支持 `label_key`（**服务端**翻译，前缀校验拒绝越界 key）；用户可自助改密/改名
（当前密码闸门下沉 `platform/auth.ts`，稳定错误码）；左侧菜单可按用户隐藏/恢复
（`site_users.menu_prefs`，纯 UI 层）。迁移 `0013`。真浏览器验收 38 条全绿
（`.wrangler/eshop-verify.cjs` v5）。

同轮收尾了批次 4 的遗留验证：**主页接管**（`routes[]` 声明 `path: "/"` 时前台首页交给
主题渲染，`src/index.ts` 的 home 闭包改为主题路由循环之后的 fallback），
`themes/eshop/theme.json` 首位路由即商品档案页；`tests/theme-eshop.test.mjs` 45 条、
`tests/_eshop-inject.mjs` 加 home-route 场景。

## 3. 源码布局（分层已落地，旧路径 `src/core/*` 已不存在）

```
src/
├── index.ts                  前端路由：站点解析 → 语言解析 → SEO → 主题路由 → CPT → 页面 → 404
├── api.ts                    管理 API（全部按站点；manifest 校验在安装路径上；`admin-menus` 端点）
├── shared/                   叶子层：types crypto repo cache scheduler（不 import 任何业务层）
├── platform/                 auth permissions sites frontend seo revisions
│   ├── admin-menus.ts        ★ 后台菜单注册表：主题/插件/核心共用的唯一读写入口
│   └── i18n/                 多语言四层
│       ├── core-pack.ts      内置核心语言包（TS 常量，不依赖 R2）
│       ├── translate.ts      interpolate / createTranslator / mergePacks
│       ├── resolve.ts        路径 → ?lang= → cookie → 站点默认
│       ├── locale-registry.ts L0 站点语言开关 + 增删改
│       ├── packs.ts          L2 分层装配 + setPackProviders 注入槽
│       └── index.ts          barrel
├── rendering/                template-engine template-resolver blocks（纯渲染）
└── extensions/
    ├── contract/             ★ 主题/插件共享的词汇与接口
    │   ├── hooks.ts            HostHooks + NULL_HOOKS + DECLARABLE_HOOKS + 注入槽
    │   ├── manifest.ts         词汇表：保留列 / 字段类型 / 后台屏幕 / 各种正则
    │   ├── capabilities.ts     CAPABILITIES 白名单
    │   └── validation.ts       validateManifest —— 安装边界校验，失败必须抛错
    ├── security.ts           只剩 safeZipPath / sha256
    ├── theme/                runtime-declarative runtime-worker capabilities templates
    │                         tables（DDL 生成 + theme_table_defs）table-facade packs
    └── plugin/               runtime packs menus

scripts/                      脚手架（生成器可被 import —— 本机沙箱无法 spawn）
├── _scaffold.mjs             parseArgs / writeTree / CliError / isMain
├── make-theme.mjs            themeFiles() + main(argv, io)
├── make-plugin.mjs           pluginFiles() + main(argv, io)
└── make-table.mjs            tableDeclarations() + main(argv, io)
```

**四条红线（`tests/suites/architecture.test.mjs` 机器强制，13 组检查）：**
1. `shared/` 不 import 任何业务层
2. `platform/` 不 import `extensions/`
3. `rendering/` 不 import `extensions/`
4. `extensions/theme/` 与 `extensions/plugin/` **互不 import**（主题调插件走 `contract/hooks.ts` 依赖倒置，`index.ts` boot 时 `setHostHooks(...)` 注入）

**同一个依赖倒置模式已经用了三处**：`platform/i18n/packs.ts` 的
`setPackProviders({theme, plugin})`、`contract/hooks.ts` 的 `setHostHooks(...)`、
以及 `platform/admin-menus.ts`（两种扩展都要写菜单，而它们互不 import ——
放在 `platform/` 是唯一不需要越界 import 的位置）。所以 `platform/` 不需要认识
`extensions/`，规则 2 依然成立——**主题/插件的语言包与菜单都由扩展层实现，平台只认接口**。

**数据红线：** `siteId` 必须贯穿所有数据访问函数，**默认值零容忍**
（字符串形式 `siteId = "default"` 和常量形式 `siteId = DEFAULT_SITE_ID` 都算违规，架构测试会 FAIL）。

## 4. 六个已确认的架构决策（§9，全部选项 A，不要再当"待确认"）

1. **slug 跨语言唯一** —— 唯一索引 `UNIQUE(site_id, type, slug)`，不含 locale
2. **主题自有表只支持基础类型** —— `text/longtext/number/boolean/date/datetime`
3. **插件也可声明自有表** —— 与主题同机制，表名 `plugin_{slug}_{table}`
   ⚠️ **决策不变，但落地在批次 4**：`theme_table_defs` 只有 `theme_name` 一列，
   支持插件必须**重建该表**（SQLite 不能 `ALTER` 主键/UNIQUE）。在那之前，
   插件声明 `tables[]` 会被**校验器明确拒绝**（不是静默忽略）。
4. **删 `theme_admin_menus`** —— 合并为统一 `admin_menu_registry`（迁移时 drop 旧表）✅ **批次 3 已完成**
5. **目录重整先做** —— ✅ 已完成
6. **界面语言本期做** —— 后台 UI 语言与内容语言独立

## 5. 进度总览（路线图见 `docs/ARCHITECTURE.md` §8）

### 批次 11–15（2026-10-08/09，全部完成——叙述见 §2 提交脉络）

| 批次 | 内容 | 基线 |
|---|---|---|
| 11 | 平台功能开关（`shared/features.ts` + Features 屏 + 规则 52–55） | `0aa6ed6` |
| 12 | savePost/deletePost/dashboard 写入路径修复 + PBKDF2 适配免费计划 CPU + handleApi try/catch + journal 主题 | `9e9dde5`/`f312143` |
| 13 | mobai 主题 + RSS `/feed.xml` + `cover` 派生 + `theme.strings` + 删除 ByteString 缺陷头 | `0f2bd7f` |
| 14 | slug 按语言（迁移 0016）+ hreflang + 按语言 feed + 切换器 + **规则 56–59 + `npm run gate`** | `7581387` |
| 15 | 数据驱动后台：块面板 / Dashboard 卡片（插件可注入）/ 声明式设置类型感知表单（迁移 0017） | `176331b` |

### 批次 1（架构防错）—— ✅ 全部完成

| 项 | 状态 |
|---|---|
| `src/` 目录分层重整（19 个平铺文件归位） | ✅ |
| 架构测试 11 组检查 + 8 项反向验证（注入违规必须 FAIL） | ✅（批次 3 后为 13 组） |
| `siteId`/`locale` 默认值清零（26 字符串 + 6 常量形式） | ✅ |
| 运行时 `validateManifest`（安装返回 400，不再只是测试端强制） | ✅ |
| 新套件 `manifest-validation`（33 条断言，逐条注入缺陷→断言拒绝） | ✅（批次 3 后为 54 条） |
| 依赖倒置 `theme↔plugin`（`contract/hooks.ts`） | ✅ |
| 多站点 SEO bug 修复（sitemap/robots 曾对所有域名返回默认站内容） | ✅ |
| 修复两个**从未生效**的守卫（默认值正则漏常量形式；跨层检查文本匹配落空） | ✅ |
| **后台 JS 拆分**（`admin.js` 1514 行 → 入口 + 22 个新模块） | ✅ 上一轮完成（见 §7） |

### 批次 2（多语言四层 L0/L1/L2/L3）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 迁移 `0011_i18n.sql`（`locales` 扩列 / `site_locales` / `posts.lang_group` / `site_users.ui_lang` / `i18n_overrides` / `theme_table_defs`） | ✅ |
| `src/platform/i18n/` 六个模块（内置核心包 + 翻译 + 语言解析 + L0 注册表 + L2 分层 + barrel） | ✅ |
| 界面语言注入（`setPackProviders`，与 `setHostHooks` 同一模式） | ✅ |
| 内容翻译组 CRUD（`i18n/translations`）+ 后台语言版本条 | ✅ |
| 后台「Languages」屏（L0 站点语言 + L2 界面语言 + 四层关系说明） | ✅ |
| 主题自有表 DDL 生成 + `theme_table_defs` 注册表 + facade + 沙箱 `table/*` 端点 | ✅ **原属批次 3，提前做了** |
| 清单内联语言包校验（插件没有 `langs/` 目录可读，只能内联声明） | ✅ 规划外新增 |
| 新套件 `tests/suites/i18n.test.mjs`（62 条）+ `tests/tools/_i18n-browser.cjs`（22 条，真实 Chromium） | ✅ |
| 修掉三个只在真实交互下暴露的缺陷（见 §8 坑位 11–13） | ✅ |

**验收要点全部有测试对着**：只启用一种语言时主题自有表**不建** `_i18n` 表；
启用第二种后出现；`price` 跨语言同值、`name` 跨语言不同值；
后台界面语言与内容语言独立可设；显式 `/en/x` 找不到返回 404 不回退。

### 批次 3（统一后台菜单 + 生成式屏幕）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 迁移 `0012_admin_menu_registry.sql`（建新表 + 搬旧数据 + `DROP theme_admin_menus`） | ✅ |
| `src/platform/admin-menus.ts`（注册/清理/查询 + `menuRowId` 防碰撞 + 分组 + 能力过滤） | ✅ |
| `src/extensions/theme/capabilities.ts` 改走注册表（`registerOwnerMenus` / `clearOwnerMenus`） | ✅ |
| `src/extensions/plugin/menus.ts`（插件菜单，`ALL_SITES='*'` 写一次） | ✅ |
| `src/api.ts` `GET /api/v1/admin-menus` 端点 + 停用插件时清它的菜单 | ✅ |
| `table-list` / `table-edit` 两个屏幕（列表列 + 表单控件全由 `fields[]` 生成） | ✅ |
| `public/admin/js/table-form.js`（字段类型 → 控件的唯一映射 + `date`/`datetime` 往返） | ✅ |
| `theme-menu.js` 改为统一分发器（`content-list` / `table-*` / `theme-settings` / `plugin-settings`） | ✅ |
| 插件清单支持 `adminMenus`（`seo` 插件新增 SEO Settings 菜单） | ✅ |
| 清单校验抽出共享 `validateAdminMenus`；插件 `tables[]` **明确拒绝** | ✅ |
| 新套件 `tests/suites/admin-menus.test.mjs`（43 条）+ 架构测试新增 3 项检查（共 13） | ✅ |
| 真实浏览器验收 `tests/tools/_admin-menus-browser.cjs`（31 条，连跑两次全绿） | ✅ |
| 修掉"新增/列表同名"缺陷（真实浏览器才暴露，见 §8 坑位 17） | ✅ |

**五条验收标准全部有测试对着**：① 生成式列表/表单，主题零后台代码；
② SEO 插件注册菜单并打开自己的设置页；③ 停用插件**只**消失它自己的菜单；
④ 切走主题保表丢菜单、切回恢复；⑤ 插件菜单在**全新站点**上无需额外步骤即可见。

**反向验证（本轮 6 项，全部注入后确认变红再撤回）**：`clearOwnerMenus` 忽略
`owner_name` → FAIL×3；插件菜单改成按站点 → FAIL×2；关掉 `table-list` 的 args 校验 →
FAIL×4；关掉插件校验分支 → FAIL×3；已发布主题用未知 screen → FAIL；
`src/` 引用已退役表 → FAIL。

### 批次 4（脚手架 + 文档）—— 已完成（插件自有表除外）

| 项 | 状态 |
|---|---|
| `extensions/contract/` 拆出 `manifest.ts`/`validation.ts`/`capabilities.ts` | ✅ |
| `scripts/make-theme.mjs` / `make-plugin.mjs` / `make-table.mjs` | ✅ |
| `tests/suites/scaffold.test.mjs`（68 条，真实校验器 + 真实模板引擎） | ✅ 已进 `npm test` |
| 修复「声明被校验但运行时没人读」第三、四例（`resolve.table` / `routes[].template`） | ✅ |
| `docs/guides/I18N.md` / `THEME-DEV.md` / `PLUGIN-DEV.md` | ✅（对着源码核对过，详见 ARCHITECTURE §4.4） |
| `themes/eshop/` 示例主题 + `tests/theme-eshop.test.mjs`（41 条） | ✅ 已进 `npm test`，七个注入场景逐条反向验证（`tests/_eshop-inject.mjs`） |
| **插件自有表** `plugin_{plugin}_{table}` | ⬜ 已登记：需**重建 `theme_table_defs`**（SQLite 不能 `ALTER` 主键/UNIQUE，而它现在只有 `theme_name` 一列） |

**本轮新增的两条引擎级守卫（都反向验证过）**：

1. **子模板未闭合 `{{@section}}` 直接抛错**。引擎原先靠「向后扫描有没有 `{{/section}}`」
   猜一个 `{{@section}}` 是定义还是插槽；猜错时子模板的 section 被当成插槽，
   布局渲染空 `<main>`——**HTTP 200、无异常**。现在用**文件事实**（`@extends` 了就是子模板，
   子模板永不提供插槽）把它变成结构性错误。
   ⚠️ 这个缺陷**真实存在于生成的骨架里**（四个子模板全漏了 `{{/section}}`），
   是 `tests/suites/scaffold.test.mjs` 渲染时才发现的。
2. **`@extends` 链的 section 合并顺序**。原写法「保留第一次写入，只特判 `i === 0`」在
   **三层**继承时让**最不派生**的根赢；改成从根向子遍历、后来者覆盖。仓库里目前没有
   嵌套布局，所以一直没暴露——主题作者一试就会拿到祖父的副本。

**反向验证（本轮 4 项）**：路由运行时改动 → theme-integration FAIL×12；
7 条新清单守卫 → manifest-validation FAIL×7；i18n 断言收窄 → 强制 `created_i18n_tables: []` 变红；
生成的骨架去掉 4 个 `{{/section}}` → scaffold 同时被「内容计数」与「引擎守卫」两条独立机制抓到。

**反向验证（eshop 主题，7 项）**：`tests/_eshop-inject.mjs` 逐场景注入——未闭合 section /
改 `query.as` / 改 `resolve.by` / 砍 `translatable` / 模板链接指向 `/blog/` / 藏模板文件 /
藏语言包——每个场景先断言"确实注入了"（内容哈希比对），再断言红在预期的断言上，
最后验证还原成功（`assertPristine` 双向把关）。全部符合预期，详见 ARCHITECTURE §4.3。

> ⚠️ **第六种假绿**在本轮暴露：套件渲染抛错时**摘要行不会打印**，
> 校验脚本把「grep 不到摘要」误读成「没有失败」。修法：套件 `catch` 里也打印摘要
> （异常计为一条失败，标注 `(aborted)`）；校验脚本把「摘要缺失」当 FAILED。
> `theme-aurora` 的摘要格式（只打 `N failure(s)`、无 passed 计数）也已统一。
> 详见 AGENTS.md「第六种假绿」与 ARCHITECTURE §4.3。

### 批次 5（后台界面语言 + 账户自助 + 菜单配置）—— ✅ 本轮完成

| 项 | 状态 |
|---|---|
| 核心 UI 语言包 en + zh-CN（各约 90 key：导航/操作/主题/登录/账户/菜单配置/提示/错误码） | ✅ `core-pack.ts`，两语言**同步扩**（§2.4 落地段） |
| SPA 字典消费 `public/admin/js/i18n.js`（叶子模块：`t()` 永不空白、localStorage 登录屏缓存、`setUiLocale`） | ✅ |
| 语言切换器（header 下拉）+ 登录屏双语 + 切换即 `loadContext()+render()` | ✅ `nav.js`/`shell.js`/`auth.js` |
| **菜单标签服务端翻译**：`admin_menu_registry.label_key`（0013）+ `validateAdminMenus` owner 前缀校验 + `admin-menus` GET 消费点 | ✅ eshop 三个菜单复用 `theme.eshop.menu.*` |
| 账户自助改密/改名：`platform/auth.ts`（`changePassword`/`changeUsername`，当前密码闸门在服务函数内）+ `POST auth/password` / `auth/username` | ✅ 稳定错误码 `wrong_current`/`weak`/`taken`/`invalid` |
| `screens/account.js`（每个角色可用，不依赖 `users.manage`） | ✅ 客户端只预检两次新密码一致 |
| per-user 菜单配置：`site_users.menu_prefs`（0013）+ `GET/PUT admin-menus/prefs` + `screens/menu-config.js` | ✅ 规则 38：只影响侧边栏，不授/撤权限；`dashboard` 永远显示 |
| **站点菜单编辑器**（用户追加需求）：逐语言改名（en/zh-CN）、项排序（箭头+拖拽）、**跨组移动**、分组改名与排序、对所有人隐藏、恢复默认 | ✅ `admin.menu.custom` settings blob + `GET/PUT/DELETE admin-menus/custom`（写需 `settings.manage`，GET 回 `can_manage`） |
| 应用点收敛：`nav.js` 纯函数 `applyMenuCustom()`（侧栏与编辑器共用） | ✅ 规则 39：改名叠加在服务端翻译之上；稳定排序；**不存在分组=忽略**（反向验证抓到过“项消失”真缺陷）；结构性变更物化整组 order |
| 新套件 `tests/suites/menu-custom.test.mjs`（40 条：API 契约 + 权限分层 + 校验 400s + 按站隔离 + **纯函数逻辑**） | ✅ 已进 `npm test`（16 套件 682 条） |
| 浏览器验收 v6 扩到 **47 条**：编辑器 11 条（改名 en/zh、组改名、组序、项序、跨组、站点隐藏、zh 回退、恢复默认） | ✅ 全绿 |
| 新套件 `tests/suites/account.test.mjs`（27 条，含 **label_key 翻译端到端**：zh-CN →「商品」、en → "Things"、无翻译回退原文） | ✅ 已进 `npm test`（15 套件） |
| 真浏览器验收 `.wrangler/eshop-verify.cjs` v5（38 条：前台 18 + 界面语言往返 + 服务端翻译菜单 + 菜单隐藏/恢复 + 账户三道闸门） | ✅ 全绿 |
| 主页接管收尾（批次 4 遗留验证）：`routes[]` 声明 `path: "/"` → 前台首页交给主题；home 闭包移到主题路由循环之后作 fallback | ✅ `/`、`/en`、`/zh-CN` 均渲染商品档案 |
| 反向验证：改密/改名守卫下沉 `platform/auth.ts` 后注入（绕过当前密码校验） | ✅ 注入 → 2 红，还原 → 27 绿 |
| **编辑器瘦身（用户反馈后重做）**：单编辑器、**行内全操作**——眼睛=站点级隐藏、箭头=排序、铅笔/点名字=展开改名/移动分组；删掉页面上全部说明文字与「我的显示偏好」面板（数据/API 保留） | ✅ `icons.js` 补 `eye`/`eye-off`；验收 v6 → **48 条**（含「无废话」断言） |
| **界面语言列表数据驱动（规则 40，用户反馈两次后定型）**：加语言 = Languages 屏数据操作，**零代码**。宇宙 = `CORE_PACKS` ∪ 平台字典 enabled ∪ 覆盖层 locale；唯一定义 `packs.ts availableUiLocaleEntries()`（切换列表与校验集同源）；缺 key 回退英文；菜单 label 语言数上限 4→8 | ✅ `packs.ts`/`core-pack.ts`/`api.ts`/`i18n.js`；i18n 套件新增 fr 数据驱动回归（3 条） |

**三条流程教训（本轮实测，详见 §8 坑位 21–23）**：真浏览器验收放在所有套件**之后**跑；
`api()` 非 2xx 时**抛 `Error(data.error)`**（`if (d.error)` 不可达，catch 里要 `explain(err.message)`）；
`ui_lang` 按用户持久化在 D1（**换浏览器也保持**，验收脚本登录后必须显式重置）。

### 批次 6–9 —— 多语言加固 / 规则 41 —— ✅ 已完成

详见 `docs/ARCHITECTURE.md` §8 路线图与 `docs/history/REVIEW-2026-09-29.md`（批次 6 审查报告）。
要点：**批次 6** 审查「多语言事实会不会在后续开发里丢失」，4 高危（`tableDelete` 跨站/删全语言、
theme-api 站点与主题头可伪造、`?? "default"` 地雷、四处 `|| "en"`）+ 3 中危全部修完，
新增 `resolveContentLocale()`（内容语言回退阶梯唯一定义）；**批次 7** 落地规则 41
（所有数据必须有多语言能力，`contract/manifest.ts` 的分类表 `PROSE_FIELD_TYPES` /
`LANGUAGE_NEUTRAL_FIELD_TYPES` + 四道结构守卫）。

### 批次 10（插件系统三支柱）—— ✅ 本轮完成

批次 10 把插件系统从「菜单 + hooks」扩成完整三支柱：**自有表（owner-agnostic）→
通知渠道（declare → host delivers）→ 声明式后台页面（declare → host renders）**。
设计全文在 `docs/design/PLUGIN-ARCHITECTURE.md`；八步交付顺序，每步独立可验证、每条新守卫都反向验证。

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 删除旧主题/插件（39 文件）+ 第十一种假绿修复 | ✅ `576fe6a` |
| 2 | 自有表 owner-agnostic：`theme_table_defs` 重建出 `owner_type` | ✅ `34c0bc9` |
| 3+4 | 渠道契约 + 插件页面契约 + 规则 48–51 校验 | ✅ `bcc856c` |
| 5 | 渠道运行时：webhook 实现 + claim-before-send 去重台账 + `PluginApi.notify` | ✅ `9487b40` |
| 6 | 后台渲染器：`plugin-page` 块渲染 + 渠道设置表单 | ✅ `9fd19db` |
| 7 | **`plugins/notify/` 示例插件**：`webhook` 渠道 + 三块 `adminPages` + `notify-settings` 菜单 | ✅ 本轮 |
| 8 | **`tests/suites/plugin-pages.test.mjs`（56 条）+ `tests/tools/_plugin-pages-inject.mjs`（10 场景反向验证）** | ✅ 本轮 |

**本轮（步骤 7+8）落实的四件事**：

1. **`plugins/notify/plugin.json` 真实存在**（`tests/suites/admin-menus.test.mjs` 从磁盘读它）。
   声明 `webhook` 渠道（`configSchema` 四字段）+ 一个 `deliveries` 页面（`stats`×2 /
   `table` / `form` 四种块）+ `notify-settings` 与 `notify-deliveries` 两个菜单 +
   `title_template`/`default_description` 设置。真实校验器接受。
2. **补上「插件自有表」最后一段未接线**：`syncOwnerTables` 早就支持 `"plugin"`，
   但**从没有人调用它**。经 `PluginTableSync` 提供者注入（规则 3 不允许 `plugin/` import
   `theme/`）按站点扇出——`plugin-pages` 套件证明启用插件会**真的建出物理表**并写注册表。
3. **`tests/suites/plugin-pages.test.mjs`（56 条）** 覆盖：未声明页面 id 被拒（规则 50）/
   块类型闭集合（规则 49）/ `form` 块写入落到**真实物理行**（不是 201）/ `stats` 聚合数字正确
   （含 `sum` 空集为 `null` 而非 0）/ 禁用插件菜单与页面从注册表消失 / 按站点租户边界 /
   **§9 渲染器真渲染**（读回 markup）。
4. **`tests/tools/_plugin-pages-inject.mjs`（10 场景）** 每个守卫注入一个真实缺陷、
   断言**具名断言**变红、还原、哈希一致。全部 0 problem。

**本轮新抓的两个「声明了但没人读」缺陷（200 + 内容错）**：

- **渲染器读错了字段路径**：表格端点答 `{ def: { fields }, items }`，渲染器却读扁平
  `data.fields` → 每个 `table`/`form` 块都画「这张表没有声明这些字段」——**HTTP 200、
  数据在线上完全正确**。修法：`sourceFields()` 先认 `data.def.fields`。
  **这个缺陷在本轮之前没有任何守卫**（`admin-spa` 只查模块图，`plugin-pages` 只查服务端），
  所以本轮给 `plugin-pages` 加了 §9「渲染器真渲染」——**唯一一条把 markup 读回来的断言**。
- **`tableAggregate` 无视 `status` 参数**：声明了却没消费，`sum`/`count` 的"空选择"断言
  因此假绿。修法是消费 `status` 并补一条对照断言（同选择下 `count` 应为真实的 0，
  以证明 `null` 是"没行"而不是"过滤被丢掉"）。


## 6. 测试与验证（当前全绿：24 套件 / 1713 条 / 0 失败，另有 `_schema-scope` 26 条 —— 合计 25 项 / 1739 条）

```bash
npx tsc --noEmit                 # src/ 0 错误（node_modules 里的 lib 冲突是既有的，忽略）
node tests/<name>.test.mjs       # 逐个跑（判据是 0 failures，别把断言数写死）
```

| 套件 | 数量 | 守什么 |
|---|---|---|
| architecture | 161 | 分层红线、默认值零容忍、清单声明与文件对齐、语言包 key 前缀、屏幕集合钉住、菜单引用的表存在、已退役表不再被引用、规则 41 分类表四道结构守卫、**规则 49/51 闭集合双表对比**、**规则 52–55 功能开关**、**规则 56–59 多语言与 URL**、**规则 60 媒体读取路径必须晚于站点解析（结构判据）**、**规则 61 块 attrs 契约：解析渲染器每个 case 的 `a.<key>` 读取集合与声明比对 + 控件覆盖每种类型 + `media-list` 必须声明 `itemKeys`**、**规则 62 媒体控件与 `/media/` URL 各只许一处构造**、**规则 63 词典：SPA 的每个 `t("…")` 键都在每个语言包里 + 两包键集相同 + `core.editor.*` 每个键都有调用点**、**规则 64 自动保存定时器只有一处清理路径 + 导航确实调用它**、**规则 65 主题表的 i18n 侧表（记录说什么就让它成真）**、**规则 66 捆绑主题经 assets 分发：`BUNDLED_THEMES` ↔ `content/themes` 对齐、`public/themes` 逐文件逐字节同步、每个消费点都有兜底、上传/卸载守卫**、**规则 69 注册行不等于安装：boot 链先注册后安装 + 判据数行而非戳记 + 判据镜像清理面**、**规则 70 post_meta 读阶梯只许一处定义 + 读者全走阶梯 + 扫描非空**、**规则 71 语言切换是取数不是改名：版本条必须带语言重新取数 + 禁改名形状 + 列表钉站点默认语言**、**规则 72 拒绝必须带出口：卸载拒绝以 force 为条件 + 强制路径先把占用站点改回捆绑默认主题**、**规则 73 菜单位置确定性：查找 ORDER BY + 渲染读 manifest 位置 + 内置主题声明 menuLocations + SPA 走 scoped**、**规则 74 小工具站点隔离：渲染查询带 site_id + buildScope 喂 widgets 进作用域 + 后台列表同样 scoped + 契约 tenant=site + 内置主题声明 sidebars**、**规则 75 后台前缀是注入的：serveAdminIndex 注入 base + API 整套挂前缀 + 旧地址 404 + cookie Path 是前缀**、**规则 76 站点计数按 site_id 分组 + 主题读站点自己的 theme.active + createSite 播语言行**、**编辑器块面板来自 `CORE_BLOCKS`（SPA 禁块名字面量）**、**Dashboard 统计卡来自 API（禁 stat 硬编码）**、**声明式设置表单 13 类型逐个有渲染分支**、**元守卫：`check()` 条件非布尔即抛错 + 禁"集合当条件" + 禁"字面量当条件"** |
| _schema-scope | 26 | 迁移流应用到临时 SQLite，逐表检验「声明 vs 真实列」一致（租户 + 语言维度） |
| manifest-validation | 104 | 安装边界：每个用例注入单个缺陷，断言必须抛错（含内联语言包、菜单 args、**规则 48–51**、规则 41 双向） |
| admin-menus | 43 | 注册表 schema / `menuRowId` 防碰撞 / 归属隔离 / 排序 / 能力过滤 / 主题与插件注册 / 停用插件只删自己的菜单 / 新站点可见 / 切主题切回 |
| admin-spa | 79 | 后台模块图无环/无孤儿、`window.*` 契约、每个屏幕真渲染一次、**内容编辑器真渲染（新条目 / 已存在条目）：排期往返 + `#locale` 只读 + 自动保存定时器起停 + **规则 71 版本条切换后标题/块/徽标来自目标语言的行 + 列表版本徽标与语言过滤**、**媒体屏：查询串形状与编码 + 分页算术（空 payload 不产出 NaN）+ 瓦片走共享 URL + 垃圾行不产出瓦片 + 工具栏/投放区/上传控件**、**规则 67 界面语言偏好：单写者扫描（只有 `js/i18n.js` 能写）+ 写者自己重载字典 + 运行时"保存后顶部勾选跟着走、不需要刷新" + "被拒绝时不改语言"** |
| template-engine | 49 | 模板解释器单元（含子模板未闭合 section 抛错、三层继承最派生者胜） |
| scaffold | 71 | 生成的 theme/plugin/table 过**真实**校验器 + **真实**模板引擎 + **真实**架构规则 |
| theme-integration | 134 | 上传→激活→CPT→渲染→切主题保数据，端到端（含表驱动路由）、**§9 卸载全清理 + 占用拒绝 + `?force=1` 强制卸载（占用站点回落捆绑默认）**、**§11 菜单位置确定性（独立站点双 header 菜单稳定获胜 + footer 位置渲染 + 二次渲染一致）**、**§12 小工具端到端（四类型渲染 + 禁用/异语言/跨站均不出现）** |
| locale-url | 36 | 按语言 slug 的路由/404/唯一性、hreflang、按语言 feed、切换器（规则 56–59）、**§1b 自定义字段带语言（单页/列表按语言取值 + 阶梯第 2 层回退 + 列表 reading_time）** |
| theme-fixture | 47 | fixture 主题的声明与模板自洽 |
| theme-default | 53 | default 主题（墨白 MOBAI）：模板真渲染 + head 的 SEO 契约（canonical/og/hreflang/feed）+ 语言包键完整性 |
| multisite | 100 | 多站点隔离（含 SEO 端点按站点、**§9 断言关掉 KV 镜像后确实没有 KV 写入**、**feed 按站点 + RSS 断言**） |
| i18n | 75 | 多语言四层契约（§5.4① 八条）+ 翻译组 + 主题自有表 |
| admin-contract | 133 | 后台 API 契约（含块面板形状/无漂移/en+zh 标签、**调色板下发的 attrs 契约（类型/必填/翻译标签/`itemKeys`/容器标记）**、dashboard cards 数组、设置 options 往返、**§12 列表按站点默认语言取代表行 + `locales` 集合 + `?locale=` 过滤 + 未翻译行不被吞**、**§13 菜单契约：CRUD + 批量重排先验归属 + 嵌套一层 + 删父升级子 + 跨站点 404**、**§14 小工具契约：scoped CRUD + config 校验 400 + 跨站 404**、**§15b 前缀挂载带全量请求：经前缀的 `?site=` 真的改变答案 + `?withCounts=1` 真的改变 payload 形状 + 分页参数到达**、**§16 站点计数契约：行级语言种子 + 每站计数含草稿 + 邻站计数是它自己的 + 空站报 0 + 主题读选择/未选报空 + 不带 withCounts 无新字段 + 非当前站点的默认语言可钉**） |
| **media-picker** | **31** | **统一媒体控件（批次 16 Track A3 新增）**：`mediaUrl()` 的形状与**能被读取路径解回同一个 key** / `mediaItem()` 归一化（`media_files` 行与已存值两种输入、垃圾输入拒绝）/ 坏 payload 不炸对话框 / 控件的单值与多值两种形态 + 调用方寻址透传 + 转义 / **闭环：选择器给的 URL，真实渲染器画得出图片与画廊** / 三个消费点都走共享控件 |
| **editor-blocks** | **40** | **块 attrs 契约的往返（批次 16 Track B1 新增）**：契约良构（类型闭集合/标签/`itemKeys`）+ **契约 → 控件 → 写入的属性键 → 真实渲染器 markup** 的往返 + `required` 的语义（无 url 的图片渲染空）+ 嵌套寻址（子块按路径写入、父块不被穿透）+ **§8 反向对照**（按旧编辑器形状构造的图片/画廊/HTML 块必须渲染为空） |
| **media** | **69** | **媒体访问（批次 16 Track 0 新增）**：租户闸门（跨站 key → 404）/ 会话闸门 / **owner 硬隔离（含管理员）** / legacy `uploaded_by IS NULL` 的祖父条款 / 上传写归属 + 站点必须真实存在 / 列表按 owner 收窄 + `q`/`type`/分页/`total` / dashboard 媒体卡与列表 total 一致 / PATCH alt·title（非 owner 403、无 `media.write` 403、别站 id 404）/ **DELETE 先删 R2 对象再删行** / 脏策略行 fail-closed / **站点列表 memo 的 per-request 复位**（§1：先发前台请求 → 再建站点 → 再请求它） |
| account | 27 | 账户自助：改密/改名的当前密码闸门、稳定错误码、menu_prefs 隔离、label_key 翻译端到端 |
| menu-custom | 40 | 站点菜单编辑器三端点契约、权限分层、10 种结构违规 400、`applyMenuCustom` 纯函数语义 |
| plugin-hooks | 32 | 插件 hook 生命周期 |
| **plugin-pages** | **56** | **插件声明式后台页面（批次 10 新增）**：未声明页面 id 被拒（规则 50）/ 块类型闭集合（规则 49）/ `form` 块写入落到**真实物理行** / `stats` 聚合数字正确（`sum` 空集 = `null` 非 0）/ 禁用插件菜单与页面从注册表消失 / 按站点租户边界 / **§9 渲染器真渲染（读回 markup——本轮唯一一条把响应变成 HTML 再断言的守卫）** |
| plugin-channels | 55 | 通知渠道运行时：webhook fetch 计数、claim-before-send 去重（含跨站双向）、`readChannelConfig` 只读声明过的 key |
| **features** | **56** | **平台功能开关（批次 11 新增）**：列表与来源标注（site/var/default）/ **两层鉴权**（匿名被拒 + 非管理员 `author` 写 → 403，读只需会话）/ 保存往返 + 只落一行 + INSERT 分支 / **三层优先级逐层单独验**（站点行 > `env` var > 默认）/ 脏行降级 / 未知 key → 400 且不落库 / 屏幕接线 / UPDATE 分支（两次保存仍一行） |
| theme-worker | 37 | L3 沙箱（含 WorkerStub 不可跨请求）+ **§10 功能开关反向验证：`theme_runtime_worker` 关/删/显式 false/拼错时都不加载沙箱，站点设置关能压过 var 开** |
| launcher-parity | 62 | `cfpress.sh` ↔ `cfpress.ps1` 动作/菜单编号/套件表/退出码逐项对齐（解析结构，非 grep）+ BOM + 磁盘套件全集对齐 |

⚠️ **一跑必须有摘要行**：所有套件遵循「catch 里也打印摘要、崩溃标注 `(aborted)`」——
脚本判据统一是 `^[0-9]+ passed, [0-9]+ failed`，**匹配不到就当失败**（见「第六种假绿」）。
本轮清掉了三处**多余的第二个摘要行**（`admin-spa` / `i18n` / `architecture` 各自打过一个
`${X ? "1" : "0"} failure(s)`）——两个摘要两种拼法，正是 grep 抓错行、把崩溃读成通过的原因。

另有一个**不在 `npm test` 链里**的反向验证工具（`_tenant-query-audit.mjs`，跑得可当普通 suite）：

```bash
node tests/tools/_schema-scope.mjs           # 迁移流 → 临时 SQLite，逐表核对声明与真实列
node tests/tools/_tenant-query-audit.mjs     # 列出所有「碰租户表但不带 site_id」的语句；每条需书面裁决
node tests/tools/_config-parity.mjs          # 本地配置 = 从模板+ids 重新生成的字节（进 npm run gate）
```

⚠️ `_config-parity.mjs` 的**第一条真实命中就是它自己**：写完立刻红了，因为
`wrangler.local.jsonc` 的**注释里**有一句解释占位符机制的 `REPLACE_WITH_*`——守卫
原本扫的是**原始文本**，分不清"文档提到占位符"和"占位符没被替换"。改成只扫**解析后的
值**。写守卫时先问：**我扫的是配置，还是关于配置的散文？**

⚠️ `_tenant-query-audit.mjs` 的 `REVIEWED` 表**键是 `file:line`**——任何在上方的编辑都会
把一条已裁决的语句挤成 `NEW`。本轮 `api.ts` 新增若干行后，`theme_installs` 那条从 `:1154`
移到 `:1187`，必须**重新键位**；同时补了 `notify.ts:108`（本批次的去重台账回写）的裁决。
跑它时 `NEW` 是**提示不是失败**，但每条都要有人看一眼。

插件系统的反向验证工具（手工跑，不进 `npm test`）：

```bash
node tests/tools/_plugin-pages-inject.mjs    # 10 场景：注入真实缺陷 → 断言具名断言变红 → 还原 → 哈希一致
```

**系统骨架 + 功能开关**的反向验证工具（10+ 场景，手工跑）：

```bash
node tests/tools/_skeleton-inject.mjs        # 35 场景：schema / 事件契约 / 断言拼法 / 功能开关 / 块面板 / 块 attrs 契约 / 媒体控件 / 词典 / dashboard 卡 / 设置表单分支
node tests/tools/_locale-url-inject.mjs     # 4 场景：规则 56–59（slug COALESCE / 散落回退 / locale 正则 / feed 站点隔离）
node tests/tools/_launcher-inject.mjs        # 16 场景：启动器两侧对齐 / BOM / stderr 提示 / EOF 退出
node tests/tools/_media-inject.mjs           # 7 场景：规则 60（租户闸门 / 会话闸门 / owner 读闸门 / owner 列表子句 / 上传归属 / 删除顺序 / 分支位置）
```

⚠️ 这三个工具（`_skeleton` / `_launcher` / `_plugin-pages`）都用 **Worker 线程在进程内**跑套件——
本沙箱 `spawnSync` 一律 `EBUSY`，用子进程会把「跑不起来」伪装成「没变红」。
其 worker 入口**只由套件自己桩掉的 `process.exit` 收尾**（不能 `.then(() => done(0))`）：
`import()` 在模块体结束时即 resolve，**早于 `main()` 的第一个 `await`**，慢套件（esbuild 编译）
会确定性地输掉这场竞速、被读成「注入后没有摘要」——即把红读成 abort。见 §8 坑位 30。


第二个反向验证工具，守**规则 41（所有数据都有多语言能力）**：

```bash
node tests/tools/_i18n-field-inject.mjs      # 6 个场景，注入→断言按名字变红→还原→再断言干净
node tests/tools/_i18n-data-inventory.mjs    # 清点所有承载数据的声明类，列出还没有语言维度的
```

⚠️ **多套件共享同一个本地 D1**：断言必须按 owner 收窄（`theme_name` / 站点），
别写全局计数。`theme_table_defs` **按设计不随主题停用消失**，所以夹具必须删掉自己的注册行
**并且** drop 自己生成的表——否则下一套件会看到上一套件留下的东西
（i18n 套件已经因此假红过一次）。

另有两个**不在 `npm test` 链里**的真实浏览器验收脚本：

```bash
npx wrangler dev --port 47913 --ip 127.0.0.1     # 另开一个 shell
node tests/tools/_i18n-browser.cjs                     # 多语言：39 条断言（含 §7 编辑器界面语言、§8 界面语言开关）
node tests/tools/_admin-menus-browser.cjs              # 菜单与生成式屏幕：31 条断言
node tests/tools/_media-picker-browser.cjs             # 媒体控件 + 媒体屏：34 条断言（批次 16 A3/A4）
node tests/tools/_sites-screen-browser.cjs             # 站点屏：计一次请求 + 每行真三元组 + 预览链接按各自前缀 + 主题徽标跳转（批次 28）
node .wrangler/eshop-verify.cjs                  # eshop 全链路 + 批次 5 新功能：47 条断言
```

⚠️ 站点屏脚本还**故意用一个 404 换一个真相**：`page.on("request")` 收集 `/api/` 路径的
查询串，因此「计数只发了一次请求」是**观察出来的**而不是数出来的（见下方坑位：这也是
唯一能照出「前缀挂载丢 query」的地方）。查路径时用 `startsWith`，不要用 `===`——SPA
还会请求 `/admin/api/v1/site/logo`，那是另一个 404 噪音源，会让「零未捕获错误」这条假红。

⚠️ **`_media-picker-browser.cjs` 的 API 调用必须走页面自己的 `fetch`**（见坑位 43）——
用 `context.request` 会 401，因为会话 cookie 是 `Secure` 而 Playwright 的请求上下文
在 http 上不发它。

⚠️ **浏览器验收必须放在所有测试套件之后跑**（先测试 → 再 `theme:deploy` + 恢复 locale
→ 最后验收）。15 个套件共享同一块本地 D1，幂等清理会清掉 `site_locales` 的 zh-CN 行
与 `settings.theme.active`——本轮 `/zh-CN` 404 之谜的真相就是这个（ symptom 是
"昨天还好好的 URL 今天 404"）。`eshop-verify.cjs` 对此**自愈**：登录后先把界面语言
重置为 en 再重载（`ui_lang` 按用户持久化，见坑位 23）。

`_i18n-browser.cjs` 跑 39 条断言：登录 → Languages 屏（含**内置简体中文必须被列出**）→ 加语言 →
编辑器语言版本条 → 建翻译 → 删翻译 → 停用语言 → 切界面语言，并断言**零 console 错误、零失败请求、零 5xx**。
§8 是**唯一**能看见「面板与顶部勾选是否一致」的地方：它读 `#lang-menu .menu-item.active` 的
`data-ui-locale`，点真 Save，**不刷新**断言勾选跟着走（规则 67）。
⚠️ §4 需要库里有「翻译版本不完整」的文章；全新空库上没有文章时它会红（夹具前提，不是代码缺陷）。

`_admin-menus-browser.cjs` 跑 31 条断言：SEO 插件菜单出现在 "Extensions" 分组 → 打开
插件设置 → 值写入后**刷新仍在**；再上传一个声明 `tables[]` 的主题 → 激活 → "From theme"
分组出现 → **列表的列来自 `fields[]`、表单控件来自 `field.type`** → 存 → 列表可见 →
删 → 复原初始状态。

两个脚本都**自己清理自己**，所以可以重复跑；都用应用自己的 API 挑选目标数据，
不依赖固定行号。

⚠️ **`node tests/run-all.mjs` 在本机沙箱会整体报 SKIP（EBUSY）**——Windows 沙箱锁 node 二元文件，
不是测试失败。**逐个直接跑才可靠。**

⚠️ **断言强度教训**（`tests/suites/multisite.test.mjs` 第 9b 段曾假绿）：断言必须盯住
"注入缺陷后必然会变的那一个值"。断言"XML 格式正确"这类东西等于没断言。
**上一轮又踩了一次同源的坑**：`tests/suites/admin-spa.test.mjs` 第一版断言"`render()` 没抛错"，
而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板 —— 于是注入一个
未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**（非空、不含错误面板）。

⚠️ **反向验证本身也会假绿**（本轮新增的第四种失败，见 `AGENTS.md`）：
为 `clearOwnerMenus` 写的归属隔离用例原本拿"主题 owner vs 插件 owner"对比，
于是把 `WHERE` 里的 `owner_name` 整条删掉**测试依然全绿**——两个 fixture 的 `owner_type`
本来就不同，`owner_name` 在这一次比较里是多余的。**被删掉的那一半必须是唯一区分
fixture 的那一项**；修正方式是再加一个**同类型**的第二个 owner（注入后 3 个 FAIL）。

⚠️ **新守卫必须反向验证**：写完守卫 → 故意注入一次违规 → 确认它 FAIL。测不出失败的检查等于没有检查。
本轮 6 项注入（见 §5 批次 3）全部如期变红。

## 6b. 线上部署与运维（免费计划）

**当前线上状态（2026-10-09）**：`cfpress.2aass.workers.dev` 已部署到批次 16 全部三个 track，
远端 D1 已到 **0018**（`wrangler d1 migrations list --remote` 报 "No migrations to apply"）。
部署前的线上抽查（方案文档里承诺的那一步）结果：**0 个媒体文件、0 处内容引用 `/media/`、1 个站点**——
所以规则 60 的两条行为变更（要求会话 + key 站点校验）当时**没有任何东西可破坏**。
⚠️ 一旦开始上传媒体并在内容里引用，`require_session` 默认**开**就意味着前台图片对匿名读者 404
（规则 60e）；Media 屏里改一行即可放开。
⚠️ 沙箱内**无法**用 HTTP 验证线上（代理拦截 `*.workers.dev`），只能靠 `wrangler deploy` 输出
+ `deployments status` 证明；要真验证请开浏览器。

- **部署顺序**：先 `node scripts/make-local-config.mjs`（或直接 `npm run deploy`，`predeploy`
  会跑）→ `wrangler d1 migrations apply cfpress --remote -c wrangler.local.jsonc`
  → `wrangler deploy -c wrangler.local.jsonc`（**捆绑主题文件经 Worker assets 自动带上**：
  `predeploy` 先跑 `scripts/sync-bundled-themes.mjs` 把 `content/themes/**` 同步进
  `public/themes/**`，`wrangler deploy` 上传 assets，运行时 `bundledThemeFile` 兜底读——
  **规则 66**。曾经"主题文件逐个 `wrangler r2 object put`"的那一步已从流程中删除）。
  **迁移必须先于 deploy**（新代码写新列，列不存在即 500；旧代码+新列无害）。
  ⚠️ **远端 `theme_installs` 有行 ≠ 远端 R2 有文件**（踩过两次的老坑）——对**捆绑主题**
  这不再是坑（文件走 assets，与 R2 无关）；对**用户上传的主题**依然成立。
- **远端灌内容**：`wrangler d1 execute cfpress --remote --file=…`。大 SQL 会报
  `{"D1_RESET_DO":true}` → **按 ~4 条语句一批**分次执行。写完 bump
  `content_cache_versions` 让前台缓存失效。
- **监控**：沙箱/本地都无法访问 `*.workers.dev`（代理 502），用 Cloudflare **GraphQL
  analytics**（`api.cloudflare.com` 放行）查 `workersInvocationsAdaptive` 的
  `dimensions{status}`。⚠️ **标签 ≠ 根因**：`scriptThrewException` 那次的真因是 CPU 超限
  （Error 1102 不打这个标签）。
- **免费计划 = 单请求 10ms CPU**（付费 50ms，可调 3000ms）。`hashPassword` 的
  `PBKDF2_ITERATIONS = 25000`（≈3.5–5ms）就是按这个预算定的，**别调回 120000**
  （实测 22.4ms → 写库前被杀 → `site_users` 恒 0 → 登录报 "Request failed"）。
  迭代数写在 hash 串里，调高不破坏旧密码；任何"每请求都要跑"的重计算先问 10ms 够不够。
- **推送纪律**：`npx tsc --noEmit`（src/ 0 错误）+ `npm run gate` 全绿才许 push；
  push 后三路验证（`git rev-parse` == `git ls-remote` == `gh api …/commits/main`）。
- ⚠️ **待办**：之前曾在对话中泄漏过一个 Cloudflare API token（`cfut_` 开头，完整值见
  当时的对话记录，**不要写进本仓库**——GitHub secret scanning 会拒收推送，这也是它仍被视为
  泄露的证明）。应到 https://dash.cloudflare.com/profile/api-tokens 撤销。

## 7. 后台 SPA（两轮前拆分，批次 5 增 3 个模块，批次 10 再增 2 个，批次 15 数据驱动三面）

> 批次 15 起三块界面**只渲染平台下发的数据**，别在 SPA 里重新列清单：
> 编辑器块面板 ← `GET /api/v1/blocks`（`CORE_BLOCKS`）；Dashboard 统计卡 ← dashboard API 的
> `cards` 数组（插件经 `dashboardCards` filter 注入）；主题/插件设置表单 ←
> `theme/{name}/settings`，按 `ALLOWED_FIELD_TYPES` 逐类型渲染
> （architecture.test.mjs 有三节守卫盯着，硬编码即红灯）。

`public/admin/admin.js` 1514 行单文件 → 入口 + 6 个基础模块 + 屏幕模块
（`js/screens/` 现有 24 个文件：注册表 `index.js` + 23 个屏幕/工具模块）。

### 落点

```
public/admin/
├── admin.js             入口：装配 + window.* 注册（< 120 行）+ boot 时 cachedMessages()
├── ui.js  icons.js      UI kit / 图标
└── js/
    ├── state.js         state + api/scoped/contentPath/postTypeInfo/loadContext（叶子模块）
    │                    loadContext 同取 admin-menus/prefs → state.hiddenMenus（与菜单同取：
    │                    切语言重跑 loadContext 时两者同时刷新）＋ state.plugins（每个块
    │                    页面的声明来源）
    ├── i18n.js          ★ 批次 5：t()/loadMessages/setUiLocale（叶子中的叶子，谁都能 import 它）
    ├── plugin-page.js   ★ 批次 10：声明式插件页面的**渲染器**（谁都能 import 它，无状态）
    │                    导出 RENDERED_BLOCK_TYPES / RENDERED_AGGREGATES /
    │                    RENDERED_CHANNEL_FIELD_TYPES，架构测试按集合与契约对比
    ├── nav.js           baseGroups（分组带稳定 id）/ applyMenuCustom（★ 站点定制唯一应用点，
    │                    纯函数，侧栏与编辑器共用）/ navGroups（应用定制 + 双层隐藏过滤）/
    │                    navGroups / sidebar / header（语言下拉）
    ├── shell.js         render + go + switchSite + pageHead + 屏幕注册表 + 页名分发 + 语言切换委托
    ├── auth.js          renderLogin / doLogin / logout / setThemeForTest（登录成功后 loadMessages）
    ├── table-form.js    字段类型 → 控件 的唯一映射 + 值往返
    └── screens/         index.js（注册表）+ 23 个屏幕/工具模块
                         ★ account.js / menu-config.js 是批次 5 新增（都走 data-* 委托，零新 window.*）
                         ★ menu-config.js = 站点菜单编辑器（改名/排序/跨组/隐藏/恢复默认，
                           结构性变更物化显式 order，标签 change 即存、Enter 提交）+ 我的偏好双面板
                         ★ plugin-page.js 是批次 10 新增：`plugin-page:<id>` 屏幕——
                           声明从 state.plugins 读（单一事实源），每块独立加载数据
```

**`i18n.js` 是叶子中的叶子**：不 import 任何东西，所以包括 `ui.js` 在内的所有模块都能
依赖它而不成环。菜单标签**不在**这里翻译——`admin-menus` API 已在服务端把 `label_key`
换成译文，切换语言时 `setUiLocale → loadContext() → render()` 重取上下文即可。

**`plugin-page.js`（渲染器）是第二个「谁都能 import」的叶子**：无状态、不读 `state`，
只吃 `(decl, dataBySource)` 返回 HTML。它存在的原因是**插件不能带可执行代码**
（Workers 禁 `eval`/`new Function`/动态 import），所以插件声明 `blocks[]`、宿主负责画。
这是同一个模式的第三次应用，前两次是 `tables[].fields[]`（宿主生成 CRUD 表单）与
`channels[].configSchema`（宿主生成设置表单）。**加了新块类型要改三处**——契约、
`RENDERED_BLOCK_TYPES`、渲染器 switch——漏一处是架构测试失败，而不是 200 的空面板。

**关键设计：`shell.js` 不 import 任何屏幕。** 屏幕通过 `setScreenTable(SCREENS)`
自注册，登录屏通过 `setLoginScreen(renderLogin)` 注入 —— 否则
`shell → screens → shell` 立即成环。`extension-install.js` 独立出来是为了
不让"主题屏"依赖"插件屏"。屏幕内的 `window.xxx()` 调用已全部改为直接调用导入的函数。

### 页名分发（批次 3 定形，批次 10 加第五个前缀）

`shell.js` 按前缀分发页名：`menu:<id>`（扩展菜单）、`table:<t>`（列表）、
`table-new:<t>`（新建）、`table-edit:<t>:<slug>`（编辑）、**`plugin-page:<id>`（批次 10）**。
**必须保持三前缀分离**——
合并成 `table:<t>[:<slug>]` 会让"列表"和"新建"成为同一个页名，点 Add 时路由认为
"已经在目标页上"而不重渲染，按钮看起来完全没反应（见 §8 坑位 17）。

> **新屏幕不该产生新的 `WINDOW_HANDLERS` 条目。** `screens/languages.js` 全部动作走
> `data-lang-enable` / `data-lang-disable` / `data-action="add-language"` 这类
> document 级委托，一个 `window.*` 都没加；本轮的 `table-list.js` / `table-edit.js`
> 同样走 `data-table-new` / `data-table-edit` / `data-table-del` / `data-table-save`。
> 新代码照这个来——规则 23 那个"漏登记零报错"的坑，最好的用法是根本不去踩它。

### `window.*` 契约（注意：是 **17** 个，不是 18 —— 之前本文档写错了）

markup 用内联 `onclick="name(...)"`，浏览器解析在 `window` 上、不在模块作用域。
**少注册一个不会有任何报错**：不编译、不报 console、不发失败请求，按钮就是点了没反应。

`toggleMenu` `closeMenus` `toggleGroup` `toggleSidebar` `go` `switchSite`
`newContent` `editContent` `addBlock` `saveContent` `showRevisions` `deleteContent`
`installExtension` `pluginSettings` `doLogin` `logout` `setThemeForTest`

全部集中在入口的 `WINDOW_HANDLERS` 映射里，一眼可见。

### 配套测试 `tests/suites/admin-spa.test.mjs`（56 条）

1. 相对 import 全部可解析；模块图无环（DFS，报出完整环路径）；无孤儿模块
2. `window.*`：入口有 `WINDOW_HANDLERS` 映射；17 个一个不少；markup 里调用的名字全部登记过
3. 入口保持薄（< 120 行、不定义任何屏幕）；`js/screens/` ≥ 15 个文件
4. **真实 import 入口**（复制到临时目录加 `type: module`，用 DOM/fetch 替身）：
   启动不抛错、无未处理 rejection、17 个处理器都是函数
5. **所有页面各真渲染一次**，断言写进 `#content` 的内容非空且不含错误面板
6. 编辑器（新条目 / 已存在条目）、媒体屏（分页/编码/瓦片）、**规则 67 的界面语言偏好**
   （单写者扫描 + 写者自己重载字典 + 保存后顶部勾选跟着走 + 被拒绝时不改语言）

### 真实浏览器验收（三套）

**两轮前（后台拆分）**：`wrangler dev` + Chromium（playwright-core，浏览器已在
`%LOCALAPPDATA%\ms-playwright`）

- 静态资源全部 200 且 MIME 正确（`/admin/js/**` 目录确实被托管）
- 登录 → 侧栏真实点击（走 document 级委托）→ 主题下拉切换 → 侧栏折叠
- **16 个页面 × 明暗两套** = 32 次渲染，0 异常：h1 非空、导航项存在、正文 > 200 字符、壳层存在
- 用户菜单登出（走 `data-action` 委托）回到登录页
- console 零错误、零 5xx。唯一 401 是登录前的 `/api/v1/auth/me`，**设计内**

**上一轮（多语言）**：`tests/tools/_i18n-browser.cjs`，22 条断言，见 §6。
它把「语言开关 → 编辑器语言版本条 → 建翻译 → 删翻译」这条链在真浏览器里走通，
并证明**界面上真的多了一块、又真的少回去**——而不是只证明接口返回了 200。

**本轮（菜单 + 生成式屏幕）**：`tests/tools/_admin-menus-browser.cjs`，31 条断言，见 §6。
它证明的是**"声明 → 后台"这条路真的通了**：插件菜单出现并能打开设置页、
主题声明的表真的生成了列表列与表单控件、值真的存进去且刷新后还在。
**这一套抓到了单元测试看不见的产品缺陷**（"新增/列表同名"，见坑位 17）——
两个屏幕各自都能渲染，所以逐屏渲染测试永远发现不了它。

### 没做的事（已登记）

`public/admin/` 没有搬到仓库根的 `admin/`。`wrangler.jsonc` 的 `assets.directory`
只接受**一个**目录，而 `/admin/*` 这个 URL 空间必须保留（`src/index.ts` 把
`/admin` 前缀交给 `env.ASSETS.fetch()`，`robots.txt` 也依赖它）。搬迁要么再加一个
静态目录、要么把 `public/` 整个重构——都与"拆 JS"正交。已登记进 `AGENTS.md`
的偏离表。

同样登记在偏离表、留给批次 4 的还有：`public/admin/ui.js` 未再细分；
`extensions/contract/` 只拆出了 `hooks.ts`；**插件自有表**（需要重建 `theme_table_defs`）。

## 8. 关键坑位清单（新人必读）

1. **Workers 禁止 eval / new Function / 动态 import** —— 模板引擎是解释执行，永远别引入 eval 类方案
2. **`.wrangler/` 含 bootstrap 管理员密码 hash**，已 gitignore，绝不入库
3. **多站点**：`theme_installs.active` 不是"当前主题"；唯一事实源是 `settings` 表按站点的 `theme.active`。
   声明表主键用 `scopedId(prefix, siteId, key)` 内嵌站点，否则跨站 UNIQUE 冲突
4. **主题切换只隐藏声明、绝不删数据**（含主题自有表）
5. **L3 主题 Worker**：`WorkerStub` 请求作用域，只能缓存 R2 源码字符串；`load()` 失败是延迟的，必须 `/__health` 预热
6. **清单校验的硬边界**：`blocks[].name` 纯标识符不带斜杠（`core/` 前缀是平台内置专用）；
   表名 ≥2 字符；表字段类型只有 6 种。新增清单规则的标准动作：
   写进 `validateManifest` → 在 `manifest-validation.test.mjs` 加注入用例 → 同步 `AGENTS.md` 与 §5.3
7. **每轮做完必须 commit + push**（用户明确要求），push 后**必须独立验证**：
   `git ls-remote origin main` 要等于本地 HEAD（沙箱 git 有"命令成功但 ref 没变"的已知问题），
   最硬的证据是 `gh api repos/unifare/CFCMS/commits/main --jq .sha`
8. **memory 文件与文档里的路径引用要跟着重构走** —— 上轮分层后 `MEMORY.md` 残留 8 处 `src/core/*` 旧路径，差点误导后续会话
9. **后台改结构时**：`shell.js` 不得 import 屏幕（自注册）；屏幕之间不得互相 import；
   新的 `window.*` 处理器必须登记进入口的 `WINDOW_HANDLERS`（漏登记**零报错**，按钮点了没反应）。
   见 `AGENTS.md` 规则 21–24。**优先用 `data-*` 委托，根本不产生新的 `window.*`。**
10. **别把"没抛错"当断言**：`render()` 会 catch 屏幕异常并渲染错误面板，
    所以"`render()` resolved" 不等于"屏幕是好的"。断言要盯**写进 DOM 的内容**。
11. **`lang_group` 可空，「没有它就是自己」只能写一次**。JS 用 `groupOf()`、
    SQL 用 `GROUP_SQL`（都在 `src/api.ts`，紧挨着），两处共用同一个定义。
    只写 `WHERE p.lang_group = ?` 会**排除组名所指的那一行自己**，于是组看起来是空的：
    编辑器报告语言缺失，并诱导用户**再建一份已经存在的内容**——不报错，只是悄悄多一份。
12. **语言开关是后台上下文的事实源**。改完必须 `loadContext()` 再 `render()`，
    否则 `state.locales` 是旧的，`loadVersions()` 以为站点只有一种语言，
    **整个语言版本条不渲染**。屏幕上"少一块"不会报错，所以极难发现。
13. **别把"缓存是空的"和"事实是空的"当成同一件事**。`loadVersions` 原本写
    `state.locales.length < 2` → 空数组走了"单语言"分支。改成只在**确知**单语言
    （长度恰为 1）时短路，其余情况问服务端。
14. **`langs` 语言包两条路径**：主题从 R2 读 `themes/<name>/langs/<locale>.json`；
    插件**没有目录可读**（`uploadExtension` 把包当 zip 原样存，从不解包），
    只能把语言包**内联在 `plugin.json` 的 `langs{}` 里**。两条路径同一套 key 前缀规则。
15. **`{table}_i18n` 永不 drop、永不清回 NULL**。语言停用只隐藏；重新启用时翻译必须还在。
    主表字段只增不删（`ALTER TABLE ADD COLUMN`）。这是与 WordPress 的分界线。
16. **`.wrangler/` 里的本地 D1 会被测试直接写**（`node:sqlite` 读 miniflare 的 sqlite 文件），
    所以测试留下的 fixture 会出现在后台列表里。**别把"后台里怎么多了几条测试数据"当成 bug。**
17. **后台页名必须三前缀分离**（`table:` / `table-new:` / `table-edit:`）。
    曾经合并成 `table:<t>[:<slug>]`，"列表"与"新建"因此是**同一个页名**：点 Add 时
    路由判断"我已经在这个页面上了"→ 不重渲染 → **按钮看起来完全没反应**
    （无报错、无失败请求、无 5xx）。逐屏渲染测试发现不了它（两个屏幕各自都能渲染），
    **只有真实浏览器点一下才会暴露**。见 `AGENTS.md` 规则 35。
18. **菜单必须带归属（`owner_type` + `owner_name`）**，`admin_menu_registry` 是唯一来源，
    `theme_admin_menus` 已退役。主题菜单**按站点**；插件菜单**写一次 `site_id='*'`**、
    读时 `site_id = ? OR site_id = '*'`——插件只有安装级 `enabled`，按站点扇出需要
    一个**尚不存在**的"建站点钩子"，少了它新站点会静默地没有任何插件菜单。
19. **`table-list` / `table-edit` 的列与控件必须由 `tables[].fields[]` 生成**，
    主题不得手写后台表单。字段类型只有 6 种，`datetime` 列**全库都是 INTEGER 秒**
    （`table-form.js` 的 `toLocalInput`/`fromLocalInput` 负责往返）。**插件不得声明
    `tables[]`、也不得用这两个 screen**（校验器直接拒绝，不是忽略——静默忽略一个已声明
    的能力比拒绝它更危险）。
20. **反向验证的 fixture 必须只有一处差异**。拿"主题 owner vs 插件 owner"去验
    `owner_name` 过滤是**假绿**：删掉 `owner_name` 依然全绿，因为两个 fixture 的
    `owner_type` 本来就不同。写用例时先问「我把这一条删了，哪个断言会变红」。
21. **共享 D1 会被测试套件清掉配置**。15 个套件共用同一块本地 D1，幂等清理波及
    `site_locales`（zh-CN 行消失）与 `settings.theme.active`——症状是"昨天还好好的
    `/zh-CN` 今天 404"。**验收顺序铁律：先跑全部套件 → 再部署/恢复配置 → 最后真浏览器
    验收**。`eshop-verify.cjs` 对语言状态自愈（登录后重置为 en 再重载）。
22. **`api()` 帮手在非 2xx 时抛 `Error(data.error)`**——服务端的稳定错误码
    （`wrong_current`/`weak`/`taken`/`invalid`）出现在 catch 的 `err.message` 里，
    SPA 里 `if (d.error)` 分支**永远不可达**。错误对话框要写
    `explain(err.message)`，否则用户看到裸码（账户屏实踩：对话框显示 "wrong_current"）。
23. **`ui_lang` 按用户持久化在 D1，换浏览器也保持**。全新浏览器登录依然是上次的语言
    （localStorage 缓存只是登录屏的加速，不是事实源）。浏览器验收脚本断言界面文案前
    必须先显式重置语言；否则上一次运行切过中文，这一次的英文断言全红——**功能没坏，
    是状态没归零**。
24. **SPA 套件的盲区：只 import、不点击**。`admin-spa.test.mjs` 做静态检查 + 真实
    import 入口，但从不执行登录点击路径——`doLogin` 里漏 import 一个函数（ReferenceError）
    套件全绿，因为屏幕渲染异常会被 catch 成错误面板，而登录路径根本没被走到。
    **登录卡死的探针**：playwright 监听 `console`/`pageerror`/`response` + 打印
    `#dialog-host`（`_i18n-browser.cjs` 同款手法；`auth.js` 缺 `loadMessages` 就是这样抓到的）。
25. **`fill()` 只派发 `input` 不派发 `change`**。菜单编辑器的标签输入在 `change`（失焦）时
    才保存——自动化测试 fill 之后**必须显式 blur**，否则断言读到的是改名前的界面
    （v6 首跑实踩：改名断言挂了，但后续步骤的点击触发 blur 又把它救活了——症状是
    "现在没生效、两步之后生效了"）。Enter 提交（keydown→blur）是给人用的快捷方式，
    不是给 playwright 的。
26. **「声明了但没人读」缺陷族又添两员（批次 10）**：字段被校验、运行时没人消费 → **200 + 内容错**。
    ① 插件列表 API 把 `adminPages[]`/`channels[]` 存成 JSON **字符串**（透出了但读不了）；
    ② 渲染器读扁平 `data.fields` 而端点答 `data.def.fields`（每块都画"表没有这些字段"）；
    ③ `tableAggregate` 声明了 `status` 参数却从没消费它（空选择断言因此假绿）。
    **加字段时先找它的消费点，找不到就别加**——同一个病在本仓库已经出现七次。
27. **守卫的"观测面"决定了它能抓到什么（批次 10 的核心教训）**。渲染器字段路径的缺陷
    **在服务端断言里根本不可见**：`plugin-pages` 起初只查 API 与 DB，注入该缺陷后
    `admin-spa`（只查模块图）与 `plugin-pages`（只查服务端）**双双全绿**。
    修法不是再加一条服务端断言，而是**加一条把响应变成 HTML 再读回来的断言**（§9）。
    **推论**：一条守卫只能证它观测的那一层；"测试全绿"不代表"这个缺陷有人看着"。
28. **反向验证工具不要把「套件自己 abort」当成「读不到摘要」**。`_plugin-pages-inject.mjs`
    原本一见 `(aborted)` 就报"no summary"，于是"缺表"那个真实红（`18 passed, 5 failed`）
    被当成**坏了运行器**而不是**坏了守卫**。分开两个概念：`aborted` = **没有可解析的摘要**；
    `selfAborted` = 套件自己走进了 catch（摘要仍可读）。**没有摘要才算失败**，
    有摘要的 abort 就是一份真实证据。
29. **`_tenant-query-audit.mjs` 的裁决表键是 `file:line`**，任何上方编辑都会把一条
    已裁决语句挤成 `NEW`。改完 `src/api.ts` 之类的文件后跑一次，**报了 `NEW` 就重新键位**
    （本轮 `theme_installs` 那条从 `:1154` 移到 `:1187`）。`NEW` 是提示不是失败，
    但每条都要有人写一句为什么会话安全的裁决。
30. **注入工具用 `import().then(done)` 收尾 → 慢套件被读成 abort**（批次 11 新增的假绿形态）。
    `import()` 在模块体执行完就 resolve，**早于套件 `main()` 的第一个 `await`**；
    worker 线程由谁先结束谁说了算。esbuild 编译慢的套件（`features`）确定性输掉，
    症状是「注入后没有摘要」——**把一次真红读成运行器坏了**。修法：worker 入口
    **只由套件自己桩掉的 `process.exit` 收尾**，并用 `reported` 守卫保证只结算一次。
    已在 `_skeleton-inject` / `_launcher-inject` / `_plugin-pages-inject` 三处修掉。
31. **注入的缺陷让套件自己抛错时，红会被"崩溃"盖住**。开关场景把 settings key 改成
    `cfpress.features-typo` 后，断言 `rows[0].value` 在空数组上抛、逃出 `main()`、
    **摘要行根本没印** → 工具报 `no summary`（= abort）而不是「这条断言红了」。
    三层修法：① 断言先查 `rows.length` 再用带守卫的 `JSON.parse` 读元素；
    ② **每个 section 包 `section()`**，抛错记一条 FAIL 而不是中断整轮；
    ③ 夹具在**开头和结尾都前缀删**（`LIKE 'cfpress.features%'`）——中途崩溃不再留脏行。
32. **测试一条路由的权限，别用"匿名被拒"当判据**。`api.ts` 里 `requireAdmin` 是**全局闸门**，
    它下面每条路由都已过会话校验——所以"匿名请求被拒"**对任何一条路由都成立**，
    测不出这条路由自己的闸门。要验证 `settings.manage`，必须造一个**非管理员**用户
    （`features.test.mjs` 用 `/api/v1/users` 造了个 `author` 角色用户），
    否则 `can()` 会把 `role === "admin"` 短路成 true。这正是场景「drops its permission check」
    第一版**没变红**的原因。
33. **写入路径的判据必须是查询结果，不是入参形状**。`savePost` 对「带 id 的 PUT」曾只做
    UPDATE（SQLite 零行更新不报错）→ 孤儿翻译行 + 假成功 200；publish-only 的 PUT 又曾把
    URL 改名成 entityId（`tSlug || entityId` 兜底只在 CREATE 分支合法）。`deletePost` 曾
    不校验站点归属。三者同根：**先查行在不在、属不属于这个站，再写**。
34. **多套件顺序跑也可能偶发 1 红**（`menu-custom` / `plugin-pages` 各出现过 1 次，共享本地 D1）。
    症状：链内 1 条 FAIL、单独跑与链段重跑全绿、失败套件不碰你改的代码。先单独跑、
    再跑一次链段确认；**两次独立全绿才能写成基线**。别把偶发当成自己的改动引入的回归，
    也别不加验证就当成"环境问题"放过。
35. **`{{#each x}}` 不写 `as` 时绑定的是 `this`**——循环体内直接写 `{{字段}}` 得到空，
    200、零异常。必须 `{{#each x as item}}`。三处新主题模板同时踩过，探针/DOM 检查才现形。
36. **三条闸门都答 404 时，断言"404"等于没断言**（观测面层的又一例，批次 16）。
    `/media/<key>` 有租户 / 会话 / owner 三条独立闸门，全部返回 404。套件若只在三条全关时
    断言"取不到"，**删掉任何一条都不会变红**——另外两条还站着。修法两条：
    ① 决策函数返回**原因**（`site`/`session`/`owner`/`missing`）而不是布尔；
    ② 套件把闸门**逐条单独打开**（把其余策略放宽到只剩它），再断言那一刻的 404。
    `_media-inject.mjs` 7 个场景就是按这个形状逐条注入的。
37. **以 `env` 为键的"per-request" memo，实际生命周期是 isolate**（批次 16 抓到的真缺陷）。
    `platform/sites.ts` 的站点列表 memo 注释写着 per-request，但 `env` 在 Workers 里跨请求复用
    → 站点列表被冻结到 isolate 回收为止 → **新建站点在前台解析不到**（host 与 path 前缀都落到
    默认站），单站点安装完全看不出来。修法：入口每请求 `resetSiteListMemo(env)`。
    一般规律：**注释声称的作用域要和键的作用域一致**，否则缓存会替你记住不该记的东西。
38. **写测试时的两种假绿，本轮在自己的套件里各踩一次**（批次 16）。
    ① `setPolicy` 忘了带 `?site=` → 策略写到 `default` 站 → §4 那条断言红了（这次是好事，
    它暴露了问题），但 §10 三条断言**空转通过**，因为它们改的那行根本不存在；
    ② 修法是补 **non-vacuity 断言**（"策略确实落在这个站上" / "确实改动了 1 行"）。
    **写"某行被改坏后应当拒绝"的断言时，先断言那行真的存在且真的被改坏了。**
39. **`check(name, condition, detail)` 的 `condition` 传字面量，恒为真**（批次 16，第九种假绿）。
    `check("…", JSON.stringify(a), JSON.stringify(b))` 把**期望值与实际值当成了条件与详情**——
    读起来像在断言"两者相等"，实际断言的是"一个非空字符串为真"。架构套件**全绿**，
    是 `_skeleton-inject.mjs` 的场景报 `did NOT go red` 才发现的：
    **注入工具的价值不在于它跑得多，而在于它逼你把每条守卫看一次它的红。**
    修法两层：改掉那一条，并把元守卫从"禁集合当条件"扩到**"禁字面量当条件"**
    （字符串 / 模板串 / 数组 / 对象 / `true`）。
    ⚠️ 元守卫只扫 `architecture.test.mjs` 自己——**其它套件里同样的拼法只能靠注入工具抓**。
40. **契约漏掉一半时，症状是"控件渲染成一个空字段"**（批次 16）。
    `media-list` 的条目键原本由 `api.ts` 在出口处附加，契约本身不描述条目形状；
    于是**只用契约**（不经过 API）渲染控件时，画廊字段渲染成**没有任何输入框**的空字段。
    修法：把 `itemKeys` 声明在属性上（规则 61c）。
    **判据：一个控件如果需要调用方告诉它"你由什么组成"，那部分组成就还没被声明。**
    与 26 号坑（"声明了但没人读"）互为镜像：**这一族缺陷的两个方向都要有人看**。
41. **`check(name, condition, detail)` 的恒真断言在本仓库已出现三次，全在同一个文件**（批次 16）。
    ① 集合当条件（`check("…", offenders, [])`）；② `JSON.stringify(a)` 当条件；
    ③ **数组当条件、把期望值放进了 detail**（`check("…", controlOwners, ["…/media-picker.js"])`）。
    三次架构套件都**全绿**，三次都是 `_skeleton-inject` 报 `did NOT go red` 才发现的。
    **词法模式只能禁"想到的拼法"** —— 所以修法落在 `check()` 本身：
    **条件不是布尔就抛 `TypeError`**，把这一整类变成一声巨响；词法守卫（禁集合、禁字面量）
    保留为更早更友好的一层网。
    推论：**"我加了一条守卫"和"这条守卫能红"是两件事**，而只有注入工具能分辨它们。
    凡新增具名断言，必须先在注入工具里补一个场景——这不是纪律，是唯一可靠的检查。
42. **`await` 写进非 async 的委托函数**（批次 16）：`document.addEventListener("click", (e) => { … await … })`
    在**解析期**就是 `SyntaxError: Unexpected reserved word`，模块整体加载失败。
    症状不是"这个功能不生效"，而是**后台整个起不来**。
    抓它的是 `admin-spa.test.mjs` 的"入口能启动"那一条（真实 import 入口 + DOM 替身）——
    静态模块图检查看不见语法错误（它只解析 import 说明符）。
    **一条"真的 import 一次"的断言，价值高于十条文本扫描。**
43. **浏览器验收脚本不能用 `context.request` 调这个后台的 API**（批次 16）：
    会话 cookie 是 `Secure`，而 Playwright 的 `APIRequestContext` **不套用浏览器那条
    "localhost 可信"例外**，于是它一个 cookie 都不发，每个调用都是 401——
    而同一个 context 里的**页面**明明是已登录的。症状极具迷惑性：上传成功（页面发起）、
    随后用 `context.request` 查库却 401，看起来像"上传没落库"。
    **正解**：走页面自己的 `fetch`（`page.evaluate`），本目录既有的两个验收脚本就是这么做的。
    另一条同源陷阱：**先用 `context.request` 登录会把浏览器也登录掉**，登录屏因此永远不出现，
    `#u` 等到超时——登录必须由页面驱动。
44. **块编辑器不重渲染，所以"选完之后的样子"要自己刷新**（批次 16）。
    预览只在渲染时画一次 → 选完文件看不到缩略图，读起来像"没选上"。
    Node 断言"模板里有 `<img>`"永远是对的（它检查模板，不检查交互），**只有真浏览器能发现**。
    修法是控件里留一个可被就地刷新的槽（`[data-media-preview]`）。
    **推论：凡是"用户做了一个动作、界面应当立刻变化"的地方，都必须有真浏览器验收。**
50. **把查询串当成路径传给 `scoped()`**（批次 16 A4，浏览器验收当场抓到）。
    `scoped("media&page=1")` 产出 `media&page=1?site=default` —— **不匹配任何路由**，答案 404。
    媒体屏因此直接显示错误面板；**媒体选择器的搜索**同样 404，但那个 404 被吞成空列表，
    于是搜索框看起来像"没有结果"——**一个看起来像产品行为的网络错误**。
    两个调用点都犯过，而它们相隔两个批次。修法落在 `scoped()` 本身：**参数带 `&` 而不带 `?` 就直接抛错**。
    **判据：一个从症状完全认不出来的错误，值得三行检查。**
51. **`theme_table_defs.i18n_table` 可以比它的表活得久**（批次 16 A4，同上）。
    首次写入报 `no such table: theme_menusbrowser_menuitem_i18n`——
    **一个 schema 形状的错误，成因却是一条陈旧的行**。链条：
    ① 这个字段的粘性**是有意的**（`COALESCE` 保留旧名：禁用语言应当**隐藏**翻译，
    而不是重新启用时用主表值**重新播种**，那会覆盖已保留的翻译）；
    ② 但粘性 ⇒ 它可以比表活得久（**测试夹具 drop 生成的表却留下注册行**）；
    ③ 门面**只信任这个字段**，于是它去写一张不存在的表。
    修法：**同步要修复它自己写下的映射**——回读 `i18n_table`，非空就 `CREATE TABLE IF NOT EXISTS`。
    `_schema-scope.mjs` 把不变量钉住（含"侧表消失后重新同步"的模拟）。
    ⚠️ 这条**只有**把浏览器脚本夹具的 `translatable` 补对之后才会暴露——
    在此之前上传被校验器拒绝，那段代码**从来没有被执行到**。
    **推论：一个被守卫挡住而从未运行的代码路径，和一个坏掉的代码路径，从外面看是一样的。**
45. **`<option>` 不写显式 `value` 时，浏览器拿 option 的文本当值**（批次 16）。
    编辑器的状态下拉原本就是这样，于是"把标签翻译成中文"会**把 `草稿` 写进 `posts.status`**——
    一个**翻译**动作变成一次**数据损坏**。修法是显式 `value="${s}"`，并在真浏览器里同时断言
    "值仍是标识符"与"标签已是中文"。
    **一般规律：凡是同时碰"显示"与"数据"的改动（翻译、格式化、本地化），
    都要专门看一眼数据的出口是不是被顺手改了。**
46. **一条跑不起来的验收脚本，比没有验收脚本更误导**（批次 16 抓到 `_admin-menus-browser.cjs`）。
    它的夹具主题声明了散文字段 `name` 却**没写 `translatable`**；规则 41 落地后上传被校验器拒绝，
    于是第 5 节之后**全线失败**——而失败长得像"生成式表格屏幕坏了"，不像"夹具过期了"。
    这类脚本不在 `npm test` 里，没人跑就没人知道它坏了。
    **推论：改了扩展的声明能力（规则 41 这类）之后，要主动跑一遍手工验收脚本**；
    修好夹具后 31 条全绿。
47. **`browser.close()` 写在脚本中段**（批次 16 修 `_i18n-browser.cjs`）：
    任何**新加在其后**的章节都会对着已关闭的浏览器跑，报错却是
    `Target page, context or browser has been closed`，指向新章节里的辅助函数——
    读起来像"新代码有问题"，其实是"上面有个提前关闭"。
    **收尾动作放脚本末尾**，这样加章节永远不会踩到它。
48. **入口函数调用 `render()` 时没有 await，于是测试读到的是空容器**（批次 16 B4）。
    `newContent` / `editContent` 由点击处理器调用，那里没人在等渲染，所以它们 fire-and-forget。
    测试紧接着读 DOM 时拿到空字符串，而**症状看起来像"这个控件不存在"**——
    断言全在抱怨标记，没有一个在抱怨时序。修法：测试里让渲染链结算一次（`settle()`），
    并在注释里写明原因。**"元素不存在"和"还没渲染"是两种完全不同的诊断。**
49. **同一个文件里第 4 次写出恒真断言，被 `check()` 的布尔守卫当场抛错拦住**（批次 16 B4）。
    写规则 64 的第一条守卫时又把**数组**当成了条件。上一轮加的
    `if (typeof condition !== "boolean") throw` 立刻抛了 `TypeError`——
    **守卫抓到了写守卫的人**。这是把词法模式换成运行时类型检查的回报：
    模式只能禁"想到的拼法"，类型检查覆盖整类。
52. **主题卸不掉：先查 `settings` 里 `theme.active` 是哪个站点占着（批次 19）**。
    两条报错含义完全不同：`"X" ships with the product` = 捆绑主题（`default`/`journal`），
    **设计上就不可卸载**（文件在 Worker assets 里，下次 deploy 又回来）；
    `still active on: acct` = 有个站点把它设成了当前主题，**判据逐站点**、
    由 `SELECT site_id FROM settings WHERE key='theme.active' AND value=?` 得出
    （`theme_installs.active` 是全局重算标志，**不可信**）。卸载前必须先去那些站点换主题，
    或者删掉那些站点（`deleteSite` 会清 `theme.active`）。
    ⚠️ **本地 dev 库常年被套件污染**：实测残留 4 个测试站点（`acct`/`adm`/`shop`/`de`）
    + 4 个测试主题（`accttheme`/`admtheme`/`shoptheme`/`detheme`），每个都激活在自己站点上——
    所以"我没在用这个主题"经常只是**没在看那个站点**。
53. **测试不得改写运营者自己的设置（批次 19）**。共享 dev 库上出现两次同形状的副作用：
    ① `_i18n-browser.cjs` 为了断言英文，把界面语言强制成 `en` **并留在那里**；
    ② `i18n.test.mjs` 的幂等清理把非 `en` 的 `ui_lang` 置 `NULL`（为了确定性）。
    两者都让"跑过一次测试"= "我的后台变回英文了"。正解与套件处理
    `theme_routes`/`site_locales`/`theme.active` 同一纪律：**开头快照、结尾原样放回**。
    **判据：这不是套件的状态，是一个人的偏好。**

## 9. 权威文档索引

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | **唯一权威**：多语言 §2、主题 §3、插件 §4、防错 §5、表总览 §6、分层 §7、路线图与进度 §8、已确认决策 §9、假绿记录 |
| `docs/design/PLUGIN-ARCHITECTURE.md` | 插件系统三支柱设计全文（自有表 / 通知渠道 / 声明式后台页面）+ 八步交付顺序 |
| `docs/history/HANDOVER-PLUGIN-BATCH.md` | 批次 10 过程存档（步骤 1–6 细节、用户拍板决策、本轮新坑） |
| `AGENTS.md` | 改代码前的硬规则清单（红线、清单规则、后台 SPA 规则、共用定义规则、菜单注册表规则 32–37、**插件规则 48–51**、**功能开关规则 52–55**、**多语言与 URL 规则 56–59 + `npm run gate`**、**媒体隔离规则 60**、**块 attrs 契约规则 61**、**媒体控件规则 62**、**后台文案与词典规则 63**、**编辑器定时器与身份规则 64**、**主题表 i18n 侧表规则 65**、明确不做的事） |
| `docs/HANDOVER.md` | 本文 |
| `src/shared/features.ts` | **功能开关唯一词汇表 + 解析器**（`FEATURE_SWITCHES` / `featureEnabled()` / `featureSnapshot()`）——开关定义只此一处 |
| `public/admin/js/screens/features.js` | 功能开关后台屏（每开关一张卡：来源标注 / var 名 / 声明默认 / 继承值 / 重置为继承） |
| `tests/suites/features.test.mjs` | 功能开关 API 契约（两层鉴权 / 三层优先级 / 脏行降级 / 未知 key 400 / INSERT+UPDATE 分支 / 屏幕接线） |
| `tests/tools/_skeleton-inject.mjs` | 骨架 + 开关 + 数据驱动后台的反向验证工具（**23 场景**：schema/事件契约/断言拼法/开关/块面板/dashboard 卡/设置表单分支） |
| `tests/tools/_locale-url-inject.mjs` | 多语言与 URL 规则 56–59 的反向验证工具（4 场景） |
| `tests/suites/architecture.test.mjs` | 分层与越界守门人（分层红线 + 默认值 + 闭集合双表对比 + 规则 41 分类表 + **规则 52–55 开关守卫 + 规则 56–59 多语言守卫 + 块面板/dashboard/设置表单三节**） |
| `tests/suites/admin-menus.test.mjs` | 菜单注册表契约（归属隔离 / 安装级可见 / 停用只删自己 / 切主题切回） |
| `tests/suites/i18n.test.mjs` | 多语言四层契约（§5.4① 八条 + 翻译组 + 主题自有表 + 9b 段 `lang_group` 回归） |
| `tests/suites/locale-url.test.mjs` | 按语言 slug 的行为契约（两种存储形态的路由/404/唯一性/hreflang/按语言 feed/sitemap；规则 58 的行为面） |
| `src/platform/media-policy.ts` | **媒体访问策略的唯一定义**（规则 60）：`isolation` / `require_session`（站点设置行 `cfpress.media`）+ `mediaKeyBelongsToSite` + `mediaReadDecision`（**返回拒绝原因**）+ `mediaOwnerClause`——前台读取路径与后台 API 共用同一份 |
| `tests/suites/media.test.mjs` | 媒体两轴（租户 / 所有者）的契约：三闸门**逐条单独打开**再断言、删除顺序、legacy NULL 祖父条款、站点列表 memo 的 per-request 复位 |
| `tests/tools/_media-inject.mjs` | 上者的反向验证工具（7 场景，注入→具名断言变红→还原→哈希一致；手工跑，不在 gate 里） |
| `src/rendering/blocks.ts` | **块属性契约的唯一定义**（规则 61）：`CORE_BLOCKS`（每块的 `attrs[]`/`children`/`media-list` 的 `itemKeys`）+ `BLOCK_ATTR_TYPES` 闭集合——渲染器与编辑器控件都从它派生 |
| `public/admin/js/block-fields.js` | 块属性的**控件唯一映射**（`RENDERED_ATTR_TYPES` + `renderBlockAttr(s)`）+ **块树寻址与变更的纯函数**（无状态叶子，可脱离 DOM 测试） |
| `tests/suites/editor-blocks.test.mjs` | 块 attrs 的往返契约（契约 → 控件 → 写入的键 → 真实渲染器 markup + 嵌套寻址 + §8 反向对照） |
| `public/admin/js/media-picker.js` | **媒体控件的唯一定义**（规则 62）：`mediaUrl()`（唯一构造 `/media/<key>`）/ `mediaItem()` 归一化 / `mediaFieldHtml()`（唯一控件标记）/ `openMediaPicker()`（搜索 + 网格 + 上传 + 单选多选）——块属性、自定义字段、扩展设置三处共用 |
| `tests/suites/media-picker.test.mjs` | 上者的契约：URL 形状与读取路径一致 + 归一化 + 控件形态 + **"选择器给的 URL，真实渲染器画得出来"的闭环** + 三个消费点都走共享控件 |
| `tests/tools/_media-picker-browser.cjs` | 上者的**真浏览器**验收（25 条，自清理可重复）：登录 → 加图片块 → 对话框内上传 → 选中 → 落值 → **保存后确认写在 `url` 而非 `text`** → 会话/匿名两种读取 → 取消路径 |
| `tests/tools/_sites-screen-browser.cjs` | **站点屏的真浏览器**验收（批次 28，自清理可重复）：经 API 建一个带前缀的夹具站点（**故意走 API**，因为语言行种子正是本批次修的，手写行会把它藏起来）→ 断言计数**只发一次**请求、每行是真三元组、预览链接来自**该站点自己**的 prefix/host、主题徽标点进主题屏 → 删站点并确认已消失。**它是唯一照出「前缀挂载丢 query」的地方** |
| `docs/design/MEDIA-EDITOR-PLAN.md` | 批次 16 的四轨道拆分（**Track 0 / B1 / A3 已实现，A4 / B3 / B4 / B5 未实现**）——含已拍板的媒体语义与编辑器缺陷清单 |
| `docs/design/MULTISITE-USER-ISOLATION-TEST-PROGRESS.md` | **多站点隔离矩阵的测试进度账**：矩阵套件 `multisite-isolation-matrix`（57 断言 / 0 失败）逐条映射 `MS-x.y`；记录两个实测泄漏的修复（genericTable 漏 redirects/rewrites 站点过滤、revisions/autosave 只按 post_id 过滤）+ 反向验证记录；4 个 GitHub issue（#1 MS-3.2 决策、#2 extensions/versions 无权限门、#3 派生表缺行为断言、#4 genericTable 死条目） |
| `docs/design/MULTISITE-USER-ISOLATION-STORIES.md` | **多站点 × 用户归属 × 数据隔离的 user story 矩阵**（18 条，编号 `MS-x.y`，可直接被测试引用）：三轴（数据面 22+7 张表 / 入口面 6 档 / 主体面 4 种）× 三条约简原则；附录 A/B/C 是参数清单，附录 D 是 P0–P2 待办。**6 张站点级表 + 5 张派生表完全没有隔离断言**；MS-3.2 记录了一个**需要拍板的产品决策**（站点 admin 能否管本站点用户） |
| `tests/tools/_i18n-browser.cjs` | 多语言后台的真实浏览器验收（**29 条**，自清理，可重复跑）：语言开关 / 编辑器语言版本条 / **§7 编辑器界面语言**（切 zh-CN 断言中文标签、无英文残留、**option 值仍是标识符**） |
| `tests/tools/_admin-menus-browser.cjs` | 菜单 + 生成式屏幕的真实浏览器验收（31 条，自清理，可重复跑） |
| `tests/suites/admin-spa.test.mjs` | 后台 SPA 的结构守门人（模块图 + `window.*` 契约 + 逐屏渲染） |
| `tests/suites/account.test.mjs` | 账户自助与菜单偏好契约（当前密码闸门 / 稳定错误码 / prefs 隔离 / label_key 翻译端到端） |
| `tests/suites/plugin-pages.test.mjs` | 插件声明式后台页面契约（规则 49/50 + `form` 写入落真表 + `stats` 聚合 + 禁用清理 + **渲染器真渲染**） |
| `tests/tools/_plugin-pages-inject.mjs` | 上者的反向验证工具（10 场景，注入→具名断言变红→还原→哈希一致） |
| `tests/tools/_tenant-query-audit.mjs` | 租户查询审计（列出所有碰租户表但不带 `site_id` 的语句，逐条书面裁决；键是 `file:line`） |
| `.wrangler/eshop-verify.cjs` | 全链路真浏览器验收（语言状态自愈，需 `wrangler dev`） |
| `src/platform/seo.ts` | sitemap / robots / **feed（RSS 2.0，按站点+按语言）**——SEO 三端点都必须接收并使用 `siteId`（规则 59） |
| `src/shared/features.ts` 之外的第二词汇表：`src/rendering/blocks.ts` 的 `CORE_BLOCKS` | **可插入块类型的唯一定义**——编辑器面板经 `GET /api/v1/blocks` 下发，SPA 里出现块名字面量即架构红灯 |
| `docs/HANDOVER.md` | 本文 |
| `.workbuddy-ai/memory/` | 工作日志（按天）+ `MEMORY.md`（长期记忆）——本机文件，不入库 |
