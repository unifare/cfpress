# AGENTS.md — 硬规则

这份文件是给 AI（以及人类）改这个仓库时的**强制约束**。完整设计理由见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。这里只列会**导致测试失败**的规则。

> 有疑问时：规则本身由 `tests/suites/architecture.test.mjs` 强制执行。
> 改规则必须同时改测试，否则规则不存在。

---

## 改动面清单（Definition of Done）—— **先读这一节**

完整版与**交织矩阵**见 [`docs/CHANGE-CONTRACT.md`](docs/CHANGE-CONTRACT.md)。
`docs/ARCHITECTURE.md` §10 是**历史教训目录**（踩过的坑）；那份契约是**要做的清单**。

**铁律：任一「适用」维度未覆盖 = 没做完。** 不适用的维度要**写明为什么不适用**，
不能默认跳过——本仓库所有「丢三拉四」都是这一条的反面：改动者心里只有 1–2 个维度，
而系统有 **20** 个（批次 C–E 后新增 18–20，见契约 §8）。

动手前先过一遍，交付时逐条给出「做了 / 不适用（为什么）」：

```
 1 分层          shared ← platform ← rendering ← extensions ← index.ts，只向右依赖
 2 租户          表有归属声明 + 查询带 site_id + 删站点不留注册表残留
 3 内容语言      lang_group + 每语言一行 + 每语言自己的 slug + 回退阶梯只一处
 4 界面语言      每个用户可见串走 t() + 中英两套 + 界面语言≠内容语言
 5 主题数据语言  tables[].language{} + 散文字段标 translatable + _i18n 永不 drop
 6 菜单语言      menu_items.locale（'' = 全语言，故意不跨语言回退）
 7 小工具语言    widget_instances.locale + 每次读取带 site_id
 8 URL/SEO       显式语言 404 不回退 + alternates/hreflang + per-locale feed/sitemap
 9 用户与权限    requireAdmin + capability + 越权 403 + 每用户偏好带 user_id
10 扩展契约      每个声明都被消费 + validateManifest + 注册行 ≠ 安装
11 hook/事件     DECLARABLE_HOOKS / DOMAIN_EVENTS（事件是事实，不是通道）
12 渲染          只解释不执行 + CORE_BLOCKS 唯一声明 + include/section 配得上
13 缓存          改内容/主题/设置之后 bumpContentCache
14 后台 SPA      注册屏 + WINDOW_HANDLERS + 按服务端层级读字段 + URL + 桩载荷非空
15 迁移          只增有序 + 改 PK 要重建表 + 遗留行不回填 + 新表进 schema
16 测试与文档    规则三处同步 + 新套件进四张表 + 文档里写的路径必须存在
17 部署          配置一份生成 + 主题随 assets + 新增声明要重新激活 + ps1 的 BOM
18 前后台分离    两套身份从存储到 cookie 分开 + 没有东西可交换（member cookie 打后台 401）
19 后台隐身      整个后台挂可配前缀 + SPA 不硬编码 + 旧地址 404 不重定向 + cookie Path 限定
20 每站点角色    can(…,siteId) 必填 + 查成员表带站点过滤 + 不回退 + UI 问和 API 同一个问题
```

**最容易漏、也最贵的三条交织**（完整表见契约 §2）：

- **加表 / 加字段** → ① `contract/schema.ts` 分类（租户 + 语言 + 理由）
  ② 扩展表要写 `tables[].language{}` ③ **读它的每个查询带 `site_id`**
  —— 不带 = 多站点串台，而**单站点安装测不出来**。
- **加 / 改后台屏** → ① 每个串 `t()` 且中英齐 ② 内联 `onclick` 的 handler 登记进
  `WINDOW_HANDLERS` ③ **桩载荷必须非空** —— 空载荷会让屏幕的行渲染代码从不执行，
  少 import 一个标识符也能一路绿到浏览器（§12 第 15 种）。
- **改内容保存路径** → ① `bumpContentCache` ② 每语言自己的 slug
  ③ `meta` 按语言写（`resolveMetaByPost` 是唯一读阶梯）。

**批次 C–E 新增的三条边界**（「一直在、加第二实例才暴露」，详见契约 §1 维度 18–20 / §8）：

- **加第二个身份面**（新 cookie / 新会话表 / 新解析器）→ 必须回答「**另一套**身份的凭据打过来会怎样」，
  答案必须是 401 且**由构造给出**（不同表 + 不同 cookie 名 + 不同端点前缀），不是靠"记得写"的检查。
  **改了 A 的解析器去读 B 的会话表，没人去试的话红线测试照样绿。**
- **加 / 改后台入口**（前缀、路由、资产、登录端点）→ ① SPA 不硬编码前缀 ② 旧地址**一律 404**
  含旧资产 ③ **重写 URL 必须带 `u.search`**（丢了 query 没有一个请求会报错）。
- **加 / 改权限判断** → ① `siteId` 从调用点**必传**（不是可选带默认）② 查成员表**带站点过滤**
  ③ **绝不回退 `site_users.role`** ④ 后台角色集**派生** ⑤ **屏**读的字段和 API 问的**同一个**
  （`role_here` 不读安装级 `role`）——API 不再问的问题，屏还在答，**不报错，只是答错**。

**为「几十种语言」做准备**（今天 2 种，目标是几十种）：**不得**写 `locale === "en"`
这类分支、不得把语言清单写死在数组里、不得用 `ORDER BY` 的第一个语言或 `MIN(locale)`
当「站点默认语言」（站点默认只从 `site_locales.is_default` 读）。
语言字面量只允许出现在 i18n 层，`node tests/tools/_locale-literal.mjs` 会拦，
每条白名单都要写理由。

**发现一个「以后每次都要做」的东西时**：写进契约 §1/§2/§3 + 这一节 +
**尽量变成机器判据**（能断言的别留在文档里）+ **反向验证**它。
只写文档不写判据 = 它会在下一次改动里消失。
**守卫要锚在「消费」上，不是「提及」上**——锚在子串或距离窗口上的守卫**永远绿**
（批次 E2 的两条守卫第一版都是死的，是反向验证抓到的，不是评审抓到的）。

---

## 改代码前

1. 跑 `npm test`，确认基线是绿的（**判据是 0 failures**；断言数会随套件增减变化）。
2. 跑 `npx tsc --noEmit`，`src/` 必须 0 错误。
   （`node_modules` 里 `lib.dom.d.ts` 与 `@cloudflare/workers-types` 的冲突是上游问题，可忽略。）
   ⚠️ 本机 `npm test` 会因沙箱锁住 node 二元文件而**整体报 SKIP（`EBUSY`）**——
   那不是测试失败。可靠做法是逐个 `node tests/<name>.test.mjs`。

## 改完代码后

3. 再跑一次全部套件与 `npx tsc --noEmit`，都必须绿。
4. 如果改了扩展的声明能力（主题清单 / 插件清单的字段），同步更新
   `tests/suites/architecture.test.mjs` 与 `docs/ARCHITECTURE.md`。
5. 如果改了多语言（`src/platform/i18n/`、翻译组、主题自有表），跑
   `node tests/suites/i18n.test.mjs`，并同步 `docs/ARCHITECTURE.md` §2.7 / §5.4①。
   **如果动了字段分类表（`PROSE_FIELD_TYPES` / `LANGUAGE_NEUTRAL_FIELD_TYPES`）
   或规则 41 的任一强制点，必须跑 `node tests/tools/_i18n-field-inject.mjs`** ——
   它注入 6 个缺陷、断言每个都真的变红（含"断言注入确实生效"与"还原也验证"）。
   **任何与语言有关的逻辑（尤其"以后会有几十种语言"的假设）都要跑
   `node tests/tools/_locale-literal.mjs`** —— 它拦 `locale === "xx"`、
   `/^zh/i.test(locale)`、写死的语言清单，以及 i18n 层之外的任何语言字面量。
6. 如果改了后台界面，跑 `node tests/suites/admin-spa.test.mjs`，并跑一次真实浏览器验收
   `node tests/tools/_i18n-browser.cjs` / `node tests/tools/_admin-menus-browser.cjs`
   （需要另开 `npx wrangler dev --port 47913 --ip 127.0.0.1`）。
   ⚠️ 该套件"每个注册页面都真渲染一遍"那条守卫，桩 `fetch` 的默认 GET 必须回**一行真实
   形状的记录**——回空数组时屏幕的行渲染代码**从不执行**，少 import 一个标识符
   （`attr`）就能一路绿到浏览器里 `attr is not defined`（§12 第 15 种）。
   ⚠️ **URL 就是页面**：`state.page` 与 hash 是一件事的两种拼法，写入点只有 `render()`
   里的 `syncHash()`；页名映射是通用的（`:` ↔ `/`），新增 `foo:` 前缀不需要改它。
   别在别处手写 `location.hash`——那会让 URL 与屏幕分叉。
7. 如果改了 `src/rendering/template-engine.ts`、`src/extensions/contract/*`、
   或 `scripts/make-*.mjs`，跑 `node tests/suites/scaffold.test.mjs`。它用**真实校验器**与
   **真实模板引擎**跑生成的骨架——**生成器的缺陷只有渲染一遍才会现形**（见下方规则 4）。
7b. **如果加了数据库表、改了表的租户/语言归属、或改了 `contract/schema.ts`**，跑
   `node tests/tools/_schema-scope.mjs`（已进 `npm test`）。它把迁移流应用到**临时 SQLite**
   并驱动**真实 `syncThemeTables()`**，逐表检验声明与真实列一致。
   同时跑一次 `node tests/tools/_tenant-query-audit.mjs`：新语句会打印为 `NEW`，
   **必须补一条书面裁决**（为什么不带 `site_id` 是安全的）。
7c. **如果改了 `contract/events.ts` 或插件的 `subscribes[]`**，跑
   `node tests/suites/manifest-validation.test.mjs` 与 `node tests/suites/architecture.test.mjs`
   （后者守 `DOMAIN_EVENTS` 的完整性、唯一性、payload 版本兜底，以及
   "事件名不得混进 hook 列表"）。
7d. **如果动了 `scripts/cfpress.sh` 或 `scripts/cfpress.ps1`（加动作、改菜单编号、
   改套件表）**，跑 `node tests/suites/launcher-parity.test.mjs`。它要求两份文件
   **动作名、菜单编号、套件表、退出码**完全对齐，并且套件表要覆盖
   `package.json` 的 `test` 链（增删套件时两边都要改，它会告诉你漏了哪边）。
   ⚠️ 改 `cfpress.ps1` 后**必须确认 BOM 还在**（`head -c 3 scripts/cfpress.ps1 | xxd`
   应显示 `efbbbf`）——多数编辑器/写入工具会把它吃掉，而症状要到 Windows
   PowerShell 5.1 下才出现（中文变乱码），PS 7 与文本编辑器都看不出来。
7e. **如果加了/改了会碰共享本地 D1 的套件，跑
   `node tests/tools/_residue-guard.mjs [suite…]`**（先停 `wrangler dev`，它占着
   那个 sqlite 文件）。套件跑的是 `wrangler dev` 用的**同一个** sqlite（见下），
   所以**套件留下的任何一行都会出现在本地站点的后台**：主题屏的幽灵主题、站点屏的
   幽灵站点、内容列表里的野文章。
   **铁律：清理必须在首尾各做一次**（`media.test.mjs` 是范式）。只在开头清
   （"clear what a previous run left behind"）等于把残留**永久化**——跑完就多一堆，
   下一次跑才清掉；本仓库曾因此让后台长期挂着一堆测试主题。
   在 `default` 站激活一个 fixture 主题会 clear-then-insert 掉该站的
   `field_defs`/`post_types`/`taxonomies`/`theme_routes`/`theme_blocks`/
   `admin_menu_registry` 与派生的 `theme_installs.active`，**必须快照+还原**
   （用 `tests/fixtures/_capability-snapshot.mjs`），否则操作员的真实主题能力行
   被静默冲掉。**别删操作员自己的 settings 行**（`cfpress.features`、
   `theme.active`）——快照+还原，删掉就是丢数据。
   守卫的判据是**逐行内容比对**（不是按名字），所以"同名的旧残留先被清、新的又被留下"
   这种会漏掉的情况也能抓到；它只对**应用自己会物化的行**放行（捆绑主题/插件的能力行）。
   新增套件要加进它的 `SHARED_D1_SUITES` 列表。
   ⚠️ 改守卫本身也要反向验证：注掉一个套件的收尾清理，确认守卫**点名该套件**并打印
   泄漏的那一行。

8. **加了新的架构规则，必须同时做一次「反向验证」**：故意注入一次违规，
   确认测试真的会 FAIL，再撤回。**测不出失败的检查等于没有检查**——
   本仓库已经发生过**十八种**（见下方「守卫失效记录」与「同一意图的两种写法」）；
   十八条压缩成**七层**之后的判据见 `docs/ARCHITECTURE.md` §12「共同盲区」；
   工具（都在 `tests/tools/`，全部用 Worker 线程、内容哈希、`assertPristine`）：
   `_skeleton-inject.mjs`（schema / 事件契约 / 断言拼法 / 围栏块路径 / 正文命令路径 / 图标名 / 功能开关 / 块 attrs 契约 / 媒体控件 / 词典 / 捆绑主题 assets（规则 66），**42 个场景**）、
   `_launcher-inject.mjs`（启动器两侧对齐 / BOM / stderr 提示 / EOF 退出 / 孤儿套件，**16 个场景**）、
   `_i18n-field-inject.mjs`（字段分类，**6 个场景**）、
   `_plugin-pages-inject.mjs`（声明式后台页面，**10 个场景**）、
   `_fixture-inject.mjs` / `_fixture-inject-verify.mjs`（主题夹具不变量）。
   ⚠️ 这些工具**用 Worker 线程在进程内跑套件**——本沙箱 `spawnSync` 一律 `EBUSY`，
   用子进程会把"跑不起来"伪装成"没变红"。
   ⚠️ **这一步是纯人肉纪律，因此它本身就是本仓库最大的单点风险**：跳过它不会报警
   （守卫恰恰是那个不会报警的东西）。凡新增具名断言，**必须**在某个 `_*-inject.mjs`
   里补一个对应场景；靠"记得跑"是不成立的（详见 §12 最后一节）。

   ⚠️ **工具不会报警的三种情形本身也是假绿**（本轮新踩两种，都已修）：
   ① **`import()` 解析 ≠ 套件跑完**。套件末尾是 `process.exit(0)`，而模块体在
   `main()` 的第一个 `await` 返回前就结束了——于是 `.then(() => done(0))` 是个**提前
   触发**，谁先到谁赢，worker 被终止时只带走了已写出的输出。症状是"no summary"，
   被读成"守卫没变红"。只有**够慢**的套件会输掉这场竞速（esbuild 编译是常见原因），
   所以看起来像个别套件的毛病而不是 harness 缺陷。修法：**只留套件自己的
   `process.exit` 作为完成信号**（catch 里仍上报，正常 resolve 不上报）。
   ② **套件在注入下抛异常 = 没有摘要 = 读成"没变红"**。断言写完再读一个空数组
   （`rows[0].value`）就会这样：**崩溃把本该出现的红掩盖了**。修法两条：
   先断言集合形状再读元素（`rows.length` 之后才 `rows[0]`），以及**每一节用
   `section()` 包住**，让崩溃记为该节的一条失败而不是整轮无摘要。
   ③ **夹具清理只删精确 key**。注入把写入改成 `cfpress.features-typo` 后套件崩溃，
   残留行让**下一轮**在另一行报 UNIQUE 冲突——一次诚实的红被翻译成一次令人困惑的红。
   清理要按**前缀**（`LIKE 'cfpress.features%'`），且首尾各一次。

**当前仓库布局**（已重整完毕，新代码必须放对位置）：

```
content/                   ★ 被装载的内容（主题 / 插件 / 迁移流）
├── themes/                已发布主题（default fixture）
├── plugins/               已发布插件（notify）
└── migrations/            有序 D1 迁移流（wrangler.jsonc 的 migrations_dir 指向它）

src/
├── index.ts              前台路由      ← 唯一可以知道所有层的地方
├── api.ts                管理 API
├── shared/               叶子层：types crypto repo cache scheduler
├── rendering/            纯渲染：template-engine template-resolver blocks
├── platform/             auth permissions sites frontend seo revisions
│   ├── admin-menus.ts   ★ 后台菜单注册表（主题/插件/核心共用的唯一读写入口）
│   └── i18n/             多语言四层：core-pack translate resolve
│                         locale-registry packs index
└── extensions/
    ├── contract/         ★ 主题与插件共享的词汇与接口（依赖倒置的支点）
    │   ├── hooks.ts         HostHooks + DECLARABLE_HOOKS（宿主提供实现）
    │   ├── events.ts      ★ DOMAIN_EVENTS + EventEnvelope（事实，不是通道，规则 45）
    │   ├── schema.ts      ★ PLATFORM_SCHEMA：每张表的租户/语言归属（规则 43）
    │   ├── manifest.ts      词汇表：保留列 / 字段类型 / 后台屏幕 / 语言策略 / 各种正则
    │   ├── capabilities.ts  CAPABILITIES 白名单
    │   └── validation.ts    安装边界：validateManifest（失败必须抛错）
    ├── security.ts       只剩 safeZipPath / sha256（校验已移入 contract/）
    ├── theme/            runtime-declarative runtime-worker capabilities
    │                     templates tables table-facade packs
    └── plugin/           runtime packs menus channels

public/admin/             零构建后台 SPA（静态资源，wrangler assets 根）

tests/
├── run-all.mjs           全跑入口（薄层，注意本沙箱 spawnSync 会 EBUSY）
├── suites/               ★ 行为与架构套件（*.test.mjs）—— `npm test` 跑这些
├── tools/                ★ 注入器 / 诊断 / 迁移应用器（_*.mjs、_*.cjs）—— 手工跑
└── fixtures/             套件共享的 harness 代码（_extension-rules.mjs）

docs/                     见 docs/README.md 的索引
├── ARCHITECTURE.md       ★ 完整设计理由（§12 是假绿全表）
├── HANDOVER.md           ★ 接手必读
├── guides/               THEME-DEV / PLUGIN-DEV / I18N
├── design/               架构决策与其研究
└── history/              过往复查与已退役批次的记录

scripts/                  脚手架（生成器必须可被 import，见 tests/suites/scaffold.test.mjs）
├── _scaffold.mjs         共用：parseArgs / writeTree / CliError / isMain
├── make-theme.mjs        themeFiles() 纯函数 + main(argv, io)
├── make-plugin.mjs       pluginFiles() 纯函数 + main(argv, io)
├── make-table.mjs        tableDeclarations() 纯函数 + main(argv, io)
├── cfpress.sh            ★ 启动/部署入口（POSIX sh）：数字菜单 + 命令模式
└── cfpress.ps1           ★ 同上，Windows PowerShell 5.1 版
```

**`content/` 与 `src/` 的分界**：`src/` 是**代码**，`content/` 是**被装载的内容**。
主题、插件、迁移流都从这里读；仓库根只留代码与配置（`README` `AGENTS`
`LICENSE` `package.json` `tsconfig.json` `wrangler.jsonc`）。
`theme-previews/` 是**被 gitignore 的截图产物**，不属于结构的一部分。

**启动器两份文件是一个契约**：`cfpress.sh` 与 `cfpress.ps1` 承诺"同一套动作、同一套
菜单编号、同一套退出码"。`tests/suites/launcher-parity.test.mjs` **解析**两份文件的
`case`/`switch` 分支与套件表再比对——不是 grep 子串。改任一侧都要改另一侧，
否则套件变红。（为什么必须解析结构：见下方「十八种假绿」。）

launcher 侧已经踩过、并已写进测试的四条：
① **`.ps1` 必须有 UTF-8 BOM**——Windows PowerShell 5.1 把无 BOM 文件按 ANSI/GBK 读，
菜单里的中文在**解析期**就变乱码（PS 7 与文本编辑器都看不出来）。
② **`.ps1` 不得用 `$ErrorActionPreference = 'Stop'`**——PS 5.1 会把原生命令的每一行
stderr 包成 `NativeCommandError`，`Stop` 让它变**终止性**错误；本仓库每个套件都打
`ExperimentalWarning` 到 stderr，于是 launcher 跑第一个套件就死。
③ **菜单提示必须走 stderr**——`choice=$(menu_read ...)` 会把 stdout 一起捕进去，
提示写 stdout 时每个答案都变成 `"  > 9"`，**没有任何分支能匹配**（界面看着正常）。
④ **输入耗尽必须退出**——把 EOF 当"再问一次"会无限刷菜单（PS 版实测**一分钟 9.7 MB 日志**）。
`sh` 版读 stdin（管道可驱动），`ps1` 版在调 `Read-Host` **之前**用
`[Console]::IsInputRedirected -and -not [Console]::In.Peek()` 判断——事后无法区分
"没有控制台"和"用户按了回车"。

