// 探针：百度搜索框的 label 到底从哪来？
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.baidu.com", { timeoutMs: 15000 })
  const r = await tab.evalJs(`(() => {
    const el = document.querySelector('#chat-textarea')
    if (!el) return { none: true }
    const step = {}
    let lb = null
    try { lb = document.querySelector('label[for="chat-textarea"]') } catch (e) {}
    step.forLabel = lb ? (lb.innerText || '').slice(0, 60) : null
    const wl = el.closest('label')
    step.wrapLabel = wl ? (wl.innerText || '').slice(0, 60) : null
    step.wrapLabelTag = wl ? wl.tagName + '.' + String(wl.className).slice(0, 30) : null
    step.aria = el.getAttribute('aria-label')
    step.title = el.title
    const chain = []
    let n = el.parentElement, d = 0
    while (n && d < 6) { chain.push(n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : '')); n = n.parentElement; d++ }
    step.ancestors = chain
    return step
  })()`)
  console.log(JSON.stringify(r, null, 1))
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
