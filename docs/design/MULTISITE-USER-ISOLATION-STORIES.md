# 多站点 · 用户归属 · 数据隔离 —— User Story 矩阵

> 这份文档回答：**「多站点到底有多少种情况要正确？」**
>
> 它是**测试蓝图**：每条 story 有编号、验收标准、当前状态、以及它落到哪个测试。
> 编号在整份文档里唯一，测试断言里直接用 `MS-1.2.3` 这样的 ID 引用，
> 于是"这条 story 测过了吗"永远可以 grep 得到答案。
>
> 与另外两份文档的分工：
> - `docs/CHANGE-CONTRACT.md` 回答「**我改的东西**要覆盖哪些面」（按改动类型）
> - `docs/ARCHITECTURE.md` §10 回答「每个面**为什么存在**」（规则 1–80）
> - **本文**回答「多站点这个**功能空间**里有多少条路径」（按功能穷举）
>
> ⚠️ **本文只覆盖"多站点 + 用户归属 + 数据隔离"这一个功能空间**，不重复其他维度。
> 语言（L1–L4）、渲染、扩展契约等各自有专门的矩阵（见契约 §1）。

---

## 0. 怎么读这份矩阵

### 0.1 矩阵的三个轴

多站点隔离的问题空间是**三个正交轴的笛卡尔积**，这也是它"庞大"的原因：

| 轴 | 取值 | 权威来源 |
|---|---|---|
| **A. 数据面** | 22 张站点级表 + 7 张派生租户表 + 一批平台级表 | `src/extensions/contract/schema.ts` 的 `PLATFORM_SCHEMA` |
| **B. 入口面** | 前台 URL / 后台 API / 后台 SPA / 主题沙箱 / 计划任务 / 扩展装载 | `resolveSite()` + `api.ts` + `index.ts` |
| **C. 主体面** | 匿名 / member（按站点）/ staff（install 级身份 + 按站点成员行）/ superadmin | `permissions.ts` 的 `can()` |

**穷举 = 22+7 张表 × 6 个入口 × 4 种主体**。但**不是每一个格子都值得单独测**——
本文用三条**约简原则**把它压到可执行的规模（见 §0.3）。

### 0.2 状态标记

| 标记 | 含义 |
|---|---|
| ✅ | 已实现且有测试断言 |
| 🟡 | 已实现但**断言不完整**（只在功能测试里被间接覆盖，没有专门的隔离断言） |
| ❌ | **未实现**（是真实的待办，不是"想多了"） |
| ⚪ | **设计上不适用**（写明为什么，不是跳过） |

### 0.3 三条约简原则（为什么矩阵不会无限大）

**原则 1 —— 同构的表共享一条 story。**
22 张站点级表如果逐个写 story 会得到 22 份几乎相同的东西。它们**在隔离这个维度上同构**：
都靠"每条语句带 `site_id`"实现隔离。所以只写一条 story（`MS-1.1`），
再用**一张表清单**（§附录 A）作为它的参数。新增一张站点表 = 往清单加一行，
**story 数不变**。这才是"矩阵庞大"的正确处理方式：**穷举数据，不穷举维度**。

**原则 2 —— 入口面按"站点从哪来"分类，不按端点名分类。**
`resolveSite()` 只有三档（path_prefix → host → default）。
所以入口面压成三条 story（`MS-2.1/2.2/2.3`）+ 一条"绕过 resolveSite"的 story（`MS-2.4`）。

**原则 3 —— 主体面的关键是"谁在拿谁的凭据"。**
4 种主体两两组合有 12 个方向，但**只有 4 个方向是危险的**（跨层越权）。
其余是显然的拒绝。所以主体面压成 4 条 story（`MS-3.1`–`MS-3.4`），
每条钉一个**危险的错方向**。

---

## 1. 数据面：每条语句都必须带站点（`MS-1.x`）

### MS-1.1 —— 站点级表：A 站的数据，B 站看不到、改不了、删不掉

**作为** 一个在 A 站工作的编辑，
**我要** 在任何列表/详情/写入/删除里都只看到 A 站的数据，
**以便** B 站的内容永远不会出现在我的后台、也不会被我误删。

**验收标准**
1. 任何 `SELECT` 站点级表都带 `site_id`（不是过滤后过滤，是 SQL 里就在）。
2. 任何 `UPDATE` / `DELETE` 都带 `WHERE id=? AND site_id=?`（**不是先查再删**——
   先查后删在两次查询之间有窗口，且"查"忘了带站点就全放开）。
