// 验收：真·文字浏览器完整管线（DOM 文字 + 媒体块 ASCII）
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"

const W = 100, H = 34
const edge = await launchEdge({ width: 1100, height: 900 })
const { tab } = edge
try {
  const url = process.argv[2] || "https://www.zhihu.com/signin"
  await tab.navigate(url)
  await new Promise((r) => setTimeout(r, 3000))

  const page = await buildTextPage(tab, { width: W, viewport: false, maxMediaRows: 12 })
  page.lines = page.lines
  console.log(`页面: ${page.meta.title}`)
  console.log(`块 ${page.blocks.length} · 行 ${page.lines.length}`)
  const r = renderTextPage(page, { width: W, maxRows: H, yOffset: 0 })
  console.log("═".repeat(W + 2))
  for (const row of r.rows) {
    let line = ""
    for (const run of row) line += run.t
    console.log(" " + line.replace(/\s+$/, ""))
  }
  console.log("═".repeat(W + 2))
} finally {
  edge.quit()
}