**套件表连"磁盘上多出来的套件"也要对齐（`launcher-parity.test.mjs` 第 5b 节）**：
批次 10 新增 `tests/suites/plugin-channels.test.mjs` 时，它**同时缺席四个注册表**
（`package.json` 的 `test` 链、`tests/run-all.mjs`、`cfpress.sh`、`cfpress.ps1`）——
而那时三条既有断言全绿，因为每一条都只检查"表里的东西在另一份表里"。
**两个方向都对齐，唯独没人问"磁盘上的东西在不在表里"。** 5b 节补上了这个方向：
扫 `tests/*.test.mjs` 的真实清单，逐个要求出现在 launcher 套件表里。
（这是**观测面层**的又一例：断言全成立，只是没人测过"全集"。）

**5b 节自己也被反向验证过（批次 F 追加 `tests/suites/user-delete.test.mjs` 时）**：
把注册键改名 → 守卫报 `no suite name is listed only by .sh` 与 `... only by .ps1` 两条；
把整条删掉 → 再加报 `every tests/**/*.test.mjs on disk is in the launcher table` 与
`every suite in npm test is in the launcher table` 三条。**每条都指名道姓、且不中断**——
所以"某套件漏注册"这四类事故各有独立的一条能抓到它。

⚠️ **改 `cfpress.sh` / `cfpress.ps1` 的脚本一律用二进制模式读写**：Python **文本模式**
（`open(p,'w')`）会把整文件转成 **CRLF**，而 `.gitattributes` 把 `*.sh` 钉成 LF——
`SUITES="…"\n` 的正则匹配不到 `"\r\n`，`launcher-parity` 会报 `parsed the shell suite table —
not found`，**看起来像守卫坏了**。改完务必
`python -c "print(open('scripts/cfpress.sh','rb').read().count(b'\r\n'))"` 确认是 `0`。

**文档里的测试路径也是可执行的（`architecture.test.mjs` 末节）**：AGENTS.md 告诉贡献者
"改了 X 就跑 Y"，所以一个指向已删除套件的路径不是排版瑕疵，是一条**照做就会失败**的指令，
且失败长得像"套件坏了"而不是"文档过期了"。批次 10 删掉两个主题套件后留下 **8 处**引用，
靠人肉找漏了 1 处（`THEME-DEV.md` §7 代码块里的 `theme-aurora.test.mjs`）——**新守卫当场抓住**。
判据只扫**围栏代码块内**的 `tests/*.mjs`：散文里合法地保留已退役的名字（解释"为什么删它"），
围栏块才是无歧义的"跑这个"。**这条守卫自己证明了非空转**——它第一次运行就红了。

**`contract/manifest.ts` 为什么单独存在**：`tests/suites/architecture.test.mjs` 需要**读**这些
词汇表（后台屏幕白名单、字段类型、保留列）。词汇表住在校验器内部时，唯一的检查办法
是**抄一份**，而抄本永远先过期。两个地方需要同一个答案时，共享定义，而不是共享结论。
同一理由把 `tests/fixtures/_extension-rules.mjs` 抽了出来，供 `architecture.test.mjs` 与
`scaffold.test.mjs` 共用。

**脚手架必须可被 import**：本机沙箱**无法 spawn 任何子进程**（node 二元文件被锁，
`spawnSync` 一律 `EBUSY`，与 `tests/run-all.mjs` 报 SKIP 同因）。所以三个生成器都写成
`main(argv, io)` + 纯内容构造函数 + `isMain()` 守卫，`tests/suites/scaffold.test.mjs` 直接调用。
只能以命令形式运行的生成器，等于**输出永远没被检查过的**生成器。

`platform/admin-menus.ts` 放在 `platform/` 而不是任一扩展里，理由是**两种扩展都要写它，
而它们互不 import（规则 3）**——放在任一侧都会逼出一次越界 import。
`platform/i18n/packs.ts` 的 `setPackProviders()` 与 `contract/hooks.ts` 的
`setHostHooks()` 是**同一个模式**：平台只认接口，实现在 boot 时由 `index.ts` 注入。
`platform/` 因此不需要认识 `extensions/`（分层规则 1）。

---

## 分层（§7.3）

| # | 规则 |
|---|---|
| 1 | `src/platform/` 不得 import `src/extensions/` |
| 2 | `src/rendering/` 不得 import `src/extensions/` |
| 3 | `src/extensions/theme/` 与 `src/extensions/plugin/` **互不 import** |
| 4 | `src/shared/` 不得 import 任何业务层 |
| 5 | 只有 `src/index.ts` 可以知道所有层 |

**理由**：主题和插件消费的是**同一套宿主接口**。这条守住了，"插件也能注册后台菜单"
才是免费的而不是特例；守不住，两者就会长成两套无法合并的东西。

**规则 3 的具体做法（别绕过它）**：主题渲染需要给插件机会改输出（`beforeRender`、
`html` filter、短代码），但**主题绝对不能 `import` `plugin/`**。正确姿势是：

```ts
// extensions/theme/… 里 —— 只认接口，不认识 plugin/
import { hostHooks } from "../contract/hooks";
const hooks = o.hooks ?? hostHooks();
await hooks.applyFilters("html", ctx, out);
```

真正的实现由 `index.ts` 在 boot 时用 `setHostHooks({...})` 注入一次。
没有注入时 `hostHooks()` 返回 `NULL_HOOKS`（空实现、原样返回）——
**行为与"本站没装插件"完全一致，所以调用点不需要 null 判断**。

> 违反这条的典型症状：功能全对、测试全绿，但插件变成了每个主题的硬依赖，
> 删掉插件主题就编译不过。`tests/suites/architecture.test.mjs` 现在会拦住它。

## 数据访问（§10 规则 4、9）

| # | 规则 |
|---|---|
| 6 | 数据访问函数**必须显式接收** `siteId` 与 `locale`，**不得有默认值** |
| 7 | 主题/插件**不得直接写 SQL**（`env.DB.prepare("SELECT…")` 一律禁止），只能用宿主 facade |
| 8 | 表名由平台生成（`theme_{owner}_{table}`），**不得硬编码** |
| 9 | 只读本主题/本插件声明过的表 |

规则 6 现状：**已清零**（26 处字符串字面量 + 6 处 `DEFAULT_SITE_ID` 常量形式全部移除）。
棘轮常量 `ALLOW_KNOWN_DEFAULTS` 已删除，现在是**零容忍硬规则**。

> ⚠️ 注意 **`siteId = DEFAULT_SITE_ID` 也算违规**。用常量拼写不会让它变成好设计，
> 只会让正则更难发现它——这正是它藏了很久的原因。

**理由**：`siteId = "default"` 是多站点 bug 的藏身处——调用点能编译、能运行、
静默读错站点的数据。上一轮修的 `activeTheme()` 缺陷就是这个模式的产物。

**唯一合法的兜底位置**：把「请求 → 站点」的解析收敛到 `requestSiteId(url)` 一处。
那里必须给出兜底，因为这是唯一真正需要做选择的地方；它写成**表达式**而非参数默认值。

## 平台功能开关（`src/shared/features.ts`）

有些能力**不是每个部署都该开**——`worker_loaders` 与 `services` 绑定只在付费计划上存在，
KV 镜像在免费计划上纯属写入放大器。这类能力一律走**开关**，不要靠"部署时没配绑定"来关。

| 规则 | 说明 |
|---|---|
| 52 | 每个开关在 `FEATURE_SWITCHES` 里**定义一次**：`key` + `varName` + `defaultOn` + `label` |
| 53 | 开关的**唯一解析入口**是 `featureEnabled(env, siteId, key)`；调用点不得自己读 `env` 或 `settings` |
| 54 | 每个开关**必须显式写出 `defaultOn`**，且新增开关默认 `false` |
| 55 | 开关词汇表住在**叶子层**（`shared/`），不得搬回 `extensions/contract/` |

**优先级（高→低）**：站点 `settings` 行 `cfpress.features` → `env.<varName>`（`wrangler.jsonc` 的 `vars`）
 → `defaultOn`。

**为什么词汇表在 `shared/` 而不是 `contract/`**：`shared/cache.ts` 是消费者，而 `shared/` 是**叶子**
（§7.3 规则 5），它不得 import `extensions/`。第一版把它放在 `contract/manifest.ts`，
`architecture.test.mjs` 直接报 `src/shared/features.ts -> ../extensions/contract/manifest`。
当时的三条出路是：把消费者挪出 `shared/`（不可能，缓存版本真的属于那里）、**放宽分层规则**
（那会是这条规则的第一道裂缝），或者把词汇表下移——选了第三条。

**为什么"每个开关都必须显式声明默认值"是硬规则**：`defaultOn` 漏写时 `undefined` 是假值，
行为上"看起来是对的"，于是没人会发现这个开关**在文档里被描述成可配置、实际却永远关着**。
`architecture.test.mjs` 因此断言 `typeof s.defaultOn === "boolean"`，并单独断言每个开关都是 `false`。

**为什么调用点不能自己读 `env`**：`wrangler.jsonc` 的 `vars`、站点 `settings` 行、默认值三层里，
任何一层被跳过都会得到一个"配了但没生效"的开关——这正是本仓库已修过五次的
「声明先于运行时」缺陷族。所以 `_tenant-query-audit.mjs` 之外再加一条：
`tests/suites/architecture.test.mjs` 断言 `FEATURE_SWITCHES` 只在**一个文件**里定义。

**当前三个开关**（都在 `wrangler.jsonc` 的 `vars` 里显式写 `"false"`）：

| key | var | 关掉时发生什么 |
|---|---|---|
| `cache_mirror_kv` | `CFPRESS_CACHE_MIRROR_KV` | 不往 KV 镜像内容缓存版本号；D1 仍是权威 |
| `theme_runtime_worker` | `CFPRESS_THEME_RUNTIME_WORKER` | 主题 Worker 沙箱不启动，全部走声明式渲染器 |
| `ui_locale_follow_site` | `CFPRESS_UI_LOCALE_FOLLOW_SITE` | 后台界面语言菜单照旧列出平台知道的所有语言（§2.4 的解耦）；**打开**才收窄成"本站启用的语言" |

> ⚠️ **`theme_runtime_worker` 的开关必须检查在绑定之前**。反过来的话，一个付费账号
> （有 `worker_loaders`）会让"绑定在"**静默压过**运营者的意图，这个开关就白加了。
> 两个原因要保持在代码里可区分——`tests/suites/theme-worker.test.mjs` §10 为此分开断言。

> ⚠️ **开关的"关"方向必须有断言**。`theme-worker.test.mjs` §1–9 全部在开关**开**的前提下跑
> （那是它们的主体），所以"出厂默认关"这件事**只有 §10 在守**。删掉 §10，套件照样全绿，
> 而默认关这件事就再也没人验证了——这是「守卫覆盖的范围比它声称的小」这一族
> （`docs/ARCHITECTURE.md` §12）的形状：§1–9 全在开关**开**的前提下跑，
> 唯一守"出厂默认关"的是 §10。

> ⚠️ **`varName` 三处必须同时存在**：`FEATURE_SWITCHES` 里声明、`src/shared/types.ts` 的
> `Env` 上可读、`wrangler.jsonc` 的 `vars` 里有键。前两条由 `architecture.test.mjs` 断言；
> 第三条同样由它断言（**双向**：配置里有、没有开关读它的键也算红，那是改名后的残留）。
> 这不是形式主义：批次 11 把 `vars` 块**只加进了 `wrangler.jsonc`**，而所有命令跑的是
> `wrangler.local.jsonc`——于是线上根本没有 `vars`。**漏一个 var 和写 `"false"` 的解析结果
> 都是"关"**，所以这个差异在两个批次里完全隐形，只有"设一个 var → deploy → 发现开关没动"
> 才会暴露。

> ⚠️ **部署配置是生成的，别手改**。链条只有两条边：
> `wrangler.jsonc`（提交，占位符）+ `wrangler.ids.json`（gitignore，真 id，**唯一手写**）
> → `node scripts/make-local-config.mjs` → `wrangler.local.jsonc`（生成物，所有命令带 `-c` 跑的）。
> 三处守卫：`architecture.test.mjs`（`varName` ↔ 模板 `vars` 键，双向）、
> `tests/tools/_config-parity.mjs`（**本地文件 = 重新生成的字节**；进 `npm run gate`；
> 本地文件/ids 缺失时明确报 **n/a 而不是 pass**，因为"文件不在所以跳过"正是本仓库最忌讳的假绿）、
> `launcher-parity` §8b（启动器每条 wrangler 命令都带 `-c "$CONFIG"`，且读它之前先重新生成）。
> **永远不要把真 id 写进 `wrangler.jsonc`**——它被 git 跟踪，下一次 commit 就把在用的数据库
> id 发到公开仓库。启动器曾经就是这么教的（不带 `-c` 部署占位符那份 + 叫你去编辑模板），已修。

## 多语言与 URL（规则 56–59）

多语言不只是"存了翻译"——URL、回退、SEO 输出每一层都有一种把错误**静默**藏起来的写法。
规则 56–59 把这些写法变成红灯。

| 规则 | 说明 |
|---|---|
| 56 | locale 前缀解析**只许** `platform/i18n/resolve.ts`（`resolveLocale`/`isKnownLocale`）。任何地方不得自写"取首段当语言"的正则或 split |
| 57 | 内容语言回退**只许** `resolveContentLocale` 一处；`src/platform/i18n/` 之外禁止 `\|\| "en"` / `?? "zh-CN"` 式的硬编码 locale 兜底 |
| 58 | 凡 SQL 同时触及 `posts p JOIN post_translations` 并按 slug 过滤，**必须** `COALESCE(t.slug, p.slug)`，不得只匹配 `p.slug` |
| 59 | SEO 端点（sitemap/robots/feed）**必须**接收并使用 `siteId`；多语言输出（hreflang/feed/切换器）只能列**该站点声明**的语言 |

**为什么 58 是硬规则**：migration 0016 起 slug 按语言——`posts.slug` 是默认语言值兼全行回退，
`post_translations.slug` 是本语言自己的 URL 段（NULL = 跟随主表）。凡是漏掉 COALESCE 的查询，
**每个给自己起了名字的语言全部 404**，而默认语言一切正常——这是最典型的"我只测了默认语言"缺陷。
写作路径的判别：`p.slug` 只在「L 是站点默认语言」或「该行没有其他语言的翻译行」时才允许被改写
（两种存储形态都合法：兄弟行共享 `lang_group`，或单行多翻译）。

**为什么 56/57 要封"另一种写法"**：回退阶梯写在两处 = 两处各错一半；
`|| "en"` 散落在调用点 = zh-CN 站**静默读写英文行**，页面照常 200，
只有内容语言不对——观测面上和"没做翻译"一模一样。

**为什么 59 存在**：`/sitemap.xml` 曾在站点解析之前匹配，第二个站点拿到的是默认站的站点地图；
feed/hreflang 把别的站点的语言列出去是同样的病。守卫在
`tests/suites/architecture.test.mjs`（四道，具名），注入验证在 `tests/tools/_locale-url-inject.mjs`。

**切换器在列表页和文章页不是同一件事（规则 58 的推论）**：列表页一个路径对多语言，
所以「换掉 locale 段」是对的；文章页不是——slug 按语言，`/en/blog/<zh-slug>` 是 404。
`langNav()`（`src/platform/frontend.ts`）因此接收 `post.alternates`：有该语言版本就用**它自己的 URL**，
没有才退回换段（退回后的 404 是实话，因为那篇确实没有那个语言的版本）。
⚠️ `buildScope` 必须在 `post.alternates` **还是相对路径时**读取它——
hreflang 那一段会把该属性整体替换成带 origin 的副本，之后读就会把绝对 URL 塞进主题导航。
具名断言「the switcher on an article points at each language's own slug」在
`tests/suites/locale-url.test.mjs`，注入场景在 `tests/tools/_skeleton-inject.mjs`。

**一键门禁**：`npm run gate` = 架构测试 + 清单校验 + schema 作用域 + locale-url 注入（全为可移植的
node 直调）。它**不含** `tsc --noEmit`——因为 lib.dom 与 workers-types 的既有上游冲突会淹没退出码——
所以推送前的完整纪律是 **`tsc --noEmit`（src/ 0 错误）+ `npm run gate`**；红灯的提交不许推。

## 媒体隔离（规则 60）

`media_files` 有两个维度：**租户**（`site_id`，迁移 0009）与**所有者**（`uploaded_by`，迁移 0018）。
一个媒体文件有两扇门，**两扇都必须各自把关**——它们曾经各管一半，而只有一半被测过：

| 规则 | 说明 |
|---|---|
| 60a | `/media/<key>` 的读取分支**必须**在站点解析**之后**匹配。对象键里的 `uploads/{siteId}/` 段就是租户，站点没解析出来就没有东西可以拿它去比对 |
| 60b | 读取路径的裁决**只许**来自 `platform/media-policy.ts`（`mediaReadDecision`）。`index.ts` 与 `api.ts` 两扇门必须走同一份策略，否则"列表里看得见的"和"真能取到的"会分叉 |
| 60c | 拒绝**一律 404**，绝不 403——403 等于确认"这个 key 存在，只是不属于你" |
| 60d | 删除**先删 R2 对象、再删行**。行是唯一知道对象键的东西，先删行会把字节永久留在 R2 且无人能列出 |
| 60e | 上传是**唯一铸造租户的写入**，必须确认站点真实存在（`?site=` 只做形状校验，`nosuchsite` 能通过正则） |

**为什么 60a 是硬规则**：这条分支原本在 `resolveSite` **之前**、**鉴权之前**直接 `env.MEDIA.get(key)`。
于是 A 站铸的 key 在 B 站的域名下 200，未登录访客也 200——而 `media_files` 早就按站点分好了，
后台列表也早就按站点收窄了。**恰恰因为另一扇门是对的，这个洞活过了所有既有断言。**
行为测试看不见它（把分支挪回上面，只要所有站点恰好都是默认站就全绿），
所以守卫是**结构的**：`architecture.test.mjs` 解析 `index.ts`，要求 `startsWith("/media/")`
出现在 `await resolveSite(` 之后。

**为什么 60b 要封"另一份策略"**：媒体策略是站点级设置（`settings` 行 `cfpress.media`：
`isolation` = `owner|site`、`require_session`）。**解析不了 = 关（安全侧）**：owner 隔离 + 要求会话。
⚠️ `require_session` 默认**开**，后果是**未登录访客（也就是前台所有读者）取不到任何媒体**——
主题里 `<img src="/media/...">` 会 404。这是运营者的决定，不是缺陷；前台一旦挂图，
**第一件事是看这个开关**（Media 屏，或那一行 settings）。它的存在就是为了让这个选择可逆。

**为什么 60e 只在写入侧查站点**：读/改/删都靠 `site_id=?` 收窄 SQL，不存在的站点天然查不到行；
只有上传会**铸造**一个租户（R2 键前缀 + 行），拼错的站点名会造出一批谁也列不出来的文件。

**三条闸门都是 404，所以断言必须盯"哪一条闸门"**：`mediaReadDecision` 返回**原因**
（`site`/`session`/`owner`/`missing`），套件把三条闸门**逐条单独打开**再断言——
只在三条全关时断言"404"的写法，任何一条还在就能通过，删掉一条根本不会变红。
`tests/suites/media.test.mjs`（69 条）按这个形状写，`tests/tools/_media-inject.mjs`（7 场景）
逐条注入确认。**这个工具不在 `npm run gate` 里**（要跑 9 遍带 esbuild 的套件），手工跑。

**顺带修掉的一个真缺陷（同一条轨道）**：`platform/sites.ts` 的站点列表 memo 注释写着"per-request"，
但它以 `env` 为键、且**从不清理**——而 `env` 是 isolate，不是请求。于是**新建的站点在前台解析不到**
（host 与 path 前缀都落到默认站），直到 isolate 恰好回收。修法是在入口每个请求开头
`resetSiteListMemo(env)`。守卫：`media.test.mjs` §1 先发一次前台请求、再建站点、再请求它。

## 块 attrs 契约（规则 61）

块（`core/paragraph` … `core/columns`，共 12 种）的**属性集合只有一份声明**：
`src/rendering/blocks.ts` 的 `CORE_BLOCKS`。三条硬规则：

| 规则 | 说明 |
|---|---|
| 61a | **渲染器只能读声明过的属性**。`platform/frontend.ts` 的 `renderBlocks` 每个 `case` 里 `a.<key>` 的读取集合必须**恰好等于**该块声明的 `attrs[].key` 集合。守卫**解析** switch 的每个 case 体（不是 grep 字符串） |
| 61b | **每种属性类型都必须有控件分支**。`public/admin/js/block-fields.js` 的 `RENDERED_ATTR_TYPES` 必须等于 `BLOCK_ATTR_TYPES`，且 switch 里每种类型都要有 `case`——一个没有分支的类型会静默退化成文本框 |
| 61c | **`media-list` 属性必须声明 `itemKeys`**。条目形状属于属性本身；控件无法凭空造出 `url`/`alt`，缺了它只会渲染一个没有输入框的空字段 |

