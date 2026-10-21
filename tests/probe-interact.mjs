// 页面交互对齐真实浏览器探针：hover 菜单 / change 事件 / select 换选项 /
// contenteditable 富文本 / 修饰键组合。逐项验证「传统浏览器能做到的，这里也能」。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import { typeIntoField, backspaceField } from "../src/inputpath.js"
import http from "node:http"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>交互探针</title><style>
#submenu { display: none; position: absolute; background: #fff; border: 1px solid #ccc; }
#nav:hover #submenu { display: block; }
</style></head><body>
<div id="nav" tabindex="0" style="width:120px">商品分类
  <div id="submenu"><a href="#" id="item1">子菜单项一</a><br><a href="#" id="item2">子菜单项二</a></div>
</div>
<input id="phone" placeholder="手机号">
<select id="city"><option>合肥</option><option>芜湖</option><option>安庆</option></select>
<div id="editor" contenteditable="true" style="width:300px;height:60px;border:1px solid #999"></div>
<script>
window.__counts = { over: 0, change: 0, input: 0, keys: [] }
document.getElementById("nav").addEventListener("mouseover", () => window.__counts.over++)
document.getElementById("phone").addEventListener("change", () => window.__counts.change++)
document.getElementById("phone").addEventListener("input", () => window.__counts.input++)
document.getElementById("city").addEventListener("change", () => window.__counts.change++)
document.addEventListener("keydown", (e) => {
  window.__counts.keys.push({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey })
})
</script></body></html>`

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8")
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${server.address().port}/`

let edge = null
try {
  edge = await launchEdge({ width: 880, height: 520 })
  const tab = edge.tab
  await tab.navigate(BASE, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 500))
  const page = await buildTextPage(tab, { width: 72, viewport: false, indent: 1 })
  const fieldOf = (pred) => (page.fields || []).find(pred)

  // ── A. contenteditable 富文本 ──
  const rich = fieldOf((f) => f.type === "richtext")
  ok("A1 contenteditable 被提取为一等公民控件", !!rich, rich ? `fid=${rich.fid}` : "fields=" + JSON.stringify((page.fields || []).map(f => f.tag + ":" + f.type)))
  if (rich) {
    await tab.focusField(rich.fid)
    const r1 = await typeIntoField(tab, rich, "你好世界")
    ok("A2 富文本打字成功", /你好世界/.test(r1.value || ""), `value=${JSON.stringify(r1.value)} via=${r1.via}`)
    const r2 = await backspaceField(tab, rich)
    ok("A3 富文本退格成功", r2.value !== null && !/界\s*$/.test(r2.value || "界"), `value=${JSON.stringify(r2.value)}`)
  }

  // ── B. change 事件（对齐真实浏览器失焦语义）──
  const phone = fieldOf((f) => f.tag === "INPUT" && !f.btn)
  ok("B1 找到输入框", !!phone)
  if (phone) {
    await tab.focusField(phone.fid)
    await typeIntoField(tab, phone, "13812345678")
    const before = await tab.evalJs("window.__counts.change")
    await tab.fireChange(phone.fid)
    const after = await tab.evalJs("window.__counts.change")
    ok("B2 fireChange 触发站点 change 校验", after === before + 1, `${before} → ${after}`)
  }

  // ── C. 原生 select 换选项 ──
  const city = fieldOf((f) => f.tag === "SELECT")
  ok("C1 找到下拉框", !!city)
  if (city) {
    const v1 = await tab.selectStep(city.fid, 1)
    ok("C2 ↓ 换到下一项并返回新文本", v1 === "芜湖", JSON.stringify(v1))
    const chg = await tab.evalJs("window.__counts.change")
    ok("C3 换选项触发了 change", chg >= 2, `change=${chg}`)
    const v2 = await tab.selectStep(city.fid, -5)
    ok("C4 越界返回 null 且不动", v2 === null)
    const v3 = await tab.selectStep(city.fid, -1)
    ok("C5 ↑ 回到上一项", v3 === "合肥", JSON.stringify(v3))
  }

  // ── D. hover 展开菜单 ──
  const els = await tab.enumerateInteractive(880, 520)
  const navIdx = els.findIndex((e) => /商品分类/.test(e.text || ""))
  ok("D1 元素清单里有导航项", navIdx >= 0, `els=${els.length}`)
  if (navIdx >= 0) {
    await tab.hoverEl(navIdx)
    await new Promise((r) => setTimeout(r, 250))
    const st = await tab.evalJs(`(() => ({
      vis: getComputedStyle(document.getElementById("submenu")).display,
      over: window.__counts.over,
    }))()`)
    ok("D2 hover 后子菜单展开（:hover 生效）", st.vis === "block", `display=${st.vis}`)
    ok("D3 mouseover 事件触发", st.over >= 1, `over=${st.over}`)
    // hover 链：鼠标移到子菜单项上，父菜单不收起（真实浏览器行为）
    const els2 = await tab.enumerateInteractive(880, 520)
    const itemIdx = els2.findIndex((e) => /子菜单项一/.test(e.text || ""))
    ok("D4 展开的子菜单项出现在元素清单里", itemIdx >= 0)
    if (itemIdx >= 0) {
      await tab.hoverEl(itemIdx)
      await new Promise((r) => setTimeout(r, 250))
      const st2 = await tab.evalJs(`getComputedStyle(document.getElementById("submenu")).display`)
      ok("D5 鼠标移到子项上菜单仍展开（hover 链保持）", st2 === "block", `display=${st2}`)
    }
  }

  // ── E. 修饰键组合 ──
  await tab.focusField(phone.fid)
  await tab.pressCombo("a", 2)
  await new Promise((r) => setTimeout(r, 200))
  const k1 = await tab.evalJs(`(() => { const k = window.__counts.keys; return k[k.length - 1] || {} })()`)
  ok("E1 Ctrl+A 到达页面（ctrlKey=true）", k1.key === "a" && k1.ctrl === true, JSON.stringify(k1))
  await tab.pressArrow("down", 8)
  await new Promise((r) => setTimeout(r, 200))
  const k2 = await tab.evalJs(`(() => { const k = window.__counts.keys; return k[k.length - 1] || {} })()`)
  ok("E2 Shift+↓ 到达页面（shiftKey=true）", k2.key === "ArrowDown" && k2.shift === true, JSON.stringify(k2))
  await tab.pressEditKey("end")
  await new Promise((r) => setTimeout(r, 200))
  const k3 = await tab.evalJs(`(() => { const k = window.__counts.keys; return k[k.length - 1] || {} })()`)
  ok("E3 End 编辑键到达页面", k3.key === "End", JSON.stringify(k3))
} catch (e) {
  fail++; console.log(`  ✗ 探针异常：${e?.stack || e}`)
} finally {
  try { edge?.quit() } catch {}
}

server.close()
console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
