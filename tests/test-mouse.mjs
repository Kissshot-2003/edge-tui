// 鼠标交互测试：解析 SGR 序列 → 命中渲染格 → 落到正确的 DOM 块 → 真点击生效。
//
// 为什么必须有：参考 Browsh 之后补上的能力 —— 终端里「看到就点」才是本能，
// 而键盘路径（Tab 循环 / v 元素清单）要求用户先知道有这两个功能、再盯着屏幕找行号。
//
// 判据必须是**真实链路**：解析出来的坐标 → 命中判定 → 元素编号 → CDP 真点击
// → 页面上真的发生了那件事（window.__hit 记录了哪个链接被点）。
// 只断言"解析出了坐标"证明不了任何事 —— 坐标对但落错块，用户看到的就是点 A 开 B。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { parseSgrMouse, classifyMouse, hitTestRows, buildClickIndex, rowCandidates, matchElement } from "../src/mouse.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const OFFLINE = process.argv.includes("--offline")
const PC = 78
const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "mouse-page.html")).href
const B = (s) => Buffer.from(s, "utf8")

console.log("══ 鼠标（终端 SGR 序列 → 命中 → 真点击）══\n")

// ─────────────────────────────────────────────────────────────
// ① 纯解析：不依赖浏览器，先保证协议这一层是对的
// ─────────────────────────────────────────────────────────────
console.log("① SGR 序列解析")

{
  const ev = parseSgrMouse(B("\x1b[<0;10;5M"), 0)
  ok("左键按下解析正确", ev && !ev.bad && ev.cb === 0 && ev.x === 10 && ev.y === 5 && !ev.release,
    ev ? JSON.stringify(ev) : "null")
  ok("len 覆盖整个序列", ev && ev.len === 10, ev ? `len=${ev.len}` : "")

  const cl = classifyMouse(ev)
  ok("分类为左键单击", cl?.kind === "click" && cl.button === 0 && cl.x === 10 && cl.y === 5, JSON.stringify(cl))

  const rel = classifyMouse(parseSgrMouse(B("\x1b[<0;10;5m"), 0))
  ok("'m' 结尾识别为抬起（不是点击）", rel?.kind === "release", JSON.stringify(rel))

  const wu = classifyMouse(parseSgrMouse(B("\x1b[<64;3;4M"), 0))
  ok("滚轮上", wu?.kind === "wheelUp", JSON.stringify(wu))
  const wd = classifyMouse(parseSgrMouse(B("\x1b[<65;3;4M"), 0))
  ok("滚轮下", wd?.kind === "wheelDown", JSON.stringify(wd))

  const rc = classifyMouse(parseSgrMouse(B("\x1b[<2;7;8M"), 0))
  ok("右键识别为 button=2（调用方会忽略它，留给终端菜单）", rc?.kind === "click" && rc.button === 2, JSON.stringify(rc))

  // 拖动：cb 带 32 位。不识别的话一次拖拽 = 连续多次点击
  const drag = classifyMouse(parseSgrMouse(B("\x1b[<32;7;8M"), 0))
  ok("拖动（cb=32）识别为 move，不会被当成点击", drag?.kind === "move", JSON.stringify(drag))

  // 大列号：老式 X10 编码在 223 列就溢出，SGR 必须原样保住
  const wide = parseSgrMouse(B("\x1b[<0;301;42M"), 0)
  ok("列号 301 不溢出（X10 编码会在 223 处崩掉）", wide?.x === 301 && wide?.y === 42, JSON.stringify(wide))

  // 序列被 chunk 切开：必须返回 null 等下一批，绝不能当残缺字节吞掉
  ok("半截序列返回 null（等下一个 chunk）", parseSgrMouse(B("\x1b[<0;10"), 0) === null)
  ok("只有 ESC 前缀也返回 null", parseSgrMouse(B("\x1b["), 0) === null)
  ok("空缓冲返回 null", parseSgrMouse(B(""), 0) === null)

  // 认错了要能按长度跳过，否则会死循环
  const bad = parseSgrMouse(B("\x1b[<0;10;5X"), 0)
  ok("非法终结符标记为 bad 且给出跳过长度", bad?.bad === true && bad.len === 10, JSON.stringify(bad))

  // 从 start 偏移处解析（真实循环里 keyBuf 前面可能还有别的字节）
  const off = parseSgrMouse(B("ab\x1b[<0;2;3M"), 2)
  ok("支持从偏移处解析", off && !off.bad && off.x === 2 && off.y === 3, JSON.stringify(off))
}