3. 跨站读取一个已知 id（B 站的 id 传到 A 站的请求里）→ **404**（不是 403，不是空对象）。
4. 跨站删除 → 被删的行**仍然在**。

**参数（→ 附录 A 的表清单）**：22 张 `tenant: "site"` 表。

**当前状态**：🟡 —— `_tenant-query-audit.mjs` 静态审计每条触碰租户表的语句；
`multisite.test.mjs` §4 断言了内容/设置/主题/CPT/导航/缓存/SEO/feed 的隔离。
**缺口**：`site_users_sites`、`members`、`member_sessions`、`notification_log`、
`i18n_overrides`、`widget_instances`、`redirects`、`rewrites`、`taxonomies`、`terms`、
`theme_blocks`、`theme_routes`、`theme_table_defs`、`field_defs`、`post_types`
没有**逐表的**跨站读/写/删断言（多数只被架构审计的静态面覆盖）。

**测试落点**：`tests/suites/multisite-isolation-matrix.test.mjs`（新）§1，
参数化遍历附录 A，每张表三条断言（跨站读 404 / 跨站写无效 / 跨站删无效）。

---

### MS-1.2 —— 派生租户表：靠父行继承，父行不可见则子行不可见

**作为** 一个编辑，
**我要** 通过一个内容的 id 拿不到别的站点的自定义字段、修订、翻译、SEO、排期，
**以便** "知道 id 就能读到"这条路被堵死。

**验收标准**
1. 所有对派生表的查询都 `JOIN 父表 ... WHERE 父表.site_id=?`（或等价的存在性检查）。
2. 拿着 B 站 post 的 id 到 A 站请求 `/content/post/<B-id>` → **404**。
3. 拿着 B 站 post 的 id 到 A 站请求它的 `meta` / `revisions` / `translations` → **404**。
4. **不能只过滤父表的列表**而把子表的详情端点放开（历史形状：列表过了站点，详情没带站点）。

**参数**：7 张 `derivedTenant` 表（`post_meta`、`post_revisions`、`post_autosaves`、
`post_translations`、`seo_meta`、`term_relationships`、`scheduled_posts`）。

**当前状态**：🟡 —— `multisite.test.mjs` §4 覆盖了内容列表与详情；
`i18n.test.mjs` 覆盖翻译。**缺口**：派生表**逐表的详情端点**没有跨站断言，
`seo_meta`、`scheduled_posts`、`post_autosaves` 尤其。

**测试落点**：新套件 §2，遍历 7 张派生表，每张一条"跨站详情 404"。

---

### MS-1.3 —— 平台级表：**故意**没有 `site_id`，且不能偷偷加上

**作为** 维护者，
**我要** 平台注册表（`sites` / `locales` / `site_users` / `role_permissions` / 扩展注册表）
**保持** install 级，
**以便** 站点数量不会让语言注册表/扩展清单/权限矩阵产生 N 份副本。

**验收标准**
1. 平台级表**没有** `site_id` 列（有 = 暗示存在 per-site 副本，而实际不存在）。
2. 试图给平台级表加 `site_id` → `_schema-scope.mjs` **当场红**（分类与真实列不符）。
3. `sites` 表**就是**租户注册表，它自己必然无 `site_id`。

**当前状态**：✅ —— `_schema-scope.mjs` 用 `PRAGMA table_info` 逐表比对分类。

**测试落点**：`_schema-scope.mjs`（已有）。

---

### MS-1.4 —— 站点删除：purge 的真的清了，retain 的真的留了

**作为** 站点管理员，
**我要** 删除一个站点时，它的**配置**（菜单/设置/路由/CPT 注册）被清干净，
而它的**内容**（文章/媒体）被保留，
**以便** 不留下"指向不存在站点的注册行"，也不毁掉作者的工作。

**验收标准**
1. `deleteSite()` 删除所有 `onSiteDelete: "purge"` 表中该站的行。
2. `onSiteDelete: "retain"` 的行**还在**，且**解析不到任何东西**（站点没了 → `resolveSite` 不再匹配）。
3. purge 的清单**派生自** `PLATFORM_SCHEMA`，不是手写列表（手写列表会漂移）。
4. 新增站点级表**不声明** `onSiteDelete` → `architecture.test.mjs` **红**。
5. `site_users_sites` 的成员行随站点 purge；`site_users`（身份）**不 purge**（人比站点活得久）。
6. ⚠️ **删除 `sites` 行本身**——`_cf_KV` 内部表**绝不能碰**。

