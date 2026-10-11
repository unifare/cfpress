# 多站点隔离 / 用户隔离 / 后台隐身 / 设置分两级 —— 实施方案（批次 A–F）

> 状态：**批次 A（hosts/域名绑定）、B（设置分两级）、C（后台隐身）、D（前台会员）与 E1（staff 按站点：权限接线）已完成**；E2（站点-角色 UI）、F（契约收尾）待做。
> A：三个域名经 dev server 各自命中 default / shop-demo / de-demo，hosts 改动在标记块内、已自动备份。
> B：`platform_settings` + `SETTING_DEFS` + 唯一读取阶梯 + 设置屏两栏 + `platform.manage`。
> C：`admin.path` 可配（平台级）；整个后台（SPA + 资产 + API + 登录端点）挂前缀之下、旧地址
> 一律 404（含旧资产与旧登录门）；cookie 改名 `cfpress_admin` 且 `Path=<前缀>`；SPA 全面改读
> 服务端注入的 `window.CFP_ADMIN_BASE`；登录 per-isolate 限流（5 次 / 60s → 429）。
> **规则 75**，三处同步；`architecture` 154 / `admin-contract` 105 / `admin-spa` 79 全绿；
> 真浏览器验收（默认前缀与移到 `/manage` 两种情形）各 5/5。
> 其余批次待做：D 前台会员 → E staff 按站点 → F 收尾。
> 原则沿用本仓库既有纪律：每批独立可交付、独立验证、**改完必须 commit**；
> 新增守卫必须反向验证；规则三处同步；新表必须过 `contract/schema.ts` 两轴分类。

---

## 0. 现状体检（实测结论，先量化再说"缺什么"）

| 项 | 现状 | 结论 |
|---|---|---|
| 站点解析 | `resolveSite()`：最长 `path_prefix` → `host` → 默认站点。**host 匹配已经可用** | 只差"把测试域名绑上" |
| 后台入口 | `index.ts` **硬编码** `/admin` 与 `/admin/*`，直接 `env.ASSETS.fetch()` | 前缀不可配、可被扫描 |
| 后台资产 | `index.html` 三处绝对路径 `/admin/admin.js` / `/admin/admin.css` / `/admin/favicon.svg` | 改前缀必须连资产一起改 |
| 后台 API | `state.js` 硬编码 `fetch("/api/v1/" + path)`；`/api/v1/auth/login` **公开且可被发现** | 后台 API 与前台 API 同一前缀 |
| 用户 | `site_users`（**install 级**身份），角色 `admin/author/editor` | 没有前台用户；后台用户不区分站点 |
| 会话 | `admin_sessions` + cookie `cfpress_session`（`Path=/`，HttpOnly，SameSite=Lax，Secure） | 一枚 cookie 服务所有用途；`Path=/` 意味着前台请求也会带上它 |
| 权限 | `can()`：`role === "admin"` 直接 `true`；否则查 `role_permissions`（**install 级**，无站点维度） | **A 站的 admin 天然能管 B 站** —— 这是"用户隔离"最大的洞 |
| 前台用户 | **完全没有**：无 member 表、无前台会话、无登录/注册、主题无登录部件 | 需要从零建，但因此可以一开始就做对 |
| 防爆破 | **没有任何限流/锁定**（全库无 rate limit / attempt / lockout） | 登录端点可被无限尝试 |
| 设置 | `settings` **只有站点级**（`UNIQUE(site_id,key)`）；**没有 facade**，读写内联在 `src/api.ts` 十几处；`plugin/runtime.ts:19` 的注释记录过一次同款事故（"`UPDATE settings … WHERE key=?` 会重写**每个**站点"）。现有键全部是站点级：`site.title` / `site.description` / `seo.*` / `theme.active` / `cfpress.features` / `i18n.defaultLocale` / `admin.menu.custom` | **没有平台级设置**，`admin.path` 无处安放；也没有"键属于哪一层"的声明 |
| 域名 | `sites.host` 已有列；本地没有任何测试域名绑定 | 需要改 hosts（系统级操作） |

---

## 1. 设计决定（需要你拍板的 5 点）

