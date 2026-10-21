import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"

const edge = await launchEdge({ width: 800, height: 600 })
const tab = edge.tab
try {
  await tab.navigate("https://example.com")
  const info = await tab.pageInfo()
  console.log("page:", info.t, "|", info.u, "| height px:", info.sh)
  await tab.setViewport(64 * 4, 600)
  const png = await tab.screenshot(false)
  console.log("png bytes:", png.length)
  const grid = pngToGrid(png, 4, info.sh > 600 ? 8 : 8)
  console.log("grid:", grid.cols, "x", grid.rows)
  const first = String.fromCharCode(...grid.chars.slice(0, 30))
  console.log("sample:", JSON.stringify(first))
  console.log("OK")
} finally {
  edge.quit()
}
