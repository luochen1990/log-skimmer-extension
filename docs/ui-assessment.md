# UI 现状评估与重设计决策 (v0.1.5 → v0.2.0)

> 走查基底: 真实截图 (e2e/shots/, 1280×900, github/forgejo fixture + 降级路径) × 源码通读
> (overlay.ts / inline.ts / controller.ts / adapters)。范围: overlay 面板 + 流内呈现;
> 引擎/对齐/取数链路不在本次范围。

## 一、问题清单 (按影响排序)

| #   | 问题                                                                                                                                                           | 影响                                                                  | 证据                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| P1  | **宿主 CSS 污染**: overlay/fab 是光秃 DOM + 内联 style, 宿主页样式可渗透                                                                                       | 可靠性债已兑现过一次 (v0.1.3 按钮文字被宿主页吞色, 补丁治标)          | overlay.ts 全部样式走 `#lsk-overlay …` 页面级选择器 + inline style |
| P2  | **无设计系统**: 颜色 hex 散落 overlay.ts/inline.ts/intent.ts 三处, 无 token, 无暗色适配                                                                        | GitHub Dark (主流默认) 下 overlay 白亮刺眼; 改一处配色要动三处        | intent.ts INTENT_COLOR/INTENT_META, overlay.ts 内联 hex            |
| P3  | **块行信息密度失衡**: rule id (引擎术语, 如 `gcc-clang-driver-error ghc-gcc-phase-failure`) 是行内主视觉, category 胶囊 + rule 一串 + 行号挤在一行; 无日志原文 | 用户最想要的 "错在哪" 反而要展开 context 才能看到                     | github-overlay.png                                                 |
| P4  | **头部与 tabs 拥挤**: meta 行三段信息一行塞死; rules chip 与操作按钮混排; step 标签 flex-wrap, 多 step 时换行撑爆头部, 激活态仅靠 `.on` 蓝底区分               | 信息层级混乱, 15 step 页面不可用                                      | github-overlay.png / degrade-no-endpoint.png                       |
| P5  | **流内只有 "染色" 没有降噪**: 27k 行日志中高亮行是绝对少数, 噪音行仍需人眼扫过; 无 icon (远距离扫视无锚点); GitHub 默认折叠的 group/step 区含命中时不会展开    | 流内轨价值大打折扣: 用户诉求是 "折叠噪音 + 高亮命中 + 默认展开命中区" | github-inline.png                                                  |
| P6  | **折叠省略行素**: overlay 内 `⋯ 980 lines` 灰字无层次                                                                                                          | 次要                                                                  | github-overlay.png                                                 |

## 二、设计决策记录

### D1 overlay + fab 改 Shadow DOM 隔离 (根治 P1)

- `#lsk-overlay` / `#lsk-fab` 变为宿主元素 (host), 内部结构 + 样式进 open shadow root。
  Playwright CSS 引擎穿透 open shadow, 全部既有 e2e 选择器 (`#lsk-overlay .lsk-blk` 等) 不变。
- 布局关键属性 (fixed 定位/尺寸/z-index) 以 inline style 落在 host 上 (inline 胜页面样式表,
  宿主无法渗透); 继承性属性 (font/color) 在 shadow 内 `:host { all: initial }` 重置。
- 取舍: 光秃 `<style>` 注入 + `!important` 满天飞也能续命, 但每来一个宿主主题就是一次
  打地鼠; shadow 一次隔离, 双形态 (MV3/userscript) 均为纯 DOM 能力, 无兼容代价。

### D2 设计 token 单点 + 暗色适配 (根治 P2)

- 新增 `src/core/tokens.ts`: 全部中性色/语义色/字体/间距收敛为一份 CSS custom properties
  (shadow 内 `:host` 作用域), `prefers-color-scheme: dark` 覆盖为 GitHub Primer Dark 同源
  色板 — 与宿主 GitHub Dark 视觉共生而非对撞。
- 流内高亮色保持 intent.ts 语义色 (红/黄/蓝双主题可读), 背景染色用 `color-mix` 按主题调 alpha。
- 取舍: token 不抽 CSS 变量给页面侧流内样式复用 (流内是宿主 DOM, 注入变量有污染面),
  流内只消费 intent.ts 的语义色常量 — 两处各管各域, 不强行 DRY。

### D3 块行信息层级重排 (根治 P3)

