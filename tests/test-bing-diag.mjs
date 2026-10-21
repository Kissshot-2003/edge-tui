// 诊断：Bing 页面为什么整屏 @
import { launchEdge } from "../src/cdp.js"
import { PNG } from "pngjs"
import fs from "node:fs"

const edge = await launchEdge({ width: 980, height: 800 })
const { tab } = edge
try {
  await tab.navigate("https://www.bing.com")
  await tab.setViewport(980, 800)
  await new Promise((r) => setTimeout(r, 3000))
  const png = await tab.screenshot(false)
  fs.writeFileSync("probe-bing.png", png)
  const p = PNG.sync.read(png)
  const { width: pw, height: ph, data } = p
  const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
  const CELL_W = 10, CELL_H = 8

  let sum = 0, n = 0
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (y * pw + x) * 4
    sum += lumaOf(data[i], data[i + 1], data[i + 2]); n++
  }
  console.log("整图平均亮度 =", (sum / n).toFixed(1), " 尺寸", pw, ph)

  const cols = Math.floor(pw / CELL_W), rows = Math.floor(ph / CELL_H)
  const report = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let R = 0, G = 0, B = 0, cnt = 0, minL = 255, maxL = 0
    const hist = new Map()
    for (let y = r * CELL_H; y < r * CELL_H + CELL_H; y++)
      for (let x = c * CELL_W; x < c * CELL_W + CELL_W; x++) {
        const i = (y * pw + x) * 4
        R += data[i]; G += data[i + 1]; B += data[i + 2]; cnt++
        const l = lumaOf(data[i], data[i + 1], data[i + 2])
        if (l < minL) minL = l
        if (l > maxL) maxL = l
        const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
        hist.set(k, (hist.get(k) || 0) + 1)
      }
    let mk = 0, mc = 0
    for (const [k, v] of hist) if (v > mc) { mc = v; mk = k }
    const modeL = lumaOf(((mk >> 8) & 0xf) << 4, ((mk >> 4) & 0xf) << 4, (mk & 0xf) << 4)
    const localL = lumaOf(R / cnt, G / cnt, B / cnt)
    report.push({ r, c, localL: +localL.toFixed(1), modeL, flat: +(mc / cnt).toFixed(2), minL: +minL.toFixed(0), maxL: +maxL.toFixed(0) })
  }
  console.log("\n前 12 格采样 (localL / modeL / flatness / min-max):")
  report.slice(0, 12).forEach((x) => console.log(`  [r${x.r} c${x.c}] local=${x.localL} mode=${x.modeL} flat=${x.flat} range=${x.minL}-${x.maxL}`))
  const flats = report.filter((x) => x.flat > 0.75)
  console.log(`\nflat>0.75 的格子: ${flats.length}/${report.length}`)
  console.log("这些格的 modeL 平均 =", flats.length ? (flats.reduce((a, x) => a + x.modeL, 0) / flats.length).toFixed(1) : "N/A")
  const avgAll = report.reduce((a, x) => a + x.localL, 0) / report.length
  console.log("所有格 localL 平均 =", avgAll.toFixed(1))
} finally {
  edge.quit()
}
