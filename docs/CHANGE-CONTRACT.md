# 改动面契约（Definition of Done）

> 这份文档回答一个问题：**「这个改动做完了吗？」**
>
> 三份文档分工，别搞混：
>
> | 文档 | 回答 | 组织方式 |
> |---|---|---|
> | `AGENTS.md` | **不做会怎样变红** | 硬规则 + 跑什么命令 |
> | `docs/ARCHITECTURE.md` §10 | **每个面为什么存在** | 历史教训目录（规则 1–79） |
> | **本文** | **你正在做的事要覆盖哪些面** | 按「改动类型」组织 |
>
> §10 是**踩过的坑**，本文是**要做的清单**。坑会继续增加；清单的条目数
> 等于这个系统的维度数（20 个），维度不会因为你多学一个教训而变多。
> > 维度 18–20（前台/后台分离、后台前缀隐身、每站点角色）是批次 C–E 加的：
> > 它们**不是**新坑，而是三条一直存在、只是从前**没有第二个例子来暴露**的边界。
> > 维度数从 17 变 20 是因为系统长出了这三条边界，不是因为教训变多。

---

## 0. 三条铁律（先读这个）

**铁律 1 —— 任一**适用**维度未覆盖 = 没做完。**
不适用的维度要**写明为什么不适用**，不能默认跳过。一份改动说明里没有出现的维度，
默认等于「没想过」，而不是「不需要」。
> 本仓库历史上所有「丢三拉四」都是这一条的反面：改动者心里只有 1–2 个维度
> （"我加了个表" / "我加了个屏"），而系统有 20 个（批次 C–E 后）。

**铁律 2 —— 凡是「能存东西」的新东西，必须回答两个轴。**
租户（哪個站点：`site_id` / 派生 / 平台全局）与语言（逐语言 / 语言中立）。
`contract/schema.ts` 是唯一权威，**没分类 = `_schema-scope.mjs` 当场红**。
> 两个轴都不是从表名能猜出来的：`media_files` 看着全局其实是按站点；
> `locales` 看着按站点其实是平台全局（规则 43）。
> 批次 D 的 `member_sessions` 是第三个例子：它**看着**可以由 `member_id → members.site_id`
> 推出（派生租户），但 `deleteSite()` 的统一 purge 只认本地 `site_id` 列——
> **能推导 ≠ 够用**：只要那张表要进 purge 循环，`site_id` 就是承重的，不是冗余（规则 77 ⚠️）。

**铁律 2b —— 凡是「一个新身份面」的新东西，必须回答「另一套身份能不能用它」。**
系统里有两套身份（staff / member，规则 77）。加任何**门**（端点、cookie、会话表、解析器）
都要顺手回答：**另一套身份的凭据打过来会怎样**。答案必须是 401，且这个答案要**由构造给出**
（不同的表 + 不同的 cookie 名 + 不同的端点前缀），不是由一个"记得写"的检查把门——
"记得写"的检查在没人去试的时候照样绿（§12 的共同盲区）。

**铁律 3 —— 每个新守卫必须反向验证。**
注入一次违规，确认它真的变红，再撤回。**测不出失败的检查等于没有检查**
（§12 记录了十六种假绿，每一种都是"检查存在但从没红过"）。
**第 16 种补了一句新的问法**：注入之前先问"我的夹具是运行时真的会产出的东西吗"——
手写的 fixture 会让守卫检查一个**从未存在过的形状**，全绿而线上是空的。

**铁律 3b —— 守卫锚在「消费」上，不是「提及」上。**
一条断言要钉的是**代码读了哪个事实**，不是**文件里出现了哪个词**。规则 79 的两条守卫
第一版都是死的：锚在子串（`x.sites` 匹配到一处无关的读）或距离窗口
（`state.sites` 附近 400 字内出现 `data-switch-site`——而 `state.sites.find(...)` 自己就满足了）。
**修法**是锚在**绑定**上：`const siteOptions = state.sites.map(...)`、`otherSitesText(x.sites, here)`。
反向验证抓到的，不是评审抓到的——所以铁律 3 是这条的验证手段，不是可选项。

---

## 1. 二十个维度

「怎么验」一列写的是**命令**，不是建议。改动涉及的维度必须跑过；不涉及的要说明。

