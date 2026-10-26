// icon.mjs — 扩展图标程序化生成 (矢量意图 → 像素, 无第三方依赖):
//   深色圆角方底 + 三根左对齐胶囊条 (failure 红 / warning 琥珀 / info 蓝, 宽度递减)
//   — "把万行日志折叠为少量证据块" 的视觉隐喻, 配色与 overlay intent 色一致。
// 抗锯齿: 每像素 3×3 超采样取平均 (覆盖率采样); 输出 PNG bytes (pngEncode)。

import { pngEncode } from './binutil.mjs'

const BG = [0x1f, 0x23, 0x28] // GitHub 深墨色底
const BARS = [
  { w: 1.0, color: [0xcf, 0x22, 0x2e] }, // failure
  { w: 0.68, color: [0xd4, 0xa7, 0x2c] }, // warning
  { w: 0.42, color: [0x09, 0x69, 0xda] }, // info
]
const MARGIN_X = 0.16 // 条区左右边距 (单位 = 图标边长)
const BAR_H = 0.13
const BAR_GAP = 0.1
const CORNER = 0.19 // 底板圆角半径比例

/** 点到圆角矩形边界的有符号距离 (单位空间; 中心 0.5,0.5)。 */
function sdRoundRect(x, y, hx, hy, r) {
  const qx = Math.abs(x - 0.5) - (hx - r)
  const qy = Math.abs(y - 0.5) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 点到水平线段 (胶囊轴) 的距离。 */
function sdSeg(x, y, x0, x1, yy) {
  const t = Math.min(Math.max((x - x0) / (x1 - x0), 0), 1)
  return Math.hypot(x - (x0 + t * (x1 - x0)), y - yy)
}

/** 单采样点颜色 (单位空间) — 返回 RGBA (条恒在底板内, 直接覆盖; 透明外预乘黑)。
 *  屏幕坐标: y 向下增长 — BARS[0] (failure 红) 在最上, 与 overlay intent 排序一致。 */
function sample(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, CORNER) > 0) return [0, 0, 0, 0]
  let c = BG
  const left = MARGIN_X
  const spanW = 1 - 2 * MARGIN_X
  const top0 = 0.5 - (BAR_H + BAR_GAP) // 最上条中心; 三条整体垂直居中: 0.5 ± (BAR_H+BAR_GAP)
  for (let i = 0; i < BARS.length; i++) {
    const bar = BARS[i]
    const cy = top0 + i * (BAR_H + BAR_GAP)
    const x0 = left + BAR_H / 2
    const x1 = left + spanW * bar.w - BAR_H / 2
    if (sdSeg(x, y, x0, x1, cy) <= BAR_H / 2) c = bar.color
  }
  return [c[0], c[1], c[2], 255]
}

/** size×size 图标 PNG。 */
export function iconPng(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const N = 3 // 超采样密度
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const s = sample((px + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size)
          r += s[0] * s[3]
          g += s[1] * s[3]
          b += s[2] * s[3]
          a += s[3]
        }
      }
      const i = (py * size + px) * 4
      if (a > 0) {
        rgba[i] = Math.round(r / a)
        rgba[i + 1] = Math.round(g / a)
        rgba[i + 2] = Math.round(b / a)
      }
      rgba[i + 3] = Math.round(a / (N * N))
    }
  }
  return pngEncode(size, size, rgba)
}
