// 短信验证码登录探针：复现并验证「获取验证码 → 整页刷新 / 收不到验证码」的根因。
//
// 模拟一个典型的（略烂的）短信登录页：
//   · 手机号 + 验证码 + 「获取验证码」按钮（无 type，默认 submit 型）
//   · 站点 onsubmit 校验手机号：合法 → preventDefault（AJAX 登录，地址不变）；
//     不合法 → 放行 → 整页提交到 /login（烂站点常态）
//   · sendSms：手机号合法 → preventDefault + fetch /send-sms；不合法 → 直接 return
//     （不阻止默认 → 表单整页提交 —— 真实烂站点最常见的写法）
//
// 验证三件事：
//   A. 输入的手机号真的进了站点校验逻辑，点「获取验证码」走 AJAX、不整页刷新；
//   B. 回车提交：AJAX 站点拦截后地址不变是**正确行为**（真实浏览器同样如此）——
//      旧代码误判为"提交失败"，先 requestSubmit 强制再提交一遍，
//      上层 pageSubmit 还会把输入内容当搜索词直接跳 Bing → 用户看到的
//      「获取验证码把整个页面刷新了」即源于此。修复后：不强制提交、不劫持跳转。
//   C. 对照：手机号不合法时回车，站点自己放行整页提交 —— 真实浏览器同样行为，
//      不是本程序的 bug。
import { launchEdge } from "../src/cdp.js"
import { typeIntoField, submitField } from "../src/inputpath.js"
import http from "node:http"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const hits = []
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>短信登录</title></head><body>
<form id="f" action="/login" method="get" onsubmit="return guardSubmit(event)">
<h2>短信验证码登录</h2>
<input id="phone" name="phone" placeholder="请输入手机号">
<button id="sms" onclick="sendSms(event)">获取验证码</button>
<input id="code" name="code" placeholder="验证码" style="display:block;margin-top:8px">
<button type="submit">登录</button>
</form>
<script>
window.__submitCount = 0
function guardSubmit(e) {
  window.__submitCount++
  var p = document.getElementById("phone").value
  if (/^1\\d{10}$/.test(p)) { e.preventDefault(); return false }
  return true
}
function sendSms(e) {
  window.__smsCount = (window.__smsCount || 0) + 1
  var p = document.getElementById("phone").value
  if (!/^1\\d{10}$/.test(p)) return
  e.preventDefault()
  fetch("/send-sms?phone=" + p)
  document.getElementById("sms").textContent = "已发送(59)"
}
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost")
  hits.push({ path: u.pathname, phone: u.searchParams.get("phone") || "" })
  res.setHeader("content-type", "text/html; charset=utf-8")
  if (u.pathname === "/") res.end(PAGE)
  else res.end("<html><body><h1>表单被整页提交了</h1></body></html>")
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${server.address().port}/`

/** 与 run.mjs#waitUrlChange 同款判据 */
async function waitUrlChange(url0, totalMs) {
  const step = 150
  for (let waited = 0; waited < totalMs; waited += step) {
    await new Promise((r) => setTimeout(r, step))
    try {
      const u = await tab.evalJs("location.href")
      if (u && u !== url0) { await new Promise((r) => setTimeout(r, 420)); return u }
    } catch {}
  }
  return ""
}

let edge = null, tab = null
try {
  edge = await launchEdge({ width: 880, height: 520 })
  tab = edge.tab
  await tab.navigate(BASE, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 500))
  await tab.evalJs(`(() => {
    document.getElementById("phone").setAttribute("data-etui-field", "1")
    document.getElementById("code").setAttribute("data-etui-field", "2")
    return 1
  })()`)

  // ── A. 输入 + 点「获取验证码」 ──
  const fPhone = { fid: 1, tag: "INPUT", type: "text", text: "请输入手机号", value: "" }
  const r1 = await typeIntoField(tab, fPhone, "13812345678")
  ok("A1 手机号进入控件", r1.value === "13812345678", `via=${r1.via} value=${JSON.stringify(r1.value)}`)

  const box = await tab.evalJs(`(() => {
    const b = document.getElementById("sms").getBoundingClientRect()
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
  })()`)
  await tab.realClick(box.cx, box.cy)
  await new Promise((r) => setTimeout(r, 1200))
  const smsHit = hits.find((h) => h.path === "/send-sms")
  ok("A2 「获取验证码」走 AJAX：服务端收到手机号", smsHit?.phone === "13812345678",
    `hits=${JSON.stringify(hits)}`)
  const loc1 = await tab.evalJs("location.href")
  ok("A3 AJAX 点击后地址未变（没有整页刷新）", loc1 === BASE, loc1)
  const smsText = await tab.evalJs(`document.getElementById("sms").textContent`)
  ok("A4 按钮进入倒计时（站点状态认可了点击）", /已发送/.test(smsText), smsText)

  // ── B. 回车提交（bug 复现点：AJAX 站点拦截回车后，地址不变是正确行为）──
  // 注意本夹具里「获取验证码」按钮没写 type（默认 submit 型，且是表单里第一个
  // 提交按钮 = 隐式提交的**默认按钮**）：回车的隐式提交会合成一次对它的点击
  // （__smsCount +1），这是真实浏览器同款行为，不是程序造成的。
  const submitBefore = await tab.evalJs("window.__submitCount")
  const smsBefore = await tab.evalJs("window.__smsCount || 0")
  const loginBefore = hits.filter((h) => h.path === "/login").length
  const fCode = { fid: 2, tag: "INPUT", type: "text", text: "验证码", value: "" }
  const r2 = await submitField(tab, fCode, waitUrlChange, 1600)
  const loc2 = await tab.evalJs("location.href")
  const submitAfter = await tab.evalJs("window.__submitCount")
  const smsAfter = await tab.evalJs("window.__smsCount || 0")
  const loginAfter = hits.filter((h) => h.path === "/login").length
  ok("B1 AJAX 站点拦截回车后：地址未变、未误判为需要强制跳转", loc2 === BASE, `${loc2} via=${r2.via} how=${r2.how || "-"}`)
  ok("B2 程序没有强制额外提交（submit 处理器没被 requestSubmit 再触发一遍）",
    submitAfter === submitBefore, `${submitBefore} → ${submitAfter}`)
  ok("B3 没有发生整页提交（/login 未被命中）", loginAfter === loginBefore, `/login 命中 ${loginAfter - loginBefore} 次`)
  ok("B4 回车的隐式提交合成点击了默认按钮（无 type 按钮 = 真实浏览器同款语义）",
    smsAfter === smsBefore + 1, `__smsCount ${smsBefore} → ${smsAfter}`)

  // ── C. 对照：手机号不合法时回车 → 站点自己放行整页提交（真实浏览器同款行为）──
  await tab.navigate(BASE, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 500))
  await tab.evalJs(`document.getElementById("code").setAttribute("data-etui-field", "2")`)
  const loginC0 = hits.filter((h) => h.path === "/login").length
  const r3 = await submitField(tab, { fid: 2, tag: "INPUT", type: "text", text: "验证码", value: "" },
    waitUrlChange, 1600)
  const loginC1 = hits.filter((h) => h.path === "/login").length
  ok("C1 空手机号回车：站点放行 → 整页提交（与真实浏览器一致，enter 路径成功）",
    r3.ok === true && loginC1 === loginC0 + 1, `via=${r3.via} /login +${loginC1 - loginC0}`)
} catch (e) {
  fail++; console.log(`  ✗ 探针异常：${e?.stack || e}`)
} finally {
  try { edge?.quit() } catch {}
}

server.close()
console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