**当前状态**：✅（`multisite.test.mjs` §10 + `architecture.test.mjs` non-vacuity 段）；
⚠️ **缺口**：purge/retain 的**逐表**断言不完整（当前主要断言"站点没了"和"某几类清了"）。

**测试落点**：新套件 §4，遍历 `PURGE_ON_SITE_DELETE` 逐表断言"清了"，
遍历 `retain` 表逐表断言"还在但不可达"。

---

### MS-1.5 —— 站点删除后**孤儿身份**：成员行清了，身份还在，且**不再有任何访问**

**作为** 维护者，
**我要** 删掉一个站点后，曾经只属于那个站点的 staff 用户
**仍然是 install 级身份**（还能被授予别的站点），但**对任何现存站点都没有权限**，
**以便** "删了站点"不等于"删了人"，也不等于"这个人还留着某处的门"。

**验收标准**
1. 删站点 S 后，`site_users_sites` 里 `site_id=S` 的行全部消失。
2. 曾经只在 S 有成员行的用户，其 `site_users` 行**仍在**。
3. 该用户对任何现存站点 `can(...) === false`（**行缺席 = 拒绝**，不回退）。
4. `superadmin` 例外：仍然全通。
5. 删**身份**（`deleteUser`）时成员行也一起走（规则 80，已有套件）。

**当前状态**：🟡 —— 规则 80 覆盖了"身份删时成员行走"；
**缺口**："站点删时成员行走、身份留、且权限归零"这条**组合**没有专门断言。

**测试落点**：新套件 §5。

---

## 2. 入口面：站点从哪来（`MS-2.x`）

### MS-2.1 —— `resolveSite` 的优先级：最长前缀 > host > 默认

**作为** 一个站点运营者，
**我要** 同一个 host 下 `/shop` 与 `/blog` 是两个站点，且 `/shop/fr` 归 `/shop`，
**以便** 前缀包含关系不会让一个站点吃掉另一个。

**验收标准**
1. 最长匹配前缀获胜（`/shop/fr` 归属 `/shop`，不是被更短的前缀抢走）。
2. 前缀匹配是**段边界**的：`/shopx` **不**匹配前缀 `/shop`。
3. prefix 命中优先于 host；host 命中优先于默认。
4. 都命不中 → 默认站点（**唯一**合法的站点回退点，有 `ARCH-RULE-EXEMPT` 标记）。
5. 前缀被剥离后的 path 以 `/` 开头（`path.slice(prefix.length)` 后补斜杠）。

**当前状态**：✅ —— `multisite.test.mjs` §2/§3。

**测试落点**：已有；新套件补"段边界"与"剥离后 path"两条边界。

---

### MS-2.2 —— 每请求重置的站点列表 memo（**跨请求污染**是这里唯一的坑）

**作为** 一个刚创建了站点的管理员，
**我要** 创建后**立刻**能在前台访问它，
**以便** 不用等 isolate 回收（否则"我建了站点但打不开"，且**单站点安装测不出来**）。

**验收标准**
1. `siteListMemo` 在**每个请求开始**被重置（keying on `env` 不是请求作用域——`env` 是 isolate）。
2. 创建/改站点后，**下一个**请求就能按它的 host/prefix 解析到它。
3. 在**同一个**请求内**不**重复查 `sites`（memo 的正向作用）。

**当前状态**：✅ —— `sites.ts` 注释记录了历史缺陷；`multisite.test.mjs` 有覆盖。

**测试落点**：已有；建议补一条"同请求内只查一次"的表征断言。

---

### MS-2.3 —— 前台读路径的站点必须来自 `resolveSite`，不能自己造

**作为** 维护者，
**我要** 任何前后台读路径的 `siteId` 都从 `resolveSite` 来，
**以便** 没有任何地方凭空写 `"default"` 字面量（历史形状：站点解析早于 API 层，
导致带前缀站点走不通前台 API）。

**验收标准**
1. 除 `resolveSite` 自身外，`src/` 里没有第二个 `"default"` 站点字面量回退。
2. 带前缀站点的**非 GET** 请求也能正确解析站点（历史缺陷：非 GET 兜底吞掉 POST）。
3. 主题沙箱内的 `site.id` 与宿主解析的一致。