**为什么 61 存在**：编辑器曾经**给所有块写 `attrs.text`**，而渲染器按类型读不同的属性
（`core/image`→`url`+`alt`、`gallery`→`items`、`html`→`html`、`group`/`columns`→嵌套 `content`）。
两边从不需要达成一致，于是**12 种块里有 6 种从后台插入后前台渲染为空**——
**HTTP 200、零异常、零 5xx**，是「声明先于运行时」缺陷族的第八例。
所有既有守卫都看不见它：清单校验器查的是声明，架构测试查的是结构，
`admin-spa.test.mjs` 从不打开编辑器屏幕。

**修法不是"把 `attrs.text` 换成六个 if"**，而是**把 attrs 契约提成一份声明**，
编辑器与渲染器同时从它派生：`GET /api/v1/blocks` 下发属性清单（含翻译后的标签与 `itemKeys`），
编辑器据此逐属性出控件。**新增块或改属性时改一处**——`CORE_BLOCKS`——
漏改任一侧是架构红灯，而不是一个空 `<div>`。

**观测面在 `tests/suites/editor-blocks.test.mjs`**（40 条）：它把整条链**跑一遍**——
契约 → 控件 → 控件写入的属性键 → **真实渲染器**产出的 markup——并断言每个声明过的属性
都能在输出里找到自己的标记。该套件 §8 是**刻意的反向对照**：按旧编辑器的形状
（所有块只写 `text`）构造一个图片块，断言往返断言**确实会失败**。
**验证块链路只做静态检查是不够的**：`editor-blocks` 与架构守卫的关系，
正是「行为断言」与「结构断言」各自只能证自己那一层。

⚠️ 本轮的教训：`check(name, condition, detail)` 的 `condition` 传**字面量**（字符串/数组/对象）
恒为真。`architecture.test.mjs` 的元守卫现在同时禁两种拼法——
"集合当条件"与"字面量当条件"——但**元守卫只看本文件**，
其它套件里同样的拼法只能靠注入工具抓。

## 媒体控件与媒体 URL（规则 62）

"选一个媒体文件"这个动作在后台有**三个**消费点，它们必须是**同一个控件**：

| 消费点 | 声明来源 |
|---|---|
| 块的 `media` / `media-list` 属性 | `rendering/blocks.ts` 的 `CORE_BLOCKS`（规则 61） |
| 内容自定义字段的 `media` / `media-multiple` | `ALLOWED_FIELD_TYPES`（13 种，**一直就有这两种**） |
| 主题/插件设置的 `media` / `media-multiple` | 同一份 `ALLOWED_FIELD_TYPES` |

| 规则 | 说明 |
|---|---|
| 62a | 控件的包装（`data-media-field`）与按钮（`data-media-pick`）**只许** `public/admin/js/media-picker.js` 产出。任何屏幕自己拼一份 = 架构红灯 |
| 62b | `/media/<key>` 的 URL **只许** `mediaUrl()` 一处构造（`/media/` + `encodeURIComponent`）。手拼的 URL 遇到含 `/` 的文件名就会被读取路径解成另一个 key（规则 60 还会按站点判它 404） |
| 62c | 控件的**唯一职责**是"把选中的 URL 写进那个发起请求的 input，并派发 `input`/`change`"。这样三个消费点都**不需要新接线**：块属性有监听写 `attrs[key]`、设置表单 `change` 即存、自定义字段在保存时读 `[data-meta]` |

**为什么 62 存在**：`media` / `media-multiple` **从一开始就在 `ALLOWED_FIELD_TYPES` 里**，
但**编辑器自定义字段没有任何分支** → 静默掉进默认文本框（与规则 61 同族的"声明了但没人读"），
而主题设置屏只有一个 placeholder 写着 "URL in the media library" 的裸文本框——
作者得先知道媒体库存在、再自己找到文件、再把 URL 抄进去。
**"全平台统一的控件"因此不是重构，是补一个从来没被实现过的东西。**

⚠️ 媒体屏也曾自己拼三处 `/media/` URL；现在它走 `mediaUrl()`，62b 才有意义。

⚠️ **这个控件有真浏览器验收**：`tests/tools/_media-picker-browser.cjs`（25 条，需要
`wrangler dev --port 47913`）。它抓到的第一个缺陷就是 Node 侧永远看不见的：
**选完文件后没有预览**（编辑器为了不丢焦点不重渲染，预览只在渲染时画一次）。
⚠️ 写这类脚本时**不要用 `context.request` 调后台 API**——会话 cookie 是 `Secure`，
Playwright 的请求上下文在 http 上不发它，每个调用都会 401（而页面本身是登录的）；
也不要用 `context.request` 登录，那会把浏览器一起登录掉、登录屏永不出现。
**走页面自己的 `fetch`**（`page.evaluate`）。

## 后台文案与词典（规则 63）

`t(key, fallback)` 有英文兜底 ⇒ **缺键是静默的**：界面其余部分是用户的语言，只有这一条是英文。
这是「声明先于运行时」的**镜像**——代码要了一个没人声明的键，而唯一症状是一个没被翻译的标签。

| 规则 | 说明 |
|---|---|
| 63a | SPA 里 `t("…")` 引用的每个**字面量**键，必须在**每个**核心语言包里存在 |
| 63b | 两个核心语言包必须声明**同一组键**——缺一个字符串的语言，是没人能信的语言 |
| 63c | `core.editor.*` 命名空间**每个键都要有调用点**（只给一个屏幕用的字符串，没人显示就是死代码） |

**两条数据纪律**（本轮实测）：

- **状态值落库仍是英文小写**（`draft`/`published`/`private`/`scheduled`），**只翻译显示层**。
  翻译存进去会让每个查询都依赖界面语言。
- ⚠️ **`<option>` 不写显式 `value` 时，浏览器拿 option 的文本当值**。
  于是"把标签翻译成中文"会**把 `草稿` 写进 `posts.status`**——一个翻译动作变成一次数据损坏。
  编辑器里状态选项因此显式写了 `value="${s}"`；`_i18n-browser.cjs` §7 断言这一点。

守卫在 `architecture.test.mjs`（**gate 覆盖**：解析两个语言包 + 扫描 SPA 的 `t("…")` 调用点，
双向都查 + 三条非空断言），注入场景在 `_skeleton-inject.mjs`（3 个）。
真浏览器验收在 `tests/tools/_i18n-browser.cjs` §7：切到 zh-CN 打开编辑器，断言**标签是中文**、
**没有英文残留**、**option 值仍是标识符**，再切回英文。
**Node 守卫只能证"键存在"，证不了"某个屏幕真的读了它"**——两者缺一不可。

## 界面语言偏好：一个写者、两个读者（规则 67）

| 规则 | 说明 |
|---|---|
| 67a | 界面语言偏好的**唯一写者**是 `public/admin/js/i18n.js` 的 `setUiLocale()`；**任何屏幕都不得自己 POST `i18n/ui-locale`** |
| 67b | 字典重载（`await loadMessages()`）**写在 `setUiLocale()` 内部**，调用方不得依赖自己记得重载 |
| 67c | 被拒绝的切换**必须抛出**（服务端对没有语言包的 locale 回 400 + 可用列表），两个调用点各自处理：`shell.js` 弹 toast、Languages 屏弹对话框 |

**为什么**：同一个服务端事实有**两个前端读者、两条刷新路径**——

- 后台顶部语言下拉的勾选读 `currentLocale()`，那是 `i18n.js` 的**模块级状态**，只由
  `setMessages()`（即 `loadMessages()`）设置；
- Languages 屏每次挂载都重新读 `GET i18n/ui-locale`。

Languages 屏的 Save 原本自己 POST 再 `render()`，**不重载字典**，于是保存后**面板显示新语言、
顶部下拉还勾着旧语言**，直到整页刷新。两个端点都由服务端同一个 `resolveUiLocale` 解析、
返回同一个值，所以**这个分歧在服务端完全看不见**：curl 两次都拿到正确答案，
`admin-spa.test.mjs` 的"每个屏幕都能渲染"也照样全绿。它是**纯客户端分歧**。

守卫在 `tests/suites/admin-spa.test.mjs`（单写者扫描 + 写者必须重载字典 + 运行时"保存后
顶部勾选跟着走、不需要刷新" + "被拒绝时不改语言"）；注入场景在 `_skeleton-inject.mjs`（3 个）；
真浏览器验收在 `tests/tools/_i18n-browser.cjs` §8。

> ⚠️ 反向验证时**必须注入原始形状**：第一次注入写成了「自己 POST + `afterLanguageChange()`」，
> 而 `afterLanguageChange()` 默认就会重载字典——于是注入"通过"了。真实的旧代码是
> 「自己 POST + `toast()` + `render()`」，一行字典重载都没有。**注入的必须是历史真实形状，
> 不是"看起来差不多"的形状**，否则反向验证自己变成第九种假绿。

## 编辑器的定时器与身份（规则 64）

编辑器为**已存在的条目**起一个 10 秒自动保存定时器。它原本只在两条退出路径里被清掉
（`Back` 与保存成功），于是**从侧栏离开编辑器**（走 `shell.go()`）会把定时器留在后台——
用户在看别的屏幕时，它每 10 秒照旧 POST 一次自动保存。**没有任何东西失败，写入只是看不见。**

| 规则 | 说明 |
|---|---|
| 64a | 清理路径**只有一处**：`state.js` 的 `stopAutosave()`；任何模块**不得**自己 `clearInterval(state.autosaveTimer)` |
| 64b | 导航（`go()` / `switchSite()`）必须调用它 |
| 64c | 编辑一个**已存在**的条目时，`#locale` 是**只读**的（`disabled`）。切语言 = 切版本（用上方的语言版本条），不是改写这一行的语言 |
| 64d | 保存与自动保存**从 `state.editing.locale` 读语言**，不从 DOM 读——身份是事实，不是标记 |

⚠️ **`publish_at` 必须往返**：编辑器曾把已排期的 `publish_at` 丢掉（渲染成空），
于是"打开一篇已排期的文章再保存"= **静默取消排期**。用 `table-form.js` 的
`toLocalInput` / `fromLocalInput`（一处定义），不要就地写 `new Date(...)`。

守卫：`architecture.test.mjs`（结构：只有 `state.js` 清定时器 + 导航确实调了它）
**与** `admin-spa.test.mjs`（行为：编辑已存在条目会起定时器、导航离开会停它、
排期往返、`#locale` 不可编辑）。**结构守卫只能证调用点存在，证不了导航真的跑到了它**——
两者缺一不可。

## 主题表的 i18n 侧表（规则 65）

`theme_table_defs.i18n_table` 是**门面唯一信任的字段**——它非空，门面就去写/join 那张侧表。

| 规则 | 说明 |
|---|---|
| 65a | `i18n_table` 的**粘性是有意的**（`COALESCE` 保留旧名）：禁用一种语言时应当**隐藏**翻译，而不是在重新启用时用主表值**重新播种**（那会覆盖已保留的翻译） |
| 65b | 但"粘性"意味着这个字段**可以比它的表活得久**（夹具 drop 了生成的表 / 有人手工清理）→ 首次写入报 `no such table: …_i18n`，**一个 schema 形状的错误，成因却是一条陈旧的行** |
| 65c | 所以**同步要修复它自己写下的映射**：写入注册行后回读 `i18n_table`，若非空就 `CREATE TABLE IF NOT EXISTS` 一次（幂等）。**记录说什么，就让它成真** |

⚠️ **`scoped(path)` 的参数必须是路径，不能已经带查询串**。`scoped("media&page=1")` 会产出
`media&page=1?site=default` —— **不匹配任何路由**，答案 404；而在媒体选择器里那个 404 被
吞成空列表，于是搜索框看起来像"没有结果"。两个调用点都犯过。
现在 `scoped()` **直接抛错**（三行检查，症状从外面完全认不出来，这正是检查值得存在的时候）。
正确写法：`scoped(\`media?${query}\`)`。

## 捆绑主题经 Worker assets 分发（规则 66）

捆绑主题（`default`，定义在 `src/shared/bundled.ts` 的 `BUNDLED_THEMES`）
曾经**没有分发渠道**：注册行写进了 `theme_installs`，模板文件却只在 R2——而 R2 清空后
是空的。于是**每次清库/重部署，首页都是 `__fallback__` 壳**，要手工逐个上传 13 个对象
才能恢复。那是补丁。设计是：

| 规则 | 说明 |
|---|---|
| 66a | 捆绑主题运行时经 **ASSETS 绑定**读 `public/themes/**`（`bundledThemeFile`）；R2 只承载用户上传的主题。`content/themes/**` 是源，`public/themes/**` 是同步副本，且**恰好等于 `BUNDLED_THEMES` 那几个主题的文件，逐字节一致**（`scripts/sync-bundled-themes.mjs` 生成；`predeploy` 与两个启动器先跑它再 deploy/dev） |
| 66b | 每个捆绑名必须对应真实的 `content/themes/<name>/theme.json`；`content/themes/` 下的目录要么捆绑、要么**不发布**（`fixture` 是测试夹具）。同步脚本的复制集**必须从 `BUNDLED_THEMES` 推导**，不许遍历整个 `content/themes/` |
| 66e | ⚠️ **`public/` 下的每个文件都是公网可读的**（`wrangler deploy` 原样上传）。所以"发布集 = `BUNDLED_THEMES`"是**安全边界**不是便利：同步脚本曾经镜像整个 `content/themes/`，于是**测试夹具主题被发布到了线上**（`/themes/fixture/theme.json` 实测 200），而当时的架构测试断言的是"两棵树逐文件一致"——**它把泄漏钉成了正确**。豁免必须是**排除**，不是**纳入** |
| 66c | 主题内容加载的**每个消费点**（`runtime-declarative.ts` 的模板读取 / `activeTheme` 探测 / 语言包读取，以及 `packs.ts`）都必须走 assets 兜底。删掉任意一处兜底 = 对应路径清库后 `__fallback__` 回归（守卫逐点钉住，不是全文搜标识符——全文搜在删一处时依旧绿，注入验证抓过这个） |
| 66d | 捆绑名**不可被上传覆盖、不可被卸载**（`src/api.ts` 的 "ships with the product" 守卫读 `BUNDLED_THEMES`——不许手抄名单） |

改 `content/themes/` 下任何文件后**必须跑 `node scripts/sync-bundled-themes.mjs`**
（或直接 `npm run deploy`——`predeploy` 会跑）。守卫在 `architecture.test.mjs`（规则 66 节，
**18 条断言**含非空：发布集 = `BUNDLED_THEMES`、非捆绑目录绝不进 `public/`、同步脚本的复制集
从 `BUNDLED_THEMES` 推导）；注入场景在 `_skeleton-inject.mjs`（删兜底 / 树漂移 /
**夹具泄漏进 `public/themes`** / **同步退回整目录镜像**）；
行为验证在 `theme-integration.test.mjs` §10（**空 R2 仍渲染 `home`**）。

## 注册行不等于安装（规则 69）

规则 66 给了捆绑主题**分发渠道**，`seedBundledExtensions` 写的那行 `theme_installs`
让它**能渲染**——`activeTheme()` 会 `ORDER BY active DESC, installed_at ASC` 回退并探测
可加载的 `index.html`。但**能渲染 ≠ 主题拥有任何东西**：激活是**用户动作**，全新安装里
没有这个动作。于是新装的站点前台一切正常（中文页、切换器、feed、sitemap 全对），
而主题在库里**一行都没有**。

线上实测（修之前）：`GET theme/fields` 返回 `{"items":[]}`。没有声明字段，编辑器就一个
自定义字段都不显示；`savePost` 的 `fieldExists` 闸门于是把**每个 `meta` 值原样丢掉**——
HTTP 200、零报错、什么都没写。演示内容的 `category`/`tags` 读回来是 `{}`，
中英文首页都写「Uncategorised / 未分类」。**表象像内容问题，根因是主题从来没被安装过。**

| 规则 | 说明 |
|---|---|
| 69a | 启动链必须**先注册后安装**：`index.ts` 的 boot 块里 `await seedBundledExtensions(env)` 之后必须跟 `await ensureThemeCapabilities(env)`。顺序是断言不是细节——`ensureThemeCapabilities` 经 `theme_installs` 解析活动主题，而那行正是播种调用创建的；反过来它会在自己本该修复的那一次启动上读到空注册表 |
| 69b | 安装逻辑放在 `extensions/theme/capabilities.ts` 的 `ensureThemeCapabilities`，**不能**放进 seeder：规则 4 禁止 `plugin/` import `theme/`。`index.ts` 是唯一允许同时知道两层的模块，链就接在那里 |
| 69c | 判据必须是**测量**（数行），不是版本戳。戳记「主题 X 版本 V 在此装过」，就必须被**任何删除能力行的人**作废——而测试套件共享同一个本地 D1，**正是**故意删这些行的。戳记会拒绝修复它唯一存在的理由，即缺陷本身。数行只要一次查询，且能自愈 |
| 69d | 判据必须**镜像清理面**：`clearThemeCapabilities` 从五张表 DELETE（`post_types`/`taxonomies`/`field_defs`/`theme_routes`/`theme_blocks`）并经注册表 API 清菜单，所以「已拥有」的计数必须问全这六处。镜像漏一处 = 同一个主题上「已装」和「未装」给出两个答案 |

**已接受、写在注释里而非藏起来的**：只声明 `settings[]` / `tables[]` 的主题在计数表里
什么都不占，于是**每次启动都会重跑**。`applyThemeCapabilities` 的每条语句都是 upsert 或
`DELETE ... WHERE declared_by_theme=?`，所以重复是幂等的。

守卫在 `architecture.test.mjs`（规则 69 节，**5 条断言**：启动链两处调用 + 顺序 +
函数真实存在 + 判据数行 + 判据镜像清理面）；注入场景在 `_skeleton-inject.mjs`
（抽掉 boot 链第二句 / 把数行换成戳记）。
**行为验证**：删掉本地库 `field_defs`（套件本来就留下这个状态），重启 dev server 让
isolate 全新启动，**不发任何激活请求**，字段自己回来——这是修复成立与否的唯一判据，
因为结构断言只能看到调用点存在，看不到它真的跑了。

## post_meta 的语言读阶梯只许一处定义（规则 70）

批次 23 给 `post_meta` 加了 locale 维度（迁移 0019，`PRIMARY KEY(post_id, meta_key, locale)`；
`docs/design/MEDIA-EDITOR-PLAN.md` 的 B5）。从此"这个语言读这篇内容的哪个字段值"是一个
**四级阶梯**：本语言行（0）→ 站点默认语言行（1）→ `''` 遗留行（2，0019 之前的共享行，
**故意不回填**，让未重新保存的数据照原样渲染）→ 任意行（3）。

| 规则 | 说明 |
|---|---|
| 70a | 阶梯**只许一处定义**：`platform/post-meta.ts` 的 `resolveMetaByPost` / `metaLocaleRank`。这与 `resolveContentLocale`（规则 57 的铸点）同一纪律——两份阶梯的退化形状是"卡片写着 设计、文章写着 Design"，而且是逐请求、逐字段的 |
| 70b | **每个读 `post_meta` 的模块**（列表 `attachMeta`、单页 `findContent`、主题 Worker 的 `postMetaMap`、admin 的语言行展开）必须经 `resolveMetaByPost` 解析。裸 SELECT 允许（阶梯需要行），**重实现解析不允许** |
| 70c | **写入必须带语言**：`savePost` 的 meta upsert 绑定的是本次保存的 `locale`。写入丢语言 = 所有语言的值都落在 `''` 遗留层，最后写的那个语言赢——SQLite upsert 静默覆盖，HTTP 200 |
| 70d | 主题迁移数据库时**不回填** `''` 遗留行（0019 头部注释记录了原因）：回填会替用户决定"这些共享值属于哪个语言"，而阶梯的第 2 层已经让它们照旧渲染 |

守卫在 `architecture.test.mjs`（规则 70 节，**3 条**：唯一定义 + 读者全走阶梯 +
扫描非空）；行为断言在 `locale-url.test.mjs` §1b（单页/列表按语言取值 + 阶梯第 2 层
回退——删掉本语言行后回落到站点默认语言）；注入场景在 `_skeleton-inject.mjs`
（**5 条**：列表挂接丢语言 / 单页不挂字段 / 写入落 `''` 层 / 列表丢 reading_time /
第二份阶梯定义）。

## 语言切换是取数，不是改名（规则 71）

批次 24 修的缺陷，形状是「200 + 静默毁数据」：共享行形态（一个 `posts` id、每个语言一行
`post_translations`）把**所有语言的内容**装进同一个响应里，编辑器顶部的「语言版本」条
点击 `zh-CN` 时**只把 `state.editing.locale` 改成 zh-CN**——标题和块编辑器还是上一个
语言的，界面上没有任何异常。用户在这种状态下点保存，就把上一个语言的内容写进了另一个
语言的行。**一次不重新取数的语言切换，是一个穿着导航按钮的数据粉碎机。**

| 规则 | 说明 |
|---|---|
| 71a | 版本条切换到**已存在**的版本时**必须重新取数**，并把目标语言传给取数函数（`editContent(type, id, locale)` → 在语言行里挑 `locale` 匹配的那行）。同 `posts` id 也不例外——恰恰是共享行形态需要它 |
| 71b | **不许只改标签**：`current.locale = locale; render()` 这个形状被结构性禁止 |
| 71c | 后台内容列表的**代表行 = 站点默认语言**（`siteDefaultLocale`），**永远不是 `MIN(locale)`**——字典序回答的是"哪个翻译排最前"，`en` 只是字母表巧合。`?locale=` 参数按语言过滤；被过滤语言没有行的文章**仍然列出**（标题空 + 徽标说明有哪些语言），静默吞行就是"中文版丢了"的温床。每行携带 `locales`（该文实际拥有的语言），SPA 据此画版本徽标 |

