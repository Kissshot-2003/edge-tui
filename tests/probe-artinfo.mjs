// 探针：给真实页面的每张媒体图量「信息量」（最常见字符的占比）。
// 目的：为「低信息量图 → 降级成一行占位」选一个有依据的阈值，
// 而不是拍脑袋。渲染出来的字符画好不好看，最终要拿真实页面说话。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"

const PAGES = [
  ["百度首页（logo 是一大块噪点）", "https://www.baidu.com/"],
  ["澎湃新闻（新闻配图）", "https://www.thepaper.cn/"],
  ["必应首页", "https://cn.bing.com/"],
  ["GitHub Trending", "https://github.com/trending"],
]

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  for (const [name, url] of PAGES) {
    try {
      await tab.navigate(url, { timeoutMs: 15000 })
      const page = await buildTextPage(tab, { width: 78, viewport: false, indent: 1, maxMediaRows: 8, qrMaxRows: 23 })
      console.log(`\n── ${name} ──`)
      for (const l of page.lines.filter((x) => x.type === "media")) {
        if (!l.art || !l.art.chars) { console.log(`   (${l.tag} ${l.srcW}×${l.srcH} 无 art)`); continue }
        const n = l.art.chars.length
        const hist = {}
        for (let i = 0; i < n; i++) { const c = String.fromCharCode(l.art.chars[i]); hist[c] = (hist[c] || 0) + 1 }
        const sorted = Object.entries(hist).sort((a, b) => b[1] - a[1])
        const top3 = sorted.slice(0, 3).map(([c, k]) => `${JSON.stringify(c)}:${((k / n) * 100).toFixed(0)}%`).join(" ")
        console.log(`   ${l.tag} ${String(l.srcW).padStart(4)}×${String(l.srcH).padStart(4)}  ${String(l.art.cols).padStart(3)}×${String(l.art.rows).padStart(2)}  flat=${l.art.flat.toFixed(2)}  distinct=${sorted.length}  ${top3}`)
      }
    } catch (e) {
      console.log(`\n── ${name} ── 失败：${String(e?.message || e).slice(0, 80)}`)
    }
  }
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