| # | 决定 | 我的建议 | 理由 |
|---|---|---|---|
| D1 | 后台前缀存哪 | **新表 `platform_settings`**（install 级），`admin.path` 是它的第一个键 | `settings` 是站点级且 `UNIQUE(site_id,key)`——用 `site_id='*'` 是给一张**声明为站点级**的表开后门，`_schema-scope` 的两轴模型会跟着变脏。平台级就该有自己的表（§2.5） |
| D2 | staff 用户模型 | **install 级身份 + 按站点角色**（WordPress multisite 式）：身份在 `site_users`，新增 `site_users_sites(user_id, site_id, role)` | 一个人一个账号即可管理多个站点；隔离的是**能力**而不是身份。彻底每站点一套用户会让 staff 在每个站重复注册，且丢失"同一个作者跨站写作" |
| D3 | 前台会员模型 | **天然按站点**：`members(site_id, …)`，A 站注册的账号在 B 站不存在 | 前台用户的隔离就应该是数据级的，不是角色级的 |
| D4 | 旧后台路径的行为 | **404**，不是 301/302 | 重定向会把新路径泄露给扫描器 |
| D5 | 测试域名后缀 | **`.test`**（RFC 6761 保留给测试，永不解析到公网） | `.local` 会被 mDNS 抢答，Linux/macOS 上行为不一致 |

其余默认值（可改）：三个测试站点与域名 —— `cfpress.test`（default）、`shop.cfpress.test`（shop）、`de.cfpress.test`（de）。

---

## 1b. 设置分两级（这是 D1 的地基，单独成批）

**现状的问题**：`settings` 只有一层，而系统确实存在两层设置。今天所有键都恰好是站点级的
（`site.title` / `seo.*` / `theme.active` / `cfpress.features` / `i18n.defaultLocale`），
所以"没有平台层"看不见——但后台前缀、会员注册开关、默认站点语言这些**天生是平台级**的键
一旦出现，就只能在一张站点级的表里开后门。

**设计**（沿用本仓库"声明 + 单一权威 + 派生"的既有形状）：

1. **新表 `platform_settings(key, value, autoload)`** —— `tenant: "platform"`（无 `site_id`，
   与 `theme_installs` 同类），语言中立。
2. **`SETTING_DEFS`** —— 每个设置键的**唯一权威声明**（放在 `src/platform/settings.ts`）：
   `key` / `scope`（`platform` \| `site`）/ 类型 / 默认值 / 是否敏感（设置屏是否回显）。
   **每个键必须声明 scope**，未声明的键 → 架构套件红。这是"加一个设置键忘了说它属于哪一层"
   的机制化，与 `onSiteDelete` 同款。
3. **读取阶梯只有一份定义**：`getSetting(env, siteId, key)`：
   - `scope: "platform"` → 只读 `platform_settings` → 声明的默认值
   - `scope: "site"` → 只读 `settings(site_id)` → 声明的默认值
   - `scope: "site"` 且声明 `inherit: true` → 站点值 → 平台值 → 声明的默认值
   **不做隐式跨层回退**：未声明的组合不存在，避免"同一个问题两份答案"（规则 23）。
4. **写入只走 facade**：`setSetting(env, siteId, key, value)` 按 `SETTING_DEFS[key].scope`
   决定写哪张表，**拒绝写未声明的键**。`src/api.ts` 里十几处内联 SQL 全部收口到这里。
   `_tenant-query-audit.mjs` 会把残留的直接读写报成 `NEW`，逼着逐条裁决或收口。
5. **设置屏拆两栏**：「平台设置」（新增能力 `platform.manage`，仅平台管理员）与
   「本站点设置」（`settings.manage`）。改后台前缀的入口就在平台设置栏。
6. **迁移**：建表 + 现有站点键**原位不动**（它们全是 `site` 级，无需搬家）；
   `platform_settings` 初始为空，键按需出现。

**验收（具名断言 + 注入场景）**：
- `architecture.test.mjs`：每个被读写的设置键都声明了 scope；`platform_settings` 存在且是
  platform 级；`getSetting` 的阶梯只此一处（不许第二份定义，同规则 70 的做法）。
- `_tenant-query-audit.mjs`：`settings` 的直接读写应归零或逐条有裁决。
- `admin-contract`：平台键改了、站点键不动；`site.manage` 之外的角色改平台键 → 403。
- 注入：直接对 `settings` 写一个未声明键 → 红。

**这一批必须在「后台隐身」之前做**：`admin.path` 需要平台级设置先存在。

---

## 2. 总体设计

