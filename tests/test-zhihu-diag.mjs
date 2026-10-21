// 诊断：为什么知乎渲染成一团噪声
import { launchEdge } from "../src/cdp.js"
import { PNG } from "pngjs"
import fs from "node:fs"

const CELL_W = 4, CELL_H = 8
const PAGE_BG = [11, 23, 38]
const edge = await launchEdge({ width: 432, height: 224 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(432, 224)
  await new Promise((r) => setTimeout(r, 300))
  const png = await tab.screenshot(false)
  fs.writeFileSync("probe.png", png)
  const p = PNG.sync.read(png)
  const { width: pw, height: ph, data } = p

  // 统计像素亮度分布
  const hist = new Array(10).fill(0)
  let sum = 0, n = 0
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (y * pw + x) * 4
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    hist[Math.min(9, Math.floor(l / 25.6))]++
    sum += l; n++
  }
  console.log("整图平均亮度 =", (sum / n).toFixed(1))
  console.log("亮度直方图（每档 25.6）:")
  hist.forEach((c, i) => console.log(`  ${i * 25.6 | 0}-${(i + 1) * 25.6 | 0}: ${(c / n * 100).toFixed(1)}%`))

  // 逐格统计：底色占比 vs 文字占比
  const cols = Math.floor(pw / CELL_W), rows = Math.floor(ph / CELL_H)
  let flatCells = 0, mixedCells = 0
  let bgModeCount = {}
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let minL = 255, maxL = 0
    let rs = 0, gs = 0, bs = 0
    for (let y = r * CELL_H; y < r * CELL_H + CELL_H; y++)
      for (let x = c * CELL_W; x < c * CELL_W + CELL_W; x++) {
        const i = (y * pw + x) * 4
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        if (l < minL) minL = l
        if (l > maxL) maxL = l
        rs += data[i]; gs += data[i + 1]; bs += data[i + 2]
      }
    rs /= 32; gs /= 32; bs /= 32
    const key = `${rs | 0},${gs | 0},${bs | 0}`
    bgModeCount[key] = (bgModeCount[key] || 0) + 1
    if (maxL - minL < 12) flatCells++; else mixedCells++
  }
  console.log(`\n格子统计：纯色格 ${flatCells} / 混合格 ${mixedCells}`)
  console.log("最常见格子颜色 top5:")
  Object.entries(bgModeCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([k, v]) => console.log(`  rgb(${k}) x${v}`))

  // 取几个具体位置的真实像素，确认到底什么颜色
  console.log("\n采样：")
  const sample = (px, py, label) => {
    const i = (py * pw + px) * 4
    console.log(`  ${label} (${px},${py}) = rgb(${data[i]},${data[i + 1]},${data[i + 2]})`)
  }
  sample(20, 20, "左上装饰区")
  sample(300, 100, "中部")
  sample(360, 170, "右侧")
  sample(5, 200, "左下")
} finally {
  edge.quit()
}
