// 探针：一次「整页抓取」vs 一次「行窗口重排」各要多久？
//
// 用来量化用户投诉的「每动一下就要重新加载」到底有多贵：
// 旧 scrollPx 走的是一次完整 capture（等内容稳定 + 重新提取 DOM + 每个媒体块重新截图），
// 现在只走 renderTextPage（纯内存重排）。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"

const URL_ = process.argv[2] || "https://cn.bing.com/"
const PC = 78, PR = 24
const t = () => Date.now()
const ms = (f) => { const a = t(); return f().then((v) => [t() - a, v]) }
const fmt = (msArr) => msArr.map((x) => `${String(x).padStart(5)}ms`).join(" ")

// 合成一个"内容多、图也多"的页面：不依赖网络，数字可复现。
// 这正是旧 scrollPx 最惨的场景 —— 每次滚动都要重抓 40 张图。
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
const heavyHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>重页面</title></head><body>
<h1>重页面：长正文 + 40 张图</h1>
${Array.from({ length: 200 }, (_, i) => `<p>第 ${i + 1} 段正文，用来把页面撑得足够长。</p>`).join("\n")}
${Array.from({ length: 40 }, (_, i) => `<img src="data:image/png;base64,${PNG1x1}" width="300" height="200" alt="配图${i + 1}">`).join("\n")}
</body></html>`

async function measure(label, url) {
  await tab.navigate(url, { timeoutMs: 12000 })
  const fulls = []
  for (let i = 0; i < 3; i++) {
    const [a] = await ms(() => buildTextPage(tab, {
      width: PC, viewport: false, indent: 1,
      maxMediaRows: Math.max(4, Math.min(12, Math.floor(PR / 3))),
      qrMaxRows: Math.max(8, PR - 1),
    }))
    fulls.push(a)
  }
  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const media = page.lines.filter((l) => l.type === "media").length

  const rer = []
  for (let i = 0; i < 60; i++) {
    const [a] = await ms(async () => {
      renderTextPage(page, { width: PC, maxRows: PR, yOffset: i % 20 })
    })
    rer.push(a)
  }
  rer.sort((a, b) => a - b)

  const avgFull = Math.round(fulls.reduce((a, b) => a + b, 0) / fulls.length)
  const avgRer = Math.round(rer.reduce((a, b) => a + b, 0) / rer.length)
  console.log(`\n【${label}】排版行 ${page.lines.length}，媒体块 ${media} 个`)
  console.log(`  旧路径 整页抓取  ${fmt(fulls)}   平均 ${avgFull}ms   ← 每滚一步都走这个`)
  console.log(`  新路径 行窗口重排 p50=${rer[Math.floor(rer.length / 2)]}ms p95=${rer[Math.floor(rer.length * 0.95)]}ms   平均 ${avgRer}ms   ← 现在滚一步走这个`)
  console.log(`  → 每滚一步：${avgFull}ms → ${avgRer}ms（约 ${(avgFull / Math.max(1, avgRer)).toFixed(0)} 倍），后者完全不碰浏览器`)
  return { avgFull, avgRer }
}

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await measure("真实站点 " + URL_, URL_)
  await measure("合成重页面（长正文 + 40 图）", "data:text/html;charset=utf-8," + encodeURIComponent(heavyHtml))
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