| # | 维度 | 判据（做对了长什么样） | 怎么验 | 规则 |
|---|---|---|---|---|
| 1 | **分层** | `shared ← platform ← rendering ← extensions ← index.ts`，只允许向右依赖；`shared/` 不 import 业务层；`platform`/`rendering` 不 import `extensions/`（要扩展就反转依赖、注入接口） | `architecture.test.mjs`（分层段） | 1–4 |
| 2 | **租户（站点隔离）** | 每张表在 `PLATFORM_SCHEMA` 有租户归属；每条触碰租户表的语句带 `site_id`（或已在 `REVIEWED` 里有书面裁决）；**站点删除后不留注册表残留** | `_schema-scope.mjs`、`_tenant-query-audit.mjs`、`multisite.test.mjs` | 43、44、46、47 |
| 3 | **语言：内容（L1）** | 每条内容行有 `lang_group`；每语言一行 `post_translations`；**每语言自己的 slug**；回退阶梯只有一份定义（`resolveContentLocale()`），调用点不写 `\|\| "en"` | `i18n.test.mjs`、`locale-url.test.mjs` | 5–7、10、71 |
| 4 | **语言：界面（L2）** | 每个用户可见串走 `t(key, fallback)`，key 带前缀（`core.` / `theme.{slug}.` / `plugin.{slug}.`）；**中英两套都在**；界面语言与内容语言不混用 | `i18n.test.mjs`、`admin-spa.test.mjs`、`_i18n-browser.cjs` | 8、9、63、67 |
| 5 | **语言：主题业务数据（L3）** | `tables[].language{strategy,translatable[]}` 显式声明；散文字段进 `translatable`、语言中立不进（`isProseFieldType()` 是唯一谓词）；`{table}_i18n` 只在站点服务 ≥2 语言时建、**永不 drop**；`theme_table_defs.i18n_table` 是门面唯一信任的字段 | `_schema-scope.mjs`、`theme-integration.test.mjs`、`_i18n-field-inject.mjs` | 12、12b、41、42、65 |
| 6 | **语言：菜单** | `menu_items.locale`：`''` = 全语言，指定语言只在该语言渲染（**故意不跨语言回退**）；菜单容器本身语言中立 | `menu-custom.test.mjs`、`theme-integration.test.mjs` | 73 |
| 7 | **语言：小工具** | `widget_instances.locale` 同上语义；每次读取带 `site_id` | `theme-integration.test.mjs`（§12 侧栏段） | 74 |
| 8 | **语言：URL / SEO** | 显式语言 URL 找不到返回 **404 不回退**；`alternates`/`hreflang` 指向各语言**自己的 slug**；per-locale feed 与 sitemap | `locale-url.test.mjs`、`theme-default.test.mjs` | 7、71 |
| 9 | **用户与权限** | 每个管理端点先过 `requireAdmin` + 能力检查；越权是 **403 不是 404**；每用户偏好（`ui_lang`/`menu_prefs`/autosave）带 `user_id`；**能力白名单** `CAPABILITIES` 是唯一权威 | `admin-contract.test.mjs`、`account.test.mjs` | 16、60 |
| 10 | **扩展契约（主题/插件）** | 清单每个声明**都被消费**（`routes[]`/`menuLocations[]`/`sidebars[]`/`tables[]`/`fields[]`/`blocks[]`/`adminMenus[]`/`adminPages[]`/`channels[]`/`settings[]`）；安装边界 `validateManifest` 拒绝非法（**失败必须抛**）；注册行 ≠ 安装（规则 69） | `manifest-validation.test.mjs`、`scaffold.test.mjs`、`theme-integration.test.mjs` | 13–17、42、66、69 |
| 11 | **hook 与事件** | `DECLARABLE_HOOKS` 是插件能声明的**全部**；`DOMAIN_EVENTS` 是**事实**（过去式）不是通道；事件名不得混进 hook 列表；payload 带版本兜底 | `architecture.test.mjs`（事件段）、`manifest-validation.test.mjs`、`plugin-hooks.test.mjs` | 45 |
| 12 | **渲染** | 模板引擎只解释不执行（禁 eval/动态 import 用户代码）；helper 调用形式固定；块属性集合只在 `rendering/blocks.ts` 的 `CORE_BLOCKS` 声明一次；`@include`/`@extends`/section 开闭配得上 | `template-engine.test.mjs`、`editor-blocks.test.mjs`、`theme-fixture.test.mjs`、`_skeleton-inject.mjs` | 61 |
| 13 | **缓存** | 改了内容/主题/设置必须 `bumpContentCache(env, siteId)`，否则前台继续吐旧 HTML（"改了没反应"的头号原因） | `theme-integration.test.mjs`、`multisite.test.mjs` | — |
| 14 | **后台 SPA** | 新屏在 `screens/index.js` 注册；markup 里调用的 handler 都登记进 `WINDOW_HANDLERS`（`window.*` 是外部契约）；从**服务端实际放置的层级**读字段；URL = 页面；**桩载荷必须非空** | `admin-spa.test.mjs`、`_admin-menus-browser.cjs` | 67、68 |
| 15 | **数据迁移** | 迁移**有序、只增不改**；SQLite 改不了 PK → 重建表（抄 0019/0020 套路）；遗留行**故意不回填**且读阶梯有唯一定义；新表同步进 `contract/schema.ts` | `_schema-scope.mjs`、`_apply-migrations.mjs` | 44、70 |
| 16 | **测试与文档** | 规则**三处同步**（`AGENTS.md` + `ARCHITECTURE.md` §10 + `architecture.test.mjs`）；新套件要进**四个注册表**（`package.json` test 链、`run-all.mjs`、`cfpress.sh`、`cfpress.ps1`）；文档里写的测试路径必须存在 | `architecture.test.mjs`（末节）、`launcher-parity.test.mjs` | 18–23 |
| 17 | **部署与启动器** | 配置**一份手写 + 一份生成**（真 id 绝不进 `wrangler.jsonc`）；主题随 assets 分发；**新增 manifest 声明后必须重新激活主题**（`ensureThemeCapabilities` 是"从零修复"不是"增量同步"）；改 `cfpress.ps1` 后 BOM 还在 | `launcher-parity.test.mjs`、`cfpress.sh doctor` | 52–55、66、69 |
| 18 | **前台 / 后台身份分离** | 两套身份从**存储到 cookie 完全分离**：`site_users`(install 级) vs `members`(按站点)、`admin_sessions` vs `member_sessions`、`cfpress_admin` vs `cfpress_member`、`{前缀}/api/v1/…` vs `/api/v1/front/…`；**没有东西可交换**（member cookie 打后台端点 401，反之亦然）；member 用户名按站点唯一 | `architecture.test.mjs`（规则 77 节）、`admin-contract.test.mjs` §17、`theme-default.test.mjs` §8b | 77 |
| 19 | **后台前缀隐身** | 整个后台（SPA + 资产 + API + 登录端点）挂在可配前缀（`admin.path`）之下；SPA **不硬编码前缀**（读注入的 `window.CFP_ADMIN_BASE`）；**旧地址一律 404 不重定向**（含旧资产）；cookie `cfpress_admin` 的 `Path=<前缀>`（前台响应不含它）；登录端点限流 | `admin-spa.test.mjs`（规则 75 节）、`architecture.test.mjs`（规则 75 节）、`admin-contract.test.mjs` §0b/§0c/§15b | 75 |
| 20 | **每站点角色** | 权限答案**带站点**：`can(env,user,perm,siteId)` 的 `siteId` 是**必填**（不是可选带默认）；查 `site_users_sites` **且带站点过滤**；**绝不回退 `site_users.role`**；行的缺席 = 拒绝；`superadmin` 首先短路且不可从站点屏授予；UI 问和 API **同一个**问题（读 `role_here` 不读安装级 `role`） | `architecture.test.mjs`（规则 78/79 节）、`admin-contract.test.mjs` §18、`admin-spa.test.mjs`（users 屏） | 78、79 |

