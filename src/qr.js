// qr.js —— 二维码的「无损读出 + 终端渲染」
//
// 为什么需要这一步：
//
//   旧做法是把二维码区域**截图**，再降采样成 9 行字符画。37×37 的模块被压成
//   9 行 → 每行要塞 4 个模块，信息丢光，只能看出"这里有个二维码"。
//
//   正确做法来自 qrencode：**不做降采样，1 模块 = 1 字符地画**。
//   qrencode -t ASCII 之所以扫得出来，就是因为它从不损失模块。
//
// 于是任务变成两半：
//   ① 从页面拿到**原始分辨率**的二维码位图，再还原出 n×n 的 0/1 模块矩阵；
//   ② 把模块矩阵按 1:1 映射成终端字符，并强制黑白配色。
//
// ⚠️ ① 为什么走截图而不是 `canvas.getImageData()`：
//    知乎登录页的二维码是 <canvas class="Qrcode-qrcode">，但它内部是用
//    **跨域图片**绘制出来的 —— canvas 被污染，`getImageData()` 直接抛
//    SecurityError，像素一个也读不到。
//    截图走的是浏览器自己的合成结果，不受同源策略限制，对 canvas / img /
//    CSS 背景图一视同仁。分辨率也够：138px 的码里 37 个模块，约 3.7px/模块，
//    再超采样 2× 到 7.5px/模块，边界清晰得很。

import { PNG } from "pngjs"

const BLACK = [0, 0, 0]
const WHITE = [255, 255, 255]

/** 这个媒体块值不值得试一把二维码识别 */
export function isQrCandidate(b) {
  if (!b || b.kind !== "media") return false
  if (/二维码|扫码|扫一扫|条码|qr\s*code|barcode/i.test(String(b.alt || ""))) return true
  // 很多站点不给 alt。近正方形 + 尺寸合理（够大才画得下定位角，够小才可能是码）
  const min = Math.min(b.w, b.h), max = Math.max(b.w, b.h)
  if (min >= 88 && min <= 520 && max - min <= Math.max(6, max * 0.08)) return true
  return false
}

/**
 * 从一张原始分辨率的位图里识别二维码模块矩阵。
 *
 * 思路：
 *   1. 亮度二值化（阈值取 min/max 中点，天然适应深浅主题）
 *   2. 取暗像素外接框 —— 静区是亮的，会被自然切掉，框就是符号本体
 *   3. 对每个候选模块数 n（QR version 1..40 → 21,25,...,177）把框切成 n×n 格，
 *      采样每格中心区，统计"成色纯度"。**正确的 n 会让每格要么全黑要么全白**
 *      （纯度接近 1）；错误的 n 会切出大量跨模块边界的混合格（纯度接近 0）。
 *   4. 用三个 7×7 定位角做硬校验，杜绝把照片/图标误判成二维码。
 *
 * @param {Uint8ClampedArray|Buffer} data RGBA
 * @returns {{n:number, bits:string, purity:number, src:string}|null}
 */
export function qrFromRgba(data, w, h) {
  if (!w || !h) return null
  const N = w * h
  if (N < 15 * 15) return null

  const lum = new Uint8Array(N)
  let lo = 255, hi = 0
  for (let i = 0; i < N; i++) {
    const L = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
    lum[i] = L
    if (L < lo) lo = L
    if (L > hi) hi = L
  }
  if (hi - lo < 50) return null

  const mid = (lo + hi) / 2
  const bin = new Uint8Array(N)
  for (let i = 0; i < N; i++) bin[i] = lum[i] < mid ? 1 : 0

  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (!bin[row + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  if (bw < 15 || bh < 15) return null
  // 符号本身必须是正方形（三个定位角贴边，所以外接框就等于符号）
  if (Math.abs(bw - bh) / Math.max(bw, bh) > 0.12) return null

  const sample = (n) => {
    const mw = bw / n, mh = bh / n
    if (mw < 1.2 || mh < 1.2) return null
    const bits = new Uint8Array(n * n)
    let purity = 0
    const r = 0.21   // 取中心 42% 见方：避开模块边界与抗锯齿过渡带
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const ix0 = Math.floor(x0 + (gx + 0.5 - r) * mw)
        const ix1 = Math.max(ix0 + 1, Math.ceil(x0 + (gx + 0.5 + r) * mw))
        const iy0 = Math.floor(y0 + (gy + 0.5 - r) * mh)
        const iy1 = Math.max(iy0 + 1, Math.ceil(y0 + (gy + 0.5 + r) * mh))
        let s = 0, c = 0
        for (let py = iy0; py < iy1 && py < h; py++) {
          const row = py * w
          for (let px = ix0; px < ix1 && px < w; px++) { s += bin[row + px]; c++ }
        }
        if (!c) return null
        const v = s / c
        bits[gy * n + gx] = v > 0.5 ? 1 : 0
        purity += Math.abs(v - 0.5) * 2
      }
    }
    return { n, bits, purity: purity / (n * n) }
  }

  let best = null
  for (let n = 21; n <= 177; n += 4) {
    const t = sample(n)
    if (t && (!best || t.purity > best.purity)) best = t
  }
  if (!best || best.purity < 0.72) return null

  const n = best.n, b = best.bits
  const finderOK = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = (x === 0 || x === 6 || y === 0 || y === 6)
        const core = (x >= 2 && x <= 4 && y >= 2 && y <= 4)
        if (b[(oy + y) * n + (ox + x)] !== ((ring || core) ? 1 : 0)) return false
      }
    }
    return true
  }
  if (!finderOK(0, 0) || !finderOK(n - 7, 0) || !finderOK(0, n - 7)) return null

  let s = ""
  for (let i = 0; i < n * n; i++) s += b[i] ? "1" : "0"
  return { n, bits: s, purity: best.purity, src: w + "x" + h }
}

