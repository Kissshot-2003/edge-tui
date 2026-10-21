// 端到端验证「文字模式」——模拟 run.mjs 的 capture/resize/render 全过程。
//
// run.mjs 需要真实 TTY（setRawMode），无法用脚本驱动交互模式。
// 所以这里复刻它的渲染链路，逐步断言每一环：
//   1. 视口尺寸按文字模式设定（宽视口 → 桌面版页面）
//   2. buildTextPage 能取到可读中文
//   3. renderTextPage 输出的行宽严格等于页面区宽度（防串位）
//   4. 媒体块真的变成了字符画（非空、有轮廓）
//   5. 行级滚动生效且不越界
//   6. makeLineMapper / overlayRuns 能正确叠加选中框
//   7. JSON 化后无 NaN/undefined（term.render 的输入约束）

import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, overlayRuns, makeLineMapper } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"

const URL_ = process.argv[2] || "https://www.zhihu.com/signin"
const PC = 78, PR = 24       // 页面区 列×行

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  " + extra : ""}`) }
}

const t0 = Date.now()
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab

try {
  console.log(`\n══ 文字模式端到端 · ${URL_} ══\n`)

  // ① 文字模式视口：宽视口让站点给桌面版布局
  const vpW = Math.max(880, PC * 9)
  const vpH = Math.max(520, PR * 19)
  await tab.setViewport(vpW, vpH)
  console.log(`[1] 视口 ${vpW}×${vpH}`)
  await tab.navigate(URL_)
  await new Promise((r) => setTimeout(r, 1400))
  await tab.scrollTarget()

  const sp = await tab.scrollState()
  ok("scrollState 返回视口宽高", Number.isFinite(sp.iw) && Number.isFinite(sp.ih), `iw=${sp.iw} ih=${sp.ih} host=${sp.host}`)

  // ② 抽取 + 排版
  const tBuild = Date.now()
  const page = await buildTextPage(tab, {
    width: PC, viewport: false, indent: 1, maxMediaRows: 8,
  })
  const buildMs = Date.now() - tBuild
  console.log(`[2] 块 ${page.blocks.length} · 行 ${page.lines.length} · 耗时 ${buildMs}ms`)
  ok("提取到块", page.blocks.length > 3, `blocks=${page.blocks.length}`)

  const textOf = (p) => p.lines.filter((l) => l.type === "text").map((l) => l.text).join("\n")
  const allText = textOf(page)
  ok("含可读中文", /[\u4e00-\u9fa5]{2,}/.test(allText), `中文行 ${page.lines.filter((l) => l.type === "text" && /[\u4e00-\u9fa5]/.test(l.text)).length}`)
  ok("不含字符画噪声行", !/[#%@]{12,}/.test(allText))

  // ③ 渲染 —— 严格宽度
  const res = renderTextPage(page, { width: PC, maxRows: PR, yOffset: 0 })
  console.log(`[3] 渲染 ${res.rows.length} 行 / 共 ${res.totalRows} 行`)
  ok("渲染行数 = 页面区行数", res.rows.length === Math.min(PR, res.totalRows), `${res.rows.length}`)

  const widths = res.rows.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
  const badW = widths.map((w, i) => ({ w, i })).filter((x) => x.w !== PC)
  ok("每行宽度严格 = " + PC, badW.length === 0, badW.length ? `越界行 ${JSON.stringify(badW.slice(0, 5))}` : `行宽集合 {${[...new Set(widths)].join(",")}}`)

  const flat = res.rows.flat()
  const badVals = flat.filter((r) => typeof r.t !== "string" || !Array.isArray(r.fg))
  ok("run 结构合法（t 为 string / fg 为数组）", badVals.length === 0, badVals.length ? JSON.stringify(badVals[0]) : "")

  let jsonOk = true
  try { JSON.parse(JSON.stringify(res.rows)) } catch { jsonOk = false }
  ok("可 JSON 序列化（term.render 的 diff 依赖）", jsonOk)

  // ④ 媒体块 —— 按「信息密度分级」验证，而不是要求每个媒体都出图
  //     qrcode/photo/small 出字符画；icon（任一边 < 40px）只给一行占位，
  //     免得 20×20 的 favicon 也吃 14 行、把正文挤出首屏。
  const medias = page.lines.filter((l) => l.type === "media")
  console.log(`[4] 媒体块 ${medias.length} 个`)
  ok("识别到媒体块", medias.length >= 1)

  const desc = medias.map((m) => `${m.tier || "?"}:${m.tag}${m.alt ? ":" + m.alt : ""} ${m.srcW}×${m.srcH}→${m.cols}×${m.rows}`).join(" | ")
  // 二维码走的是「无损档」，art 只有 {cols,rows}，没有 chars/color —— 要分开断言
  const qrBlocks = medias.filter((m) => m.qrCells)
  const withArt = medias.filter((m) => m.art && m.art.chars)
  const icons = medias.filter((m) => m.tier === "icon" || !m.art)

  ok("每个媒体都有分级标记", medias.every((m) => !!m.tier), desc.slice(0, 180))
  ok("非图标媒体都转出了可渲染内容",
    medias.filter((m) => m.tier !== "icon").every((m) => m.qrCells || (m.art && m.art.cols > 0 && m.art.rows > 0)),
    desc.slice(0, 180))
  ok("小图标降级为一行占位（不占图）",
    icons.every((m) => !m.art || m.art.rows === 0),
    `图标 ${icons.length} 个: ${icons.map((m) => `${m.tag} ${m.srcW}×${m.srcH}`).join(", ")}`)

  if (qrBlocks.length) {
    ok("二维码走无损档（模块矩阵，不是字符画）",
      qrBlocks.every((m) => m.qrCells.ch.length === m.qrCells.cols * m.qrCells.rows && !m.art.chars),
      qrBlocks.map((m) => `${m.alt || m.tag} ${m.qrCells.n}×${m.qrCells.n} 模块 → ${m.qrCells.cols}×${m.qrCells.rows} 格`).join(" | "))
  }

  if (withArt.length) {
    // 取面积最大的一块来验证墨量与配色 —— 通常是二维码，最能反映真实渲染质量
    const m = withArt.slice().sort((a, b) => b.cols * b.rows - a.cols * a.rows)[0]
    console.log(`     最大字符画: ${m.tag} ${m.alt || ""} ${m.cols}×${m.rows}`)
    let nonBlank = 0
    for (let i = 0; i < m.art.chars.length; i++) if (m.art.chars[i] !== 32) nonBlank++
    const ratio = nonBlank / m.art.chars.length
    ok("字符画有内容（非全空白）", ratio > 0.05, `墨点占比 ${(ratio * 100).toFixed(1)}%`)
    let hasColor = false
    for (let i = 0; i < m.art.color.length; i++) if (m.art.color[i] !== 0) { hasColor = true; break }
    ok("字符画带颜色", hasColor)
  }

  // ⑤ 行级滚动
  const maxOff = Math.max(0, res.totalRows - PR)
  console.log(`[5] 最大行偏移 ${maxOff}`)
  const r1 = renderTextPage(page, { width: PC, maxRows: PR, yOffset: Math.min(5, maxOff) })
  const r2 = renderTextPage(page, { width: PC, maxRows: PR, yOffset: Math.min(10, maxOff) })
  if (maxOff >= 10) {
    ok("不同偏移渲染出不同内容", JSON.stringify(r1.rows) !== JSON.stringify(r2.rows))
    ok("偏移后行数仍为 " + PR, r2.rows.length === PR)
  } else {
    ok("内容不足时偏移被安全钳制", r2.rows.length <= PR)
  }
  const rOver = renderTextPage(page, { width: PC, maxRows: PR, yOffset: maxOff + 100 })
  ok("越界偏移返回空/安全", rOver.rows.length === 0, `rows=${rOver.rows.length}`)

  // ⑥ 叠加层
  const map = makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 })
  ok("lineMapper 可调用且返回有限值", Number.isFinite(map(0)) && Number.isFinite(map(400)), `map(0)=${map(0)} map(400)=${map(400)}`)

  const rowsForOverlay = renderTextPage(page, { width: PC, maxRows: PR, yOffset: 0 }).rows
  const els = [
    { x: 20, y: 10, w: 120, h: 30, i: 0, inVp: true },
    { x: 200, y: 120, w: 160, h: 24, i: 1, inVp: true },
  ]
  const changed = overlayRuns({
    rows: rowsForOverlay, width: PC, els, showNumbers: true,
    pickInfo: els[1], colsPerPx: PC / 1200, lineOfY: map, viewOffsetY: 0, pxPerRow: 8,
  })
  ok("overlayRuns 改动了内容", changed)
  const ovWidths = rowsForOverlay.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
  ok("叠加后行宽仍 = " + PC, ovWidths.every((w) => w === PC), `集合 {${[...new Set(ovWidths)].join(",")}}`)
  const ovFlat = rowsForOverlay.flat()
  ok("叠加后 run 结构仍合法", ovFlat.every((r) => typeof r.t === "string" && Array.isArray(r.fg)))

  // ⑦ 与图片模式对比：同样内容，文字模式的可读性
  const readable = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length
  const hz = readable(allText)
  ok("中文可读字符 > 20", hz > 20, `中文字符数 ${hz}`)

  console.log(`\n── 页面摘要 ──`)
  console.log(res.rows.slice(0, 18).map((r) => r.map((x) => x.t).join("").replace(/\s+$/, "")).join("\n"))
} catch (e) {
  console.error("\n[异常]", e?.stack || e)
  fail++
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ ${pass} 通过 · ${fail} 失败 · ${((Date.now() - t0) / 1000).toFixed(1)}s ══\n`)
process.exit(fail ? 1 : 0)
