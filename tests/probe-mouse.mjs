// 探针（不参与回归）：真实站点上鼠标链路的覆盖率。
//
// 统计「带来源块的 run 里有多少能真的匹配到可交互元素」—— 这个比例就是
// 「用户在屏幕上看着像链接的地方，点下去有多少是有效的」。
// 太低说明命中判定或枚举口径对不上；本地夹具永远是 100%，只有真实站点能给真数。
//
// 用法：node tests/probe-mouse.mjs [url...]
//
// 顺带验证「点一下真的会发生事」：地址是否变化、控件是否真的拿到焦点。
// 注意 _blank 链接：修好之前这里是 false（Chromium 在后台静默开新标签，
// 终端里看不到任何反应），修好之后应当是 true。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { hitTestRows, matchElement } from "../src/mouse.js"

const PC = 78
const urls = process.argv.slice(2).filter((a) => !a.startsWith("-"))
if (!urls.length) urls.push("https://cn.bing.com/", "https://cn.bing.com/search?q=test")

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  for (const u of urls) {
    await tab.navigate(u)
    await new Promise((r) => setTimeout(r, 1800))
    const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
    const res = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
    const rows = res.rows
    const els = await tab.enumerateInteractive(880, 520)

    // 统计：有多少个带 src 的 run 能匹配到可交互元素
    let runs = 0, clickable = 0, links = 0
    const sample = []
    const misses = []
    for (let r = 0; r < rows.length; r++) {
      let col = 0
      for (const run of rows[r]) {
        const w = run.w !== undefined ? run.w : strWidth(String(run.t ?? ""))
        if (run.src) {
          runs++
          const hit = hitTestRows(rows, r, col)
          const m = matchElement(els, run.src)
          if (hit === run.src && m && m.overlap > 0) {
            clickable++
            if (sample.length < 4) sample.push(`r${r}c${col}「${String(run.t).trim().slice(0, 16)}」→ #${m.index} ${m.el.tag}`)
          } else if (misses.length < 6) {
            misses.push(`r${r}c${col}「${String(run.t).trim().slice(0, 18)}」${hit === run.src ? "(元素重叠为 0)" : "(命中判定不符)"}`)
          }
          if (run.src.href) links++
        }
        col += w
      }
    }
    console.log(`\n### ${u}`)
    console.log(`  排版 ${rows.length} 行 · 带来源块的 run ${runs} 个 · 其中可点击 ${clickable} 个 (${(clickable / Math.max(1, runs) * 100).toFixed(0)}%) · 带 href ${links}`)
    sample.forEach((s) => console.log("   " + s))
    if (misses.length) {
      console.log("   未命中样本（正常：纯文字块本来就没得点）：")
      misses.forEach((s) => console.log("     " + s))
    }

    // 真点一个：搜索框（field 块优先，退回链接）
    const f = (page.fields || []).find((x) => !x.btn && !x.disabled && !x.readonly && x.fid !== undefined)
    let box = null
    if (f) {
      box = await tab.focusField(f.fid)
      const ae = await tab.evalJs("document.activeElement && (document.activeElement.id || document.activeElement.tagName)")
      console.log(`  控件「${f.type}」聚焦 → activeElement=${ae}`)
    }
    const firstLink = (() => {
      for (const run of rows.flat()) if (run.src?.href) return run.src
      return null
    })()
    if (firstLink) {
      const m = matchElement(els, firstLink)
      if (m) {
        const before = await tab.evalJs("location.href")
        await tab.scrollElIntoView(m.index)
        await new Promise((r) => setTimeout(r, 80))
        const bx = await tab.clickIndex(m.index)
        await new Promise((r) => setTimeout(r, 1200))
        const after = await tab.evalJs("location.href")
        console.log(`  点链接「${String(firstLink.text || "").trim().slice(0, 20)}」→ ${bx ? bx.tag : "null"} · 地址变化: ${before !== after}`)
      }
    }
  }
} finally { try { await edge.quit() } catch {} }