---

## 2. 交织矩阵：碰了 X，就必须同时处理 Y

**这一节是本文最重要的部分。** 维度不是并列的格子，是**互相咬合**的：改一个东西
几乎总会牵动另外两三个，而牵动的那几个恰恰是「看不到、但线上会坏」的地方。

| 你改了… | 必须同时检查 | 为什么（不检查会怎样） |
|---|---|---|
| **加一张表 / 一个字段** | ① `contract/schema.ts` 分类（租户+语言）② 若是扩展表：`tables[].language{}` ③ 读它的每个查询带 `site_id` ④ 站点删除时清不清 ⑤ `_tenant-query-audit` 的裁决 | 不分类 → `_schema-scope` 红；不带 `site_id` → **多站点串台**（单站测不出来）；散文字段不标 `translatable` → 中文页显示英文分类名 |
| **加一条管理 API** | ① 权限（`requireAdmin` + capability）② `siteId` 从 `requestSiteId` 取而不是参数默认值 ③ 变更后 `bumpContentCache` ④ 返回的 payload 层级 = 屏幕读取的层级 ⑤ `admin-contract` 一条断言 | 少 ③ → "保存了但页面没变"；少 ④ → 屏幕读 `undefined` 静默空白 |
| **加一个后台屏 / 改屏** | ① 注册进 `SCREENS` ② 用到的 handler 登记 `WINDOW_HANDLERS` ③ 每个串走 `t()` 且中英齐 ④ URL 能表达（`pageToHash` 通用，无需特例）⑤ 桩载荷非空才能跑到行渲染 | 少 ② → 按钮点了没反应（无报错）；少 ③ → 半截英文界面；少 ⑤ → **少 import 一个标识符也能全绿到浏览器**（§12 #15） |
| **加一种语言** | ① `locales`（平台注册表）+ `site_locales`（本站点启用）② 界面词典两套 ③ 内容：每语言一行 + 自己的 slug ④ 菜单/小工具的 `locale` 语义 ⑤ feed/sitemap/hreflang ⑥ **不得在任何地方写 `if (locale === "en")` 或硬编码语言清单** | 少 ⑥ → 从 2 种语言扩到几十种时会静默坏（见 §3.5） |
| **改主题声明（`theme.json`）** | ① `validateManifest` 过 ② 声明**被消费**（不消费 = 声明面为空，规则 69）③ 已安装的站点**重新激活**才注册 ④ `theme-fixture`/`theme-default` 过 ⑤ 生成物 `public/themes/**` 同步（`sync-bundled-themes.mjs`） | 少 ③ → 线上 `/blog` 404（批次 23 真实事故）；少 ⑤ → 部署后主题文件不存在 |
| **改主题模板 / 部件（parts）** | ① 每个模板过**真实模板引擎**（有数据/无数据各一次）② `@include`/`@extends` 目标存在 ③ section 开闭配得上 ④ 模板里用到的 helper 在十个小写 helper 里 ⑤ 部件改动要检查**所有**引用它的模板 | 少 ① → 生成器/模板缺陷只有渲染一遍才现形（规则 4） |
| **加一个插件能力 / hook** | ① `CAPABILITIES` 白名单 ② `DECLARABLE_HOOKS` ③ 宿主**真的实现**了它（声明 ≠ 实现）④ `subscribes[]` 的事件名在 `DOMAIN_EVENTS` 里 ⑤ `manifest-validation` + `plugin-hooks` 各一条 | 少 ③ → 插件声明了能力但调不动；少 ④ → 事件名混进 hook 列表 |
| **加一个块类型 / 改块属性** | ① `CORE_BLOCKS` 是唯一声明 ② 三个消费点（块属性 / 自定义字段 / 扩展设置）共用媒体控件 ③ 渲染器与契约的集合**相等** ④ 编辑器与渲染器读**同一个**属性名 | 历史上六种块渲染成空（编辑器写 `attrs.text`、渲染器读别的） |
| **加迁移** | ① 迁移流有序、只增 ② 改 PK → 重建表（SQLite 限制）③ 新表进 `PLATFORM_SCHEMA` ④ 遗留行**不回填**、读阶梯有唯一定义 ⑤ 本地 + 线上都要 `migrations apply` | 少 ③ → `_schema-scope` 红；少 ④ → 老数据在新语言下消失 |
| **改启动器（`cfpress.sh`/`.ps1`）** | ① 两侧动作名/菜单号/套件表/退出码**完全对齐** ② `.ps1` 的 **UTF-8 BOM 还在** ③ 菜单提示走 stderr ④ 输入耗尽要退出 ⑤ 新套件进四张表 | `launcher-parity` 会红；BOM 掉了只有 PS 5.1 才看得出来（中文乱码） |
| **改 schema / 新增站点级表** | ① `PLATFORM_SCHEMA` ② `deleteSite` 是否该清它 ③ 若不该清，**写明理由**（内容按策略保留） | 不清 → 删除站点后 `GET admin-menus` 仍返回它的菜单（已知债） |
| **改内容保存路径** | ① `bumpContentCache` ② 每语言 slug ③ `meta` 按语言写（`resolveMetaByPost` 是唯一读阶梯）④ 修订/自动保存也带 locale | 少 ③ → 分类名不翻译；少 ② → 永久链接静默变成 post id |
| **改任何面向用户的东西** | ① 中英词典都补 ② 用 `t()` 不写字面量 ③ 跑 `_i18n-browser.cjs` | 缺键**是静默的**（`t()` 有英文兜底，界面其余部分已本地化） |
| **给系统加一个新身份面（新 cookie / 新会话表 / 新解析器）** | ① 与**另一套**身份结构性分开（不同表 + 不同 cookie 名 + 不同端点前缀，规则 77）② 用 A 身份打 B 的门 → **401** 的**行为断言**（不是"没人试过"）③ 两套解析器各读各的会话表（`currentMember` 不许出现 `admin_sessions`，反之亦然）④ 新表两轴分类 + `onSiteDelete` ⑤ cookie `Path` 与**用途一致**（后台前缀限定 / 前台 `/`）⑥ 登录端点限流 | 少 ① → 一个改读对方会话表的解析器**接受对方的 cookie**，红线测试只要没人去试就照样绿（规则 77b 是**承重的**）；少 ④ → 删站后留下解析不到任何东西的登录行 |
| **加 / 改后台入口（前缀、路由、资产、登录端点）** | ① SPA 不硬编码前缀（读注入的 base）② 后台 API 整套挂前缀下（不只登录门）③ **旧地址 404 不重定向**（含旧资产——只 404 页面等于留指路牌）④ `Path=<前缀>` 的 cookie ⑤ **重写 URL 必须带上 `u.search`**（否则经前缀进来的请求所有 query 参数全丢，且**没有一个请求报错**） | 少 ⑤ →「有些参数生效、有些不生效」铺满后台，`?site=` 掉了就是"当前站点"＝默认值（批次 28 真实事故）；少 ③ → 扫描器顺着旧资产路径找到新前缀 |
| **加 / 改权限判断（`can` / `requirePermission` / 能力）** | ① `siteId` 从调用点**必传**（不是可选带默认，规则 78a）② 查成员表**且带站点过滤** ③ **绝不回退 `site_users.role`**（回退 = "从站点移除"变成"仍然有访问"）④ 该权限属于平台级还是站点级（`PLATFORM_PERMISSIONS` 是显式清单）⑤ 后台门 `requireAdmin` 的角色集**派生**自 `SITE_ROLES` + `SUPERADMIN_ROLE` ⑥ **屏**读的字段和 API 问的**同一个**（`role_here` 不读安装级 `role`） | 少 ① → 某个调用点**悄悄**重问站点盲问题，而那个问题**仍然有答案**，缺陷因此能通过评审；少 ⑤ → 加新角色时静默把 owner 锁在门外（批次 E 真实踩过）；少 ⑥ → API 不再问的问题，屏还在答，**不报错** |
| **给权限答案加一个事实（改 `users` 屏 / 列表 payload）** | ① API 新增字段与**屏读取处逐字对齐**（读错永远是 `undefined` 且静默）② 屏**点名它所看的站点**（`state.site` 与端点 `site` 不一致时静默显示错站点）③ 空值要有**可见**的表示（空白格与渲染失败外观上无从区分）④ 守卫锚在**屏读了哪个事实**上，不锚在"某词出现过" | 少 ④ → 锚在子串/距离窗口的守卫**永远绿**（规则 79 两条守卫第一版都是死的，反向验证抓到的） |

