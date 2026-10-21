// 验证「文字模式 + 元素清单」的完整链路。
//
// 这是用户最关心的场景：知乎登录页找不到入口、点不动。
// 文字模式下页面区只有 24 行左右，登录表单往往在折叠线以下，
// 所以必须验证：枚举 → 选中 → 自动滚入 → 真实点击，每一步都成立。
//
// 与 test-picker-logic.mjs 的区别：那个测的是图片模式的像素网格坐标，
// 这里测的是文字模式的行级滚动 + 终端行列叠加，两套坐标系不能混用。

import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, overlayRuns, makeLineMapper } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"

const PC = 78, PR = 24
let pass = 0, fail = 0
const ok = (n, c, e = "") => { c ? (pass++, console.log(`  ✓ ${n}${e ? "  " + e : ""}`)) : (fail++, console.log(`  ✗ ${n}${e ? "  " + e : ""}`)) }

const t0 = Date.now()
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  console.log("\n══ 文字模式 · 元素清单链路 ══\n")
  const vpW = Math.max(880, PC * 9), vpH = Math.max(520, PR * 19)
  await tab.setViewport(vpW, vpH)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1500))
  await tab.scrollTarget()

  // ① 枚举（用真实视口尺寸，与 run.mjs 的 viewW/viewH 一致）
  const sp0 = await tab.scrollState()
  const els = await tab.enumerateInteractive(sp0.iw, sp0.ih)
  console.log(`[1] 枚举到 ${els.length} 项，视口内 ${els.filter((e) => e.inVp).length} 项 (视口 ${sp0.iw}×${sp0.ih})`)
  ok("枚举到元素", els.length > 5, `${els.length}`)

  const phone = els.find((e) => /手机号/.test(e.text || ""))
  ok("找到「手机号」输入框", !!phone, phone ? `[${phone.i}] ${phone.tag} "${phone.text}"` : "未找到")

  const loginBtn = els.find((e) => /登录\/注册|登录$/.test((e.text || "").trim()))
  ok("找到「登录/注册」按钮", !!loginBtn, loginBtn ? `[${loginBtn.i}] ${loginBtn.text}` : "未找到")

  // ② 滚入视野
  if (phone) {
    const box = await tab.scrollElIntoView(phone.i)
    ok("scrollElIntoView 返回坐标", !!box, box ? `visY=${box.visY} visH=${box.visH}` : "null")
    if (box) {
      const inVp = box.visY >= -1 && box.visY + box.visH <= sp0.ih + 2
      ok("滚入后落在视口内", inVp, `visY=${box.visY} visH=${box.visH} 视口高=${sp0.ih}`)
    }
  }

  // ③ 文字排版 + 行映射：确认「手机号」那块文字真的排进了可见行
  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1, maxMediaRows: 6 })
  const map = makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 })
  const textLines = page.lines.filter((l) => l.type === "text" && /手机号|验证码|扫码|登录/.test(l.text))
  console.log(`[2] 命中关键词的文字行 ${textLines.length} 条`)
  ok("关键词文字进入排版结果", textLines.length >= 2, textLines.map((l) => `"${l.text}"`).join(" / ").slice(0, 120))

  if (phone) {
    // ⚠️ 必须跟**渲染行数**比，不是排版行数（page.lines.length）。
    // 媒体块会把 1 个排版行展开成「标签 + 字符画」多行，所以渲染行数 ≥ 排版行数
    // （知乎登录页实测 71 vs 41）。旧断言拿渲染行号去比排版行数 ——
    // 之所以一直通过，是因为手机号那个 <input> 当时既不是文字块也不是媒体块，
    // 匹配不到自己的锚点，只能退到上方「手机号」标签那一行；而标签的行号恰好 < 41。
    // 表单控件成为一等公民后，输入框有了精确锚点，映射回到正确的第 46 行，
    // 这条写错的断言才暴露出来。
    const rr = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
    const flatRows = rr.rows.map((r) => r.map((x) => x.t).join(""))
    const wantRow = map(phone.y, phone.x, phone.w, phone.h)
    ok("行映射把手机号落在合理行号",
      Number.isFinite(wantRow) && wantRow >= 0 && wantRow < rr.totalRows,
      `row=${wantRow} / 渲染行 ${rr.totalRows}（排版行 ${page.lines.length}）`)
    ok("映射到的那一行确实与手机号有关", /手机号/.test(flatRows[wantRow] || ""),
      `row ${wantRow}: "${(flatRows[wantRow] || "").trim().slice(0, 50)}"`)
  }

  // ④ 叠加层：选中框能画到正确行且行宽守恒
  const res = renderTextPage(page, { width: PC, maxRows: PR, yOffset: 0 })
  const rows = res.rows
  const fakeEls = els.slice(0, 8).map((e) => ({ ...e }))
  overlayRuns({
    rows, width: PC, els: fakeEls, showNumbers: true,
    pickInfo: phone || fakeEls[0], colsPerPx: PC / sp0.iw,
    lineOfY: map, viewOffsetY: 0, pxPerRow: 8,
  })
  const ws = rows.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
  ok("叠加后行宽全 = " + PC, ws.every((w) => w === PC), `集合 {${[...new Set(ws)].join(",")}}`)
  const hasBox = rows.some((r) => r.map((x) => x.t).join("").includes("#"))
  ok("选中框字符确实画上了", hasBox)

  // ⑤ 真实点击
  if (phone) {
    // 重新枚举（前面的滚动改了页面），再点击
    await tab.scrollTarget()
    const sp2 = await tab.scrollState()
    const els2 = await tab.enumerateInteractive(sp2.iw, sp2.ih)
    const p2 = els2.find((e) => /手机号/.test(e.text || ""))
    if (p2) {
      await tab.scrollElIntoView(p2.i)
      const hit = await tab.clickIndex(p2.i)
      ok("clickIndex 未越界", !!hit && !hit.offscreen && Number.isFinite(hit.cx), hit ? `(${hit.cx},${hit.cy})` : "null")
      await new Promise((r) => setTimeout(r, 300))
      // 点击后 DOM 焦点必须真的落到输入框上 —— 这是「点得动」的硬指标
      const act = await tab.evalJs(`(()=>{const a=document.activeElement;return a?{tag:a.tagName,ph:a.placeholder||'',type:a.type||''}:null})()`)
      ok("点击后焦点落在输入框", act && act.tag === "INPUT", JSON.stringify(act))
      await tab.insertText("13900139000")
      await new Promise((r) => setTimeout(r, 300))
      const val2 = await tab.evalJs(`(()=>{const a=document.activeElement;return a&&'value' in a?a.value:'(无焦点)'})()`)
      ok("insertText 写入成功", String(val2).includes("139"), `值="${val2}"`)
    } else {
      ok("二次枚举仍能找到手机号", false)
    }
  }

  // ⑥ 行级滚动：用长内容验证。网络受限（用户环境全局 TUN 代理），
  //    不依赖外网站点，直接用 data: URL 构造一个确定性的长文档。
  const longHtml = `<!doctype html><meta charset="utf-8"><title>长文档滚动测试</title>
<body style="font:16px/1.6 sans-serif;max-width:640px;margin:24px auto">
<h1>终端模拟器简史</h1>
${Array.from({ length: 60 }, (_, i) =>
    `<p>第 ${i + 1} 段：终端模拟器是把一个物理终端的行为用软件重现的程序。它接收键盘输入并送往伪终端，再把远端产生的字节流按转义序列解释成屏幕上的字符、颜色与光标位置。这一段文字足够长，用来验证排版引擎的折行与行级滚动是否正确。</p>`).join("\n")}
</body>`
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(longHtml))
  await new Promise((r) => setTimeout(r, 800))
  const longPage = await buildTextPage(tab, { width: PC, viewport: false, indent: 1, maxMediaRows: 2 })
  const longRes = renderTextPage(longPage, { width: PC, maxRows: PR, yOffset: 0 })
  console.log(`[3] 长文档内容 ${longRes.totalRows} 行 / 页面区 ${PR} 行`)
  ok("长文档内容溢出页面区", longRes.totalRows > PR, `total=${longRes.totalRows} > ${PR}`)
  const maxOff = longRes.totalRows - PR
  const offA = renderTextPage(longPage, { width: PC, maxRows: PR, yOffset: 0 })
  const offB = renderTextPage(longPage, { width: PC, maxRows: PR, yOffset: Math.floor(maxOff / 2) })
  const offC = renderTextPage(longPage, { width: PC, maxRows: PR, yOffset: maxOff })
  ok("顶部与中部内容不同", JSON.stringify(offA.rows) !== JSON.stringify(offB.rows))
  ok("中部与底部内容不同", JSON.stringify(offB.rows) !== JSON.stringify(offC.rows))
  ok("滚到底仍有内容", offC.rows.length > 0, `rows=${offC.rows.length}`)
  const reduceW = (rows) => rows.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
  ok("各滚动位置行宽守恒", reduceW(offA.rows).every((w) => w === PC) && reduceW(offC.rows).every((w) => w === PC),
    `top={${[...new Set(reduceW(offA.rows))].join(",")}} bottom={${[...new Set(reduceW(offC.rows))].join(",")}}`)
  ok("中文折行未切断超宽", reduceW(offC.rows).every((w) => w <= PC))
} catch (e) {
  console.error("\n[异常]", e?.stack || e)
  fail++
} finally {
  try { await edge.quit() } catch {}
}
console.log(`\n══ ${pass} 通过 · ${fail} 失败 · ${((Date.now() - t0) / 1000).toFixed(1)}s ══\n`)
process.exit(fail ? 1 : 0)
