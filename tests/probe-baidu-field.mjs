// 探针：百度首页的搜索框到底被识别成了什么？
// 用户看到的怪象：▢ 文本域「中国女排3比0菲律宾女排」· 空 —— 搜索框挂着一条新闻标题，
// 而且被当成"文本域"。把 DOM 事实挖出来。
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.baidu.com", { timeoutMs: 15000 })
  const r = await tab.evalJs(`(() => {
    const out = []
    for (const el of document.querySelectorAll('input,textarea,[contenteditable]')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const r2 = el.getBoundingClientRect()
      if (r2.width < 40 || r2.height < 10) continue
      out.push({
        tag: el.tagName, type: el.type || '', id: el.id || '', name: el.name || '',
        cls: String(el.className || '').slice(0, 40),
        ph: el.placeholder || '', aria: el.getAttribute('aria-label') || '',
        title: el.title || '', val: String(el.value || '').slice(0, 20),
        w: Math.round(r2.width), h: Math.round(r2.height),
        label: (el.labels && el.labels[0] ? el.labels[0].innerText.slice(0, 24) : ''),
        form: !!el.form, editable: el.isContentEditable,
      })
    }
    return out
  })()`)
  for (const f of r) {
    console.log(`${f.tag}${f.type ? "[" + f.type + "]" : ""} #${f.id} name=${f.name} ${f.w}×${f.h}`)
    console.log(`   placeholder=${JSON.stringify(f.ph)} aria=${JSON.stringify(f.aria)} title=${JSON.stringify(f.title)} label=${JSON.stringify(f.label)}`)
    console.log(`   class=${JSON.stringify(f.cls)} form=${f.form} value=${JSON.stringify(f.val)}`)
  }
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(0)
