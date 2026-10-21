// 「页面加载卡住」回归测试：把四种真实卡死场景**搬到本地**，量时间。
//
// 用户原话：「总是会有莫名其妙的页面加载卡住的问题」。
//
// 为什么必须本地复现：「卡住」来自真实站点的子资源，静态页面测不出来。
// 这里起一个可控的 HTTP 服务器，让请求**永远不返回**，从而确定性地制造出
// 浏览器"load 事件永不触发 / 解析被阻塞 / 弹窗阻塞渲染"这几种状态。
//
// 四种病灶（旧实现都会冻很久）：
//   ① /hang    一张图永远不返回 → load 永不触发 → 旧实现等满 25s + settle 12s
//   ② /block   一个 <script src> 永远不返回 → **解析被阻塞**，DOMContentLoaded
//               和 readyState!=='loading' 都永不到来（连 domReady 判据也失效）
//   ③ /alert   onload 里 alert() → 弹窗**阻塞渲染进程**，evaluate/screenshot 全不返回
//   ④ /many    30 张大图 → 每次截图一次 CDP 往返，串行抓完几十秒
//
// 判据是**墙上时钟**与**能不能继续操作**，不是"功能是否报错"。
import http from "node:http"
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一张真的有内容的图（渐变 + 噪声）。
 *  ⚠️ 不能用 1×1 纯色 PNG 拉伸 —— 那种图渲染出来 flat=1.00（整片同一个字符），
 *  会被「低信息量图降级」正确地跳过，对照断言就失效了。 */
const { PNG } = await import("pngjs")
function noisyPngDataUri(w = 64, h = 44, seed = 0) {
  const img = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // 横向渐变 + 纵向渐变 + 少量噪声 → 降采样后各格亮度分布足够散
      img.data[i] = (x * 255) / w
      img.data[i + 1] = (y * 255) / h
      img.data[i + 2] = 60 + ((x * 7 + y * 13 + seed) % 120)
      img.data[i + 3] = 255
    }
  }
  return "data:image/png;base64," + PNG.sync.write(img).toString("base64")
}
/** body 可能**根本不存在**（解析被阻塞）—— 读正文一律走这个 */
const bodyText = (tab) => tab.evalJs(
  "((document.body && document.body.innerText) || '').replace(/\\s+/g,'')")

// ── 可控的"坏服务器" ──
const IMG = (i) => `<img src="/img${i}.png" width="300" height="200" alt="图片${i}">`
const server = http.createServer((req, res) => {
  const path0 = req.url.split("?")[0]
  if (path0 === "/hangimg.png" || path0 === "/hangscript.js" || path0.startsWith("/img")) {
    // 关键：**接受连接但永不回应**（不 end、不写），让浏览器一直挂着
    if (path0.startsWith("/img")) {
      // /many 用的图片：正常返回一张**有内容**的 PNG（快），走了这条路
      const n = Number(path0.slice(4, -4)) || 0
      const png = Buffer.from(noisyPngDataUri(64, 44, n).split(",")[1], "base64")
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length })
      res.end(png)
      return
    }
    return   // 永远不返回
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  if (path0 === "/hang") {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>卡住：图片不返回</title></head>
<body><h1>这张页面正文是可读的</h1><p>正文内容在这里，正文内容在这里，正文内容在这里。</p>
<p>第二段正文，确保文本量不为零。</p>
<img src="/hangimg.png" width="300" height="200" alt="永不返回的图">
</body></html>`)
    return
  }
  if (path0 === "/block") {
    // 阻塞脚本放在**正文中间**（统计/广告脚本的常见位置）：
    // 它之前的正文浏览器已经解析出来了，文字浏览器应该照样能读。
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>卡住：脚本阻塞解析</title></head>
<body><h1>阻塞脚本之前的正文</h1>
<p>这一段在阻塞脚本之前，浏览器已经解析出来了。</p>
<script src="/hangscript.js"></script>
<p>这一段在阻塞脚本之后，永远不会被解析到。</p>`)
    return
  }
  if (path0 === "/blockhead") {
    // 阻塞脚本放在 <head>：解析器直接停住，`document.body` **根本不存在**。
    // 这是"页面全白 + 一直转圈"的典型形态。
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>卡住：head 里的脚本</title>
<script src="/hangscript.js"></script></head>
<body><h1>这一段永远不会出现</h1></body></html>`)
    return
  }
  if (path0 === "/alert") {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>卡住：弹窗阻塞渲染</title></head>
<body onload="alert('站点弹窗')"><h1>弹窗后面还有正文</h1><p>正文正文正文。</p></body></html>`)
    return
  }
  if (path0 === "/many") {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>图很多</title></head><body>
<h1>三十张大图</h1>${Array.from({ length: 30 }, (_, i) => IMG(i)).join("\n")}
</body></html>`)
    return
  }
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>正常页</title></head>
<body><h1>正常页面</h1><p>内容正常。</p></body></html>`)
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const PORT = server.address().port
const base = `http://127.0.0.1:${PORT}`

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab

