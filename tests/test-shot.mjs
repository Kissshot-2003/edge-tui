import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"

const edge = await launchEdge({ width: 1024, height: 900 })
try {
  const tab = edge.tab
  await tab.navigate("https://www.bing.com")
  const info = await tab.pageInfo()
  console.log("after navigate:", JSON.stringify(info), "url:", info.u)
  await new Promise((r) => setTimeout(r, 1500))
  const info2 = await tab.pageInfo()
  console.log("after 1.5s:", JSON.stringify(info2))
  const pxH = Math.min(info2.sh + 40, 24000)
  await tab.setViewport(400, pxH)
  await new Promise((r) => setTimeout(r, 500))
  const info3 = await tab.pageInfo()
  console.log("after viewport:", JSON.stringify(info3))
  const png = await tab.screenshot(true)
  console.log("png bytes:", png.length)
  const { PNG } = await import("pngjs")
  const meta = PNG.sync.read(png)
  console.log("png size:", meta.width, "x", meta.height)
  const grid = pngToGrid(png, 4, 8, [28, 28, 28])
  console.log("grid:", grid.rows, "x", grid.cols)
  let nonSpace = 0, rows = 0
  for (let y = 0; y < grid.rows; y++) {
    let has = false
    for (let x = 0; x < grid.cols; x++) {
      const c = grid.chars[y * grid.cols + x]
      if (c !== 32 && c !== 46) { nonSpace++; has = true }
    }
    if (has) rows++
  }
  console.log("non-space cells:", nonSpace, "non-empty rows:", rows)
  // 打印前 12 行
  for (let y = 0; y < Math.min(12, grid.rows); y++) {
    console.log(String(y).padStart(2, " ") + "|" + String.fromCharCode(...grid.chars.subarray(y * grid.cols, y * grid.cols + Math.min(80, grid.cols))) + "|")
  }
} finally {
  edge.quit()
}