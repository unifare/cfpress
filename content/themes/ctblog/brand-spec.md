# Brand spec — 「手记」独立开发技术博客

**方向**：以 **innei.in** 的版式与动效为主（衬线阅读、hover 才亮起的强调色、鼠标跟随背景特效），以 **cali.so** 的个人主页结构为形（双语自我介绍 + 旋转星环 + 数字编号小节 + 单列个人页脚）——彻底去掉公司味。配色：**高反差 —— 纯黑 `#0a0a0a` + 霓虹黄 `#ffd60a` 招牌（默认深色）**，炽橙白点缀；浅主题白底黑字配深黄灼橙。

**一句话**：innei 的版式骨架，换上一副冷色调的皮 —— 白得像文档，蓝得像终端。

## Tokens（OKLch）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--bg` | `oklch(100% 0 0)` `#ffffff` | `oklch(14.5% 0 0)` `#0a0a0a` | 白底 / 纯黑（默认深色） |
| `--surface` | `oklch(96.7% 0.001 286)` `#f4f4f5` | `oklch(20.0% 0 0)` `#161616` | 卡片 / 代码块 |
| `--fg` | `oklch(23% 0.020 260)` | `oklch(95% 0.010 250)` | 正文墨色（冷黑 slate） |
| `--muted` | `oklch(52% 0.018 258)` | `oklch(72% 0.015 255)` | 次要文字 |
| `--faint` | `oklch(58% 0.016 255)` | `oklch(62% 0.014 255)` | 元信息 / 日期 |
| `--border` | `oklch(88.7% 0.007 286)` `#d9d9de` | `oklch(30.1% 0 0)` `#2e2e2e` | hairline 分隔 |
| `--accent` | `oklch(54.8% 0.112 90)` 深黄 `#8a6d00` | `oklch(88.5% 0.181 95)` `#ffd60a` | 主强调 / CTA |
| `--accent-2` | `oklch(55.3% 0.174 38)` 灼橙 `#c2410c` | `oklch(70.5% 0.193 39)` `#ff6b35` | 辅助 / 数字 |
| `--accent-3` | `oklch(21.0% 0.006 286)` 墨黑 `#18181b` | `oklch(100% 0 0)` 纯白 `#ffffff` | 点缀（封面/粒子反白） |
| `--on-accent` | `oklch(100% 0 0)` 白 | `oklch(14.5% 0 0)` | 黄底黑字（浅 4.92:1 / 深 ~15:1） |

派生：`--accent-soft`、`--accent-2-soft`、`--highlight`（马克笔冷蓝）、`--shadow-accent`（冷蓝辉光）。

语义色（冷调）：success `oklch(58% 0.13 158)`／warn `oklch(64% 0.14 72)`／danger `oklch(56% 0.19 20)`。

## 字体栈

- Display / 正文（衬线，沿用 innei）：`"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif`
- UI / 导航（无衬线）：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- Mono（标签 / 日期 / 代码）：`"JetBrains Mono", "Cascadia Code", ui-monospace, monospace`

## 姿态规则

1. **淡绿纸底**：`--bg` `#e7f4ec`（浅主题），深主题为深绿黑 `#0b1410`。
2. **中性色统一冷灰**：`fg / muted / faint / border` 色相全部落在 250–260，版面整体降温。
3. **强调色克制**：`.nav a`、`.post-item` 的强调色只在 `hover` 亮起（innei 式）；常驻彩色只保留在 CTA、统计数字、进度条。
4. **两条冷色分工**：电光蓝管「交互与强调」，冷青管「数据与数字」；进度条用纯蓝并带冷辉光（不做蓝→青渐变）。
5. **酷感细节**：hero 右侧细网格底纹（`.grid-bg`，冷灰线 + 遮罩渐隐）、首页信息流加 innei 式竖向时间轴（`.post-list.timeline`）、跑马灯、缓动抬升 hover；全部尊重 `prefers-reduced-motion`。
6. 正文 `max-width: 68ch` / 行高 1.85；容器加宽到 1200px 贴近 innei 的宽版式；全大写标签正字距 `0.1em`。

## 图标