// ─────────────────────────────────────────────────────────────
// ② 命中判定（纯数据）
// ─────────────────────────────────────────────────────────────
console.log("\n② 渲染格命中判定")

{
  const A = { id: "A" }, Bb = { id: "B" }, Cc = { id: "C" }
  const rows = [
    [ { t: "登录", fg: [0,0,0], w: 4, src: A }, { t: "  注册", fg: [0,0,0], w: 6, src: Bb }, { t: "  X", w: 10 } ],
    [ { t: "".padEnd(20), w: 20 } ],
  ]
  ok("第 0 列落在第一个块", hitTestRows(rows, 0, 0) === A)
  ok("第 3 列仍在第一个块（宽度是 4，含右边界不越界）", hitTestRows(rows, 0, 3) === A)
  ok("第 4 列进入第二个块（注册）", hitTestRows(rows, 0, 4) === Bb)
  ok("第 9 列仍在第二个块", hitTestRows(rows, 0, 9) === Bb)
  ok("空白尾段无 src → null（不猜测性点击）", hitTestRows(rows, 0, 12) === null)
  ok("越界行 → null", hitTestRows(rows, 5, 0) === null)

  const idx = buildClickIndex(rows)
  ok("行索引只收录「有来源块」的行（空白行不进表）", idx.size === 1, `size=${idx.size}`)
  ok("第 0 行两个块", rowCandidates(idx, 0).length === 2, `${rowCandidates(idx, 0).length}`)
  ok("第 1 行没有块（整行是空白）", rowCandidates(idx, 1).length === 0)

  const els = [
    { i: 0, x: 0, y: 0, w: 200, h: 24, text: "登录" },
    { i: 1, x: 0, y: 200, w: 200, h: 24, text: "远处" },
  ]
  ok("块落在元素矩形内 → 匹配到该元素编号", matchElement(els, { x: 20, y: 5, w: 30, h: 18 })?.index === 0)
  ok("完全不相交时退化为中心距（仍给一个结果而非 null）",
    matchElement(els, { x: 0, y: 100, w: 10, h: 10 })?.index === 0,
    String(matchElement(els, { x: 0, y: 100, w: 10, h: 10 })?.index))
  ok("没有元素时返回 null", matchElement([], { x: 0, y: 0, w: 1, h: 1 }) === null)
  ok("块没有坐标时返回 null", matchElement(els, { kind: "text" }) === null)
}

