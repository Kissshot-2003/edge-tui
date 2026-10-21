// 对比：几何排序 vs DOM 文档顺序，哪个读起来更顺
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1000, height: 900 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 3000))

  // 只按 DOM 顺序收集叶子文字块（不排序）
  const seq = await tab.evalJs(`(() => {
    const out = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    const hasTextDeep = (n) => (n.innerText || '').trim().length > 0
    let n
    while ((n = walker.nextNode())) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const r = n.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const kids = [...n.childNodes]
      const elemKids = kids.filter(k => k.nodeType === 1 && hasTextDeep(k))
      const mediaKids = kids.filter(k => k.nodeType === 1 && /^(IMG|CANVAS|VIDEO)$/.test(k.tagName))
      if (elemKids.length || mediaKids.length) continue
      const t = (n.innerText || '').replace(/\\s+/g,' ').trim()
      if (!t) continue
      out.push({ y: Math.round(r.y + scrollY), x: Math.round(r.x + scrollX),
                 w: Math.round(r.width), h: Math.round(r.height), text: t.slice(0, 60),
                 tag: n.tagName,
                 fs: parseFloat(getComputedStyle(n).fontSize) || 16 })
    }
    return out
  })()`)

  console.log("── DOM 文档顺序 ──")
  seq.forEach((b, i) => console.log(`  ${String(i).padStart(2)}. y=${String(b.y).padStart(4)} x=${String(b.x).padStart(4)} ${b.text}`))
  console.log(`\n共 ${seq.length} 块`)
} finally {
  edge.quit()
}
