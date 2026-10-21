import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1200, height: 900 })
try {
  const tab = edge.tab
  for (const w of [392, 400, 500, 512, 768]) {
    await tab.setViewport(w, 940)
    const s = await tab.evalJs(`window.innerWidth + "x" + window.innerHeight + " dpr=" + window.devicePixelRatio`)
    console.log(w, "->", s)
  }
} finally {
  edge.quit()
}