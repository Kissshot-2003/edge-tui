import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"

const t0 = Date.now()
const edge = await launchEdge({ width: 1024, height: 900 })
const tLaunch = Date.now() - t0
const tab = edge.tab
try {
  const t1 = Date.now()
  await tab.navigate("https://cn.bing.com/")
  const tNav = Date.now() - t1
  await tab.setViewport(976, 400)
  await new Promise((r) => setTimeout(r, 3000))
  const t2 = Date.now()
  const png = await tab.screenshot(false)
  const tShot = Date.now() - t2
  const t3 = Date.now()
  const grid = pngToGrid(png, 4, 8, [28, 28, 28])
  const tConv = Date.now() - t3
  console.log(JSON.stringify({ tLaunch, tNav, tShot, tConv, pngSize: png.length, grid: grid.cols + "x" + grid.rows }))
} finally {
  edge.quit()
}
