# CFCMS 底层架构规划

> 状态：**设计定稿，已开始实施**（批次 1 部分完成，见 §8）
> 参照实现：`D:\1Dev\nodecms\nodecms`（Node + Express + Sequelize 版，已跑通多主题/多语言/插件/主题自有表）
> 本文回答四个问题：**多语言怎么做、主题如何变成业务包、插件边界在哪、怎么防止"功能实现了但是垃圾代码"**。
>
> 配套文件：[`AGENTS.md`](../AGENTS.md)（压缩成硬规则，供 AI 直接遵守）、
> [`tests/suites/architecture.test.mjs`](../tests/suites/architecture.test.mjs)（规则的机器执行）。

---

## 0. 先说结论：三条设计主线

在看具体方案之前，先明确这份规划的三个不可动摇的立场。后面每一节都是它们的展开。

**主线一：分层，且层与层之间只通过声明通信。**

一个功能属于哪一层，看它的生命周期归谁管：

| 生命周期 | 归属 | 例子 |
|---|---|---|
| 随平台发布/升级 | **平台核心** | 文章、页面、用户、权限、多语言开关 |
| 随主题启用/停用 | **主题** | 产品、订单、房产、宠物档案 |
| 随插件启用/停用 | **插件** | SEO、短代码、支付网关 |

主题和插件**永远不直接读写对方的表**，也不直接调用对方的函数。它们各自向平台**声明**自己要什么，平台负责兑现。这条守住了，主题和插件才能各自独立安装、卸载、升级而不互相炸掉。

**主线二：能力靠"声明 + 平台兑现"，不靠"主题自己写 SQL"。**

这是 Cloudflare Workers 平台的硬约束逼出来的，但恰好也是更好的设计。Workers 禁止 `eval` / `new Function` / 动态 `import()` 用户代码（V8 isolate 限制，不是本项目偷懒）。所以主题**不能**携带可执行 JS 在主 Worker 里跑。

于是主题描述"我要一张产品表，字段是这些"，平台建表、建 API、建后台界面。主题负责的只是**长什么样**（模板）和**什么时候用什么数据**（路由 + 查询声明）。

**主线三：所有"约定"都必须有机器强制，不能只写在文档里。**

这是用户最关心的一点——"一个很蠢的 AI 加个功能，功能实现了，但是是垃圾代码"。文档管不住 AI，**测试和类型才能**。所以本规划里每一个"应该"，都要落到下面四种机制之一：

1. **类型约束**——写错编译不过（`tsc --noEmit`）
2. **清单校验**——声明不合法就装不上（`validateManifest`）
3. **契约测试**——行为不对测试就红（`npm test`）
4. **架构测试**——越界就失败（分层依赖方向检查）

没有落到这四种里的"规范"，一律视为**没有规范**。

---

## 1. 现状诊断

### 1.1 CFCMS 已有什么

代码量约 4340 行 TypeScript，已经具备相当完整的地基：

| 已具备 | 文件 | 评价 |
|---|---|---|
| 模板引擎（无算术、10 个 helper、`@section` 插槽） | `src/rendering/template-engine.ts` (839 行) | 够用，约束明确 |
| 主题清单 + 能力落实 | `src/extensions/theme/runtime-declarative.ts` + `capabilities.ts` | **设计正确**，是本次规划的起点 |
| L3 主题 Worker 沙箱 | `src/extensions/theme/runtime-worker.ts` (429 行) | 难得，能力受控的回调 API |
| 插件 hook 运行时 | `src/extensions/plugin/runtime.ts` | 注册表 + 受控 facade，方向对 |
| 多站点（host / path_prefix） | `src/platform/sites.ts` | 已贯穿 `site_id` |
| 多语言**骨架** | `migrations/0001` 的 `locales` / `post_translations` | 有表，但缺"开关"层 |
| 清单校验 | `src/extensions/security.ts` | 已逐字段校验主题清单 |

**最重要的一点**：CFCMS 的主题声明模型（`postTypes` / `taxonomies` / `fields` / `routes` / `adminMenus` / `blocks` / `settings`）与 nodecms 的 `theme.json` + `models.js` 是**同一个思路**，只是 CFCMS 更早把它做进了 Worker 平台约束里。所以这次不是推倒重来，是**把已有骨架补全成完整体系**。

### 1.2 缺什么（本次要补的）

> **本节是规划时的诊断快照。** 截至批次 2 完成的现状：多语言开关 ✅、主题自有表 ✅、
> 内容翻译组 ✅、防烂代码机制 ✅、目录结构 ✅。**只剩「主题菜单升级为真实后台页面」
> 与「插件注册后台菜单」两项留给批次 3**（`admin_menu_registry`）。
> 下表保留原文，是为了让后来者看到"为什么要做这些事"，而不是当成待办清单。

| 缺口 | 现状 | 后果 |
|---|---|---|
| **多语言没有"平台开关"** | `locales` 表存在，但没有任何"某主题的多语言是否启用"的概念 | 用户明确要求的核心机制缺失 |
| **主题自有表无处声明** | 主题只能声明 CPT（复用 `posts` 表），不能声明真正独立的表 | 商城主题的产品只能塞进 `posts`，字段一多就崩 |
| **主题菜单只是"链接"** | `theme_admin_menus.screen` 只允许 7 个固定值，主题不能注册真实后台页面 | 主题的后台管理界面无法存在 |
| **插件不能注册后台菜单** | `adminMenus` 只在主题清单里被读取 | 插件想做后台页面没门 |
| **内容多语言是半成品** | `post_translations` 有表，但没有"翻译组"概念、没有后台联动 | 无法管理"这篇文章的英文版" |
| **没有防烂代码机制** | 只有 `tsc` 和功能测试 | 用户最担心的问题无人守 |
| **目录结构混乱** | 见 §7 | 认知负担高，AI 容易放错位置 |

### 1.3 从 nodecms 学到的、要修正的东西

参照实现在这些地方踩了坑，规划里必须绕开：

| nodecms 的问题 | 证据 | CFCMS 的修正 |
|---|---|---|
| **`beforeFind` 全局 hook 注入语言过滤** | `models/index.js:200-217` | **不用**。魔法式全局注入让"为什么查不到数据"变得无法调试。改为**显式传 locale**（CFCMS 现状已是对的） |
| **主题模型直接挂主 sequelize** | `themes/eShop/models.js` 用 `eshop_` 前缀 | 前缀是**约定**不是**强制**，AI 很容易忘。改为**由平台按主题名强制生成表名** |
| **主题自带 `admin-routes.js` 自行鉴权** | `themes/eShop/admin-routes.js:16-30` 自己 `jwt.verify` | 每个主题重写鉴权 = 必然有主题写错。改为**平台统一鉴权，主题只声明权限点** |
| **`theme-manager` 四种取主题路径层层兜底** | `core/theme-manager.js:33-79` | 过度兜底掩盖了 `theme.active` 缺失的真 bug（CFCMS 上一轮刚修过同类问题）。**单一真相，取不到就报错** |
| **主题能抄插件、插件能抄主题** | 无边界检查 | 加**架构测试**禁止 |

---

## 2. 多语言架构（核心章节）

这是最复杂的一块，也是用户明确点名的重点。**关键洞察：多语言不是一层的概念，是四层。**

先看分层，再逐层展开。

### 2.1 四层模型

```
┌─────────────────────────────────────────────────────────────┐
│ L0  平台开关层    locales / site_locales                     │
│     决定这个站点"支持哪些语言"，是后面三层的前提             │
├─────────────────────────────────────────────────────────────┤
│ L1  内容语言层    post_translations / content_groups        │
│     平台拥有的内容（文章、页面）的多语言版本                 │
├─────────────────────────────────────────────────────────────┤
│ L2  界面语言层    i18n packs（核心 / 插件 / 主题 / DB 覆盖） │
│     菜单、按钮、提示文案的翻译                               │
├─────────────────────────────────────────────────────────────┤
│ L3  主题业务语言层  主题自有表的翻译（产品、房产…）          │
│     只有该主题的多语言被启用时才存在                         │
└─────────────────────────────────────────────────────────────┘
```

**用户说的"某个主题的多语言要在平台的多语言里开启了才能起作用"，指的就是 L0 → L3 的联动。** 下面逐层说清。

### 2.2 L0：平台开关层

两张表，职责分明：

```sql
-- 平台级：这个部署认识哪些语言（语言字典，不是开关）
-- 已有，扩两列
CREATE TABLE locales (
  code       TEXT PRIMARY KEY,        -- 'zh-CN' / 'en' / 'ja'
  name       TEXT NOT NULL,           -- '简体中文' / 'English' / '日本語'
  native_name TEXT,                   -- '简体中文'（语言切换器用它，不用 name）
  direction  TEXT NOT NULL DEFAULT 'ltr',  -- 'ltr' / 'rtl'
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,   -- 新增：平台是否启用（全局）
  sort_order INTEGER NOT NULL DEFAULT 0    -- 新增：切换器排序
);

-- 站点级：这个站点启用哪些语言 + 默认是哪个
CREATE TABLE site_locales (
  site_id   TEXT NOT NULL,
  code      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,   -- 每个站点各自一个默认语言
  enabled   INTEGER NOT NULL DEFAULT 1,    -- 站点级开关
  PRIMARY KEY (site_id, code)
);
```

**为什么必须分两层**：多站点部署下，`locales` 是"这台机器装了哪些语言包"，`site_locales` 是"这个站点对外露哪几个"。一个部署里，中文站和英文站可以各露各的。CFCMS 已有 `sites` 表，这一步是自然延伸。

**`native_name` 为什么单独一列**：语言切换器上要写"简体中文"而不是"Simplified Chinese"——后者对中文用户毫无意义。这个是通用 i18n 实践，不是过度设计。

**每个站点一个默认语言**（不是全局一个）：这是 nodecms 的 `settings.siteLanguage` 做对了的地方，保留。

### 2.3 L1：内容语言层（平台内容）

**范围**：文章（`post`）、页面（`page`）——即用户说的"目前平台就只有文章，页面有多语言吧"。

现状是 `posts` + `post_translations` 已经分离了。这个结构**是对的**，只需要补一个"翻译组"概念：

```sql
-- posts 表：加两列
ALTER TABLE posts ADD COLUMN lang_group TEXT;   -- 同一内容的各语言版本共享
-- 已有 slug / type / status / site_id，slug 不再全局唯一

-- 唯一约束改为：同一站点 + 同一类型 + 同一 slug，全局唯一（跨语言也唯一）
-- 理由见下方"设计决策"
CREATE UNIQUE INDEX idx_posts_site_type_slug ON posts(site_id, type, slug);

-- post_translations：已有，保持
--   (post_id, locale) UNIQUE，存 title/excerpt/content
```

> ⚠️ **现状核对（2026-09-28 实测真实本地 D1）**：`posts` 表当前**没有任何 slug 唯一约束**，
> 只有 `idx_posts_slug`（普通索引）。应用层 `savePost` 也不做冲突检查，
> `findContent` 用 `LIMIT 1` 静默取第一条。
> 也就是说 —— **今天两个内容可以占同一个 slug，前台会静默只显示其中一个**。
> 所以这里不是"收紧一个已有约束"，而是**第一次真正加上约束**；
> 加之前要先写数据清理（找出并合并重复 slug），否则迁移会因唯一索引创建失败而中止。
> 这个检查也提醒：**`docs/` 里关于 schema 的断言必须对着真实库验一遍再写**，
> 不能照抄设计意图——本段的唯一索引就属于"计划中、尚未存在"。

**设计决策：为什么每个语言版本是独立的 `posts` 行，而不是一行多列**

| 方案 | 优点 | 缺点 | 采用 |
|---|---|---|---|
| A. 每个语言一行 + `lang_group` 关联 | slug/status/published_at 天然按语言独立；URL 天然独立；翻译可独立发布（英文版先上、中文版还没写完） | 需要在应用层维护组 | ✅ **采用** |
| B. 一行多列（`title_en`, `title_zh`） | 查询简单 | 加语言要改表结构；无法独立发布；语言数一多列爆炸 | ❌ |

关键理由是**独立发布**。多语言站点最常见的需求是"英文版已经上线，日文版还在翻译"。方案 B 做不到。额外好处：独立 slug 让 `/en/about-us` 和 `/zh/关于我们` 都自然成立。

**`slug` 唯一性为什么收紧到跨语言唯一**：nodecms 的做法是 `(slug, lang_code)` 唯一，允许 `/en/about` 和 `/zh/about` 共用 `about`。看起来方便，但会导致**同一站点下两个语言版本抢同一个无前缀 URL**——而 CFCMS 支持无前缀访问（`/about` 走默认语言）。这必然产生歧义。收紧后，谁先占 `about` 谁得，另一个必须换 slug，语义清晰。这是一个**有意偏离参照实现**的决定。

**翻译组管理（后台交互）**：

后台编辑页需要一个"语言版本条"：

```
[ 简体中文 ● ] [ English ○ ] [ 日本語 ＋ ]
     当前         已存在      未创建
```

- 点已存在的语言 → 切到该版本编辑
- 点 `＋` → 弹窗：**创建翻译**（复制当前版本作为初稿）/ **仅切换**（跳到空白的该语言） / 取消
- 保存时若当前语言版本不存在，**自动创建**（不覆盖原文）

这套交互 nodecms 已经验证过（`docs/i18n/02-content-i18n.md`），直接照搬思路，但**实现上不依赖 ORM hook**。

**查询层：显式传 locale，不用全局 hook**

这是对 nodecms 的**明确修正**：

```ts
// ✅ CFCMS 做法：每个数据访问函数显式收 locale
export async function findContent(env, type, slug, locale, siteId) { ... }

// ❌ nodecms 做法：beforeFind 全局注入
// models.Post.beforeFind(o => { o.where = {...o.where, langCode: getCurrentLang()} })
```

理由：全局 hook 看起来"零调用点改动"很优雅，但它让**调试变成噩梦**。当后台列表页查不到数据时，你必须先想起存在全局 hook，再想起当前语言上下文是什么，才能开始排查。显式参数虽然啰嗦，但**读代码就能知道会发生什么**。上一轮修的 `activeTheme` 隐式兜底 bug 就是同一个教训。

### 2.4 L2：界面语言层

这一层 nodecms 做得相当完整，**四层翻译字典叠加**的设计直接采纳：

```
① 核心语言包     langs/{lang}.json              平台自带文案
② 插件语言包     plugins/{name}/langs/{lang}.json  插件启用时注册
③ 主题语言包     themes/{name}/langs/{lang}.json   主题启用时注册
④ 数据库覆盖     settings 表 i18n.overrides        后台可改，优先级最高
```

后层覆盖前层。查找不到时**回退 key 本身**——永不空白，这个兜底是对的（它兜的是"文案没翻译"，不是"系统状态未知"，性质完全不同）。

**关键点：界面语言 ≠ 内容语言。** 这两者必须彻底分开：

| | 内容语言 (contentLang) | 界面语言 (uiLang) |
|---|---|---|
| 管什么 | 前台文章/页面显示哪个语言版本 | 后台菜单、按钮、提示文案 |
| 谁决定 | 访问者（URL 前缀 / cookie） | 管理员个人偏好 |
| 典型场景 | 英文用户看 `/en/post` | 中文站长管理英文站 |

一个中文站长管理一个纯英文站点，是**完全正常**的配置。如果合成一个语言，这个场景就崩了。CFCMS 目前没有界面语言概念，要新增：`users.ui_lang` 列 + cookie 回退 + 站点默认。

**翻译函数签名**（模板与 JS 侧统一）：

```ts
__('theme.aurora.nav.home')                    // → "首页"
__('admin.posts.count', { n: 42 })             // → "42 篇文章"
```

**key 命名规范**（强制，由架构测试检查）：

```
core.*            平台界面文案          core.admin.save
theme.{slug}.*    主题文案              theme.aurora.nav.home
plugin.{slug}.*   插件文案              plugin.seo.meta.title
```

**为什么前缀必须强制**：两个主题各自有一个叫 `nav.home` 的 key，同站切换时会互相覆盖。前缀把命名空间隔离了。这个是**必须机器检查**的（扫描所有 `langs/*.json` 的 key 前缀是否符合所属目录），写进文档没用。

> **✅ L2 已在后台 SPA 消费（批次 5）。** 落地形状：
>
> - **核心语言包**是 TS 常量（`src/platform/i18n/core-pack.ts`），en 与 zh-CN 各约 90 个 key——不依赖 R2，全新安装即有完整后台文案。
> - **可切换的界面语言列表是数据驱动的**：= 内置核心包（`CORE_PACKS`，保证完整）∪ 平台语言字典 enabled 项（`locales` 表，Languages 屏写入）∪ 覆盖层出现过的 locale。唯一定义在 `packs.ts` 的 `availableUiLocaleEntries()`，同时充当切换列表（`i18n/messages` 的 `ui_locales`）与 `ui-locale` 的校验集（`availableUiLocales`）。**添加一门界面语言是 Languages 屏上的数据操作，不改任何代码**——没有翻译的 key 由 SPA `t()` 的英文 fallback 兜底，翻译随后通过覆盖层（`i18n/overrides`）补齐。SPA 只从 `ui_locales` 派生（`i18n.js setUiLanguages()`，en 恒第一），任何一侧都不硬编码语言清单（AGENTS.md 规则 40）。
> - **站点语言的可选项也必须包含内置包**：`i18n/locales` 响应里的 `core_entries`（= `CORE_PACK_LOCALES` 的行视图，`core-pack.ts`）是 Languages 屏「Platform dictionary — not enabled here」面板的第二来源。该面板原本只列平台字典（`locales` 表），而全新安装只种了 `en` 一行——于是**每次新部署这个面板都是空的**，管理员只能把 `zh-CN` 手打进对话框，而平台其实一直带着完整的简体中文包。同文件的 `core_locales`（纯代码）长期**无人消费**，正是「声明先于运行时」的形状；`i18n` 套件现在同时钉住两个视图的集合相等。
> - **SPA 侧**只有一个叶子模块 `public/admin/js/i18n.js`：`t(key, fallback)`（字典值 → 英文 fallback → key 本身，**永不空白**）、`loadMessages()`（`GET /api/v1/i18n/messages`，一次拿全合并字典）、`setUiLocale(loc)`（`POST /api/v1/i18n/ui-locale` 持久化到 `site_users.ui_lang` + 重新拉字典）。字典缓存在 localStorage，**登录屏**在能发认证请求之前就用上次的语言渲染。
> - ⚠️ **`setUiLocale()` 是界面语言偏好的唯一写者，而且字典重载写在它内部**（规则 67）。这个事实有**两个前端读者、两条刷新路径**：后台顶部语言下拉的勾选读 `currentLocale()`（`i18n.js` 的模块级状态，只由 `setMessages()` 设置），而 Languages 屏每次挂载都重新读 `GET i18n/ui-locale`。Languages 屏的 Save 曾经**自己** POST 偏好再 `render()`，不重载字典——于是面板显示新语言、顶部下拉还勾着旧语言，**直到整页刷新**。服务端两个端点都由同一个 `resolveUiLocale` 解析、返回同一个值，所以这个分歧**只能在浏览器里看见**（`_i18n-browser.cjs` §8）。
> - **`ui_locale_follow_site` 开关（规则 52–55，默认关）可以反转上面那条解耦**：打开后，界面语言菜单只列**本站启用的语言**。它必须实现在 `packs.ts availableUiLocaleEntries()` 里，**不能放在 SPA**——同一个数组既是切换列表又是 `ui-locale` 的校验集，在服务端过滤才保得住"菜单给的 = 服务器收的"这条不变式；放前端会留下"服务器仍接受菜单不再展示的语言"。站点一门语言都没有时（pre-0011 库）回落到完整列表，绝不返回空菜单。
> - **界面语言按用户持久化**（`site_users.ui_lang`，批次 2 的列），所以**换浏览器也保持**——这也是浏览器验收脚本必须在登录后显式重置语言的原因（见 HANDOVER 坑位 23）。
> - **菜单标签的翻译消费点在服务端**：`GET /api/v1/admin-menus` 用 `resolveUiLocale` + `loadUiPacks` + `mergePacks` 解析字典，行的 `label_key` 命中字典就替换 `label`，未命中保留原文；响应带 `ui_locale`。SPA 切语言 = `setUiLocale → loadContext() → render()`，**不做任何前端二次翻译**——同一个答案只有一处定义。`label_key` 的前缀校验见 §3.5 与 AGENTS.md 规则 13d。

### 2.5 L3：主题业务语言层（本规划的重点）

现在是回答用户问题的核心：**主题自己的数据怎么多语言，且为什么必须平台开关。**

#### 2.5.1 问题陈述

一个商城主题有 `product` 表，标题"iPhone 15"要翻译成"iPhone 15"（英文）和"アイフォン15"（日文）。这个多语言：

- **不属于平台**——平台不认识"产品"这个概念（用户原话："产品默认不属于平台系统的"）
- **属于主题**——只有商城主题在用时才存在
- **但必须受平台控制**——用户原话："某个主题的多语言要在平台的多语言里开启了才能起作用"

#### 2.5.2 设计：`theme_locale_tables` 声明 + 平台生成翻译表

主题在清单里声明哪些自有表需要多语言：

```json
{
  "name": "eshop",
  "title": "EShop",
  "version": "1.0.0",
  "tables": [
    {
      "name": "product",
      "label": "Product",
      "translatable": ["name", "description"],
      "fields": [
        { "key": "name",        "type": "text",     "label": "Name" },
        { "key": "description", "type": "longtext", "label": "Description" },
        { "key": "price",       "type": "number",   "label": "Price" },
        { "key": "stock",       "type": "number",   "label": "Stock" },
        { "key": "sku",         "type": "number",   "label": "SKU" }
      ]
    },
    {
      "name": "product_category",
      "label": "Product Category",
      "translatable": ["name", "description"],
      "fields": [
        { "key": "name",        "type": "text",     "label": "Name" },
        { "key": "description", "type": "longtext", "label": "Description" },
        { "key": "sort_order",  "type": "number",   "label": "Order" }
      ]
    }
  ]
}
```

> 注意 `translatable` 里的每个 key 都必须在同一张表的 `fields[]` 里声明过（规则 16），
> 而 `fields[].type` 只有 6 种：`text` / `longtext` / `number` / `boolean` / `date` / `datetime`。
>
> ⚠️ **`fields[].type` 同时表达「要不要翻译」**（AGENTS.md 规则 41）：
> `text` / `longtext` 是**散文**，必须列进 `translatable`；另外四种是**语言中立**，
> 必须**不在** `translatable` 里。两个方向都在安装时拒绝。
> 所以上面的 `sku` 声明为 `number`——它是标识符，每种语言一个 SKU 是建模错误；
> 若写成 `text`，校验器会要求它可翻译，而那是错的。
> 分类谓词是 `contract/manifest.ts` 的 `isProseFieldType()`，**不要在别处重写**。

> **没有 `integer`**——`number` 就够了。写错类型会在**安装时**被拒（400），不会等到渲染。

平台据此**按需生成**（下面是 `theme_eshop_product` 的实际形状）：

```sql
-- 主表：平台列 + 全部声明字段
CREATE TABLE theme_eshop_product (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,          -- 平台生成：本地化 URL 用
  lang_group  TEXT NOT NULL,          -- 平台生成：翻译组
  name        TEXT,                   -- 声明式字段（translatable，同时也在主表）
  description TEXT,                   -- 声明式字段（translatable，同时也在主表）
  price       REAL,                   -- 声明式字段（number → 语言中立）
  stock       REAL,                   -- 声明式字段（number → 语言中立）
  sku         REAL,                   -- 声明式字段（number → 语言中立；标识符不是散文）
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(site_id, slug)
);

-- 翻译表：只有声明为 translatable 的字段（仅当站点服务 ≥2 种语言时才建）
CREATE TABLE theme_eshop_product_i18n (
  row_id     TEXT NOT NULL,
  locale     TEXT NOT NULL,
  name       TEXT,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (row_id, locale)
);
```

**可翻译字段为什么同时出现在两张表里**：单语言站点也必须能存产品名。`_i18n` 表在
启用第二种语言之前根本不存在，如果 `name` 只在 `_i18n` 上，单语言站连名字都没处放。
主表那一列同时充当**站点默认语言的值**——所以启用第二种语言**不需要数据迁移**，
已有值就是默认语言的值。读取时 `COALESCE(tr.k, dflt.k, m.k)` 按「请求语言 → 站点默认 → 主表」
取，**单语言与多语言两条路径返回的内容在构造上完全相同**（`table-facade.ts` 的 `readProjection`）。

> ⚠️ **`posts.lang_group` 可空，生成表的 `lang_group` 是 `NOT NULL`。** 这个不对称是有意的：
> `posts` 是既有表，SQLite 的 `ALTER TABLE` 加不了 `NOT NULL` 列；生成表是平台从零建的，
> 当然一开始就写死约束。所以"没有 `lang_group` 就是自己"这条兜底规则只对 `posts` 需要，
> 但读 `posts` 的代码**必须**按可空来写（见 §5.4③）。

