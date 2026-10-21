// 探针：能否从 DOM 提取「文字块 + 图片块」的有序序列，含坐标与层级
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1000, height: 900 })
const { tab } = edge
try {
  const url = process.argv[2] || "https://www.zhihu.com/signin"
  await tab.navigate(url)
  await new Promise((r) => setTimeout(r, 3000))

  const blocks = await tab.evalJs(`(() => {
    const out = []
    const seen = new Set()

    // 判定「叶子文字块」：自身含文字，且没有含文字的子元素（避免父子重复）
    const hasText = (n) => (n.innerText || '').trim().length > 0

    const walk = (el, depth) => {
      if (depth > 40) return
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      if (r.bottom < -2000 || r.top > 20000) return   // 只关心文档流范围内

      const tag = el.tagName
      // 图片/画布/视频 → 图片块（只认真正的媒体元素；
      // background-image 太常见了，很多容器都有，不能当图片块，否则整个 body 被吞掉）
      if (/^(IMG|CANVAS|VIDEO|PICTURE)$/.test(tag)) {
        const key = 'img' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width)
        if (!seen.has(key) && r.width >= 16 && r.height >= 16) {
          seen.add(key)
          out.push({ kind: 'img', tag,
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            alt: el.getAttribute('alt') || el.getAttribute('aria-label') || '',
            src: (el.currentSrc || el.src || '').slice(0, 80) })
        }
        return   // 图片内部不再下钻
      }

      // 找「直接子节点里有没有带文字的」——有则继续下钻，没有则本节点是叶子文字块
      const kids = [...el.childNodes]
      const textNodes = kids.filter(n => n.nodeType === 3 && n.textContent.trim())
      const elemKids = kids.filter(n => n.nodeType === 1 && hasText(n))
      const directText = textNodes.map(n => n.textContent).join('')

      if (elemKids.length === 0) {
        // 叶子：整段文字归本节点
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim()
        if (t) {
          const key = 'tx' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + t.slice(0,20)
          if (!seen.has(key)) {
            seen.add(key)
            out.push({ kind: 'text', tag,
              x: Math.round(r.x), y: Math.round(r.y),
              w: Math.round(r.width), h: Math.round(r.height),
              text: t,
              fs: cs.fontSize, fw: cs.fontWeight, color: cs.color,
              href: (el.closest('a')?.getAttribute('href') || '').slice(0, 60),
            })
          }
        }
        return
      }
      // 本节点还混有直接文字（如 <div>文字<a>链接</a></div>）
      if (directText.trim()) {
        const tr = el.getBoundingClientRect()
        out.push({ kind: 'text', tag: tag + '#mixed',
          x: Math.round(tr.x), y: Math.round(tr.y),
          w: Math.round(tr.width), h: Math.round(tr.height),
          text: directText.replace(/\\s+/g,' ').trim().slice(0, 120),
          fs: cs.fontSize, fw: cs.fontWeight, color: cs.color, href: '' })
      }
      for (const k of elemKids) walk(k, depth + 1)
    }

    walk(document.body, 0)
    return out
  })()`)

  const texts = blocks.filter(b => b.kind === "text")
  const imgs = blocks.filter(b => b.kind === "img")
  console.log(`共 ${blocks.length} 块：文字 ${texts.length}，图片 ${imgs.length}`)
  console.log("\n── 前 30 个文字块（按文档坐标排序）──")
  console.log("  y     x    w×h      字号  文字")
  texts.slice(0, 30).forEach(b => {
    console.log(`  ${String(b.y).padStart(4)} ${String(b.x).padStart(4)}  ${String(b.w+"×"+b.h).padEnd(9)} ${b.fs.padEnd(6)} ${b.text.slice(0, 44)}${b.href ? "  →" + b.href : ""}`)
  })
  console.log("\n── 图片块 ──")
  imgs.forEach(b => console.log(`  y=${b.y} x=${b.x} ${b.w}×${b.h} ${b.tag} alt="${b.alt}" ${b.src.slice(0,50)}`))
} finally {
  edge.quit()
}
