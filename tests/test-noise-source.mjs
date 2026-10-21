// 定位知乎首屏左侧重噪声区的来源元素
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 432, height: 224 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(432, 224)
  await new Promise((r) => setTimeout(r, 300))

  const info = await tab.evalJs(`(() => {
    const pts = [[60,60],[60,120],[60,180],[30,90],[200,60],[350,170]]
    return pts.map(([x,y]) => {
      const e = document.elementFromPoint(x, y)
      if (!e) return { pt: [x,y], el: null }
      const cs = getComputedStyle(e)
      return {
        pt: [x,y],
        tag: e.tagName,
        cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60),
        parentCls: (typeof e.parentElement?.className === 'string' ? e.parentElement.className : '').slice(0, 60),
        bgImg: cs.backgroundImage.slice(0, 80),
        txt: (e.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 30),
      }
    })
  })()`)
  for (const x of info) {
    console.log(`pt(${x.pt}) ${x.tag} cls="${x.cls}" parent="${x.parentCls}"`)
    console.log(`      bgImg=${x.bgImg || "(无)"}  text=${JSON.stringify(x.txt)}`)
  }
} finally {
  edge.quit()
}
