# CFPress 核心体系强化需求与架构规划方案

> 状态：草案（已记录用户核心需求）  
> 责任人：AI Pair Programmer & Architect  
> 目标：对标 dotnetcms / WordPress，梳理并落地「固定链接体系、系统设置强化、插件系统实装、主题后台业务支撑（如商城）」四大核心系统。

---

## 一、 需求清单与现状差距分析 (Gap Analysis)

根据用户提出的需求，结合 CFPress 现有技术栈（Cloudflare Workers + D1 + R2 + 零构建 SPA），当前系统存在四大核心需求与现状差距：

| 序号 | 需求模块 | dotnetcms / WordPress 对标能力 | CFPress 现状 | 差距与解决思路 |
|---|---|---|---|---|
| **1** | **固定链接结构 (Permalink Structure)** | • 朴素 (`/?p=123`)<br>• 日期/月份/数字/文章名/自定义模式<br>• `%year%`, `%postname%`, `%category%` 等标签<br>• 规范 301 重定向 | • 硬编码 `/{locale}/blog/:slug`<br>• 旧 `urls.js` (URL Manager) 仅查简单重写表，无体系化规则 | • 彻底废弃旧 URL Manager<br>• 建立底层固定链接双向引擎（生成+正则反向解析）<br>• 统一前台动态路由接管与规范 301 重定向 |
| **2** | **系统设置体系加强 (Settings Enhancement)** | • 结构化分类分组（常规、写作、阅读、讨论、媒体、固定链接、隐私/SEO）<br>• 强类型校验（时区、语言、日期格式、角色、分页大小）<br>• 区分站点设置与语言设置 | • settings 表仅扁平 key-value<br>• 后台仅零散零配置项，无系统化分 tab 界面 | • 梳理并扩充 Settings 分组与元数据定义<br>• 增强后台「设置中心」多 Tab 面板<br>• 将固定链接、常规、阅读配置项纳入统一体系 |
| **3** | **插件系统实装与 Hook 测试插件 (Plugins & Hooks)** | • 完整生命周期 Hook<br>• 真正的实装插件（如 dotcms 中的 hook 演示/测试插件、通知插件、SEO 插件）<br>• 插件能力与宿主钩子可调试、可验证 | • `DECLARABLE_HOOKS` 声明了 8 个 hook（beforeRender, afterSavePost, footer 等）<br>• 仅有 `notify` 示例插件，缺乏直观的 Hook 验收与测试插件 | • 开发一个官方 **`hook-tester` (Hook 测试/审计插件)**<br>• 验证插件的全部 8 个 hook 触发流程与日志物化<br>• 确保插件生命周期与宿主完全联动并带严格守卫 |
| **4** | **主题后台业务支撑（如商城主题）** | • 主题带后台业务菜单（商品列表、订单管理、商品规格设置）<br>• 主题自有表（Product, Order 等）在后台直接具有完整的 CRUD 界面与操作流 | • 清单允许 `tables[]` 和 `adminMenus[].screen="table-list"`<br>• 缺乏一个像 dotcms 商城主题那样真正的 **Shop（商城）完整主题示范**<br>• 缺乏对表单联动、状态流转的更完整支持 | • 打造完整的 **`shop` (商城) 官方主题**<br>• 声明商品表 `products`、分类表 `product_categories`、订单表 `orders`<br>• 自动在后台生成带图标的业务菜单与 CRUD 管理界面<br>• 前台模板带商品展示、结算前台、多语言价格显示 |

---

## 二、 详细设计方案

### 1. 固定链接体系 (Permalink Engine)
- **架构设计**：
  - 在 `src/platform/permalink.ts` 中实现：
    - `compilePattern(pattern)`：将 `%year%/%postname%/` 等转换为带具名捕获组的 RegExp。
    - `buildPermalink(pattern, post, locale)`：正向生成文章规范 URL（服务于前台渲染、Sitemap、Feed、SEO hreflang）。
    - `matchPermalink(pattern, pathname)`：从当前请求 URL 提取变量，反查 `posts` 表。
  - **前台路由改造**：
    - `src/index.ts` 动态调用 `matchPermalink`。
    - 若访问 `/?p=123` 或历史格式，自动 301 跳转至规范固定链接。
  - **后台 SPA**：
    - 废弃 `public/admin/js/screens/urls.js`，新增 `public/admin/js/screens/permalinks.js`。
    - 提供预设选项（朴素、日期和名称、月份和名称、数字型、文章名、自定义结构）与标签插入 Chips。

