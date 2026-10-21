// 高级交互探针：双击（真实连击）/ 拖拽滑块（三段鼠标序列）/ 文件上传（CDP
// file chooser 拦截）/ 同源 iframe（递归枚举 + 坐标换算 + 文字提取）。
// 逐项验证「传统浏览器能做到的，这里也能」。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>高级交互探针</title></head><body>
<div id="dbl" tabindex="0" style="width:120px;padding:8px;border:1px solid #999">双击我</div>

<div id="track" style="position:relative;width:300px;height:30px;background:#eee;margin:10px 0">
  <div id="handle" tabindex="0" style="position:absolute;left:0;top:0;width:40px;height:30px;background:#36c"></div>
  <span id="right" tabindex="0" style="position:absolute;right:0;top:6px;width:20px;height:18px">⇥</span>
</div>

<input type="file" id="up">
<div id="upnote">尚未选择</div>

<iframe id="inner" src="/inner" style="width:320px;height:90px;border:1px solid #ccc"></iframe>
<iframe id="cross" src="data:text/html,<p>cross-origin</p>" style="width:120px;height:40px;border:1px dashed #ccc"></iframe>

<script>
window.__st = { clicks: 0, dbl: 0, down: 0, moves: 0, up: 0, x: 0, files: [] }
document.getElementById("dbl").addEventListener("click", () => window.__st.clicks++)
document.getElementById("dbl").addEventListener("dblclick", () => window.__st.dbl++)
var h = document.getElementById("handle"), track = document.getElementById("track"), drag = false
h.addEventListener("mousedown", () => { drag = true; window.__st.down++ })
document.addEventListener("mousemove", (e) => {
  if (!drag) return
  window.__st.moves++
  var r = track.getBoundingClientRect()
  var x = Math.max(0, Math.min(260, e.clientX - r.left - 20))
  h.style.left = x + "px"
  window.__st.x = x
})
document.addEventListener("mouseup", () => { if (drag) { drag = false; window.__st.up++ } })
document.getElementById("up").addEventListener("change", (e) => {
  window.__st.files = Array.from(e.target.files).map((f) => f.name)
  document.getElementById("upnote").textContent = "已选 " + window.__st.files.join(",")
})
</script></body></html>`

const INNER = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="ib" onclick="parent.window.__st.ifClick=(parent.window.__st.ifClick||0)+1">iframe按钮</button>
<input id="ii" placeholder="内嵌输入框">
</body></html>`

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8")
  res.end(req.url === "/inner" ? INNER : PAGE)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${server.address().port}/`

// 真实临时文件（上传用）
const tmpFile = path.join(os.tmpdir(), "etui-probe-upload.txt")
fs.writeFileSync(tmpFile, "探针上传内容", "utf8")

let edge = null
try {
  edge = await launchEdge({ width: 880, height: 560 })
  const tab = edge.tab
  await tab.navigate(BASE, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 500))

  // ── F. 同源 iframe：递归枚举 + 坐标换算 + 真实点击 ──
  const els = await tab.enumerateInteractive(880, 560)
  const ifBtnIdx = els.findIndex((e) => /iframe按钮/.test(e.text || ""))
  ok("F1 iframe 内的按钮被递归枚举出来", ifBtnIdx >= 0, `els=${els.length}`)
  const ifInputIdx = els.findIndex((e) => e.tag === "INPUT" && /内嵌/.test(e.text || ""))
  ok("F2 iframe 内的输入框也在清单里", ifInputIdx >= 0)
  if (ifBtnIdx >= 0) {
    const box = await tab.clickIndex(ifBtnIdx)
    await new Promise((r) => setTimeout(r, 250))
    const c = await tab.evalJs("window.__st.ifClick || 0")
    ok("F3 真实点击 iframe 内按钮命中（坐标跨 frame 换算正确）",
      c >= 1 && box && !box.offscreen, `ifClick=${c}`)
  }

  // ── G. 双击 ──
  const dblIdx = els.findIndex((e) => /双击我/.test(e.text || ""))
  ok("G1 找到双击目标", dblIdx >= 0)
  if (dblIdx >= 0) {
    await tab.dblClickIndex(dblIdx)
    await new Promise((r) => setTimeout(r, 250))
    const st = await tab.evalJs("({ c: window.__st.clicks, d: window.__st.dbl })")
    ok("G2 dblclick 事件触发（clickCount 语义）", st.d >= 1, JSON.stringify(st))
    ok("G3 click 也计数（两次按压 = 2 次点击）", st.c >= 2, `clicks=${st.c}`)
  }

  // ── H. 拖拽滑块 ──
  const hIdx = els.findIndex((e) => e.tag === "DIV" && false) // handle 是纯色 div 无文字，改用坐标找
  // handle/text 都是空文本 —— 用枚举返回的几何信息找：最左侧的小方块
  const els2 = await tab.enumerateInteractive(880, 560)
  let handleIdx = -1, rightIdx = -1
  for (const e of els2) {
    if (e.tag === "SPAN" && /⇥/.test(e.text || "")) rightIdx = e.i
    if (e.tag === "DIV" && !e.text.replace(/\(div\)/, "").trim() && e.w === 40 && e.h === 30) handleIdx = e.i
  }
  ok("H1 找到滑块把手与右端目标", handleIdx >= 0 && rightIdx >= 0,
    `handle=${handleIdx} right=${rightIdx}`)
  if (handleIdx >= 0 && rightIdx >= 0) {
    const r = await tab.dragEls(handleIdx, rightIdx)
    await new Promise((r2) => setTimeout(r2, 300))
    const st = await tab.evalJs("({ x: window.__st.x, down: window.__st.down, moves: window.__st.moves, up: window.__st.up })")
    ok("H2 三段序列完整（按下→移动→松开）", st.down === 1 && st.up === 1 && st.moves >= 5, JSON.stringify(st))
    ok("H3 滑块真的被拖到了右端", st.x >= 180, `x=${st.x}`)
    ok("H4 拖拽结果返回两端盒子", !!r.a && !!r.b && !r.a.offscreen && !r.b.offscreen)
  }

  // ── I. 文件上传 ──
  const els3 = await tab.enumerateInteractive(880, 560)
  const upIdx = els3.findIndex((e) => e.tag === "INPUT" && e.type === "file")
  ok("I1 元素清单里有文件控件（type=file）", upIdx >= 0)
  if (upIdx >= 0) {
    const r = await tab.uploadToIndex(upIdx, [tmpFile])
    await new Promise((r2) => setTimeout(r2, 300))
    ok("I2 CDP 写入成功（file chooser 拦截）", r.ok === true, JSON.stringify(r))
    const st = await tab.evalJs(`({
      n: document.getElementById("up").files.length,
      name: (document.getElementById("up").files[0] || {}).name || "",
      note: document.getElementById("upnote").textContent,
    })`)
    ok("I3 input.files 真的有了文件", st.n === 1 && /probe-upload/.test(st.name), JSON.stringify(st))
    ok("I4 change 事件触发（站点侧「已选文件」更新）", /已选/.test(st.note), `note=${st.note}`)
    // 非文件控件应当被拒绝
    const dblIdx2 = els3.findIndex((e) => /双击我/.test(e.text || ""))
    const bad = await tab.uploadToIndex(dblIdx2, [tmpFile])
    ok("I5 非文件控件被拒绝（notfile）", bad.ok === false && bad.why === "notfile", JSON.stringify(bad))
  }

  // ── J. iframe 文字提取 ──
  const page = await buildTextPage(tab, { width: 72, viewport: false, indent: 1 })
  const allText = (page.blocks || []).map((b) => b.text || b.alt || "").join("\\n")
  ok("J1 同源 iframe 的文字并进主文档流", /iframe按钮/.test(allText))
  ok("J2 跨源 iframe 如实标注（不假装读到）", /跨域 iframe/.test(allText))
} catch (e) {
  fail++; console.log(`  ✗ 探针异常：${e?.stack || e}`)
} finally {
  try { edge?.quit() } catch {}
  try { fs.unlinkSync(tmpFile) } catch {}
}

server.close()
console.log(`\\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