/** PNG 缓冲区 → 二维码矩阵 */
export function qrFromPng(buf) {
  try {
    const png = PNG.sync.read(buf)
    return qrFromRgba(png.data, png.width, png.height)
  } catch {
    return null
  }
}

/**
 * 模块矩阵 → 终端单元格网格。
 *
 * 返回 `{ cols, rows, ch, fg, bg, style, n }`，行优先、长度为 cols*rows。
 *
 * 两种比例：
 *   full  1 模块 = 2 字符宽 × 1 字符高。用「空格 + 背景色」铺色块，
 *         **完全不依赖字形**，也不受 ambiguous-width 影响。
 *   half  1 模块 = 1 字符宽 × 半字符高，用 ▀▄█ 上下拼合 —— 一行装 2 个模块行。
 *         行数只有 full 的一半，是终端高度受限时的唯一选择。
 *
 * 两者都**强制前景黑、背景白**：深色终端主题下若沿用默认前景色，画出来是
 * "白点黑底"的反色码，不少扫码器不认 —— 这正是上游 wireguard-install 把
 * `qrencode -t UTF8` 改成 `-t ANSI256UTF8` 的原因（issue #41 的同源问题）。
 *
 * @param {{n:number, bits:string}} qr
 * @param {{margin?:number, style?:'half'|'full'}} o
 */
export function qrToCells(qr, o = {}) {
  const n = qr.n
  const margin = o.margin === undefined ? 2 : Math.max(0, o.margin)
  const S = n + margin * 2
  const style = o.style === "full" ? "full" : "half"

  // 带静区的取值器：静区恒为"亮"
  const at = (x, y) => {
    const ix = x - margin, iy = y - margin
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) return 0
    return qr.bits.charCodeAt(iy * n + ix) === 49 ? 1 : 0   // 49 = '1'
  }

  if (style === "full") {
    const cols = S * 2, rows = S
    const ch = new Array(cols * rows)
    const fg = new Array(cols * rows)
    const bg = new Array(cols * rows)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const f = at(x, y) ? BLACK : WHITE
        const c0 = y * cols + x * 2
        ch[c0] = ch[c0 + 1] = " "
        fg[c0] = fg[c0 + 1] = f
        bg[c0] = bg[c0 + 1] = f
      }
    }
    return { cols, rows, ch, fg, bg, style, n }
  }

  // half：每行承载 2 个模块行。S 为奇数时末行下半落在静区（白）。
  const cols = S
  const rows = Math.ceil(S / 2)
  const ch = new Array(cols * rows)
  const fg = new Array(cols * rows)
  const bg = new Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < cols; x++) {
      const top = at(x, r * 2)
      const bot = r * 2 + 1 < S ? at(x, r * 2 + 1) : 0
      const i = r * cols + x
      if (top && bot) { ch[i] = "█"; fg[i] = BLACK; bg[i] = WHITE }
      else if (top) { ch[i] = "▀"; fg[i] = BLACK; bg[i] = WHITE }
      else if (bot) { ch[i] = "▄"; fg[i] = BLACK; bg[i] = WHITE }
      else { ch[i] = " "; fg[i] = WHITE; bg[i] = WHITE }
    }
  }
  return { cols, rows, ch, fg, bg, style, n }
}

/**
 * 选一个能塞进当前视口的渲染比例，并定出静区宽度。
 *
 * 静区（quiet zone）是二维码规范要求的白边，规范值 4 模块。
 * 终端尺寸有限时逐级退让到 3 / 2，但**不接受 1 或 0** ——
 * 静区只剩一格时页面底色会直接贴到定位角上，扫码器很难锁定。
 * 真放不下就退到 half 比例（行数减半），而不是牺牲静区。
 *
 * ⚠️ 必须在**一屏内**放得下。二维码横跨两屏没法扫 ——
 * 手机一次只能拍到一屏，缺一半的码解不出来。
 *
 * @param {{n:number}} qr
 * @param {{width:number, maxRows:number}} o
 */
export function planQrLayout(qr, o = {}) {
  const width = o.width || 80
  const maxRows = o.maxRows || 20
  const n = qr.n

  const measure = (style, margin) => {
    const S = n + margin * 2
    return {
      style,
      margin,
      cols: style === "full" ? S * 2 : S,
      rows: style === "full" ? S : Math.ceil(S / 2),
    }
  }

  // 先试 full（模块面积是 half 的 4 倍，屏幕成像清晰得多），静区从宽到窄；
  // full 怎么调都放不下，才退到 half。
  for (const style of ["full", "half"]) {
    for (const margin of [4, 3, 2]) {
      const p = measure(style, margin)
      if (p.rows <= maxRows && p.cols <= width - 2) return p
    }
  }
  // 超高版本二维码（如 version 40 = 177 模块）连 half+静区2 都超一屏：
  // 仍然给无损矩阵，随文本流滚动。
  return measure("half", 2)
}