**当前状态**：✅ —— `architecture.test.mjs` 规则 4 段 + 批次 D 修的缺陷。

**测试落点**：已有。

---

### MS-2.4 —— 绕过 `resolveSite` 的入口：每个都要自己答"站点是谁"

**作为** 维护者，
**我要** 那些不走普通请求管线的入口（计划任务、扩展装载、管理员 API 的 `?site=`）
**显式** 指定站点，
**以便** 不存在"站点悄悄落到默认值"的路。

**验收标准**

| 入口 | 站点从哪来 | 断言 |
|---|---|---|
| `?site=<id>` 查询参数 | 显式，且**只接受该用户有权的站点** | 无权的 site id → 403/404，不回退默认 |
| `scheduled()`（Cron） | 无请求上下文 → 遍历**所有**站点或按 `scheduled_posts.site_id` | 不能只处理默认站点 |
| 扩展/主题装载（boot 链） | 站点级声明按站点同步（`syncOwnerTables`、`ensureThemeCapabilities`） | 每个站点各自拥有自己的能力行 |
| 后台 SPA 的站点切换器 | 读 `GET sites`（**已按 `accessibleSiteIds` 过滤**） | 切到无权站点 → 该站不在列表里 |

⚠️ **`?site=` 的坑**：经后台前缀进来的请求，**重写 URL 必须带上 `u.search`**，
否则 `?site=` 整个丢失 → 站点变默认值，而且**没有一个请求报错**（批次 28 真实事故）。

**当前状态**：🟡 —— `admin-contract.test.mjs` §15b 覆盖了"前缀带 query"；
站点切换器过滤由 E1 的 `GET sites` 过滤白送，E2 只把它钉住。
**缺口**：权限 API 的 `?site=` 无站点 id 的**越权**断言（"传一个我没资格的站点 id"）。

**测试落点**：新套件 §3.4 + `admin-contract.test.mjs` 补一条。

---

## 3. 主体面：谁在拿谁的凭据（`MS-3.x`）

### MS-3.1 —— staff 的身份是 install 级，**权限是站点级的**

**作为** 一个只在 A 站有 editor 成员的 staff 用户，
**我要** 能登录后台、能编辑 A 站，
**但** 在 B 站的任何内容/设置端点得到 **403**，
**以便** "在一个站点被聘用"不等于"在每个站点被聘用"。

**验收标准**

| # | 场景 | 期望 |
|---|---|---|
| a | A 站有成员行 → A 站 `content.write` | ✅ 通过 |
| b | B 站无成员行 → B 站 `content.write` | ❌ 403 |
| c | B 站无成员行 → B 站 `settings.manage` | ❌ 403 |
| d | 成员行存在但角色是 `author` → `content.write` | 按角色矩阵（`role_permissions`） |
| e | 用户被从 A 站移除（行删了）→ A 站 | ❌ 403（**不回退** `site_users.role`） |
| f | `superadmin` → 任何站点任何站点级权限 | ✅ 通过（首先短路） |

**当前状态**：✅ —— `admin-contract.test.mjs` §18（31 条）+ `architecture.test.mjs` 规则 78 段。

**测试落点**：已有。

---

### MS-3.2 —— 平台级权限**不属于**任何站点级角色

**作为** 维护者，
**我要** `platform.manage` / `users.manage` / `extensions.manage` 只有 `superadmin` 有，
**以便** 一个 B 站的 admin 不能通过"给自己所在的 B 站管理员身份"拿到建站/管用户的能力。

**验收标准**

| # | 场景 | 期望 |
|---|---|---|
| a | `PLATFORM_PERMISSIONS` 是显式闭集，列表外的权限一律站点级 | ✅ 已实现 |
| b | 站点 admin 调 `POST sites`（建站） | **403** |
| c | 站点 admin 调 `POST users`（建用户） | **403** |
| d | 站点 admin 调 `GET users`（列用户） | **403** |
| e | 站点 admin 调 `PUT users/:id/sites/:siteId` 把**自己**授到 B 站 | **403** |
| f | 站点 admin 上传扩展 | **403** |
| g | 站点屏**不能**授予 `superadmin`（即使 superadmin 自己操作） | **400** |

**当前状态**：✅（`admin-contract.test.mjs` §18 覆盖 b/c/d/g；`can()` 对非 superadmin 的平台级权限直接 `return false`）。

