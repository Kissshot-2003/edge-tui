import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1024, height: 900 })
try {
  const tab = edge.tab
  await tab.navigate("https://www.bing.com/search?q=test")
  await tab.setViewport(392, 400)
  await new Promise((r) => setTimeout(r, 2000))
  const before = await tab.evalJs(`({ tag: document.activeElement?.tagName, hasInput: !!document.querySelector('input[name=q], input[type=search], input[type=text], textarea, form input') })`)
  console.log("before:", JSON.stringify(before))
  await tab.evalJs(`(() => {
    const el = document.querySelector('input[placeholder], input[name=q], input[type=search], input[type=text], textarea')
    if (el) { el.focus(); el.select() }
    return document.activeElement?.outerHTML?.slice(0, 120) || null
  })()`)
  const active = await tab.evalJs(`({ tag: document.activeElement?.tagName, name: document.activeElement?.name, type: document.activeElement?.type, ph: document.activeElement?.placeholder })`)
  console.log("active:", JSON.stringify(active))
  await tab.insertText("opencode 浏览器")
  await new Promise((r) => setTimeout(r, 300))
  const value = await tab.evalJs(`({ v: document.activeElement?.value, tag: document.activeElement?.tagName, name: document.activeElement?.name })`)
  console.log("typed value:", JSON.stringify(value))
  await tab.keyTap("Enter", "Enter", 13)
  await new Promise((r) => setTimeout(r, 3000))
  const after = await tab.evalJs(`({ u: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 60) })`)
  console.log("after enter:", JSON.stringify(after))
  console.log("OK")
} finally {
  edge.quit()
}