// 调试：看 x 区间覆盖情况，找出为什么分栏检测没触发
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS } from "../src/extract.js"

const edge = await launchEdge({ width: 1000, height: 900 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 3000))
  const blocks = (await tab.evalJs(EXTRACT_BLOCKS)).blocks
  const texts = blocks.filter((b) => b.kind === "text" && b.text.trim())
  console.log("文字块 x 区间（排序后）:")
  const spans = texts.map((b) => [b.x, b.x + b.w, b.text.slice(0, 22)]).sort((a, b) => a[0] - b[0])
  spans.forEach(([s, e, t]) => console.log(`  [${String(s).padStart(4)}, ${String(e).padStart(4)}] 宽${String(e - s).padStart(4)}  ${t}`))

  console.log("\n扫描空白带:")
  let coverEnd = spans[0][1]
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i]
    const gap = s - coverEnd
    if (gap > 0) console.log(`  gap=${String(gap).padStart(4)}  在 [${coverEnd}, ${s}] 之间  ${gap > 96 ? "★ 超过阈值" : ""}`)
    coverEnd = Math.max(coverEnd, e)
  }
} finally {
  edge.quit()
}
