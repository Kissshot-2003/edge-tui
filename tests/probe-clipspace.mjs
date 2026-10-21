// 判定 Page.captureScreenshot 的 clip 是「文档坐标」还是「视口坐标」
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS, PAGE_META } from "../src/extract.js"
import { qrFromPng } from "../src/qr.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2200))

  const report = async (tag) => {
    const meta = await tab.evalJs(PAGE_META)
    const blocks = (await tab.evalJs(EXTRACT_BLOCKS)).blocks
    const qrBlock = blocks.find((b) => b.kind === "media" && /二维码/.test(b.alt || ""))
    if (!qrBlock) { console.log(`${tag}: 没找到二维码块`); return }
    const sy = meta.scrollLayoutY || 0, sx = meta.scrollLayoutX || 0
    console.log(`${tag}: 块布局坐标 (${qrBlock.x},${qrBlock.y}) · 总滚动 (${sx},${sy})`)

    const a = await tab.screenshotClip(qrBlock.x, qrBlock.y, qrBlock.w, qrBlock.h, { scale: 2 })
    const b = await tab.screenshotClip(qrBlock.x - sx, qrBlock.y - sy, qrBlock.w, qrBlock.h, { scale: 2 })
    const ra = qrFromPng(a), rb = qrFromPng(b)
    console.log(`   用「布局坐标」截 → ${ra ? `✓ n=${ra.n} 纯度${ra.purity.toFixed(2)}` : "✗ 不是二维码"}`)
    console.log(`   用「视口坐标」截 → ${rb ? `✓ n=${rb.n} 纯度${rb.purity.toFixed(2)}` : "✗ 不是二维码"}`)
  }

  await report("滚动前")
  await tab.scrollTarget()
  await tab.scrollBy(200)
  await new Promise((r) => setTimeout(r, 400))
  await report("滚动 200px 后")
} finally {
  try { await edge.quit() } catch {}
}
