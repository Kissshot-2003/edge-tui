// 探针：真实网页上「折叠内容」的探测情况。
// 关注三件事：① 提取有没有变慢（折叠探测要为每个隐藏块找展开控件）
//             ② 正常页面会不会误报（把隐藏菜单当成折叠内容）
//             ③ 真站点上到底有多少折叠、标题是什么
//
// 用法：node tests/probe-fold.mjs [url...]
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, applyFoldState } from "../src/textbrowser.js"

const urls = process.argv.slice(2).filter((a) => !a.startsWith("-"))
if (!urls.length) {
  urls.push("https://www.zhihu.com/signin", "https://cn.bing.com", "https://developer.mozilla.org/zh-CN/docs/Web/HTML/Element/details")
}

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  for (const u of urls) {
    console.log("\n════ " + u)
    try {
      await tab.navigate(u)
      await new Promise((r) => setTimeout(r, 1500))
      const t0 = Date.now()
      const page = await buildTextPage(tab, { width: 78, viewport: false, indent: 1 })
      const ms = Date.now() - t0
      const folds = page.folds || []
      console.log(`  提取 ${ms}ms · blocks=${page.blocks.length} · lines=${page.lines.length} · folds=${folds.length} · 丢弃隐藏文本=${page.droppedHidden || 0} 字`)
      for (const f of folds.slice(0, 6)) {
        console.log(`   · [${f.reason}] ${f.label} —— ${f.len} 字，正文首句：${String(f.text).slice(0, 40).replace(/\n/g, " ")}`)
      }
      if (folds.length) {
        const r0 = renderTextPage(page, { width: 78, maxRows: 9999, yOffset: 0 })
        applyFoldState(page, new Set(folds.map((f) => f.id)), 78)
        const r1 = renderTextPage(page, { width: 78, maxRows: 9999, yOffset: 0 })
        console.log(`  展开后行数：${r0.totalRows} → ${r1.totalRows}`)
      }
    } catch (e) {
      console.log("  失败：" + (e?.message || e))
    }
  }
} finally {
  try { await edge.quit() } catch {}
}
