// 诊断：导出真实 PNG，检查页面渲染是否真的"空白"
import { launchEdge } from "../src/cdp.js"
import fs from "node:fs"

const edge = await launchEdge({ width: 1024, height: 900 })
try {
  const tab = edge.tab
  await tab.navigate("https://cn.bing.com/")
  await tab.setViewport(400, 800)
  await tab.evalJs(`document.documentElement.style.zoom = ""`)
  await new Promise((r) => setTimeout(r, 4000))
  const png = await tab.screenshot(false)
  fs.writeFileSync("../dump-bing.png", png)
  console.log("wrote dump-bing.png", png.length)

  // 采样：页面首屏中心区域的像素亮度分布
  const { PNG } = await import("pngjs")
  const img = PNG.sync.read(png)
  console.log("size:", img.width, "x", img.height)
  let dark = 0, mid = 0, light = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const luma = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    if (luma < 60) dark++
    else if (luma < 160) mid++
    else light++
  }
  const total = img.data.length / 4
  console.log(`dark=${(dark / total * 100).toFixed(1)}% mid=${(mid / total * 100).toFixed(1)}% light=${(light / total * 100).toFixed(1)}%`)

  // 页面滚动高度（判断是否真加载了内容）
  const info = await tab.evalJs(`({sh: document.documentElement.scrollHeight, ih: innerHeight, imgs: document.images.length, ready: document.readyState})`)
  console.log("page:", JSON.stringify(info))

  // 诊断：页面是否被检测为 headless —— 检查关键元素可见性
  const probe = await tab.evalJs(`(() => {
    const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { s, w: Math.round(r.width), h: Math.round(r.height), op: getComputedStyle(e).opacity, vis: getComputedStyle(e).visibility, disp: getComputedStyle(e).display } }
    return {
      ua: navigator.userAgent.slice(0, 100),
      webdriver: navigator.webdriver,
      boxes: ['#b_content', '#sb_form', '#sb_form_q', 'form', 'h1', '#b_results', 'header', 'main', 'img'].map(q).filter(Boolean),
    }
  })()`)
  console.log("probe:", JSON.stringify(probe, null, 1))
} finally {
  edge.quit()
}
