// PNG → 字符网格转换
//
// 关键约定：RAMP 索引必须与"墨量"正相关 —— 越暗的像素用越密的字符。
// 早期版本把亮像素映射到密集字符（@），导致白底网页在终端里变成一整片 @、
// 文字反而变成稀疏空格，页面完全不可读。现在统一为：墨量越高 → 字符越密。

import { PNG } from "pngjs"

// 索引 0 = 最空（背景），末尾 = 最密（文字）
// 两条 ramp 的方向必须一致，都用「索引越大 → 墨越重」，
// 否则同一套索引公式会一条对一条反（曾导致深色页面整屏 @）。
const RAMP = " .,:;irsXA253hMHGS#9B&@"
export const RAMP_DARK_TEXT = RAMP   // 浅底深字
export const RAMP_LIGHT_TEXT = RAMP  // 深底浅字（密度方向相同，靠 ink 计算区分）

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)
const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

function cellStats(data, pw, x0, y0, x1, y1, bg) {
  let R = 0, G = 0, B = 0, A = 0, n = 0
  let minL = 255, maxL = 0
  // 取该格「出现最多的量化颜色」作为本地底色，用于判断本格是背景还是文字
  const hist = new Map()
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * pw + x) * 4
      const a = data[i + 3]
      R += data[i] * a; G += data[i + 1] * a; B += data[i + 2] * a; A += a
      const l = lumaOf(data[i], data[i + 1], data[i + 2])
      if (l < minL) minL = l
      if (l > maxL) maxL = l
      // 量化到 16 级，统计众数色
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
      hist.set(key, (hist.get(key) || 0) + 1)
      n++
    }
  }
  const avgA = A / n / 255
  if (avgA < 0.02) {
    return { r: bg[0], g: bg[1], b: bg[2], empty: true, minL: 255, maxL: 0, modeL: bg[0] }
  }
  const Rv = R / A, Gv = G / A, Bv = B / A
  const r = clamp255(Rv * avgA + bg[0] * (1 - avgA))
  const g = clamp255(Gv * avgA + bg[1] * (1 - avgA))
  const b = clamp255(Bv * avgA + bg[2] * (1 - avgA))

  // 众数色亮度 = 本格的「底色」；众数占比越高，说明本格越接近纯背景
  let modeKey = 0, modeCount = 0
  for (const [k, c] of hist) if (c > modeCount) { modeCount = c; modeKey = k }
  const modeL = lumaOf(((modeKey >> 8) & 0xf) << 4, ((modeKey >> 4) & 0xf) << 4, (modeKey & 0xf) << 4)
  const flatness = modeCount / n   // 1 = 完全纯色（必是背景）

  return { r, g, b, empty: false, minL, maxL, modeL, flatness }
}

/**
 * @param {Buffer} pngBuf  PNG 二进制
 * @param {number} cellW   每格宽（像素）
 * @param {number} cellH   每格高（像素）
 * @param {number[]} bg    页面底色 [r,g,b]，用于半透明混合
 * @param {object} opts    { invert?: boolean, contrast?: number }
 */
export function pngToGrid(pngBuf, cellW = 4, cellH = 8, bg = [16, 16, 16], opts = {}) {
  const png = PNG.sync.read(pngBuf)
  const { width: pw, height: ph, data } = png

  const grid = {
    cols: Math.max(1, Math.floor(pw / cellW)),
    rows: Math.max(1, Math.floor(ph / cellH)),
    chars: null,   // Uint8Array ncols*nrows ASCII 码
    color: null,   // Uint8Array ncols*nrows*3 每格平均色
    pw,
    ph,
  }
  grid.chars = new Uint8Array(grid.cols * grid.rows)
  grid.color = new Uint8Array(grid.cols * grid.rows * 3)

  // 第一遍：逐格统计 + 求整图平均亮度（用于自动判定底/字明暗）
  const stats = new Array(grid.cols * grid.rows)
  let lumaSum = 0
  const modeHist = new Map()   // 全图「众数色亮度」直方图，用于估计页面底色
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x0 = c * cellW, y0 = r * cellH
      const x1 = Math.min(x0 + cellW, pw), y1 = Math.min(y0 + cellH, ph)
      const s = cellStats(data, pw, x0, y0, x1, y1, bg)
      stats[r * grid.cols + c] = s
      lumaSum += lumaOf(s.r, s.g, s.b)
      if (!s.empty) {
        // 量化到 16 级会系统性低估约 8（mid-point 偏置），补回来
        const k = (s.modeL + 8) | 0
        modeHist.set(k, (modeHist.get(k) || 0) + 1)
      }
    }
  }
  const avgLuma = lumaSum / (grid.cols * grid.rows)
  // 页面底色 = 全图出现次数最多的「格内众数亮度」。
  // 背景格数量远多于文字格，所以峰值一定落在背景上；
  // 用众数比用平均稳：整屏文字的大页面不会把底色估偏。
  let bgLuma = avgLuma, best = 0
  for (const [k, v] of modeHist) if (v > best) { best = v; bgLuma = k }
  // 峰值占比太低说明页面没有明显底色（照片/复杂图），退回平均亮度
  if (best < grid.cols * grid.rows * 0.05) bgLuma = avgLuma

  // invert 未指定时按底色亮度自动判定：暗底 → 浅字
  const lightText = opts.invert ?? bgLuma < 118
  const ramp = lightText ? RAMP_LIGHT_TEXT : RAMP_DARK_TEXT
  const rampLen = ramp.length
  const contrast = opts.contrast ?? 1.0

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const gi = r * grid.cols + c
      const s = stats[gi]
      grid.color[gi * 3] = s.r
      grid.color[gi * 3 + 1] = s.g
      grid.color[gi * 3 + 2] = s.b

      if (s.empty) {
        grid.chars[gi] = 32
        continue
      }

      // ── 墨量计算 ──
      // 两个互补信号：
      //   dev   = 本格平均亮度相对页面底色的偏离 → 表示「这块区域整体有内容」
      //   spread= 本格内亮度极差               → 表示「这块区域有笔画/边缘」
      // 为什么两个都要：4x8 的格子会把笔画平均掉，一格里 25% 是深色文字时
      // 均值只偏离底色一点点，只看 dev 的话正文永远只有中等墨量、标题和正文
      // 分不出来。spread 恰好对这种「一半底一半字」的格子最敏感。
      // 反过来一整片纯背景 dev≈0 且 spread≈0，两者同时归零，页面才干净。
      const localL = lumaOf(s.r, s.g, s.b)
      const spread = Math.max(0, s.maxL - s.minL) / 255
      // 与页面底色的偏离方向按页面明暗决定：
      //   浅底深字 → 比底更暗的部分是字；深底浅字 → 比底更亮的部分是字
      const delta = lightText ? bgLuma - localL : localL - bgLuma
      const dev = Math.max(0, delta) / 255
      // dev 需要放大：格子均值天生稀释文字，除以 255 后信号很小
      let ink = dev * 3.4 + spread * 1.75
      // 只有「有内容」的格子才给墨：两者都极小的纯背景直接归零，
      // 避免 diff/抖动噪声把大片背景点出麻点
      if (ink < 0.05) ink = 0
      ink = (ink - 0.10) * contrast + 0.02
      ink = ink < 0 ? 0 : ink > 1 ? 1 : ink

      const idx = Math.min(rampLen - 1, Math.max(0, Math.round(ink * (rampLen - 1))))
      grid.chars[gi] = ramp.charCodeAt(idx)
    }
  }

  grid.avgLuma = avgLuma
  grid.bgLuma = bgLuma
  grid.lightText = lightText
  return grid
}

