import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"

const edge = await launchEdge({ width: 1024, height: 900 })
try {
  const tab = edge.tab
  await tab.navigate("https://www.bing.com")
  await tab.setViewport(980, 800)
  await new Promise((r) => setTimeout(r, 3000))
  const info = await tab.evalJs(`({ title: document.title, sh: document.documentElement.scrollHeight, text: (document.body?.innerText || '').slice(0, 160), bg: getComputedStyle(document.body).backgroundColor })`)
  console.log(JSON.stringify(info))
  const png = await tab.screenshot(false)
  const grid = pngToGrid(png, 10, 8, [28, 28, 28])
  console.log("grid:", grid.rows, "x", grid.cols)
  for (let y = 0; y < Math.min(20, grid.rows); y++) {
    console.log(String(y).padStart(2, " ") + "|" + String.fromCharCode(...grid.chars.subarray(y * grid.cols, y * grid.cols + grid.cols)) + "|")
  }
} finally {
  edge.quit()
}