- **线性描边图标**（沿用 innei 语汇）：`stroke="currentColor"`、`stroke-width: 1.7`、`fill: none`、圆头圆角（`stroke-linecap/linejoin: round`）、`viewBox 0 0 24 24`。
- 尺寸：社交图标 18px / 按钮内 16–18px；颜色继承 `currentColor`，只在 `hover` 转 `--accent`。
- 位置：footer 社交行（GitHub / X / Telegram / 邮箱 / RSS）、主题切换、导航与箭头。全部内联 SVG，不引第三方图标库。
- 状态点 `.status-dot`：7px 实心 success 圆点 + `::after` 脉冲圈（`dot-pulse` 2.4s），用于 hero「正在做」与 footer「在线」。

## 动效

- `enter`：内容入场（opacity + `translateY(16px)` + `blur(6px)` → 0），缓动 `cubic-bezier(.2,.75,.2,1)`。
- `.reveal` / `.reveal.in`：滚动淡入上移（`IntersectionObserver` 触发，子项按 60ms 交错，上限 360ms）。
- `lamp`：主题切换时图标旋转 + 缩放 + 淡入（0.42s）。
- `dot-pulse`：状态点呼吸圈。
- `#bg-fx` 鼠标特效（innei 式）：全屏 fixed canvas，~24–90 粒冷蓝/冷青微粒缓慢漂移 + 靠近连线，鼠标位置有 280px 光晕跟随（lerp 0.06），微粒在 160px 内被轻轻推开；页脚 `背景特效 · 开/关` 按钮可切换（localStorage `od-fx`），默认开（触屏 / `prefers-reduced-motion` 下默认关），切标签页自动暂停。
- 全部动效包在 `prefers-reduced-motion` 兜底内：reduced 时 `.reveal` 直接可见、入场动画不播放。

## 个性层（花哨但收敛：冷色内只玩质感）

- `.shimmer`：电光蓝→冷青流动微光字（6s 循环），只用在 hero 关键词一处。
- `.caret`：终端光标块，`blink` 1.2s（innei 式），只跟在 hero 自我介绍后。
- `.rail` / `.rail-card`：横滑栏（cali.so 式循环播放 / 书架），CSS 纯色 + 圆点纹理封面（4 种冷调轮换，全部由 token 派生），hover 上浮 + 微旋转；封面大字为衬线首字。
- 标题下划线：文章标题 hover 时 1.5px 下划线从左滑出。
- `#cursor-ring`：26px 鼠标圆环（lerp 0.16 跟随），悬停链接时放大到 42px 并转辅色；由 JS 动态创建，随背景特效开关，触屏 / reduced-motion 下不存在。（聚光灯压暗层已撤除。）
- 页脚盲文 `⠎⠓⠕⠥⠚⠊`（shouji 装饰，aria-hidden），后跟十字架 `✝`（`.cross`，随强调色）。

## 信仰元素（基督教，克制出现）

- 星环中心为拉丁十字架几何形（取代四角星），随强调色，hover 旋转。
- 关于页末尾「信仰」一节：马太福音 5:16，与站内"光"的动效语言呼应。
- 不做大幅宗教视觉、不改内容基调，只作个人印记。

## 去公司味规则（cali.so 式个人主页）
1. 首页是「人」不是「产品」：双语自我介绍 `.hello` + 右侧旋转星环 `.orbit`（不对称布局 `.me-top`）+ 窄栏 `.narrow`（780px）；hero 不再放"手"头像（和导航 logo 重复）。
2. 页头破工整：导航自动编号 `01–04`（CSS counter，不占 HTML）、logo 是斜 -6° 钴蓝印章（白字 + 内圈线，hover 回正）。
2. 小节用数字编号 `.sec-head`（01 写作 / 02 此刻 / 03 联系），中英双语标题。
3. 禁用：数据指标条、营销跑马灯、大置顶卡片、多栏链接页脚、导航当前项下划线条、图标按钮 hover 加边框（会抖动）。
4. 页脚单列：头像行 `.me-foot` + `联系 contact` / `索引 index` 文本行 `.foot-links` + 底栏（© / UTC+8 时钟 / 特效开关 / 参考 cali.so / innei.in）。