### 2.1 两套登录，从存储到 cookie 完全分离

| | 后台（staff） | 前台（member） |
|---|---|---|
| 身份表 | `site_users`（install 级） | **`members`**（`site_id`，按站点） |
| 会话表 | `admin_sessions` | **`member_sessions`** |
| cookie | `cfpress_admin`，`Path=<后台前缀>` | `cfpress_member`，`Path=/` |
| 端点 | `/<adminPath>/api/v1/...` | `/api/v1/front/...` |
| 角色 | `site_users_sites.role`（按站点） | `members.role`（按站点） |
| 密码哈希 | `crypto.ts`（PBKDF2 25k，迭代数在哈希里） | 同一份实现 |

**"毫无关联"的落地方式**：不同的表 + 不同的 cookie 名 + 不同的端点前缀。在此基础上加守卫：

- 用 member cookie 打任何 `requireAdmin` 端点 → **401**；
- 用 admin cookie 打任何 `/front/*` 端点 → **401**；
- 两个会话表的 id 空间互不相交（不同表），**注入器补一个场景**：把 member 会话 id 当 admin 会话用，必须失败。

### 2.2 后台隐身

- `index.ts` 读 `admin.path`（带 memo，改动时 `resetAdminPathMemo()`，与 `resetSiteListMemo` 同款）。
- `/{adminPath}` 与 `/{adminPath}/*` → 后台 SPA + 后台 API；`Set-Cookie` 的 `Path` 限定到该前缀。
- **旧路径 `/admin*` → 404**（不重定向）。
- **登录端点挂在后台前缀之下**，即 `/{adminPath}/api/v1/auth/login`：后台 API 整体隐身，而不是只藏一个登录页。
- **前台专用 API** 另立 `/api/v1/front/*`（member 登录/注册/me）——公开是正常的，它本来就是给访客用的。
- **登录限流**（无论是否隐藏都要有）：按 `IP + username` 计失败次数，指数退避 + 短时锁定，记在 D1 表里。
- SPA 的三处绝对路径与 `state.js` 的 `/api/v1/` 改为**由服务端注入的 base**（`<script>window.CFP_ADMIN_BASE=…</script>`），这是本批最大的工作量点。

### 2.3 staff 按站点隔离

- `can(env, user, permission, siteId)` 增加站点参数；`requirePermission` 同步。
- 规则：`user.role === "superadmin"` → 全站；否则查 `site_users_sites` 得到**当前站点**的角色，再查 `role_permissions`；没有该站点的角色 → 403。
- 迁移：现有 `site_users.role` 平移为"该用户在 `default` 站点的角色"，并给首位用户 `superadmin`。
- 后台 UI：站点切换器只列出该用户有角色的站点；`users` 屏加"站点-角色"编辑。
- **这是改动面最大的一批**：`src/api.ts` 里 `requirePermission(...)` 的调用点全部要补 `siteId`（我会先统计数量，并用一条架构守卫强制"管理端点必须传 siteId"）。

### 2.4 hosts 自动化（系统级操作，按你的要求做成"小心 + 可回滚"）

新脚本 `scripts/dev-hosts.mjs`（Node，跨平台判断）+ `scripts/dev-hosts.ps1`（Windows 自提权）：

1. **只**操作 `# >>> cfpress-dev begin` … `# <<< cfpress-dev end` 标记块；块外一字节不动。
2. **先备份**：`hosts.cfpress-<时间戳>.bak`（写在 hosts 同目录，不可写则退回 `%TEMP%`），**备份后校验字节数一致**才继续改——本仓库假绿 #5 的教训是"清理/备份必须验证"。
3. 幂等：重复运行不产生重复行；`--remove` 只删标记块内内容，其余原样。
4. `--list` 列出当前映射；`--verify` 逐域名请求 dev server 并打印 `X-CFPress-Site`，**域名 → 站点** 一一对应才退出 0。
5. 域名清单**单一来源** = `sites.host`（不写在脚本里），脚本只负责写系统文件。
6. 改完**必须复查**：文件行数 = 原行数 ± 预期差；标记块恰好一对。

风险与缓解：Windows 写 hosts 需要管理员 —— 脚本检测到非提权时**明确报错并给出提权命令**，绝不静默失败。

---

## 3. 批次划分（每批独立可交付、独立验证、各自 commit + push）