⚠️ **但这里有一个真实的设计缺口，需要你拍板（不是我替你决定）：**

`users.manage` 是**平台级**权限 → **只有 superadmin 有**。后果是：

> **站点 A 的 admin 完全不能管理站点 A 的用户**——看不到用户列表（`GET users` 403）、
> 不能建用户、不能给本站点的人授权或撤权。**所有**用户管理事实上是 superadmin 独占。

这对一个多站点 CMS 是**功能缺失**：真实运营里"每个站点的管理员管自己站点的人"是核心需求。
现状**是安全的**（没有提权路径——因为整个端点只有 superadmin 能进，站点 admin 根本走不到
`targetSite` 的检查），但**不完整**。

**两个候选方案**

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A. 保持现状** | `users.manage` 保持平台级；站点管理用户 = superadmin 的活 | 站点 admin 无用户管理能力；多站点运营靠 superadmin 集中管理。**当前已是此状态** |
| **B. 拆成两层** | 新增站点级权限 `site.users.manage`：站点 admin 可管**本站点**用户，但**不能**给任何人本站点以外的授权，也**不能**碰 superadmin 身份 | 端点对站点 admin 开放后，**#e 的守卫性质改变**（见下） |

⚠️ **若选 B，#e 必须重写**：现在 #e 安全是因为"整个端点只有 superadmin 能进"；
选 B 之后端点对站点 admin 开放，**必须**显式检查 `targetSite === siteId`
（否则站点 admin 能给自己在 B 站开一个门——**这时它才是真正的提权洞**）。
**这正是"守卫锚在消费上"的又一例**：不能靠"没人去试"，要靠 `targetSite` 的显式检查。

**测试落点**：现有 §18 覆盖 A 方案；若选 B，新套件 §3.5 补 `targetSite` 越权断言。

---

### MS-3.3 —— member（前台）与 staff（后台）**没有东西可交换**

**作为** 维护者，
**我要** 一个前台注册用户**永远**不能通过任何凭据形式碰到后台，
**以便** "在商店站点注册"不等于"拿到后台的一把钥匙"。

**验收标准**（每条都是**行为**断言，不是"没人试过"）

| # | 携带的凭据 | 打的门 | 期望 |
|---|---|---|---|
| a | `cfpress_member` cookie | 任意后台 API | **401** |
| b | `cfpress_member` cookie | 后台 SPA 页面 | 重定向到登录 / 401 |
| c | 一个 `member_sessions` 的 id | 后台 API（当作 `cfpress_admin`） | **401** |
| d | `cfpress_admin` cookie | 前台 member API（`/api/v1/front/me`） | **401** |
| e | 一个 `admin_sessions` 的 id | 前台 member API | **401** |
| f | — | 前台注册的 username 与后台 staff 重名 | **允许**（不同表，按站点各自唯一） |

**验收标准（构造层）**
1. `currentMember` **不许**出现 `admin_sessions`；`requireAdmin` **不许**出现 `member_sessions`。
2. cookie 名不同：`cfpress_admin` vs `cfpress_member`。
3. 端点前缀不同：`{admin.path}/api/v1/…` vs `/api/v1/front/…`。

**当前状态**：✅ —— `architecture.test.mjs` 规则 77 段（含红线）+ `admin-contract.test.mjs` §17。

**测试落点**：已有；新套件可复用其中 a–f 作为矩阵的一行。

---

### MS-3.4 —— member 按站点隔离：A 站注册的会员在 B 站不存在

**作为** 一个在 A 站注册的读者，
**我要** 在 B 站**不是**登录状态，
**以便** "在 A 站注册"不等于"在 B 站有账号"。

**验收标准**
1. `members` 有 `site_id`，用户名**按站点唯一**（`UNIQUE(site_id, username)`）。
2. A 站的 member session 带 `site_id`；用它打 B 站的会员端点 → **401**。
3. A 站和 B 站可以**各自**有一个叫 `alice` 的会员（不冲突）。
4. 删站点时 `members` 与 `member_sessions` 按站点 purge。
5. 同一 email 在两个站点注册 → 允许（按站点各一份）。

**当前状态**：🟡 —— `admin-contract.test.mjs` §17 覆盖了身份分离；
**缺口**：**逐站点**的会员隔离（第 2/3/5 条）没有专门断言。

**测试落点**：新套件 §3.6。

---

### MS-3.5 —— 无成员行 = 拒绝，且**绝不回退**

