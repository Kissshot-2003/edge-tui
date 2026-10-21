// 自绘 ANSI 渲染器：行级 diff，无 native 依赖
//
// 配色取自 CodeWhale TUI（_ref/codewhale-tui.png 实测采样）：
//   深蓝底 + 橙红边框 + 蓝/紫/青/金 四色语义
// 全部以 24-bit RGB 数组 [r,g,b] 表示。

export const C = {
  // ── 基础层 ──
  bg: hexRGB("#0B1726"),        // 页面区底色（最深）
  bgDeep: hexRGB("#09131F"),    // 状态栏底
  chrome: hexRGB("#0E1C2F"),    // 顶栏底色
  chromeAlt: hexRGB("#162840"), // 次级 chrome
  border: hexRGB("#EF8262"),    // 输入框/强调边框（橙红）
  borderDim: hexRGB("#2A3F5A"), // 普通分隔线

  // ── 文字层 ──
  fg: hexRGB("#B9C1D3"),        // 主文字
  text: hexRGB("#95A1B6"),      // 正文
  dim: hexRGB("#8E99B1"),       // 次要说明
  weak: hexRGB("#5A6B85"),      // 极弱提示

  // ── 语义色 ──
  blue: hexRGB("#78A5D8"),      // 链接/模型名
  purple: hexRGB("#A88BF8"),    // 模式
  cyan: hexRGB("#76CFC5"),      // 状态/在线
  gold: hexRGB("#EFC767"),      // 高亮/选中
  accent: hexRGB("#EF8262"),    // 强调（同 border）
  ok: hexRGB("#49C970"),
  err: hexRGB("#F17471"),
}

function hexRGB(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

// 简易显示宽度：CJK/全角按 2 列
export function strWidth(s) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || c >= 0xac00 && c <= 0xd7a3 || c >= 0xf900 && c <= 0xfaff || c >= 0xfe30 && c <= 0xfe4f || c >= 0xff00 && c <= 0xff60 || c >= 0xffe0 && c <= 0xffe6 || c >= 0x20000) ? 2 : 1
  }
  return w
}

export function pad(s, w) {
  const len = strWidth(s)
  if (len >= w) return s
  return s + " ".repeat(w - len)
}

// 按显示宽度截断（不会切坏中文）
export function truncateByWidth(s, w) {
  if (strWidth(s) <= w) return s
  let out = "", cur = 0
  for (const ch of s) {
    const cw = strWidth(ch)
    if (cur + cw > w) break
    out += ch
    cur += cw
  }
  return out
}

// 按显示宽度从左侧省略（保留尾部，适合长路径）
export function truncateLeft(s, w, marker = "…") {
  if (strWidth(s) <= w) return s
  const mw = strWidth(marker)
  let out = "", cur = 0
  for (let i = s.length - 1; i >= 0; i--) {
    const cw = strWidth(s[i])
    if (cur + cw > w - mw) break
    out = s[i] + out
    cur += cw
  }
  return marker + out
}

export function createTerm() {
  const out = process.stdout
  const esc = (s) => "\x1b[" + s
  let cols = Math.max(20, out.columns || 100)
  let rows = Math.max(5, out.rows || 36)
  out.on("resize", () => { cols = Math.max(20, out.columns || 100); rows = Math.max(5, out.rows || 36) })
  let prevLines = null   // 上帧每行 ANSI 文本（不含定位），用于行级 diff
  let destroyed = false

  function colorSeq(fg, bg) {
    let s = ""
    if (fg) s += `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`
    if (bg) s += `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m`
    return s
  }

  // 渲染一行 runs 到带色 ANSI 文本
  function lineAnsi(runs, width) {
    let sb = ""
    let total = 0
    let lastFg = null, lastBg = null
    for (const r of runs) {
      if (total >= width) break
      const t = String(r.t ?? "")
      const need = r.w !== undefined ? r.w : strWidth(t)
      const remain = width - total
      const text = strWidth(t) >= remain ? truncateByWidth(t, remain) : pad(t, need)
      total += strWidth(text)
      const fg = r.fg || C.text
      const bg = r.bg
      if (fg[0] !== lastFg?.[0] || fg[1] !== lastFg?.[1] || fg[2] !== lastFg?.[2] || String(bg) !== String(lastBg)) {
        sb += colorSeq(fg, bg)
        lastFg = fg; lastBg = bg
      }
      sb += text
    }
    if (total < width) sb += "\x1b[0m" + " ".repeat(width - total)
    sb += esc("K")
    return sb
  }

  // screenRuns: 每行 runs: [{t, fg, bg, w}]
  // 返回本次写入的字符串（便于测试），不改变调用方语义
  function render(screenRuns) {
    if (destroyed) return ""
    const count = Math.min(screenRuns.length, rows)
    let sb = ""
    sb += esc("?25l")
    const lineBuf = []
    for (let y = 0; y < count; y++) {
      lineBuf.push(lineAnsi(screenRuns[y] || [], cols))
    }
    if (!prevLines) {
      sb += esc("H") + esc("0m")
      for (let y = 0; y < lineBuf.length; y++) {
        sb += `\x1b[${y + 1};1H` + lineBuf[y]
      }
    } else {
      for (let y = 0; y < lineBuf.length; y++) {
        if (prevLines[y] === lineBuf[y]) continue
        sb += `\x1b[${y + 1};1H` + lineBuf[y]
      }
    }
    // 上帧更长时，清掉尾部多余行，避免残影
    if (prevLines && prevLines.length > lineBuf.length) {
      for (let y = lineBuf.length; y < prevLines.length; y++) {
        sb += `\x1b[${y + 1};1H` + "\x1b[0m" + esc("K")
      }
    }
    sb += esc("0m") + esc("?25h")
    prevLines = lineBuf
    out.write(sb)
    return sb
  }

  function clear() {
    prevLines = null
    out.write(esc("2J") + esc("H"))
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    prevLines = null
    out.write(esc("0m") + esc("?25h") + "\r\n")
  }

  return {
    render,
    clear,
    destroy,
    get width() { return cols },
    get height() { return rows },
  }
}