### 批次 A —— hosts 工具 + 测试域名绑定（最小、独立、先交）
- **做什么**：`dev-hosts` 双脚本（备份/标记块/幂等/回滚/verify）；`seed:sites` 把三个测试站点连同 `host` 绑定做成可重跑播种；`multisite.test.mjs` 扩展：三个 host 各解析到对应站点、`X-CFPress-Site` 正确。
- **不碰**：鉴权、后台前缀。
- **验收**：`./scripts/cfpress.sh hosts --verify` 全绿；浏览器访问 `http://shop.cfpress.test:47913/` 命中 shop；hosts 文件在改动前后 diff 只差标记块。
- **改动面**：`scripts/`、`seed:demo`（站点部分）、`multisite.test.mjs`、`docs/`。

### 批次 B —— 设置分两级：`platform_settings` + 唯一读取阶梯
- **做什么**：新表 `platform_settings`；`SETTING_DEFS`（每键声明 scope / 类型 / 默认 / 敏感）；
  `getSetting` / `setSetting` facade，并把 `src/api.ts` 十几处内联 SQL 全部收口；
  设置屏拆「平台设置 / 本站点设置」两栏；新增能力 `platform.manage`；迁移建表。
- **验收**：`architecture.test.mjs` 断言"每个被读写的键都声明了 scope" + "阶梯只此一处"；
  `_tenant-query-audit.mjs` 对 `settings` 的直接读写归零（或逐条裁决）；
  `admin-contract` 平台键与站点键互不影响、无 `platform.manage` 改平台键 → 403；
  注入：对 `settings` 写一个未声明键 → 红。
- **改动面**：迁移、`contract/schema.ts`（新表两轴分类）、新模块 `src/platform/settings.ts`、
  `src/api.ts`、`admin-spa`、注入器。

### 批次 C —— 后台隐身：前缀可配置 + cookie 收紧
- **C1（路由与 cookie）**：`admin.path`（`platform_settings`，见批次 B）+ memo；`index.ts` 按前缀服务 SPA 与后台 API；旧路径 404；cookie 改名 `cfpress_admin` 并 `Path=<前缀>`；登录端点搬到后台前缀下；**登录限流**。
- **C2（SPA base）**：`index.html` 三处路径、`state.js` 的 `/api/v1/` 改为服务端注入的 base；真实浏览器验收。
- **验收**：`/{旧路径}` → 404；`/{新路径}` 可用；`/{新路径}/api/v1/auth/login` 可登录；**旧路径下的资产请求也 404**；未登录访问 `/{新路径}` 只见登录页；连续 5 次错密码触发限流；前台页面响应**不含** `Set-Cookie: cfpress_admin`。
- **改动面**：`src/index.ts`、`src/api.ts`、`src/platform/auth.ts`、`public/admin/*`、`admin-contract`、`admin-spa`、注入器场景、真实浏览器验收。

### 批次 D —— 前台会员（与后台完全分离）
- **D1（数据与 API）**：`members` + `member_sessions` 两张新表（过 `_schema-scope` 两轴分类 + `onSiteDelete: purge`）；`/api/v1/front/auth/{login,register,logout}` 与 `/api/v1/front/me`；`requireMember(env, request, siteId)`。
- **D2（主题）**：`login`/`register` 模板部件、`member` 作用域进模板、登出动作；中英词典。
- **验收（具名断言 + 注入场景）**：member cookie 打 `requireAdmin` 端点 → 401；admin cookie 打 `/front/*` → 401；A 站 member 在 B 站登录失败；注册开关关闭时 403；`_schema-scope` 对新表两轴分类与真库一致。
- **改动面**：迁移、`contract/schema.ts`、`src/platform/members.ts`、`src/api.ts`、主题模板与词典、`theme-default.test.mjs`、注入器。

**已完成（2026-10-11）**，落地与计划的两处偏差记录如下：

