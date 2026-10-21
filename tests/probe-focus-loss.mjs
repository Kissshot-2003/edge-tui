// 探针：CDP 输入在「焦点丢失」时到底是不是静默失效？
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("data:text/html,<input id=q type=search name=q placeholder=x><textarea id=t></textarea><button id=b>go</button>")
  await new Promise((r) => setTimeout(r, 400))

  const st = () => tab.evalJs("(() => { const a=document.activeElement; return { tag:a&&a.tagName, id:a&&a.id, v:document.getElementById('q').value } })()")

  console.log("初始：", JSON.stringify(await st()))
  console.log("\n── 聚焦 q 后 ──")
  await tab.evalJs("document.getElementById('q').focus()")
  console.log("状态：", JSON.stringify(await st()))
  await tab.insertText("A")
  console.log("insertText('A') 后：", JSON.stringify(await st()))

  console.log("\n── blur 后（无任何焦点元素）──")
  const blurred = await tab.evalJs("(() => { const a=document.activeElement; if(a&&a.blur) a.blur(); return { tag:document.activeElement&&document.activeElement.tagName, id:document.activeElement&&document.activeElement.id } })()")
  console.log("blur 结果：", JSON.stringify(blurred))
  await tab.insertText("B")
  console.log("insertText('B') 后：", JSON.stringify(await st()))

  console.log("\n── blur 后按 Backspace ──")
  await tab.pressBackspace()
  console.log("pressBackspace 后：", JSON.stringify(await st()))

  console.log("\n── blur 后按 Enter（会不会提交?）──")
  await tab.evalJs("window.__s = ''")
  await tab.pressEnter()
  console.log("pressEnter 后：", JSON.stringify(await st()))

  console.log("\n── 聚焦到另一个控件 (textarea) 后打给 q ──")
  await tab.evalJs("document.getElementById('t').focus()")
  await tab.insertText("C")
  console.log("状态：", JSON.stringify(await st()),
    " textarea=", JSON.stringify(await tab.evalJs("document.getElementById('t').value")))
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