守卫在 `architecture.test.mjs`（规则 71 节，**3 条**：切换必须带语言重新取数 +
禁止改名形状 + 列表钉默认语言且无 `MIN(locale)`）；行为断言在 `admin-spa.test.mjs`
（切换后标题/块/徽标来自目标语言的行）与 `admin-contract.test.mjs` §12（默认语言代表行
+ `locales` 集合 + 显式过滤 + 未翻译行不被吞）；注入场景在 `_skeleton-inject.mjs`
（**4 条**：编辑器只改名 / 列表钉死语言 / 丢 `locales` 集合 / 列表只显示行自己的语言）。

## 拒绝必须带出口：强制卸载（规则 72）

批次 25 修的产品缺口：主题被别的站点占用时卸载 409，主题屏只说「仍被以下站点激活，
请先在那里停用」——**一条没有任何出口的拒绝**。占用站点是测试残留也好、真实多站也好，
操作者都未必能"先去那个站点换主题"；"这个主题删不掉"就是这么信出来的。与死锚点、
不可达对话框同族：**界面说了一句真实但没用的真话**。

| 规则 | 说明 |
|---|---|
| 72a | 409 仍是**无条件强制路径**的权威：不带 force 的 DELETE 在任何占用下照样拒绝。出口必须是**显式确认**（`?force=1`），不是默认行为 |
| 72b | 强制卸载先把每个占用站点的 `theme.active` 改回**捆绑默认主题**（规则 66 保证它在每个站点已安装、可渲染——回落永远是一个还能渲染的站点），再走同一条卸载清理（能力行/菜单/设置/生成表/文件/R2 全站清理本来就是按主题名全局做的，只有站点选择需要逐站写） |
| 72c | SPA 侧：占用站点的卡片点「卸载」弹**确认**（列出站点 + 说明回落 + 停用并卸载），不是死胡同提示框。确认后带 `?force=1` 发 DELETE |

守卫在 `architecture.test.mjs`（规则 72 节，**2 条**：拒绝以 force 为条件 + 强制路径先把
占用站点改回默认主题）；行为断言在 `theme-integration.test.mjs` §9（占用中 force=1 → 200
+ 占用站点回落 default + 主题真没了）；注入场景在 `_skeleton-inject.mjs`
（force 被无视——历史形状逐字）。

## 菜单位置解析必须确定性（规则 73）

批次 26 修的确定性缺口：`menu()` 取 header 菜单是 `SELECT id … LIMIT 1` **没有 ORDER BY**。
同一站点建两个 header 菜单（后台完全允许）后，前台导航是 SQLite 高兴给哪行就哪行——
**请求之间会翻转，而代码一行没动**。与"列表按 MIN(locale) 排字母"同族：不确定的读取
迟早被用户当成数据丢失。

| 规则 | 说明 |
|---|---|
| 73a | 菜单位置 → 菜单的解析必须**定序**：`ORDER BY id LIMIT 1`，最小 id 稳定获胜。任何"取一个"的查询都必须能回答"为什么是这一个" |
| 73b | 位置集合来自**激活主题 manifest 的 `menuLocations[]`**（渲染时直读，不落库、不需要重新激活——区别于 routes[] 的注册机制），`buildScope` 按 location 输出 `menu.<id>` / `menu.<id>_html`；`menu.primary*` 保留为 header 的别名（旧模板兼容）。声明里没有的 location **不渲染**，模板里也没有硬编码字面量 |
| 73c | 菜单条目管理是完整 CRUD：批量重排一次提交全序列（服务端先验每个 id 属于本站点本菜单再写）、嵌套只允许一层（父必须同菜单、非自身、无父级）、删除父条目把子条目**升级为顶级**而不是孤儿。全部 site-scoped（规则 6） |

守卫在 `architecture.test.mjs`（规则 73 节，**4 条**：ORDER BY 存在 / 渲染读 manifest
而非字面量 / 内置主题声明 menuLocations / SPA 走 scoped）；行为断言在
`admin-contract.test.mjs` §13（CRUD + 重排 + 嵌套契约 + 跨站点 404）与
`theme-integration.test.mjs` §11（独立站点上双 header 菜单确定性获胜 + footer 位置渲染
+ 二次渲染逐字一致）；注入场景在 `_skeleton-inject.mjs`（LIMIT 1 无排序 + 渲染器硬编码
header——两条都是历史真实形状）。

## 小工具必须站点隔离地端到端（规则 74）

批次 27 修的隔离缺口：`widget_instances` 建表时**没有 site_id**，而唯一存在过的读路径
（`GET /widgets`）连租户过滤都没有——多站点安装里每个站点的侧栏都会显示所有站点的
小工具，正是 §10 规则 6 禁止的泄漏（菜单侧同一教训的孪生：商店的导航项出现在默认站点
首页）。批次 27 同时把"后台有、前台没有"的小工具真正接到了模板上。

| 规则 | 说明 |
|---|---|
| 74a | widget 的**每次读取都带 `site_id`**（前台渲染 `widgetGroups` 与后台列表同样）；0020 迁移重建表（site_id + locale，旧行归 default——与 0009 同哲学），契约声明 `tenant: "site"` |
| 74b | locale 语义与 `menu_items` 一致：`locale=''` 所有语言渲染，指定语言**只在该语言的页面渲染**——故意不做跨语言回退："关注公众号"这种小工具不该因为没人写英文版就出现在英文页上 |
| 74c | 前台接线是契约不是福利：`buildScope` 必须把渲染好的 widget 组放进模板作用域（`widgets.<sidebar>`，无小工具的侧栏无键），消费点在 layout（sidebar 区）与 footer（footer 区）；theme.json 用 `sidebars[]` 声明，SPA 的分组就是声明列表——"在没人渲染的侧栏里建小工具"从此不可能 |
| 74d | config 按类型校验：text/html → body；recent-posts → count 1–20；menu → menu_id 必须属于本站点。html 不过 esc（信任边界：仅管理员可写，与 block 渲染一致，文档注明） |

守卫在 `architecture.test.mjs`（规则 74 节，**5 条**：渲染查询带 site_id / buildScope
喂 widgets 进模板作用域 / 后台列表同样 scoped / 契约 tenant=site / 内置主题声明
sidebars）；行为断言在 `admin-contract.test.mjs` §14（scoped CRUD + 三种 config 校验
400 + 跨站 404）与 `theme-integration.test.mjs` §12（独立站点端到端：四类型渲染 +
禁用不出现 + 异语言不出现 + default 站点小工具不泄漏进本次渲染）；注入场景在
`_skeleton-inject.mjs`（渲染查询丢 site_id + 模板作用域没有 widgets——两条都是历史形状）。

## 后台前缀是注入的，cookie 被它限定（规则 75）

批次 C 的后台隐身。后台前缀可配（平台级设置 `admin.path`，默认 `/admin`），
目标是把**整个后台**（SPA + 资产 + API + 登录端点）挪到一个扫描器猜不到的位置。
三件事各自都可能悄悄失效，因为页面照样渲染、网络面板里的 404 未必有人看：

| 规则 | 说明 |
|---|---|
| 75a | **SPA 不得硬编码前缀。** 服务器在 `/admin/index.html` 里把三处 `"/admin/…"` 资产路径重写成当前前缀，并注入 `<script>window.CFP_ADMIN_BASE="…"</script>`；SPA 的 `state.js`、`i18n.js`（leaf，不能 import state.js，故各自读同一个全局）与登录 fetch 全部由它拼 URL。改前缀后 SPA 仍能用，是这个变量的唯一目的 |
| 75b | **后台 API 整套挂在前缀之下**（`{前缀}/api/…`），不只是登录门。`index.ts` 剥掉前缀后交给 `handleApi`——一份实现、两个前缀（`/api/*` 旧路径仍在，批次 D 才动）。⚠️ **重写 URL 必须带上 `u.search`**：第一版只从 `u.origin` 重建，于是经前缀进来的请求**所有查询参数全丢**（`?site=`/`?withCounts=1`/`?locale=`/分页），而 `/api/*` 那条因为拿的是原始 request 所以照常工作——「有些参数生效、有些不生效」铺满整个后台，且**没有一个请求会报错**（`?site=` 掉了就是「当前站点」，正是默认值）。批次 28 的站点屏因此看不到计数才发现 |
| 75c | **旧地址一律 404**，不重定向（重定向把新前缀交给扫描器）。旧 `/admin` 路由、旧 `/admin/*` **资产**、旧 `/api/v1/auth/login` 都要 404——只 404 页面而放行 `/admin/admin.js` 等于留了指路牌 |
| 75d | **会话 cookie 叫 `cfpress_admin` 且 `Path=<前缀>`**。不用 `cfpress_session`（与批次 D 的 `cfpress_member` 区分）；`Path=/` 会把后台会话带上每个前台请求——验收检查的就是前台响应**不含** `Set-Cookie: cfpress_admin` |

守卫在 `admin-spa.test.mjs`（规则 75 节，**5 条**：源码无裸绝对 URL / shell 仍有 ≥3 个
`/admin/…` 锚点 / `state.js` 与 `i18n.js` 都读全局 / 运行时每个请求都带前缀）；
行为断言在 `admin-contract.test.mjs` §0b/§0c/§15b（cookie Path 是前缀 / 旧登录 404 / 公开端点不
Set-Cookie / 连错 6 次 429 / 把 `admin.path` 移到 `/manage` 后新前缀可用且旧前缀连资产全 404 /
**经前缀的 `?site=` 与 `?withCounts=1` 真的到达 API**）；结构守卫在 `architecture.test.mjs`
（规则 75 节，**8 条**，含「前缀挂载带 `u.search`」）；注入场景在 `_skeleton-inject.mjs`
（`state.js` 硬编码 `/api/v1/` + cookie `Path=/` + cookie 名退回 `cfpress_session` +
**前缀挂载丢 query**——四条都是历史形状）。

> ⚠️ **写守卫时别在 `//` 行注释里写 `/*`。** `architecture.test.mjs` 的 `blankComments()`
> 用非贪婪 `/\/\*[\s\S]*?\*\//g` 抹注释，行注释里的一个 `/*` 会一路吞到后文某个 `*/`，
> **把整段代码抹成空白**，守卫于是报「锚点不存在」——代码是对的，是注释里的字符弄瞎了它。
> 自查：`(src.match(/\/\*/g)||[]).length === (src.match(/\*\//g)||[]).length`。

## 计数按站点分组，主题报「选了什么」（规则 76）

批次 28 §3.1 的站点屏管理深度：每一行要回答「这个站的前台在哪、里面有多少东西、
用什么渲染」。三件事各自的错答案都长得很像对的答案，所以逐条钉住：

| 规则 | 说明 |
|---|---|
| 76a | **一个聚合、按站点分组，不是每行一次请求。** `GET sites?withCounts=1` 用 `GROUP BY site_id` 的 `COUNT` 一次性给出每站的 posts/pages/media。**不带 `GROUP BY site_id` 的 `COUNT` 是最像对的错答案**——它给出平台总数，每一行都是个像样的数字，只有第二个站点存在时才能看出它错。不带 `withCounts` 时 payload 与从前**逐字节一致**（`counts`/`theme` 字段完全不出现），因为站点切换器与 `themes.js` 都读这个端点 |
| 76b | **主题列 = 该站点选了什么**（`settings['theme.active']` 行），**不是** `activeTheme()`。后者回答「该用什么渲染」、会探测存储并按「装了就算数」命名一个主题；用于报表会把一个没选过主题的站点标成有主题。没选过就是**空字符串**，不是 `null`、更不是借默认站点的名字 |
| 76c | **新建站点必须当场播下语言行。** `seedSiteLocales` 的 doc 写着"called when a site is created"——它**从没被调用过**（`createSite` 里补上了）。新站点因此一辈子骑在「无行 → 服务整个字典」的兜底上，且**没有 `is_default` 行**：这正是「新站点是空壳、语言没人选过」的来源。断言要读**表里的行**，不能读服务出来的语言列表——兜底让两者长得一模一样，这就是它隐身的原因 |

守卫与行为断言在 `admin-contract.test.mjs` §16（**23 条**：行级语言种子 + 每站计数含草稿 +
邻站计数是它自己的 + 空站点报 0 而非 `undefined` + 主题读选择/未选报空 + 不带 `withCounts`
无新字段 + 非当前站点的默认语言可被钉住且不动当前站点）；注入场景在 `_skeleton-inject.mjs`
（`COUNT` 丢 `GROUP BY` + 主题改走 `activeTheme()` + 新建站点不播语言行——三条都是历史形状）。
站点屏的前台预览链接由**该站点自己的**前缀/host 拼出（`siteFrontEnd()`），拼当前站点的是错的。

## 两套身份是**结构性**隔离，不是策略性隔离（规则 77）

批次 D 的前台会员。前台有自己的身份——`members`（**按站点**）、`member_sessions`、
`cfpress_member` cookie、`/api/v1/front/…` 端点族——整套设计的地基是：它与后台的隔离
**由构造保证**，而不是由某个"记得写"的检查把门。断言要证明的是「没有东西可交换」，
而这是一句关于**代码**的话：

| 规则 | 说明 |
|---|---|
| 77a | **两个 cookie 名必须不同**（`cfpress_admin` vs `cfpress_member`）。同一个浏览器同时登录后台与前台时会发出一个 `Cookie:` 头同时带着两者，**不同的名字是唯一能把它们分开的东西**。守卫从两处常量定义读出来再比较——重命名一侧会红，守卫也不会因为自己写错的期望值而静默同意 |
| 77b | **两个解析器各读各的会话表**：`currentMember` 绝不出现 `FROM admin_sessions`，`currentUser` 绝不出现 `FROM member_sessions`。**这是承重的断言**——一个改读 `admin_sessions` 的 `currentMember` 会接受后台 cookie，而红线测试只要没人去试就照样绿。前台路由函数体里也**不许出现** `requirePermission`/`currentUser`：那是后台的门 |
| 77c | **两张表在 schema 里就带 `site_id`**，且每次读都把 `site_id` 放进 WHERE（连接的两半都要：会话行与成员行各属哪个站点）。**用户名按站点唯一**（`UNIQUE INDEX (site_id, username)`）——两个站可以各有一个 `bob`；全局 `UNIQUE` 会让一个站的注册挡住另一个站 |
| 77d | **两张表在契约里声明为站点表**（`tenant: "site"` / `onSiteDelete: "purge"`），否则进不了 `PURGE_ON_SITE_DELETE`，删站后留下解析不到任何东西的登录行 |
| 77e | **主题 scope 的 `member` 走 `currentMember`**（在 `runtime-declarative.ts` 里由平台填），主题永远拿不到后台解析器，也伪造不了/清不掉这个字段 |

> ⚠️ **`member_sessions` 带 `site_id` 是承重的，不是冗余。** 一度按派生租户声明
> （可由 `member_id → members.site_id` 推出），`_schema-scope` 立刻报它缺列。真正原因是
> `deleteSite()` 用统一的 `DELETE FROM <table> WHERE site_id=?` 遍历 purge 清单——
> **没有 `site_id` 的表进不了这个循环**，只能加一段 bespoke 删除（第二个会忘的地方）。
> 规律：派生根租户表只在局部列**冗余**时才对（连接表）；这里它是**承重**的。

守卫在 `architecture.test.mjs`（规则 77 节，**17 条**）；行为断言在 `admin-contract.test.mjs`
§17（**35 条**，含两条红线：member cookie 打后台 API → 401、admin cookie 打 `/front/me` → 401，
外加 A 站 member 在 B 站登录失败 / 注册关时 403 / 带前缀站点可达 / 登出后会话失效 /
响应体不含 `password_hash`）；主题侧在 `theme-default.test.mjs` §8b（登录注册模板两种状态各渲染）；
注入场景在 `_skeleton-inject.mjs`（`currentMember` 反读 `admin_sessions` + cookie 同名 +
`member_sessions` 丢 `site_id` + 契约降级为平台表——四条都是真实缺陷形状）。

## 权限答案里必须带着「关于哪个站点」（规则 78）

批次 E 的 staff 按站点隔离。批次 D 分开了**身份**，这一条分开**权限**。旧的
`can(env, user, permission)` 读一列 `site_users.role`——店铺站的 `editor` 到处都是 `editor`，
"此人能否**在此**发布"从来没被问过。地基换成 `site_users_sites(user_id, site_id, role)`：
一行一个 (人, 站)，**行的缺席就是拒绝**。

| 规则 | 说明 |
|---|---|
| 78a | **`siteId` 是必填参数**，不是「可选带默认」。可选会让某个调用点**悄悄**重问站点盲问题——而那个问题**仍然有答案**（它读到某人的一行），缺陷因此能通过评审；必填则编译器点名每一处必须表态"哪个站点"。守卫读签名，**同时拒绝** `siteId?: string` 与 `siteId: string = "…"` 两种可选拼法（后者 `=` 在类型之后，只匹配 `siteId\s*=` 会漏）。后台门 `requireAdmin` 的角色集必须**派生**自 `SITE_ROLES` + `SUPERADMIN_ROLE`，写死会漏掉新角色 |
| 78b | **每一个 `requirePermission` 调用点都传 `siteId`**（当前 **31 处**）。漏一处 = 一处静默答错租户，只有一次看全部才看得见。**两类权限**：`PLATFORM_PERMISSIONS = {platform.manage, users.manage, extensions.manage}`（install 级，只有 superadmin 有）；其余按站点。**建/改/删站点改判为 `platform.manage`**——站点还不存在时没有成员行可满足，按站点判是无解的题 |
| 78c | **绝不回退到 `site_users.role`**。回退正是「从站点移除」变成「仍然有访问」的方式：成员行没了、回退照答、移除看起来生效而什么都没变。查成员表也必须**带站点过滤**（`WHERE user_id = ? AND site_id = ?`）——只留表、丢掉站点的查询形态合法、返回一行、**只是错的那行**。`superadmin` 是唯一有意的例外，且**首先**短路（它是"尚不存在的站点"的答案） |
| 78d | **契约声明为站点表**；`superadmin` 在 `SITE_ROLES` 之外（站点屏不能授予 install 级角色）；迁移带 `site_id` **且必须平移**（每个既有 user × 每个既有 site 补一行，当前角色）——否则升级后第一个请求就对所有人（含 owner）答"无成员"，把自己锁在门外 |

> ⚠️ **`requireAdmin` 的硬编码角色列表是升级陷阱（本批真实踩过）。** 迁移 0023 把唯一管理员
> 提升为 `superadmin` 后，`admin-contract` §0b 立刻红：`requireAdmin` 写死
> `["admin","editor","author"]`，**不含 `superadmin`** → owner 被锁在每一个后台端点之外。
> 规律：任何"允许哪些角色"的集合都要**派生**自角色清单，写死的集合会在加新角色时静默过期。

守卫在 `architecture.test.mjs`（规则 78 节，**15 条**）；行为断言在 `admin-contract.test.mjs`
§18（**31 条**：A 站 editor 打 B 站 `content.write` → 403 + superadmin 全站对照 + `GET sites`
按成员过滤 + `platform.manage`/`users.manage` install 级 + 授/撤站点角色 + `role_here`/`sites` 契约）；
注入场景在 `_skeleton-inject.mjs`（回退全局 role + 丢站点过滤 + `siteId` 变可选 + 迁移丢平移 +
`superadmin` 入可授集 + 后台角色集写死——六条都是真实缺陷形状）。

## 后台 UI 必须问和 API 同一个问题（规则 79）

批次 E2。规则 78 修的是**服务端**那半；这一条是**客户端**那半，失败方式不一样：
**服务端不再读 `site_users.role`，而仍然在渲染它的屏不报任何错**。E1 之后 `users` 表还印着
`x.role`（安装级身份列）当"角色"——安装级是 `author`、却是**当前站点 `admin`** 的账号渲染成
"author"。不抛错、不 403，屏只是回答了一个 API 已经不再问的问题，用的是**仍然有值**的字段。

| 规则 | 说明 |
|---|---|
| 79a | **`users` 屏读端点新加的按站点事实**：`role_here`（本站角色）+ `sites`（成员映射）+ 回声的 `site`；**不把安装级 `role` 当站点角色渲染**（对 `superadmin` 的**比较**是允许的——那是判断不是渲染）。屏还要**点名所看的站点**：`state.site` 与端点的 `site` 一旦不同，静默显示的就会是错站点的角色；「其他站点」列**逐个点名**（`default: Author`），没有其余站点时写「仅本站」——**空白格与渲染失败外观上无从区分** |
| 79b | **站点切换器建自 `state.sites`（＝`GET sites`，服务端按成员过滤，规则 78）**，不是硬编码列表。硬编码会让被过滤掉的站点重新出现、点下去 403——正是本批要消掉的"先给后拒"。守卫锚在**绑定**上（`const siteOptions = state.sites.map(…)`），不是"两个词距离够近"：`state.sites` 在同一文件里还有别的读者，窗口一宽就**永远绿** |
| 79d | **`superadmin` 不出现在站点角色的选项里**（它 install 级、跨全站，端点也 400 拒）。站点角色集在 UI 与 `SITE_ROLES` 里是**同一条闭集**，各写一遍就是两份答案开始分叉的地方 |