**作为** 维护者，
**我要** `can()` 在找不到成员行时返回 `false`，
**以便** "从站点移除某人"是一个**真的**移除。

⚠️ **这是全矩阵最容易假绿的一条**：回退到 `site_users.role` 时，
"移除"看起来生效了（行没了），但权限没变——**测不出来，除非专门测**。

**验收标准**
1. 删掉某用户在某站的成员行 → 该站 `can(...) === false`。
2. 删掉**唯一**的成员行 → 该用户**所有**站点级权限为 `false`。
3. `can()` 的 `siteId` 参数**必填**（编译期：可选参数会让调用点静默重问站点盲问题）。
4. 源码里**没有**第二处读 `site_users.role` 当作站点权限的地方。

**当前状态**：✅ —— 规则 78 段。

**测试落点**：已有。

---

## 4. 交叉面：真正的"庞大"在这里

上面三节各自正交。**交叉**才是矩阵庞大的来源，也是缺陷最常栖息的地方。
下面的表**不是**要求逐格测，而是**每格标注是否需要专门的断言**。

### 4.1 数据面 × 入口面

| 入口 ↓ \ 数据 → | 站点级表 | 派生租户表 | 平台级表 |
|---|---|---|---|
| 前台 URL | ✅ MS-1.1 | ✅ MS-1.2 | ⚪（前台不读平台注册表，除 `locales`） |
| 后台 API | ✅ MS-1.1 | 🟡 MS-1.2 | ✅ MS-1.3 |
| 后台 SPA | 🟡（列表已过站点） | 🟡 | ⚪ |
| 主题沙箱 | ✅（`site.id` 注入） | 🟡（`theme_table_defs` 按站点） | ⚪ |
| 计划任务 | 🟡 MS-4.3（实现正确，缺多站点断言） | 🟡 MS-4.3 | ⚪ |
| 扩展装载 | 🟡（`syncOwnerTables`） | ⚪ | ✅ |

**计划任务那两格是 🟡 不是 ❌**：`src/shared/scheduler.ts` 的实现按站点遍历、
按站点 bump 缓存，是对的；缺的是**多站点断言**（现有测试可能只跑默认站点）。
见 MS-4.3。

### 4.2 主体面 × 数据面

| 主体 ↓ \ 数据 → | A 站的内容 | B 站的内容 | 平台注册表 |
|---|---|---|---|
| 匿名（前台） | ✅ 只读 published | ✅ 只读 published | ⚪ |
| member@A | ✅ 按站点 | ✅ 403（MS-3.4） | ⚪ |
| staff@A（editor） | ✅ | ✅ 403（MS-3.1b） | 🟡 |
| staff@A（admin） | ✅ | ✅ 403 | 🟡（不能建站/建用户） |
| superadmin | ✅ | ✅ | ✅ |

### 4.3 新增 story

#### MS-4.1 —— 站点切换器只显示有权的站点

**验收标准**：`GET sites` 返回的列表 ⊆ `accessibleSiteIds(user)`；
superadmin 返回全部；普通 staff 只返回有成员行的。

**当前状态**：✅（E1 的过滤 + E2 钉住）。

#### MS-4.2 —— 后台列表的"每站点统计"不泄露无权站点的名字

**验收标准**：`?withCounts=1` 的响应 `items` 只含该用户有权（`accessibleSiteIds`）的站点；
每站点计数按 `GROUP BY site_id` 算，但对无权站点既不出名字也不出数字。

**当前状态**：✅ —— `api.ts` 的 `sites` GET：先 `accessibleSiteIds` 过滤 `items`，
`withCounts` 的分组计数只用于给**已过滤列表**里的行补数字。**待补**：一条断言
（用无权站点名去查响应里是否出现它）。

#### MS-4.3 —— 计划任务按站点遍历

**作为** 站点运营者，
**我要** 我在 B 站排期的文章到点在 B 站发布会，
**以便** 排期不是只有默认站点能用。

**验收标准**
1. `scheduled()` 处理**每个**站点的到期文章（不是只默认站点）。
2. 发布事件带的站点与文章一致。
3. 发布后 `bumpContentCache(env, siteId)` 用的是该文章所属站点。
4. 只有**受影响的**站点 bump 缓存（多站点安装不会每分钟失效无关站点）。