---

## 3. 按「改动类型」的清单

### 3.1 新增一个内容类型（CPT，主题声明）

1. `theme.json` 加 `postTypes[]`，`fields[]` 里**散文字段标 `translatable`**、语言中立不标。
2. 若该类型有自有数据表 → 走 §3.2。
3. 前台：`templates/` 里给 `single-<cpt>.html` / `archive-<cpt>.html`（或声明 `routes[]`）。
4. 后台：类型自动出现在内容菜单；列表/表单由声明生成，**不得手写**。
5. 语言：每语言自己的 slug；`post_meta` 按语言写。
6. 站点：类型注册在 `post_types`（**按站点**）——A 站激活的主题不该给 B 站加类型。
7. 验：`manifest-validation` + `theme-integration` + `i18n` + `_schema-scope`；改了声明要**重新激活**。

### 3.2 新增一张主题/插件表

1. `tables[]` 声明 `name/label/fields[]` + **`language{strategy,translatable}`**。
2. `contract/schema.ts`：表是**生成表**（`theme_{owner}_{table}`），不需要登记；但**若你的迁移手写了平台表**，必须登记租户+语言归属。
3. 主表必有 `site_id`；`{table}_i18n` **没有** `site_id`（键是 `row_id`+`locale`）——对它的任何删除必须**先在主表验站点归属**（规则 12b，用 `tableDelete` / `tableDeleteTranslation` 两个函数表达两件事）。
4. 站点删除：生成表**不 drop**（它属于平台、装着所有站点的行）；行按站点不可达即可。
5. 验：`_schema-scope`（声明 vs 真实列）、`theme-integration`（CRUD + 语言）、`_i18n-field-inject`。

### 3.3 新增一个后台屏

