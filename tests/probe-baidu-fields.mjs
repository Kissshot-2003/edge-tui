// 探针：提取器视角下，百度首页的表单控件长什么样（label 从哪来）
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS } from "../src/extract.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.baidu.com", { timeoutMs: 15000 })
  const r = await tab.evalJs(EXTRACT_BLOCKS)
  for (const f of r.fields || []) {
    console.log(`fid=${f.fid} ${f.tag}${f.type ? "[" + f.type + "]" : ""} score=${f.score} btn=${f.btn}`)
    console.log(`   label=${JSON.stringify(f.label)} ph=${JSON.stringify(f.ph)} name=${JSON.stringify(f.name)} id=${JSON.stringify(f.id)}`)
    console.log(`   ${f.w}×${f.h} @ ${f.x},${f.y}`)
  }
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