// ─────────────────────────────────────────────────────────────
// ③ 真机：解析出的坐标真的能点到正确的东西
// ─────────────────────────────────────────────────────────────
console.log("\n③ 真实页面（本地 fixture）")
if (OFFLINE) {
  console.log("  (--offline：跳过真实页面部分)")
} else {
  const edge = await launchEdge({ width: 1200, height: 800 })
  const tab = edge.tab
  try {
    await tab.setViewport(880, 520)
    await tab.navigate(fixture)
    await new Promise((r) => setTimeout(r, 700))

    const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
    const res = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
    const rows = res.rows

    // 找「某个块」在屏幕上的位置：按 href 反查它排到了哪一行哪一列
    const locate = (pred) => {
      for (let r = 0; r < rows.length; r++) {
        let col = 0
        for (const run of rows[r]) {
          const w = run.w !== undefined ? run.w : strWidth(String(run.t ?? ""))
          if (run.src && pred(run.src)) return { row: r, col, w, src: run.src, text: String(run.t) }
          col += w
        }
      }
      return null
    }

    // ── 三个并排链接：必须各自可分辨 ──
    const a = locate((s) => s.href === "#alpha")
    const b = locate((s) => s.href === "#beta")
    const c = locate((s) => s.href === "#gamma")
    ok("三个并排链接都排进了文本流", !!a && !!b && !!c,
      a && b && c ? `行 ${a.row}/${b.row}/${c.row}` : `${!!a}${!!b}${!!c}`)
    ok("三个链接被「行内合并」到同一行（这正是需要分段记录的场景）",
      !!a && !!b && !!c && a.row === b.row && b.row === c.row, a && b && c ? `rows=${a.row},${b.row},${c.row}` : "")
    ok("同行的三个链接列位置互不相同", !!a && !!b && !!c && a.col === 0 && b.col > a.col && c.col > b.col,
      a && b && c ? `cols=${a.col},${b.col},${c.col}` : "")

    // 命中「注册」那一段的**中间**（不是行首）：这是分段 src 的核心价值
    const hitB = hitTestRows(rows, b.row, b.col)
    ok("点在同一行的「注册」上 → 命中注册块（不是登录）",
      hitB && hitB.href === "#beta", hitB ? `命中 href=${hitB.href}` : "null")
    const hitC = hitTestRows(rows, c.row, c.col)
    ok("点在同一行的「帮助中心」上 → 命中帮助块", hitC && hitC.href === "#gamma",
      hitC ? `命中 href=${hitC.href}` : "null")

    // 真点击：走 enumerateInteractive → clickIndex（和主程序 openBlock 同一条路）
    const els = await tab.enumerateInteractive(880, 520)
    const mB = matchElement(els, b.src)
    ok("「注册」块匹配到了可交互元素编号", !!mB && mB.index >= 0, mB ? `index=${mB.index} overlap=${mB.overlap}` : "null")
    await tab.evalJs("window.__hit = []")
    const box = await tab.clickIndex(mB.index)
    const hits = await tab.evalJs("window.__hit || []")
    ok("真实点击落到了「注册」（onclick 记录 HIT=B）",
      !box?.offscreen && Array.isArray(hits) && hits.join("") === "B", `hits=${JSON.stringify(hits)}`)
    ok("点击的地址随之变为 #beta", (await tab.evalJs("location.hash")) === "#beta",
      await tab.evalJs("location.hash"))

    // ── 控件行：点在输入框上必须能聚焦 ──
    const fld = locate((s) => s.kind === "field" && s.type === "search")
    ok("搜索框在文本流里可定位", !!fld, fld ? `行 ${fld.row} 列 ${fld.col}「${fld.text.trim()}」` : "")
    const hitF = hitTestRows(rows, fld.row, fld.col + 2)
    ok("点在控件行 → 命中该控件块（kind=field）", hitF?.kind === "field" && hitF.fid === fld.src.fid,
      hitF ? `kind=${hitF.kind} fid=${hitF.fid}` : "null")
    await tab.focusField(hitF.fid)
    ok("按命中的编号聚焦后，页面焦点真的在那个输入框上",
      (await tab.evalJs("document.activeElement && document.activeElement.id")) === "kw",
      await tab.evalJs("document.activeElement && document.activeElement.id"))

    // ── 折叠行：点标记行要能认出折叠块 ──
    const fold = locate((s) => s.kind === "fold")
    ok("折叠标记行可定位", !!fold, fold ? `行 ${fold.row} foldId=${fold.src.foldId}` : "")
    const hitFold = hitTestRows(rows, fold.row, fold.col + 3)
    ok("点在折叠标记上 → 命中 fold 块", hitFold?.kind === "fold" && hitFold.foldId === fold.src.foldId,
      hitFold ? `kind=${hitFold.kind}` : "null")

    // ── 整屏每一行的宽度仍然守恒（改了 per-segment run 生成，必须复查）──
    const widths = rows.map((r) => r.reduce((acc, x) => acc + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
    const badW = widths.map((w, i) => (w === PC ? -1 : i)).filter((i) => i >= 0)
    ok("每行宽度严格等于终端宽（分段渲染没破坏宽度守恒）", badW.length === 0,
      badW.length ? `异常行 ${badW.slice(0, 5).join(",")} 宽度 ${badW.map((i) => widths[i]).slice(0, 5).join(",")}` : `${rows.length} 行全部 ${PC} 列`)

    // ── 滚轮：坐标落在页面区之外也不能崩（主程序据此过滤）──
    const ev = parseSgrMouse(B("\x1b[<65;10;3M"), 0)
    ok("滚轮事件可解析（主程序按行号过滤页面区）", classifyMouse(ev)?.kind === "wheelDown" && ev.y === 3)

    // ── 枚举编号与真实元素必须严格同序同长 ──
    // 这是「本地一切正常、真实站点点了没反应」的根因：out 按矩形去重，
    // 而 clickIndex 查的 window.__etuiEls 没去重，一组等尺寸元素就能让下标错开。
    // 夹具里放了两个矩形完全相同的按钮来钉死这个不变量。
    const chk = await tab.evalJs(`(() => {
      const els = window.__etuiEls || []
      const SX = scrollX, SY = scrollY
      return { n: els.length, rects: els.map(e => { const r = e.getBoundingClientRect()
        return [Math.round(r.x + SX), Math.round(r.y + SY), Math.round(r.width), Math.round(r.height)] }) }
    })()`)
    ok("夹具里确实存在等尺寸元素（否则这条断言是空转）",
      (await tab.evalJs("document.querySelectorAll('#dup-1,#dup-2').length")) === 2 &&
      (await tab.evalJs("(() => { const a=document.getElementById('dup-1').getBoundingClientRect(), b=document.getElementById('dup-2').getBoundingClientRect(); return a.x===b.x && a.y===b.y && a.width===b.width && a.height===b.height })()")) === true)
    ok("__etuiEls 与枚举结果同长（去重后仍一一对应）", chk.n === els.length,
      `__etuiEls=${chk.n} 枚举=${els.length}`)
    const misalign = []
    for (const e of els) {
      const r = chk.rects[e.i]
      if (!r || r[0] !== e.x || r[1] !== e.y || r[2] !== e.w || r[3] !== e.h) misalign.push(`${e.i}:${e.tag}`)
    }
    ok("每一项的编号都能索引到同一个元素（编号不错位）", misalign.length === 0,
      misalign.length ? `错位 ${misalign.slice(0, 6).join(",")}` : `${els.length} 项全部对齐`)

    // ── target=_blank 必须在本标签打开 ──
    const blank = locate((s) => s.href === "#blank-target")
    ok("_blank 链接在文本流里可定位", !!blank, blank ? `行 ${blank.row}` : "")
    if (blank) {
      const mB2 = matchElement(els, blank.src)
      await tab.evalJs("window.__hit = []")
      await tab.evalJs("location.hash = ''")
      await tab.scrollElIntoView(mB2.index)
      await new Promise((r) => setTimeout(r, 80))
      const bx = await tab.clickIndex(mB2.index)
      await new Promise((r) => setTimeout(r, 400))
      const hits = await tab.evalJs("window.__hit || []")
      const hash = await tab.evalJs("location.hash")
      ok("点击 _blank 链接：onclick 触发", !bx?.offscreen && hits.includes("BLANK"), `hits=${JSON.stringify(hits)}`)
      ok("点击 _blank 链接：在本标签打开（地址真的变了，而不是静默开新标签）",
        hash === "#blank-target", `location.hash=${hash || "(空)"}`)
      ok("页面上的 target 已被摘掉（下次点击仍是本标签）",
        (await tab.evalJs("document.getElementById('lnk-blank').hasAttribute('target')")) === false)
    }
  } finally {
    try { await edge.quit() } catch {}
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