> ⚠️ **词典是双向对等的。** 新增 key 必须 **EN 与 ZH_CN 两个包都加**（架构守卫双向查对等：
> 只在一边出现的 key 与只在一边出现的语言一样坏）。同时**删掉过时角色的词条**：`viewer` 在
> `role_permissions` 里根本不存在（规范是 admin/editor/author），下拉里留着它 = 让人建一个
> 零权限账号。

守卫在 `architecture.test.mjs`（规则 79 节，**8 条**）；行为断言在 `admin-spa.test.mjs`
（"users 屏按站点显示角色" **8 条**：本站角色而非安装级列 + superadmin 标为跨站 + 其他站点点名
+ 屏点名所看站点 + 每行有编辑器 + 切换器恰好列出端点返回的站点 + 被过滤的站点不被补回）；
注入场景在 `_skeleton-inject.mjs`（屏改印安装级 `role` + 屏丢 `role_here` + 切换器硬编码 +
`superadmin` 入站点角色选项——四条都是真实缺陷形状）。

## 身份和它的成员行一起死（规则 80）

批次 F。批次 E 把 staff 用户拆成两半：身份（`site_users`，install 级）与成员行
（`site_users_sites`，一行一个 (人, 站)）。**把一行从另一行里拆出来，就会生出一行必须跟着
第一行一起死的行**——而这里**没有级联**（D1 按连接开外键，表上也没声明 FK）。

产品侧**没有删用户端点**，所以今天唯一的孤儿成员行在测试清理里（四个套件手工补了
`DELETE FROM site_users_sites`）。**正因如此清理放在「紧挨身份的一个函数」里**
（`platform/auth.ts` 的 `deleteUser`），而不是等一个未来的端点：失败形态不是
"留了一行"（没人指向它时不可见），而是**"后来复用了同一个 id 的用户继承了陌生人的访问"**。

| 规则 | 说明 |
|---|---|
| 80a | **两行一次 `batch` 删掉**：成员行在前、身份在后。中间态不可观测（读者看不到"身份没了、成员行还在"）。只删 `site_users` 的 `deleteUser` 在**调用点读起来一模一样**，却把这条规则要防的孤儿重新引入——所以守卫**不看调用点，看函数体** |
| 80b | **守卫不要求有调用者，只要求这个两语句删除只有一处定义**——加端点的人会**找到**它，而不是自己重新推导一半。守卫还**跨整个 `src/` 词法禁止**第二处裸 `DELETE FROM site_users`（测试清理里内联删除是合法的；这里管的是产品自己的代码） |
| 80c | 这个 `DELETE FROM site_users_sites WHERE user_id=?` 是**安装级**的、无 `site_id`——身份要走了，它**每个**站点的授权都要跟着走。**加站点过滤反而是错的**（会留下其余成员行，正是本条要防的缺陷）。已写入 `_tenant-query-audit.mjs` 的书面裁决 |

> ⚠️ **"能推导 ≠ 够用"的第三个例子**（前两个：`member_sessions` 的 `site_id`、连接表）。
> `site_users_sites` 的站点可以由 `user_id → site_users`… 不，身份表是 install 级，
> 推不出站点。这条的教训是反过来的一半：**一个安装级的删除语句（无 `site_id`）是合法且正确的**，
> 只要它的理由是"把这个人整个删掉"，而不是"我忘了加站点过滤"。审计工具会把它报成 hit——
> **裁决要写清它是哪一种**。

守卫在 `architecture.test.mjs`（规则 80 节，**5 条**：函数存在 + 两行都删 + 一个 batch +
`src/` 内无第二个裸删身份 + 非空）；注入场景在 `_skeleton-inject.mjs`（删身份时漏删成员行）。

## 主题看到的是**投影**，不是行（规则 81）

主题批次。作用域里每一个对象都是**数据库行的投影**，字段名一律 **snake_case**
（`post.reading_time`、`page.document_title`、`site.title`）——因为它们是行。而 `publicMember`
返回的是 **camelCase**（`displayName`），那是 JSON API 正确的形状、**模板错误的形状**。

| 规则 | 说明 |
|---|---|
| 81a | **`memberScope()` 是 member 唯一的模板投影点**（`platform/members.ts`）。`buildScope` 必须走它，不能把 `publicMember` 的结果直接交给模板。形状对不上时 `{{member.display_name}}` 解析成 `undefined`、**静默渲染为空**——HTTP 200、无异常、页面上就是一个空名字 |
| 81b | **投影保留 snake_case + 一个 `name` 别名**（"想显示点什么"的模板不必自己写回退），且 **绝不携带 `password_hash`**——这个对象会交给用户编写的模板 |
| 81c | **主题套件必须把 part 当一等渲染目标。** 出问题的 `{{member.display_name}}` 在 `templates/parts/header.html` 里——**parts 不是 templates**。只扫 `templates/` 的套件永远渲染不到它（详见下方"守卫失效记录"第 16 种） |

> ⚠️ **这不是假想的。** `content/themes/default/` 的 `login.html` / `register.html` /
> `parts/header.html` **三处**都写着 `{{member.display_name}}`，线上就是空名字；
> 而 `theme-default.test.mjs` §8b 全绿——因为**它的 fixture 手写了 `display_name`**，
> 一个真实作用域从未有过的形状。**fixture 编造运行时不会产生的形状 = 无法失败的守卫**
> （§12 #5 同族）。修法不是改断言的期望值，而是**让 fixture 由真实投影函数生成**
> （`theme-default.test.mjs` §8b 现在 `bundle("src/platform/members.ts")` 后调 `memberScope()`）。

守卫：`theme-default.test.mjs` §8b（`memberScope()` 的 `display_name` + 不是 camelCase，
**且 fixture 由真函数生成**）；`theme-bundled.test.mjs`（**走真 `BUNDLED_THEMES`**，
逐主题渲染**全部** templates **与 parts**，两种登录状态各一遍，签名在的断言必须打印出名字）。
注入场景在 `_skeleton-inject.mjs`（`buildScope` 绕过投影 / `memberScope` 丢 `display_name` /
part 里写成 camelCase——三条）。

## 我的文章是读者的，且只是读者的（规则 82）

`account.html` 上 `{{#each my_posts as post}}` 是全库唯一**一种**由**身份而非路由**决定的列表
（两套主题各一份，来源同一个 `memberPosts()`）。
`buildScope` 只在有 `member` 时建它（**缺席，不是空数组**——否则只看 `{{#if my_posts}}` 的模板
会在空列表上渲染"0 篇"表头，而不是登录引导）。

| 规则 | 说明 |
|---|---|
| 82a | **查询同时过滤 `site_id` 与 `author_member_id`。** member id 今天**按站点唯一**，所以 `WHERE author_member_id=?` 读起来"够用"——而这正是 §10 规则 6 不许依赖的**巧合**。任何让 member id 全局化的迁移都会把它变成**跨站泄漏**且无人察觉。迁移 0024 把这一对写成不变式 |
| 82b | **不滤状态。** 模板打印 `<span class="badge">{{post.status}}</span>`；查询若滤 `published`，这个徽标每行都是同一个词——**装饰，不是信息**。作者必须看见自己的草稿；藏起来的是*公开*列表（那才是 `runThemeQuery`） |
| 82c | **链接是内置 permalink `/{locale}/blog/{slug}`，不是当前路由 base。** 账户页挂在 `/account` 下，复用路由 base 会把每篇指向 `/account/<slug>`、点击即 404——而账户页本身 HTTP 200，所以只有"锚在构造出来的 URL 上"的守卫看得见 |
| 82d | **无会员即缺席**（见上）。`my_posts` 由 `memberRow` 是否在场决定，不放进 `extra`——它是平台解析出的身份派生，插件不得借此把"我的文章"指向别人 |

> ⚠️ **`url` 是唯一不共享的字段。** 列表经路由 base 链接，我的文章经内置 permalink 链接——
> 所以派生的三字段（`date_display`/`cover`/`reading_time`）抽成 `deriveListingFields()` 一处定义
> 两处调用，**`url` 刻意不在其中**。这个抽取不是洁癖：第一版复制了那三行，`_skeleton-inject`
> 立刻报 `anchor appears 2x (need 1)`——**重复正是守卫看得见的形状**。

守卫：`architecture.test.mjs` 规则 82 节（6 条：非空性 + a + b + c + d×2，全部**切函数体**再匹配，
因为 `site_id = ?` 在文件里到处都是，全文扫描会同意一段从未带过这一对的代码）。
注入场景 4 条（去 site 过滤 / 加 `published` / 换成 `/account` base / 无会员也建）。
端到端验收：真 dev server + 真 D1，草稿与已发布都显示、徽标有区分度、链接是内置 permalink、
`/en/account` 用英文自己的 slug（规则 58）、另一会员**零泄漏**并显示空状态、未登录走 signed-out 分支。

## 语言切换器是下拉（规则 83）

切换器从「一排平铺的语言胶囊」改成原生 `<details>/<summary>` 下拉。**不需要 JS**——主题是数据，
`<details>` 是浏览器自带的开合控件，与"主题不执行代码"的红线一致。

难点只有一个：**触发器要显示"当前语言的名字"，而模板语言查不了。** 它有 `{{#each}}` 和九个
helper，**没有"取 current 那一项"**；在触发器里循环也不行——当前项在列表**中间**，
`{{#if l.current}}` 会把**其他**语言的名字一起打出来。所以这个"挑"发生在 `buildScope`，
而它必须从**同一个数组** `lang_nav` 派生——一个来源，两个视图，二者不可能对"哪门语言是当前"产生分歧。

| 规则 | 说明 |
|---|---|
| 83a | **按匹配挑，不按位置挑。** `find(l => l.current)`，不是 `langNavRows[0]`。后者在"站点默认语言恰好是渲染中的语言"时**看起来完全正确**，在其他每个语言上**静静报错**，页面上没有别的东西会反驳它 |
| 83b | **来自 `lang_nav` 的同一个数组。** 另起一个数组去挑，两个数组可以对"哪门语言是当前"产生分歧——而分歧只在多语言站点可见 |
| 83c | **与 `lang_nav` 同一个门槛。** 单语言站点两者都不给：一个语言不构成切换器，而没门槛的 `lang_current` 会在一个**根本不渲染菜单**的 header 里留下一个孤立的名字 |

> ⚠️ **两条守卫第一版都是死的**（`_skeleton-inject` 抓到的，不是评审）：
> ① `theme-bundled` 的断言第一版是**整页** `html.includes("简体中文")`——菜单本来就逐语言列出名字，
> 所以触发器改成 `{{lang_current.code}}` 后，**菜单那一行仍然供出"简体中文"**，断言照样绿。
> 这是「锚在**提及**上而不是**消费**上」的**第四次**（规则 69/78/79）。修法：读 **`<summary>` 内部**的文本
> （剥掉标签，因为触发器里还有图标 SVG）。
> ② fixture 里 `current: true` 排在**第 0 位**时，`find(current)` 和 `[0]` 结果相同——夹具的排序巧合，
> 不是代码，决定了成败。修法：`makeScope` 用**三语言、当前语言在中间**。
> 两集合/两取值先问**凭什么相等**——别断言巧合。

守卫：`theme-bundled.test.mjs` §5b（5 条：`<details>`+`<summary>` / 触发器文本是名字且不含裸 code /
列出其他语言 / 不含 `class="lang-nav"` / `everyPageChecks` 干净；**先过 `{{#if lang_nav}}` 筛文件**，
否则一个删掉整个下拉的主题也全绿）；
`architecture.test.mjs` 规则 83 节（4 条：非空性 + 83a + 83b + 83c，**切 `buildScope` 的 `langCurrent` 构造**再匹配）。
注入场景 3 条（退回平铺 / 触发器用裸 code / 按位置挑当前语言）。
端到端验收：真 dev server，浅色与深色各一张、中英各一张，确认触发器显示**名字**、展开后当前项有勾选标记。

## 前台投稿属于会员，且只属于会话（规则 84）

前台会员可以写**自己的**文章：`POST /api/v1/front/posts` 创建、`PUT /posts/:id` 编辑、
`DELETE /posts/:id` 删除。它**不是** `savePost` 换个调用方——`savePost` 答的是 **staff** 会话：
作者取自后台 cookie、写进 `posts.author_id`、并信任调用方给的 `status`（编辑有权发布）。
会员是另一种身份（规则 77），三处差别正是它单独成函数的原因：

| 规则 | 说明 |
|---|---|
| 84a | **作者来自会话，不来自 body。** `author_member_id` 只从 `requireMember` 的结果取；`body.author_member_id` **一个字节都不读**——读了就等于让一个会员**以别人之名**发文，与"客户端自报 `site_id`"是同一种缺陷。`author_id` 保持 `''`（迁移 0024：**永不伪造**一个 staff 用户，因为 `author_id` 是 `site_users` 的 id 空间，每个读者都这么假设） |
| 84b | **所有权是过滤，落空答 404 而不是 403。** 每条语句同时带 `site_id` **和** `author_member_id`；别人的、别站的、不存在的文章**一律 404**——403 会**确认这个 id 存在**（MS-1.1 禁止的存在性预言机，也是 `savePost` 对跨站 id 也答 404 的理由） |
| 84c | **状态由服务端决定。** 投稿落地即 `'draft'`，`body.status` **直接忽略**；**编辑不碰 `status`**（`UPDATE posts SET` 里没有它）——会员既不能自己发布，也不能把 staff 已发布的文章打回草稿 |
| 84d | **写入是唯一入口。** `post_meta` 只有一处写者 `writePostMeta()`（规则 70 的镜像：**读**是唯一阶梯，**写**是唯一函数）——重复正是守卫看得见的形状（§12 第 17 种） |
| 84e | **不写 `activity()`。** `admin_activity.user_id` 装的是 **staff** id；把会员 id 写进去就是迁移 0024 拒绝的"一列两义"。会员的动作由它碰过的行（`posts.author_member_id`）记录，不进 staff 日志 |
| 84f | **没有第二个"我的文章"读者。** 前台**刻意没有** `GET /posts`：读路径是账户页的 `my_posts` 作用域（规则 82），在 `buildScope` 里**只定义一次**；第二个带自己 SQL 的读者 = "我的"的第二个定义，两者可以互相矛盾 |

守卫：`architecture.test.mjs` 规则 84 节（12 条，全部**切函数体**再匹配：作者只来自会话 /
所有权谓词成对 / 404 而非 403 / `author_id` 写 `''` / 创建落 `draft` 且两次 `UPDATE posts SET`
都不含 `status` / 不写 `activity()` / 无第二个读者 + 三个 `requireMember` 调用点）。
行为测试：`admin-contract.test.mjs` §19（36 条，**真 D1**：跨会员 404、跨站 404、
body 冒充作者被忽略、请求发布仍答 draft、编辑不打回草稿、每语言 slug 冲突 409、
声明过的 meta 按语言写、未声明的丢弃、删除连带清干净；`wipe()` 按**作者**扫而非按 id 前缀——
端点是 `randomId()` 铸的 id，按前缀扫会漏，留下的残留在下一轮撞 slug 冲突、红在**别的**断言上）。
注入场景 3 条（删所有权谓词 / 状态取自请求 / 作者取自 body）。
⚠️ **注入的多行锚点必须 SQL + bind 一起改**——只改 SQL 会让语句在 bind 数量不匹配时抛错，
套件因**无关原因**变红，那是无效注入。

## 前台表单面必须无 JS 可用（规则 85）

会员面（注册 / 登录 / 投稿 / 删除）在模板里一直是**纯 HTML 表单**，注释也一直这么写
（"no JavaScript: the form POSTs straight to the front-end API and the server redirects back"）。
**在这条规则之前，那句话是假的**：前台 API 只解析 JSON，于是真实表单拿到 `400 invalid_username`
——而那个用户名是读者**确实填了**的（`request.json()` 对表单体抛错，`.catch(() => ({}))`
把它变成 `{}`）；注释承诺的重定向**从未发生**。禁用脚本的读者根本登不进来。

| 规则 | 说明 |
|---|---|
| 85a | **一个 body 读取器。** `routeFrontApi` 里**不许**出现 `request.json()`；每个前台端点都走 `readFrontParams()`。逐端点各写一个 `request.json()` 正是两种形状漂移的方式，而且漂移是**静默**的：端点会回答一个调用方**明明发过**的字段 |
| 85b | **回什么形状由调用方决定。** 表单请求答 `303 See Other` 回它自己的 `redirect` 字段（cookie 随行）；JSON 请求**原样**（同 body 同 status）。**读的次数与答的次数必须相等**——新端点读了表单却答 JSON，正是这条钉住的回归 |
| 85c | **表单是「正向识别」，不是「非 JSON」。** 只认 `application/x-www-form-urlencoded` / `multipart/form-data`。`!/json/` 看起来等价，其实不是：`logout` **没有 body**，脚本发它时**根本不带 Content-Type**，那种写法会**悄悄**把它的答案从 JSON 变成重定向 |
| 85d | **重定向只许站内。** `redirect` 字段是**最强意义上的调用方提供**——任何人都能构造一条指向我们表单的链接、填任意值；原样写进 `Location:` 就是开放重定向（一个读起来像我们的钓鱼页）。`//host` 是协议相对（**另一个源**），`/\host` 对某些浏览器是路径、对另一些是 authority，**两者都拒**，被拒时回落 |
| 85e | **失败也要回重定向。** 浏览器读不了 JSON 错误体，所以被拒的提交必须带 `?error=<code>` 回来；否则读者看到的是**同一个表单**，比之前更糊涂。崩溃路径同理（500 也不能给表单看 JSON） |
| 85f | **模板侧：写操作是 POST 表单，读操作才可以是链接。** `account.html` 的删除**必须是 `<form method="post">`**——普通链接只能 GET，而 GET **绝不能**毁掉一行（预取即删除） |

**作用域**：`query`（请求自身的 search params 摊平）进 scope，让模板能读回 `?error=`；
`edit_post` 是 `?id=` 指名的**该会员自己的**文章，**派生自 `my_posts`**（规则 82 的唯一读者），
**不是**第二次查询——一个来源、两个视图，就是规则 83 给 `lang_current` 用的形状。

守卫：`architecture.test.mjs` 规则 85 节（11 条，全部**切函数体**再匹配：路由不自己解析 body /
读取器真的解析表单体 / 读答成对 / 答 303 / 正向识别 / 站内重定向 / 崩溃路径也答表单）。
模板侧：`theme-bundled.test.mjs` §5c（6 条，按**渲染出的消息**断言，不按 CSS 里的 `.form-error`
——那是「锚在提及而非消费」，§12 第 16 种）。
**覆盖面**：§5c 是**主题无关**的（`if (existsSync(templates/compose.html))` 才跑），所以哪套主题
落了文件就自动被检查——`default` 与 `prism` 现在都跑（每套 6 条 compose + 3 条 account）。
⚠️ **但「主题无关」不等于「加了文件就万事大吉」**：`theme-default.test.mjs` §9 有一条**反向**断言
（`no unused keys`），新模板引用的键必须被它的**手写** `tplFiles` 清单覆盖，否则新加的 29 个语言键
会被判成「没人用」。**加模板要同时加进那份清单**——这是本套件唯一一处需要人工跟上的地方。
行为测试：`admin-contract.test.mjs` §20（33 条，**真 D1**：表单注册/登录/登出/投稿/编辑/删除 →
303 + Location + cookie；开放重定向被拒而普通路径被尊重；重名与错密码带 `?error=`；
**表单路径对「不是你的 id」与「不存在的 id」答同一个**（无预言机）；JSON 路径全部不变，
尤其**不带 Content-Type 的 logout 仍是 200 JSON**）。
注入场景 4 条（表单识别变「非 JSON」/ 重定向守卫放开 / 适配器不再 303 / 端点自己解析 body）。

## 守卫失效记录（READ THIS）

`tests/suites/architecture.test.mjs` 自己出过**三次假绿**，都是「检查存在但从不触发」。
**全库累计十八种**——`docs/ARCHITECTURE.md` §12 是完整表，这里列前三种：

| 检查 | 曾经的写法 | 为什么失效 | 现状 |
|---|---|---|---|
| `siteId` 默认值 | 只匹配 `= "default"` 字面量 | `siteId = DEFAULT_SITE_ID` 完全匹配不到，6 处长期漏网 | 已同时匹配字符串与常量，并锚定到参数列表 |
| 主题/插件互不 import | `spec.includes("/extensions/plugin/")` | 真实写法是 `"../plugin/runtime"`，**不含 `/extensions/`** | 已改为按文件目录**解析路径**再比较 |
| 语言包 key 前缀 | 检查存在，但所有 `langs/` 目录都是空的 | **对空集合的检查是空转**——直到批次 2 才第一次有真文件 | `themes/aurora/langs/*.json` 已落地并反向验证过 |

