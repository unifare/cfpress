# 菜单 / 小工具 / 站点 落地方案（批次 26–28 规划）

> 状态：**批次 26 菜单 ✅ 已完成**、**批次 27 小工具 ✅ 已完成**、**批次 28 站点 ✅ 已完成**
> （提交见 git log：26/27 见 `91664e0` 一带，28 见 `9b89ed6`）。
> `menuLocations`/`sidebars` 最终采用**渲染时直读 manifest** 方案——比 routes[] 的
> 注册机制更简单，且天然不需要重新激活；widget 的 locale 语义与 menu_items 对齐
> （''=全语言、指定语言只在该语言渲染），未采用 meta 阶梯——侧栏小工具要的是
> "按语言显示/不显示"，不是跨语言回退。
> §3.2 还债早由 `91664e0` 完成（`deleteSite` 走 `PURGE_ON_SITE_DELETE` 派生清单），
> §3.1 站点屏增强与 §3.3 测试本轮完成；过程中另查出 `createSite` **从未调用**
> `seedSiteLocales`（新站点没有语言行的根因），一并修掉，见 **规则 76**。
> 原则：一切按现有框架惯例走 —— 站点隔离（rule 6）、locale 读阶梯（rule 70）、
> 拒绝带出口（rule 72）、反向验证、规则三处同步、改完必须 commit。

---

## 0. 现状体检（实测结论，先量化再说"没实现"）

| 功能 | 数据表 | API | 后台 SPA | 前台渲染 | 结论 |
|---|---|---|---|---|---|
| 菜单 | ✅ `menus`+`menu_items`（site-scoped，item 带 locale、parent_id） | ⚠️ 只有列表/新建菜单、列出/新增条目；**无改/删菜单、无改/删/排序条目** | ⚠️ 只读表格+新建对话框，无条目管理 | ⚠️ `platform/frontend.ts menu()` 取 `location='header'` 的 **LIMIT 1 无排序**（多个 header 菜单时结果不确定）；theme.json 未声明菜单位置；`menu.primary_html` 是硬编码上下文 | 骨架在，管理面和确定性缺失 |
| 小工具 | ❌ `widget_instances`（0005）**没有 site_id** —— 多站点会串台（另一站点的侧栏出现在本站） | ⚠️ GET/POST 各一条，**无 PUT/DELETE/排序/启停**；POST 连正文都不收 | ❌ 只读表格+新建对话框（没有内容字段，建出来的 text widget 是空的） | ❌ **完全没有接线**：`buildScope` 不查这张表，模板没有 sidebar 区域 | 三无：无内容、无管理、无渲染 |
| 站点 | ✅ `sites` + 路由解析（prefix→host→default） | ✅ GET/POST/PUT/DELETE 全通（实测 200） | ⚠️ CRUD 可用，但缺管理深度：无前台预览入口、无站点内容概况、无主题/语言跳转、新建站点是空壳（无默认语言引导） | ✅ 多站点路由本身可用 | 可用但浅；`deleteSite` 残留 `theme_table_defs`/`admin_menu_registry`（已知债） |

---

## 1. 批次 26 —— 菜单（管理面 + 确定性）

**目标**：后台能完整管理菜单（增删改、拖拽排序、嵌套、按语言设条目），前台按声明渲染。

### 1.1 数据层（无迁移）
`menus` / `menu_items` 结构已够用（`sort_order`、`parent_id`、`locale` 都在）。**不需要迁移**。

### 1.2 API 补齐（src/api.ts）
```
PUT    menus/:id            { name, location }        → 校验 location 非空
DELETE menus/:id            → 连带删 menu_items（同 site）
PUT    menus/:id/items      { order: [item_id,...] }  → 批量重排（拖拽结果一次性提交，防逐条竞态）
PUT    menu_items/:id       { title, url, target, locale, parent_id }
DELETE menu_items/:id
```
- 全部 site-scoped（`WHERE site_id=?`，防 rule 6 教训复发）。
- 嵌套校验：`parent_id` 必须属于同菜单且不许成环（深度 >2 直接 400，首版只做一层嵌套）。

