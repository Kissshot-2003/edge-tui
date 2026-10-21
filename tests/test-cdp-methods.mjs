// CDP 方法名审计 —— 防止「调用了不存在的方法」这类 bug
//
// 教训（2026-10-21）：`Page.goBack` / `Page.goForward` **在 CDP 协议里根本不存在**。
// 历史上 src/cdp.js 就是这么写的，于是每次后退都报
// "'Page.goBack' wasn't found"，错误又被 catch 吞进状态栏 ——
// 后退/前进这个功能从项目第一天起就没生效过，**加载失败之后更是完全无路可退**，
// 而用户看到的只是「按了没反应」。
//
// 这类 bug 极难靠读代码发现：方法名长得像真的，参数也对，报错还被吞掉了。
// 所以这里做一次**实证审计**：逐个发过去，看回的是
//   「方法不存在」（'X' wasn't found）→ 失败
//   还是别的错（参数不对之类）  → 方法存在，通过
import { launchEdge } from "../src/cdp.js"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

/** CDP 对"方法不存在"的报错长这样：'Page.goBack' wasn't found */
function isMissingMethod(msg) {
  return /wasn't found|was not found|Unknown command|not found/i.test(String(msg || ""))
}

// 项目里用到的全部 CDP 方法 + 一份无害的参数
// ⚠️ 不含 Browser.close —— 它会把浏览器关掉。
const METHODS = [
  ["Page.enable", {}],
  ["Page.disable", {}],
  ["Runtime.enable", {}],
  ["Page.setLifecycleEventsEnabled", { enabled: true }],
  ["Page.navigate", { url: "about:blank" }],
  ["Page.stopLoading", {}],
  ["Page.captureScreenshot", { format: "png" }],
  ["Page.getNavigationHistory", {}],
  ["Page.navigateToHistoryEntry", { entryId: 0 }],
  ["Page.setInterceptFileChooserDialog", { enabled: false }],
  ["Page.handleJavaScriptDialog", { accept: true }],
  ["Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }],
  ["Runtime.evaluate", { expression: "1" }],
  ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }],
  ["Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }],
  ["Input.insertText", { text: "" }],
  ["DOM.setFileInputFiles", { files: [], backendNodeId: 0 }],
  ["Target.getTargets", {}],
]

console.log("══ CDP 方法名审计 ══\n")

const edge = await launchEdge({ width: 900, height: 600 })
try {
  for (const [m, params] of METHODS) {
    let err = null
    try { await edge.tab.conn.send(m, params) } catch (e) { err = e }
    ok(`${m} 存在`, !err || !isMissingMethod(err?.message),
      err ? `→ ${String(err.message).slice(0, 70)}` : "")
  }

  // Target.createTarget / closeTarget 走的是**浏览器级**连接
  // （页面级连接上没有这两个方法，用页面连接测会误报）。
  const version = await (await fetch(`http://127.0.0.1:${edge.port}/json/version`)).json()
  const bws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { bws.addEventListener("open", res); bws.addEventListener("error", rej) })
  let bseq = 0
  const bsend = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++bseq
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      bws.removeEventListener("message", onMsg)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    bws.addEventListener("message", onMsg)
    bws.send(JSON.stringify({ id, method, params }))
  })
  for (const [m, params] of [["Target.createTarget", { url: "about:blank" }]]) {
    let err = null, tid = null
    try { tid = (await bsend(m, params)).targetId } catch (e) { err = e }
    ok(`${m} 存在（浏览器级）`, !err || !isMissingMethod(err?.message),
      err ? `→ ${String(err.message).slice(0, 70)}` : `targetId=${tid}`)
    if (tid) {
      let err2 = null
      try { await bsend("Target.closeTarget", { targetId: tid }) } catch (e) { err2 = e }
      ok("Target.closeTarget 存在（浏览器级）", !err2 || !isMissingMethod(err2?.message),
        err2 ? `→ ${String(err2.message).slice(0, 70)}` : "")
    }
  }
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
