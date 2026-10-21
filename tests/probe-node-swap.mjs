// 探针：站点把输入框节点整个换掉（React/Preact 重挂载、站点 focus 后换新节点）
// 之后，CDP 输入是不是就"静默失效"了？这是"打字没反应"最真实的成因。
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("data:text/html,<input id=q name=q type=search data-etui-field=0 placeholder=x><textarea id=t></textarea>")
  await new Promise((r) => setTimeout(r, 400))

  const val = (sel) => tab.evalJs(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`)
  const active = () => tab.evalJs("(() => { const a=document.activeElement; return a? a.tagName+'#'+(a.id||'') : null })()")

  // ── 场景 A：正常流程 ──
  await tab.evalJs("document.getElementById('q').focus()")
  await tab.insertText("A")
  console.log(`A 正常聚焦         : value=${JSON.stringify(await val("#q"))} active=${await active()}`)

  // ── 场景 B：节点被换掉（旧节点持有焦点，随后被整体替换）──
  await tab.evalJs(`(() => {
    const old = document.getElementById('q')
    const nu = document.createElement('input')
    nu.id = 'q'; nu.name = 'q'; nu.type = 'search'; nu.setAttribute('data-etui-field','0')
    old.replaceWith(nu)          // 只换节点，不动文档结构
    return true
  })()`)
  console.log(`B 换节点后         : value=${JSON.stringify(await val("#q"))} active=${await active()}`)
  await tab.insertText("B")
  console.log(`B insertText('B')  : value=${JSON.stringify(await val("#q"))}   ← 静默失效？`)

  // ── 场景 C：读回校验 + 重新聚焦后重送（自愈第 1 级）──
  await tab.evalJs(`document.querySelector('[data-etui-field="0"]').focus()`)
  await tab.insertText("C")
  console.log(`C 重新聚焦再送     : value=${JSON.stringify(await val("#q"))} active=${await active()}`)

  // ── 场景 D：把 focus() 覆盖成空函数，看还剩哪条路 ──
  // 注意结论：`insertText` **仍然生效** —— 说明"浏览器内部记住的焦点"和
  // `document.activeElement` 是两码事：覆盖 focus() 只影响以后调用它的代码，
  // 不影响内部已经记住的目标。所以想制造"送不进去"，只能靠**换掉节点**
  // （场景 B：旧节点脱离文档，内部焦点跟着废掉）。
  await tab.evalJs(`(() => { const el=document.querySelector('[data-etui-field="0"]'); el.focus = function(){}; return true })()`)
  await tab.evalJs(`document.querySelector('[data-etui-field="0"]').blur()`)
  await tab.evalJs(`(() => { const el=document.querySelector('[data-etui-field="0"]'); window.__ev=0; el.addEventListener('input',()=>{window.__ev++}); return true })()`)
  await tab.insertText("D")
  console.log(`D focus 被覆盖后送字: value=${JSON.stringify(await val("#q"))}   ← 仍生效（内部焦点还在）`)
  const domVal = await tab.insertTextDom("0", "E")
  console.log(`D DOM 注入返回     : ${JSON.stringify(domVal)}  input 事件 ${await tab.evalJs("window.__ev")} 次`)

  // ── 场景 E：焦点在别的控件上时送字会去哪 ──
  await tab.evalJs("document.getElementById('t').focus()")
  await tab.insertText("Z")
  console.log(`E 焦点在 textarea  : q=${JSON.stringify(await val("#q"))} t=${JSON.stringify(await val("#t"))}`)
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