### 1.3 前台确定性（规则 73 拟定：菜单位置解析必须确定性）
- `platform/frontend.ts menu()`：`LIMIT 1` 前加 `ORDER BY id`，消除不确定性；
- theme.json 新增声明（沿用 routes[] 的既有机制，`ensureThemeCapabilities` 注册）：
  ```json
  "menuLocations": [{ "id": "header", "label": "Header" }, { "id": "footer", "label": "Footer" }]
  ```
- `buildScope` 按 **location → 指派菜单 → items** 输出 `menu.header` / `menu.footer`（数组 + `_html` 各一份）；
  `menu.primary`/`primary_html` 保留为 `menu.header` 的别名（旧模板兼容，注释说明）。
- **既有安装注意（rule 69 教训）**：新增 manifest 声明需要重新激活主题才注册 —— 部署后线上要再激活一次 default。

### 1.4 后台 SPA（public/admin/js/screens/menus.js 重写）
WordPress 式双栏：
- 左：菜单列表 + 「新建菜单」+ 每个菜单的位置下拉；
- 右：选中菜单的条目树（展开一层子级），每条目行内编辑标题/URL/语言/排序，拖拽改 `sort_order`（HTML5 dragstart/drop，提交 `PUT menus/:id/items`）；
- 添加条目来源：自定义链接 / 站点文章（`GET posts?locale=`）/ 页面；
- 删除菜单必须带确认对话框（rule 72：拒绝带出口的姊妹面——删除带确认）。

### 1.5 测试
- admin-contract：菜单 CRUD + 批量排序 + 嵌套成环 400 + 跨站点隔离（B 站点管理员取不到 A 站点菜单）。
- theme-integration：双 header 菜单时输出确定性（建两个，断言按 id 排序取第一）；`menu.footer` 渲染。
- architecture：`menu()` 必须 `ORDER BY`（规则 73）；`buildScope` 不允许硬编码 `location='header'` 直查。
- `_skeleton-inject`：注入「LIMIT 1 无排序」历史形状 + 「无 site_id 的 menu_items 查询」。

---

## 2. 批次 27 —— 小工具（先修表，再接线）

**目标**：widget 真正从后台流到前台侧栏，且站点隔离。

### 2.1 迁移 0020（仿 0019 重建表套路）
```sql
-- widget_instances 加 site_id，PRIMARY KEY(id) 不变，索引 (site_id, sidebar, sort_order)
-- 旧数据全部归入 'default' 站点（与 0009 多站点迁移同哲学）
CREATE TABLE widget_instances_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'default',
  sidebar TEXT NOT NULL,
  widget_type TEXT NOT NULL,
  title TEXT, config TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO widget_instances_new SELECT id,'default',sidebar,widget_type,title,config,sort_order,enabled FROM widget_instances;
DROP TABLE widget_instances; ALTER TABLE widget_instances_new RENAME TO widget_instances;
```
- `extensions/contract/schema.ts`：`widget_instances` 从 `tenant: "platform"` 改 `tenant: "site"`。

### 2.2 API 补齐
```
GET    widgets            → WHERE site_id=?（scoped 化，跟随 ?site= 上下文）
POST   widgets            → 绑定 site_id；config 按 widget_type 校验
PUT    widgets/:id        { title, config, sidebar, sort_order, enabled }
DELETE widgets/:id
```
- config 契约（`config` JSON 列）：`text/html` → `{ body }`；`recent-posts` → `{ count: 5 }`；`menu` → `{ menu_id }`。

### 2.3 后台 SPA（public/admin/js/screens/widgets.js 重写）
- 按 sidebar 分组（header/footer/sidebar 三组卡片），组内上下移改 `sort_order`；
- 新建/编辑对话框按类型出表单（text/html 出正文 textarea —— 现在连这个都没有）；
- 启停开关（`enabled` 列已在表里，从未被消费）。