try {
  await tab.setViewport(880, 520)

  // ══ ① 子资源永不返回：load 事件不会来 ══
  console.log("── ① 图片永不返回（load 永不触发）──")
  let t0 = Date.now()
  const r1 = await tab.navigate(`${base}/hang`, { timeoutMs: 12000 })
  const ms1 = Date.now() - t0
  ok("★ 导航没有被卡住（旧实现要等满 25s）", ms1 < 3500, `${ms1}ms · state=${r1.state}`)
  ok("★ 确认 load 事件从未触发（旧实现的等待条件永远不成立）",
    tab.life.load === false, `life.load=${tab.life.load}`)
  const body1 = await bodyText(tab)
  ok("正文照样读得到（w3m 式「收到多少渲染多少」）", /这张页面正文是可读的/.test(body1) && body1.length > 20,
    `${body1.length} 字`)

  // ══ ② 阻塞解析的脚本：readyState 也不会变 ══
  console.log("\n── ② <script src> 永不返回（解析被阻塞）──")
  t0 = Date.now()
  const r2 = await tab.navigate(`${base}/block`, { timeoutMs: 12000 })
  const ms2 = Date.now() - t0
  ok("★ 解析被阻塞时也不卡（旧实现连 readyState 判据都失效）", ms2 < 3500,
    `${ms2}ms · state=${r2.state}`)
  const rs = await tab.evalJs("document.readyState")
  ok("确认 readyState 确实还停在 loading（所以判据里不能有它）", rs === "loading", `readyState=${rs}`)
  const body2 = await bodyText(tab)
  ok("★ 阻塞脚本**之前**的正文照样读得到", /阻塞脚本之前的正文/.test(body2), `${body2.length} 字`)

  // ②' 阻塞脚本在 <head>：body 根本不存在 → 应当很快给出"空"的结论，不能等满超时
  console.log("\n── ②' 阻塞脚本在 <head>（body 不存在，页面全白）──")
  t0 = Date.now()
  const r2b = await tab.navigate(`${base}/blockhead`, { timeoutMs: 12000 })
  const ms2b = Date.now() - t0
  ok("★ 空页面快速收手（不等满 12s 超时）", ms2b < 6500, `${ms2b}ms · state=${r2b.state}`)
  ok("如实报告这是「没有内容」而不是「超时」", r2b.state === "stalled", `state=${r2b.state}`)
  ok("确认 body 真的不存在", (await tab.evalJs("document.body === null")) === true)

  // ══ ③ alert() 阻塞渲染进程 ══
  console.log("\n── ③ onload alert()（弹窗阻塞渲染进程）──")
  t0 = Date.now()
  const r3 = await tab.navigate(`${base}/alert`, { timeoutMs: 8000 })
  const ms3 = Date.now() - t0
  ok("★ 导航没有被弹窗冻住", ms3 < 4000, `${ms3}ms · state=${r3.state}`)
  ok("★ 弹窗被自动关掉并记账", (tab.dialogCount || 0) >= 1,
    `dialogCount=${tab.dialogCount} type=${tab.dialog?.type} msg=${tab.dialog?.message}`)
  // 关键：弹窗没关掉的话，下面两件事都会永久挂住
  const stillAlive = await Promise.race([
    tab.evalJs("1+1").then((v) => v === 2),
    sleep(4000).then(() => false),
  ])
  ok("★ 弹窗之后仍能执行 JS（没关掉就永久不返回）", stillAlive === true)
  const canShot = await Promise.race([
    tab.screenshot().then(() => true).catch(() => false),
    sleep(4000).then(() => false),
  ])
  ok("★ 弹窗之后仍能截图", canShot === true)

  // ══ ④ 抓图预算 ══
  console.log("\n── ④ 图很多时的抓图预算 ──")
  await tab.navigate(`${base}/many`, { timeoutMs: 8000 })
  t0 = Date.now()
  const full = await buildTextPage(tab, { width: 78, viewport: false, indent: 1 })
  const fullMs = Date.now() - t0
  const fullMedia = full.lines.filter((l) => l.type === "media" && l.art)
  ok("不设预算时全部抓取（作为对照）", fullMedia.length >= 20, `${fullMedia.length} 张 · ${fullMs}ms`)

  // 重新抓一次，这次给预算
  await tab.navigate(`${base}/many`, { timeoutMs: 8000 })
  const seen = []
  t0 = Date.now()
  const lim = await buildTextPage(tab, {
    width: 78, viewport: false, indent: 1,
    limits: { maxShots: 4, deadline: Date.now() + 1500, onProgress: (d, t) => seen.push(`${d}/${t}`) },
  })
  const limMs = Date.now() - t0
  const skipped = lim.lines.filter((l) => l.type === "media" && l.skipped)
  ok("★ 超预算的图被跳过而不是无限抓", skipped.length > 0,
    `跳过 ${skipped.length} 张：${[...new Set(skipped.map((l) => l.skipped))].join(" / ")}`)
  ok("★ 跳过时抓图总耗时被压住", limMs < 6000, `${limMs}ms（不设预算 ${fullMs}ms）`)
  ok("抓图过程中有进度回调（界面不会静止）", seen.length > 0, seen.slice(0, 4).join(" "))
  const rendered = renderTextPage(lim, { width: 78, maxRows: 9999, yOffset: 0 })
  const text = rendered.rows.map((r) => r.map((x) => x.t).join("")).join("\n")
  ok("★ 被跳过的图在页面上写明原因（不能悄悄消失）", /未抓取（/.test(text),
    (text.match(/▫ IMG[^\n]*未抓取[^\n]*/) || [""])[0].slice(0, 70))

  // ══ ⑤ 导航本身失败要立刻回报 ══
  console.log("\n── ⑤ 导航失败（域名解析不了）──")
  t0 = Date.now()
  const r5 = await tab.navigate("http://this-host-does-not-exist-etui.invalid/", { timeoutMs: 12000 })
  const ms5 = Date.now() - t0
  ok("★ 失败的导航立刻回报错误，不是等超时", ms5 < 4000 && !!r5.errorText,
    `${ms5}ms · errorText=${r5.errorText}`)

  // ══ ⑥ 浏览器进程没了：在飞的调用要立刻失败，不能各自干等 30s ══
  console.log("\n── ⑥ 浏览器断开（不能各自干等 30 秒超时）──")
  await edge.quit()
  t0 = Date.now()
  const dead = await Promise.race([
    tab.evalJs("1").then(() => "resolved").catch((e) => "rejected:" + String(e?.message || e)),
    sleep(5000).then(() => "HUNG"),
  ])
  const ms6 = Date.now() - t0
  ok("★ 连接断开后调用立刻失败（不是干等 30s）", dead.startsWith("rejected") && ms6 < 3000,
    `${ms6}ms · ${String(dead).slice(0, 60)}`)
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
  try { server.closeAllConnections?.() } catch {}
  try { server.close() } catch {}
  // 挂住的 socket 会阻止进程退出
  setTimeout(() => process.exit(fail ? 1 : 0), 200).unref()
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
