// 探查：文字模式下点击输入框后，DOM 焦点与输入是否正常工作
import { launchEdge } from "../src/cdp.js"
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1500))
  await tab.scrollTarget()
  const sp = await tab.scrollState()
  const els = await tab.enumerateInteractive(sp.iw, sp.ih)
  const p = els.find((e) => /手机号/.test(e.text || ""))
  console.log("手机号元素:", JSON.stringify(p))
  const box = await tab.scrollElIntoView(p.i)
  console.log("scrollElIntoView:", JSON.stringify(box))
  const hit = await tab.clickIndex(p.i)
  console.log("clickIndex:", JSON.stringify(hit))
  await new Promise((r) => setTimeout(r, 300))
  const active = await tab.evalJs(`(()=>{const a=document.activeElement;return a?{tag:a.tagName,name:a.name,type:a.type,ph:a.placeholder,cls:String(a.className).slice(0,40)}:null})()`)
  console.log("activeElement:", JSON.stringify(active))
  await tab.insertText("13900139000")
  await new Promise((r) => setTimeout(r, 300))
  const v = await tab.evalJs(`(()=>{const i=document.querySelector('input');return i?{v:i.value,name:i.name,ph:i.placeholder}:null})()`)
  console.log("输入框:", JSON.stringify(v))
} catch (e) { console.error(e?.stack || e) } finally { try { await edge.quit() } catch {} }