### 2.4 前台接线（核心工作量）
- `buildScope` 并行追加 `widgetInstances(env, siteId, locale)`（platform 层新函数，放 `platform/frontend.ts`，与 `menu()` 并列）；
- 渲染规则：
  - `text`/`html`：config.body 直出（html 不过 esc —— 与现有 block 渲染一致，文档注明信任边界：仅管理员可写）；
  - `recent-posts`：复用 `runThemeQuery` 的文章查询 + reading_time（**10ms CPU 复核过：字符串扫描可接受**，别再引用旧错误结论）；
  - `menu`：复用批次 26 的菜单渲染；
  - `enabled=0` 不渲染；`locale` 维度：widget 的标题/正文按 rule 70 阶梯（自有 locale → 站点默认 → 任意），**复用 `resolveMetaByPost` 思路新写 `resolveWidgetConfig`，不复制阶梯逻辑**。
- `layout.html` 增加 `{{#each widgets.sidebar_html}}` / `footer_html` 消费点；theme.json 补 `"sidebars": ["sidebar","footer"]` 声明。
- **预算**：每页渲染多 1 次查询（widget 行）+ recent-posts 的文章查询；单页 D1 查询数仍在免费计划余量内，theme-integration 里加计数断言防劣化。

### 2.5 测试
- admin-contract：widget CRUD + site 隔离（迁移后旧数据归 default）；
- theme-integration：sidebar 渲染 text/recent-posts/menu 三类型、disabled 不出现、跨站点不串台（**这条是迁移的直接动机，必须有具名断言**）；
- `_skeleton-inject`：注入「widgets 查询无 site_id」（历史形状 = 现在的 1856 行）。

---

## 3. 批次 28 —— 站点（管理深度 + 还债）

**目标**：站点不只是"能建能删"，而是"能管"。

### 3.1 站点屏增强（public/admin/js/screens/sites.js）
- 每行新增：
  - **前台预览**链接（path_prefix 有 → `/prefix/`，host 有 → 构造 host URL，否则 `/`）；
  - **内容概况**：文章/页面/媒体计数（一次 `GET sites?withCounts=1` 聚合返回，别 N+1）；
  - **当前主题**徽标 + 点击跳主题屏（该站点上下文）。
- 新建站点成功后弹"下一步"引导：设置默认语言（复用 site_locales API）——新站点空壳问题的最小修法，不做完整向导。

### 3.2 还债（已知未修清单顺手清）
- `deleteSite` 补清 `theme_table_defs` / `admin_menu_registry` 残留行（与 `uninstallTheme` 的清理对齐）；
- 测试：删除站点后 `GET admin-menus` 与 `theme/capabilities` 无该站点残留。

### 3.3 测试
- admin-contract：withCounts 计数正确性、deleteSite 清理完整性；
- `_skeleton-inject`：注入「deleteSite 不清 admin_menu_registry」历史形状。

---

## 4. 每批次通用纪律（不变）
1. 反向验证：每个具名断言必须在 `_skeleton-inject.mjs` 补历史真实形状场景；
2. 套件逐个跑（沙箱 spawnSync EBUSY），绝不并行；
3. 规则三处同步（AGENTS.md + ARCHITECTURE.md §10 + architecture.test.mjs）；
4. 提交信息英文、msg 文件放 `$TEMP`、push 用当前代理端口、`gh api` 独立验证 ref；
5. 部署后：新增 manifest 声明（menuLocations/sidebars）→ **重新激活 default 主题**；提醒用户硬刷新后台。

## 5. 批次顺序与理由
26 菜单 → 27 小工具 → 28 站点：小工具的 `menu` 类型依赖批次 26 的菜单渲染；
站点屏的主题徽标依赖扩展屏现状，放最后做还债最省。