1. **`member_sessions` 带 `site_id`**。计划里 D1 只说"两张新表"；实际建表时 `member_sessions` 一度按派生租户声明（`member_id → members.site_id`，不带 `site_id`），`_schema-scope` 立刻报它在两轴模型里缺列。真正的原因是 `deleteSite()` 用统一的 `DELETE FROM <table> WHERE site_id=?` 遍历 `PURGE_ON_SITE_DELETE`——**没有 `site_id` 的表无法进入循环**，只能加一段 bespoke 删除（第二个会忘的地方）。结论写进迁移注释：派生根租户表只在局部列**冗余**时才对（连接表），这里它是**承重**的。
2. **带前缀站点走不通前台 API（真实缺陷，先于测试发现）**。`/accm/api/v1/front/auth/register` 404，两个根因：(a) 站点解析原先放在 `routeFrontApi` 内部，而 API 层运行在站点解析**之前**，永远只解析到 default；(b) `if(request.method!=="GET")return env.ASSETS.fetch(request)` 的兜底在站点解析之前，把所有 POST 送进静态资源层。修复：抽出 `handleFrontApi(env, request, siteId, resolvedPath)`，由 `index.ts` 的 `frontApiRelPath()` 识别路径、**先 resolveSite** 再调用，位置放在非 GET 兜底之前。
3. **静态主题路由不再跑无约束查询**。`/login`、`/register` 这类不声明 `query`/`resolve` 的路由原先仍会执行 `runThemeQuery` 的默认 `type:"post", limit:10`，为一个不读它的模板白付一次查询；现在只有真正声明了列表的路由才查。

**新增守卫**：`architecture` 规则 77（a 两个 cookie 名不同 / b 两个解析器各读各的会话表 + front 路由不许出现 `requirePermission`·`currentUser` / c 两张表带 `site_id` + 用户名按站点唯一 / d 契约声明为站点表 / e 主题 scope 走 `currentMember`）；`admin-contract` §17；注入器 4 个场景（反读 `admin_sessions`、cookie 同名、`member_sessions` 丢 `site_id`、契约降级为平台表）。

### 批次 E —— 后台用户按站点隔离
- **E1（权限接线）**：`site_users_sites` 表 + 迁移平移；`can(env,user,perm,siteId)` 站点感知；**全部** `requirePermission` 调用点补 `siteId`（先统计数量）+ 一条架构守卫强制。
- **E2（UI）**：站点切换器按角色过滤；`users` 屏的站点-角色编辑；中英词典。
- **验收**：A 站 editor 打 B 站 `content.write` → 403；`superadmin` 全站；`site_users.role` 平移后旧行为不回归；跨站点列表互不可见。
- **改动面**：迁移、`contract/schema.ts`、`src/platform/permissions.ts`、`src/api.ts`（所有调用点）、`admin-spa`、`admin-contract`、注入器。

**E1 已完成（2026-10-11）**，落地与计划的三处偏差记录如下：

1. **`siteId` 是「必填参数」，不是「可选带默认」**。计划只写"站点感知"；实现时把它做成签名里的必填第四参。理由：可选参数会让某个调用点**悄悄**重问"站点盲"的问题——而那个问题**仍然有答案**（它读到某人的一行），这正是缺陷能通过评审的方式。必填则编译器点名每一处必须表态"哪个站点"。守卫（规则 78a）直接读签名，拒绝 `siteId?: string` 与 `siteId = "…"` 两种可选拼法。
2. **两类权限，一张显式清单**。`PLATFORM_PERMISSIONS = {platform.manage, users.manage, extensions.manage}`（install 级，只有 `superadmin` 有）；其余按站点。**`POST/PUT/DELETE sites` 从 `content.write` 改判为 `platform.manage`**：建/改/删站点是"管理租户注册表本身"，站点还不存在时没有成员行可满足，按站点判是个无解的题。`GET sites` 按 `accessibleSiteIds` 过滤（`superadmin` 得 `null`＝全部）。
3. **`requireAdmin` 的硬编码角色列表是升级陷阱（真实缺陷，先于测试发现）**。迁移 0023 把唯一管理员提升为 `superadmin` 之后，`admin-contract` 的 §0b 立刻红：`requireAdmin` 写死 `["admin","editor","author"]`，**不含 `superadmin`** → owner 被锁在每一个后台端点之外。修复：`ADMIN_ROLES` 从 `SITE_ROLES` + `SUPERADMIN_ROLE` **派生**（规则 78a 钉住"必须是派生的"）。

