// 布局引擎：把 DOM 顺序的块序列排版成终端字符行
//
// 输入是「DOM 文档顺序」的块序列（见 extract.js），这已经是正确的阅读顺序。
// 所以这里不再排序，只做三件事：
//   1. 判断相邻块是「同段续写」（拼同一行，用空格分隔）还是「另起一块」（换行）
//   2. 按 y 间距插入空行，保留版面的呼吸感
//   3. 每块文字按终端宽度折行（CJK 感知）
//
// 输出行类型：
//   { type:'text',  text, indent, style, item, src, segs }   ← 文字行
//       item —— 叠加层的锚点（只挂在折行首行，避免重复矩形）
//       src  —— 鼠标命中用的来源块（折行的每一行都挂）
//       segs —— 行内合并的片段 [{t, src, style}]，让点击能分辨「这一段是哪个链接」
//   { type:'media', block }                       ← 媒体占位（渲染层填 ASCII）
//   { type:'fold',  block, indent }               ← 折叠内容标记（渲染层决定展开与否）
//   { type:'field', blocks, indent }              ← 表单控件行（同一行的输入框+提交按钮合并）
//   { type:'blank' }                              ← 空行
//   { type:'rule',  label }                       ← 分隔线

import { strWidth } from "./term.js"

// 同一视觉行的 y 容差
const ROW_TOL = 8
// 行内拼接到同一行的最大间距（像素）
const MAX_INLINE_GAP = 40
// 竖直间距超过此值插一个空行
const BLANK_GAP = 22
// 竖直间距超过此值插两个空行（段落分隔）
const PARA_GAP = 60