**教训**：文本匹配容易被"同一意图的另一种写法"绕过（前两行），
而**对空集合的检查等于没有检查**（第三行）。凡是要守卫结构，就解析结构
（路径、AST、类型），别匹配字符串；凡是守卫集合，先确认集合非空。
**每次新增守卫，都要注入一次违规确认它会红。**

### 反向验证本身也会假绿：fixture 必须只有一处差异

批次 3 发现第四种失败，**不在被守卫的代码里，而在验证用的 fixture 里**：

> 为 `clearOwnerMenus` 写的"归属隔离"用例，原本拿**主题 owner** 对**插件 owner**。
> 于是把 `WHERE` 里的 `owner_name` 整条删掉，测试**依然全绿**——因为两个 fixture 的
> `owner_type` 本来就不同，`owner_name` 在这一次比较里是多余的。

**规则**：反向验证时，被删掉的那一半必须是**唯一区分 fixture 的那一项**。
写用例时先问一句「我把这一条删了，哪个断言会变红」——答不上来就说明 fixture 没设对。
（修正后：再加一个**同类型**的第二个 owner，注入后产生 3 个 FAIL。）

### 第五种假绿：断言描述的是上一轮的产物（清理失败被吞掉）

批次 4 在 `tests/suites/scaffold.test.mjs` 上踩到，**不在被测代码里，也不在 fixture 里，
而在"测试到底在看哪个文件"上**：

> 套件开头 `rmSync(SCRATCH, { recursive: true, force: true })`。Windows 上这一步会因
> `EBUSY` 失败，而 `force: true` **把错误吞掉**。生成器又刻意拒绝覆盖已存在的文件，
> 于是残留的旧文件全部存活——整套断言描述的是**这一次根本没有写出来的内容**。
> 症状极具误导性：套件全绿，而把缺陷注入生成器之后，红的是"另一件事"。

**规则**：**清理之后要验证清理成功**（`if (existsSync(dir)) throw new Error(...)`）。
凡是"先清空再生成"的套件，都必须能区分"这次生成的"与"上次剩下的"。

同源的第二条，关于**注入脚本自己**：

> 第一次注入脚本打印 `closers removed: 2 -> 2` —— 它什么都没改，
> 而我把随后出现的红色当成了证据。那次"反向验证"证明的不是我想证明的东西。

**规则**：注入后必须断言"目标确实从 N 变成 M"（`if (left !== 0) throw`），
恢复后同样断言。**不能证明自己注入成功的注入，不是注入。**

### 第六种假绿：没有摘要行的一跑，被当成了通过

批次 4 写 `themes/eshop/` 的反向验证时踩到，**不在被测代码里，不在 fixture 里，
也不在"看哪个文件"上，而在"我怎么读测试结果"上**：

> 套件的摘要在 `main()` 末尾打印。模板渲染一旦抛错（未闭合的 `{{/section}}`
> 会让引擎直接抛），控制流跳出，**`N passed, M failed` 这一行永远不会打印**。
> 我的校验脚本用 `grep '^[0-9]+ passed'` 读结果——匹配不到就什么也不输出，
> 而我把"没有输出"读成了"没有失败"。**同一次会话里犯了两次。**

**规则**：**没有摘要 = 失败**。一跑的产出必须能自证它跑完了；`grep` 匹配不到，
是"我不知道"，不是"它没事"。两层都要修：

1. **套件侧**：摘要抽成 `summary()`，`catch` 分支里也调用，并把异常计为一条失败。
   任何一跑都必然有摘要行，崩溃标注 `(aborted)`。
   ⚠️ 早先某主题套件只打印 `${failed} failure(s)`、**没有 passed 计数**（该套件已在批次 10 退役），
   已统一。**摘要格式不一致，脚本就分不清"绿"和"崩"。**
2. **校验脚本侧**：`grep -qE '^[0-9]+ passed, [0-9]+ failed'` 失败即 `exit 1`。

> **第六种的孪生：摘要说 `(aborted)`，而 `(aborted)` 里没有具名断言。**
> 规则 84 与 85 的注入各撞上一次：注入的缺陷让套件**崩溃**（不是断言失败），
> 崩溃被 `catch` 忠实报成 `(aborted)` —— 但反向验证工具要找的是**失败列表里的具名断言**，
> 而 abort 的失败列表**是空的**。于是工具报 `no summary while injected`，
> 读起来像「工具坏了」，真相却是「这条守卫**没有被证明**会红」。
> 两次根因相同：**fixture 的 setup 被正在被测的那个缺陷弄坏了**，断言想要的那一行**从未存在**，
> 而测试用 `sqlite.prepare(...).get(...).title` 直接取属性 → `TypeError`。
> 修法：`?.`（**绑定**要 `String(x ?? "")`，绑定 `undefined` 会抛
> `Provided value cannot be bound to SQLite parameter`），并把纪律降级为机制 ——
> `launcher-parity.test.mjs` §5d 断言**每个套件的数据库读取都空安全**（注释先清空，
> 否则守卫会命中自己解释缺陷形状的那两行注释）。
> **教训：崩溃不是「确认的检出」。** 一条守卫要被证明会红，就必须红在**它自己那条断言**上；
> 崩溃的失败列表里没有它，于是「守卫没红」和「守卫红了」长得一样。

### 反向验证工具自身的两个陷阱（都在批次 4 踩到）

| 陷阱 | 症状 | 修法 |
|---|---|---|
| **字节数守卫看不见等长替换** | `"/shop/"` → `"/blog/"` 长度完全相同，守卫打印"什么都没改"，而注入**其实生效了** —— 防假阴的工具自己产出假阴 | 比**内容哈希**，不比长度 |
| **快照取自脏树** | `git checkout -- <path>` **修不了 git 从没见过的文件**（新主题是 untracked），还原静默失败 → 场景逐层叠加；更糟的是脏状态被**拍进快照**，"还原"忠实还原了损坏，套件连续七轮红在**没有任何场景引入过**的缺陷上 | 不用 `git checkout`：快照前 `assertPristine()`，还原后**再** `assertPristine()`。**还原也要被验证** |

参考实现：`tests/tools/_launcher-inject.mjs`（16 个场景，每个都断言"确实注入了"→"红在哪一条"→"还原成功"）。
它**不进 `npm test`** —— 它是工具，跟 `_i18n-browser.cjs` 同一性质。

### 第七种假绿：守卫守的是「写法」，不是「语义」

`architecture.test.mjs` 的 `siteId` 零容忍检查出过**第四次失效**，形态与前三次同源但更隐蔽：

> 它匹配 `siteId = "default"`（参数默认值），**匹配不到 `o.siteId ?? "default"`**。
> 于是 v0.7.1 审查时发现 `??`/`||` 形式的兜底又悄悄长回来了——
> **问题没被消灭，只是从 `=` 被挤进了 `??`**。

同类，**本次新增守卫时自己又踩了两次**（都是"守卫本身不生效"）：

| 症状 | 原因 | 修法 |
|---|---|---|
| 新写的兜底正则对 `o.siteId ?? "default"` **不匹配** | `\b` 在 `"default"` 的 **尾引号后**不成立（`\b` 要求两侧一为词字符），`(?:"default")\b` 恒假 | 去掉尾 `\b`；**逐写法实测**，不靠推断 |
| 豁免范围元守卫**注入后不变红** | 它只统计"既带标记、又有违规"的文件 → 第二个文件**没有违规就能白拿豁免** | 统计**标记本身**，不统计"标记有没有起作用" |

**规则**：① 守卫要覆盖**同一意图的每一种写法**（`=`、`??`、`||`、三元），
新增一条就用一批真实样例**逐条实测**它命中；② 守卫**自身的守门逻辑**也要反向验证，
**一个"只在没违规时才通过"的检查，看不见自己的范围失控**。

### 第八种假绿：断言**拼法**让它不可能失败

批次 6 新增 schema / 事件契约守卫时，本文件的格式被抄了一遍：

```js
check("no domain event is declared twice", dupes, []);   // ← 不可能失败
```

`check(name, condition, detail)` 测的是 **真值**，而**空数组恒为真**。
于是七条新守卫**全部无法失败**——注入一个重复的 `MediaUploaded` 到 `DOMAIN_EVENTS`，
磁盘上确实是两份，测试**依然 40/40 全绿**。这是唯一一次假绿发生在**守卫自己内部**。

**修法两层**：

1. `checkEmpty(name, offenders)` —— 意图可表达，不必在每处重复 `len === 0`；
2. **元守卫**扫本文件，禁止 `check(<字符串>, <任意表达式>, [])` 这种拼法，并断言
   扫描到的 `check*` 调用数 **> 20**（否则扫一个空文件也"通过"）。

> 第一版元守卫只匹配**裸标识符**（`check("x", someList, [])`），
> 结果两条条件写成 `.filter(...)` 的假绿调用溜过去了。**守卫的守卫也要覆盖每种写法**
> ——这正是第七种的教训，隔一节又犯了一次。

### 反向验证工具自身的三条铁律（`tests/tools/_skeleton-inject.mjs`、`_launcher-inject.mjs`）

本轮把全部场景跑通了（现已 12 个），途中工具自己假绿过三次：

| 坑 | 症状 | 修法 |
|---|---|---|
| **量字节数看不见等长替换** | `"site"`→`"sote"` 长度相同 → 守卫打印"什么都没改"，而注入**其实生效了** | 比**内容哈希**（SHA-256） |
| **快照取自脏树** | 还原失败（`git checkout` 修不了 untracked 文件）→ 场景逐层叠加；脏状态被拍进快照 → "还原"忠实还原了损坏，**连续几轮红在没人引入过的缺陷上** | 快照前 `assertPristine()`，还原后**再**跑一次——**还原也要被验证** |
| **用子进程跑套件** | 本沙箱 `spawnSync` 一律 `EBUSY` → 每个场景报"没有摘要"，**"跑不起来"伪装成"没变红"** | 改用 **Worker 线程**（同进程，无需二元文件）。⚠️ 从 ESM 父进程 `eval` 出的 worker 里 `require` **未定义** → 必须用 `import()` |

第 2、3 条合起来的后果很值得记：**一次未还原的注入，会让后续所有场景的结论作废**，
而 `assertPristine` 之所以没拦住，是因为它的基准快照本身取自已经脏掉的树。**先修树，再快照。**

### 十八种假绿的**共同盲区**（比十八条记录本身更重要）

十八条不是十八个随机的意外。把「修法」一列竖着读一遍，会发现它们几乎全部落在同一句话上：

> **我倾向于检查「我写下的字」，而不是检查「实际发生的事」。**

| 检查的层次 | 假绿条目 | 为什么会假 |
|---|---|---|
| **字节层** | — | 长度相同、BOM 缺失、CRLF 混入：文本比较看不见 |
| **文本层** | 1、2、5、7、10、**11** | 匹配字符串 → 「同一意图的另一种写法」直接绕过（**11：注释里的 token 也算**） |
| **集合层** | 3、4 | 对空集合 / 只有一处差异的 fixture 施加断言 = 空转 |
| **控制流层** | 6、8 | 崩溃路径从不执行到断言；`check(…, [], [])` 这种拼法不可能失败 |
| **调用点层** | 9 | 断言「某函数被调用过」，而它有第二个调用点 |
| **观测面层** | 12、**14** | 断言本身成立，但**它观测的那一层看不见缺陷**（服务端断言看不见渲染器；单套件看不见注册表全集；**分发渠道的守卫看不见「主题有没有安装」**） |
| **工具层** | 13 | **被测代码、fixture、断言全对**——错的是"谁来收尾这场实验"：工具在套件得出结论前就关掉 worker，把红读成了 abort |

**没有一条是"测试写错了"**——十八条全都是「守卫覆盖的范围比它声称的小」。
所以「第十八种」几乎必然长得像其中某一行，而**不是**一个新病。

> **第十二种已经来了（观测面层）。** 批次 10 修完渲染器读错字段路径的缺陷后，
> `admin-spa.test.mjs`（15/0）与 `plugin-pages.test.mjs`（46/0）**双双保持全绿**——
> 因为前者只查模块图与导出，后者只在服务端断言。**没有任何一条断言观测过"把响应
> 渲染成 HTML 再读回"**。修法不是加断言的*数量*，而是加断言的**观测面**：
> 在 `plugin-pages.test.mjs` 第 9 节装 DOM 替身、加载**真实**渲染器模块，
> 断言 `<th>Label</th>`、`<td>7</td>` 真的出现在 HTML 里。
> **删掉这条断言，那两个缺陷立刻复活而其余全绿。**
> 呼应 §12 的预测（第十二种长得像第 3 行「集合层」），但它其实是**新的一层**：
> 断言正确、集合非空，只是**它的眼睛没对着缺陷**。

> **第十三种也来了（工具层），而且比第十二种更靠外。** 批次 11 给三个注入工具写
> worker 入口时用了 `import(suite).then(() => done(0))`——`import()` 在**模块体结束时**
> 就 resolve，**早于套件 `main()` 的第一个 `await`**。谁先结束 worker 谁说了算，
> 于是 esbuild 编译慢的 `features` 套件**确定性输掉这场竞速**，症状是"注入后没有摘要"。
> 这里被守卫的代码、fixture、断言**三条全对**，错的是**实验的收尾权**——
> 工具把一次真红读成了 abort。修法：worker 入口**只由套件自己桩掉的 `process.exit`
> 收尾**，加 `reported` 守卫保证只结算一次。
> **教训：假绿可以发生在「被测对象之外」——眼睛（观测面）和手（工具）都会骗你。**
> 所以"我的断言对不对"这个问题永远问不到工具这一层，工具**自己也得跑一次反向验证**。

> **第十四种来了（观测面层，回到第 12 种的同一行——预测兑现）。** 批次 22 把双语内容
> 播到线上时发现：`GET theme/fields` 返回 `{"items":[]}`，而主题**正在服务每一个页面**——
> 中文页、切换器、feed、sitemap 全对。根因是 `seedBundledExtensions` 只写 `theme_installs`
> 注册行、**从不调 `applyThemeCapabilities`**，而 `activeTheme()` 会回退到注册表并探测
> 可加载的 `index.html`，所以主题**照样渲染**。规则 66 的 18 条断言全绿——
> 它们问的是"文件分发得到吗"，**没人问"主题拥有什么"**。后果是 `savePost` 的
> `fieldExists` 闸门把每个 `meta` 静默丢掉：线上实测 12 次 200、`post_meta` 零行、
> 中英文首页全写「Uncategorised / 未分类」。修法是规则 69：boot 链**先注册后安装**，
> 判据**数行**而非版本戳。**教训：能渲染是最强的假绿**——它是全站所有测试的共同前提，
> 会让"某个声明面整个缺席"变成不可见。

> **第十五种来了（还是观测面层，但这次骗过守卫的是它自己喂的数据）。** 批次 26 重写菜单屏时
> 少 import 了 `attr`，浏览器里一打开菜单页就 `attr is not defined`；而 `admin-spa.test.mjs`
> 早就有一条"每个注册页面都真渲染一遍"的守卫，它**全绿**。原因是桩 `fetch` 对所有列表
> 统一回 `{items: []}`——**行渲染代码从不执行**，于是 `.map(m => attr(m.id))` 里的
> 未定义标识符永远走不到。这不是"断言写错了"（断言对、集合非空、控制流也走到了），
> 而是**观测面喂进去的是一份"什么都不做"的输入**：空数据让屏幕退化成静态骨架，
> 而骨架恰好不需要那些标识符。修法两条：桩的默认 GET 改成**一行真实形状的记录**
> （`{...probeItem, items: [probeItem]}`），以及把"渲染出错"的失败信息**带上屏幕自己的报错文本**
> ——否则你只知道"它渲染了错误面板"，还得回浏览器里找原因。
> **教训：假绿不只来自"检查的范围比声称的小"，也来自"喂给检查的数据比真实的小"。**
> 空集合、空列表、空载荷都是同一类：**代码路径没被走到，而不是没写错。**

> **第十六种来了（fixture 层：守卫的输入是它自己编的形状）。** 主题批次给一个二次元主题
> 写通用套件时，先写了一条"签名在时模板要打印出读者名字"。它在 `theme-default.test.mjs`
> §8b 里**一直是绿的**——因为那个 `member` fixture 是**手写的 `display_name`**，
> 而运行时交给模板的其实是 `publicMember` 的 **camelCase `displayName`**。
> 于是 `{{member.display_name}}` 在**线上渲染成空**（`default` 主题的 `login.html` /
> `register.html` / `parts/header.html` 三处就是这么写的），而套件全绿：
> **守卫的输入是一个运行时永远不会产生的形状。** 这不是"断言写错了"（断言对、也真的执行了），
> 是**夹具替被检对象承担了它不具备的性质**——和第三种（空 `langs/` 目录）、第十五种（空列表桩）
> 同族，但这次空不是"空集合"，是"**填了假的**"。**空的和假的都是同一类：夹具不是被测对象的样本。**
> 修法两条，缺一不可：① 投影在**产品代码里只有一处**（`memberScope()`），
> ② **fixture 由那个真函数生成**（`theme-default.test.mjs` §8b 现在
> `bundle("src/platform/members.ts")` 后调 `memberScope()`），把"夹具与运行时一致"从人的记忆
> 变成 import 边。**只要夹具是手写的，它就一定会漂。**
> 第三条修法针对**范围**：新套件第一版只扫 `templates/`，**parts 被漏掉了**——
> 而出问题的那一行恰好在 `parts/header.html`。把 camelCase 注进 header，套件仍然 **100/0**。
> 反向验证抓住它之后才补上 parts。**这正是第 11 种"套件红了不等于你的守卫红了"的镜像：
> 套件全绿也不等于你要守的那条被执行到了。**

> **第十七种来了（工具层：锚点被复制品弄得不唯一）。** 规则 82 给 `memberPosts` 写第一版时，
> 它**照抄**了公开列表的三行派生（`date_display`/`cover`/`reading_time`）。于是注入器里
> 既有的场景 `listings stop deriving a reading time` 的锚点 `it.reading_time = readingTime(...)`
> **在文件里出现了 2 次** → 工具不再"注入一个缺陷"，它会**同时改两处**，并且报
> `anchor appears 2x (need 1)`。**这次红得对，却被第一眼读成了工具的问题**——危险正在这里：
> 同一个形状在没有 `appears Nx` 检查的工具里，就会**静默地注入到错误的地方**，
> 然后"went red"给你一个假的安全感。修法两条：① 抽 `deriveListingFields()`，
> **一处定义、两处调用**——重复正是守卫看得见的形状，**修掉重复比放宽锚点正确**；
> ② 工具对多命中**直接判无效**，别取第一个。**`appears Nx` 这一条本身就是守卫，不是噪音。**

> **第十八种来了（还是工具层，但方向相反：绿被读成了工具坏）。** 规则 83 的注入场景跑完，
> 工具报 `no summary (aborted)`——措辞把矛头指向**运行器**。真相是：注入之后**套件保持全绿**
> （因为断言是死的，见规则 83 段），而 `theme-bundled` / `theme-default` 的结尾是
> `if (fail) { … process.exit(1); }`——**只在失败时退出**。harness 只把套件自己桩掉的
> `process.exit` 当完成信号，于是套件自然退出 → worker 排空 → 找不到摘要 → 报"没有摘要"。
> **这与第 13 种是同一枚硬币的两面**：13 是"**红**被读成 abort"，18 是"**绿**被读成 abort"，
> 两者都**指向工具自己**。修法：① harness 补 `process.on("beforeExit", () => done(0))`——
> 它在**事件循环排空**时触发（所有 `await` 结算之后），**不会**重现第 13 种"模块体结束即提前
> 触发"的竞态；② 两个套件改成**无条件** `process.exit(fail ? 1 : 0)`，回到 harness 假设的约定；
> ③ 症状词条要**指向真相**（"did NOT go red"），别让"工具坏了"成为第一嫌疑。
> **工具报错时，先问它指的是代码还是它自己——两种都发生过。**

> ⚠️ **注：第六种的第 1 条被 8 个套件违反了——约定没有机制就会漂移。** 规则 84 的注入场景把
> 缺陷注进 `src/api.ts` 时，工具报 `admin-contract` **`no summary (aborted)`**。真相不是工具坏了：
> 套件在缺陷下**抛异常崩溃**，而它的 `main().catch` 只打 `Harness error:` 就 `process.exit(2)`
> ——**没有摘要行**。这与第六种的**第 1 条逐字相同**（"摘要抽成函数，`catch` 里也调用，崩溃标注
> `(aborted)`"）：规则早在批次 4 就写进了本文档，**却没有任何机制**。到批次 24，**28 个套件里已有 8 个**
> 漂出了这条规则（`catch` 退出时给了 code，没给摘要），另有 6 个同族（`features`/`i18n`/
> `plugin-hooks`/`theme-worker`/`scaffold`/`manifest-validation`）。**一份只有文字、没有守卫的约定，
> 就是一份会腐烂的约定。** 修法两条：① 14 个套件补上崩溃摘要；② 把约定**降级为机制**——
> `launcher-parity.test.mjs` §5c 现在断言**每个套件文件里"最后一个崩溃构造之后"必须出现摘要**
> （`summary(`/`finish(` 调用，或 `passed, … failed` 文本；`catch { bootError = e }` 之后照常报告是
> **允许**的，因为那一跑确实自报了）。它用**行首锚定**的正则找崩溃构造——**守卫自己的源码里就含这些
> 标记字符串**，不锚定就会搜到自己，然后去检查错的块。注入场景 1 条（把一个套件退回那 8 个的形状）。
> **教训：第六种给了规则，这条注记说明规则需要守卫；"有文字无机制"就是漂移的温床。**