**这个设计的三个要点：**

**要点一：表名由平台强制拼装，主题不能自由命名。**
格式固定为 `theme_{themeName}_{tableName}`。主题声明里 `name` 只能是小写标识符（复用 `validExtensionName`）。**AI 忘记加前缀这件事在物理上不可能发生**——它根本没机会写表名。

**要点二：`translatable` 决定哪些字段进翻译表。**
这是设计的精髓。`price` 不该多语言，"iPhone 15" 该。如果一股脑把所有字段都做多语言，价格会被翻译成不同值，产生"英文站打 8 折"这种灾难。**声明式地划清"语言相关"与"语言无关"，是这个模型最重要的价值。**

**要点三：翻译表在主表多语言未启用时不存在。**
这就是用户要的"平台开关"。流程：

```
管理员在平台「语言」页启用 en
        ↓
site_locales 插入 (default, 'en')
        ↓
平台扫描所有已激活主题的 tables[].translatable 声明
        ↓
对每个有 translatable 字段的表，若该站点已启用 ≥2 种语言 → 建 {table}_i18n 表
        ↓
主题的多语言「生效」
```

反过来，如果站点只有一种语言（`site_locales` 里 enabled 的只有一条），平台**不建** `_i18n` 表，主题的所有查询走单语言简化路径。这既是性能优化，也让"没开多语言时系统简单"成为可验证的事实。

#### 2.5.3 主题如何读写自己的表

主题**不写 SQL**。平台提供受能力约束的 facade：

```ts
// 主题 Worker 沙箱内可用的 API（经 env.HOST 回调）
const products = await host.table('product').list({ locale, limit: 20 });
const product  = await host.table('product').bySlug(slug, locale);
await host.table('product').save({ slug, price: 299, name, description }, locale);
```

平台侧实现要点：

- `host.table('product')` 里的 `'product'` 必须**在该主题清单里声明过**，否则直接抛错。这防止主题访问别的主题的表。
- 单语言模式下 `locale` 参数被忽略，直接读主表。
- 多语言模式下 `list({locale})` 做 `LEFT JOIN`，缺失翻译回退到默认语言（与 L1 的降级策略一致）。

**回退策略统一**：全系统所有多语言查询都遵循"**当前语言 → 站点默认语言 → 空**"，不抛错。理由：内容没翻译是常态，不是错误。抛错会让一个未翻译的产品导致整页 500。

### 2.6 多语言解析：URL 语义（统一规则）

这是最容易出错的地方，单独定死。CFCMS 现状（上一轮刚整改）已经是正确方向，这里正式化：

**URL 规则**

```
/{locale}/...     显式指定语言
/...              无前缀 → 站点默认语言，找不到再尝试其他语言
```

**解析优先级**（从高到低）：

1. URL 显式前缀（`/en/about`）—— 访问者明确表达了意图，**不再回退到别的语言**
2. `?lang=` 查询参数 —— 供无头 API 与预览使用
3. cookie —— 记住访问者上次选择
4. `site_locales.is_default` —— 站点默认

**关键细节：显式前缀 vs 无前缀，回退行为必须不同**

| 请求 | 找不到时 | 理由 |
|---|---|---|
| `/en/about` | **404** | 访问者说了要英文，给他中文是欺骗 |
| `/about` | 尝试其他语言 | 访问者没表达偏好，给什么都比空白好 |

这个区分在 CFCMS 现有实现（`src/index.ts:234-243`）里已经做对了，写进规范固化下来。

**切换器：列表页换段，文章页必须用翻译自己的 URL（规则 58 的推论）**

`lang_nav`（`langNav()`，`src/platform/frontend.ts`）给每个站点语言一项。
「换掉 locale 段」只对**列表页**成立——一个路径，多份翻译。**文章页不成立**：
migration 0016 起 slug 按语言，`/en/blog/<zh-slug>` 是 404，
于是切换器会在读者最想切换的那类页面上给出死链。

判据是 `post.alternates`（hreflang 已经在用的同一份数据）：
有该语言版本就用**它自己的 URL**；没有才退回换段（退回后的 404 是实话，
因为那篇确实没有那个语言的版本）。

⚠️ `buildScope`（`runtime-declarative.ts`）必须在 `post.alternates` **还是相对路径时**读取它：
下面 hreflang 那一段会把该属性整体替换成带 origin 的副本，
之后读就会把绝对 URL 塞进主题导航。具名断言在 `tests/suites/locale-url.test.mjs`。

### 2.7 实施清单

批次 2 已全部落地（2026-09-28）。下表是**完成状态 + 实际落点**，与最初规划的差异都记在
「备注」列里——路径变了，规则没变。

| 步骤 | 内容 | 实际落点 | 状态 |
|---|---|---|---|
| M1 | `locales` 加 `native_name/direction/enabled/sort_order`；新建 `site_locales` | `migrations/0011_i18n.sql` | ✅ |
| M2 | `posts` 加 `lang_group`；slug 唯一约束收紧为 `UNIQUE(site_id, type, slug)` | 同上 | ✅ |
| M3 | `site_users` 加 `ui_lang` | 同上 | ✅ |
| M4 | 新建 `i18n_overrides` 存 DB 覆盖层 | 同上 | ✅ |
| M5 | i18n 核心模块：语言包注册表 + `__()` + 语言解析 | `src/platform/i18n/`（`core-pack` / `translate` / `resolve` / `locale-registry` / `packs` / `index`） | ✅ |
| M6 | 界面语言注入（后台 API + admin SPA） | `src/platform/i18n/packs.ts`（`setPackProviders`）、`src/api.ts`、`public/admin/js/screens/languages.js` | ✅ |
| M7 | 内容翻译组 CRUD API + 后台语言版本条 | `src/api.ts`（`i18n/translations`）、`public/admin/js/screens/editor.js` | ✅ |
| M8 | 主题 `tables[]` 声明解析 + 建表 | `src/extensions/theme/tables.ts`，由 `capabilities.ts` 调用 | ✅ |
| M9 | 主题表 facade + 沙箱 API 端点 | `src/extensions/theme/table-facade.ts`、`src/extensions/theme/runtime-worker.ts` | ✅ |
| M10 | 语言包 key 前缀架构测试 | `tests/suites/architecture.test.mjs` 的 `checkLangPacks` + `themes/aurora/langs/` | ✅ |
| M11 | 语言包内联声明（主题/插件都在清单里带 `langs`） | `src/extensions/security.ts` 的 `validateInlineLangs` | ✅ 规划外新增 |
| M12 | 主题表注册表（切主题后仍能找到自己的表） | `theme_table_defs` 表，见 §6.3 | ✅ 规划外新增 |

**与规划的两处偏离，都是有意的**：

1. **`M5` 的模块落在 `src/platform/i18n/` 而不是 `src/core/i18n.ts`** ——
   批次 1 已经把 `src/core/*` 拆掉了，`platform/` 才是它的位置。
2. **多了 M11/M12 两步**。M11 是因为插件包在 `uploadExtension` 里是以 zip 原样存进 R2 的、
   从不解包，所以插件的语言包只能**内联在清单里**；M12 是因为主题切换后它的表还在，
   必须有一张注册表记住「逻辑名 → 生成的物理表名」这个映射，否则数据就再也找不到入口了。

**M2 的 slug 约束是 `UNIQUE(site_id, type, slug)`，不含 `locale`**。这不是疏漏：一个语言
版本就是一条 `posts` 行，`locale` 在 `post_translations` 上；把 `locale` 放进唯一键会让
「无前缀 URL」变得歧义（`/about` 该命中哪个语言？）。同一个 `slug` 在同站同类型下只属于
一个翻译组，语言之间用 `-2`、`-3` 之类的自由 slug 区分。

---

## 3. 主题架构

### 3.1 主题的三层形态

CFCMS 已经明确支持两种运行时，规范里正式定名：

| 层 | 名称 | 形态 | 自由度 | 用在哪 |
|---|---|---|---|---|
| **L2** | 声明式主题 | `theme.json` + HTML 模板 | 模板语法内 | 内容站、博客、企业站 |
| **L3** | Worker 主题 | 额外带 `worker.js`，跑在沙箱 isolate | 任意 JS | 复杂交互、商城、需要自定义逻辑 |

**L2 是默认，L3 是逃生舱。** 大部分主题不需要 L3。这个分级的意义是：**能让 95% 的主题不碰代码**，同时给剩下 5% 留了门。

### 3.2 主题清单（theme.json）完整 schema

这是主题与平台的**唯一契约**。定稿如下：

```jsonc
{
  // ---- 身份 ----
  "name": "eshop",                    // 必需，[a-z0-9-_]{2,64}
  "title": "EShop 商城",              // 必需，显示名
  "version": "1.0.0",                 // 必需，semver
  "author": "...",
  "description": "...",
  "screenshot": "screenshot.png",
  "runtime": "declarative",           // "declarative" | "worker"

  // ---- 主题自带语言包的语言（规则 25）----
  // ⚠️ 这是**声明**，不是开关：运行时**没有任何消费点**（激活与否只看
  // site_locales，与本字段无关）。所以它必须由一个守卫来赋予意义——
  // 声明的每种语言**必须**有 langs/{code}.json，否则安装不上。
  // 声明式主题的实际文案在 langs/{locale}.json（运行时从 R2 读）。
  "locales": ["zh-CN", "en", "ja"],

  // ---- 内联语言包（插件必须用这个形式，主题也可用）----
  // key 必须带前缀：theme.{name}. / plugin.{name}. / core.（core. 是覆盖平台文案）
  // 插件没有 langs/ 目录可读（包是 zip，从不解包），只能内联声明。
  "langs": {
    "zh-CN": { "theme.eshop.nav.home": "首页" },
    "en":    { "theme.eshop.nav.home": "Home" }
  },

  // ---- 模板 ----
  "templates": ["index", "home", "single", "page", "archive", "404"],
  "parts": ["layout", "header", "footer"],

  // ---- 平台内容扩展（复用 posts 表）----
  "postTypes": [
    {
      "name": "news",
      "label": "News",
      "labels": { "singular": "News", "plural": "News" },
      "supports": ["title", "editor", "excerpt", "thumbnail"],
      "hasArchive": true,
      "rewrite": { "slug": "news" }
    }
  ],
  "taxonomies": [
    { "name": "topic", "label": "Topic", "postTypes": ["news"], "hierarchical": false }
  ],
  "fields": [
    { "key": "source_url", "label": "Source", "type": "url", "postTypes": ["news"] }
  ],

  // ---- 主题自有表（商城/房产/宠物等主题需要）----
  // name 是逻辑名（不带斜杠）；物理表名由平台拼成 theme_{theme}_{name}。
  // fields[].type 只有 6 种：text / longtext / number / boolean / date / datetime。
  // translatable 里的每个 key 都必须在该表的 fields[] 里声明过。
  "tables": [
    {
      "name": "product",
      "label": "Product",
      "translatable": ["name", "description"],
      "fields": [
        { "key": "name",        "type": "text",     "label": "Name", "required": true },
        { "key": "description", "type": "longtext", "label": "Description" },
        { "key": "price",       "type": "number",   "label": "Price", "required": true },
        { "key": "stock",       "type": "number",   "label": "Stock" },
        { "key": "sku",         "type": "text",     "label": "SKU" }
      ],
      "hasArchive": true,
      "rewrite": { "slug": "products" }
    }
  ],

  // ---- 前台路由 ----
  //
  // `template` 直接指定模板（优先级高于层级）；`resolve` 决定读文章还是读表；
  // `query.as` 决定列表绑到哪个作用域变量（默认 posts）。三者都会被运行时消费，
  // 详见 §3.2.2。
  "routes": [
    { "path": "/products",      "template": "archive-product",
      "resolve": { "table": "product" },
      "query":   { "limit": 24, "as": "products" } },
    { "path": "/products/:slug", "template": "product-detail",
      "resolve": { "table": "product", "by": "slug" } }
  ],

  // ---- 后台菜单（本规划扩展：支持自定义页面）----
  "adminMenus": [
    { "id": "products",      "label": "产品",   "icon": "box",
      "screen": "table-list", "args": { "table": "product" },
      "capability": "content.read" },
    { "id": "shop-settings", "label": "商城设置", "icon": "settings",
      "screen": "theme-settings" },
    { "id": "orders",        "label": "订单",   "icon": "receipt",
      "screen": "custom", "args": { "view": "admin/orders.html" },
      "capability": "content.read" }
  ],

  // ---- 后台设置项 ----
  "settings": [
    { "key": "currency", "label": "货币", "type": "select",
      "options": ["CNY", "USD"], "default": "CNY" }
  ],

  // ---- L3 权限（worker 主题才需要）----
  "capabilities": ["content.read", "site.read", "menu.read", "locales.read"],
  "supports": ["blocks", "menus"]
}
```

**与现状的差异**（新增字段）：`locales`、`tables`、`adminMenus[].capability`、`adminMenus[].args.view`、`tables[].translatable`、`settings[].options`。

#### 3.2.1 `blocks[].name` 没有命名空间（重要，容易踩）

平台内置区块用 `core/` 前缀（`src/rendering/blocks.ts`：`core/paragraph`、`core/image` …），但**主题声明的区块名是纯标识符，不含斜杠**：

```jsonc
// ✅ 正确
"blocks": [{ "name": "property-card", "title": "Property Card", "template": "parts/card" }]
// ❌ 被拒：Invalid block name: theme/property-card
"blocks": [{ "name": "theme/property-card", ... }]
```

原因：`blocks[].name` 走的是 `IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/i`，与 `postTypes[].name` / `taxonomies[].name` / `fields[].key` 同一条规则。这个字段会落成 `theme_blocks` 表里的一行、并以 `UNIQUE(site_id, name)` 去重，斜杠既不合法也没必要 —— `core/` 前缀表达的是"谁内置的"，而主题区块的来源已经由 `declared_by_theme` 列记录。

**这条规则此前只存在于校验器里、没有写进文档**，是 2026-09 加校验时才被实测暴露出来的：仓库自带的集成测试当时用了 `theme/property-card`。修法是改测试（不是放宽校验），因为**拒绝是正确的**。

#### 3.2.2 前台路由：声明必须被消费（`routes[]`）

`routes[]` 的字段**曾经校验得比用得严**：`resolve.table` 在安装时被检查是否已声明、`template` 被架构测试断言必须是 `templates[]` 的一员，而运行时两个都没读 —— 路由只看 `kind`/`postType` 推模板，只把查询结果绑成固定的 `posts`。三种情况的症状完全一样：**页面渲染成功、HTTP 200、内容是错的**。现在每个字段都有明确消费点，且每一个都在 `tests/suites/theme-integration.test.mjs` 第 5c 段有活断言（把路由改回旧写法会让那一段 12 条断言变红）。

| 字段 | 语义 | 不写 / 不读会怎样 |
|---|---|---|
| `template` | **直接指定模板，优先级高于模板层级**（层级仍作为兜底） | 按 `kind`/`postType` 推；表路由没有 post type 可推 → 只能落到泛化的 `archive`/`single` |
| `resolve.table` | 该路由读**主题自有表**，不是文章 | 只读文章 → 表里的行在前台永远不可见 |
| `resolve.type` + `by` | 读文章（CPT），`by` 只能是 `slug`/`id` | —— |
| `query.as` | 列表绑到哪个作用域变量，**默认 `posts`** | 模板写 `{{#each properties}}` 会静默走 `{{else}}` 空分支 |

三条硬规则（`validateManifest` 拒绝安装）：

1. **`resolve` 必须二选一**：`type` 或 `table`。两个都写会被拒 —— 不是洁癖，是路由必须有唯一答案：两条分支都会给 `post` 赋值，后跑的那条静默覆盖前一条。
2. **`resolve.by` 只能是 `"slug"` / `"id"`**。写成 `"ID"` 会**静默按 slug 读**。
3. **`query.as` 必须匹配 `SCOPE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/`**。比 `IDENT_RE` 紧：模板表达式把标识符 token 化成 `[A-Za-z_$][A-Za-z0-9_$]*`，而 `my-list` 在 JS 里是合法属性名、在模板里却是 `my` 减 `list`（模板**没有算术运算符**）—— 绑定存在，但没有任何模板读得到它。**同一个 `as` 语义在 `{{@query ... as="x"}}` 里已经存在**，两处共用一套拼法，不新造词汇。

两条路由行为约定：

- **"地址指向一个对象、但没找到" 是 404，不是列表页。** 这条以前写不出来：`kind` 只在找到行之后才变成 `"single"`，所以 `!post && kind==="single"` **恒假**，`/products/no-such` 返回**列表页 + 200**。现在用独立的 `wantSingle` 记录"URL 指向一个对象"，与 `post` 解耦。
- **列表项的链接由路由自身路径拼**，不是硬编码 `/blog/`。路由存在的意义就是主题拥有那段 URL 空间 —— `/writing`、`/products` 的每一项都链到 `/blog/<slug>` 会全部 404。

**表路由与后台读的是同一张表**：`resolveTableForSite()` 放在 `extensions/theme/table-facade.ts`（不是 `api.ts`），因为它有两个必须一致的调用方 —— 管理 API 与前台路由。两份实现早晚会对"本站的 `product` 是哪张表"给出不同答案，症状就是后台列表与前台页面显示不同的行。

### 3.3 主题自有表：为什么用声明而不是让主题自己建表

用户提到参照实现的做法是主题带 `models.js`，自己 `sequelize.define('Product', ..., { tableName: 'eshop_products' })`。

**这个做法在 CFCMS 上不可行，且即使可行也不该用**：

| 维度 | nodecms：主题自己 define | CFCMS：声明式 |
|---|---|---|
| 平台约束 | 无 | Workers 禁止动态代码 → **物理上做不到** |
| 表名冲突 | 靠开发者记得加前缀 | 平台强制拼装 → **不可能冲突** |
| 建表时机 | 主题加载时 `sync({alter:false})` | 激活时一次性、可观测、可回滚 |
| 迁移 | 主题自己写 `runMigrations`（eShop 就有） | 平台按声明 diff，统一处理 |
| 卸载清理 | 主题可能忘 | 平台执行 `dropTables` |
| 审计 | 无 | 建表语句可导出、可审查 |

最后一条对"防错"尤其重要：**声明式让"AI 写的主题会建什么表"完全可预测**。它写的是一段 JSON，不是一段可能带 `DROP TABLE` 的代码。

### 3.4 主题切换时的数据策略

**核心原则：切换主题隐藏数据，绝不删除。**

理由：主题切换是**外观决策**，不是**数据决策**。用户换主题看看效果，不该丢掉商城的所有订单。这是 WordPress 的做法，也是正确的做法。

具体行为：

| 事件 | `posts`/`post_types`/`terms` 等声明表 | `theme_{n}_{table}` 业务表 |
|---|---|---|
| 主题 A 激活 | 写入 A 的声明，`affected_by_theme='A'` | 建表（若不存在） |
| 切到主题 B | A 的声明 `active=0`（**不删**） | B 的表建起来；A 的表**原样保留** |
| 再切回 A | A 的声明 `active=1`，数据完好 | A 的表还在，数据完好 |
| 卸载主题 A | 声明行删除；**数据行保留** | 默认**保留**；显式勾选"同时删除数据"才 drop |

「卸载时是否删数据」必须是**显式勾选 + 二次确认 + 显示将删除的行数**。默认不删。

### 3.5 主题后台菜单：从"链接"升级为"页面"

> **✅ 已落地（批次 3，`0012_admin_menu_registry.sql`）。** 本节原以"现状问题"开头；
> 现在 `ALLOWED_ADMIN_SCREENS` 有 **10 个**值，两个表屏幕由 `fields[]` 生成表单，
> 主题确实不再需要写任何后台代码。下面是实现后的形状。

**旧问题**：`ALLOWED_ADMIN_SCREENS` 只有 7 个固定值（`dashboard`/`content-list`/`content-edit`/`settings`/`media`/`custom`/`theme-settings`），且 `screen` 只是告诉 SPA "打开哪个内置页面"。主题无法提供自己的后台界面。

**设计**：`screen` 是**屏幕类型**，主题选类型并给参数，平台负责渲染。

| `screen` | 参数 | 渲染什么 | 用途 |
|---|---|---|---|
| `dashboard` | — | 仪表盘 | |
| `content-list` | `{ type }` | 平台内容的列表（含 CPT） | 新闻、产品（若走 `posts`） |
| `content-edit` | `{ type }` | 平台内容编辑器 | |
| `table-list` | `{ table }` | **主题自有表的列表**（批次 3 新增） | 商城产品、房产列表 |
| `table-edit` | `{ table }` | **主题自有表的编辑器**（批次 3 新增） | 由 `fields[]` 自动生成表单 |
| `theme-settings` | — | 主题 `settings[]` 声明的表单 | 商城设置 |
| `plugin-settings` | — | 插件 `settings[]` 声明的表单（批次 3 新增） | 插件自己的配置页 |
| `custom` | `{ view }` | 扩展自带的 HTML 片段（沙箱渲染） | 订单看板等复杂界面 |
| `media` | — | 媒体库 | |
| `settings` | — | 站点设置 | |

**`table-edit` 由 `fields[]` 自动生成表单**——这是关键。主题声明 `{ key: "price", type: "number", label: "Price" }`，平台就渲染出一个数字输入框。主题**不需要写 HTML 表单**，AI 也就**没机会写错表单**。

落地位置：`public/admin/js/table-form.js`（唯一的"字段类型 → 控件"映射表）+ `screens/table-list.js` / `screens/table-edit.js`。声明侧只有 6 种字段类型，所以映射是完备的；新增类型必须同时改这三处，否则表单会渲染出一个控件却丢掉用户输入的值（见 `table-form.js` 顶部注释）。

**`args` 按屏幕类型做 schema 校验**（§5.3）：`table-list`/`table-edit` 必须给出 `args.table`，且该表必须在本清单的 `tables[]` 里声明过；`custom` 必须给出 `args.view` 且不得越出扩展包。**理由**：参数写错的清单能装上、能激活，然后渲染出一个空白页——而报错会指向渲染器，不指向清单。

**权限统一由平台施加**：每个菜单项声明 `capability`（如 `content.read`）。菜单可见性、API 访问都由平台在这一处检查。**主题不写鉴权代码**——对照 nodecms 的 `themes/eShop/admin-routes.js` 自己 `jwt.verify` + 自己查 `user.role !== 'admin'`，那种写法必然有主题写漏。

**页面键（SPA 侧）**：`table:` 系列用**三个互不重叠的前缀**——`table:<table>` 是列表，`table-new:<table>` 是新建表单，`table-edit:<table>:<slug>` 是编辑某一行。曾经用"一个前缀 + 可选段"（`table:<table>[:<slug>]`），结果"列表"和"新建"在缺省 slug 时**是同一个页面名**：点"新增"跳回它自己所在的列表，什么也没发生。这个缺陷只有真实浏览器验收才暴露得出来（`tests/tools/_admin-menus-browser.cjs`）。

**菜单标签多语言（批次 5，迁移 `0013` 的 `label_key` 列）**：`adminMenus[]` 可以声明 `label_key`（如 `"theme.eshop.menu.products"`），**必须**匹配 owner 前缀 `theme.{name}.` / `plugin.{name}.`（`validateAdminMenus` 用 ownerName 构造正则，越界 key 让**安装失败**而不是静默不翻译——与规则 11 同一个理由）。消费点只有一个：`GET /api/v1/admin-menus` 命中合并字典就替换 `label`（§2.4）。范例 `themes/eshop/theme.json` 的三个菜单**复用既有语言包 key**（`theme.eshop.menu.*`）而不是发明第二套——两个地方需要同一个答案时共享定义。

**站点菜单编辑器（批次 5）**：管理员可以对整个站点的后台菜单做**站点级定制**——逐语言改名（en/zh-CN）、菜单项排序（箭头/拖拽）、**跨组移动**、分组改名与排序、对所有人隐藏。存为 `settings` 表里每站一份 JSON（key `admin.menu.custom`），`GET/PUT/DELETE admin-menus/custom` 三端点（写需 `settings.manage`；GET 顺带回 `can_manage`）。**唯一应用点是 `nav.js` 的纯函数 `applyMenuCustom()`**——侧栏与编辑器共用同一份定义（与 `groupOf()` 同一条纪律）。解析顺序：override[locale] → override.en → 内置/服务端翻译文案。分组 id 是 `nav.js` 内置的七个（`general`/`content`/`from-theme`/`extensions`/`appearance`/`system`/`tools`）；**移动到不存在的分组会被忽略**（项绝不消失）。排序语义：显式 order 升序在前，未排序的按内置顺序殿后（稳定排序）——编辑器的结构性变更会**物化整组显式 order**。与每用户隐藏（`menu_prefs`）叠加：有效隐藏 = 站点级 hidden ∪ 用户自己的隐藏。契约在 `tests/suites/menu-custom.test.mjs`（40 条，含纯函数逻辑与「不存在分组」注入）。

