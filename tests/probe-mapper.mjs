// 探查 makeLineMapper 的锚点表：每一条有 y 的排版行、渲染行号、以及元素坐标的量纲
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, makeLineMapper, renderedRowCount } from "../src/textbrowser.js"

const PC = 98
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1800))

  const meta = await tab.evalJs(`({ url: location.href, scrollY: window.scrollY, innerH: window.innerHeight })`)
  console.log("meta:", JSON.stringify(meta))

  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  console.log(`blocks=${page.blocks.length} lines=${page.lines.length}`)
  const ymin = Math.min(...page.blocks.map((b) => b.y))
  const ymax = Math.max(...page.blocks.map((b) => b.y))
  console.log(`块 y 范围: ${ymin} … ${ymax}`)

  console.log("\n── 锚点表（前 20 条有 y 的排版行）──")
  let rowAcc = 0, shown = 0
  for (const l of page.lines) {
    const src = l.type === "media" ? l.block : l.item
    if (src && Number.isFinite(src.y) && shown < 20) {
      const txt = l.type === "media" ? `[media ${src.tag}]` : String(l.text || "").slice(0, 24)
      console.log(`  渲染行 ${String(rowAcc).padStart(3)}  y=${String(src.y).padStart(6)}  ${txt}`)
      shown++
    }
    rowAcc += renderedRowCount(l)
  }

  const map = makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 })
  console.log("\n── 映射结果 ──")
  for (const y of [24, 100, 159, 200, 244, 300, 400, 600, 1000]) {
    console.log(`  y=${String(y).padStart(5)} → 行 ${map(y)}`)
  }

  await tab.scrollTarget()
  const els = await tab.enumerateInteractive(880, 520)
  console.log(`\n── 元素坐标（前 12 个）── 共 ${els.length} 个`)
  for (const e of els.slice(0, 12)) {
    console.log(`  y=${String(e.y).padStart(6)} h=${String(e.h).padStart(4)} x=${String(e.x).padStart(5)} ` +
      `tag=${e.tag} "${String(e.text || "").slice(0, 22)}"`)
  }
  const targets = ["验证码登录", "密码登录", "开通机构号", "中国"]
  console.log("\n── 目标元素 ──")
  for (const kw of targets) {
    const e = els.find((x) => String(x.text || "").includes(kw))
    console.log(e ? `  ${kw}: y=${e.y} h=${e.h} x=${e.x} w=${e.w}` : `  ${kw}: 未找到`)
  }
} finally {
  try { await edge.quit() } catch {}
}
