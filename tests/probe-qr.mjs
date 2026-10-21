// 探针：二维码到底用什么元素渲染的
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1000, height: 900 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 3000))

  const info = await tab.evalJs(`(() => {
    const out = { canvases: [], qr: null, imgs: [] }
    document.querySelectorAll('canvas').forEach(c => {
      const r = c.getBoundingClientRect()
      out.canvases.push({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })
    })
    document.querySelectorAll('img').forEach(i => {
      const r = i.getBoundingClientRect()
      out.imgs.push({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
                      src: (i.currentSrc||i.src||'').slice(0,60), alt: i.alt })
    })
    const q = document.querySelector('.Qrcode-container, .Qrcode, [class*=Qrcode], [class*=qrcode]')
    if (q) {
      const r = q.getBoundingClientRect()
      const cs = getComputedStyle(q)
      out.qr = { cls: q.className, tag: q.tagName, w: Math.round(r.width), h: Math.round(r.height),
                 x: Math.round(r.x), y: Math.round(r.y), bgImg: cs.backgroundImage.slice(0,80),
                 childCount: q.children.length,
                 innerHTML: q.innerHTML.slice(0, 300) }
    }
    return out
  })()`)
  console.log(JSON.stringify(info, null, 2))
} finally {
  edge.quit()
}