**新增守卫**：`architecture` 规则 78（a `can`/`requirePermission` 的 `siteId` 必填 + 后台角色集派生 / b 全部 31 个调用点带 `siteId` + 平台权限集非空 / c `can()` 只读成员表且带站点过滤 + 无行即拒 + `superadmin` 先短路 / d 契约声明为站点表 + `superadmin` 不可按站点授予 + 迁移带 `site_id` 且平移）；`admin-contract` §18（31 条：A 站 editor 打 B 站 403、superadmin 对照、站点列表按成员过滤、平台权限 install 级、授/撤站点角色、`role_here`/`sites` 契约）；注入器 6 个场景（回退全局 role、丢站点过滤、`siteId` 变可选、迁移丢平移、`superadmin` 进可授集、后台角色集写死）。

### 批次 F —— 契约与守卫收尾
- `CHANGE-CONTRACT.md` 新增三个维度（**前台/后台分离**、**后台前缀隐身**、**每站点角色**）+ 交织矩阵补行；`AGENTS.md` DoD 同步；`_schema-scope` 新表两轴；注入器场景；`_residue-guard` 跑一遍确认无残留。

---

## 4. 顺序与理由

```
A（hosts + 域名）          最小、独立、不碰鉴权；做完立刻能验证 host 路由
   ↓
B（设置分两级）            地基：C 的 admin.path 需要平台级设置先存在
   ↓
C（后台隐身）              依赖 A（域名绑好后才能验证"旧路径在某些域下也 404"）+ B
   ↓
D（前台会员）              与 C 都动 index.ts 路由，分开做降低冲突；模型先立起来
   ↓
E（staff 按站点）          依赖 D 的按站点身份模型 + C 的 cookie 命名
   ↓
F（契约与守卫收尾）
```

A 不碰任何鉴权代码，是最安全的第一步；B 与 C 都在 `index.ts` 里加路由分支，**合并在一起做会互相干扰**，所以拆开。

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 改后台前缀把自己锁在外面 | 改动要求**二次确认**、写入 `admin_activity` 审计、`cfpress.sh` 提供 `admin:path` 兜底命令、文档写明恢复方式 |
| `requirePermission` 全量接线是大面积改动 | 先统计调用点数量并写入本计划；加一条架构守卫强制"每个管理端点传 siteId"；分 D1/D2 两步，每步全量套件回归 |
| hosts 是系统级文件 | 只动标记块 + 先备份并**校验备份** + 幂等 + 可完全回滚 + 非提权时明确报错 |
| cookie 改名使现有登录失效 | 本地开发可接受；写进 CHANGE 说明；线上部署时挑维护窗口 |
| 两套会话将来被"顺手统一" | 守卫写成**具名断言 + 注入场景**，任何人合并两套会话都会红 |
| 前台登录页成为新的攻击面 | 限流同样覆盖前台端点；注册可关；密码策略与后台同一份实现 |

---

## 6. 明确不做（本计划之外，留接口位）

邮件找回 / 邮箱验证、OAuth 与第三方登录、评论系统、会员付费/等级、多因素认证。
（这些都依赖本计划的 C/D 落地，届时各自成批。）

---

## 7. 每批的验证矩阵（摘要）

| 批 | 单元/契约 | 真实浏览器 | 反向验证 |
|---|---|---|---|
| A | `multisite`（host 路由 ×3） | 三个域名各命中对应站 | hosts 工具：非提权/坏标记块/重复运行 |
| B | `architecture`（键必声明 scope + 阶梯唯一）、`admin-contract`（平台键/站点键互不影响、403）、`_tenant-query-audit`（settings 直读写归零） | 设置屏两栏，平台栏无 `platform.manage` 不可改 | 注入：写未声明的键 |
| C | `admin-contract`（路径、404、cookie、限流）、`admin-spa`（base） | 旧路径 404、新路径可用、限流触发、前台不带后台 cookie | 注入：硬编码 `/admin`、cookie `Path=/` |
| B | `admin-contract`（路径、404、cookie、限流）、`admin-spa`（base） | 旧路径 404、新路径可用、限流触发、前台不带后台 cookie | 注入：硬编码 `/admin`、cookie `Path=/` |
| C | `admin-contract`（member 401/403）、`_schema-scope`（新表）、`theme-default`（部件） | 前台登录/注册/登出、A 站 member ≠ B 站 | 注入：member 会话当 admin 用 |
| D | `admin-contract`（跨站点 403）、`architecture`（siteId 接线守卫） | 切换器按角色过滤 | 注入：`requirePermission` 丢 siteId |
| E | 全量 + `_residue-guard` | 两个既有浏览器脚本 | 全部新守卫 |