---

## 4. 插件架构

### 4.1 插件 vs 主题：边界在哪

这是最容易混的一对概念，必须说死。

| 维度 | 主题 | 插件 |
|---|---|---|
| 回答的问题 | "网站**长什么样**，承载**什么业务**" | "给网站**加什么能力**" |
| 数量 | **每个站点同时只能有 1 个** | 可以有很多个 |
| 换掉它 | 网站外观和业务全变 | 网站照常，只是少了某项功能 |
| 典型例子 | 博客主题、商城主题 | SEO、短代码、支付网关、评论审核 |
| 能声明后台菜单 | ✅ | ✅ **（本规划新增）** |
| 能声明自有表 | ✅ | ✅ 应支持，机制同主题 |
| 能改前台模板 | ✅ 拥有模板 | ❌ 只能通过 hook 注入 |
| 能声明 CPT | ✅ | ⚠️ 允许但少见（如插件提供的"作品集"类型） |

**判据（给 AI 用的决策规则）**：

> 换掉这个东西之后，网站还能正常显示吗？
> - **不能** → 它是主题
> - **能，只是功能少了** → 它是插件

举例：SEO 插件卸掉，网站还在，只是少了 meta 标签 → 插件。商城主题卸掉换成博客主题，产品页全没了 → 主题。

### 4.2 插件的能力模型：声明式 + 宿主实现

CFCMS 现有设计（`src/extensions/plugin/runtime.ts`）已经确立了正确方向，规范固化：

**插件不携带可执行 JS。** 清单声明要挂哪些 hook，宿主提供每个 hook 的实现。

```jsonc
{
  "name": "seo",
  "title": "SEO Toolkit",
  "version": "1.0.0",
  "permissions": ["content.read", "settings.read", "settings.write"],
  "hooks": ["html", "beforeSavePost", "afterSavePost"],

  // 本规划新增：插件也能注册后台菜单
  "adminMenus": [
    { "id": "seo-general", "label": "SEO", "icon": "chart",
      "screen": "plugin-settings", "capability": "settings.read" }
  ],

  // 本规划新增：插件设置项声明
  "settings": [
    { "key": "title_template", "label": "标题模板", "type": "text",
      "default": "{title} | {site}" },
    { "key": "default_description", "label": "默认描述", "type": "textarea" }
  ],

  // 本规划新增：插件声明它关心哪些语言（用于语言包校验）
  "locales": ["zh-CN", "en"]
}
```

**`DECLARABLE_HOOKS` 是白名单**（现有 `extensions.ts:54-62`），未知 hook 名被静默忽略。这个行为**要改成报错**——静默忽略会让插件作者以为 hook 生效了。改为安装时校验、不认识的 hook 名直接拒绝安装。

### 4.3 能力（capability）清单

现有 `CAPABILITIES`（`extension-security.ts:1-5`）：

```
content.read, content.write, settings.read, settings.write,
media.read, media.write, routes.register, admin.register
```

需要补充（因为新增了主题自有表和插件菜单）：

```
table.read       读主题/插件自有表
table.write      写主题/插件自有表
i18n.read        读语言包与启用的语言
i18n.write       管理翻译
```

**能力检查必须在服务端**。`pluginApi` 的 facade（`extensions.ts:344-383`）已经做对了：每个方法先 `allow(cap)` 再执行，越权直接抛 `Capability denied`。这个模式要保持。

**为什么不靠 hook 名反推能力**：hook 名是"何时执行"，能力是"能碰什么"。两者正交。一个 `html` hook 只读设置时不需要写权限，读写权限该由 `permissions` 显式声明。

### 4.4 插件菜单的实现路径

现状：`adminMenus` 只在主题清单里被读（`theme-capabilities.ts` → `theme_admin_menus` 表）。

改造：

```sql
-- 统一菜单表：主题与插件的后台菜单汇到一处
CREATE TABLE admin_menu_registry (
  id             TEXT PRIMARY KEY,
  site_id        TEXT NOT NULL,
  owner_type     TEXT NOT NULL,      -- 'theme' | 'plugin' | 'core'
  owner_name     TEXT NOT NULL,      -- 'eshop' | 'seo'
  menu_id        TEXT NOT NULL,
  label          TEXT NOT NULL,
  icon           TEXT,
  screen         TEXT NOT NULL,
  args_json      TEXT NOT NULL DEFAULT '{}',
  capability     TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(site_id, owner_type, owner_name, menu_id)
);
```

**关键：菜单有归属 (`owner_type`/`owner_name`)，所以某插件停用时，只清它的菜单，不碰别人的。**

后台 API 按 `capability` 过滤后返回给 SPA，SPA 只管渲染。**排序规则**：core 菜单按固定顺序，主题菜单紧跟内容组，插件菜单归入"扩展"组。

`theme_admin_menus` 旧表**迁移后废弃**（原方案里"或保留为视图"这条路没走）——两张表存同一件事是 bug 温床。0012 把行搬进新表后 `DROP TABLE`，`tests/tools/_apply-migrations.mjs` 会断言它不再存在。

> **✅ 已落地（批次 3）。** 实现分散在三处，各自的职责不要混：
>
> | 位置 | 职责 |
> |---|---|
> | `src/platform/admin-menus.ts` | 注册表的唯一读写口（`registerOwnerMenus` / `clearOwnerMenus` / `listAdminMenuGroups`） |
> | `src/extensions/theme/capabilities.ts` | 主题激活/停用时调上面的口，`owner_type='theme'` |
> | `src/extensions/plugin/menus.ts` | 插件启用/停用时调上面的口，`owner_type='plugin'` |
>
> **为什么读写口在 `platform/` 而不在任一扩展目录**：两种扩展都要写它。放在 `extensions/theme/`，插件路径就得 import 主题（违反 §7.3 规则 3）；放在 `extensions/plugin/` 则反过来。`platform/` 是唯一"两种扩展都能 import、且允许碰数据库"的层。
>
> **三个实现期才暴露的坑，都写进了守卫：**
>
> 1. **行主键必须内嵌 owner。** 自然键是四元组，但主键只能是一个值。旧方案 `scopedId("tam", site, menuId)` **不含 owner**，两个主题各声明一个 `main` 菜单就会撞主键——第二个主题静默覆盖第一个。现在 `menuRowId()` 内嵌四元组，并追加一个四元组的短哈希：`acme-shop` 与 `acme_shop` 会 slug 成同一个串，只靠可读部分仍会撞（`tests/suites/admin-menus.test.mjs` 第 2 段钉住这一点）。
> 2. **插件菜单是"全站"的，主题菜单是"单站"的。** 主题按站点激活，所以它的菜单按站点存；插件只有一个安装级 `enabled` 开关，没有按站点的镜像。若在启用时给每个站点写一行，就必须再挂一个"建站时补写"的钩子——**漏掉那个钩子，新站点会静默地没有插件菜单**。所以插件行写 `site_id = '*'`（`ALL_SITES`），读取时 `site_id=? OR site_id='*'`。一次写入，对尚未存在的站点也正确。
> 3. **读菜单要有 owner 的名字，而唯一正确的来源是 `settings` 的 `theme.active`。** 用 `theme_installs.active` 会在多站点上选错主题（§6.1 的老坑）。
>
> **收敛时机**：插件菜单在 `loadEnabledPlugins()` 里物化——那里本来就在回答"哪些插件是启用的、各自声明了什么"，hook 与菜单共用同一个答案。enable/disable 端点会 `resetPluginRuntime()` + `bootPluginRuntime()`，所以改动立即生效；其余请求由 boot 收敛。

---

## 5. 防错机制（防烂代码）

这是用户最强调的一点。前面所有设计都是为了"让正确的做法比错误的做法更容易"。这一节是把它制度化。

### 5.1 问题的本质

> "一个很蠢的 AI，我要它加个功能。它乱写，功能实现了，但是是垃圾代码。"

拆解这句话，坏代码有**四种**，防御手段各不相同：

| 坏代码类型 | 长什么样 | 为什么危险 |
|---|---|---|
| **A. 功能对但越界** | 主题直接读 `posts` 表、插件调主题的函数 | 今天能跑，明天另一个模块一改就炸 |
| **B. 功能对但重复** | 三个主题各写一份 `esc()`、各写一份鉴权 | 修 bug 要修 N 处，必然漏 |
| **C. 功能对但脆弱** | 假设 `site_id` 一定是 `'default'`、假设 locale 是 `en` | 多站点/多语言一开就崩 |
| **D. 功能对但不可维护** | 一个函数 800 行、命名 `doStuff2`、注释说"临时方案" | 无法阅读，无法安全修改 |

通用 AI 的问题在于它**只检查 A 里的"功能对不对"**，其余三类它看不见。所以必须用机器来挡。

### 5.2 防线一：类型约束（挡 C 类）

**现状**：`tsc --noEmit` 已经跑，0 错误。要把它变成**更硬的约束**。

具体做法：

```ts
// ❌ 坏：siteId 可选，容易忘，忘了就隐式落到 default
export async function findContent(env, type, slug, locale, siteId = "default") {}

// ✅ 好：siteId 与 locale 是必填的位置参数，忘记传就编译不过
export async function findContent(
  env: Env, type: string, slug: string,
  locale: string, siteId: string
): Promise<ContentRow | null> {}
```

**去掉所有 `siteId = "default"` 的默认值**。这是最有价值的一条类型约束——它把"忘记传站点"从运行时静默错误变成编译期错误。上一轮的 `activeTheme` bug 正是"隐式默认值掩盖了状态缺失"。

代价：调用点要全部改。值得。

### 5.3 防线二：清单校验（挡 A 类的前半）

**现状**：`extension-security.ts` 的 `validateManifest` 已经逐字段校验。要**加强并覆盖新字段**：

```ts
// 新增校验
- tables[].name        必须匹配 /^[a-z][a-z0-9_]{1,63}$/
- tables[].translatable 必须是 fields 里存在的 key（否则翻译一个不存在的字段）
- tables[].fields[].key 不得与平台保留字冲突（id/site_id/slug/lang_group/status/created_at/updated_at）
- adminMenus[].id       必须是纯标识符（IDENT_RE），且同一扩展内不得重复
- adminMenus[].screen   必须在 ALLOWED_ADMIN_SCREENS 里（现 10 个）
- adminMenus[].capability 必须在 CAPABILITIES 里
- adminMenus[].args      按 screen 类型做 schema 校验：
                          'table-list'/'table-edit' → args.table 必填且必须已声明
                          'custom'                 → args.view 必填且必须是相对路径
                          其余 screen              → args 允许为空对象
- routes[].resolve.table 必须已声明
- routes[].resolve       必须二选一（type | table），不能都写也不能都不写
- routes[].resolve.by    只能是 "slug" / "id"（写错会静默按 slug 读）
- routes[].resolve.type  必须是标识符
- routes[].template      必须是合法模板名（它现在真的会去选模板）
- routes[].query         必须是对象；query.as 必须匹配 SCOPE_NAME_RE
- locales[]             必须是合法语言代码格式
- 所有 key 前缀           语言包文件里的 key 必须匹配 L2 命名规范（见 §5.5）
- langs{}               内联语言包：locale 必须是合法代码、value 必须是字符串、
                        每个 key 必须带 theme.{name}. / plugin.{name}. / core. 前缀
```

**批次 3 的收口：`adminMenus` 校验抽成了共享函数 `validateAdminMenus(menus, declaredTables, ownerType)`**，
主题与插件走**同一份**校验（`validateManifest` 里按 `type` 分派）。这条不是重构洁癖——两套写法
早晚会分叉，而分叉的那一刻，"插件菜单能不能用某个 screen"就没有唯一答案了。

插件侧多两条硬边界：

- **`table-list` / `table-edit` 对插件一律拒绝**。这两个 screen 渲染的是**主题声明的表**，
  插件没有 `tables[]` 可依赖（见下一条），放行只会得到一个渲染期 500。
- **插件的 `tables[]` 被明确拒绝**（报错，不是忽略）。原因是结构性的：`theme_table_defs`
  目前只有 `theme_name` 列，要支持插件自有表必须**重建该表**（SQLite 不能 `ALTER` 主键/UNIQUE），
  属批次 4。**静默忽略一个已声明的能力比拒绝它更危险**——作者会以为表建好了。

`langs` 那条是本批次新增的（M11）。**插件为什么把语言包内联在清单里**：`uploadExtension`
把插件包当 zip 原样存进 R2，从不解包，所以插件没有"一个 `langs/` 目录"可以读。
主题有（`themes/<name>/langs/<locale>.json`，运行时从 R2 读），插件只能声明。

两个扩展都定义 `nav.home` 时，谁生效取决于加载顺序，而且**没有正确的修复位置**——
所以前缀不是风格要求，是让 key 全局唯一、且冲突时能一眼看出该改谁。校验必须拦住它：
`tests/suites/manifest-validation.test.mjs` 第 11 段里每条规则都有
「注入缺陷 → 断言必须抛错」的用例（现 54 条断言，其中 8 条专为批次 3 的菜单规则新增）。

**校验失败必须让安装失败，不能警告后继续。** 一个装不上的主题胜过半个能跑的主题。

### 5.4 防线三：契约测试（挡 B/C 类）

**现状**：12 个套件，且是**驱动真实 Worker 源码 + 真实本地 D1**，这个基础很好。
判据是 **0 failures**，不要把断言数写死当验收标准——数字会随套件增减。

> 批次 3 新增 `tests/suites/admin-menus.test.mjs`（43 条断言）：注册表 schema、`menuRowId` 防碰撞、
> 归属隔离、排序、能力过滤、主题注册、插件注册、**停用插件只删它自己的菜单**、
> **安装级插件菜单对新站点立即可见**、主题切走/切回。另有两个真实浏览器脚本
> （`tests/tools/_i18n-browser.cjs`、`tests/tools/_admin-menus-browser.cjs`）。

要补的测试类型：

**① 多语言契约测试**

```
- 未启用多语言时，主题自有表不建 _i18n 表
- 启用 en 后，_i18n 表出现
- 单语言模式下 table.list({locale:'en'}) 忽略 locale 参数
- 多语言模式下，缺翻译回退到默认语言（不是空、不报错）
- 显式前缀 /en/xxx 找不到 → 404（不回退）
- 无前缀 /xxx 找不到 → 尝试其他语言
- price 字段（非 translatable）在两种语言下值相同
- name 字段（translatable）在两种语言下值不同
```

最后两条尤其重要——它们**直接验证"translatable 划分是否正确工作"**。这是本设计最核心的语义。

**已落地**：`tests/suites/i18n.test.mjs`（62 条断言，0 failures，可重复）。八条全覆盖，其中承重的
两条是「`price` 跨语言同值」和「`name` 跨语言不同值」——一个商店在英文站少收 20% 就是这两条
没守住的样子。用例里的 fixture 主题 `eshoptheme` 声明了一张表 `product`，
`translatable: ["name","description"]`，字段 `price/sku/name/description`。

浏览器侧的验收（真实 Chromium 打真实 `wrangler dev`）在 `tests/tools/_i18n-browser.cjs`：22 条断言，
覆盖登录 → 语言开关 → 编辑器语言版本条 → 建翻译 → 删翻译 → 停用语言，并断言零 console 错误、
零失败请求、零 5xx。它**自己清理自己**（建出来的版本当场删掉、语言停用回原样），所以可以重复跑。

**③ 一个必须记住的坑：`lang_group` 是可空的**

`lang_group` 允许为 NULL，一行没有它时**用它自己的 id 当组名**。这个规则必须在**查和写两边
写成同一个表达式**：

```ts
const GROUP_SQL = "COALESCE(NULLIF(TRIM(p.lang_group), ''), p.id)";
function groupOf(row) { return String(row?.lang_group ?? "").trim() || String(row?.id ?? ""); }
```

只写 `WHERE p.lang_group = ?` 会把**组名所指的那一行自己**排除掉（它的 `lang_group` 是 NULL），
于是这个组看起来是空的：编辑器报告该语言缺失，并诱导用户**再建一个已经存在的语言的副本**。
迁移前写入的数据、任何不写这一列的外部导入，都会踩到这里。
`tests/suites/i18n.test.mjs` 第 9b 段专门守它（两处调用点都反向验证过：注入旧写法 → 断言确实变红）。

**教训（第三次同类）**：「同一意图的另一种写法」是这类 bug 的固定来源。凡是一个概念有两处
表达（JS 表达式 ↔ SQL 表达式、字符串 ↔ 常量、路径 ↔ 字符串匹配），就必须让两处**共用同一个
定义**，而不是各写一遍看起来等价的版本。

**② 架构测试（新增，关键）**

这是挡 B 类"越界与重复"的机器。

```js
// tests/suites/architecture.test.mjs

test('核心层不依赖主题层', () => {
  // src/core/*.ts 不得 import 任何 themes/ 目录下的东西
});

test('主题不得直接写 SQL', () => {
  // themes/**/* 不得出现 env.DB.prepare / SELECT / INSERT
  // 主题只能通过 host.table() facade
});

test('插件不得 import 主题', () => {
  // plugins/**/* 不得 import themes/**
});

test('无未声明的表名', () => {
  // 全仓搜索 /theme_[a-z]+_/ 字面量，必须都能对应到某个主题的声明
});

test('语言包 key 前缀正确', () => {
  // themes/aurora/langs/zh-CN.json 的 key 必须全部以 'theme.aurora.' 开头
  // plugins/seo/langs/en.json 的 key 必须全部以 'plugin.seo.' 开头
});

test('无硬编码 site_id', () => {
  // src/**/*.ts 不得出现 siteId = "default" 的默认参数
  // 出现即失败（防止有人把默认值加回来）
});

test('每个 cap 检查成对出现', () => {
  // 新增的 facade 方法必须同时有 allow() 与 deny 路径
});
```

**这些测试的价值在于它们是"无情的"**。AI 写新代码时，如果越界，测试立刻红。它不需要"理解架构"，只需要"运行测试"。

**已落地**：`tests/suites/architecture.test.mjs` 现有 13 项检查。批次 3 新增 3 项：

1. **`ALLOWED_ADMIN_SCREENS` 被钉住**（集合相等，不是"包含"）——加屏幕必须同时改测试，
   否则"这个 screen 存不存在"就没有唯一答案。
2. **仓库里每个已声明的菜单都用了已知 screen，且 `table-*` 引用的表真的在某个主题的 `tables[]` 里**——
   这条会读真实清单文件，不是读源码字符串。
3. **`src/` 与 0012 之后的迁移不得再引用 `theme_admin_menus`**（比对前剥掉注释）——
   守住"旧表已退役"，防止有人从历史提交里复制粘贴回来。

**③ 主题一致性测试**

```
- 主题声明的每个 template 都存在对应文件
- 主题声明的每个 adminMenu 的 screen/args 组合合法
- 主题声明 locales 后，langs/ 下有对应语言包文件
```

### 5.5 防线四：脚手架与模板（挡 D 类）

**这是最实用的一条，也是最容易被忽略的。**

AI 写代码烂，很大原因是**没有好的起点**。让它从空白文件开始写，它只能自由发挥。

做法：提供生成器。

```bash
npm run make:theme -- my-shop     # 生成主题骨架
npm run make:plugin -- my-seo     # 生成插件骨架
npm run make:table -- <theme> <table>  # 生成表声明片段
```

生成的骨架里：

- 目录结构已经对
- `theme.json` 已经填好必需字段和注释
- `langs/zh-CN.json` + `langs/en.json` 已就位（key 前缀已对）
- 模板里已经用了正确的 helper 写法（`{{len(posts)}}` 而不是 `{{posts.length}}`）
- 已经包含一个可跑通的最小示例

**原理**：让 AI 做"填空"而不是"创作"。填空出错的概率远低于创作。而且生成的骨架**天然通过架构测试**，AI 改动时越界会立刻被发现。

### 5.6 防线五：约定优于配置（减少 AI 的选择空间）

**每给 AI 一个"你可以自己决定"的机会，就多一个写烂的机会。**

所以：

| 事项 | 不让 AI 决定，而是 | 理由 |
|---|---|---|
| 表名 | 平台按 `theme_{name}_{table}` 拼 | 冲突不可能 |
| 语言包路径 | 固定 `langs/{code}.json` | 找不到是常见 bug |
| 后台表单 | 由 `fields[]` 自动生成 | 手写表单必然有漏 |
| 鉴权 | 平台统一施加 | 手写鉴权必然有漏 |
| 排序 | 声明 `sort_order` | 默认按名字，够用 |
| 错误处理 | facade 内部统一抛错 | 每处自己 try/catch 是灾难 |

**反过来说：把自由度集中在"真正需要创意的地方"——模板长什么样、业务逻辑是什么。** 其余全部收走。

### 5.7 防错机制的落地顺序

不是所有防线同等紧急。按性价比排序：

| 优先级 | 机制 | 工作量 | 收益 | 状态 |
|---|---|---|---|---|
| **P0** | 架构测试（§5.4②） | 小 | **最大**。写一次，永久生效，挡住所有越界 | ✅ **已完成** |
| **P0** | 清单校验加强（§5.3） | 小 | 大。主题装不上好过跑一半 | ✅ 已完成（测试侧）；`validateManifest` 加强待做 |
| **P1** | 去掉 `siteId` 默认值（§5.2） | 中 | 大。编译期挡 C 类 | ⏳ 棘轮守着，26 处待清理 |
| **P1** | 脚手架（§5.5） | 中 | 大。降低 AI 犯错概率 | ⏳ 待做 |
| **P2** | 多语言契约测试（§5.4①） | 中 | 中高 | ⏳ 批次 2 |
| **P2** | 主题一致性测试（§5.4③） | 小 | 中 | ✅ 已完成（并入架构测试） |

**P0 已落地**。架构测试 + 清单校验是一天之内能做完的事，而它们能挡住后面
80% 的架构腐化。已建内容与验证记录见 §8 批次 1 的进度表。

---

## 6. 数据库表总览

按归属分类，**这是"哪些表属于平台、哪些属于主题"的唯一权威清单**。

### 6.1 平台核心表

| 表 | 归属 | 说明 |
|---|---|---|
| `sites` | 平台 | 多站点注册表 |
| `settings` | 平台 | 键值配置（按 site_id） |
| `locales` | 平台 | 语言字典 |
| `site_locales` | 平台 | **新增**，站点启用哪些语言 |
| `posts` | 平台 | 文章/页面/CPT（共用，`type` 区分） |
| `post_translations` | 平台 | 内容翻译 |
| `post_meta` | 平台 | 自定义字段值；**0019 起按语言**（键 `post_id,meta_key,locale`，读阶梯唯一定义 `platform/post-meta.ts`，规则 70） |
| `users` / `roles` / `permissions` / `sessions` | 平台 | 权限体系 |
| `media` | 平台 | 媒体库 |
| `menus` / `menu_items` | 平台 | 前台导航 |
| `admin_menu_registry` | 平台 | **已落地**（批次 3，0012），后台菜单统一注册表。主题与插件走同一条注册路径，`owner_type`/`owner_name` 决定停用谁时清谁。旧表 `theme_admin_menus` 已 `DROP`。批次 5 加 `label_key` 列（0013，菜单标签的字典 key，见 §3.5）。见 §4.4 |
| `i18n_overrides` | 平台 | **新增**，界面翻译覆盖（L2 最高优先层） |
| `theme_table_defs` | 平台 | **新增**，主题自有表的注册表：`logical_name → table_name / i18n_table / fields`。见 §6.3 |

> 表里写的是 `users`/`roles`/…，但**实际的管理员账号表叫 `site_users`**（`M3` 加的是
> `site_users.ui_lang`；批次 5 的 0013 又加了 `menu_prefs`——per-user 隐藏菜单的
> JSON 数组，纯 UI 层语义见 §3.5 / AGENTS.md 规则 38）。`sessions`/`users` 在本仓库
> 并不存在——别照着这行去写迁移。

### 6.2 主题声明表（平台代管，数据属主题）

| 表 | 说明 |
|---|---|
| `post_types` | 主题声明的 CPT（复用 `posts`） |
| `taxonomies` / `terms` / `term_relationships` | 分类法 |
| `field_defs` | 自定义字段定义 |
| `theme_routes` | 主题路由 |
| `theme_blocks` | 主题区块 |
| `theme_setting_defs` / `theme_settings` | 主题设置 |
| `theme_installs` | 主题安装记录（含 manifest） |

> **后台菜单不在这个表里了。** 它曾经是 `theme_admin_menus`，批次 3 起归入
> `admin_menu_registry`（§6.1 / §4.4）——因为插件也要注册菜单，而"主题的菜单表"这个
> 形状本身就把插件挡在门外。

### 6.3 主题自有业务表（动态生成）

