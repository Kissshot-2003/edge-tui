// 可读性验收：文字型页面能否在字符画里读出来
import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"
import fs from "node:fs"

const CELL_W = 4, CELL_H = 8
const PAGE_BG = [11, 23, 38]
const W = 110, H = 36
const PAGE_COLS = W - 2, PAGE_ROWS = H - 3 - 5

const edge = await launchEdge({ width: PAGE_COLS * CELL_W, height: PAGE_ROWS * CELL_H })
const { tab } = edge
try {
  const pages = [
    ["https://example.com", "example.com（纯文字基准）"],
    ["https://www.zhihu.com/signin", "知乎登录（参考）"],
  ]
  for (const [url, label] of pages) {
    await tab.navigate(url)
    await new Promise((r) => setTimeout(r, 2200))
    await tab.setViewport(PAGE_COLS * CELL_W, PAGE_ROWS * CELL_H)
    await new Promise((r) => setTimeout(r, 300))
    const png = await tab.screenshot(false)
    const g = pngToGrid(png, CELL_W, CELL_H, PAGE_BG, { contrast: 1.35 })
    console.log(`\n════ ${label} ════ luma=${g.avgLuma.toFixed(0)} lightText=${g.lightText} ${g.cols}x${g.rows}`)
    for (let r = 0; r < Math.min(g.rows, PAGE_ROWS); r++) {
      let line = ""
      for (let c = 0; c < PAGE_COLS; c++) {
        const i = r * g.cols + c
        line += i < g.chars.length ? String.fromCharCode(g.chars[i]) : " "
      }
      const t = line.replace(/\s+$/, "")
      if (t.trim()) console.log(t)
    }
  }
} finally {
  edge.quit()
}