export function layout(blocks, opts = {}) {
  const width = opts.width || 80
  const indent = opts.indent ?? 1
  const avail = Math.max(8, width - indent)

  const lines = []
  let prev = null   // 上一个块（用于判断间距/同行）

  for (const b of blocks) {
    // ── 折叠内容标记 ──
    // 它代表的是一段「被站点藏起来」的正文，占位宽度/坐标取自展开控件。
    // 这里只排出一行标记（展开后的正文由 textbrowser.js#applyFoldState 追加），
    // 所以排版行号与实际渲染行号仍是一一对应。
    if (b.kind === "fold") {
      if (prev) {
        const gap = b.y - (prev.y + (prev.h || 0))
        if (gap > PARA_GAP) { lines.push({ type: "blank" }); lines.push({ type: "blank" }) }
        else if (gap > BLANK_GAP) lines.push({ type: "blank" })
      }
      lines.push({ type: "fold", block: b, indent })
      prev = b
      continue
    }

    // ── 表单控件 ──
    // 一个控件占一行。**同一视觉行内的多个控件合并成一行** ——
    // 搜索框和它右边的「搜索」按钮本来就是并排的，拆成两行读起来很别扭。
    // 合并后 renderedRowCount 仍是 1（叠加层映射不受影响）。
    if (b.kind === "field") {
      const last = lines[lines.length - 1]
      const prevF = last && last.type === "field" ? last.blocks[last.blocks.length - 1] : null
      if (prevF && Math.abs(b.y - prevF.y) <= ROW_TOL) {
        last.blocks.push(b)
        prev = b
        continue
      }
      if (prev) {
        const gap = b.y - (prev.y + (prev.h || 0))
        if (gap > PARA_GAP) { lines.push({ type: "blank" }); lines.push({ type: "blank" }) }
        else if (gap > BLANK_GAP) lines.push({ type: "blank" })
      }
      lines.push({ type: "field", blocks: [b], block: b, indent })
      prev = b
      continue
    }

    if (b.kind === "media") {
      if (prev && b.y - (prev.y + prev.h) > BLANK_GAP) lines.push({ type: "blank" })
      lines.push({ type: "media", block: b })
      prev = b
      continue
    }

    const text = (b.text || "").trim()
    if (!text) continue

    // 与上一块的垂直间距 → 插空行
    if (prev) {
      const gap = b.y - (prev.y + prev.h)
      if (gap > PARA_GAP) { lines.push({ type: "blank" }); lines.push({ type: "blank" }) }
      else if (gap > BLANK_GAP) lines.push({ type: "blank" })
    }

    // 能否与上一块拼成同一行：
    //   · y 基本对齐（同一视觉行）
    //   · 上面那块是行内元素（a/span 等），或间距很小
    //   · 拼起来不超宽
    const sameRow = prev && prev.kind === "text" &&
      Math.abs(b.y - prev.y) <= ROW_TOL &&
      (b.x - (prev.x + prev.w)) <= MAX_INLINE_GAP &&
      (b.x - (prev.x + prev.w)) >= -4 &&
      !prev.block && !b.block

    if (sameRow) {
      const last = lines[lines.length - 1]
      if (last && last.type === "text" && last.inlineOpen) {
        const gapPx = Math.max(0, b.x - (prev.x + prev.w))
        const gapCols = Math.max(1, Math.min(4, Math.round(gapPx / 7)))
        const add = " ".repeat(gapCols) + text
        if (strWidth(last.text) + strWidth(add) <= avail) {
          last.text += add
          last.style = mergeStyle(last.style, styleOf(b))
          // 逐个片段留档。`登录 注册 帮助` 这种导航行拼成一行之后，
          // 只记「这一行的样式」是不够的 —— 鼠标点在「注册」上必须开注册。
          if (last.segs) last.segs.push({ t: add, src: b, style: styleOf(b) })
          prev = b
          continue
        }
      }
    }

    // 另起一行：折行输出
    const wrapped = wrapByWidth(text, avail)
    wrapped.forEach((w, i) => {
      const st = i === 0 ? styleOf(b) : { ...styleOf(b), link: false }
      lines.push({
        type: "text",
        text: w,
        indent,
        style: st,
        item: i === 0 ? b : null,
        src: b,                                        // 鼠标：折行每行都点得回原块
        segs: [{ t: w, src: b, style: st }],
        inlineOpen: i === 0 && !b.block,   // 行内元素允许后续拼接
      })
    })
    prev = b
  }

  // 清理：首尾空行、连续空行压缩
  while (lines.length && lines[0].type === "blank") lines.shift()
  while (lines.length && lines[lines.length - 1].type === "blank") lines.pop()
  const out = []
  for (const l of lines) {
    if (l.type === "blank" && out[out.length - 1]?.type === "blank") continue
    out.push(l)
  }
  return out
}

function styleOf(it) {
  return {
    bold: !!it.bold,
    heading: !!it.heading,
    link: !!it.href,
    dim: (it.fs && it.fs <= 12),
    big: (it.fs && it.fs >= 18),
    color: it.color,
    href: it.href,
    size: it.fs || 16,
  }
}

function mergeStyle(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    bold: a.bold && b.bold,
    heading: a.heading || b.heading,
    link: a.link || b.link,
    dim: a.dim && b.dim,
    big: a.big || b.big,
    color: a.color,
    href: a.href || b.href,
    size: a.size,
  }
}

/** 按终端显示宽度折行（CJK 感知），优先在空格处断开 */
export function wrapByWidth(s, width) {
  if (width <= 2) return [s]
  const out = []
  let cur = ""
  let curW = 0
  for (const ch of s) {
    const cw = strWidth(ch)
    if (curW + cw > width) {
      // 英文尽量在空格处断，避免切碎单词
      const sp = cur.lastIndexOf(" ")
      if (sp > width * 0.5 && /[A-Za-z0-9]/.test(ch)) {
        out.push(cur.slice(0, sp))
        cur = cur.slice(sp + 1) + ch
        curW = strWidth(cur)
      } else {
        out.push(cur)
        cur = ch
        curW = cw
      }
    } else {
      cur += ch
      curW += cw
    }
  }
  if (cur) out.push(cur)
  return out.length ? out : [""]
}

export { ROW_TOL, MAX_INLINE_GAP, BLANK_GAP, PARA_GAP }