| 表模式 | 说明 |
|---|---|
| `theme_{theme}_{table}` | 主题声明的业务主表（如 `theme_eshop_product`） |
| `theme_{theme}_{table}_i18n` | 翻译表，**仅当站点启用 ≥2 语言时才建** |

生成规则由 `src/extensions/theme/tables.ts` 持有，**表名永远由平台拼**，主题清单里写的是
逻辑名（`product`），不写物理表名。

`theme_table_defs` 记录这个映射（`site_id + theme_name + logical_name → table_name / i18n_table`）。
存在的理由只有一条：**主题切换后，它的表和数据都还在**（§3.4「只删声明、保留数据」）。
如果物理表名每次都从清单现推，那么主题一旦停用，清单没了，那些数据就永远没有入口了。

两条不变量：

- `i18n_table` 只在站点变多语言时被填上，**之后永不清回 NULL**。语言被停用不代表翻译数据
  该消失——重新启用时它们必须原样还在。
- 主表用 `ALTER TABLE ADD COLUMN` 增量补字段，**从不删列**。删列会丢数据，而"清单里去掉一个
  字段"和"我要删掉这一列的数据"是两件不同的事。

字段名不得与保留列冲突（`id` / `site_id` / `slug` / `lang_group` / `status` / `created_at` /
`updated_at`），这条由清单校验拦下（AGENTS.md 规则 17）。

### 6.4 插件表

| 表 | 说明 |
|---|---|
| `plugin_installs` | 插件安装记录 |
| `plugin_setting_defs` / `plugin_settings` | 插件设置 |
| `extension_capabilities` | 能力授权记录 |
| `plugin_{plugin}_{table}` | 插件自有表（⏳ **推迟到批次 4**；机制与主题同源，但 `theme_table_defs` 目前只有 `theme_name` 列，要支持插件得把它泛化成 owner 概念——这是一次表重建，不是加一列） |

**命名约定（强制）**：扩展生成的表一律带**归属前缀**——主题 `theme_{theme}_{table}`、
插件 `plugin_{plugin}_{table}`。这让"哪些表是扩展生成的、属于谁"一眼可辨，也让架构测试有稳定
的匹配模式（`isGeneratedThemeTable` 只认 `theme_` 前缀，所以它不会误把平台表当成主题表）。

> 前缀是**归属标记，不是装饰**。没有它，平台就没法回答"这张表能不能删"——而"切主题时该不该
> 动这张表"正是靠这个答案决定的。

---

## 7. 目录结构重整

现状的问题：**根目录散落着 `src/`、`themes/`、`plugins/`、`public/`、`migrations/`、`tests/`、`docs/`、`scripts/`，同时 `public/admin/` 里塞了 4 个 JS 文件（1883 行）却没有任何目录层次。** 更麻烦的是 `src/core/` 里 22 个文件平铺，看不出分层。

### 7.1 目标结构

```
cfpress/
├── src/                          # Worker 源码
│   ├── index.ts                  # 入口：只在路由分发
│   ├── api.ts                    # 管理 API
│   │
│   ├── platform/                 # ── 平台层（不认识主题/插件）──
│   │   ├── admin-menus.ts        # ✅ 后台菜单注册表（主题/插件/核心共用的唯一读写入口）
│   │   ├── i18n/                 # ✅ 多语言四层
│   │   │   ├── core-pack.ts          # L2 内置核心语言包（TS 常量，不依赖 R2）
│   │   │   ├── translate.ts          # interpolate / createTranslator / mergePacks
│   │   │   ├── resolve.ts            # 路径 → ?lang= → cookie → 站点默认
│   │   │   ├── locale-registry.ts    # L0 站点语言开关 + 增删改
│   │   │   ├── packs.ts              # L2 分层装配 + setPackProviders 注入槽
│   │   │   └── index.ts              # barrel
│   │   ├── auth/                 # 认证与权限（当前 auth.ts）
│   │   ├── sites.ts              # 多站点
│   │   ├── frontend.ts           # 前台内容查询
│   │   ├── permissions.ts  seo.ts  revisions.ts
│   │
│   ├── rendering/                # ── 渲染层 ──
│   │   ├── template-engine.ts
│   │   ├── template-resolver.ts  # WP 式模板层级
│   │   └── blocks.ts
│   │
│   ├── extensions/               # ── 扩展层（主题 + 插件）──
│   │   ├── contract/             # 两层共享的契约
│   │   │   ├── hooks.ts          # ✅ HostHooks 接口 + NULL_HOOKS + 注入槽 + DECLARABLE_HOOKS
│   │   │   ├── manifest.ts       # ✅ 词汇表（屏幕/字段类型/保留列/名字正则）+ 声明模型
│   │   │   ├── validation.ts     # ✅ 安装边界：validateManifest（§5.3）
│   │   │   └── capabilities.ts   # ✅ 能力枚举 + isCapability() 守卫
│   │   ├── security.ts           # ✅ 只剩 safeZipPath / sha256
│   │   ├── theme/
│   │   │   ├── runtime-declarative.ts  # ✅ 声明式渲染
│   │   │   ├── runtime-worker.ts       # ✅ L3 沙箱（含 table/* 端点）
│   │   │   ├── capabilities.ts         # ✅ 声明落实（建表/建菜单）
│   │   │   ├── templates.ts            # ✅ 模板加载与缓存
│   │   │   ├── tables.ts               # ✅ 自有表 DDL 生成 + theme_table_defs 注册表
│   │   │   ├── table-facade.ts         # ✅ 宿主侧表访问（读投影 / 写分派）
│   │   │   ├── packs.ts                # ✅ 主题语言包提供者（R2）
│   │   │   └── admin-screens.ts        # ✖ 不再需要：后台屏幕改为**由声明生成**（§3.5）
│   │   ├── plugin/
│   │   │   ├── runtime.ts        # ✅ 已落地：hook 注册表 + 运行时装配 + 启用插件时注册菜单
│   │   │   ├── menus.ts          # ✅ 插件菜单（写一次 site_id='*'）
│   │   │   ├── packs.ts          # ✅ 插件内联语言包提供者
│   │   │   ├── hooks.ts          # ✖ 不再需要：hook 目录统一在 contract/hooks.ts（单一事实源）
│   │   │   └── facade.ts         # ✖ 不再需要：能力门面就是 runtime.ts 的导出
│   │
│   └── shared/                   # 纯工具，无业务依赖
│       ├── types.ts  crypto.ts  repo.ts  cache.ts  scheduler.ts
│
├── themes/                       # 主题（数据包，不是源码）
│   ├── aurora/
│   │   ├── theme.json
│   │   ├── screenshot.png
│   │   ├── templates/
│   │   │   ├── layout.html      # 或 parts/layout.html
│   │   │   ├── index.html  home.html  single.html  page.html
│   │   │   ├── archive.html  404.html
│   │   │   └── parts/           # header/footer/tokens
│   │   ├── assets/              # css / js / images
│   │   └── langs/               # zh-CN.json / en.json
│   └── eshop/                   # ★ 范例（批次 4）：主题自有表 + 生成式后台屏 + 声明式路由
│       ├── theme.json           #   tables[] / adminMenus[] / routes[].resolve / query.as
│       ├── templates/           #   archive-product / single-product 走 resolve.table
│       │   └── parts/           #   layout.html（\@section 插槽）
│       └── langs/               #   en.json / zh-CN.json，key 全带 theme.eshop. 前缀
│
├── plugins/
│   └── seo/
│       ├── plugin.json           # 语言包内联在这里的 `langs{}`，不在这里建目录
│       └── views/                # 后台 HTML 片段（custom screen 用）
│
├── public/admin/                 # 后台 SPA（零构建，纯原生 ESM）
│   ├── index.html
│   ├── admin.css
│   ├── icons.js                  # 内联 SVG，禁引 CDN（有加载竞态）
│   ├── ui.js                     # UI kit：主题 / toast / 对话框 / 下拉 / 格式化
│   └── js/
│       ├── admin.js              # 入口：只做装配 + WINDOW_HANDLERS（< 120 行）
│       ├── state.js              # 共享 state + API 帮手（叶子模块）
│       ├── nav.js                # 导航模型 / 侧栏 / header（纯 markup）
│       ├── shell.js              # render 循环 + 页面骨架 + 页名分发（不得 import 任何屏幕）
│       ├── auth.js               # 登录屏（注入进 shell）
│       ├── table-form.js         # ✅ 字段类型 → 控件 的唯一映射 + date/datetime 往返
│       └── screens/
│           ├── index.js          # 页名 → 屏幕 注册表（唯一 import 全部屏幕的模块）
│           ├── dashboard.js  content-list.js  editor.js
│           ├── media.js  themes.js  plugins.js
│           ├── languages.js      # L0 站点语言 + L2 界面语言
│           ├── sites.js  users.js  settings.js  menus.js
│           ├── theme-menu.js     # ✅ 统一菜单分发器（menu:<id>）
│           └── table-list.js  table-edit.js     # ✅ 生成式：列与控件来自 fields[]
│
├── migrations/                   # D1 迁移，编号递增
├── tests/
│   ├── architecture.test.mjs     # ★ 分层与越界检查（13 项）
│   ├── _extension-rules.mjs      # ★ 架构规则的**唯一**实现，三个套件共用（勿抄一份）
│   ├── manifest-validation.test.mjs
│   ├── admin-menus.test.mjs      # ★ 菜单注册表契约（归属隔离 / 安装级可见）
│   ├── i18n.test.mjs             # ★ 多语言四层契约（§5.4①）
│   ├── _i18n-browser.cjs         # ★ 真实 Chromium 打真实 wrangler dev
│   ├── _admin-menus-browser.cjs  # ★ 菜单 + 生成式屏幕的真实浏览器验收
│   ├── admin-spa.test.mjs        # 后台结构守门人（模块图 + window.* 契约）
│   ├── scaffold.test.mjs         # ★ 生成器产物过真实校验器 / 引擎 / 架构规则
│   ├── theme-fixture.test.mjs    # ★ fixture 主题：声明与模板互相自洽
│   ├── plugin-channels.test.mjs  # ★ 通知渠道运行时（webhook + 去重台账）
│   ├── plugin-pages.test.mjs     # ★ 插件声明式后台页面（规则 49/50 + 渲染器真渲染）
│   ├── _plugin-pages-inject.mjs  # ★ 上者的反向验证工具（10 个场景，手工跑）
│   ├── _apply-migrations.mjs     # 本地迁移（**别用 wrangler CLI**，见 HANDOVER）
│   └── run-all.mjs
├── scripts/
│   ├── _scaffold.mjs             # ✅ 脚手架共用件（名字校验 / 写树不覆盖 / 参数解析）
│   ├── make-theme.mjs            # ✅ 生成主题骨架（刻意不声明 tables[]，见下）
│   ├── make-plugin.mjs           # ✅ 生成插件骨架
│   ├── make-table.mjs            # ✅ 生成 tables[] + adminMenus 片段，可 --write 合并
│   ├── deploy-theme.mjs
│   └── seed-demo-content.mjs
├── docs/
│   ├── ARCHITECTURE.md           # 本文
│   ├── HANDOVER.md               # 交接文档
│   ├── I18N.md                   # ✅ 已写（批次 4）：四层模型 + 三条不变量 + 排查表
│   ├── THEME-DEV.md              # ✅ 已写（批次 4）：模板语言五条硬规则 + 清单字段
│   ├── PLUGIN-DEV.md             # ✅ 已写（批次 4）：插件不发代码 + 7 个可声明 hook
│   └── THEME-ARCHITECTURE-PLAN.md  # 历史方案（保留）
├── public/                       # 纯静态资源（favicon 等）
└── wrangler.jsonc
```

> 上图是**最终形态**，不是当前状态。后台 SPA 现在仍在 `public/admin/` 下
> （模块结构与上图一致，只差外层目录名），原因见 §7.2 的说明。

### 7.2 重整要点

| 变化 | 现状 | 目标理由 | 状态 |
|---|---|---|---|
| `src/core/*` 平铺 19 文件 | 全部在 `src/core/` | 拆成 `platform/` `rendering/` `extensions/` `shared/` 四个**有依赖方向**的目录 | ✅ 已完成 |
| 主题与插件解耦 | `theme-runtime` 直接 import 插件运行时 | 新增 `extensions/contract/hooks.ts` 做依赖倒置，红线 4 才真正成立 | ✅ 已完成 |
| 后台 JS 拆文件 | `admin.js` 1514 行单文件 | 每个屏幕一个文件，改一个屏幕不必读全部 | ✅ 已完成 |
| `public/admin/` → `admin/` | 仍在 `public/admin/`（4 文件 → 22 模块） | 与"静态资源"区分开 | ⏳ **推迟**（见下） |
| 主题加 `assets/` | CSS/JS 散在模板里 | 主题资源有归属 | ⏳ 待做（批次 2/4） |
| 主题加 `langs/` | 无 | 多语言必需 | ⏳ 待做（批次 2） |
| 测试分 `contract/` `integration/` | 全平铺 | 契约 vs 集成，失败时知道查哪 | ⏳ 待做 |
| 新增 `scripts/make-*.mjs` | 无 | 脚手架（§5.5） | ✅ **批次 4 已完成**（生成器可被 import，见 §8 批次 4.2） |

> **为什么 `public/admin/` 没有搬到仓库根的 `admin/`**：`wrangler.jsonc` 的
> `assets.directory` 只接受**一个**目录，而 `/admin/*` 这个 URL 空间必须保留
> （`src/index.ts` 把 `/admin` 与 `/admin/` 前缀交给 `env.ASSETS.fetch()`，
> `robots.txt` 也依赖它）。把目录搬到仓库根就意味着要么再起一个静态目录、
> 要么把 `public/` 整个重构——两者都与"后台 JS 拆分"这件正交的事无关。
> 因此本轮只做拆分、不动位置；目录搬迁等 `public/` 的资源归属一并规划时再做。
> §7.1 的目标树里画的 `admin/` 是**最终形态**，不是本轮承诺。

#### 后台 SPA 的模块结构（已落地）

```
public/admin/
├── index.html            入口（无需改动：本来就是 type="module" 引 admin.js）
├── admin.css  favicon.svg
├── admin.js              入口：只有装配与 window.* 注册（< 120 行）
├── ui.js  icons.js       UI kit 与图标（本轮未拆）
└── js/
    ├── state.js          共享 state + API 帮手（**叶子模块**，不 import 任何东西）
    ├── nav.js            导航模型 / 侧栏 / header（纯 markup 构造，不调用 render）
    ├── shell.js          render 循环 + 页面骨架 + 导航动作 + 屏幕注册表
    ├── auth.js           登录屏 / 登录 / 登出
    └── screens/
        ├── index.js      页名 → 屏幕 的注册表（唯一 import 全部屏幕的模块）
        ├── dashboard.js  content-list.js  editor.js  media.js
        ├── resources.js  urls.js  settings.js  seo.js
        ├── sites.js  users.js  search.js  menus.js  widgets.js
        ├── themes.js  plugins.js  extension-install.js  theme-menu.js
```

**两条结构约束（`tests/suites/admin-spa.test.mjs` 机器强制）**：

1. **模块图无环，且没有孤儿模块。** 关键在于 `shell.js` **不 import 任何屏幕**——
   屏幕通过 `setScreenTable(SCREENS)` 自注册，登录屏通过 `setLoginScreen()` 注入。
   否则 `shell → screens → shell` 立刻成环。同理，`extension-install.js` 独立出来
   是为了不让"主题屏"依赖"插件屏"。
2. **`window.*` 是外部契约。** 渲染出来的 markup 用内联 `onclick="name(...)"`，
   浏览器把它解析在 `window` 上、而不是模块作用域。少注册一个不会有编译错误、
   不会有 console 报错、不会有失败请求——**按钮就是点了没反应**。所以入口用一个
   `WINDOW_HANDLERS` 映射把 17 个处理器集中登记，测试同时检查
   "markup 里调用的名字都登记过" 与 "拆分前的 17 个一个都没少"。

3. **URL 就是页面（hash 路由）。** `state.page` 是应用内部的"我在哪"，hash 是给用户
   看的那个。没有它，刷新 / 书签 / 发给同事的链接**永远落在 dashboard**，而浏览器的
   "后退"会直接离开后台而不是回到上一个屏。
   - 只用 fragment（不碰 History API）：SPA 仍能从任何静态托管上跑，页名也不需要服务端路由。
   - 页名语法保持**可读形状**：`:` 变路径分隔符、每段单独编码，所以 `cpt:news` 是
     `#/cpt/news` 而不是 `#/cpt%3Anews`；分段编码也是**往返精确**的原因（段里自带
     `/`、`?`、`:` 都能原样还原）。
   - 编辑器**不是**独立页面（内容列表在 `state.editing` 有值时渲染它），它的目标挂在
     fragment 的查询上：`#/posts?edit=<id>` / `#/posts?new=1`。
   - ⚠️ **写 URL 的地方只有一个：`render()`（`syncHash()`）。** `go()` / `switchSite()` /
     `newContent()` / `editContent()` 最后都汇到 `render()`，所以没有调用方需要记得同步
     URL，也没有调用方能忘。
   - ⚠️ 屏幕名 → URL 的映射是**通用**的（`:` ↔ `/`），所以新增一个 `foo:` 前缀
     **不需要**改 `pageToHash`。这是设计意图，不是巧合——如果哪天需要为某个前缀写特例，
     说明这个通用映射被破坏了。
   - 判据在 `admin-spa.test.mjs`：所有 `SCREENS` 键 + 每个带前缀的语法**往返一致**，
     导航会写 URL，URL 会导航（含 boot / 后退 / 手改 hash），深链进编辑器能恢复。


### 7.3 依赖方向规则（架构测试的判据）

```
shared/  ←  任何层可用，但 shared 不依赖任何业务层
   ↑
platform/  ←  不认识 extensions/
   ↑
rendering/  ←  可用 platform，不认识 extensions/
   ↑
extensions/  ←  可用 platform 与 rendering，但**主题与插件之间互不可见**
   ↑
index.ts  ←  唯一知道所有层的地方
```

**四条红线**（全部已被 `tests/suites/architecture.test.mjs` 机器强制）：

1. `shared/` 不 import 上层任何东西
2. `platform/` 不 import `extensions/`
3. `rendering/` 不 import `extensions/`
4. `extensions/theme/` 与 `extensions/plugin/` 互不 import

第 4 条尤其重要——**核心层给主题和插件提供的是同一套接口**，这样"插件也能注册菜单"就是免费的。

**⚠️ 第 4 条在落地时遇到并解决的第一个真问题**：

主题渲染需要给插件机会改输出（`beforeRender` action、`html` filter、短代码）。
最直觉的写法是让 `theme/` 直接 `import` `plugin/` 的 `applyFilters` —— 编译能过、功能也正常，
但**插件就此成为每个主题的硬依赖**，而这两个东西本应是独立安装的。

解决办法是**依赖倒置**，落在一个新文件 `src/extensions/contract/hooks.ts`：

```
   contract/hooks.ts        ←  只依赖 shared/types，声明 `HostHooks` 接口
        ↑                ↑
   theme/ 依赖它      plugin/ 实现它
        ↑                ↑
        └──── index.ts 把两边接起来 ────┘
```

