// 验收：DOM 提取 + 布局 → 终端文本渲染
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS, PAGE_META } from "../src/extract.js"
import { layout } from "../src/layout.js"

const W = 100
const edge = await launchEdge({ width: 1000, height: 900 })
const { tab } = edge
try {
  const url = process.argv[2] || "https://www.zhihu.com/signin"
  await tab.navigate(url)
  await new Promise((r) => setTimeout(r, 3000))

  const blocks = (await tab.evalJs(EXTRACT_BLOCKS)).blocks
  const meta = await tab.evalJs(PAGE_META)
  console.log(`页面: ${meta.title}`)
  console.log(`块数: ${blocks.length}（文字 ${blocks.filter((b) => b.kind === "text").length}，媒体 ${blocks.filter((b) => b.kind === "media").length}）`)
  console.log(`\n${"═".repeat(W)}`)
  console.log(` ${meta.title}`)
  console.log(`${"═".repeat(W)}`)

  const lines = layout(blocks, { width: W - 2, indent: 1 })
  for (const l of lines) {
    if (l.type === "blank") { console.log(""); continue }
    if (l.type === "media") {
      const b = l.block
      console.log(`  [${b.tag}${b.alt ? " " + b.alt : ""} ${b.w}×${b.h}]`)
      continue
    }
    const pad = " ".repeat(l.indent || 0)
    let prefix = ""
    if (l.style?.link) prefix = "› "
    console.log(pad + prefix + l.text)
  }
  console.log(`${"═".repeat(W)}`)
} finally {
  edge.quit()
}
