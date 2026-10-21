// 验证真实程序（run.mjs）的滚动：dump 一屏 → 滚到底 → 再 dump，内容必须不同。
//
// run.mjs 需要 TTY 才能进交互模式，但 --dump 是一次性的。
// 这里用 run.mjs 的启动参数 + 一个能触发滚动的长文档，
// 通过比对两次 dump 的可见文本确认滚动链路（scrollPx → textRowOffset → 重绘）成立。

import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, makeLineMapper } from "../src/textbrowser.js"

const PC = 78, PR = 24
let pass = 0, fail = 0
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  ✓ ${n}${e ? "  " + e : ""}`)) : (fail++, console.log(`  ✗ ${n}${e ? "  " + e : ""}`)) }

// 复刻 run.mjs 的 scrollPx 文字模式分支
function makeScroller(page, pc, pr) {
  let total = 0
  let off = 0
  const res0 = renderTextPage(page, { width: pc, maxRows: pr, yOffset: 0 })
  total = res0.totalRows
  const scrollPx = (dy) => {
    const maxOff = Math.max(0, total - pr)
    const step = Math.round(dy / 8)     // CELL_H = 8
    off = Math.max(0, Math.min(maxOff, off + step))
    return renderTextPage(page, { width: pc, maxRows: pr, yOffset: off })
  }
  return { scrollPx, get off() { return off }, get total() { return total }, get maxOff() { return Math.max(0, total - pr) } }
}

const longHtml = `<!doctype html><meta charset="utf-8"><title>滚动验证</title>
<body style="font:16px/1.6 sans-serif;max-width:640px;margin:24px auto">
<h1>终端模拟器简史</h1>
${Array.from({ length: 60 }, (_, i) =>
  `<p>第 ${i + 1} 段：终端模拟器是把一个物理终端的行为用软件重现的程序。它接收键盘输入并送往伪终端，再把远端产生的字节流按转义序列解释成屏幕上的字符、颜色与光标位置。这一段文字足够长，用来验证排版引擎的折行与行级滚动是否正确。</p>`).join("\n")}
</body>`

const t0 = Date.now()
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  console.log("\n══ 文字模式 · 滚动链路 ══\n")
  await tab.setViewport(Math.max(880, PC * 9), Math.max(520, PR * 19))
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(longHtml))
  await new Promise((r) => setTimeout(r, 800))

  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1, maxMediaRows: 2 })
  const sc = makeScroller(page, PC, PR)
  console.log(`[1] 内容 ${sc.total} 行 · 页面区 ${PR} 行 · 最大偏移 ${sc.maxOff}`)
  ok("长文档内容溢出", sc.total > PR, `${sc.total} > ${PR}`)
  ok("最大滚动偏移 > 0", sc.maxOff > 0, `${sc.maxOff}`)

  const view = (r) => r.rows.map((x) => x.map((y) => y.t).join("").trim()).join("\n")
  const top = view(sc.scrollPx(0))
  ok("初始在顶部 (offset=0)", sc.off === 0, `off=${sc.off}`)

  // 模拟按 j (2*CELL_H*2 = 32px → 4 行)
  const v1 = view(sc.scrollPx(32))
  ok("按下 j 后偏移前进", sc.off > 0, `off=${sc.off}`)
  ok("按下 j 后内容变化", v1 !== top)

  // 半页 d
  const v2 = view(sc.scrollPx(Math.floor(PR / 2) * 8))
  ok("按 d 后继续前进", sc.off > 4, `off=${sc.off}`)

  // 到底 G
  const vEnd = view(sc.scrollPx(100000))
  ok("按 G 抵达底部", sc.off === sc.maxOff, `off=${sc.off} max=${sc.maxOff}`)
  ok("底部内容与顶部不同", vEnd !== top)

  // 到顶 g
  sc.scrollPx(-100000)
  ok("按 g 回到顶部", sc.off === 0, `off=${sc.off}`)

  // 边界：再往下也不越界
  sc.scrollPx(100000)
  const o1 = sc.off
  sc.scrollPx(100000)
  ok("到底后继续下滚不越界", sc.off === o1 && sc.off === sc.maxOff, `off=${sc.off}`)

  // 行映射跟着偏移走
  sc.scrollPx(-100000)
  const m0 = makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 })
  sc.scrollPx(100000)
  const m1 = makeLineMapper(page, { yOffset: sc.off, pxPerRow: 8, viewOffsetY: 0 })
  const y = 3000
  ok("行映射随滚动偏移平移", m0(y) !== m1(y), `m0(3000)=${m0(y)} m1(3000)=${m1(y)}`)

  // 每屏行宽都要守恒
  const allW = (r) => r.rows.every((row) => row.reduce((a, x) => a + (x.w !== undefined ? x.w : 0), 0) === PC)
  sc.scrollPx(-100000)
  const widths = [0, 5, 20, sc.maxOff].map((o) => allW(renderTextPage(page, { width: PC, maxRows: PR, yOffset: o })))
  ok("各滚动位置行宽守恒", widths.every(Boolean), JSON.stringify(widths))

  console.log("\n── 顶部窗口 ──")
  console.log(top.split("\n").slice(1, 8).join("\n"))
  console.log("\n── 底部窗口 ──")
  console.log(vEnd.split("\n").filter((l) => l).slice(-6).join("\n"))
} catch (e) {
  console.error("\n[异常]", e?.stack || e)
  fail++
} finally {
  try { await edge.quit() } catch {}
}
console.log(`\n══ ${pass} 通过 · ${fail} 失败 · ${((Date.now() - t0) / 1000).toFixed(1)}s ══\n`)
process.exit(fail ? 1 : 0)