- `theme/` 只认 `HostHooks` 接口，调用 `hooks.applyFilters(...)`，**永远看不到 plugin/**；
- 没有注入时使用 `NULL_HOOKS`（原样返回、空实现）——行为与"本站没装插件"完全一致，
  所以调用点**不需要 null 判断**，也不会两边分支；
- `index.ts` 是唯一同时 import 两层的模块，在 boot 时调一次 `setHostHooks(...)`。

> 顺带修掉了 `decorateOutput` 里的 `o.siteId ?? "default"` —— 它和参数默认值是同一类问题：
> 隐性兜底会让"传漏了"看起来像"正常工作"。

**这次也发现架构测试自己是假绿的**（见 §8 批次 1 的反向验证表）：
跨层检查原本用 `spec.includes("/extensions/plugin/")` 做文本匹配，
而真实写法是 `"../plugin/runtime"`，**根本不含 `/extensions/`**——检查从未生效过。
已改为**按文件所在目录解析路径再比较**，并补上 `shared/` 叶子层检查。

---

## 8. 实施路线图

分四个批次，每批次**可独立验证、可独立交付**。

### 批次 1：目录重整 + 架构测试（P0，约 1 天）

**做什么**
1. 按 §7.1 移动文件（纯移动，不改逻辑）
2. 写 `tests/suites/architecture.test.mjs`（§5.4②的 7 条）
3. 加强 `validateManifest`（§5.3）
4. 去掉 `siteId` 默认值（§5.2）

**验收**
- `tsc --noEmit` 0 错误
- 现有 241 条测试全绿
- 架构测试全绿
- **故意在主题里写一句 `env.DB.prepare(...)`，架构测试必须失败**（验证测试真的有效）

> 第 4 条是**必须做**的验证——测试写了但不会失败，等于没写。

#### 进度（已落地的部分）

| 项 | 状态 | 证据 |
|---|---|---|
| 架构测试（11 组检查） | ✅ 已建 | `tests/suites/architecture.test.mjs`，已接入 `npm test` 与 `run-all.mjs`（批次 3 后为 13 组） |
| 反向验证（测试确实会失败） | ✅ 已验证 | 7 项注入测试均如期失败（见下） |
| 主题清单漂移修复 | ✅ 已修 | `themes/default`、`themes/magazine` 声明与实际文件对齐 |
| 硬规则文档 | ✅ 已建 | [`AGENTS.md`](../AGENTS.md) |
| `siteId` 默认值清理 | ✅ 已完成 | 26 处全部移除；棘轮常量已删除，规则改为零容忍 |
| 多站点 SEO 回归修复 | ✅ 已修 | `/sitemap.xml`、`/robots.txt` 移到站点解析之后 |
| **其余 6 处常量默认值** | ✅ 已修 | `siteId = DEFAULT_SITE_ID`，旧正则漏掉的那批 |
| **目录重整（src/）** | ✅ 已完成 | `src/core/*` → `shared/` `platform/` `rendering/` `extensions/`，见下表 |
| **依赖倒置（theme↔plugin）** | ✅ 已完成 | 新增 `extensions/contract/hooks.ts`，红线 4 从"纸面"变为"真实成立" |
| **运行时清单校验** | ✅ 已完成 | §5.3 全部规则实现进 `validateManifest`；`tests/suites/manifest-validation.test.mjs` 33 条断言逐条证明"拒绝"（批次 3 后为 54 条） |
| **后台 JS 拆分** | ✅ 已完成 | `admin.js` 1514 行 → 入口 < 120 行 + `js/` 下 4 个基础模块与 18 个屏幕模块；新增 `tests/suites/admin-spa.test.mjs`（15 条）看住模块图与 `window.*` 契约，见 §7.2 |

**批次 1 验收状态（2026-09-28 实测）**

```
architecture        10 passed, 0 failed
manifest-validation 33 passed, 0 failed
admin-spa           15 passed, 0 failed   ← 本轮新增
template-engine     47 passed, 0 failed
theme-integration   46 passed, 0 failed
multisite           74 passed, 0 failed
admin-contract      32 passed, 0 failed
plugin-hooks        25 passed, 0 failed
theme-worker        28 passed, 0 failed
theme-aurora         0 failure(s)
npx tsc --noEmit    0 错误（仅 node_modules 内的既有 lib 冲突）
```

10 个套件已全部接入 `npm test` 与 `tests/run-all.mjs`（`admin-spa` 紧跟
`manifest-validation`，理由相同：不需要数据库，守的是"结构"而不是"行为"）。

后台 SPA 另有一次**真实浏览器**验收（`wrangler dev` + Chromium）：
登录 → 侧栏真实点击 → 主题下拉 → 侧栏折叠 → **16 个页面 × 明暗两套** → 用户菜单登出，
断言 h1 非空、导航项存在、正文长度、壳层存在、无 "Something went wrong" 面板，
且 console 零错误、零 5xx。唯一出现的 401 是登录前的 `/api/v1/auth/me`，属**设计内**。

> **`run-all.mjs` 在本机沙箱里会整体报 SKIP（`EBUSY`）** —— 这是 Windows 沙箱锁 node 二元文件的已知现象，
> 不是测试失败。runner 刻意把"跑不起来"与"跑失败"分开报告（见 `run-all.mjs` 的注释）。
> 逐个直接执行 `node tests/<name>.test.mjs` 才是本机可靠的验证方式。

#### 目录重整的落点（已完成）

| 目标层 | 文件 | 说明 |
|---|---|---|
| `src/shared/` | `types` `crypto` `repo` `cache` `scheduler` | 叶子层，不依赖任何业务层 |
| `src/rendering/` | `template-engine` `template-resolver` `blocks` | 纯渲染，零业务依赖 |
| `src/platform/` | `auth` `permissions` `sites` `frontend` `seo` `revisions` | 不认识扩展 |
| `src/extensions/` | `contract/hooks` `security` | 共享契约与安全 |
| `src/extensions/theme/` | `runtime-declarative` `runtime-worker` `capabilities` `templates` | 主题侧 |
| `src/extensions/plugin/` | `runtime` | 插件侧 |
| `src/` 根 | `index.ts`（路由）`api.ts`（管理 API） | 唯一知道所有层的地方 |

原 `src/core/` 的 19 个平铺文件已全部归位，`src/core/` 目录已删除。
共 23 个 `.ts` 文件、4525 行；`tsc --noEmit` 0 错误；esbuild 打包通过。

**反向验证记录**（这是本批次最重要的产出——证明防线真的有效）：

| 注入的违规 | 架构测试的反应 |
|---|---|
| 主题里加 `env.DB.prepare("SELECT …")` | ✅ FAIL，并列出文件名 |
| 语言包写无前缀的 `"nav.home"` | ✅ FAIL，并指出缺少的前缀 |
| 清单声明一个不存在的模板 | ✅ FAIL，并给出缺失的文件名 |
| 新增 `siteId = "default"`（字符串形式） | ✅ FAIL，报出文件:行号 |
| 新增 `siteId = DEFAULT_SITE_ID`（常量形式） | ✅ FAIL —— **这曾是真实漏洞**，旧正则只匹配字符串字面量 |
| 主题里加 `import ... from "../plugin/runtime"` | ✅ FAIL —— **这也曾是真实漏洞**，旧检查文本匹配 `/extensions/plugin/`，而真实路径不含该串 |
| `shared/` 里加 `import ... from "../platform/..."` | ✅ FAIL，指出"reaches platform/" |
| 移除 sitemap 的站点过滤 | ✅ FAIL，两条断言分别指出"default 列表混入 shop 的文章" |
| 主题声明 `blocks[].name = "theme/property-card"` | ✅ REJECTED —— 加运行时校验后由 `validateManifest` 直接拦截安装 |
| **（后台 SPA）从 `WINDOW_HANDLERS` 删掉 `logout`** | ✅ FAIL —— 两条断言分别指出"no longer published: logout"与"not a function on window" |
| **（后台 SPA）给 `shell.js` 加一条 `import … screens/dashboard.js`** | ✅ FAIL —— 报出完整环：`shell.js → screens/dashboard.js → shell.js` |
| **（后台 SPA）内联 `onclick` 指向未注册的处理器** | ✅ FAIL —— "markup calls these but nothing publishes them: notAHandler" |
| **（后台 SPA）新增一个没人 import 的模块** | ✅ FAIL —— "orphans (written but never imported)" |
| **（后台 SPA）屏幕体内引用未导入的标识符** | ✅ FAIL —— "rendered the error panel"（**这条第一版漏了**，见下） |
| **（后台 SPA）屏幕什么都不写进 `#content`** | ✅ FAIL —— "rendered nothing" |

> ⚠️ 后台 SPA 那组里的**第 5 条**，第一版是假绿。原因是 `render()` 自己
> `try/catch` 住屏幕的异常并换成 "Something went wrong" 面板——于是
> **"`render()` 没抛错"并不等于"屏幕是好的"**，注入一个未定义的标识符后测试依然全绿。
> 改法是断言**真正写进 DOM 的东西**（不能含错误面板、不能为空），而不是断言"没抛错"。
> 教训与 §8 的 9b 段同源：**断言要盯住注入缺陷后必然会变的那个值**，
> 而"没有异常"往往是个恒定不变的值。

**这次清理中真实发现并修复的问题**（都是"文档/测试说已守住，实际没守住"）：

1. **`/sitemap.xml` 与 `/robots.txt` 完全不按站点工作。** 它们在 `src/index.ts` 里排在
   `resolveSite()` **之前**，并调用 `locales(env)` / `siteInfo(env)`（无 `siteId`）。
   后果：多站点部署下**每个域名都返回默认站的 sitemap**，而且是 200，没有任何报错。
2. **架构测试的正则漏掉常量形式默认值。** 旧正则只匹配字符串字面量，
   于是 `siteId = DEFAULT_SITE_ID` 六处全部"隐形"。规则看似被棘轮守住，实际没有。
3. **跨层检查从未生效。** 旧检查匹配 `/extensions/plugin/`，而真实写法是 `"../plugin/runtime"`。
   **这条最值得警惕**：一个守不住东西的守卫比没有守卫更糟，因为它是被信任的。
4. **主题与插件之间本该"互不可见"，实际做不到。** 主题渲染要调插件的 filter，
   于是就形成了 `theme/` → `plugin/` 的直接依赖。已用 `contract/hooks.ts` 做依赖倒置解决。
5. **两处类型错误在移除默认值后暴露**：`ThemeRenderOptions.siteId` 是可选字段，
   而渲染器实际必需。默认值一直在掩盖这个缺口。已改为必填。
6. **`theme-integration` 用了一个非法区块名。** 加运行时清单校验后立刻暴露：
   该测试 fixture 声明 `blocks[].name = "theme/property-card"`，而 `IDENT_RE` 不允许斜杠，
   于是**主题安装直接 400**（测试此前"通过"是因为当时根本没有安装期校验）。
   修的是测试（不是放宽规则）—— 详见 §3.2.1。**这是本批次"加校验"的直接收益：
   它把一个此前只在运行时静默变形的问题，提前到了安装边界上。**

**关于断言强度的教训**（值得记住）：
第 9b 段测试**第一版是假绿**——它断言"XML 格式正确"和"不含 `/products/widget`"，
而那个路径当时根本没有已发布内容，所以**注入 bug 后依然全绿**。
改成断言真实存在的两个 slug（`default-post` / `shop-post` 的互相排斥）后，
注入 bug 立刻产生两条 FAIL。
**教训：断言必须盯住"注入缺陷后必然会变的那一个值"，否则写出来的只是装饰。**

### 批次 2：多语言四层（P1）—— ✅ 已完成（2026-09-28）

**做了什么**
1. 迁移 `0011_i18n.sql`（L0 两张表 + `posts.lang_group` + `site_users.ui_lang` + `i18n_overrides` + `theme_table_defs`）
2. `src/platform/i18n/` 六个模块（`core-pack` / `translate` / `resolve` / `locale-registry` / `packs` / `index`）
3. 界面语言注入（API + admin SPA）：`setPackProviders` 走的是与 `setHostHooks` 同一套依赖倒置
4. 内容翻译组 CRUD + 后台语言版本条（`public/admin/js/screens/languages.js`、`editor.js`）
5. 主题自有表 DDL 生成 + 注册表 + facade + 沙箱端点（M8/M9，原本排在批次 3，**提前做了**）
6. 多语言契约测试（§5.4①）+ 清单内联语言包校验（M11）

**验收（逐条有测试对着）**
- 只启用 `zh-CN` 时，主题自有表**不建** `_i18n` 表 → `i18n.test.mjs` 第 2 段
- 启用第二种语言后，`_i18n` 表出现 → 第 3 段
- 同一产品的中英文标题可分别编辑、分别访问 → 第 4/6 段
- `price` 在两种语言下值相同（验证 translatable 划分）→ 第 4 段
- 后台界面语言与内容语言独立可设 → 第 7 段
- 真实浏览器里上述界面真的能点 → `tests/tools/_i18n-browser.cjs`（22 条）

**这一步真实发现并修复的缺陷**（都是"只在真机/真实交互下才暴露"的那一类）：

1. **`translationGroup` 把组名所指的那一行自己排除掉了。** 详见 §5.4③。
   后果不是报错，而是**静默诱导用户建重复内容**。
2. **改语言开关后没有刷新后台上下文**，`state.locales` 还是旧的 `["en"]`，
   于是编辑器的语言版本条**整条不渲染**，屏幕上没有任何东西解释它为什么不在。
   `loadVersions` 原本把"缓存是空的"和"这个站只有一种语言"当成同一件事。
3. **`loadVersions` 的守卫写成 `state.locales.length < 2`** —— 空数组走的是"单语言"分支。
   改成只在**确知**单语言（长度恰为 1）时短路，其余情况问服务端。

> 这三条有一个共同形状：**状态缓存与事实源不一致时，界面选择"什么都不显示"**。
> 界面上"少了一块"比"显示错了"更难发现，因为没有任何东西是红的。

### 批次 3：后台菜单统一 + 脚手架（P1）—— ✅ 已完成（2026-09-28）

> 主题自有表的部分（原批次 3 的 1–3 项）已在批次 2 落地，见上。

**做什么**
1. `admin_menu_registry` 统一菜单表（主题 + 插件），迁移时 **drop `theme_admin_menus`**
2. `table-list` / `table-edit` / `theme-settings` 屏幕
3. 插件菜单支持（与主题走同一条注册路径）
4. `extensions/contract/` 补齐 `manifest.ts` / `validation.ts` / `capabilities.ts`

**验收**
- 一个 `eshop` 示例主题能建出 `theme_eshop_product` 与 `_i18n`（DDL 部分已完成）
- 后台自动出现"产品"菜单，列表和表单**由声明生成**（主题无表单代码）
- SEO 插件能注册自己的后台菜单
- 停用插件后，只有它的菜单消失
- 切主题后，旧主题的表在、菜单消失、切回来菜单恢复

#### 落地情况

| 项 | 状态 | 落点 |
|---|---|---|
| 1. 统一注册表 + drop 旧表 | ✅ | `migrations/0012_admin_menu_registry.sql`（迁移时把旧行搬过去，再 `DROP`） |
| 2. `table-list` / `table-edit` 屏幕 | ✅ | `public/admin/js/table-form.js` + `screens/table-list.js` + `screens/table-edit.js` |
| 2b. `plugin-settings` 屏幕 | ✅ | 批次 3 新增（原清单没列，但插件菜单需要它才有落点），`screens/theme-menu.js` 统一分发 |
| 3. 插件菜单 | ✅ | `src/extensions/plugin/menus.ts`，写入 `ALL_SITES`（见 §4.4 坑 2） |
| 4. `extensions/contract/` 补齐 | ✅ | 批次 4 完成，见 §8 批次 4.1 |

**本轮未做（明确登记，不静默放行）**

- **`extensions/contract/` 只拆 `hooks.ts` 一件事。** 这是纯结构性重构（把 `manifest.ts` /
  `validation.ts` / `capabilities.ts` 挪进契约层），不改行为；与批次 3 的功能项混在一个提交里
  会让"哪一行改动导致了行为变化"变难判断。推迟到批次 4。
- **插件自有表（`plugin_{plugin}_{table}`）推迟到批次 4。** §6.4 曾把它标为批次 3，实现时发现
  `theme_table_defs` 只有 `theme_name` 列，要支持插件必须把它泛化成 owner 概念——**那是表重建，
  不是加一列**（SQLite 不能 `ALTER` 主键/UNIQUE，见 0009 的教训）。插件声明 `tables[]` 目前
  **被校验器明确拒绝**，而不是被静默忽略。
- ~~**`eshop` 示例主题本身**仍是批次 4 的产物。~~ ✅ **批次 4 已交付**：
  `themes/eshop/` + `tests/theme-eshop.test.mjs`（41 条），见 §4.3。
  ⚠️ **两者都在批次 10 步骤 1 随旧主题一起删除了**（`tests/theme-eshop.test.mjs` 与
  `tests/_eshop-inject.mjs` 已不存在；`themes/` 现只剩 `default` 与 `fixture`）。
  本文 §4.3 保留过程记录，但**其中的命令不要再执行**——用 `tests/suites/theme-fixture.test.mjs`
  与 `tests/suites/theme-integration.test.mjs` 替代。本批次当时用
  `menusdemo` 夹具（测试内）与 `menusbrowser`（浏览器验收内）验证了同一组能力。

**验收证据（2026-09-28 实测）**

```
architecture         13 passed, 0 failed   ← 新增 3 组（屏幕白名单/已装扩展的菜单/旧表已退役）
manifest-validation  54 passed, 0 failed   ← 新增 12 条（含 8 条"注入缺陷必须抛错"）
admin-menus          43 passed, 0 failed   ← 本轮新增，覆盖 §4.4 的三条不变量
admin-spa            15 passed, 0 failed   ← 22 个已注册页面全部渲染
admin-contract       32 passed, 0 failed
i18n                 62 passed, 0 failed
multisite            74 passed, 0 failed
plugin-hooks         25 passed, 0 failed
template-engine      47 passed, 0 failed
theme-integration    46 passed, 0 failed
theme-worker         28 passed, 0 failed
theme-aurora          0 failure(s)
npx tsc --noEmit     0 错误（仅 node_modules 内的既有 lib 冲突）
```

外加一次**真实浏览器**端到端验收（`tests/tools/_admin-menus-browser.cjs`，31 条断言，连跑两次均绿）：
启用插件 → 侧栏长出 "Extensions" 组 → 菜单打开插件自己的设置页 → 改值并**重新加载后仍在**
→ 上传并激活带 `tables[]` 的主题 → 侧栏 "From theme" 组出现 → 打开生成列表（列来自声明）
→ 新增行（表单控件来自 `fields[].type`）→ 保存 → 列表出现该行 → 从列表删除 → 复原初始状态
→ 全程零 console 错误 / 零 5xx。

> **这次浏览器验收抓到了一个 Node 层抓不到的缺陷。** SPA 的页面键原本是
> `table:<table>[:<slug>]`，于是"列表"与"新增"在缺省 slug 时是**同一个页面名**——
> 点"新增"跳回它自己所在的列表，**界面上什么也没发生、控制台什么也没报**。
> 结构测试（渲染桩）与 API 测试都覆盖不到"点一下之后去了哪"。
> 修法是把三个深度拆成互不重叠的前缀：`table:` / `table-new:` / `table-edit:`（§3.5）。

**反向验证记录（批次 3 新增，逐条注入确认会红）**

| 注入的违规 | 测试的反应 |
|---|---|
| `clearOwnerMenus` 忽略 `owner_name`（只按站点+类型清） | ✅ `admin-menus` FAIL ×3 |
| 插件菜单写成具体站点而非 `ALL_SITES` | ✅ `admin-menus` FAIL ×2（含"新站点看不到插件菜单"） |
| 关掉 `table-list` 的 `args.table` 校验 | ✅ `manifest-validation` FAIL ×4 |
| 关掉**插件**分支的清单校验 | ✅ `manifest-validation` FAIL ×3 |
| 已装主题的菜单指向一个不存在的屏幕 | ✅ `architecture` FAIL |
| 在 `src/` 里引用已退役的 `theme_admin_menus` | ✅ `architecture` FAIL |

> ⚠️ **第一条第一版是假绿，值得记下来。** 最初的用例是"清掉插件 B，断言主题 A 还在"——
> 两个 owner **类型不同**，所以只验证了谓词里 `owner_type` 那一半；把 `owner_name` 整段删掉，
> 测试依然全绿。改成"两个同类型 owner"后才真正红。**教训：隔离性测试必须让被删掉的那一半
> 成为唯一的区分依据**，否则它在测别的东西。

### 批次 4：脚手架 + 文档（P2）

**做什么**
1. ✅ `scripts/make-theme.mjs` / `make-plugin.mjs` / `make-table.mjs`（§4.2）
2. ✅ `docs/guides/I18N.md` / `THEME-DEV.md` / `PLUGIN-DEV.md`（§4.4）
3. ✅ 示例主题 `eshop`（作为声明能力的活文档）（§4.3）
4. ✅ `extensions/contract/` 拆分（批次 3 登记的技术债）（§4.1）
5. ⏳ 插件自有表（批次 3 登记的技术债）——**仍未做**，见 §9 决定 3

**验收**
- ✅ `npm run make:theme -- demo` 生成的骨架：`tsc` 过、架构测试过、能激活、能渲染
  （由 `tests/suites/scaffold.test.mjs` 68 条断言机器证明，而非人工试一遍）
- ✅ 范例主题 `eshop` 过真实校验器 / 架构规则 / 模板引擎，且**七个注入场景逐条验证会红**

#### 4.1 已完成：`extensions/contract/` 拆分 + 路由消费契约收口

**拆分**（纯结构调整，行为不变）。`extensions/security.ts` 原本混了三件事，现在按"谁读它"拆开：

| 文件 | 内容 | 为什么单独存在 |
|---|---|---|
| `contract/manifest.ts` | 词汇表（屏幕 / 字段类型 / 保留列 / 名字正则）+ 声明模型接口 | **`tests/suites/architecture.test.mjs` 会读这个文件**去检查已装主题有没有用未知屏幕。列表住在校验器里时，唯一的检查办法是抄一份 —— 而抄本会漂移 |
| `contract/capabilities.ts` | `CAPABILITIES` + `isCapability()` 类型守卫 | 同上；顺带让调用点不再写 `CAPABILITIES.includes(x as Capability)` |
| `contract/validation.ts` | 安装边界（`validateManifest`） | 只做判断，不定义词汇 |
| `extensions/security.ts` | 只剩 `safeZipPath` / `sha256` | 名字终于和内容一致 |

**同时修掉了第三个"声明先于运行时"的缺口**（§3.2.2）：`routes[].resolve.table`、`routes[].template`、`query.as`。前两个被校验、被架构测试断言，却从不被读取；第三个根本不存在，于是路由查询结果永远只能叫 `posts`。

**新增的架构守卫**：`DECLARABLE_HOOKS`（可声明 hook 名单）原本是**死代码** —— 插件声明一个拼错的 hook 名照样安装、启用、报告 active，然后什么也不做。名单搬进 `contract/hooks.ts` 后校验器与运行时读同一份，并由 `architecture.test.mjs` 钉住"可声明的 hook 与已实现的 hook 一一对应"。

**验收证据（2026-09-29 实测，连跑两轮一致）**

```
architecture         15 passed, 0 failed   ← 新增 2 条（DECLARABLE_HOOKS ↔ HOOK_IMPLS）
manifest-validation  63 passed, 0 failed   ← 新增 9 条（7 条"注入缺陷必须抛错" + 2 条接受）
admin-menus          43 passed, 0 failed
admin-spa            15 passed, 0 failed
template-engine      47 passed, 0 failed
theme-integration    65 passed, 0 failed   ← 新增 5c 段（表路由 / 模板指定 / 未命中 404 / 链接）
multisite            74 passed, 0 failed
i18n                 62 passed, 0 failed
admin-contract       32 passed, 0 failed
plugin-hooks         25 passed, 0 failed
theme-worker         28 passed, 0 failed
theme-aurora          0 failure(s)
npx tsc --noEmit     0 错误（仅 node_modules 内的既有 lib 冲突）
```

**反向验证记录（批次 4 新增，逐条注入确认会红）**

| 注入的违规 | 测试的反应 |
|---|---|
| 关掉 `routes[].template` 的模板名校验 | ✅ `manifest-validation` FAIL |
| 关掉 `resolve` 的"二选一"校验 | ✅ `manifest-validation` FAIL ×2 |
| 关掉 `resolve.type` 的标识符校验 | ✅ `manifest-validation` FAIL |
| 关掉 `resolve.by` 的枚举校验 | ✅ `manifest-validation` FAIL |
| 关掉 `query.as` 的作用域名校验 | ✅ `manifest-validation` FAIL |
| 关掉 `query` 的对象校验 | ✅ `manifest-validation` FAIL |
| 把路由改回改动前的写法（整段） | ✅ `theme-integration` FAIL ×12 |
| 让语言开关谎报 `created_i18n_tables: []` | ✅ `i18n` FAIL |

> ⚠️ **本轮又踩到一次"断言随运行顺序变化"。** `theme-integration` 的夹具声明了 `tables[]`，
> 而 `theme_table_defs` **按设计不随主题停用消失**，于是它留下的注册行让 `i18n` 里一条
> **站点级**的 `created_i18n_tables` 相等断言多出一项 —— 单跑绿、按 `npm test` 顺序跑红。
> 修法是把断言收窄到自己那张表，**收窄后再反向验证一次**（谎报 `[]` 仍会红）。
> 这已经是同一个坑的第三次：**共享 D1 上的断言必须按 owner 收窄，不能用全局计数。**

#### 4.2 已完成：脚手架（`scripts/make-*.mjs`）+ `tests/suites/scaffold.test.mjs`

**生成器是一个承诺**：「从这里开始，你不可能把形状弄错」。这个承诺在没有东西检查它的时候
一文不值 —— 骨架恰好由一堆**会静默失败**的构造组成（`{{len(posts)}}` 的括号写法、
`{{{post.html}}}` 的三花括号、`@section` 插槽、必须存在的 `@include` 目标、
决定碰撞胜负的语言包前缀），没有一条能从空白文件里推出来。

**为什么生成器必须是可 import 的**：本机沙箱**无法 spawn 任何子进程**（`spawnSync` 一律
`EBUSY`，与 `tests/run-all.mjs` 报 SKIP 同因）。所以三个生成器都拆成
`main(argv, io)` + 纯内容构造函数（`themeFiles` / `pluginFiles` / `tableDeclarations`）+
`isMain()` 守卫，用户可见的错误抛 `CliError` 并转成退出码。
**只能以命令形式运行的生成器，等于输出永远没被检查过的生成器。**

`tests/suites/scaffold.test.mjs`（68 条）用四重独立检查守住这个承诺：

| # | 检查 | 用的什么 |
|---|---|---|
| 1 | 生成的清单被**真实**安装边界接受 | `validateManifest`（`contract/validation.ts`） |
| 2 | 生成的树过**真实**架构规则 | `_extension-rules.mjs` —— 与 `architecture.test.mjs` **同一份函数**，不是副本 |
| 3 | 每个模板过**真实**模板引擎（有数据 / 无数据各一次） | `renderTemplateSource`（`rendering/template-engine.ts`） |
| 4 | 每个 `@include`/`@extends` 目标、每个 section 开闭都配得上 | 直接读生成的文件 |

第 2 条之所以共用函数而不是抄一份：**抄本永远先过期**，而且"过了架构测试"这句话就变成了
声明而非事实。这与 `contract/manifest.ts` 单独存在的理由是同一条。

**它抓到的真实缺陷（这是本节的要点）**

> 骨架的**四个子模板全都漏了 `{{/section}}`**。
>
> 引擎判断一个 `{{@section "x"}}` 是**定义**还是**插槽**，靠的是向后扫描有没有配对的
> `{{/section}}`。漏掉闭合标签 → 子模板的 section 被判定成插槽 → 不进 `@sections` →
> 布局渲染**空的 `<main>`**。**HTTP 200、零异常、零日志。**
>
> 这个缺陷只有在**真的渲染一遍**的时候才会现形。清单校验器说它没问题，架构测试说它没问题。

**由此新增的两条引擎级守卫（都反向验证过）**

| 守卫 | 修什么 | 为什么这么修 |
|---|---|---|
| **子模板未闭合 `{{@section}}` 直接抛错** | 上面那个静默空白页 | 猜测有一个**可以证明**的错法：`@extends` 了的文件是子模板，而**子模板永远不提供插槽**。于是"既 `@extends` 又有未闭合 section"不是猜测而是**结构性错误**（`extendsName` 是解析结果，不是文本匹配） |
| **`@extends` 链的 section 合并顺序** | 三层继承时**最不派生**的根赢 | 原写法「保留第一次写入，只特判 `i === 0`」在两层时正确、三层时反了。仓库里没有嵌套布局，所以一直没暴露 —— 主题作者一试就会拿到祖父的副本。改成从根向子遍历、后来者覆盖 |

**验收证据（2026-09-29 实测）**

```
architecture         15 passed, 0 failed
manifest-validation  63 passed, 0 failed
admin-menus          43 passed, 0 failed
admin-spa            15 passed, 0 failed
template-engine      49 passed, 0 failed   ← 新增 2 条（未闭合 section 抛错 / 三层继承最派生者胜）
scaffold             68 passed, 0 failed   ← 本轮新增，已进 npm test 链
theme-integration    65 passed, 0 failed
multisite            74 passed, 0 failed
i18n                 62 passed, 0 failed
admin-contract       32 passed, 0 failed
plugin-hooks         25 passed, 0 failed
theme-worker         28 passed, 0 failed
theme-aurora          0 failure(s)
npx tsc --noEmit     0 错误（仅 node_modules 内的既有 lib 冲突）
```

**本轮新增的反向验证（逐条注入确认会红）**

| 注入的违规 | 测试的反应 |
|---|---|
| 把骨架的 4 个 `{{/section}}` 删掉 | ✅ `scaffold` FAIL（内容计数）+ 引擎守卫抛出精确消息 —— **两条独立机制同时抓到** |
| 关掉"子模板未闭合 section"守卫 | ✅ `template-engine` FAIL（且只有这一条） |
| 恢复旧的 section 合并写法 | ✅ `template-engine` FAIL（且只有这一条） |

> ⚠️ **本轮的第五种假绿：断言描述的是上一轮的产物。**
> 套件开头 `rmSync(SCRATCH, {force:true})` 在 Windows 上会因 `EBUSY` 失败，而 `force:true`
> **把错误吞掉**；生成器又刻意拒绝覆盖已存在的文件，于是残留的旧文件全部存活 ——
> 整套断言描述的是**这一次根本没有写出来的内容**。
> 修法：**清理之后验证清理成功**（`if (existsSync(dir)) throw`）。
> 同源的第二条：第一次注入脚本打印 `closers removed: 2 -> 2` —— 它什么都没改，
> 而我把随后出现的红色当成了证据。**注入后必须断言"确实从 N 变成 M"。**
> **不能证明自己注入成功的注入，不是注入。**

#### 4.3 已完成（⚠️ 已于批次 10 退役）：`themes/eshop/` 范例主题 + `tests/theme-eshop.test.mjs`

> ⚠️ **本节是过程记录。** `themes/eshop/`、`tests/theme-eshop.test.mjs` 与
> `tests/_eshop-inject.mjs` 都已在批次 10 步骤 1 随旧主题一起删除。
> 其中的命令**不要再执行**；替代品是 `tests/suites/theme-fixture.test.mjs`（fixture 主题自洽）
> 与 `tests/suites/theme-integration.test.mjs`（上传→激活→渲染端到端）。

**为什么需要一个真的主题，而不是又一篇文档。** `eshop` 是**声明能力的活文档**：
主题自有表、生成式后台屏、声明式路由（`resolve.table` / `query.as`）、双语目录 ——
文档会漂移，而一个**真实校验器、真实架构规则、真实模板引擎都接受的**主题不会。

它也是唯一同时用到这四样东西的地方：`scaffold.test.mjs` 证明生成器产出的骨架合法
（骨架**不声明任何表和路由**，因为它没有业务逻辑），`theme-integration.test.mjs` 证明
机制在**内联夹具**上能跑。两者都不会发现 `resolve.table` 与 `translatable` 不再咬合，
或商品模板在用一个声明里已经消失的字段。

**它声明了什么**：一张 `product` 表（`translatable: ["name","blurb"]`，故意**不含**
`price` / `stock` —— 价格不属于某个语言）、三个后台菜单（`table-list` / `table-edit` /
`theme-settings`，**零后台代码**）、三条路由（`/shop` 列表、`/shop/:slug` 单件
`resolve.by: "slug"`、`/journal`）、两个语言与各自的 `theme.eshop.*` 语言包。

**它的反向验证工具是 `tests/_eshop-inject.mjs`**（手工跑，不进 `npm test` —— 它是个
**工具**，跟 `_i18n-browser.cjs` 同一性质）。七个场景，每个都断言"确实注入了"再断言
"红在预期的哪一条"，然后**验证还原成功**：

| 注入 | 预期变红的断言 |
|---|---|
| 删掉一个 `{{/section}}` | `every child closes every section it opens`（+ 引擎抛出，套件中止） |
| 改掉 `query.as` | `the listing route names its scope` |
| 改掉 `resolve.by` | `the item route resolves the table by slug` |
| 砍掉 `translatable` 的一项 | `only the text-bearing fields are translatable` |
| 把模板链接指向 `/blog/` | `archive links to the route's own path` + `…not hard-coded to /blog/` |
| 藏掉一个已声明的模板文件 | `theme manifest rules report nothing` + `every declared template exists` |
| 藏掉一个语言包 | `every declared locale ships a pack` |

**本轮新增的第六种假绿：没有摘要行的一跑，被当成了通过。**

> 套件的摘要在 `main()` 末尾打印。模板渲染一旦抛错（比如那个未闭合的 `{{/section}}`），
> 控制流直接跳出，**`N passed, M failed` 这一行永远不会打印**。
> 而我的校验脚本用 `grep '^[0-9]+ passed'` 读结果 —— 匹配不到就什么也不输出，
> 我把"没有输出"读成了"没有失败"。**同一次会话里，这个错误犯了两次。**

修法分两层，缺一不可：

1. **套件侧**：`summary()` 抽成函数，`catch` 分支里也调用它，并把异常计为一条失败。
   于是**任何一跑都必然有摘要行**，且崩溃会以 `(aborted)` 标注。
   早先某主题套件只打印 `${failed} failure(s)`、**没有 passed 计数**（该套件已在批次 10 退役），
   也已统一成同一种摘要 —— 摘要格式不一致，脚本就分不清"绿"和"崩"。
2. **校验脚本侧**：把"**摘要行缺失**"当作 `FAILED`，而不是跳过。
   `.wrangler/eshop-rev.sh` 里 `grep -qE '^[0-9]+ passed, [0-9]+ failed'` 失败即 `exit 1`。

> **规则**：**没有摘要 = 失败**。一跑的产出必须能自证它跑完了；`grep` 匹配不到，
> 是"我不知道"，不是"它没事"。

**另外两个同源陷阱（都在反向验证工具自己身上）**

| 陷阱 | 症状 | 修法 |
|---|---|---|
| **字节数守卫看不见等长替换** | `"/shop/"` → `"/blog/"` 长度完全相同，于是守卫打印"什么都没改"，而那次注入其实**生效了** —— 防假阴的工具自己产出了一个假阴 | 比**内容哈希**，不比长度 |
| **快照取自脏树** | `git checkout -- <path>` **修不了 git 从没见过的文件**（`themes/eshop/` 是全新的），还原静默失败 → 每个场景叠加在上一个之上；更糟的是脏状态被**拍进快照**，于是"还原"忠实还原了损坏，套件连续七轮红在一个**没有任何场景引入过**的缺陷上 | 不用 `git checkout`：快照前 `assertPristine()`，还原后再 `assertPristine()`。**还原也要被验证** |

**验收证据（2026-09-29 实测，`npm test` 全链）**

```
architecture         15 passed, 0 failed
manifest-validation  63 passed, 0 failed
admin-menus          43 passed, 0 failed
admin-spa            15 passed, 0 failed
template-engine      49 passed, 0 failed
scaffold             68 passed, 0 failed
theme-integration    65 passed, 0 failed
theme-eshop          41 passed, 0 failed   ← 本轮新增，已进 npm test 链
multisite            74 passed, 0 failed
i18n                 62 passed, 0 failed
admin-contract       32 passed, 0 failed
plugin-hooks         25 passed, 0 failed
theme-worker         28 passed, 0 failed
theme-aurora         14 passed, 0 failed   ← 摘要格式本轮统一（原为 "0 failure(s)"，无 passed 计数）
npx tsc --noEmit     0 错误（仅 node_modules 内的既有 lib 冲突）
```

#### 4.4 已完成：三份开发文档

`docs/guides/I18N.md`（四层模型、`resolveLocale` 优先级、三条不变量、排查表）、
`docs/guides/THEME-DEV.md`（模板语言五条硬规则、`theme.json` 逐字段、症状→成因表）、
`docs/guides/PLUGIN-DEV.md`（**插件不发代码**的理由、7 个可声明 hook、内联语言包）。

三份都**对着源码写、不是对着记忆写**。核对中改掉了三处文档失实：helper 数量写成 10
（实为 **9**）、`query.order` 白名单漏了 `published_at`、以及"首次访问自动建表"
（实际是**主题激活时**由 `applyThemeCapabilities` → `syncThemeTables` 建的）。

#### 4.5 已完成：后台界面语言 + 账户自助 + 菜单配置（批次 5）

用户需求原话：「后台的多语言至少要中/英」「用户要可以修改密码、用户名」「左侧菜单
可配置、菜单动态多语言、和系统语言对齐」。四件事、一套语言基建：

| 项 | 落点 |
|---|---|
| 核心 UI 语言包（en + zh-CN，各约 90 key） | `src/platform/i18n/core-pack.ts`（§2.4 落地段） |
| SPA 字典消费：`t()` / 登录屏缓存 / 语言切换器 | `public/admin/js/i18n.js`（叶子模块）+ `nav.js`/`shell.js`/`auth.js` 接线 |
| **菜单标签服务端翻译**（`label_key` + 前缀校验） | `admin-menus` GET 消费点（§2.4）、`validateAdminMenus` 按 owner 拒绝越界 key、`themes/eshop` 复用 `theme.eshop.menu.*` |
| 账户自助：改密 / 改名（当前密码闸门下沉 `platform/auth.ts`） | `POST auth/password` / `auth/username`，稳定错误码 `wrong_current`/`weak`/`taken`/`invalid`，SPA `explain(code)` 映射译文 |
| per-user 菜单配置（隐藏/恢复） | `site_users.menu_prefs`（0013）+ `GET/PUT admin-menus/prefs` + `screens/menu-config.js`；**UI 层语义**（规则 38） |
| 新套件 `tests/suites/account.test.mjs`（27 条） | 全链路：闸门码、`auth/me` 反映、prefs 往返/隔离、**label_key 翻译端到端** |

**两条流程教训（本轮实测）**：① 真浏览器验收必须放在**所有测试套件之后**——15 个套件
共享同一块本地 D1，幂等清理会清掉 `site_locales` 的 zh-CN 行与 `theme.active`；
② `api()` 帮手在非 2xx 时**抛 `Error(data.error)`**——错误码进 catch 的 `err.message`，
SPA 的 `if (d.error)` 分支因此不可达，错误对话框要 `explain(err.message)`。
详见 HANDOVER 坑位 21–23。

---

## 9. 已确认的架构决策（原"待决策事项"）

> **状态：已全部确认（2026-09-28）。六项均采用选项 A。**
> 这些是**架构级决定**，实施中如要更改必须回到本文档改，不能在代码里悄悄偏离。

| # | 事项 | 决定 | 理由 | 落点 |
|---|---|---|---|---|
| 1 | **slug 唯一性** | **跨语言唯一**——`/en/about` 与 `/zh/about` 视为同一资源的不同语言版本，不允许两个独立内容共用 slug | CFCMS 支持**无前缀访问**（`/about` 要能落到某个语言），共用 slug 必然歧义；且翻译组（`lang_group`）本来就要求"同一内容的不同语言版本共用 slug" | §2.3 唯一索引 `UNIQUE(site_id, type, slug)`，**不含 locale** |
| 2 | **主题自有表的字段类型** | **先只支持基础类型**：`text` / `number` / `boolean` / `date`（+ 后续 `longtext`） | 关系（外键到平台 `posts`）看起来诱人，但会让主题表与平台表 schema 耦合——平台改字段就崩主题。等有真实需求再加，加时走**新版本 manifest** 而不是改语义 | §3.2 `tables[].fields[].type` 枚举；§2.5 `translatable` 只对有意义的类型生效 |
| 3 | **插件是否也能声明自有表** | **支持，与主题同机制**（决策不变，落地推迟到批次 4） | 机制已经统一（同一份 DDL 生成器、同一套 `host.table()` facade）。不支持反而要维护两套路径，且现实中"插件带表"是常见需求（如表单插件）。⚠️ **落地障碍**：`theme_table_defs` 只有 `theme_name` 一列，支持插件必须把它泛化成 owner 概念，那是**表重建**（SQLite 不能 `ALTER` 主键/UNIQUE）。在此之前插件声明 `tables[]` 被校验器**明确拒绝** | §6.4 插件表命名 `plugin_{slug}_{table}`（与主题 `theme_{owner}_{table}` 对称） |
| 4 | **`theme_admin_menus` 旧表** | **迁移后删除**（批次 3 的迁移里 drop）✅ **已执行** | 与 `admin_menu_registry` 存同一件事，两张表 = bug 温床（一定会有代码读错那张、有代码只写一张） | §6.2 改为 `admin_menu_registry`；旧表已在 `0012` drop |
| 5 | **目录重整的时机** | **批次 1 就做（先重整）** | 先重整，后面所有新代码自然落在对的位置；若最后做，则批次 2–4 写的每一行代码都要再动一次 | §7.1；本批次执行中 |
| 6 | **界面语言（L2）是否本期做** | **做** | "中文站长管英文站"是内容站常态，缺了后台就没法用 | §2.4；批次 2 交付 |

### 9.1 这些决定对既有设计的连带影响

写代码前请确认自己没和这几条冲突：

- **决定 1** 让"翻译"和"独立内容"成为两个不同概念：
  - 同一 slug + 不同 locale = 翻译（一个 `lang_group`）
  - 不同 slug + 不同 locale = 两条独立内容
  → 因此**新建内容时不能只校验 slug 是否被占，而要判断"对方是不是另一个语言的同一内容"**（若对方已属某个 `lang_group`，应提示"转为翻译"而非直接报冲突）。
- **决定 2** 意味着主题**不能**在 `fields[]` 里写 `type: "reference"`。需要关联到文章时，
  用 `type: "number"` 存 post id，**关系语义由主题自己的代码解释**——平台不认。
- **决定 3** 意味着 §6 的表命名规则要**成对**实现，别只写主题那半边。
- **决定 4** 一旦 drop，任何还引用 `theme_admin_menus` 的代码都会立刻报错。
  **drop 的同一个迁移里必须先完成数据搬运**，不要分两个版本。
- **决定 5** 已在进行中，见 §8 批次 1 进度表。

---

## 10. 附：给 AI 的硬规则清单

把本文的结论压缩成一份**可直接放进 `AGENTS.md` 的清单**，让 AI 每次改代码都被约束：

```
【分层】
1. 平台的表在 platform/，主题的表在 extensions/theme/，不得互访
2. 主题与插件互不可见，只能通过平台提供的接口交互
3. shared/ 里的代码不得 import 任何业务层
4. platform/ 与 rendering/ 不得 import extensions/（要扩展就反转依赖：注入接口）

【多语言】
5. 任何数据访问函数必须显式接收 locale 与 siteId，不得有默认值——
   **`?? "default"` / `|| "en"` 这类兜底表达式同样违规**，不只是参数默认值。
   唯一的例外是 `resolveSite()`（它必须给出兜底），用注释标记
   `ARCH-RULE-EXEMPT: site-default` 声明，且全库只允许一处
6. 语言查询的回退顺序：当前语言 → 站点默认 → 空。不抛错。
   内容语言的回退阶梯只能有一份定义（`resolveContentLocale()`），
   不得在任何调用点写 `|| "en"`——它会让 zh-CN 站点读写英文行
7. 显式语言的 URL（/en/x）找不到时返回 404，不回退
8. 语言包 key 必须带前缀：core. / theme.{slug}. / plugin.{slug}.
9. 界面语言与内容语言是两件事，不得混用
10. lang_group 可空，「没有它就是自己」只能有一份定义（JS + SQL 共用）
11. 改了语言开关必须刷新后台上下文（loadContext），否则界面会静默少一块
12. {table}_i18n 只在站点服务 ≥2 种语言时创建；语言停用后永不 drop、永不清回 NULL
12b. {table}_i18n **没有 site_id 列**（键是 row_id + locale）。因此对它的任何删除
   都必须在主表先验 site_id 归属，否则 `WHERE row_id=?` 会跨站误删；
   删整行与删单语言是两件事，用两个函数表达（`tableDelete` / `tableDeleteTranslation`）
12c. 主题 Worker 的站点/主题来源（x-cfpress-site / x-cfpress-theme 请求头）是
   **声明不是事实**：必须校验站点存在、且该主题正是本站激活的主题，缺一即拒
12d. **所有数据都必须有多语言能力，这不是可选项**（AGENTS.md 规则 41）。表字段按承载
   的内容分两类，分类表是 `contract/manifest.ts` 的 `PROSE_FIELD_TYPES` /
   `LANGUAGE_NEUTRAL_FIELD_TYPES`（`isProseFieldType()` 是唯一谓词，三处消费者共用，
   不得各自重写）：
     · **散文**（`text`/`longtext`，人读的文字）→ **必须**列进 `translatable`
     · **语言中立**（`number`/`boolean`/`date`/`datetime`）→ **不得**列进 `translatable`
   两个方向都在**安装边界**校验（第三方 zip 装不进来）、在**架构测试**校验
   （已发布的主题当场变红）、并由**脚手架默认遵守**（`make-table` 自动标记）。
   分类表本身也要被守：两表不得重叠、每个允许类型必须被分类、不得有幽灵类型、
   且**必须断言扫到了非空集合**——对空集合的检查是空转。
   标识符（SKU、券码）**不是散文**：用 `number`/中性类型存，不要用 `text`——
   用 `text` 等于宣称"这段文字值得翻译"，而每种语言一个 SKU 是建模错误

【主题/插件】
13. 主题不得直接写 SQL，只能用 host.table() facade
14. 表名由平台生成（theme_{owner}_{table} / plugin_{owner}_{table}），不得硬编码
15. 后台表单由声明生成，不得手写
16. 鉴权由平台施加，不得在主题/插件里自己验证
17. 只读所属主题/插件声明过的表，访问其他表必须失败

【改代码前】
18. 先跑 npm test，确认基线是绿的（判据是 0 failures，不是断言数）
19. 改完再跑全部套件与 npx tsc --noEmit，都必须绿
20. 如果改了扩展的声明能力，同步更新 tests/suites/architecture.test.mjs 与本文档
21. 改了多语言就同步 tests/suites/i18n.test.mjs；改了后台就跑 tests/tools/_i18n-browser.cjs
22. 新增守卫必须反向验证：注入一次违规，确认它真的会 FAIL
23. 一个概念要在两处表达时（JS ↔ SQL、字符串 ↔ 常量），让两处共用同一个定义

【系统骨架：schema / 语言结构 / 事件通道】（§11）
41. **所有数据都必须有多语言能力**（见 12d）。散文进 translatable，语言中立不进
42. 每张主题/插件表**必须显式声明语言结构**：`tables[].language{strategy,translatable,
   fallback,requiredLocales}`。`strategy` 只有 `none` / `sidecar`（`versioned` 声明了但
   未实现 → 校验器**拒绝**而非忽略）。`strategy:"none"` 而表里有散文 = 断言为假，拒绝；
   `language.translatable` 与扁平的 `translatable` 不一致 = 两个权威，拒绝
43. 平台 schema 的租户/语言归属**只有一份声明**：`contract/schema.ts` 的 `PLATFORM_SCHEMA`。
   `TENANT_TABLES` / `PLATFORM_TABLES` / `DERIVED_TENANT_TABLES` / `LOCALE_COLUMN_TABLES`
   全部**派生**自它，不得手写（手写的一定会和声明漂移）
44. schema 声明**必须被真实数据库检验**（`tests/tools/_schema-scope.mjs`）：新表没分类 = 红；
   租户表没有 site_id = 红；平台表有 site_id = 红；`_i18n` 边车有 site_id = 红。
   **每一条分类都必须写理由**（≥10 字），派生租户必须写明 FK 路径
45. 领域事件是**独立于 hook 的契约**（`contract/events.ts`）：事件是**事实**（过去式、
   带 payload 版本、必带 siteId），hook 是**通道**。两者不得互相掺入
   （hooks 列表里出现事件名 = 红）。插件的 `subscribes[]` 在**安装边界**校验：
   订阅一个不存在的事件名是 400，不是"永远不触发的 hook"

【越界不变量：查询级】
46. 表有租户字段 ≠ 查询用它。`tests/tools/_tenant-query-audit.mjs` 列出所有触碰租户表
   却不带 site_id 的语句；每一处都必须有**书面裁决**（为什么安全）。
   没裁决的新语句会被标成 NEW —— 它是报告工具，不进 npm test
47. 平台表（`theme_installs` 等）上的跨站聚合是**设计**，不是泄漏：`active` 的含义是
   "有站点在用它"。判断泄漏看**声明**（schema.ts），不看表名前缀

【媒体：租户与所有者，两扇门】（AGENTS.md 规则 60）
60. 媒体文件有两个维度（`media_files.site_id` / `uploaded_by`）和**两扇门**
   （前台 `/media/<key>`、后台 `/api/v1/media`）。两扇门必须走**同一份**策略
   （`platform/media-policy.ts`），否则"列表里看得见的"和"真能取到的"会分叉
   a) `/media/` 的读取分支必须在**站点解析之后**匹配——对象键里的 `uploads/{siteId}/`
      段就是租户。守卫是**结构的**（解析 `index.ts` 的锚点顺序），不是行为测试：
      把分支挪回上面，只要所有站点恰好都是默认站，行为测试全绿
   b) 拒绝一律 **404**，绝不 403（403 等于确认"key 存在，只是不属于你"）
   c) 删除**先删 R2 对象、再删行**（行是唯一知道对象键的东西；先删行会留下无人能列出的字节）
   d) 上传是**唯一铸造租户的写入**，必须确认站点真实存在（`?site=` 只做形状校验）
   e) 策略是站点设置 `settings.cfpress.media`（`isolation: owner|site`、`require_session`），
      **解析不了 = 关（安全侧）**。⚠️ `require_session` 默认**开** ⇒ 未登录访客取不到媒体，
      前台 `<img>` 会 404；这是运营者的选择，可逆，排障第一站就是这个开关
   ⚠️ 三条闸门都答 404 ⇒ 断言必须盯"**哪一条**闸门"（`mediaReadDecision` 返回原因），
      并在套件里逐条单独打开。只在三条全关时断言"404"的写法，删掉任何一条都不会变红

【块：属性契约只有一份】（AGENTS.md 规则 61）
61. 块的属性集合**只在 `rendering/blocks.ts` 的 `CORE_BLOCKS` 里声明一次**，
   编辑器与渲染器都从它派生（`GET /api/v1/blocks` 下发，含翻译标签与 `itemKeys`）
   a) 渲染器每个 `case` 里 `a.<key>` 的读取集合必须**恰好等于**该块声明的 `attrs[].key` 集合。
      守卫**解析** switch 的 case 体，不是 grep 字符串
   b) `block-fields.js` 的 `RENDERED_ATTR_TYPES` 必须等于 `BLOCK_ATTR_TYPES`，
      且每种类型都有 `case` 分支（缺分支 = 静默退化成文本框）
   c) `media-list` 属性必须声明 `itemKeys`（条目形状属于属性本身；控件造不出来）
   ⚠️ 编辑器曾给**所有块**写 `attrs.text`，而渲染器按类型读不同属性 ⇒
      **12 种块里 6 种插入后前台渲染为空、HTTP 200、零异常**（第八例"声明先于运行时"）。
      修法是提契约、两侧同源派生，不是把 `attrs.text` 换成六个 `if`
   ⚠️ 只有**行为**断言能看见它：`tests/suites/editor-blocks.test.mjs` 把
      契约 → 控件 → 写入的属性键 → **真实渲染器 markup** 整条链跑一遍；
      架构守卫只能证结构一致。两者互补，缺一不可

【媒体控件与媒体 URL：各只有一处】（AGENTS.md 规则 62）
62. "选一个媒体文件"的三个消费点（块属性 / 自定义字段 / 扩展设置）必须共用
   `public/admin/js/media-picker.js` 的控件
   a) `data-media-field`（包装）与 `data-media-pick`（按钮）**只许**该模块产出
   b) `/media/<key>` 的 URL **只许** `mediaUrl()` 构造——手拼的 URL 遇到含 `/` 的文件名
      会被读取路径解成另一个 key（规则 60 还会按站点判它 404）。媒体屏曾有 3 处手拼
   c) 控件的唯一职责是"把 URL 写进发起请求的 input 并派发 `input`/`change`"，
      于是三个消费点都不需要新接线（块属性监听 / 设置表单 change 即存 / `[data-meta]` 保存时读）
   ⚠️ `media` / `media-multiple` 一直在 `ALLOWED_FIELD_TYPES` 里，而**编辑器自定义字段
      没有分支** → 静默掉进文本框。**"统一控件"不是重构，是补一个从未实现的能力**

【后台文案与词典】（AGENTS.md 规则 63）
63. `t(key, fallback)` 有英文兜底 ⇒ **缺键是静默的**（界面其余部分已本地化，只有这一条是英文）
   a) SPA 里 `t("…")` 的字面量键必须在**每个**核心语言包里存在
   b) 两个语言包必须声明**同一组键**
   c) `core.editor.*` 每个键都要有调用点
   ⚠️ 状态值落库仍是英文小写，**只翻译显示层**
   ⚠️ **`<option>` 不写显式 `value` 时浏览器拿文本当值** ⇒ 翻译标签会把 `草稿` 写进数据库
   ⚠️ 守卫只能证"键存在"，证不了"屏幕真的读了它" ⇒ 需要真浏览器验收（`_i18n-browser.cjs` §7）

【编辑器的定时器与身份】（AGENTS.md 规则 64）
64. 自动保存定时器是**平台级唯一**的一个，由编辑器启动、由导航停止
   a) 清理路径只有一处（`state.js` 的 `stopAutosave()`）；不得手写 `clearInterval(state.autosaveTimer)`
   b) `go()` / `switchSite()` 必须调用它——原本只在 `Back` 与保存成功两条路径里清，
      从侧栏离开会把定时器留在后台继续 POST（零失败、写入不可见）
   c) 已存在条目的 `#locale` **只读**：切语言 = 切版本（版本条），不是改写这一行的语言
   d) 保存/自动保存从 `state.editing.locale` 读语言，不从 DOM 读
   ⚠️ `publish_at` 必须往返（`table-form.js` 的 `toLocalInput`/`fromLocalInput`）；
      丢掉它 = "打开已排期文章再保存"会**静默取消排期**

【主题表的 i18n 侧表】（AGENTS.md 规则 65）
65. `theme_table_defs.i18n_table` 是门面唯一信任的字段
   a) 它的**粘性是有意的**（`COALESCE` 保留旧名）：禁用语言应当**隐藏**翻译，
      而不是重新启用时用主表值**重新播种**（会覆盖已保留的翻译）
   b) 但粘性 ⇒ 该字段**可以比它的表活得久**（夹具 drop / 手工清理）→ 首次写入报
      `no such table: …_i18n`（schema 形状的错误，成因是一条陈旧的行）
   c) **同步必须修复它自己写下的映射**：回读 `i18n_table`，非空就 `CREATE TABLE IF NOT EXISTS`（幂等）
   ⚠️ `scoped(path)` 的参数必须是路径：`scoped("media&page=1")` → `media&page=1?site=default`
      不匹配任何路由 → 404（在选择器里被吞成空列表 = "搜索无结果"）。`scoped()` 现在直接抛错

【捆绑主题经 Worker assets 分发】（AGENTS.md 规则 66）
66. 捆绑主题（`BUNDLED_THEMES`，`src/shared/bundled.ts`）的模板/语言文件**经 ASSETS 绑定
    分发**，运行时从 `public/themes/**` 读（`bundledThemeFile`），R2 只承载用户上传的主题
   a) 每个捆绑名必须对应真实的 `content/themes/<name>/theme.json`（清单 name 一致）；
      `content/themes/` 下的目录要么捆绑、要么**不发布**（`fixture`——测试夹具）。
      同步脚本的复制集**必须从 `BUNDLED_THEMES` 推导**，不许遍历整个 `content/themes/`
   b) `public/themes/**` **恰好等于** `BUNDLED_THEMES` 那几个主题的文件，**逐字节一致**——由
      `scripts/sync-bundled-themes.mjs` 生成（`predeploy` 与两个启动器都会先跑它）；
      两棵树不同步 = 用旧模板上线 = 架构测试红
   e) ⚠️ **`public/` 下的每个文件都是公网可读的**（`wrangler deploy` 原样上传），所以
      "发布集 = `BUNDLED_THEMES`" 是**安全边界**，不是便利。这条规则是**用事故换来的**：
      同步脚本原来镜像整个 `content/themes/`，于是测试夹具主题被发布到了线上
      （`https://<worker>/themes/fixture/theme.json` 实测 **200**），而当时的守卫断言的是
      "两棵树逐文件一致"——**它把泄漏钉成了正确**，套件在泄漏存在的整个期间都是绿的。
      **豁免必须是排除，不能是纳入**；一个"两个集合必须相等"的断言，要先问清
      "它们凭什么相等"。
   c) 主题内容加载的**每个消费点**（`runtime-declarative.ts` 的模板读取 / `activeTheme`
      探测 / 语言包读取，以及 `packs.ts`）都必须走 assets 兜底；删掉任意一处 = 清库后
      该路径退回 `__fallback__`（历史上 R2 是唯一来源，每次清库都要手工逐个上传 13 个
      对象才能恢复——那是补丁，不是设计）
   d) 捆绑名**不可被上传覆盖、不可被卸载**（`src/api.ts` 两处 "ships with the product"
      守卫读 `BUNDLED_THEMES`，不许抄一份名单）
   反向验证：`_skeleton-inject.mjs`（删兜底 / 两棵树漂移 / **夹具泄漏进 `public/themes`** /
   **同步退回整目录镜像** → 对应断言必须变红）；
   行为验证：`theme-integration.test.mjs` §10（空 R2 仍渲染 `home`，非 `__fallback__`）

【界面语言偏好：一个写者、两个读者】（AGENTS.md 规则 67）
67. 界面语言偏好（`site_users.ui_lang`）的**唯一写者**是 `public/admin/js/i18n.js` 的
    `setUiLocale()`；**任何屏幕都不得自己 POST `i18n/ui-locale`**
   a) 字典重载（`await loadMessages()`）**写在 `setUiLocale()` 内部**，调用方不得依赖
      自己记得重载——这个偏好有**两个前端读者**：顶部下拉的勾选读 `currentLocale()`
      （模块状态，只由 `setMessages()` 写），Languages 屏每次挂载读 `GET i18n/ui-locale`
   b) 被拒绝的切换（400：没有对应语言包）**必须抛出**：两个调用点各自处理
      （`shell.js` 弹 toast、Languages 屏弹对话框）。`catch {}` 会让这两处变成死代码，
      而"保存成功"的提示会盖在一个没变的语言上
   c) 注入/反向验证时必须注入**历史真实形状**：旧代码是「自己 POST + `toast()` +
      `render()`」，**不是**「自己 POST + `afterLanguageChange()`」——后者默认就会重载字典，
      于是注入会**假绿**（实测踩到）
   守卫：`admin-spa.test.mjs`（单写者扫描 + 写者必须重载 + 运行时"保存后勾选跟着走、
   不需要刷新" + "被拒绝时不改语言"）；注入场景 `_skeleton-inject.mjs`（3 个）；
   真浏览器 `_i18n-browser.cjs` §8（Node 守卫只能证代码形状，**证不了两个读者在浏览器里一致**）

【后台屏幕与 payload 契约】（AGENTS.md 规则 68）
68. 屏幕从**服务端实际放置的层级**读字段；不得提供一个只有"被拒绝"这一种可能结果的按钮
   a) `GET extensions/themes` 的 `active_by_site` 在**响应根**上，不在每个 item 上。
      读错层级恒为 `undefined`：不报错、不抛异常、不发失败请求，屏幕只是**说错话**
      （每个主题都写"未使用"，卸载按钮不带站点，预防性对话框永不可达，
      运营者点下去只拿到 409 `still active on: X`，而屏幕上刚说 X 没在用）
   b) 端点知道的事实必须随 payload 下发：捆绑主题的卸载**只会** 400，
      所以 `items[].bundled` 必须下发，屏幕据此改成一句说明而不是一个必然失败的按钮
   c) **守卫必须能看见缺陷**：改端点的缺陷要由"真的调端点"的套件观察
      （`admin-contract`），SPA 套件用的是自造 payload，看不见端点改动
   守卫：`admin-spa.test.mjs`（真 payload 形状渲染屏幕）、`admin-contract.test.mjs`
   （`bundled` 与端点的拒绝逐条一致）；注入场景 `_skeleton-inject.mjs`（2 个）

【注册行不等于安装】（AGENTS.md 规则 69）
69. 一行 `theme_installs` 让主题**能渲染**，不让它**拥有任何东西**。激活是用户动作，
    全新安装里没有这个动作 → 新站前台全对（中文页 / 切换器 / feed / sitemap），主题在库里
    **一行都没有**：`GET theme/fields` 返回 `{"items":[]}`，编辑器没有自定义字段，
    `savePost` 的 `fieldExists` 闸门把每个 `meta` 原样丢掉（HTTP 200、零报错、零写入）
   a) 启动链必须**先注册后安装**：`index.ts` 的 boot 块里 `await seedBundledExtensions(env)`
      之后必须跟 `await ensureThemeCapabilities(env)`。顺序是断言不是细节——
      后者经 `theme_installs` 解析活动主题，而那行正是前者创建的
   b) 安装逻辑只能在 `extensions/theme/capabilities.ts`（规则 4 禁止 `plugin/` import
      `theme/`）；`index.ts` 是唯一允许同时知道两层的模块，链接在那里
   c) 判据必须是**测量**（数行），不是版本戳：戳记「主题 X 版本 V 装过」必须被任何删除
      能力行的人作废，而套件共享同一个本地 D1、**正是**故意删这些行的 → 戳记会拒绝修复
      它唯一存在的理由。数行一次查询，且能自愈
   d) 判据必须**镜像清理面**：`clearThemeCapabilities` 从五张表 DELETE 并经注册表 API 清菜单，
      所以计数要问全这六处；漏一处 = 同一主题上"已装"与"未装"给出两个答案
   ⚠️ 已知并写在注释里：只声明 `settings[]`/`tables[]` 的主题在计数表里不占行，于是每次启动
      都会重跑（幂等 upsert，可接受），**不是**隐藏行为
   守卫：`architecture.test.mjs`（规则 69 节，5 条断言）；注入场景 `_skeleton-inject.mjs`
   （抽掉 boot 链第二句 / 把数行换成戳记）。
   **行为验证**：删掉本地 `field_defs`（套件本来就留下这个状态），重启 dev server 让 isolate
   全新启动，**不发任何激活请求**，字段自己回来——结构断言只能看到调用点存在，
   看不到它真的跑了

【post_meta 的语言读阶梯只许一处定义】（AGENTS.md 规则 70，批次 23 / 迁移 0019 / B5）
70. `post_meta` 自 0019 起带 locale 维度（`PRIMARY KEY(post_id, meta_key, locale)`），
    "这个语言读这篇内容的哪个字段值"是一个四级阶梯：本语言行（0）→ 站点默认语言行（1）→
    `''` 遗留行（2，0019 之前的共享行）→ 任意行（3）
   a) 阶梯**只许一处定义**：`platform/post-meta.ts` 的 `resolveMetaByPost` / `metaLocaleRank`。
      与 `resolveContentLocale`（规则 57）同一纪律；两份阶梯的退化形状是"卡片写着 设计、
      文章写着 Design"，逐请求、逐字段
   b) **每个读 `post_meta` 的模块**（列表 `attachMeta` / 单页 `findContent` / 主题 Worker
      `postMetaMap` / admin 语言行展开）必须经 `resolveMetaByPost` 解析。裸 SELECT 允许，
      重实现解析不允许
   c) **写入必须带语言**：`savePost` 的 meta upsert 绑定本次保存的 `locale`。写入丢语言 =
      全部落 `''` 层、最后写的语言赢（upsert 静默覆盖，HTTP 200）
   d) 迁移**不回填** `''` 遗留行（0019 头部注释记录原因）：回填替用户决定归属，阶梯第 2 层
      已让它们照旧渲染
   守卫：`architecture.test.mjs`（规则 70 节，3 条：唯一定义 + 读者全走阶梯 + 扫描非空）；
   行为：`locale-url.test.mjs` §1b（单页/列表按语言取值 + 阶梯第 2 层回退）；注入场景
   `_skeleton-inject.mjs`（5 条：列表丢语言 / 单页不挂字段 / 写入落 `''` 层 / 列表丢
   reading_time / 第二份阶梯定义）

【语言切换是取数，不是改名】（AGENTS.md 规则 71，批次 24）
71. 共享行形态把所有语言的内容装进 `GET posts/{id}` 的一个响应；版本条点击另一个语言
    时**只改 `state.editing.locale`** = 上一个语言的标题和块留在屏幕上、顶着新语言的名字，
    下一次保存把上一个语言的内容写进另一个语言的行（200 + 静默毁数据）
   a) 切换到已存在版本**必须重新取数**并传目标语言（`editContent(type, id, locale)`）；
      同 `posts` id 也不例外——共享行形态恰恰需要它
   b) `current.locale = locale; render()` 的改名形状被结构性禁止
   c) 后台内容列表**代表行 = 站点默认语言**，**永远不是 `MIN(locale)`**（字典序巧合）；
      `?locale=` 按语言过滤；被过滤语言没有行的文章**仍然列出**（不静默吞行）；
      每行携带 `locales`，SPA 画版本徽标
   守卫：`architecture.test.mjs`（规则 71 节，3 条）；行为：`admin-spa.test.mjs`（切换后
   标题/块/徽标来自目标语言）+ `admin-contract.test.mjs` §12；注入 `_skeleton-inject.mjs`
   （4 条：编辑器只改名 / 列表钉死语言 / 丢 `locales` / 列表只显示行自己的语言）

【拒绝必须带出口：强制卸载】（AGENTS.md 规则 72，批次 25）
72. 主题被占用时卸载 409，屏幕只说"请先在那里停用"——**没有出口的拒绝**就是
    "这个主题删不掉"的来源（与死锚点/不可达对话框同族：真实但没用的真话）
   a) 409 仍是**无条件强制路径**的权威：不带 force 照样拒绝；出口是显式确认（`?force=1`）
   b) 强制卸载先把占用站点的 `theme.active` 改回**捆绑默认主题**（规则 66 保证可渲染），
      再走同一条全局卸载清理（能力/菜单/设置/生成表/文件按主题名本来就是全局删）
   c) SPA 占用卡片弹**确认**（列站点 + 说明回落），不是死胡同提示框
   守卫：`architecture.test.mjs`（规则 72 节，2 条）；行为：`theme-integration.test.mjs` §9
   （占用中 force=1 → 200 + 占用站点回落 default）；注入 `_skeleton-inject.mjs`
   （force 被无视，历史形状逐字）

【菜单位置解析必须确定性】（AGENTS.md 规则 73，批次 26）
73. `menu()` 取 header 菜单曾是 `LIMIT 1` **无 ORDER BY**——两个 header 菜单时前台
    导航随 SQLite 心情翻转，请求之间会变而代码没动（与 MIN(locale) 同族：不确定读取）
   a) 位置 → 菜单的解析**定序**：`ORDER BY id LIMIT 1`，最小 id 稳定获胜
   b) 位置集合来自**激活主题 manifest 的 `menuLocations[]`**（渲染时直读，不落库、
      不需重新激活——区别于 routes[] 注册机制）；`buildScope` 输出 `menu.<id>` /
      `menu.<id>_html`，`menu.primary*` 是 header 别名（旧模板兼容）
   c) 条目管理完整 CRUD：批量重排一次提交全序列（服务端先验 id 归属再写）、嵌套仅
      一层、删父条目子条目**升级为顶级**；全部 site-scoped（规则 6）
   守卫：`architecture.test.mjs`（规则 73 节，4 条）；行为：`admin-contract.test.mjs`
   §13 + `theme-integration.test.mjs` §11（独立站点双 header 确定性 + footer 渲染）；
   注入 `_skeleton-inject.mjs`（LIMIT 1 无排序 + 硬编码 header，历史形状）

【小工具必须站点隔离地端到端】（AGENTS.md 规则 74，批次 27）
74. `widget_instances` 建表时没有 site_id，唯一读路径（`GET /widgets`）连租户过滤都
    没有——多站点下每个站点的侧栏显示所有站点的小工具（规则 6 泄漏的菜单孪生）
   a) 每次读取都带 `site_id`（前台 `widgetGroups` 与后台列表同样）；0020 重建表
      （site_id + locale，旧行归 default），契约 `tenant: "site"`
   b) locale 语义同 `menu_items`：`''` 全语言，指定语言只在该语言页面渲染——
      **故意不跨语言回退**（语言专属小工具是特性，静默串语言是缺陷）
   c) 前台接线是契约：`buildScope` 输出 `widgets.<sidebar>`（无则无键），消费点在
      layout/footer；`sidebars[]` 声明 = SPA 分组 = 渲染集合
   d) config 按类型校验（body / count 1–20 / menu_id 属本站点）；html 不过 esc
      （信任边界：仅管理员可写）
   守卫：`architecture.test.mjs`（规则 74 节，5 条）；行为：`admin-contract.test.mjs`
   §14 + `theme-integration.test.mjs` §12（四类型渲染 + 禁用/异语言/跨站均不出现）；
   注入 `_skeleton-inject.mjs`（渲染丢 site_id + 作用域无 widgets，历史形状）

【后台前缀是注入的，cookie 被它限定】（AGENTS.md 规则 75，批次 C）
75. 后台前缀可配（平台级 `admin.path`，默认 `/admin`），把整个后台挪到猜不到的位置。
    页照样渲染，所以失效是静默的：
   a) **SPA 不硬编码前缀。** `serveAdminIndex` 重写 `index.html` 三处 `"/admin/…"` 资产
      路径并注入 `window.CFP_ADMIN_BASE`；`state.js`/`i18n.js`（leaf，各自读同一个全局）
      与登录 fetch 全部由它拼 URL
   b) **后台 API 整套挂前缀之下**（`{前缀}/api/…`，剥前缀交给 `handleApi`），不只登录门。
      ⚠️ **重写 URL 必须带上 `u.search`**：第一版只从 `u.origin` 重建，经前缀进来的请求
      **所有查询参数全丢**（`?site=`/`?withCounts=1`/`?locale=`/分页），而 `/api/*` 拿原始
      request 照常工作——「有些参数生效、有些不生效」铺满后台，且**没有一个请求报错**
      （`?site=` 掉了就是「当前站点」= 默认值）。批次 28 站点屏看不到计数才发现
   c) **旧地址一律 404**：旧路由、旧 `/admin/*` **资产**、旧 `/api/v1/auth/login`——
      只 404 页面而放行 `/admin/admin.js` 等于留指路牌
   d) **cookie `cfpress_admin` + `Path=<前缀>`**（前台响应必须不含它；`Path=/` 会把后台
      会话带上每个前台请求；名字与批次 D 的 `cfpress_member` 区分）
   守卫：`admin-spa.test.mjs`（规则 75 节，5 条）；行为：`admin-contract.test.mjs`
   §0b/§0c（cookie Path / 旧登录 404 / 前台不 Set-Cookie / 连错 429 / 移动前缀后旧资产全 404）；
   注入 `_skeleton-inject.mjs`（SPA 硬编码 `/api/v1/` + cookie `Path=/` + cookie 名，历史形状）

【计数按站点分组，主题报「选了什么」】（AGENTS.md 规则 76，批次 28）
76. 站点屏是**管理**视图：每行要答「前台在哪、里面有多少、用什么渲染」。三个错答案
    都长得像对的答案，且都只在多站点时显形：
   a) **一个聚合、按站点分组。** `GET sites?withCounts=1` 用 `GROUP BY site_id` 的 `COUNT`
      给出每站 posts/pages/media。**丢掉 `GROUP BY` 的 `COUNT` 是最像对的错答案**——它给
      平台总数，每行都是个像样的数字，只有第二个站点存在时才看得出错。不带 `withCounts`
      时 payload 与从前**逐字节一致**（`counts`/`theme` 不出现），站点切换器与 `themes.js`
      都读这个端点
   b) **主题列 = 该站点选了什么**（`settings['theme.active']`），**不是** `activeTheme()`。
      后者答「该用什么渲染」、探测存储并按「装了就算数」命名主题，用于报表会把没选过主题
      的站点标成有主题。未选 = **空字符串**
   c) **新建站点当场播下语言行。** `seedSiteLocales` 的 doc 写着"called when a site is
      created"，却**从没被调用**（`createSite` 里补上）。新站点因此一辈子骑「无行 → 服务
      整个字典」的兜底且**没有 `is_default` 行**——"新站点是空壳、语言没人选过"的来源。
      断言读**表里的行**，不读服务出来的语言列表：兜底让两者一样，这就是它隐身的原因
   守卫：`admin-contract.test.mjs` §16（23 条）；注入 `_skeleton-inject.mjs`
   （`COUNT` 丢 `GROUP BY` + 主题改走 `activeTheme()` + 新建站点不播语言行，历史形状）
   另：站点屏前台预览链接由**该站点自己的**前缀/host 拼（`siteFrontEnd()`），拼当前站点的是错的
```

---

## 11. 系统骨架：schema / 语言结构 / 事件通道

第 2～10 章描述的是**功能**。这一章描述**骨架**——那些"不做也能跑，但迟早会在
多站点或多语言环境里静默出错"的东西。它们的共同点：**在单站点 + 单语言的安装里
完全看不出来**，而那是唯一有人手工测过的配置。

### 11.1 两个轴：租户与语言

每一个存储行都必须能回答两个问题：

| 轴 | 问题 | 表达方式 |
|---|---|---|
| **租户** | 这行属于哪个站点？ | `site_id`（或通过父行的 FK 继承） |
| **语言** | 这行是分语言的，还是语言中立的？ | `locale` 列 / `lang_group` + `post_translations` / `{table}_i18n` 边车 |

两个轴**互相独立**，而且**都不能从表名推断**：

- `media_files` 看着像全局，实际**必须**带 `site_id`（迁移 0009 才补上，之前
  静默跨站）；
- `locales` 看着像"每站的语言"，实际是**平台全局**的语言注册表——每站启用哪些
  是 `site_locales`（租户表）；
- `theme_eshop_product_i18n` 既不租户（通过父行继承），也不语言中立。

**这就是为什么归属必须是声明，而不是约定。**

### 11.2 单一权威：`contract/schema.ts`

```ts
export const PLATFORM_SCHEMA = [
  { table: "settings", tenant: "site", locale: null,
    note: "site settings (UNIQUE(site_id,key))" },
  { table: "post_meta", tenant: "platform", derivedTenant: "post_id → posts.site_id",
    locale: { kind: "column" },
    note: "custom post fields; scoped by the post they hang off; per-language since 0019 (read ladder in platform/post-meta.ts, rule 70)" },
  { table: "locales", tenant: "platform", locale: null,
    note: "language registry shared by all sites" },
  // …
] as const;
```

四条派生清单**全部由它算出**，禁止手写：

```ts
export const TENANT_TABLES        = PLATFORM_SCHEMA.filter(t => t.tenant === "site")…
export const PLATFORM_TABLES      = PLATFORM_SCHEMA.filter(t => t.tenant === "platform")…
export const DERIVED_TENANT_TABLES = PLATFORM_SCHEMA.filter(t => t.derivedTenant)…
export const LOCALE_COLUMN_TABLES = PLATFORM_SCHEMA.filter(t => t.locale?.kind === "column")…
```

> **为什么"派生"是硬规则而非风格**：手写的清单会在下一次编辑时与声明漂移，
> 而**消费脚本会与它读到的那一份一致**——两份清单都说自己对。这正是"共享定义
> 而不是共享结论"（规则 23）在数据层的应用。

#### 一个真实的假阳性：名字前缀不是判别器

`GENERATED_TABLE_RE = /^(?:theme|plugin)_[a-z][a-z0-9_]*$/` 看着能识别"扩展生成的表"，
但它同时匹配 `theme_installs` / `theme_settings` / `plugin_installs` / `plugin_settings`
——这些是**平台注册表**，设计上**没有** `site_id`。首次运行
`tests/tools/_schema-scope.mjs` 就在这 6 张表上假红了。

修法是让**声明**当权威：`isGeneratedBusinessTable(name)` 先查 `PLATFORM_SCHEMA`，
不在里面才按前缀认。**名字前缀无法区分"主题声明的表"与"关于主题的平台表"。**

### 11.3 语言结构声明：`tables[].language{}`（规则 42）

主题/插件声明表时，语言能力必须是**显式结构**，不能靠推断：

```jsonc
{
  "tables": [{
    "name": "product",
    "label": "Product",
    "translatable": ["name", "description"],       // 扁平式：哪些字段分语言
    "language": {                                    // 结构化：这张表如何承载语言
      "strategy": "sidecar",                         // none | sidecar | versioned
      "translatable": ["name", "description"],       // 必须与扁平式一致
      "fallback": "zh-CN",                           // 缺翻译时的回退语言
      "requiredLocales": ["en", "zh-CN"]             // 必须齐全的语言
    },
    "fields": [
      { "key": "name", "type": "text" },
      { "key": "price", "type": "number" },
      { "key": "sku", "type": "number" }
    ]
  }]
}
```

校验器（`contract/validation.ts`，安装边界）拒绝五种情况：

| 声明 | 为什么拒绝 |
|---|---|
| `strategy:"none"` 但表里有散文字段 | 断言为假——"这张表不分语言"与"它存着人读的文字"矛盾 |
| `language.translatable` ≠ 扁平 `translatable` | **两个权威**，读者会信先读到的那一个 |
| `language.translatable` 有、扁平 `translatable` 没有 | 同上，而且更隐蔽（看起来"声明得更全"） |
| `strategy:"versioned"` | 声明了但**未实现**。**拒绝比忽略好**——忽略会让作者以为生效了 |
| `language.fallback` / `requiredLocales` 里的非法 locale 码 | 拼错的 locale 永远不会匹配，且不报错 |

> `versioned` 的取舍值得记下来：这一版只有 `posts` 用 L1 式版本化，扩展表用
> `sidecar`。把一个**存在但不可用**的选项留在白名单里，等于承诺了没实现的能力。

### 11.4 检测脚本：把声明按到真实数据库上（规则 44）

`tests/tools/_schema-scope.mjs` **不读声明然后说它对**——那证明不了任何事。它：

1. 把 `migrations/*.sql` 应用到**临时目录里的真 SQLite**（不碰 `.wrangler/`：
   那是本机产物，CI 上没有、新鲜检出时陈旧、每个套件都在改它）；
2. **驱动真实的** `syncThemeTables()` 生成一对业务表 + `_i18n` 边车；
3. `PRAGMA table_info` 走一遍**真实 schema**，与声明逐条对照。

> 第 2 步不是装饰。生成的表是**运行时**创建的，迁移流里没有——只走迁移的话，
> 每一条关于生成表的断言都是**空转**，而且会一直绿。这正是首次运行时
> "非空性检查"抓到的问题。

它回答的问题与架构测试**互补**：

| | 问题 | 位置 |
|---|---|---|
| 架构测试 | 声明**自己**是否自洽、是否派生、是否重复 | `tests/suites/architecture.test.mjs` |
| schema 守卫 | 声明是否与**真实数据库**一致 | `tests/tools/_schema-scope.mjs` |

### 11.5 查询级不变量（规则 46、47）

表有 `site_id` ≠ 查询用了它。`tests/tools/_tenant-query-audit.mjs` 扫源码，列出所有
`FROM/INTO/UPDATE <租户表>` 而 6 行窗口内没有 `site_id` 的语句。

它是**报告工具**（不进 `npm test`），因为有些命中是对的：

- `src/shared/scheduler.ts:23` —— `UPDATE posts … WHERE id=?`，而 `site_id`
  **上一行刚从这一行读出来**；
- `src/api.ts:1141` —— `UPDATE theme_installs` 带跨站子查询，但 `theme_installs`
  是**平台表**，`active` 的语义就是"有站点在用它"。

所以每一处都必须有**书面裁决**，写在脚本的 `REVIEWED` 表里。没裁决的语句打印为
`NEW` ——**新泄漏看起来和旧豁免一样，除非你把它们分开**。

### 11.6 领域事件与消息通道（规则 45）

`hooks.ts` 回答"**哪里可以挂**"，`events.ts` 回答"**发生了什么**"。这是两个不同
的问题，混起来就是一个 `save_post` 因为触发者不同而有六种含义。

```
hook   是通道：宿主会调用的名字（beforeRender、html、…）
event  是事实：过去式的陈述 + payload（PostPublished、LocaleEnabled、…）
```

一个事件可以走多个通道；一个通道可以承载多个事件。`DOMAIN_EVENTS` 是 21 个事实，
`DECLARABLE_HOOKS` 是 7 个挂载点——数字不同**不是**缺陷，因为问题不同。

三条让它是**契约**而不只是常量表：

1. **名字只在这里声明一次。** 插件的 `subscribes[]` 在**安装边界**对照
   `DOMAIN_EVENTS` 校验，拼错 = 400，而不是"永远不触发的 hook"
   （`beforRender` 拼写错误就是这个病的上一次发作）；
2. **payload 带版本**（`EVENT_PAYLOAD_VERSIONS`，缺省即 v1）。加字段不用升版本，
   改名/删字段/改语义要升——**让破坏可评审，而不是静默**；
3. **事件自带作用域**。`siteId` 在**每一个**事件上不可或缺；`locale` 只在事实
   本身是分语言时出现（`PostPublished` 是，`SiteCreated` 不是，见
   `LOCALE_SCOPED_EVENTS`）。如此订阅者不会拿到一个**无法定位**的事实——
   而站点盲的插件 API 正是靠这一点藏了很久。

**这一版没有**事件总线、队列、重试。投递是宿主的business，今天是同步、进程内、
出错即丢（抛错的订阅者绝不能 500 掉请求）。**先声明词汇表**，是为了将来加持久化
投递时，那是**换传输**而不是**换形状**。

### 11.7 部署配置：一份手写、一份**生成**（规则 52–55 的一半）

三个文件，两条边：

```
wrangler.jsonc  (提交进仓库, REPLACE_WITH_* 占位符, 被评审)
      │  +  wrangler.ids.json  (gitignore, 真 id, 唯一手写的那份)
      └──────────────► wrangler.local.jsonc  (gitignore, **生成物**, 所有命令实际跑的)
                            node scripts/make-local-config.mjs
```

这个形状是被一次**真实漂移**逼出来的：批次 11 的功能开关 `vars` 块只加进了
`wrangler.jsonc`，两个批次无人发现——因为**漏一个 var 和写 `"false"` 解析结果都是"关"**。
线上 Worker 因此完全没有 `vars`，文档写的三层优先级实际只有两层；唯一的暴露方式是
"设一个 var → deploy → 发现开关没动"，而那时人会去看代码，不会去看配置。这是
「声明先于运行时」的形状，只是这次声明在 JSON 里。

**为什么是生成而不是"两份同构"**：只守"两份一致"仍然允许两份存在，也就允许它们再次漂移；
生成让"不一致"变成**不可表达**。`renderLocalConfig()` 是 (模板文本, ids 对象) 的**纯函数**，
守卫直接**重算**它再与磁盘逐字节比较，而不是重新描述一遍推导过程——第二份描述就是同一个
bug 升一层。

**为什么是文本替换而不是 JSON 序列化**：序列化会丢掉所有注释，而注释正是**实际部署那份**
文件的文档。替换后本地文件带着模板的全部注释，加上一段"这是生成物、别手改"的头。

**为什么 id 放在 `wrangler.ids.json` 而不是直接写进 `wrangler.local.jsonc`**：ids 文件是
这条链上**唯一手写**的东西，键名就是占位符名，所以模板加一个占位符只需加一行、零代码改动。
更要紧的是，它把"编辑哪个文件"变成**只有一个答案**。

⚠️ **启动器曾经把这个答案说反了，而且是个泄漏**：`act_deploy` 跑的是**不带 `-c`** 的
`wrangler deploy`（即部署**占位符那份**），拒绝信息还告诉运营者"把真 id 贴进 `wrangler.jsonc`"。
那个文件是**被 git 跟踪**的——照做之后下一次 `git commit -a` 就把一个在用的数据库 id 发到
公开仓库。现在启动器全部走 `-c "$CONFIG"`，并且在 dev/deploy/migrate 之前先跑生成器。

拆成三处守，因为可检查性不同：

| 守什么 | 断言在哪 | 为什么不能合并 |
|---|---|---|
| `varName` ↔ `wrangler.jsonc` 的 `vars` 键（**双向**：配置里有、没开关读它的键也算红） | `tests/suites/architecture.test.mjs` | 提交进仓库的文件，永远可断言 |
| **本地文件 = 重新生成的字节**（+ 模板无 id 形状的值 + ids 与占位符双向对齐） | `tests/tools/_config-parity.mjs`（进 `npm run gate`） | 本地文件与 ids 文件都 gitignore，新鲜检出时**不存在** |
| 启动器每条 wrangler 命令都带 `-c "$CONFIG"`，且读它之前先重新生成 | `tests/suites/launcher-parity.test.mjs` §8b | 提交进仓库的脚本，可断言 |

> ⚠️ 第二条**不能**写成套件里的断言。本地文件缺失时那条断言只能"跳过"，而跳过和通过
> 打印出来是一样的——**同一份配置，推导得完美和从没比对过，都会得到"绿"**。这正是本仓库
> 最忌讳的假绿。所以工具在文件缺失时明确输出 **n/a**，并且把这句话也打出来，让人无法
> 把它读成一次通过。

> ⚠️ 第三条的扫描**必须锚在"调用"上而不是"子命令"上**：拒绝信息里合法地含有
> `npx wrangler d1 create`（是建议不是命令），每个动作还会打印一行进度
> `head1 "wrangler deploy"`。第一版只匹配子命令，立刻在这两处假红。两个启动器都只经
> `npx` / `Invoke-Npx` 调 wrangler（Windows 上裸 `wrangler` 是个 `ps1` 垫片，spawn 不了），
> 所以锚在包装器上是精确的判据。

> ⚠️ 反向验证这条守卫时，注入落在 **`wrangler.jsonc`**（已提交），**不是**
> `wrangler.local.jsonc` / `wrangler.ids.json`。理由有两条：后两者在新鲜检出时不存在，
> 会让场景依赖机器状态；更要紧的是，`_skeleton-inject.mjs` 的 `assertPristine` **只覆盖
> `WATCHED` 里的文件**，往 gitignore 文件里注入而还原失败，会**静默带走这个账号的真实 id**。
> 把已提交的那一侧改到与本地不一致，触发的是**同一条**断言，风险为零。

---

## 12. 守卫失效记录（十五种假绿）

`tests/suites/architecture.test.mjs` 与各套件累计出过**十五次**"检查存在但从不触发"。
它们不都是同一个病，修法也不同——记录在此，因为**第十五次一定长得像前十五次之一**。

| # | 检查 | 曾经/现在的写法 | 为什么失效 | 修法 |
|---|---|---|---|---|
| 1 | `siteId` 默认值 | 只匹配 `= "default"` 字面量 | `siteId = DEFAULT_SITE_ID` 匹配不到，6 处长期漏网 | 同时匹配字符串与常量，锚定到参数列表 |
| 2 | 主题/插件互不 import | `spec.includes("/extensions/plugin/")` | 真实写法是 `"../plugin/runtime"`，不含 `/extensions/` | 按文件目录**解析路径**再比较 |
| 3 | 语言包 key 前缀 | 检查存在，但所有 `langs/` 都是空的 | **对空集合的检查是空转** | 先确认集合非空，再断言 |
| 4 | `clearOwnerMenus` 归属隔离 | fixture 拿主题 owner 对插件 owner | 两个 fixture 的 `owner_type` 本就不同，`owner_name` 是多余的——删掉它测试**依然全绿** | **反向验证的 fixture 必须只有一处差异** |
| 5 | `tests/suites/scaffold.test.mjs` 清理 | `rmSync(force:true)` | Windows `EBUSY` 失败且**吞掉错误**，生成器拒绝覆盖 → 残留旧文件全存活，**断言描述的是上一轮的产物** | **清理之后要验证清理成功** |
| 6 | 套件摘要 | 摘要在 `main()` 末尾打印 | 崩溃后控制流跳出，`N passed, M failed` **永远不打印**；脚本把"匹配不到"读成"没失败" | 摘要抽成 `finish()`，`catch` 里也调用并计一条失败；**没有摘要 = 失败** |
| 7 | 主题渲染断言 | 用 `grep` 数卡片个数 | `__fallback__` / 404 页让卡片数 = 0，与"空列表"无法区分 | 断言要盯**注入缺陷后必然变的那一个值** |
| 8 | 本文件的断言**拼法** | `check("…", offenders, [])` | `check` 测的是**真值**，空数组恒为真 → **断言不可能失败**。批次 6 新加的 7 条全中，重复的 `MediaUploaded` 躺在磁盘上而测试 40/40 全绿 | 加 `checkEmpty()`；再加一条**元守卫**扫本文件，禁止 `check(…, …, [])` 这种拼法 |
| 9 | 启动器 `deploy` 守卫被调用 | 断言 `Test-DeployPrecheck` 在定义体外出现过 | **它有两个调用点**（`Invoke-Deploy` 与 `Invoke-DeployFull`）；只删一个，另一个继续满足断言 → 部署路径已经不检查占位符而套件全绿 | **每个调用点各一条断言**，并按函数体切出来单独检查，不在整文件文本里搜 |
| 10 | 启动器套件表对齐 | `checkEmpty("… only by .ps1", onlySh)` | 从 `.ps1` 删一个套件时，红的是 `only by .sh`——**断言正确地红了，而场景的期望值写反了**，于是工具报"红得不对"，人差点去改对的代码 | 方向词（`only by X` / `missing from X`）**照集合差集的定义读一遍**再写进场景；工具必须打印**实际红了哪几条** |
| 11 | 套件自身的 `{{/section}}` 计数 | `src.match(/\{\{\/section\}\}/g)` | 数的是**原始文本**，而 `{{! … }}` 注释在解析前就被剥掉 → 把 `{{/section}}` 写进注释即可**伪装出"已闭合"**。注入时删掉真实闭合符、注释里留诱饵，这条断言**没有红**（第 6 节的 shell 不变量替它背了锅），而引擎的结构判据 `validateSections()`（AST 上 `n.body === null`）**正确地抛了** | **任何模板源码上的 token 计数先剥注释**（`replace(/\{\{![\s\S]*?\}\}/g, "")`）；同一个 bug 也出现在 `{{@include/@extends}}` 目标收集里，已一并修。**注入后要确认"红的是这一条"** |
| 12 | 插件页渲染器的**字段来源** | `plugin-pages.test.mjs` 只在**服务端**断言（模板渲染出的 HTML 字符串），`admin-spa.test.mjs` 只查模块图与导出 | 渲染器读 `data.fields` 而非 `data.def.fields`——两个套件**双双全绿**（15/0、46/0），因为**没有任何一条断言观测过渲染结果**。`tableAggregate` 忽略 `status` 参数同属此类。 | 加断言的**观测面**而非数量：装 DOM 替身、加载**真实**渲染器模块、断言 `<th>Label</th>`/`<td>7</td>` 真在 HTML 里（`plugin-pages.test.mjs` §9）。删掉它缺陷立刻复活 |
| 13 | **反向验证工具自己的收尾时机** | 注入工具的 worker 入口写成 `import(suite).then(() => done(0))` | `import()` 在**模块体执行完**即 resolve，早于套件 `main()` 的第一个 `await`。谁先结束 worker 谁说了算 → esbuild 编译慢的套件（`features`）确定性输掉，症状是"注入后没有摘要"——**把一次真红读成了运行器坏了**。批次 11 三个工具全中 | worker 入口**只由套件自己桩掉的 `process.exit` 收尾**，加 `reported` 守卫保证只结算一次。**判据：注入后必须读到摘要，读不到要区分"没摘要"与"红在别的断言上"** |
| 14 | **主题"装好了"这件事本身** | 规则 66 解决了捆绑主题的**分发渠道**，18 条断言全绿——所有人（包括守卫）都以为"主题装好了" | `seedBundledExtensions` 只写 `theme_installs` 注册行，**从不调 `applyThemeCapabilities`**；而 `activeTheme()` 会回退到注册表并探测可加载的 `index.html` → **主题照样渲染每一个页面**（中文页、切换器、feed、sitemap 全对）。声明面为空这件事**被"能渲染"完全掩盖**：`GET theme/fields` 返回 `{"items":[]}`，`savePost` 的 `fieldExists` 闸门把每个 `meta` 静默丢掉——线上实测 12 次 200、`post_meta` 零行、中英文首页全写「Uncategorised / 未分类」。规则 66 的断言问的是"**文件分发得到吗**"，**没人问"主题拥有什么"** | 加规则 69：boot 链**先注册后安装**；判据是**数行**不是版本戳（套件共享同一个本地 D1、正是故意删这些行的——戳记会拒绝修复它唯一存在的理由）；计数**镜像清理面**。**行为验证**：删掉 `field_defs` → 重启 dev server 让 isolate 全新启动 → **不发激活请求** → 字段自己回来 |

| 15 | **屏幕渲染守卫喂进去的数据** | `admin-spa.test.mjs`「每个注册页面都真渲染一遍」的桩 `fetch` 对所有列表统一回 `{items: []}` | 屏幕的**行渲染代码从不执行**，于是菜单屏少 import 的 `attr` 在 `.map((m) => attr(m.id))` 里永远走不到——浏览器一打开菜单页就 `attr is not defined`，而套件 63/0 全绿。**断言是对的、集合非空、控制流也走到了**：是喂进去的输入让屏幕退化成静态骨架，而骨架恰好不需要那些标识符 | 桩的默认 GET 改成**一行真实形状的记录**（`{...probeItem, items: [probeItem]}`，注意展开顺序——`probeItem` 自带空 `items`，放后面会把这一行又抹掉）；"渲染了错误面板"的失败信息**带上屏幕自己的报错文本**。反向验证：撤掉 `attr` 的 import，该条立刻红 |

### 十五种假绿的**共同盲区**（比十五条记录本身更重要）

十五条不是十五个随机的意外。把修法那一列竖着读一遍，会发现它们几乎全部落在**同一句话**上：

> **我倾向于检查「我写下的字」，而不是检查「实际发生的事」。**

| 检查的层次 | 假绿条目 | 为什么会假 |
|---|---|---|
| **字节层** | — | 长度相同、BOM 缺失、CRLF 混入：文本比较看不见 |
| **文本层** | 1、2、5、7、10、**11** | 匹配字符串，于是「同一意图的另一种写法」直接绕过（**11：注释里的 token 也算**） |
| **集合层** | 3、4 | 对空集合 / 只有一处差异的 fixture 施加断言 = 空转 |
| **控制流层** | 6、8 | 崩溃路径从不执行到断言；`check(…, [], [])` 这种拼法根本不可能失败 |
| **调用点层** | 9 | 断言「某函数被调用过」，而它有第二个调用点 |
| **观测面层** | **12**、**14**、**15** | 断言正确、集合非空、控制流也会走到——但**它观测的那一层看不见缺陷**（第 14 条：**分发渠道的守卫看不见「主题有没有安装」**；第 15 条：**喂给屏幕的是空载荷，行渲染代码根本没执行**） |
| **工具层** | **13** | **被守卫的代码、fixture、断言全都没错；错的是"谁来收尾这场实验"**——工具在套件还没得出结论时就宣布结束，于是把红读成了 abort |

注意这张表里**没有一条是"测试写错了"**——十五条全都是「守卫覆盖的范围比它声称的小」。
所以「第十五条」几乎必然长得像其中某一行，而**不是**一个新的、需要新修法的病。

**第 11 条印证了这个预测**：它落在**文本层**，跟第 2、5、7、10 条同一行，
不是新病——只是"另一种写法"这一次是**注释**。预测成立，但**预测成立本身不产生防线**：
那一次仍然是靠人**去读了"实际红了哪几条"**才发现真正的守卫没红。

**第 12 条则打破了这个预测，并且比预测更有用**：它**不落在那五行里**，它是**新的一层**。
断言全部成立——字段来源错误、集合非空、DOM 替身也装好了——只是那条断言
**观测的对象**（服务端拿到的 JSON / 模块导出 / 磁盘上的套件清单）里，
根本**不含那个缺陷**。这类假绿用"换一种写法"永远修不掉：
要修的是**眼睛对着哪里**，不是**眼睛怎么写的**。

**第 13 条又开了一层，比第 12 条更靠外**：它连"眼睛对着哪里"都没错——
被守卫的代码、fixture、断言三条全对。错的是**实验的收尾权**：工具在套件得出结论
之前就把这场实验关掉了，于是把"红"读成了"abort"。**十二、十三两条合起来说明一件事：
假绿可以发生在「被测对象之外」**——眼睛（观测面）和手（工具）都会骗你，
不只是被看的东西会骗你。所以"我的断言对不对"这个问题，永远问不到工具这一层，
只能靠**工具自己也跑一次反向验证**（否则就是"守卫的守卫"没有守卫）。

> 同层还有一例：`_launcher-inject.mjs` 的套件表对齐跑通后，
> `plugin-channels.test.mjs` **同时缺席四个注册表**（`package.json`、`run-all.mjs`、`.sh`、`.ps1`）
> 而三条既有断言全绿——因为它们都在检查"表里的东西在另一份表里"，
> **没人问"磁盘上的东西在不在表里"**。修法是扫真实清单（`launcher-parity.test.mjs` 第 5b 节）。

**第 14 条回到了第 12 条的同一行，正好印证了本节的预测。** 它不是"守卫写错了"，
也不是"眼睛没对着缺陷"那么简单——它观测的面（文件分发、树同步、兜底）**每一处都对**。
缺陷在**另一条没人观测的路径**上：注册行写了，安装没发生，而 `activeTheme()` 的
注册表回退让前台**照样渲染每一个页面**。**"能渲染"是这种假绿里最强的形状**，
因为它是全站所有测试的共同前提——谁都默认"页面出来了 = 主题装好了"，
于是"主题拥有什么"这个问题**从未被任何人问过**。
修法（规则 69）把两件事重新拆开：注册（`seedBundledExtensions`）和安装
（`ensureThemeCapabilities`），并在 boot 链上**按顺序**链起来——顺序本身也是断言，
因为反过来它会在自己本该修复的那次启动上读到空注册表。

**所以写新守卫时的第一个问题不是"哪一层"，而是"缺陷会不会出现在我观测的这个面上"。**
顺序是：缺陷 → 它在哪个可观测面留下痕迹 → 断言那个面。反了就是第 12 种。
**而第 14 条补了后半句：还要问"有没有一条正常路径会替这个缺陷把表象撑住"——
有的话，那个表象本身就是所有测试的盲区。**

**由此得到一个判据，写新守卫时先问**：

> 这条断言生效在**哪一层**？它检查的是字节、字符串、集合、控制流，还是调用点？
> 我是否在用一个**更低的层**（比如字符串匹配）去代理一个**更高的层**的事
> （比如"这个函数被真正调用"）？

**这条推论比十五条清单更有用**：清单会继续增长，但**层只有七层**。
清单从"十五种失败"压缩成"七层代理错误"之后，它就不再是荣誉榜，而是一张待偿还的债——
每一条都对应一个"本可以不这么写"的写法。

### ⚠️ 这套纪律**本身就是最大的单点风险**

必须写下来：上面全部十五条的防线，工程上**没有任何一条是自动的**。
反向验证是**人肉执行**的——每个注入场景靠人记得写、记得跑、记得还原。
`AGENTS.md` 的 checkpoint 8 写了"必须做一次反向验证"，但**它是一个祈使句，不是一道门**。

这意味着：**纪律的失效方式正是它要防的那种失效方式**——
某天赶时间跳过一次反向验证，套件依然全绿，而守卫已经空了。
**它不会报警，因为守卫恰恰是那个不会报警的东西。**

要把「第十五种」变成「最后一种」，只能把纪律**降级为机制**：

1. **新增守卫必须附一个注入场景**，否则守卫本身被拒绝（由元守卫检查
   "每条具名断言在某个 `_*-inject.mjs` 里有对应场景"）。
2. **注入场景由脚手架生成骨架**，红不了就拒绝提交——人只需要填期望值，
   不需要记得"要测"。
3. **"没有摘要 = 失败"要在工具层强制**（已做到），且**还原必须自证**
   （已做到：内容哈希 + `assertPristine()` 前后各一次）。

在第 1、2 条落地之前，这份清单的增长速度**就是纪律被消耗的速度**。
它不是战绩，是欠条。

### 第九、第十种的两个推论（都由 `tests/tools/_launcher-inject.mjs` 抓到）

**（a）"某函数被调用"要问调用点有几个。** 第九种与第七种（`resetPluginRuntime`
只测了一个 sink）、与第四种（fixture 只有一处差异）是同一个病：**只要还有另一个
等价的东西能满足断言，删掉被验的那一半就不会变红**。写断言时先问
"我把这一行删了，**同一个文件里还有哪一行能替它通过**？"

**（b）"红得不是这一条"要先怀疑期望值。** 第十种很值得记，因为它让我差点改错：
套件是对的，场景的 `expect` 写反了。工具的输出必须能区分三种结局——
**绿 / 红在这条 / 红在别的条**；只打印"有失败"就会把第三种读成第一种。
`_launcher-inject.mjs` 因此把实际红了的断言名整条打印出来。

### 第八种的两个推论（都由本轮的注入工具抓到）

**（a）反向验证的工具自己会假绿。** `tests/tools/_skeleton-inject.mjs` 有三个坑，全部踩过：

| 坑 | 症状 | 修法 |
|---|---|---|
| **量长度看不见等长替换** | `"site"`→`"sote"` 长度相同，守卫打印"什么都没改"，而注入**其实生效了** | 比**内容哈希** |
| **快照取自脏树** | 还原静默失败（`git checkout` 修不了 untracked 文件）→ 场景叠加；脏状态拍进快照 → "还原"忠实还原损坏 | 快照前 `assertPristine()`，还原后**再**跑一次 |
| **用子进程跑套件** | 本沙箱 `spawnSync` 一律 `EBUSY` → 每个场景报"没有摘要"，**跑不起来伪装成没变红** | 用 **Worker 线程**（同进程，无需二元文件），且 ESM 下用 `import()` 而非 `require` |

**（b）"没有摘要"必须双向成立。** 套件侧要保证崩溃也打摘要；**工具侧**要把
"读不到摘要"当成失败。只修一半，另一半就会把崩溃读成通过——本轮
`tests/suites/architecture.test.mjs` 自己就犯了这条（摘要原本在文件末尾），
是注入工具把它抓出来的。

### 判据：什么时候该加守卫

**每次新增守卫，都要注入一次违规确认它会红。** 不能证明自己会红的守卫，是负担
而不是资产——它会让人以为有保护。

**新守卫的检查清单**：

1. 它断言的是**结构**（路径/AST/类型/真数据库）还是**字符串**？
   守卫结构就解析结构；只有"某个名字不得出现"这种才是字符串检查（规则 2、5）。
2. 集合**非空**吗？对空集合的断言是空转（规则 3）。
3. 断言**有没有可能失败**？`check(…, list, [])` 不可能（规则 8）。
4. 注入违规后，**变红的是不是那一条**？不是就说明守卫和缺陷对不上。
5. 还原**被验证**了吗？