1. `public/admin/js/screens/<name>.js`，在 `screens/index.js` 注册。
2. 每个串 `t("core.<area>.<key>", "English fallback")`，**中英词典都补**（`core-pack.ts` 两处）。
3. handler 若被内联 `onclick` 调用 → 登记 `WINDOW_HANDLERS`（`admin.js`）。
4. 数据从服务端**实际层级**读（`d.items` 还是 `d.active_by_site` —— 读错永远是 `undefined`，且静默）。
5. 分页/过滤走 `scoped(...)`（带 `?site=`）。
6. URL：`pageToHash` 是通用映射，新屏名自动可用，**不要**写特例。
7. 验：`admin-spa.test.mjs`（会真渲染你的屏，桩载荷是**一行真记录**）+ 真实浏览器 `_i18n-browser.cjs` / `_admin-menus-browser.cjs`。

### 3.4 新增一条管理 API

1. `requireAdmin` + **能力检查**（`CAPABILITIES` 里的名字），越权 403。
2. `siteId` 从 `requestSiteId(url)` 取；**不得**给参数默认值、不得 `?? "default"`。
3. 任何写操作之后 `bumpContentCache(env, siteId)`。
4. 返回 `{items:[...]}` 或 `{ok:true}`，字段名与屏幕读取处一致。
5. 验：`admin-contract.test.mjs` 一条具名断言（含跨站点隔离）；新语句看 `_tenant-query-audit.mjs` 是否报 `NEW`，报了要**写一条书面裁决**。

### 3.5 新增一种语言（或为「几十种语言」做准备）

1. **平台注册表** `locales`（全局）+ **站点启用** `site_locales`（本站点）——两者不是一回事。
2. 界面词典：`core-pack.ts` 加一套；`i18n.test.mjs` 会检查 key 前缀与两套齐全。
3. 内容：每语言一行 `post_translations` + **各自的 slug**（共享同一个 `lang_group`）。
4. 菜单：`menu_items.locale`（`''` = 全语言）；小工具同理。
5. **不得引入任何"语言数量 = 2"的假设**：
   - ❌ `if (locale === "en")` / `locale === "zh-CN"` 这类分支
   - ❌ 把语言清单写死在数组里（唯一权威是 `locale-registry.ts`）
   - ❌ 用 `ORDER BY` 的第一个语言当默认（字典序巧合，规则 73 的同款陷阱）
   - ❌ 用 `MIN(locale)` / `items[0]` 代表"站点默认语言"——**站点默认语言只从 `site_locales.is_default` 读**
   - ✅ 语言字面量只允许出现在 i18n 层，且要有理由（`_locale-literal` 守卫会拦）
6. 验：`i18n.test.mjs`、`locale-url.test.mjs`、`node tests/tools/_locale-literal.mjs`。

### 3.6 新增一个插件能力 / hook

1. `CAPABILITIES` 加名字（白名单是唯一权威，不得在插件里自定义字符串）。
2. `DECLARABLE_HOOKS` 加 hook（若确实是"宿主提供实现"的那种）。
3. **宿主真的实现它**——声明 ≠ 实现（规则 69 的同款病：注册行不等于安装）。
4. 事件（"已经发生的事实"）放 `DOMAIN_EVENTS`，**不得**混进 hook 列表。
5. 验：`manifest-validation`、`plugin-hooks`、`architecture.test.mjs`（事件完整性/唯一性/payload 版本）。

### 3.7 改主题模板 / 部件

1. 模板只解释不执行：不用 eval、不动态 import 用户代码、不网络请求。
2. 每个 `@include`/`@extends` 目标存在；section 开闭配得上。
3. 用到的 helper 必须在十个之内（`len default lower upper truncate join number date contains`）。
4. 部件（`parts/`）改动要检查**所有**引用它的模板。
5. 改了 `content/themes/**` 要跑 `sync-bundled-themes.mjs`（`predeploy` 已挂），否则部署的是旧文件。
6. 验：`template-engine.test.mjs`、`theme-fixture.test.mjs`、`theme-default.test.mjs`、`_skeleton-inject.mjs`。

### 3.8 改 schema / 加迁移

1. 迁移**只增**、有序；改 PK 只能重建表（SQLite 限制）——抄 `0019_post_meta_locale.sql` / `0020_widget_site.sql`。
2. 新表进 `PLATFORM_SCHEMA`（租户 + 语言 + **理由**）。
3. 遗留行**故意不回填**，读阶梯只许一处定义（`resolveMetaByPost` 是范式）。
4. 本地 + 线上都要 `migrations apply`；`DROP` 时 **`_cf_KV` 内部表绝不能动**。
5. 验：`_schema-scope.mjs`（跑真实迁移流 + 真实 `syncThemeTables()`）、`_tenant-query-audit.mjs`。

### 3.9 改启动器 / 部署

1. `cfpress.sh` 与 `cfpress.ps1` 是**一个契约**：动作名、菜单号、套件表、退出码完全对齐。
2. 新套件进**四张表**：`package.json` test 链、`tests/run-all.mjs`、`cfpress.sh`、`cfpress.ps1`。
3. `.ps1` 的 BOM 必须还在（`head -c 3 scripts/cfpress.ps1 | xxd` → `efbbbf`）。
4. 真 id 只进 `wrangler.ids.json`（gitignore），`wrangler.jsonc` 只放占位符。
5. 验：`launcher-parity.test.mjs`、`node tests/tools/_launcher-inject.mjs`、`./cfpress.sh doctor`。

### 3.10 新增一个身份面（新 cookie / 新会话表 / 新登录端点）

