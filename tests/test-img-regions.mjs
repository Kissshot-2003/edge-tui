// 实验：识别「大面积图像区」并降噪，让文字区更突出
import { launchEdge } from "../src/cdp.js"
import { PNG } from "pngjs"

const edge = await launchEdge({ width: 432, height: 224 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(432, 224)
  await new Promise((r) => setTimeout(r, 300))

  // 问页面：视口里哪些区域是 <img> / canvas / 背景图
  const imgRegions = await tab.evalJs(`(() => {
    const out = []
    for (const el of document.querySelectorAll('img, canvas, svg, video, [style*="background-image"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 24 || r.height < 24) continue
      if (r.y + r.height <= 0 || r.y >= innerHeight) continue
      out.push({ tag: el.tagName, x: Math.round(r.x), y: Math.round(r.y),
                 w: Math.round(r.width), h: Math.round(r.height),
                 area: Math.round(r.width * r.height) })
    }
    return out.sort((a,b) => b.area - a.area)
  })()`)
  console.log("视口内图像区域:")
  imgRegions.forEach((r) => console.log(`  ${r.tag} ${r.w}x${r.h} @${r.x},${r.y} area=${r.area}`))

  const png = PNG.sync.read(await tab.screenshot(false))
  console.log(`\n截图 ${png.width}x${png.height}`)

  // 计算图像区占视口比例
  const vpArea = png.width * png.height
  const overlap = imgRegions.reduce((a, r) => {
    const l = Math.max(0, r.x), t = Math.max(0, r.y)
    const rr = Math.min(png.width, r.x + r.w), bb = Math.min(png.height, r.y + r.h)
    return a + Math.max(0, rr - l) * Math.max(0, bb - t)
  }, 0)
  console.log(`图像占视口比例: ${(overlap / vpArea * 100).toFixed(0)}%`)
  console.log(`→ ${overlap / vpArea > 0.35 ? "图像主导，建议降噪" : "文字主导，无需处理"}`)
} finally {
  edge.quit()
}