### 2. 系统设置体系强化 (Settings Subsystem)
- **设置分类结构**：
  - `general`：站点标题、副标题、管理员邮箱、会员注册、时区、日期格式、时间格式。
  - `reading`：首页显示（最新文章 / 静态页面）、博客页面每页文章数、Feed 摘要还是全文。
  - `writing`：默认文章分类、默认文章形式。
  - `permalink`：固定链接结构（与固定链接体系无缝联动）。
- **API & 存储**：
  - 保留 D1 `settings` 表的通用性，但在 `src/platform/settings.ts` 增加类型校验、默认值与分组 schema。

### 3. 插件系统实装与 Hook 测试插件 (Hook-Tester Plugin)
- **目标**：不光有契约，还要有真实可跑、可调试的插件。
- **实施方案**：
  - 新建 `content/plugins/hook-tester/`：
    - 声明全部支持的 hooks：`beforeRender`, `afterSavePost`, `head`, `footer`, `html`, `auth` 等。
    - 声明私有数据表 `hook_logs`：记录每次触发的 hook 名称、时间戳、上下文参数、耗时。
    - 声明后台管理页面 `adminPages`：提供日志查询与实时清除功能。
  - 编写配套集成测试 `tests/suites/hook-tester.test.mjs`，确保每个 hook 触发都写入日志且守卫生效。

### 4. 主题后台功能与商城主题 (Shop Theme with Admin Capabilities)
- **目标**：以「商城主题 (Shop)」为例，全面贯通主题声明后台管理界面的能力。
- **实施方案**：
  - 打造 `content/themes/shop/`：
    - `tables`:
      - `products`: 字段包含 `name`, `sku`, `price`, `stock`, `cover_image`, `description`，标记 `translatable: ["name", "description"]`。
      - `orders`: 字段包含 `order_no`, `total_amount`, `status`, `customer_name`, `customer_email`。
    - `adminMenus`:
      - 商品管理 (`screen: "table-list"`, `table: "products"`, `icon: "box"`)。
      - 订单管理 (`screen: "table-list"`, `table: "orders"`, `icon: "shopping-cart"`)。
    - `templates`:
      - `index.html`: 商店首页，网格展示推荐商品。
      - `archive-product.html`: 商品分类列表。
      - `single-product.html`: 商品详情页、多图轮播与购买按钮。
      - `cart.html`: 购物车与简易结账页。

---

## 三、 四阶段落地计划 (Phased Roadmap)

```
[阶段一：固定链接底层与设置集成]
   ├── 编写 src/platform/permalink.ts (编译器 + 双向匹配器)
   ├── 增加全覆盖测试 tests/suites/permalink.test.mjs
   └── 扩充 settings.ts 规范化设置项
          ↓
[阶段二：前台路由解耦与后台固定链接屏]
   ├── 改造 src/index.ts & frontend.ts 支持动态固定链接分发
   ├── 支持 /?p=123 的 301 规范重定向
   ├── 废除旧 urls.js (URL Manager)
   └── 替换为现代化「固定链接设置」SPA 屏
          ↓
[阶段三：插件生命周期实装与 Hook-Tester 插件]
   ├── 建立 content/plugins/hook-tester
   ├── 贯通所有 8 个 declarable hooks 的实际执行链路
   └── 编写 hook-tester 自动化守卫测试套件
          ↓
[阶段四：主题后台业务能力强化与 Shop 商城主题]
   ├── 扩展后台 table-list / table-form 交互体验
   ├── 搭建 content/themes/shop 商城主题全套模板与数据声明
   └── 编写商城的单测与多语言数据验证
```

---

## 四、 立即执行的第一步建议

按照既定计划，先将**阶段一（固定链接引擎 `src/platform/permalink.ts` + 单测 `tests/suites/permalink.test.mjs`）**开发并跑通，为后续设置体系和前台路由打下最稳固的基石。
