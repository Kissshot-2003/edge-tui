// 折叠内容测试：站点把正文藏起来（display:none / <details> / line-clamp）时，
// 文字浏览器是否还能「知道那里有内容」并且就地读出来。
//
// 为什么必须有（用户原话：「很多文字部分被页面折叠了看不全，无法点击展开和查看详细」）：
// 初版提取器对 display:none 一律 continue，于是折叠正文**整段消失**，
// 用户只看到「展开全文」四个字，而那是站点 JS 的控件，文字浏览器点不了。
// 现在的设计是：折叠内容连文字一起读出来，登记成一条标记 + 全文备用，
// 展开在文字层完成（applyFoldState），不依赖站点 JS、不产生副作用。
//
// 用本地 fixture 页而不是真网站：判据（有没有登记折叠、展开后读不读得到）
// 需要完全可控的 DOM，网页改版就会让断言失真。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, renderedRowCount, applyFoldState } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const PC = 78
const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "fold-page.html")).href

console.log("══ 折叠内容（文字模式）══\n")

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate(fixture)
  await new Promise((r) => setTimeout(r, 700))

  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const flat = (res) => res.rows.map((r) => r.map((x) => x.t).join(""))
  const widths = (rows) => rows.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))

  // ── ① 折叠内容被登记出来 ──
  const folds = page.folds || []
  const byReason = (r) => folds.filter((f) => f.reason === r)
  ok("检测到折叠内容 ≥ 2 处", folds.length >= 2, `${folds.length} 处：${folds.map((f) => f.reason + ":" + f.label).join(" | ")}`)
  ok("display:none 的隐藏块被登记（reason=hidden）", byReason("hidden").length >= 1)
  ok("closed <details> 被登记（reason=details）", byReason("details").length >= 1)
  ok("折叠内容带上了全文", byReason("hidden").some((f) => f.text.includes("隐藏段落关键词AAA")),
    byReason("hidden").map((f) => f.len + "字").join(","))
  ok("details 的折叠正文也在", byReason("details").some((f) => f.text.includes("BBB")))
  ok("折叠标记用的是控件的文字当标题", (byReason("hidden")[0]?.label || "").includes("展开"),
    `label=${byReason("hidden")[0]?.label}`)

  // ── ② 折叠标记排在 <details> 的 summary 之后（读起来不能是反的）──
  const lines0 = page.lines
  const sumIdx = lines0.findIndex((l) => l.type === "text" && String(l.text).includes("常见问题"))
  const foldIdx = lines0.findIndex((l) => l.type === "fold" && l.block?.reason === "details")
  ok("details 的折叠标记排在 summary 之后", sumIdx >= 0 && foldIdx > sumIdx, `summary ${sumIdx} · fold ${foldIdx}`)

  // ── ③ 默认（收起）状态 ──
  const res0 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  const t0 = flat(res0)
  ok("收起时正文里看不到折叠内容", !t0.some((s) => s.includes("隐藏段落关键词AAA") && !s.includes("折叠内容")))
  const markerRow = t0.find((s) => s.includes("▣ 折叠内容"))
  ok("收起时有「折叠内容」标记行", !!markerRow, markerRow ? markerRow.trim().slice(0, 60) : "")
  ok("标记行写明了字数与按键", !!markerRow && /字/.test(markerRow) && /按 e 展开/.test(markerRow))
  ok("line-clamp 截断的正文默认就能读到（它在 DOM 里）", t0.some((s) => s.includes("关键词 CCC")))
  ok("没有展开控件的隐藏内容被丢弃并计数", (page.droppedHidden || 0) > 0, `droppedHidden=${page.droppedHidden}`)

  // ── ④ 展开 ──
  const openIds = new Set(folds.map((f) => f.id))
  applyFoldState(page, openIds, PC)
  const res1 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  const t1 = flat(res1)
  ok("展开后能读到 display:none 里的正文", t1.some((s) => s.includes("隐藏段落关键词AAA")))
  ok("展开后能读到 details 里的正文", t1.some((s) => s.includes("BBB")))
  ok("展开后行数变多", res1.totalRows > res0.totalRows, `${res0.totalRows} → ${res1.totalRows}`)
  ok("展开后标记行显示「已展开」", t1.some((s) => s.includes("已展开") && s.includes("按 e 收起")))

  // ── ⑤ 行宽守恒 + 渲染行数一致（叠加层对齐的前提）──
  for (const [tag, rows, res, pg] of [["收起", res0.rows, res0, page], ["展开", res1.rows, res1, page]]) {
    const ws = widths(rows)
    ok(`${tag}状态：窗口内行宽全 = ${PC}`, ws.every((w) => w === PC), `集合 {${[...new Set(ws)].join(",")}}`)
  }
  // renderedRowCount 必须与 renderTextPage 的实际 push 次数一致（展开态尤其关键，
  // 因为展开往 lines 里插了成百行正文 —— 叠加层全靠这个求和找行）
  const counted1 = page.lines.reduce((a, l) => a + renderedRowCount(l), 0)
  ok("展开态：renderedRowCount 累加 === totalRows", counted1 === res1.totalRows, `${counted1} vs ${res1.totalRows}`)
  // 全量渲染（maxRows 拉满）与「窗口切片」两种取法的行宽都要守恒
  const win = renderTextPage(page, { width: PC, maxRows: 20, yOffset: 12 })
  ok("展开态：滚动窗口内行宽守恒", widths(win.rows).every((w) => w === PC))

  // ── ⑥ 幂等：反复按 e 不能把正文重复插进去 ──
  applyFoldState(page, openIds, PC)
  applyFoldState(page, openIds, PC)
  const res2 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  ok("applyFoldState 幂等（重复展开行数不变）", res2.totalRows === res1.totalRows, `${res1.totalRows} vs ${res2.totalRows}`)

  // ── ⑦ 收起后回到原状 ──
  applyFoldState(page, new Set(), PC)
  const res3 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  ok("收起后行数与初始一致", res3.totalRows === res0.totalRows, `${res0.totalRows} vs ${res3.totalRows}`)

  // ── ⑧ 页面侧展开（E）：真的去动页面，然后重新提取 ──
  // 这条路径必须能自己扛住：解除 line-clamp 截断 + 点「展开全文」。
  const n = await tab.expandPageControls()
  ok("页面侧展开执行成功", !!n && Number.isFinite(n.unclamped) && Number.isFinite(n.clicked),
    `解除截断 ${n?.unclamped} 处（${(n?.unclampedTargets || []).join(" ")}）· 点击 ${n?.clicked} 个（${(n?.targets || []).join("/")}）`)
  await new Promise((r) => setTimeout(r, 300))
  const page2 = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const res4 = renderTextPage(page2, { width: PC, maxRows: 9999, yOffset: 0 })
  const t4 = flat(res4)
  ok("页面侧展开后，display:none 的正文直接可见（不再需要折叠标记）",
    t4.some((s) => s.includes("隐藏段落关键词AAA")))
  ok("页面侧展开后行宽仍守恒", widths(res4.rows).every((w) => w === PC))
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ ${pass} 通过 · ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