1. **先决定它属于哪一套**（staff 后台 / member 前台）——系统里**只有这两套**，不要造第三套。
2. 存储到 cookie **四件套与另一套不同名**：身份表、会话表、cookie 名、端点前缀（规则 77a）。
3. 两个解析器**各读各的会话表**：`currentMember` 不许出现 `FROM admin_sessions`，
   `currentUser` 不许出现 `FROM member_sessions`；前台路由体不许出现 `requirePermission`/`currentUser`。
   这是**承重**断言：一个改读对方会话表的解析器会**接受对方的 cookie**，而红线测试只要没人去试就照样绿。
4. 新表进 `PLATFORM_SCHEMA`（两轴 + `onSiteDelete`）——**要能进 `deleteSite()` 的 purge 循环就必须有本地
   `site_id`**（能推导 ≠ 够用，规则 77 ⚠️）。
5. 用户名若按站点唯一：`UNIQUE INDEX (site_id, username)`（全局 `UNIQUE` 会让一个站的注册挡住另一个站）。
6. cookie 的 `Path` 与用途一致：后台前缀限定（前台请求不该带上它）、前台 `/`（访客每个请求都要带）。
7. **登录端点限流**（隐藏与否都要有）；注册可关。
8. 验：`architecture.test.mjs`（规则 77 节）、`admin-contract.test.mjs` §17（含两条方向的 401 红线）、
   `theme-default.test.mjs`（若动了主题 scope）+ 注入场景。

### 3.11 新增 / 改一条权限判断

1. **`siteId` 从调用点必传**——不是可选带默认。可选会让调用点**悄悄**重问站点盲问题，
   而那个问题**仍然有答案**（它读到某人的一行），缺陷因此能通过评审（规则 78a）。
2. 该权限**属于哪一级**：`PLATFORM_PERMISSIONS = {platform.manage, users.manage, extensions.manage}`
   （install 级，只有 `superadmin`）？还是按站点？**没想清楚就在 `can()` 里答一个站点无关的答案。**
3. 查 `site_users_sites` **且带站点过滤**（`WHERE user_id = ? AND site_id = ?`）——
   只留表、丢掉站点的查询形态合法、返回一行、**只是错的那行**。
4. **绝不回退 `site_users.role`**（回退 = "从站点移除"变成"仍然有访问"）。
5. `superadmin` 是唯一有意例外，且**首先**短路（它是"尚不存在的站点"的答案）。
6. 后台门 `requireAdmin` 的角色集**派生**自 `SITE_ROLES` + `SUPERADMIN_ROLE`（写死会漏新角色）。
7. `superadmin` **不在** `SITE_ROLES` 里，站点屏不能授予 install 级角色。
8. **后台 UI 问和 API 同一个问题**：屏读端点回的**按站点事实**（`role_here` / `sites`），
   不读安装级 `role`；屏点名它所看的站点；站点切换器（列表）建自**服务端已按成员过滤**的
   `GET sites`，不是硬编码列表（规则 79）。
9. 验：`architecture.test.mjs`（规则 78/79 节）+ `admin-contract.test.mjs` §18 + `admin-spa.test.mjs`
   （若动了屏）+ 注入场景（回退全局 role / 丢站点过滤 / `siteId` 变可选 / 屏印安装级 role / 切换器硬编码）。

### 3.12 加 / 改后台入口（前缀、路由、资产、登录端点）

1. 后台前缀可配（平台级 `admin.path`）；SPA **不硬编码前缀**，读服务端注入的 `window.CFP_ADMIN_BASE`。
2. 后台 API **整套**挂前缀之下（不只登录门）；`index.ts` 剥前缀交给 `handleApi`。
   ⚠️ **重写 URL 必须带上 `u.search`**：只从 `u.origin` 重建会丢掉**所有查询参数**
   （`?site=`/`?withCounts=1`/`?locale=`/分页），而 `/api/*` 那条拿原始 request 照常工作——
   「有些参数生效、有些不生效」铺满后台，**没有一个请求报错**。
3. **旧地址一律 404**，不重定向（重定向把新前缀交给扫描器）：旧页面、旧**资产**、旧登录端点都要 404。
4. 会话 cookie `Path=<前缀>`；**前台响应不含 `Set-Cookie: cfpress_admin`**。
5. 验：`admin-spa.test.mjs`（规则 75 节）、`architecture.test.mjs`（规则 75 节，含"前缀挂载带 `u.search`"）、
   `admin-contract.test.mjs` §0b/§0c/§15b、真实浏览器验收（默认前缀 + 移到 `/manage` 两种情形）+ 注入场景。

---

## 4. 端到端走查示例：新增「活动报名」

假设要给主题加一个内容类型 `event`（活动），带自有表 `registration`（报名）。

