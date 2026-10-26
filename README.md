# log-skimmer-web

> log-skimmer 生态的浏览器交付面: 一个 Tampermonkey userscript, 在 GitHub Actions / Forgejo
> 的 CI 失败日志页上做**行级失败高亮 + skim 摘要面板** — 万行日志只看有证据的那几十行。

[log-skimmer](https://github.com/luochen1990/log-skimmer) 引擎 (Rust) 编译为 wasm 内嵌于脚本,
在浏览器本地对全量日志执行 skim; 规则集从 rules 仓发布的 bundle 拉取并缓存。
**安装即完整离线** — wasm 引擎内嵌于脚本, 规则 bundle 是唯一网络依赖 (且缓存后离线可用)。

## 这是什么 / 为什么

CI 失败日志动辄上万行, 真正的失败证据往往只有几十行。log-skimmer 用规则集 (正则状态机)
把日志折叠为「failure / warning / info 证据块」。本仓把该能力带到你最常看日志的地方 —
浏览器里的 job 日志页:

- **流内高亮** — 命中行直接在原生日志流里加 intent 色边条 (虚拟化/懒加载/重渲染均自动重放);
- **skim 面板** — 悬浮摘要视图: 块列表 + 未匹配区折叠 (`⋯ N lines`), 点击跳转原生流内对应行;
- **降级而非失败** — 登录墙 / 403 / 规则拉取失败时, 面板给出「哪个环节 / 为什么 / 怎么办」,
  绝不破坏页面。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) (或其他支持 `GM_xmlhttpRequest`
   - `GM.*` storage 的脚本管理器);
2. 用 raw 链接安装本仓产物 `dist/log-skimmer.user.js`
   (从仓库下载后拖入 Tampermonkey, 或以 `@updateURL` 指向 raw 地址);
3. 打开任一 GitHub Actions job 页
   (`https://github.com/<owner>/<repo>/actions/runs/<run>/job/<job>`)
   或 Forgejo job 页 (`/<owner>/<repo>/actions/runs/<run>/jobs/<idx>`) —
   右下角出现 **skim** 按钮。

无脚本管理器也能跑 (storage 降级为 localStorage, 规则拉取受 CORS 限制可能失败) —
但推荐 Tampermonkey。

## 使用

| 操作             | 效果                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| 点击 `skim` 按钮 | 打开/关闭摘要面板                                                    |
| 点击面板中的块   | 展开/收起该块原文 context; 并跳转原生流内对应行 (跨虚拟化窗口也能跳) |
| `inline: on/off` | 流内高亮开关 (off 清除痕迹, 重放不注入; on 立即恢复)                 |
| `⟳ rules`        | 强制刷新规则 bundle 并重新 skim (失败则保留旧缓存继续工作)           |
| 面板头部 chip    | 规则数量与生成日期; 缓存超过 7 天变黄提示 stale                      |

首次运行会从 rules 仓拉取 bundle 并缓存 (GM storage); 之后离线可用, 手动刷新才更新。
高级: 在 GM storage 写 `lsk:bundleUrl` 可覆盖 bundle 端点 (调试/镜像用)。

## 架构概览

```
┌─ userscript (单文件, ~0.74 MiB) ────────────────────────────────┐
│ main.ts ─→ controller ─┬─ adapters (github / forgejo)  页面知识 │
│  (GM 门面)             ├─ core/engine ─→ wasm skim (内嵌)       │
│                        ├─ core/rules  ─→ bundle 拉取/缓存/协商  │
│                        ├─ overlay     ─→ 摘要面板 (主视图)       │
│                        └─ inline+observer ─→ 流内高亮 (幂等重放) │
└─────────────────────────────────────────────────────────────────┘
        唯一网络依赖: rules bundle (raw.githubusercontent.com, GM 跨域)
        日志数据: 页面同源端点 (GitHub data-log-url / Forgejo job API)
```

三条架构不变式 (继承自 spike T4, 详见 AGENTS.md):

1. **状态外置** — 标注状态存 `(source, line)` 外置表, 永不假设行 DOM 存活
   (GitHub 虚拟化 + step 展开即清空重建 + Turbo 导航三重丢失路径);
2. **幂等 sync** — 初始注入与 MutationObserver 重放共用同一 `syncInline()`,
   增量批次只扫 mutation 涉及的新节点;
3. **事件驱动重放** — 任何重建/懒加载/虚拟化窗口推进都收敛为 "sync 一遍"。

## 相关仓 (生态)

| 仓                                                                      | 角色               | 与本仓的契约                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [log-skimmer](https://github.com/luochen1990/log-skimmer)               | 引擎 (Rust) + spec | wasm ABI: `alloc`/`free`/`skim_json`, 4B 长度前缀 envelope                                                                                           |
| [log-skimmer-rules](https://github.com/luochen1990/log-skimmer-rules)   | 规则库 (社区维护)  | bundle: `{manifest: {format_version, min_engine_version, rule_count, generated_at}, rules: [{id, path, yaml}]}` @ `reports` 分支 `rules-bundle.json` |
| [log-skimmer-corpus](https://github.com/luochen1990/log-skimmer-corpus) | 语料库             | e2e fixture 的日志样本来源 (真实失败样本)                                                                                                            |

bundle 格式的 SSOT 在 rules 仓生成管线; 本仓只消费 (校验 + 版本协商)。

## 开发

```bash
nix develop        # node + just 工具链 (或自备 node ≥ 24)
just install       # npm ci (工具版本 SSOT = package-lock.json)
just check         # lint (biome) + typecheck (tsc) + build (esbuild) + unit (node:test) + e2e (playwright)
```

e2e 全离线: 规则 bundle 与日志均由本地 fixture 服务 (8801) 供给; forgejo 用例打本地真实
实例 (127.0.0.1:3999, 不可达自动 skip)。浏览器缓存: `just browsers` (playwright chromium)。

手动体验: `just serve` 后浏览器打开 `http://127.0.0.1:8801/fixtures/github/index.html`,
再以 Tampermonkey 安装 `dist/log-skimmer.user.js` (或无管理器直接看降级路径)。

## 许可

Apache-2.0 (与生态各仓一致)。
