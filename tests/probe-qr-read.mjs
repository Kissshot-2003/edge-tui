import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS, PAGE_META } from "../src/extract.js"
import { READ_MEDIA_QR } from "../src/qr.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2200))

  const blocks = (await tab.evalJs(EXTRACT_BLOCKS)).blocks
  const medias = blocks.filter((b) => b.kind === "media")
  console.log(`块 ${blocks.length} · 媒体块 ${medias.length}`)
  for (const m of medias) {
    console.log(`  mi=${m.mi} ${m.tag} ${m.w}x${m.h} alt="${m.alt}"`)
  }

  const elInfo = await tab.evalJs(`(() => {
    const els = window.__etuiMediaEls || []
    return els.map((e, i) => {
      const r = e.getBoundingClientRect()
      const cs = getComputedStyle(e)
      let note = ''
      let sample = null
      if (e.tagName === 'CANVAS') {
        try {
          const ctx = e.getContext('2d')
          note = ctx ? 'ctx-ok' : 'ctx-null'
          if (ctx) {
            const d = ctx.getImageData(0, 0, e.width, e.height).data
            let lo = 255, hi = 0, dark = 0
            for (let i = 0; i < d.length; i += 4) {
              const L = (d[i]*299 + d[i+1]*587 + d[i+2]*114)/1000
              if (L < lo) lo = L
              if (L > hi) hi = L
              if (L < 128) dark++
            }
            sample = { w: e.width, h: e.height, lo: Math.round(lo), hi: Math.round(hi), darkPct: Math.round(dark/(e.width*e.height)*100) }
          }
        } catch (err) { note = 'ERR ' + err.name }
      } else if (e.tagName === 'IMG') {
        note = 'natural=' + e.naturalWidth + 'x' + e.naturalHeight + ' src=' + String(e.src).slice(0, 50)
      }
      return { i, tag: e.tagName, cls: String(e.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height),
               disp: cs.display, vis: cs.visibility, note, sample }
    })
  })()`)
  console.log("── __etuiMediaEls ──")
  for (const e of elInfo) console.log("  " + JSON.stringify(e))

  const qrs = await tab.evalJs(READ_MEDIA_QR)
  console.log("── READ_MEDIA_QR ──")
  qrs.forEach((q, i) => console.log(`  [${i}] ` + (q ? `n=${q.n} purity=${q.purity.toFixed(3)} src=${q.src}` : "null")))
} finally {
  try { await edge.quit() } catch {}
}