| 步骤 | 动作 | 维度 | 不做的后果 |
|---|---|---|---|
| 1 | `theme.json` 加 `postTypes[{name:"event"}]`、`fields[{key:"place",type:"text"}]`、`tables[{name:"registration",language:{strategy:"sidecar",translatable:["note"]}}]` | 10、5 | 声明面为空：类型建不出来，或表建出来但没有语言能力 |
| 2 | `place` 是散文 → 自动进 `translatable`；`seats` 是 `number` → 不进 | 5、41 | 中文活动页显示英文地点；或数字被翻译成字符串 |
| 3 | 迁移里若手写平台表 → 进 `PLATFORM_SCHEMA`；否则不用（生成表） | 2、15 | `_schema-scope` 红 |
| 4 | 前台：`templates/single-event.html` + `routes[]` 声明 `/events` 归档 | 12、8 | 活动没有可达 URL |
| 5 | 后台：类型自动出现在内容菜单；报名列表由声明生成 | 10、14 | 手写表单 → 违反规则 15 |
| 6 | 报名 CRUD API：`requireAdmin` + capability、`requestSiteId`、写后 `bumpContentCache` | 9、2、13 | 跨站串台 / 保存了页面不变 |
| 7 | 报名数据：主表带 `site_id`；`registration_i18n` 无 `site_id`，删除前先验主表站点 | 2、5、12b | 跨站误删（`WHERE row_id=?` 会删别的站） |
| 8 | 多语言：活动标题每语言一行 + 各自 slug；报名备注走 sidecar | 3、5 | 语言切换器指向错 URL |
| 9 | 站点：A 站激活主题才有 `event` 类型；B 站没有 | 2、10 | 类型泄漏到别的站 |
| 10 | 卸载主题：生成的表**不 drop**（行留着），`theme_table_defs` 清掉 | 10、15 | 重新装回来数据还在（这是设计） |
| 11 | 删除站点：`event` 行不可达即可；**注册表行要清** | 2 | 删除站点后 `admin-menus` 仍返回它的菜单 |
| 12 | 界面串：报名屏每个串 `t()` + 中英 | 4 | 半截英文界面 |
| 13 | 测试：`manifest-validation`（清单过）、`theme-integration`（CRUD+语言+跨站）、`admin-contract`（API+隔离）、`i18n`（若动了字段分类） | 16 | 没断言 = 没做 |
| 14 | 文档：若新增了"以后每次都要做"的东西，写进本文 + `AGENTS.md` + `architecture.test.mjs`（三处同步） | 16 | 下一个人还会漏 |
| 15 | 部署：`migrations apply --remote` → `deploy` → **重新激活主题**（新声明才注册） | 17 | 线上 `/events` 404（批次 23 真实事故） |

---

## 5. 「丢三拉四」长什么样（本仓库真实案例）

| 症状 | 缺的维度 | 真实案例 |
|---|---|---|
| 主题"装好了"、页面全渲染、但**字段一个都没有** | 10（声明被消费） | 规则 66/69：`seedBundledExtensions` 只写注册行、从不 `applyThemeCapabilities`；线上 12 次 200、`post_meta` 零行 |
| 线上 `/blog` 404，本地正常 | 17（重新激活） | 批次 23：`ensureThemeCapabilities` 是"从零修复"不是"增量同步"，新声明要重新激活 |
| 后台主题列表一堆**幽灵主题** | 16（测试卫生） | 套件只在开头清理 → 残留永久化；后来加了 `_residue-guard.mjs` |
| 菜单页 `attr is not defined`，测试全绿 | 14（桩载荷） | §12 #15：空载荷让行渲染代码从不执行 |
| 别的站点的侧栏出现在本站 | 2、7 | `widget_instances` 没有 `site_id`（迁移 0020 修的） |
| 后台菜单串成别的站点的 | 2、12b | `WHERE menu_id=?` 而 `menu_id` 只在本站点唯一（批次 16） |
| 中文站读写到英文行 | 3 | 六处各自写 `\|\| "en"`，同一个问题两种答案（规则 6） |
| 分类名不翻译 | 3、5 | `post_meta` 没有 locale（迁移 0019 修的，规则 70） |
| 保存了但页面没变 | 13 | 少了 `bumpContentCache` |
| 按钮点了没反应，无报错 | 14 | 内联 `onclick` 的 handler 没登记进 `window` |
| **owner 被锁在每一个后台端点之外** | 20 | 迁移 0023 把唯一管理员提升为 `superadmin`，而 `requireAdmin` 的角色集**写死**成 `["admin","editor","author"]`（不含 `superadmin`）——已修：派生自 `SITE_ROLES` + `SUPERADMIN_ROLE`（规则 78a） |
| **A 站 editor 能管 B 站** | 20 | 旧 `can(env,user,permission)` 读一列 `site_users.role`，"此人能否**在此**发布"从来没被问过——地基换成 `site_users_sites`（迁移 0023，规则 78） |
| **屏说某人是 "author"，但他其实是本站 admin** | 20 | `users` 屏印 `x.role`（安装级身份列）当站点角色；E1 之后 API 已不再问那个问题，**屏不报错、只是答错**（规则 79，批次 E2 真实缺陷） |
| **经前缀进来的请求 `?site=` 全丢** | 19 | 批次 C：重写 URL 只从 `u.origin` 重建，没带 `u.search`——`/api/*` 那条照常工作，于是"有些参数生效、有些不生效"铺满后台且**没有一个请求报错**（规则 75b） |
| **删站点后 admin 里仍列着它的菜单** | 19（前身是 2） | 原 `deleteSite` 只删 `sites` 行与 `theme.active`；后改为**声明式** `onSiteDelete`（规则 46），每张站点级表必须表态 |
| **一次备份"成功"但没保住东西** | 18（测试卫生） | §12 #5：备份/清理**必须验证**（字节数一致）——`dev-hosts` 与 `_residue-guard` 沿用这条 |

---

## 6. 现状：哪些是机器强制、哪些还靠人肉

**这份表本身就是要维护的东西。** 一个维度从「人肉」变成「机器」，就是一次真正的加固。

