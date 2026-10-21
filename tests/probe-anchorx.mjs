import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, renderedRowCount } from "../src/textbrowser.js"
const PC = 98
const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1800))
  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  console.log("── 锚点（渲染行 / y / x..x+w / 文本）──")
  let rowAcc = 0
  for (const l of page.lines) {
    const src = l.type === "media" ? l.block : l.item
    if (src && Number.isFinite(src.y)) {
      const k = ["验证码登录","密码登录","开通机构号","中国"].find((s) => l.type === "text" && String(l.text||"").startsWith(s))
      if (k) console.log(`  行${rowAcc}  y=${src.y} h=${src.h} x=${src.x} w=${src.w} → x1=${src.x+src.w}  「${l.text}」`)
    }
    rowAcc += renderedRowCount(l)
  }
  await tab.scrollTarget()
  const els = await tab.enumerateInteractive(880, 520)
  console.log("── 元素 ──")
  for (const kw of ["验证码登录","密码登录","开通机构号","中国"]) {
    const e = els.find((x) => String(x.text||"").includes(kw))
    if (e) console.log(`  ${kw}: y=${e.y} h=${e.h} x=${e.x} w=${e.w} → x1=${e.x+e.w}`)
  }
} finally { try { await edge.quit() } catch {} }
