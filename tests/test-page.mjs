import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1024, height: 900 })
try {
  const tab = edge.tab
  await tab.navigate("https://www.bing.com")
  await tab.setViewport(392, 400)
  await new Promise((r) => setTimeout(r, 8000))
  const info = await tab.evalJs(`({ title: document.title, sh: document.documentElement.scrollHeight, text: (document.body?.innerText || '').slice(0, 300), bg: getComputedStyle(document.body).backgroundColor, links: document.querySelectorAll('a').length })`)
  console.log(JSON.stringify(info, null, 1))
  const shot = await tab.evalJs(`getComputedStyle(document.body).backgroundImage.slice(0, 60)`)
  console.log("body bgImage:", shot)
} finally {
  edge.quit()
}