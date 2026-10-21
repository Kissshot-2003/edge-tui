// 探针：浏览器新开页面（target=_blank / window.open）时，CDP 报上来的是什么？
//
// 要做成"真浏览器"，这类链接必须开成**新标签页**，而不是像现在这样
// 被强行劫持到当前标签（那是"只有一个 tab 时代"的权宜之计）。
//
// 但这里有个坑：我们自己用 Target.createTarget 开的标签页，
// 也会以 targetCreated 的形式报上来 —— 必须能把两者区分开，
// 否则会把自己的标签页当成"站点新开的窗口"重复收编。
//
// 所以要先看清 targetInfo 里到底有什么可用的判据。
import { launchEdge } from "../src/cdp.js"

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>开窗测试</title></head>
<body>
<a id="blank" href="https://example.com/child" target="_blank">新窗口链接</a>
<a id="blanknoop" href="https://example.com/child2" target="_blank" rel="noopener">新窗口(noopener)</a>
<button id="wo" onclick="window.open('https://example.com/child3','_blank')">JS开窗</button>
</body></html>`

const edge = await launchEdge({ width: 900, height: 600 })
const tab = edge.tab
try {
  // 拿浏览器级连接
  const version = await (await fetch(`http://127.0.0.1:${edge.port}/json/version`)).json()
  const bws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { bws.addEventListener("open", res); bws.addEventListener("error", rej) })
  let seq = 0
  const pending = new Map()
  const listeners = []
  bws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method) {
      for (const fn of listeners) fn(m.method, m.params)
    }
  })
  const bsend = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    bws.send(JSON.stringify({ id, method, params }))
  })

  const seen = []
  listeners.push((method, params) => {
    if (method === "Target.targetCreated") {
      const ti = params?.targetInfo || {}
      seen.push({ tag: "targetCreated", id: ti.targetId, type: ti.type, url: ti.url, opener: ti.openerId ? "有" : "无" })
    }
    if (method === "Target.targetInfoChanged") {
      const ti = params?.targetInfo || {}
      seen.push({ tag: "infoChanged", id: ti.targetId, type: ti.type, url: ti.url, opener: ti.openerId ? "有" : "无" })
    }
  })

  await bsend("Target.setDiscoverTargets", { discover: true })
  console.log("已开启目标发现\n")

  const listPages = async (tag) => {
    const arr = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json()
    const pages = arr.filter((t) => t.type === "page")
    console.log(`  [${tag}] page 目标数 = ${pages.length}`)
    for (const p of pages) console.log(`      ${p.id.slice(0, 8)}  ${String(p.url).slice(0, 60)}`)
    return pages
  }

  console.log("初始：")
  await listPages("初始")

  // ① 我们自己用 Target.createTarget 开的
  const mine = await bsend("Target.createTarget", { url: "about:blank" })
  console.log("\n自己 createTarget →", mine.targetId)
  await new Promise((r) => setTimeout(r, 500))

  // ② **真实鼠标点击** target=_blank 链接
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html), { timeoutMs: 8000 })
  const idx = await tab.evalJs("(() => { const a=document.getElementById('blank'); const r=a.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}) })()")
  const pos = JSON.parse(idx)
  await tab.realClick(pos.x, pos.y)
  await new Promise((r) => setTimeout(r, 1200))
  console.log("\n真实点击 target=_blank 之后：")
  await listPages("点完 _blank")

  // ③ window.open
  await tab.evalJs("document.getElementById('wo').click()")
  await new Promise((r) => setTimeout(r, 1200))
  console.log("\nwindow.open 之后：")
  await listPages("点完 window.open")

  console.log("\n收到的事件：")
  for (const s of seen) {
    if (s.type !== "page") continue
    console.log(`  ${s.tag.padEnd(13)} type=${String(s.type).padEnd(6)} opener=${s.opener}  url=${String(s.url).slice(0, 70)}`)
  }
  const own = seen.find((s) => s.id === mine.targetId)
  console.log("\n自己那个 target 的信息：", own ? JSON.stringify(own) : "（没收到事件）")
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