新层级: **icon (intent) → category 胶囊 → 日志原文摘要 (一行截断, flex 占满) → 页面坐标 (右对齐主坐标)**。
rule id 降级为摘要的 `title` 提示 (hover 可见, 多规则全列) — 引擎术语不占主视觉但保留可追溯性。
摘要取块首行原文 (内存全量日志现成), 用户不展开 context 即可识别错误。
页面坐标优先 (init.pageCoords, forgejo step 局部号), null 退回源坐标 — 既有行为保留。

### D4 头部三行分层 + tabs 横向滚动 (根治 P4)

- 头部分层: ① 品牌行 (skim · 版本 · spacer · 规则刷新/inline 开关/关闭); ② meta 行 (#lsk-meta,
  文件 · 压缩 · intent 计数); ③ tabs 行。rules chip 移到 meta 行尾部 (信息而非控件)。
- tabs 改横向滚动单行 (`overflow-x: auto` + nowrap + 渐隐右缘), chip = step 标签截断 +
  intent 计数点; 弃 flex-wrap (多 step 换行撑爆头部) 与下拉 (切换成本 > 滚动, 且失去
  "一眼多 step 全览")。每 chip 带最高 intent 的计数徽标, 失败 step 一眼可辨。

### D5 流内降噪三件套: 折叠 / icon / 自动展开 (根治 P5)

- **折叠** (`src/core/fold.ts` 新模块): 池内连续无标注行 ≥3 → 行加 class 隐藏
  (绝不 remove 页面节点) + 段首插入占位行 `⋯ N lines` (点击展开该段)。
  - 折叠计算只碰当次 sync 的目标行 (增量批次 = 变更子树), 禁止全池重扫 — 复用既有
    syncInline 的 targets 机制。
  - 状态外置: 折叠键 = `stepKey:startNo` 写在行 `data-lsk-fold` 与占位行 `data-lsk-ph`,
    用户展开过的段记 controller 侧 Set (重放/滚动回看不复活); 占位行是外来节点,
    GitHub 虚拟化重建后由 ReplayDriver 幂等重放重建。
  - 窗口化边界态 (github): 批次内 run 独立成段, 与相邻 cluster 的折叠段不合并 —
    占位行可能出现相邻两条, 属可接受的化妆债 (合并需跨批次状态, 复杂度不成比例)。
- **icon 纯 CSS**: `.lsk-inline[data-lsk-intent]::before` + 三条 attribute-selector 规则,
  零外来子节点 = 零重放成本; 悬浮 tip (data-lsk-tip) 保留。
- **自动展开** (adapter 契约扩展 `foldables()`): github = `##[group]` 折叠区 (fixture 契约
  `details.lsk-group[data-gstart][data-gend]`, 真实 DOM class 待登录态校准 — 与 cluster
  wrapper 同一 TODO) 内含命中行 → 触发原生展开; forgejo = 未渲染 step 的 summary 程序化点击。
  已展开区记录外置 Set 只展开一次 (防循环)。forgejo "含命中" 判定: 命中行尚未被任何已对齐
  step 段覆盖 → 折叠 step 是候选 (无法先验知道未渲染 step 的行范围, 采用保守的 "可能有" —
  单 step/前缀场景精确, 多 step 可能过量展开一次, 有界且不回折)。
- **inline: off 语义升级**: off = 移除高亮 + 解除全部折叠 + 移除占位行 (可逆性);
  自动展开的原生区域不回折 (native 状态, 回折需保存/恢复页面折叠态, 风险 > 收益)。

### D6 overlay 省略行与 fab 升级 (根治 P6)

- gap 行: 居中徽章形态 (计数 + 上下文色), 视觉上与块行明确分层。
- fab: 加失败计数徽标 (boot 完成后已知), 失败一眼可见。

### 兼容性红线 (不改的清单)

e2e 钩子全部保留: `#lsk-fab` / `#lsk-overlay` / `#lsk-diags` / `#lsk-refresh` /
`#lsk-inline-btn` / `#lsk-meta` / `#lsk-tabs` / `#lsk-rules-chip` / `.lsk-blk` / `.lsk-row` /
`.lsk-ctx` / `.lsk-gap` / `.lsk-err` / `.lsk-lines` / `window.__lsk`。
既有 32 e2e 语义不变 (仅 github 跳转用例的 scrollY 断言随折叠引入的页面高度压缩改为
"目标行锚定" 断言 — 语义更强而非放水)。