**当前状态**：🟡 —— `src/shared/scheduler.ts` 的实现是**对的**：
`SELECT ... WHERE processed_at IS NULL AND publish_at<=?`（不限站点）、
逐行取 `posts.site_id` 收进 `touchedSites` 集合、按站点 bump 缓存；
遗留无 `site_id` 的行显式 bump `default`（有一条书面理由）。
**缺口**：没有**多站点**断言（现有测试可能只跑默认站点 → 看不出）。
**待补**：三站点夹具下各排一篇，断言三篇都发布且各自缓存版本变化。

#### MS-4.4 —— 站点数量 > 2 时的隔离（不只是 A/B 两个）

**作为** 维护者，
**我要** 隔离断言在 3+ 站点时仍然成立，
**以便** 抓住"两个站点时碰巧对、三个站点时错"的实现
（例如误用 `LIMIT 1`、误用 `[0]`、误把"第一个站点"当默认）。

**验收标准**：所有隔离断言在 A/B/**C** 三站点夹具上跑；
且 A 站不是默认站点（防止"默认站 = 唯一站"的巧合）。

**当前状态**：❌ —— 现有夹具多为两站点。
**这是"两集合相等先问凭什么相等"的又一例**：两站点断言可能靠巧合成立。

---

## 5. 测试实现计划

### 5.1 新套件

`tests/suites/multisite-isolation-matrix.test.mjs`

| 段 | 覆盖 | 断言数（估） |
|---|---|---|
| §1 | MS-1.1 遍历附录 A 的 22 张站点级表（跨站读/写/删） | ~66 |
| §2 | MS-1.2 遍历 7 张派生表（跨站详情 404） | ~14 |
| §3 | MS-1.4 purge/retain 逐表 | ~30 |
| §4 | MS-1.5 孤儿身份 | ~5 |
| §5 | MS-3.2 提权方向（高优先级） | ~6 |
| §6 | MS-3.4 会员逐站点隔离 | ~8 |
| §7 | MS-4.3 计划任务按站点 | ~4 |
| §8 | MS-4.4 三站点夹具（关键隔离复跑） | ~20 |
| **合计** | | **~153** |

### 5.2 夹具要求（关键）

1. **三个站点**：`iso_a`（`path_prefix: /iso-a`）、`iso_b`（`host: b.example`）、
   `iso_c`（非默认）。
2. **默认站点不是 A、B、C 中的任何**（防巧合）。
3. **四个主体**：superadmin / staff@A(editor) / staff@B(admin) / member@A。
4. 每个站点**各自**有：1 篇文章 + 1 个自定义字段 + 1 个媒体 + 1 个菜单 + 1 个设置。
5. **两个站点都有拼音相同的标题**（如都叫 `hello`）→ 断言 `resolveContent` 按站点各取各的。
6. 清理：按 `iso_%` 前缀 sweep，且**能自愈**上次崩溃的残留
   （教训来自 `user-delete.test.mjs`）。

### 5.3 反向验证要求（每条 story 至少一处）

| story | 注入的缺陷形状 | 期望变红的断言 |
|---|---|---|
| MS-1.1 | 某表的某条语句去掉 `AND site_id=?` | 该表的跨站读断言 |
| MS-1.2 | 派生表查询去掉父表 `site_id` 条件 | 该派生表的跨站详情断言 |
| MS-1.4 | `PURGE_ON_SITE_DELETE` 里删掉一张表名 | 该表的 purge 断言 |
| MS-1.5 | 删站点时**不**删 `site_users_sites` | 孤儿成员行断言 |
| MS-2.1 | 把"最长前缀"改成"第一个匹配" | 前缀优先级断言 |
| MS-3.2（方案 B） | 把 `PUT users/:id/sites/:siteId` 的站点检查去掉（`targetSite` 不再与 `siteId` 比对） | `targetSite` 越权断言（站点 admin 给自己授 B 站） |
| MS-3.4 | member cookie 名改成与 admin 相同 | 身份分离断言 |
| MS-4.3 | `scheduled()` 只查 `is_default=1` 的站点 | 按站点发布断言 |
| MS-4.4 | 把 `WHERE site_id=?` 改成 `LIMIT 1` | 三站点断言（两站点可能仍绿） |

---

## 附录 A：站点级表清单（MS-1.1 的参数）

> 来源：`src/extensions/contract/schema.ts` 的 `PLATFORM_SCHEMA`（`tenant: "site"`）。
> **新增站点级表时，往这里加一行，story 数不变。**

| # | 表 | locale | onSiteDelete | 有专门隔离断言？ |
|---|---|---|---|---|
| 1 | `admin_menu_registry` | null | purge | 🟡 |
| 2 | `field_defs` | null | purge | 🟡（有按站点清理断言，无跨站读/写） |
| 3 | `menu_items` | column | purge | 🟡 |
| 4 | `menus` | null | purge | ✅ |
| 5 | `post_types` | null | purge | 🟡 |
| 6 | `posts` | null | retain | ✅ |
| 7 | `redirects` | null | purge | ❌ |
| 8 | `rewrites` | null | purge | ❌ |
| 9 | `settings` | null | purge | ✅ |
| 10 | `site_locales` | null | purge | 🟡 |
| 11 | `taxonomies` | null | purge | ❌ |
| 12 | `terms` | null | purge | ❌ |
| 13 | `theme_blocks` | null | purge | 🟡 |
| 14 | `theme_routes` | null | purge | 🟡 |
| 15 | `theme_table_defs` | null | purge | 🟡 |
| 16 | `media_files` | null | retain | ✅ |
| 17 | `members` | null | purge | 🟡 |
| 18 | `member_sessions` | null | purge | 🟡（有身份分离断言，无跨站点会话断言） |
| 19 | `site_users_sites` | null | purge | 🟡 |
| 20 | `i18n_overrides` | column | purge | ❌ |
| 21 | `widget_instances` | column | purge | 🟡 |
| 22 | `notification_log` | null | retain | ❌ |

**统计**：✅ 4 · 🟡 12 · ❌ 6 —— **6 张表完全没有专门的隔离断言**：
`redirects`、`rewrites`、`taxonomies`、`terms`、`i18n_overrides`、`notification_log`
（`notification_log` 有去重键断言但**无跨站**断言）。**这 6 张 ❌ + 12 张只有部分覆盖的，
就是 MS-1.1 要补的全部。**

## 附录 B：派生租户表清单（MS-1.2 的参数）

| # | 表 | 父 | 有专门隔离断言？ |
|---|---|---|---|
| 1 | `post_meta` | `posts.site_id` | 🟡 |
| 2 | `post_revisions` | `posts.site_id` | ❌ |
| 3 | `post_autosaves` | `posts.site_id` | ❌ |
| 4 | `post_translations` | `posts.site_id` | 🟡 |
| 5 | `seo_meta` | `posts.site_id` | ❌ |
| 6 | `term_relationships` | `posts.site_id` | ❌ |
| 7 | `scheduled_posts` | `posts.site_id` | ❌ |

**统计**：❌ 5 / 7

## 附录 C：平台级表（MS-1.3，**故意**无 `site_id`）

`sites`、`locales`、`site_users`、`admin_sessions`、`admin_activity`、
`role_permissions`、`content_cache_versions`、`extension_versions`、
`extension_capabilities`、`plugin_installs`、`theme_installs`、
`plugin_setting_defs`、`plugin_settings`、`theme_setting_defs`、`theme_settings`、
`shortcodes`、`platform_settings`。

（外加 `RUNTIME_TABLES`：`_cf_METADATA`、`d1_migrations`，**永不触碰**。）

---

## 附录 D：待办优先级

按"危险 × 未覆盖"排序：

| 优先 | story | 为什么 |
|---|---|---|
| **P0** | MS-1.1 的 6 张 ❌ 表 | 跨站读/写/删无断言 = 静默串台 |
| **P1** | MS-4.3（计划任务多站点断言） | 实现正确但**无断言**——回归无人拦，且单站点测不出 |
| **P1** | MS-4.4（三站点） | 两站点断言可能靠巧合 |
| **P1** | MS-1.5（孤儿身份） | 与规则 80 的组合面 |
| **P2** | MS-1.2 的 5 张 ❌ 派生表 | 详情端点跨站 |
| **P2** | MS-3.4（会员逐站点） | 身份分离已覆盖大部分 |
| **P2** | MS-4.2（计数不泄露） | 实现正确，补一条断言即可 |
| **决策** | MS-3.2 方案 A/B | **不是缺陷，是产品决策**：站点 admin 该不该管本站点用户 |

---

## 修订记录

| 日期 | 变更 |
|---|---|
| 2026-10-11 | 初版。三轴 × 三节约简 → 14 条 story；附录 A/B/C 为参数清单；待办 P0–P2。 |