**写新守卫前先问**：这条断言生效在**哪一层**？我是否在用一个**更低的层**
（字符串匹配）去代理一个**更高的层**的事（"这个函数被真正调用"）？
**而第 14 条补了后半句**：还要问"**有没有一条正常路径会替这个缺陷把表象撑住**"——
有的话，那个表象本身就是所有测试的盲区。
**第 16 条再补第三问**：**我的夹具/输入，是运行时真的会产出的东西吗？**
——不是"看起来像"，是**同一段代码跑出来的**。手写的 fixture 是一条会随时间腐烂的断言。
**第 18 条再补第四问**：**工具报的错，指的是被检的代码，还是它自己？**
——13 与 18 证明两个方向都会发生；"no summary / aborted / INVALID"这类词条**先怀疑工具**，
但结论必须来自读它**实际红了哪几条**，不是读那句总结。

⚠️ **这套纪律本身就是最大的单点风险。** 上面全部防线**没有一条是自动的**——
反向验证靠人记得写、记得跑、记得还原。它**不会报警，因为守卫恰恰是那个不会报警的东西**。
要把「第十八种」变成「最后一种」，只能把纪律降级为机制：新增具名断言**必须**附一个注入场景，
否则守卫本身被拒绝；注入骨架由脚手架生成，红不了就拒绝提交。**在那之前，
这份清单的增长速度就是纪律被消耗的速度——它不是战绩，是欠条。**

⚠️ **新增一条：注入之后必须确认「红的是这一条」。** 第 11 种就是靠第 6 节替它背锅而
差点蒙混过关——**套件红了不等于你的守卫红了**。工具要打印**实际红了哪几条**（已实现），
而人必须去读那张名单。

### 第十一种假绿：守卫数的是**被注释掉的 token**（文本层，已预测）

退役 `themes/aurora` 时把它的通用不变量折进 `tests/suites/theme-fixture.test.mjs`，
顺手给 fixture 补了 `home.html`。反向验证的注入动作是"删掉真实的 `{{/section}}`"，
但注入版本里**注释中保留了一个 `{{/section}}` 作为诱饵**——守卫是纯文本计数：

```js
const closes = (src.match(/\{\{\/section\}\}/g) ?? []).length;   // 数的是原始文本
```

于是 `opens=1, closes=1` → **红的是"另一条"（第 6 节 shell 不变量），
而这条本该红的没红**。判据 `unclosed == []` 假绿，因为注释里的 token 也算数。

**真相大白于"分清哪一条红了"**：真正拦住它的是引擎的 `validateSections()`，
它遍历的是**解析后的 AST**（`n.body === null` 判定插槽），注释在解析前就被剥掉，
所以结构判据不会被诱饵骗。**文本近似又一次被结构性事实击败**——这是本仓库第 N 次。

**规则**：任何在模板源码上做的 token 计数，**必须先剥掉 `{{! … }}` 注释**
（`src.replace(/\{\{![\s\S]*?\}\}/g, "")`）。同一文件里 `{{@include/@extends}}` 的目标
收集也有同一个 bug，已一并修。判据是**这条守卫单独注入后必须自己变红**——
不是"套件红了就行"（第 6 节替它背了锅，那不算证据）。

> 印证了上一节的预测：**第十一种长得像第 2 行，不是新病。** 预测成立，
> 但**预测成立本身不产生防线**——靠的还是我这一次记得去看"红的是哪一条"。

### 第九种假绿：守卫被**另一半**满足（`_launcher-inject.mjs` 第 5 场景）

写启动器对齐检查时，`deploy` 守卫的断言是"`Test-DeployPrecheck` 在定义体之外出现过一次"。
注入时只删掉了 `Invoke-Deploy` 里的那一次调用，`Invoke-DeployFull` 里的**另一处调用**
继续满足断言 → **套件全绿，而部署路径已经不再检查占位符**。

**规则**：断言"某函数被调用"时，要问一句"它有几个调用点"。
**每个调用点各写一条断言**（现在是 `(Invoke-Deploy)` 与 `(Invoke-DeployFull)` 两条），
并且**按函数体切出来单独检查**，不要在整个文件的文本里搜。
这跟第七种（`resetPluginRuntime` 只测了一个 sink）是同一个病，
跟「fixture 只有一处差异」是同一条反向推理。

### 第十种假绿：**期望值写反了**，于是"红得不对"被读成"没红"（同工具第 3、9 场景）

`checkEmpty("no suite name is listed only by .sh", onlySh)` —— 从 `.ps1` 里删掉一个套件时，
这个断言**正确地红了**（`.sh` 有、`.ps1` 没有 = "只有 .sh 列出"）。
但我在场景里把 `expect` 写成了 `... only by .ps1`，工具于是报
`<- went red, but not where expected`，我第一反应是"套件有 bug"，差点去改**对的代码**。

**规则**：出现"红了但不是这一条"时，先怀疑**期望值**，再怀疑代码。
断言名里的方向词（only by X / missing from X / left / right）要**照着集合差集的定义读一遍**
再写进场景。顺带：工具必须把**实际红了哪几条**打印出来（`[…|…]`），
否则"红得不对"和"没红"在输出上无法区分。同一次会话里，第 9 场景也是同一个错误。

### 合法豁免要写在源码里，不要写在测试里

`resolveSite()` 确实需要兜底（请求总得属于某个站点）。用 `?? DEFAULT_SITE_ID`
写在测试里当例外清单，读者在 `sites.ts` 里看不到它为什么合法。
改为标记 `// ARCH-RULE-EXEMPT: site-default` 放在该行上方，**全库只允许一处并计数守卫**。
好处是不豁免集合看不见：标记在源码、计数在测试，两边都要动才能扩大范围。

## 多语言（§10 规则 5、7、8）

| # | 规则 |
|---|---|
| 10 | 回退顺序恒为：当前语言 → 站点默认语言 → 空。**不抛错** |
| 11 | 语言包 key 必须带前缀：`core.` / `theme.{name}.` / `plugin.{name}.` |
| 12 | **界面语言**（后台菜单）与**内容语言**（前台文章）是两件事，不得混用 |
| 13 | 显式语言的 URL（`/en/x`）找不到时返回 404，**不回退到别的语言** |
| 13b | `lang_group` 可空，**「没有它就是自己」这条规则必须只写一次**：JS 用 `groupOf()`，SQL 用 `GROUP_SQL`（`src/api.ts`），两处共用同一个定义 |
| 13c | 语言开关（启用/停用/加语言/改默认）改动后**必须刷新后台上下文**（`loadContext()`），否则编辑器的语言版本条会整条不渲染 |
| 13d | 扩展菜单的 `label_key` 必须带 owner 前缀（`theme.{name}.` / `plugin.{name}.`，规则 11 的延伸——`validateAdminMenus` 用 ownerName 构造正则拒绝越界 key）。**菜单标签的翻译发生在服务端**（`admin-menus` GET 命中字典即替换 `label`），SPA 不做二次翻译 |
| 41 | **所有数据都必须有多语言能力，不是可选项**。表字段按承载内容分两类，分类表是 `contract/manifest.ts` 的 `PROSE_FIELD_TYPES` / `LANGUAGE_NEUTRAL_FIELD_TYPES`，`isProseFieldType()` 是唯一谓词：散文（`text`/`longtext`）**必须**在 `translatable`，语言中立（`number`/`boolean`/`date`/`datetime`）**必须不在**。两个方向都在安装边界、架构测试、脚手架默认值三处强制 |
| 42 | 主题/插件表**必须显式声明语言结构** `tables[].language{strategy,translatable,fallback,requiredLocales}`。`strategy` ∈ `none`/`sidecar`（`versioned` 声明了但**未实现 → 校验器拒绝，不是忽略**）。`strategy:"none"` 而表里有散文 = **断言为假，拒绝**；`language.translatable` 与扁平 `translatable` 不一致 = **两个权威，拒绝**；`fallback`/`requiredLocales` 里的非法 locale 码拒绝 |
| 43 | 平台 schema 的租户/语言归属**只有一份声明**：`contract/schema.ts` 的 `PLATFORM_SCHEMA`。`TENANT_TABLES` / `PLATFORM_TABLES` / `DERIVED_TENANT_TABLES` / `LOCALE_COLUMN_TABLES` **全部派生自它，不得手写**。每一条必须写 `note`（≥10 字）说明理由，派生租户（`derivedTenant`）必须写明 FK 路径（`post_id → posts.site_id`） |
| 44 | schema 声明**必须被真实数据库检验**（`tests/tools/_schema-scope.mjs`，进了 `npm test`）：数据库里的表没被分类 = 红；租户表没有 `site_id` = 红；平台表**有** `site_id` = 红；`_i18n` 边车**有** `site_id` = 红。它跑在**临时 SQLite**（迁移流）上而非 `.wrangler/`，并**驱动真实的 `syncThemeTables()`** 造出生成表——否则那些断言全是空转 |
| 45 | 领域事件是**独立于 hook 的契约**（`contract/events.ts`）：**事件是事实**（过去式 + `payloadVersion` + 必带 `siteId`，分语言的事实带 `locale`），**hook 是通道**。`DOMAIN_EVENTS` 与 `DECLARABLE_HOOKS` **不得互相掺入**（hooks 里出现事件名 = 红）。插件的 `subscribes[]` 在**安装边界**对照 `DOMAIN_EVENTS` 校验——**订阅一个不存在的事件名是 400，不是"永远不触发的 hook"** |
| 46 | 表有租户字段 **≠** 查询用了它。`tests/tools/_tenant-query-audit.mjs` 列出所有触碰租户表却不带 `site_id` 的语句；**每一处都必须有书面裁决**（`REVIEWED` 表）。没有裁决的新语句打印为 `NEW`。它是报告工具，**不进 `npm test`** |
| 47 | 平台表（`theme_installs` 等）上的跨站聚合是**设计不是泄漏**：`active` 的含义就是"有站点在用它"。判断是否泄漏看**声明**（`schema.ts` 的 `tenant`），**不看表名前缀**——`theme_installs` 匹配 `theme_*` 但它是平台表 |

规则 42 的后果：`strategy` 不是文档装饰。写 `"versioned"` 会**装不进去**而不是静默降级——
把一个存在但不可用的选项留在白名单里，等于承诺了没实现的能力。

规则 43 的后果：`theme_installs` / `theme_settings` / `plugin_installs` / `plugin_settings`
都匹配 `^(?:theme|plugin)_` 前缀，但它们是**平台注册表**、设计上**没有** `site_id`。
所以判别器是 `isGeneratedBusinessTable()`（先查声明），**不是那个正则**——
首次运行 `_schema-scope.mjs` 就在这 6 张表上假红过。

规则 45 的后果：`DOMAIN_EVENTS`（21 个）与 `DECLARABLE_HOOKS`（7 个）**数量不同是正常的**，
因为问题不同——"有几个可挂载的通道" ≠ "有几件值得知道的事"。

### 越界不变量：查询级（规则 46、47）

表声明守的是**形状**，规则 46 守的是**用法**。一条语句可以完全合法地写出来，
却装着"跨站读别人的行"：

规则 11 的后果：`themes/aurora/langs/zh-CN.json` 里写 `"nav.home"` 会让测试失败，
必须写 `"theme.aurora.nav.home"`。**这不是风格要求**——两个扩展都定义 `nav.home`
时，谁生效取决于加载顺序，且没有正确的修复位置。

规则 13b 的后果：只写 `WHERE p.lang_group = ?` 会**排除掉组名所指的那一行自己**
（它的 `lang_group` 是 NULL），于是组看起来是空的，编辑器报告语言缺失并诱导用户
**再建一个已经存在的语言的副本**——不报错，只是悄悄多出一份内容。
守卫在 `tests/suites/i18n.test.mjs` 第 9b 段，两处调用点都反向验证过。

规则 13c 的后果：`state.locales` 是缓存，语言开关是它的事实源。改了开关不刷新缓存，
`loadVersions()` 会以为站点是单语言的，于是**整个语言版本条不渲染**——
屏幕上没有任何东西是红的，因为"少一块"不会报错。

### 规则 41：为什么必须"强制"而不是"支持"

多语言能力曾经是**可选**的：`tables[].translatable` 写了就生效，不写就静默退化为单语言。
缺了它，**安装成功、单语言下渲染完全正确**，直到启用第二种语言才暴露——
那时修复成本已经是「迁移 + 重译」。这就是「声明先于运行时」缺陷族的又一员：
**校验器问的是「已声明的字段分对类了吗」，从不问「字段声明了吗」。**

三个消费者共用一处分类，**不得各自重写**（规则 23 精神）：

| 层 | 位置 | 作用 |
|---|---|---|
| 安装边界 | `contract/validation.ts` | 第三方 zip 装不进来——架构测试**永远看不到**还没落盘的扩展 |
| 架构测试 | `tests/suites/architecture.test.mjs` | 已发布主题当场变红，报错指名 `file:table:field` |
| 脚手架 | `scripts/make-table.mjs` | 新主题天生合规——生成器不守规则，规则第一天就漏 |

**为什么 B 方向（语言中立不得声明）不是多余的**：把 `price` 标成可翻译
等于**每种语言一个价格**——数据模型错误，但不会崩。**「不报错」和「正确」是两件事。**

**为什么分类表本身也要被守**：规则 41 若只跑已发布主题，新增第七种字段类型时会
全绿通过（集合里没人用它）。`tests/suites/architecture.test.mjs` 因此额外断言：
两表不重叠 / 每个允许类型都被分类 / 无幽灵类型 / **扫到的表数 > 0**。
最后一条是关键——把 `content/themes/` 改名会让「所有主题都合规」**恒真**。
**对空集合的检查是空转**（本仓库第三种假绿）。

**标识符不是散文**：SKU、券码、外部 id 必须用 `number`/中性类型，不要用 `text`。
用 `text` 等于宣称「这段文字值得翻译」。`tests/suites/i18n.test.mjs` 的夹具原本就把 `sku`
写成 `text` 却在注释里说它跨语言共享——**规则抓出了这个自相矛盾的建模**。

反向验证：`node tests/tools/_i18n-field-inject.mjs`（6 场景，工具不进 `npm test`）。
清点剩余数据承载类：`node tests/tools/_i18n-data-inventory.mjs`。

> **`settings[]` 为什么不加语言维度**：`theme_settings` 键为 `(theme_name, key)`，
> 且**前台没有任何读取路径**（`grep` 过 `rendering/`、`runtime-*.ts`、`public/admin/`，
> 只有后台 `theme-settings` 屏读它）。它是**配置**不是内容。加一个没人读的字段，
> 正是本轮要消灭的「声明先于运行时」缺陷。**结论记录在案，字段不加。**

## 主题 / 插件清单（§5.3）

| # | 规则 |
|---|---|
| 14 | 声明的 `templates[]` 必须真的存在对应文件（`runtime: "worker"` 的主题豁免） |
| 15 | `routes[].resolve.table` 必须已在 `tables[]` 里声明 |
| 16 | `tables[].translatable` 里的 key 必须是该表声明过的字段 |
| 17 | 表的字段名不得与保留列冲突：`id`/`site_id`/`slug`/`lang_group`/`status`/`created_at`/`updated_at` |
| 18 | `runtime: "worker"` 的主题必须真的提供 `entry` 指向的文件 |
| 19 | `blocks[].name` 是**纯标识符、不带斜杠**（`property-card` ✅ / `theme/property-card` ❌）。`core/` 前缀是平台内置专用的 |
| 20 | 内联语言包 `langs{}`：locale 必须是合法代码、value 必须是字符串、key 必须带 `theme.{name}.` / `plugin.{name}.` / `core.` 前缀 |
| 21 | `routes[].template` 必须**在 `templates[]` 里**、且对应文件真的存在（`runtime: "worker"` 豁免）。渲染器按名字优先选中它 |
| 22 | `routes[].resolve` 必须**恰好**声明 `type` 或 `table` **之一**——两个都写抛错，一个都不写也抛错 |
| 23 | `routes[].resolve.by` 只能是 `"slug"` 或 `"id"` |
| 24 | `routes[].query.as` 必须是合法的**模板作用域名**（`SCOPE_NAME_RE` = `[A-Za-z_$][A-Za-z0-9_$]*`），**不能带连字符** |
| 25 | `locales[]` 里声明的每种语言**必须**有 `content/themes/<name>/langs/<code>.json`（反向不强制：可以有语言包而没声明） |

**理由**：清单是主题唯一能出错的地方，那就在这里出错。放行会变成渲染期的报错，
而那个报错会指向渲染器，不指向清单——排查成本高一个数量级。

**规则 20 为什么存在**：`uploadExtension` 把插件包当 zip 原样存进 R2、**从不解包**，
所以插件没有 `langs/` 目录可读，只能把语言包内联在清单里。主题有目录
（`content/themes/<name>/langs/<locale>.json`，运行时从 R2 读）。两条路径，同一套前缀规则。

**规则 21–24 的共同教训**：这四条对应的四个字段，曾经都是「**声明被校验了、但运行时没人读**」。
校验器认它、架构测试认它，前台却按 `kind` 猜模板、按 `postType` 猜内容，
于是**页面返回 200 而内容是错的**——最贵的一类 bug。判据是：
**一个字段被写进校验器还不够，必须找到它的消费点**；找不到就别加这个字段。

**规则 25 是同一个家族的最后一条，而且它是被一句注释暴露的**：`scripts/make-theme.mjs`
的清单里一直写着「Declares which languages this theme ships packs for. The architecture test
checks it against `langs/` so "declared but not shipped" fails loudly.」——**那个检查从来没存在过**。
`locales[]` 只被 `contract/validation.ts` 校验了 BCP-47 形状，`src/` 里**没有任何消费点**。
后果是：一个主题可以声明自己有中文版却没有 `langs/zh-CN.json`，于是模板里每一条
`{{default(theme.strings.x, "English literal")}}` 都渲染成英文——**"漏了翻译"和"根本没做翻译"
在页面上、在其余所有测试里都长得一模一样**。
教训与上一条同源但更尖锐：**写在注释里的规则不是规则**。注释说"架构测试会检查"，
读的人就不再检查了——这比没有注释更糟。守卫在 `themeManifestProblems()`
（`tests/fixtures/_extension-rules.mjs`），因此 `architecture`、`theme-default`、`theme-fixture`
与 `scaffold` 四个套件同时看得见它。

**规则 24 为什么不能用连字符**：`query.as` 会成为模板里的作用域变量名，而表达式分词器
按 `[A-Za-z_$][A-Za-z0-9_$]*` 切标识符。`my-list` 是合法 JS 属性名，但在模板里
`{{#each my-list}}` 会被解析成 `my` 减 `list`，而引擎**没有算术运算符**。
放行等于给出一个**谁都读不到**的绑定。

**校验失败必须抛出、必须让安装失败**，不能警告后继续。写法是 `validateManifest` 抛
`Error`，`src/api.ts` 的 `uploadExtension()` 捕获后返回 400。一个装不上的主题
胜过半个能跑的主题。规则 14–24 每一条都在 `tests/suites/manifest-validation.test.mjs` 里
有对应的"注入缺陷 → 断言必须抛错"用例；改校验逻辑时那道套件必须跟着改。

---

## 模板语言：写主题前必须知道的五条

**这五条都会让整页渲染抛错、或静默走错分支，而且没有编译期提示。**
`scripts/make-theme.mjs` 生成的骨架把这五条都演示了一遍，`tests/suites/scaffold.test.mjs`
用**真实引擎**把它们逐条钉住。

| # | 规则 | 写错的症状 |
|---|---|---|
| 1 | helper 用 `f(a, b)` **调用**：`{{len(posts)}}` ✅ / `{{len posts}}` ❌ | 抛 `Trailing tokens` → **整页降级成空白壳层** |
| 2 | **不支持 `../`**。`{{#each}}` 内部是 `Object.create(scope)`，父级变量**按名字直接可见** | 取到 `undefined`，静默 |
| 3 | `@first` / `@last` / `@index` 绑在**迭代作用域**，不在 item 上。裸写 `{{#if @first}}` | 分支**永不渲染**，静默 |
| 4 | **`{{/section}}` 是必须的**（见下） | 子模板的 section 被误判成 slot → 布局渲染空 `<main>`，**HTTP 200、无异常** |
| 5 | `@extends` 的插槽是 `{{@section "content"}}`，**不是** `{{@block}}` | 内容不出现，静默 |

