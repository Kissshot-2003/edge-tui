// 把「折叠内容」在终端里的观感导出成纯文本（收起 / 展开两态），供 demo 快照使用。
//
//   node tests/dump-fold.mjs [宽度]
// 用本地 fixture 页，输出稳定、可复现。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, applyFoldState } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

const W = Number(process.argv[2]) || 78
const PR = 26
const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "fold-page.html")).href

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate(fixture)
  await new Promise((r) => setTimeout(r, 700))
  const page = await buildTextPage(tab, { width: W, viewport: false, indent: 1 })

  const draw = (label, yOffset) => {
    const res = renderTextPage(page, { width: W, maxRows: PR, yOffset })
    console.log(`\n─── ${label} ───（共 ${res.totalRows} 行，显示第 ${yOffset + 1}–${Math.min(yOffset + PR, res.totalRows)} 行）`)
    console.log("┌" + "─".repeat(W) + "┐")
    for (const line of res.rows) {
      if (!line) { console.log("│" + " ".repeat(W) + "│"); continue }
      const txt = line.map((r) => r.t).join("")
      const pad = Math.max(0, W - strWidth(txt))
      console.log("│" + txt + " ".repeat(pad) + "│")
    }
    console.log("└" + "─".repeat(W) + "┘")
  }

  const folds = page.folds || []
  draw("收起状态：站点折叠的正文不会丢，而是明确标出「多少字 / 按哪个键」", 0)

  applyFoldState(page, new Set(folds.map((f) => f.id)), W)
  const marker = page.lines.findIndex((l) => l.type === "text" && l.style?.foldHead)
  draw("按 e 展开：折叠正文就地插入文本流（暗色显示，不依赖站点 JS）", Math.max(0, marker - 6))
} finally {
  try { await edge.quit() } catch {}
}
