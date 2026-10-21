// 探针：Input.dispatchKeyEvent 的 Enter 到底能不能触发 <form> 隐式提交？
// 三种派发方式对比：keyDown+keyUp / rawKeyDown / 带 text:"\r"
import { launchEdge } from "../src/cdp.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "field-page.html")).href
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate(fixture)
  await new Promise((r) => setTimeout(r, 600))
  // 记录所有键盘事件与提交事件，看到底哪一环断了
  await tab.evalJs(`(() => {
    window.__log = []
    const kw = document.getElementById('kw')
    kw.addEventListener('keydown', (e) => window.__log.push('keydown:' + e.key + ' vk=' + e.keyCode))
    kw.addEventListener('keypress', (e) => window.__log.push('keypress:' + e.key))
    document.getElementById('sf').addEventListener('submit', () => window.__log.push('submit'))
    window.__submitted = ''
    return true
  })()`)
  await tab.evalJs("document.getElementById('kw').focus()")

  const send = async (label, frames) => {
    await tab.evalJs("window.__log = []; window.__submitted = ''")
    for (const f of frames) await tab.conn.send("Input.dispatchKeyEvent", f)
    await new Promise((r) => setTimeout(r, 250))
    const log = await tab.evalJs("JSON.stringify(window.__log)")
    const sub = await tab.evalJs("window.__submitted")
    console.log(`${label.padEnd(34)} log=${log} submitted="${sub}"`)
  }

  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 }
  await send("A keyDown+keyUp（现状）", [{ type: "keyDown", ...base }, { type: "keyUp", ...base }])
  await send("B rawKeyDown+keyUp", [{ type: "rawKeyDown", ...base }, { type: "keyUp", ...base }])
  await send("C rawKeyDown+char+keyUp", [
    { type: "rawKeyDown", ...base },
    { type: "char", text: "\r", unmodifiedText: "\r", ...base },
    { type: "keyUp", ...base },
  ])
  await send("D keyDown 带 text:\\r + keyUp", [
    { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base },
    { type: "keyUp", ...base },
  ])
} finally {
  try { await edge.quit() } catch {}
}