helper 只有 9 个：`len` / `default` / `lower` / `upper` / `truncate` / `join` / `number` / `date` / `contains`
（外加指令 `@extends` / `@section` / `@include` / `@query`）。
支持 `{{#if}}`/`{{#unless}}`/`{{#each … as x}}`/`{{! 注释 }}`、`===`/`!==`/`&&`/`||`/`>`/`<`。
**没有算术运算符。**

### 规则 4 详解：为什么 `{{/section}}` 不能省

引擎要区分一个 `{{@section "x"}}` 是**定义**（子模板，有 body）还是**插槽**（布局，无 body）。
判据是**向后扫描有没有配对的 `{{/section}}`**。所以：

- 布局 `parts/layout.html` 里的 `{{@section "content"}}` **故意不闭合** —— 它是插槽。
- 子模板里**必须闭合**。不闭合时它被当成插槽，不进 `@sections`，布局渲染空内容。

这个猜测有一个**可以证明**的错法，所以引擎现在直接拒绝它：**一个 `@extends` 了的文件
是子模板，子模板永远不提供插槽**。于是"既 `@extends` 又有未闭合 section"不再是猜测，
而是**结构性错误**，`parseTemplate` 抛
`Template @extends "…" but leaves section(s) unclosed: …`。
判据是文件事实（`extendsName` 是解析结果），不是文本匹配——这正是本仓库反复强调的做法。

> 批次 4 的骨架**真的漏了这四个 `{{/section}}`**，`tests/suites/scaffold.test.mjs` 才发现的。
> 症状就是上面那行：200、无异常、空白页。**只有真正渲染一遍才会暴露。**

---

## 后台 SPA（`public/admin/`）

后台是**零构建**的原生 ESM，分层顺序是
`admin.css`（令牌→组件）→ `icons.js` → `ui.js` → `admin.js` → `js/**`。

```
admin.js               入口：只做装配与 window.* 注册（< 120 行）
js/state.js            共享 state + API 帮手（叶子模块，不 import 任何东西）
js/nav.js              导航模型 / 侧栏 / header（纯 markup 构造）
js/shell.js            render 循环 + 页面骨架 + 导航动作 + 屏幕注册表
js/auth.js             登录屏 / 登录 / 登出
js/table-form.js       ★ 字段类型 → 控件 的唯一映射 + 值往返（date/datetime 转换）
js/screens/index.js    页名 → 屏幕 注册表（唯一 import 全部屏幕的模块）
js/screens/<name>.js   一屏一模块
```

| # | 规则 |
|---|---|
| 21 | `js/shell.js` **不得 import 任何屏幕**（屏幕经 `setScreenTable()` 自注册），否则立即成环 |
| 22 | 屏幕之间**不得互相 import**；共用逻辑抽独立模块（如 `extension-install.js`） |
| 23 | 每个被 markup 调用的处理器**必须登记进入口的 `WINDOW_HANDLERS`** |
| 24 | 不得引入打包器；不得删 `index.html` `<head>` 里的绘制前主题脚本 |

**理由（规则 21–22）**：屏幕要调 `render()`，`render()` 要调屏幕——直接互相
import 就是环。环在部分浏览器能跑、部分不能，且让"改一个屏幕"重新变成
"必须理解全部屏幕"。自注册把这条边反转成单向。

**理由（规则 23）**：markup 用内联 `onclick="name(...)"`，浏览器把它解析在
`window` 上、**不在模块作用域**。少登记一个**不会有任何报错**——
不编译、不报 console、不发失败请求，按钮就是点了没反应。这是最贵的一类回归。

> 新代码优先用 `data-action` + document 级委托，这样根本不产生新的
> `WINDOW_HANDLERS` 条目（`screens/languages.js` 就是这么做的）。

规则 21–24 由 `tests/suites/admin-spa.test.mjs` 强制（模块图无环 + 无孤儿模块 +
`window.*` 契约 + 每个屏幕真渲染一次）。**改后台结构时那道套件必须跟着改。**

> ⚠️ 该套件有一处**已修过的假绿**：它最初断言"`render()` 没有抛错"，
> 而 `render()` 自己 catch 住屏幕异常并换成 "Something went wrong" 面板，
> 于是注入一个未定义标识符后测试依然全绿。现在断言的是**写进 DOM 的内容**
> （非空、不含错误面板）。**别把它改回"断言没抛错"。**

---

## 后台屏幕与 payload 契约（规则 68）

| 规则 | 说明 |
|---|---|
| 68a | 屏幕必须从**服务端实际放置的层级**读字段。`GET extensions/themes` 的按站点占用表 `active_by_site` 在**响应根**上，**不在每个 item 上** |
| 68b | 屏幕**不得提供一个只有"被拒绝"这一种可能结果的按钮**。端点知道的事实（如"这个主题随产品分发、卸载必 400"）必须随 payload 下发 |

**为什么（68a）**：读错层级的字段**恒为 `undefined`**，而 `undefined` 不报错、不抛异常、
不产生失败的请求。主题屏原来读 `x.active_by_site`，于是 `others` 恒为 `[]`：
每个**不在本站激活**的主题卡片都写着"未使用"，卸载按钮的 `data-theme-del-sites` 恒为空，
那句"仍被以下站点激活：X，请先在那里停用"的**预防性对话框永远不可达** ——
运营者点下去只会拿到端点的 409 `still active on: acct`，
而屏幕上**刚刚**告诉他这个主题没人在用。**payload 一直带着这个事实，是消费方找错了地方。**

**为什么（68b）**：捆绑主题的卡片原本带一个"卸载"按钮，而卸载端点对捆绑主题**只会**回
400（"ships with the product"）。**一个只有唯一可能结果（被拒）的按钮不是功能，是错误制造机**：
运营者唯一的反馈就是那条报错。端点在同一个响应里下发 `bundled`，屏幕改成一句说明。
（这条是用户拿 `journal` 报出来的；`journal` 已随后从产品移除，规则本身不变。）

守卫：`admin-spa.test.mjs`（**用真实 payload 形状渲染屏幕**，断言卡片点名站点 +
按钮带着站点 + 捆绑主题没有卸载按钮）；`admin-contract.test.mjs`（payload 的 `bundled`
必须与端点的拒绝**逐条一致**——一个事实两个读者，断言它们一致，而不是各自看起来合理）。
注入场景在 `_skeleton-inject.mjs`（2 个）。

> ⚠️ **守卫必须能看见缺陷**：捆绑标记那一条第一次把断言钉在 `admin-spa` 上，注入
> 删掉端点字段后**没红**——SPA 套件用的是**它自己造的 payload**，看不见端点的改动。
> **改端点的缺陷要由"真的调端点"的套件来观察**（`admin-contract`）。注入工具把这种情况
> 报成 `scenario INVALID`，这是它在干活，不是它在捣乱。

---

## 主题自有表（§6.3）

| # | 规则 |
|---|---|
| 25 | 表名**只由平台拼**（`theme_{theme}_{table}`）。主题清单里写逻辑名（`product`），**不得出现物理表名** |
| 26 | `{table}_i18n` **只在站点服务 ≥2 种语言时创建**；语言被停用后**永不清回、永不 drop** |
| 27 | 主表字段用 `ALTER TABLE ADD COLUMN` 增量补，**从不删列** |
| 28 | `theme_table_defs` 记录 `逻辑名 → 物理表名` 映射，**切主题时不清**（清了数据就没入口了） |
| 29 | 主题只能读**自己**声明过的表：`resolveThemeTable()` 按 `theme_name` 过滤 |

**理由（规则 26）**：把 `_i18n` 表当成"多语言才有的东西"，好处是「我们不做多语言」
变成**数据库里可验证的事实**，而不是代码里的承诺。反过来，语言停用时删表就是
WordPress 那个坑——用户关掉一个语言，翻译就没了。**只隐藏，不删除。**

**理由（规则 28）**：物理表名如果每次都从清单现推，那么主题一旦停用、清单没了，
那些数据就永远找不到入口。所以映射要记在平台自己的表里。

> 单语言站点上，可翻译字段**仍然存在主表上**——否则单语言站连产品名都存不了。
> 主表那一列同时充当**默认语言的值**，所以启用第二种语言**不需要数据迁移**。

---

## 一条反复踩到的坑：同一意图的两种写法

本仓库已经**三次**因为"同一个概念有两处表达"而出现假绿或静默错误：

| 概念 | 写法 A | 写法 B | 后果 |
|---|---|---|---|
| 默认站点 | `siteId = "default"` | `siteId = DEFAULT_SITE_ID` | 守卫只匹配 A，6 处漏网 |
| 跨层依赖 | `spec.includes("/extensions/plugin/")` | `"../plugin/runtime"` | 守卫从不触发 |
| 翻译组 | JS `lang_group ?? id` | SQL `lang_group = ?` | 组里丢了组名所指的那一行，编辑器诱导建重复内容 |

**规则（30）**：凡是一个概念需要在两处表达（JS ↔ SQL、字符串 ↔ 常量、路径 ↔ 正则），
**让两处共用同一个定义**，不要各写一份"看起来等价"的版本。`src/api.ts` 的
`GROUP_SQL` + `groupOf()` 就是范例：SQL 片段是常量，JS 函数在它旁边，
注释里写明两者必须同步。

**规则（31）**：新增守卫后，**必须注入一次违规确认它会红**。已经发生过两次
「检查存在但从不触发」——**守不住东西的守卫比没有守卫更糟，因为它是被信任的**。

---

## 后台菜单注册表与生成式屏幕（§3.5 / §4.4 / §6.1）

| # | 规则 |
|---|---|
| 32 | 后台菜单**只有一个来源**：`admin_menu_registry`。`theme_admin_menus` 已退役——`src/` 与 0012 之后的迁移**不得再引用它**（架构测试会扫，比对前剥注释） |
| 33 | 菜单必须带**归属**：`owner_type` + `owner_name`。「停用插件只消失它自己的菜单」是这个 `WHERE` 子句的直接结果，**不是特例逻辑** |
| 34 | 主题菜单**按站点**（主题是按站点激活的）；插件菜单**只写一次 `site_id = '*'`**，读时匹配 `site_id = ? OR site_id = '*'` |
| 35 | 后台页名用**三个前缀**：`table:<t>`（列表）/ `table-new:<t>`（新建）/ `table-edit:<t>:<slug>`（编辑）。**不得合并成一个带可选后缀的前缀** |
| 36 | `table-list` / `table-edit` 的列表列与表单控件**必须由 `tables[].fields[]` 生成**；主题不得手写后台表单 |
| 37 | 插件清单**不得声明 `tables[]`**（校验器直接拒绝，不是忽略），也**不得使用 `table-list` / `table-edit`** screen |
| 38 | 菜单显示分**两层**：① **站点级定制**（改名/排序/跨组移动/对所有人隐藏）存 `settings` 的 `admin.menu.custom`（每站一份 JSON），PUT/DELETE 需 `settings.manage`，GET 任何登录用户可读；② **每用户隐藏**存 `site_users.menu_prefs`（UI 层）。两者都**只影响侧边栏渲染**——capability 过滤仍在各端点，藏菜单不授/撤任何权限。`dashboard` 永远显示（逃生门） |
| 39 | 站点菜单定制的**唯一应用点是 `nav.js` 的 `applyMenuCustom()`**（纯函数；侧栏与编辑器共用，别写第二份应用逻辑）。改名覆盖叠加在服务端 label_key 翻译**之上**（解析：override[locale] → override.en → 内置文案）；排序是**稳定排序**（显式 order 升序在前，未排序的按内置顺序殿后）；**移动到不存在的分组=忽略**（项留在原地，绝不丢弃）；结构性变更（排序/移动）必须**物化整组显式 order**，否则隐式/显式混排没法读。标签输入**change（失焦）即保存**，Enter 提交——`fill()` 类工具只派发 `input` 不派发 `change`，自动化测试 fill 后必须 blur |
| 40 | 后台**界面语言列表是数据驱动的**，宇宙 = 内置核心包（`CORE_PACKS`，保证完整）∪ 平台语言字典 enabled 项（`locales`）∪ 覆盖层出现过的 locale（`i18n_overrides`）。**唯一定义是 `packs.ts` 的 `availableUiLocaleEntries()`**：它既生成切换列表（`i18n/messages` 的 `ui_locales`），也投影成 `ui-locale` 的校验集（`availableUiLocales`）——切换器提供的与服务器接受的永远不会不一致。**加语言在 Languages 屏完成，零代码**；没有翻译的 key 由 SPA `t()` 的英文 fallback 兜底，翻译通过覆盖层补。内置包的名字在 `CORE_PACK_NAMES`（与 `CORE_PACKS` 同文件相邻）。客户端只从 `ui_locales` 派生（`i18n.js setUiLanguages()`，en 恒第一），**不得在任何一侧硬编码语言清单**。菜单 label 语言数上限 `LABEL_MAX_LOCALES`(8)。**站点语言的可选项同样不能只靠 `locales` 表**：`i18n/locales` 响应必须带 `core_entries`（`CORE_PACK_LOCALES` 的行视图），Languages 屏要并上它——否则全新安装只种了 `en` 一行，那个面板恒空、只能把 `zh-CN` 手打进去（`core_locales` 曾长期无人消费 = 声明先于运行时） |

**理由（规则 34）**：插件只有一个**安装级** `enabled` 标志，主题是**按站点**激活的。
所以插件菜单写一次 `site_id='*'`、读时用 `OR` 匹配；按站点扇出会需要"新建站点时补菜单"
的钩子，而那个钩子**目前不存在**——少了它，新建的站点会静默地没有任何插件菜单，
而且没有任何报错。用一个 `OR` 换掉一个不存在的钩子，是这笔交易里唯一划算的一侧。

**理由（规则 35）**：这一条是**真实浏览器验收**抓出来的产品缺陷。页名曾经是
`table:<t>[:<slug>]`，"列表"和"新建"因此是**同一个页名**：点 Add 时路由判断"我已经在
这个页面上了"→ 不重渲染 → **按钮看起来完全没反应**（无报错、无失败请求）。
单元测试看不见它，因为两边的 DOM 都能单独渲染出来。

**理由（规则 32–33）**：注册表把"谁声明的"变成数据，而不是调用顺序。合并前，
主题菜单和插件菜单是两张表、两套读取路径，"插件也能注册菜单"要靠特例代码实现；
合并后它只是 `owner_type` 的一个取值。

**反向验证要求**：规则 33 的用例必须包含**同类型的两个 owner**。只拿"主题 owner vs
插件 owner"对比是**假绿**——删掉 `owner_name` 依然通过（见上「反向验证本身也会假绿」）。

---

## 插件系统三支柱（§4）

插件**不能携带可执行代码**（Workers 禁 `eval` / `new Function` / 动态 import 用户代码）。
所以插件只声明**意图**（数据），宿主负责**实现**——同一个依赖倒置模式用了三次：

| 声明 | 宿主生成 |
|---|---|
| `tables[].fields[]` | CRUD 表单与列表（`table-list` / `table-edit`） |
| `channels[].configSchema[]` | 渠道设置表单（`renderChannelConfig`） |
| `adminPages[].blocks[]` | **整个后台页面**（`renderPluginPage`） |

| # | 规则 |
|---|---|
| 48 | 插件 manifest **不得含可执行代码**。`hooks` 是**名字**（`DECLARABLE_HOOKS` 的子集），实现永远在宿主的 `HOOK_IMPLS` 里——校验器拒绝任何越界的 hook 名 |
| 49 | `adminPages[].blocks[].type` 是**闭集合**（`ALLOWED_PAGE_BLOCKS = [table, stats, form]`）。每加一种类型必须同时改三处：契约列表、`public/admin/js/plugin-page.js` 的 `RENDERED_BLOCK_TYPES`、渲染器 switch——**架构测试按集合比对**，漏一处是 FAIL 而不是 200 的空面板。`stats` 的 `aggregate` 同样是闭集合（`ALLOWED_AGGREGATES`），且 `sum` 必须给 `field` |
| 50 | 菜单 `screen: "plugin-page:<id>"` **必须指向该插件真实声明的 `adminPages[].id`**（安装期校验，`validateAdminMenus` 的第 5 参 `declaredPages`）。运行期由 SPA 的 `findPage` 按 `enabled` 过滤——"禁用"意味着页面不可达，不是页面被删 |
| 51 | 渠道 `code` ∈ `HOST_CHANNEL_CODES`（当前只有 `webhook`）；`configSchema[].type` ∈ `ALLOWED_CHANNEL_FIELD_TYPES`。两侧都由 `tests/suites/architecture.test.mjs` 与 SPA 导出的 `RENDERED_CHANNEL_FIELD_TYPES` / `RENDERED_AGGREGATES` **双向核对**——声明了却没人实现正是这条要抓的分歧 |

**为什么是"导出列表对比"而不是"解析 switch"**：守卫解析源码文本（正则扫 `case "table":`）
是**猜结构**，写同一意图的另一种写法就能骗过它——这正是「同一意图的两种写法」那条坑。
渲染器 `export`s 一份列表、架构测试把它与契约列表按**集合**比对，是**被告知结构**。

**规则 3 的落地（插件声明自有表）**：`plugin/` **不能** import `theme/`。
`registerPluginTables` 只声明一个 `PluginTableSync` 接口，DDL 生成实现
（`syncOwnerTables`）由 `index.ts` 在 boot 时用 `setPluginTableSync(...)` 注入——
与 `setHostHooks` / `setPackProviders` 是同一个模式。插件表**按站点扇出**
（`theme_table_defs` 按 `site_id` 键控），插件菜单**写一次 `ALL_SITES`**。

**加字段前先找它的消费点**：本仓库「声明了但没人读」的缺陷族已出现**七次**
（200 + 内容错：插件 `adminMenus`、死掉的 `DECLARABLE_HOOKS`、`routes[].resolve.table`
与 `routes[].template`、插件列表 API 把数组存成 JSON 字符串、渲染器读错字段路径、
`tableAggregate` 忽略 `status`）。**一个新字段如果找不到运行时消费点，就不要加。**

**观测面铁律（批次 10 实测）**：渲染器读错 `data.def.fields` 的缺陷，
在**服务端断言里根本不可见**——注入后 `admin-spa`（只查模块图）与 `plugin-pages`
（只查 API/DB）双双全绿，直到给 `plugin-pages` 加了**一条把响应渲染成 HTML 再读回来**
的断言（§9）。**一条守卫只能证它观测的那一层**；"测试全绿"不等于"这个缺陷有人看着"。

---

## 允许做的事

- ✅ 加新的 `screen` 类型（同时更新 `ALLOWED_ADMIN_SCREENS`、`docs/ARCHITECTURE.md` §3.5，
  以及 `tests/suites/architecture.test.mjs` 里**钉住**的那个集合——三者必须一致）
- ✅ 加新的 capability（同时更新 `CAPABILITIES` 与 §4.3）
- ✅ 加新的 `DECLARABLE_HOOKS`（同时更新 §4.2）
- ✅ 加新的后台菜单 screen 实现（`public/admin/js/screens/`，须在 `screens/index.js` 注册）
- ✅ 重构实现，只要不跨越上面的规则

## 明确不做的事

- ❌ 往 `platform/` 里 import 某个具体主题
- ❌ 在主题里写 `env.DB.prepare(…)`
- ❌ 让 `extensions/theme/` import `extensions/plugin/`（走 `contract/hooks.ts`）
- ❌ 给数据访问函数补一个"方便的" `siteId = "default"` 默认值（**常量形式也不行**）
- ❌ 在主题/插件里自己写鉴权（`jwt.verify` / 检查 `role`）
- ❌ 手写后台表单（应由 `fields[]` 声明生成）
- ❌ 主题切换时删除业务数据（只隐藏，不删除）
- ❌ 语言停用时 drop `{table}_i18n` 表（翻译要留住）
- ❌ 在 `src/` 或新迁移里引用已退役的 `theme_admin_menus`（唯一来源是 `admin_menu_registry`）
- ❌ 把后台"新建"与"列表"合并成同一个页名（会让 Add 静默失效）
- ❌ 让插件声明 `tables[]` 或使用 `table-list` / `table-edit`（属批次 4）
- ❌ 新增架构规则却不做反向验证（测不出失败的检查不是检查）
- ❌ 把一个概念在 JS 和 SQL 里各写一遍（共用定义，见规则 30）

---

## 已知的、有意保留的偏离

| 事项 | 现状 | 原因 |
|---|---|---|
| 后台 SPA 的目录位置 | 模块结构已按 §7.2 拆好，但仍在 `public/admin/` 而非仓库根的 `admin/` | `wrangler.jsonc` 的 `assets.directory` 只接受一个目录，而 `/admin/*` 必须保留；搬迁需与 `public/` 的资源归属一并规划 |
| `public/admin/ui.js` | 仍是 303 行单文件（UI kit 未再细分） | 与屏幕拆分正交；真要拆应等后台多语言（L2）落地时一起做 |
| `theme-previews/` 仍在仓库根 | 被 `.gitignore` 排除的截图产物目录 | 是验收工具的**输出**，不是源码；位置随工具走，不入结构规划 |

这些**不是"可以随意违反规则"的许可证**——它们是**已登记的技术债**，
每一项都有明确的归属批次。新增类似问题时，登记到这里，不要静默放行。
