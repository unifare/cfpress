# MEDIA-STORAGE — 第三方图床（imgbb / postimages.org）

本站点的新上传文件可以不进本安装的 R2 存储桶，改由免费图床托管：
CFPress 保留注册行（租户、归属、alt、策略门），字节由图床 serve。

> 注：需求原文写的是 "compostimages.org"，该域名不存在；此处实现的是
> **postimages.org**（postimg）。若另有所指，加一个 provider 即可，见
> §5。

## 1. 三个存储位置

| provider | 字节在哪 | 密钥在哪填 |
|---|---|---|
| `r2`（默认） | 本安装 R2（`env.MEDIA`） | 无需密钥 |
| `imgbb` | `https://i.ibb.co/…` | 媒体屏存储面板，或 `IMGBB_API_KEY` 环境变量 |
| `postimages` | `https://i.postimg.cc/…` | 媒体屏存储面板，或 `POSTIMAGES_API_KEY` 环境变量 |

选择是**分站点**的（`cfpress.media` → `provider`），密钥**优先用本站点的**
（媒体屏输入，存为 `cfpress.media.imgbb_key` /
`cfpress.media.postimages_key`），**环境变量做兜底**
（本地 `.dev.vars`，线上 `wrangler secret put`）。

密钥在读路径**永不回显**：`GET settings` 把 sensitive 值脱敏成 `""`，
空写保留原值——所以表单上看到的永远是占位符，随手点保存也不会删 key。
要清 key 直接删行（故意的：显式删除可审计，空字符串有歧义）。
**不要**把密钥写进 `wrangler.jsonc` 的 `vars`：那份文件要提交，且架构
测试会对“无开关认领的 var”变红。

## 2. 在后台切换（媒体屏 → 存储面板）

媒体库顶部有一块存储面板（三个选项卡 + 两家 key 输入框 + 保存按钮，
和库同一屏，选完即时生效——下一次上传就走新位置，无需 reload）：

- 三个选项：本服务器（R2）/ imgbb / postimages.org。R2 和两家放同一组，
  因为“留在这”本身也是一种选择；当前使用的卡片带高亮边框。
- 每家卡片下标着状态：在用，或服务器未配置密钥。
- key 输入框是 password 型：已保存显示占位符（“已保存——留空保持不变”），
  未保存显示“在此粘贴 API 密钥”。只提交非空输入，空着保存不会删 key。
- 保存需要 `settings.manage`（和其它站点设置同一扇门）；改完面板重读，
  显示的就是生效中的状态。

切换只管**下一次**上传：库里已有的文件保持不动（它们的行写明了自己的
`storage`），所以切来切去不会 strand 任何东西。

## 3. 语义：行还是那一行，门还是那三扇门

- 内容里存的还是 `/media/<key>`（同一个 `mediaUrl()`），选择器、渲染器、
  编辑器**零改动**：读路径对远端行回 302 到图床，且发生在同样的
  tenant → session → owner 判定**之后**（规则 60b：策略模块仍是唯一裁决者）。
- 远端行的 key 形如 `uploads/{site}/remote/{provider}/…`：租户照样从 key
  上读出来，跨站 key 照样 404。
- 删除先问图床删（尽力而为，失败只记日志），再删本地行——行是我们的，
  坏了的远端不能否决本地删除。
- 302 只跳 `https://`：`remote_url` 列来自图床响应，开放重定向会把本站
  域名洗成任意 URL 跳板，所以非 https 目标一律 404。
- 图床字节**天然公开**（拿到直链谁都能取，和任何公共图床一样）。要的是
  “不可列举、不可管理”，隔离面仍在：列表/改/删全按 `site_id` + owner 来，
  无成员者连行都看不见。

## 4. postimages 的诚实说明

postimages 没有官方上传文档。本实现用的是账号 key 接口
（`https://api.postimage.org/1/upload`，已实测：无 key 回
`<error>Invalid API Key</error>`），multipart 字段 `key` + `file` +
`numfiles`，XML 回包做容忍解析（`direct` / `image` / `url` / `thumb`
按序取第一个 https 直链）。

**网站端上传流（`POST /json`）被官方明令封禁自动化**
（实测回 403："Automated uploads are not allowed via the website"），所以
故意不实现：今天能用的抓包，明天就是周一早上的故障。若官方改回包形状，
容忍解析尽量兜住，兜不住就报 502（带图床原文），绝不写无字节的行。

## 4b. imgbb 的 103（forbidden to use this website）

这是最常见的 imgbb 上传失败，**和 key 无关**：错 key 回的是 JSON
`Invalid API v1 key`，而 103 是 imgbb 边缘按**出口网络**拦自动化
（VPN、机房、共享出口易被 flag；有公开案例报某云厂商出口 IP 段被封，
换干净 IP 即好）。表现为同一 key、同一文件时成时败。

遇到时本实现的行为是固定的：400 系 verdict **不重试**（重试一个已被拒绝
的请求，除了再造一个没人记录删除 URL 的孤儿，什么也得不到）；429 / 5xx /
网络错只重试**一次**；所有请求带浏览器 UA；最终失败回 502，message 直接
说换个没被 flag 的网络或切回 R2，并在 Workers Logs 记一行（看的是模式：
全是 103，还是 429/超时混着来）。

## 5. 再加一家图床

1. 在 `src/platform/media-hosts.ts` 加 `uploadToX()`（字节进、直链出，
   失败抛带厂商原文的错）；
2. `MediaStorageProvider` 联合类型 + `KNOWN_PROVIDERS` 加名；
3. `mediaUpload` 的分支、`mediaDelete` 的远端分支 natural 跟上；
4. `tests/suites/media-hosts.test.mjs` 加“成功映射 / 失败无行”两组断言，
   并在 `tests/tools/_media-inject.mjs` 补一个反向场景；
5. 媒体屏面板加一张卡片 + 中英各一串词（`core.media.storage*`）。

## 6. 相关测试

```bash
node tests/suites/media-hosts.test.mjs   # 本功能：78 条
node tests/suites/media.test.mjs         # R2 路径不受影响：71 条
node tests/tools/_media-inject.mjs       # 9 场景含新增的两条
```

密钥只在媒体屏输入框（写进 site settings，读永脱敏）/ 本地 `.dev.vars` /
线上 secret 里出现；任何测试都不需要真 key（厂商一侧全用桩）。

## 7. 部署到没有 R2 的账户（`--no-r2`）

R2 在代码里是可选绑定（`MEDIA?`）：读不到就 404，写（媒体 R2 分支、
扩展包上传）就 400 点名，主题/语言包走自带 assets  fallback，远端
图床全程不碰 R2。所以没开 R2 订阅的账户也能部署——只要配一个不含
`r2_buckets` 的配置文件（wrangler 会在部署时校验 binding，声明了不
存在的桶就直接失败）：

```bash
node scripts/make-local-config.mjs --no-r2 --out wrangler.demo.jsonc
npx wrangler deploy --name cfpress-demo -c wrangler.demo.jsonc
```

`wrangler.demo.jsonc` 是 gitignore 的生成物（和 `wrangler.local.jsonc`
一样），`_config-parity.mjs` 在它存在时校验，不存在时报 n/a。
注意它和 `wrangler.ids.json` 当前指向的 D1/KV 配套使用；切账户部署
时先换 ids（备份好原文件），部署完换回来。
