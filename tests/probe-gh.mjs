// 调试：GitHub Trending 的提取结果怎么变成 1 行了？
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS } from "../src/extract.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://github.com/trending", { timeoutMs: 20000 })
  await new Promise((r) => setTimeout(r, 1200))
  try {
    const r = await tab.evalJs(EXTRACT_BLOCKS)
    console.log(`blocks=${(r.blocks || []).length} folds=${(r.folds || []).length} fields=${(r.fields || []).length} droppedHidden=${r.droppedHidden}`)
    for (const b of (r.blocks || []).slice(0, 12)) {
      console.log(`   ${b.kind} ${String(b.text || b.label || "").replace(/\s+/g, " ").slice(0, 60)}`)
    }
  } catch (e) {
    console.log("提取脚本抛错：", String(e?.message || e).slice(0, 300))
  }
  console.log("readyState:", await tab.evalJs("document.readyState"), " href:", await tab.evalJs("location.href"))
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