| 维度 | 机器强制？ | 在哪 |
|---|---|---|
| 1 分层 | ✅ | `architecture.test.mjs` |
| 2 租户（声明） | ✅ | `_schema-scope.mjs` |
| 2 租户（查询） | ⚠️ 报告 + 书面裁决 | `_tenant-query-audit.mjs`（`--strict` 可作门，默认报告） |
| 2 租户（站点删除） | ✅ 已修（原为已知债） | 每张站点级表在 `contract/schema.ts` 声明 `onSiteDelete: purge/retain`，`PURGE_ON_SITE_DELETE` 派生、`deleteSite` 走它；`architecture.test.mjs` 强制"每张站点级表都声明策略"+ non-vacuity，`multisite.test.mjs` 断言删站后注册表行真的没了 |
| 3 内容语言 | ✅ | `i18n.test.mjs` |
| 4 界面语言 | ⚠️ 部分（缺键静默） | `i18n.test.mjs` + `admin-spa.test.mjs` |
| 5 主题数据语言 | ✅ | `_schema-scope` + `_i18n-field-inject` |
| 6/7 菜单/小工具语言 | ✅ | `theme-integration.test.mjs` |
| 8 URL/SEO | ✅ | `locale-url.test.mjs` |
| 9 权限 | ⚠️ 部分 | `admin-contract.test.mjs` |
| 10 扩展契约 | ✅ 部分（声明被消费） | `manifest-validation` + `theme-integration` |
| 11 hook/事件 | ✅ | `architecture.test.mjs` |
| 12 渲染 | ✅ | `template-engine` + `editor-blocks` |
| 13 缓存 | ⚠️ 靠断言 | `theme-integration.test.mjs` |
| 14 后台 SPA | ✅ | `admin-spa.test.mjs` |
| 15 迁移 | ✅ | `_schema-scope.mjs` |
| 16 测试与文档 | ✅ | `architecture.test.mjs` 末节 + `launcher-parity` |
| 17 部署 | ⚠️ 靠纪律 | `doctor` + 部署清单 |
| 18 前台/后台身份分离 | ✅ | `architecture.test.mjs`（规则 77 节，17 条）+ `admin-contract.test.mjs` §17（两条方向的 401 红线）；注入 4 场景。**结构性**：两个 cookie 名不同、两个解析器各读各的会话表 |
| 19 后台前缀隐身 | ✅ | `admin-spa.test.mjs`（规则 75 节）+ `architecture.test.mjs`（规则 75 节，含"前缀挂载带 `u.search`"）+ `admin-contract.test.mjs` §0b/§0c/§15b；注入 4 场景 |
| 20 每站点角色 | ✅（服务端 + UI 两侧） | `architecture.test.mjs` 规则 78 节（15 条，`siteId` 必填 + 31 个调用点 + 无回退 + 角色集派生）+ 规则 79 节（8 条，屏读 `role_here` 不读安装级 `role` + 切换器建自 `state.sites` + `superadmin` 不可授予）；行为 `admin-contract` §18（31 条）+ `admin-spa`（users 屏 8 条）；注入 10 场景 |
| **语言数量无上限** | ✅ | `tests/tools/_locale-literal.mjs`：拦「把行为钉在某个语言上」（`locale === "xx"`、`/^xx/i.test(locale)`、写死的语言清单）与 i18n 层之外的语言字面量；每条白名单都要写理由。已知缺口：`frontend.ts` 的阅读时长标签仍是「zh 或非 zh」二分，待改成走语言包（见白名单里的 ⚠️） |

---

## 7. 当你发现一个"以后每次都要做"的东西

不要只写在这里。按这个顺序做，否则它会在下一次改动里消失：

1. **写进本文**（§1 加维度 / §2 加交织行 / §3 加清单项）——说明**判据**。
2. **写进 `AGENTS.md`** 的「改动面清单」——说明**不做会怎样**。
3. **尽量变成机器判据**：能在测试里断言的，别留在文档里。
4. **反向验证**它（铁律 3）——注入一次违规，确认它**真的变红**；红得不对也算没红（§12 #10）。
   锚要锚在**消费**上，不是**提及**上（铁律 3b）。
5. 若它推翻/细化了某条既有规则，**三处同步**：`AGENTS.md` + `ARCHITECTURE.md` §10 + `architecture.test.mjs`。
6. **给维度一个「什么时候适用」的判据**：新维度最难的不是写下来，而是让人知道**它在这一轮适不适用**。
   写清"改了 X 就必须看它"，否则下一个人会在一条不适用的维度上写"已覆盖"，而真正适用的那条被跳过。

---

## 8. 三条边界的由来（维度 18–20 为什么是「一直在、后来才被暴露」）

维度 1–17 是**加功能**时踩出来的坑。18–20 不同：它们是**系统增长出第二条实例**之后
才从"看不见"变成"必须回答"的**边界**。记在这里，是因为它们的失效方式与前面十七条不一样：

| 边界 | 为什么从前看不见 | 什么把它暴露出来 |
|---|---|---|
| 18 前台/后台分离 | 只有**一套**身份时，"两个身份会不会串"这个问题不存在；系统里唯一的 cookie 服务所有用途 | 批次 D 加**前台会员**：一个读 `admin_sessions` 的 `currentMember` 会**接受后台 cookie**，而没人去试的话红线测试照样绿 |
| 19 后台前缀隐身 | 后台路径硬编码 `/admin` 时，"能不能挪"不是问题；只有**一个**入口时"旧地址"不存在 | 批次 C 让前缀**可配**：从那一刻起，旧地址的存在、SPA 里的裸绝对路径、`Path=/` 的 cookie 都成了可被扫描的**指路牌** |
| 20 每站点角色 | 单站点安装里，"这个人能否在此发布"与"这个人能否发布"**是同一个问题**——单站点安装正是所有人手工测的那个配置 | 批次 E 加**第二个站点**：一列 `site_users.role` 对多站点安装给出"一个答案回答 N 个问题"，而 A 站 editor 管 B 站在单站测试里**永远测不出来** |

> **共同规律**：这三条边界在"只有一个实例"时全部**隐身**。加第二个身份 / 第二个入口 /
> 第二个租户，是让它们从"不存在"变成"必须回答"的那一步。所以**加第二实例时最该做的
> 不是写代码，是先问"哪些从前只有一个的东西，现在有了两个"**——这正是维度 18–20 全部的内容。
