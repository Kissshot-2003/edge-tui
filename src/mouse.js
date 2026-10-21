// 鼠标支持：SGR 序列解析 + 渲染格命中判定
//
// 为什么要做这个：Browsh 最值得抄的一点就是鼠标。
// 键盘路径（Tab 循环 / v 元素清单）是给「没有鼠标」的场景兜底的，
// 但绝大多数终端是有鼠标的 —— 人看到链接的第一反应就是点它。
// 我们此前的全部交互都压在键盘上，这是和 Browsh 差距最大的一处。
//
// 终端鼠标的唯一门槛是协议解析，而协议本身很简单：
//   ESC [ < Cb ; Cx ; Cy M    按下
//   ESC [ < Cb ; Cx ; Cy m    抬起
//   Cb：0=左 1=中 2=右（再 +32 表示拖动）；64=滚轮上 65=滚轮下
//   Cx / Cy 从 1 开始计数
//
// ⚠️ 必须用 SGR 模式（1006）。老式 X10 编码把坐标压在单字节里，
// 列号一过 223 就溢出 —— 而这个浏览器的页面区宽度经常在 200 列以上。

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h"
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l"

/**
 * 从缓冲区 start 处尝试解析一个 SGR 鼠标事件。
 * 三种返回：
 *   { cb, x, y, release, len }  —— 解析成功，len = 本事件占用的字节数
 *   { bad: true, len }          —— 认出来了但不是合法鼠标序列，按长度跳过
 *   null                        —— 数据不完整（序列被拆到两个 chunk 里），等下一批
 *
 * 「不完整必须返回 null 而不是报错」很关键：终端一次 read 可能正好把
 * `\x1b[<0;10;5M` 从中间切开，草率地把半截序列当无效字节吞掉，
 * 后半截就会被当成普通字符打进页面。
 */
export function parseSgrMouse(buf, start = 0) {
  if (!buf || buf.length - start < 3) return null
  if (buf[start] !== 0x1b || buf[start + 1] !== 0x5b || buf[start + 2] !== 0x3c) return null

  let i = start + 3
  let params = ""
  while (i < buf.length) {
    const b = buf[i]
    if (b === 0x4d || b === 0x6d) {          // 'M' 按下 / 'm' 抬起
      const parts = params.split(";")
      if (parts.length !== 3) return { bad: true, len: i - start + 1 }
      const cb = Number(parts[0]), x = Number(parts[1]), y = Number(parts[2])
      if (!Number.isFinite(cb) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return { bad: true, len: i - start + 1 }
      }
      return { cb, x, y, release: b === 0x6d, len: i - start + 1 }
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x3b) { params += String.fromCharCode(b); i++; continue }
    // 出现既不是数字/分号也不是终结符的字节 → 认错了，跳过已读部分
    return { bad: true, len: i - start + 1 }
  }
  return null
}

/**
 * 原始 Cb 编码 → 语义动作。
 *
 * SGR 的 Cb 字段还带着修饰键位，这里要**留着**：
 * 真浏览器里 Ctrl+点 / 中键点 = 在新标签页打开，这个行为很常用。
 * 以前解码时把高位直接丢掉了，于是只能收到"左键点击"，修饰键信息全丢了。
 *
 * Cb 位分配：bit0-1=按键(0左 1中 2右) bit2=Shift bit3=Alt bit4=Ctrl
 *            bit5=移动 bit6=滚轮
 *
 * @returns {{kind:'click'|'release'|'wheelUp'|'wheelDown'|'move', button?:number,
 *            x:number, y:number, ctrl?:boolean, alt?:boolean, shift?:boolean}}
 *          x / y 是 1 起的终端坐标，与 SGR 原文一致。
 */
export function classifyMouse(ev) {
  if (!ev || ev.bad) return null
  const { cb, x, y, release } = ev
  const mods = {
    ctrl: (cb & 16) !== 0,
    alt: (cb & 8) !== 0,
    shift: (cb & 4) !== 0,
  }

  // 第 6 位（64）表示滚轮。滚轮没有「抬起」事件，只有一次按下。
  if ((cb & 64) !== 0) {
    return { kind: (cb & 1) === 0 ? "wheelUp" : "wheelDown", x, y, ...mods }
  }
  // 第 5 位（32）表示「按住移动」。我们只开了 1000h（不含移动上报），
  // 但某些终端/复用器会照发 —— 不识别的话，一次拖拽会被当成连续单击，
  // 在链接上拖一下就跳走好几个页面。
  if ((cb & 32) !== 0) return { kind: "move", button: cb & 3, x, y, ...mods }

  const button = cb & 3
  if (release) return { kind: "release", button, x, y, ...mods }
  return { kind: "click", button, x, y, ...mods }
}

