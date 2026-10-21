// 探查：知乎 → 输入 → 切到 data:URL 后，页面是否真的换了
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"

const longHtml = `<!doctype html><meta charset="utf-8"><title>长文档滚动测试</title>
<body style="font:16px/1.6 sans-serif;max-width:640px;margin:24px auto">
<h1>终端模拟器简史</h1>
${Array.from({ length: 60 }, (_, i) =>
  `<p>第 ${i + 1} 段：终端模拟器是把一个物理终端的行为用软件重现的程序。它接收键盘输入并送往伪终端，再把远端产生的字节流按转义序列解释成屏幕上的字符、颜色与光标位置。这一段文字足够长，用来验证排版引擎的折行与行级滚动是否正确。</p>`).join("\n")}
</body>`

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1500))
  console.log("A 当前URL:", (await tab.evalJs("location.href")).slice(0, 50))

  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(longHtml))
  await new Promise((r) => setTimeout(r, 900))
  const after = await tab.evalJs("({u:location.href.slice(0,50), ps:document.querySelectorAll('p').length, docH:document.documentElement.scrollHeight})")
  console.log("B 切换后:", JSON.stringify(after))

  const page = await buildTextPage(tab, { width: 78, viewport: false, indent: 1, maxMediaRows: 2 })
  const res = renderTextPage(page, { width: 78, maxRows: 24, yOffset: 0 })
  console.log(`C 块 ${page.blocks.length} · 行 ${page.lines.length} · 渲染总数 ${res.totalRows}`)
} catch (e) { console.error(e?.stack || e) } finally { try { await edge.quit() } catch {} }
