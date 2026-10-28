# CWS 提交操作手册 (给发布者, 一次性 ~20 分钟)

> 前置: ① 能访问 `chrome.google.com` 的网络; ② 一张可付 $5 的卡 (Google Payments);
> ③ 本仓 `dist/log-skimmer-extension.zip` 已构建 (版本号 = manifest 内 `version`)。

## 1. 注册开发者账号 (一次性)

1. 用你的 Google 账号登录 <https://chrome.google.com/webstore/devconsole/>
2. 支付一次性注册费 **$5** (可能要求邮箱/手机验证 — 新账号风控)
3. 发布者名 (显示在商店卡片): 建议 `luochen1990` 或个人名 (可后改)

## 2. 新建 item 并上传包

1. devconsole → **New item** → 上传 `dist/log-skimmer-extension.zip`
2. 版本即 manifest 的 `0.2.1`; 之后每次发版: 仓内 bump `package.json` → 重建 → 重传

## 3. 逐字段填写 (对照 `store-listing.md`)

| 控制台区域                   | 来源                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Name / Summary / Description | store-listing.md「Store listing 字段」(直接复制代码块内容)                                    |
| Category / Language          | Developer Tools / English                                                                     |
| 图形资产                     | 上传 `docs/store/assets/` 下 4 个文件 (截图 1280×800 ×3 + promo 440×280)                      |
| Privacy policy URL           | `https://github.com/luochen1990/log-skimmer-extension/blob/main/docs/store/privacy-policy.md` |
| Data usage 披露表            | store-listing.md「Privacy practice」节逐项勾选                                                |
| Review notes                 | store-listing.md「审核答辩 notes」节 (尤其是广域匹配的必要性说明)                             |

## 4. 提交与跟进

- Submit for review → 状态 `Pending review`, 典型 **2–7 天** (新账号偏慢)
- 质询/拒绝 → 把审核邮件原文丢给 agent, 按 store-listing 的回复模板应对
- 通过 → `Published`, 商店链接回填到本仓 README 安装节 (agent代办)

## 5. 实操注意

- **网络**: 控制台与支付均需可达 Google 服务; 断连时草稿会保留
- **隐私披露一致性**: 披露表与 privacy-policy.md 的口径必须一致 (都是"零采集"), 矛盾会被拒
- **发布者账号归属**: $5 绑定账号; 换账号 = 重新注册 + 重新审核, 尽量一步到位用主账号

## 6. 可选并行渠道 (免额外开发)

- **Edge Add-ons** (免费): 同一个 zip 直接可提 (<https://microsoftedge.microsoft.com/addons>),
  审核 1–3 天, 面向 Edge 用户零成本
- Firefox: 当前 MV3 service-worker 形态不兼容 (Firefox 无 SW), 需专门构建变体 — 暂缓