/**
 * 命中判定：终端里的 (行, 列) 落在哪个 DOM 块上。
 *
 * 依赖 renderTextPage 给每个 run 挂的 `src`（来源块）。之所以不在点击时
 * 反查坐标，是因为文字模式是**重排**过的 —— 终端列和页面 x 之间没有
 * 线性关系，只有 run 自己知道「这段字符是从哪个块排出来的」。
 *
 * @param {Array<Array<run>>} rows 当前屏上正在显示的渲染行（已按窗口切好）
 * @param {number} rowIdx          页面区内的行索引（0 = 页面区第一行）
 * @param {number} col             终端列（0 起）
 * @returns {object|null} 来源块
 */
export function hitTestRows(rows, rowIdx, col) {
  const line = rows?.[rowIdx]
  if (!line || !line.length) return null
  let x = 0
  for (const r of line) {
    const w = r.w !== undefined ? r.w : String(r.t ?? "").length
    if (col < x + w) return r.src || null
    x += w
  }
  return null
}

/**
 * 「这一行整体属于哪个块」—— hitTestRows 的兜底。
 *
 * 有些行没有精确 src：文字被截断后的续行、媒体字符画、被叠加层改写的行。
 * 这时按行匹配可交互元素仍然是有意义的（用户确实点在这一行上）。
 * 返回该行覆盖到的所有块，交给调用方决定（唯一 → 直接激活；多个 → 保持沉默）。
 *
 * @param {Map<number, object[]>} rowIndex  行号 → 块列表（由 buildClickIndex 生成）
 */
export function rowCandidates(rowIndex, rowIdx) {
  return rowIndex?.get(rowIdx) || []
}

/**
 * 从「渲染行 → 块」建索引。由 renderTextPage 的 src 直接统计，
 * 比反着用坐标映射便宜，也不受多栏折返的影响。
 */
export function buildClickIndex(rows) {
  const m = new Map()
  if (!rows) return m
  for (let r = 0; r < rows.length; r++) {
    for (const run of rows[r] || []) {
      if (!run?.src) continue
      const list = m.get(r) || []
      if (!list.includes(run.src)) list.push(run.src)
      m.set(r, list)
    }
  }
  return m
}

/**
 * 在元素清单里找与某个块矩形最匹配的一项。
 * 用于把「点在哪个块上」翻译成 enumerateInteractive 的编号（真实点击要用编号）。
 *
 * 打分：重叠面积优先；完全不重叠时退化为中心距（块可能是文本节点，
 * 而可交互元素是它外面的 <a>/<button>，两者矩形常有大面积重叠但不一定包含）。
 *
 * @param {Array} els  enumerateInteractive 的结果
 * @param {object} b   块（带 x/y/w/h）
 * @returns {{index:number, overlap:number}|null}
 */
export function matchElement(els, b) {
  if (!els?.length || !b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null
  const bw = Number.isFinite(b.w) ? b.w : 0
  const bh = Number.isFinite(b.h) ? b.h : 0
  const bx1 = b.x + Math.max(bw, 1), by1 = b.y + Math.max(bh, 1)
  const bcx = b.x + bw / 2, bcy = b.y + bh / 2

  let best = null, bestScore = -Infinity
  for (const e of els) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue
    const ox = Math.min(e.x + e.w, bx1) - Math.max(e.x, b.x)
    const oy = Math.min(e.y + e.h, by1) - Math.max(e.y, b.y)
    let score
    if (ox > 0 && oy > 0) {
      score = 1e9 + ox * oy
    } else {
      const dx = Math.abs(e.x + e.w / 2 - bcx), dy = Math.abs(e.y + e.h / 2 - bcy)
      score = -(dx * dx + dy * dy)
    }
    if (score > bestScore) { bestScore = score; best = e }
  }
  if (!best) return null
  const ox = Math.min(best.x + best.w, bx1) - Math.max(best.x, b.x)
  const oy = Math.min(best.y + best.h, by1) - Math.max(best.y, b.y)
  return { index: best.i, overlap: (ox > 0 && oy > 0) ? ox * oy : 0, el: best }
}