/**
 * 把一小块截图转成「固定行列数」的字符画，用于「文字浏览器」的媒体块。
 * 与 pngToGrid 的区别：输出是给人看的一小块图，按目标终端行列数缩放，
 * 而不是固定 4x8 格子。
 *
 * @param {Buffer} pngBuf
 * @param {number} cols  目标列数
 * @param {number} rows  目标行数
 */
export function pngToMediaArt(pngBuf, cols, rows) {
  const png = PNG.sync.read(pngBuf)
  const { width: pw, height: ph, data } = png
  const W = Math.max(1, cols), H = Math.max(1, rows)
  const out = { cols: W, rows: H, chars: new Uint8Array(W * H), color: new Uint8Array(W * H * 3) }
  // 「信息量」统计：渲染出来如果一大片格子都是同一个字符，这张图在终端里
  // 就只是一块噪点/色块（logo、纯色横幅、纯色背景图）—— 占了好几行却读不出任何东西。
  // 用「最常见字符的占比」衡量，调用方可据此降级成一行占位。
  const hist = new Uint32Array(10)

  const cellW = pw / W
  const cellH = ph / H

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x0 = Math.floor(c * cellW), x1 = Math.max(x0 + 1, Math.floor((c + 1) * cellW))
      const y0 = Math.floor(r * cellH), y1 = Math.max(y0 + 1, Math.floor((r + 1) * cellH))
      let R = 0, G = 0, B = 0, n = 0
      let minL = 255, maxL = 0
      for (let y = y0; y < Math.min(y1, ph); y++) {
        for (let x = x0; x < Math.min(x1, pw); x++) {
          const i = (y * pw + x) * 4
          R += data[i]; G += data[i + 1]; B += data[i + 2]; n++
          const l = lumaOf(data[i], data[i + 1], data[i + 2])
          if (l < minL) minL = l
          if (l > maxL) maxL = l
        }
      }
      if (!n) continue
      R = (R / n) | 0; G = (G / n) | 0; B = (B / n) | 0
      const gi = r * W + c
      out.color[gi * 3] = R; out.color[gi * 3 + 1] = G; out.color[gi * 3 + 2] = B
      // 色块 + 密度：亮度决定字符疏密，保留轮廓
      const L = lumaOf(R, G, B)
      const spread = (maxL - minL) / 255
      let ink = (L / 255) * 0.72 + spread * 0.28
      const RAMP_M = " .:-=+*#%@"
      const lvl = Math.min(9, Math.max(0, Math.round(ink * 9)))
      out.chars[gi] = RAMP_M.charCodeAt(lvl)
      hist[lvl]++
    }
  }
  // 最常见亮度档的占比（0~1）。接近 1 = 整块几乎一个字符 = 没有可读信息。
  let modal = 0, filled = 0
  for (let i = 0; i < 10; i++) { if (hist[i] > modal) modal = hist[i]; filled += hist[i] }
  out.flat = filled ? modal / filled : 1
  return out
}

/** 水平合并多个字符画块（并排放置图片） */
export function hstackMedias(list, rows) {
  const cols = list.reduce((a, m) => a + m.cols + 1, -1)
  const H = Math.max(1, rows)
  const chars = new Uint8Array(cols * H).fill(32)
  const color = new Uint8Array(cols * H * 3)
  let xoff = 0
  for (const m of list) {
    for (let r = 0; r < Math.min(H, m.rows); r++) {
      for (let c = 0; c < m.cols; c++) {
        const src = r * m.cols + c
        const dst = r * cols + xoff + c
        chars[dst] = m.chars[src]
        color[dst * 3] = m.color[src * 3]
        color[dst * 3 + 1] = m.color[src * 3 + 1]
        color[dst * 3 + 2] = m.color[src * 3 + 2]
      }
    }
    xoff += m.cols + 1
  }
  return { chars, color, cols, rows: H }
}
