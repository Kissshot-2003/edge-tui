// 探查：长文档在 buildTextPage 里到底提取到多少块、多少行
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"

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
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(longHtml))
  await new Promise((r) => setTimeout(r, 900))
  const meta = await tab.evalJs("({u:location.href.slice(0,60), docH:document.documentElement.scrollHeight, ih:window.innerHeight, ps:document.querySelectorAll('p').length, txtLen:document.body.innerText.length})")
  console.log("页面:", JSON.stringify(meta))

  const page = await buildTextPage(tab, { width: 78, viewport: false, indent: 1, maxMediaRows: 2 })
  console.log(`块 ${page.blocks.length} · 行 ${page.lines.length}`)
  const texts = page.lines.filter((l) => l.type === "text")
  console.log(`文字行 ${texts.length} · 空行 ${page.lines.filter((l) => l.type === "blank").length}`)
  console.log("前 5 个块的 y/h:", page.blocks.slice(0, 5).map((b) => `${b.kind}@${b.y},h${b.h}"${(b.text || "").slice(0, 14)}"`).join(" | "))
  console.log("末 3 个块的 y/h:", page.blocks.slice(-3).map((b) => `${b.kind}@${b.y},h${b.h}"${(b.text || "").slice(0, 14)}"`).join(" | "))
  const ys = page.blocks.filter((b) => b.kind === "text").map((b) => b.y)
  console.log("文字块 y 范围:", Math.min(...ys), "→", Math.max(...ys))
} catch (e) { console.error(e?.stack || e) } finally { try { await edge.quit() } catch {} }
