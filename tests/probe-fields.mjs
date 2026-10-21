// 探针：页面上有哪些表单控件？为什么在文字模式里看不见？
//
// 用户投诉：「Bing 页面看不到搜索的输入框，无法搜索」。
// 原因候选：
//   ① input/textarea 根本不是「文字块」也不是「媒体块」→ 提取器完全跳过
//   ② 它被判成不可见（headless 下 Bing 的搜索框会不会是 display:none？）
//   ③ 它在视口外 / 在折叠容器里
// 用法：node tests/probe-fields.mjs [url...]
import { launchEdge } from "../src/cdp.js"
import { EXTRACT_BLOCKS } from "../src/extract.js"

const urls = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const list = urls.length ? urls : [
  "https://cn.bing.com/",
  "https://www.bing.com/search?q=%E6%B5%8B%E8%AF%95",
  "https://developer.mozilla.org/zh-CN/docs/Web/HTML/Element/input",
]

const PROBE = `(() => {
  const out = []
  for (const el of document.querySelectorAll('input,textarea,select,button,[role=search],[role=combobox]')) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    out.push({
      tag: el.tagName,
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      cls: (el.className || '').toString().slice(0, 40),
      ph: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      role: el.getAttribute('role') || '',
      val: (el.value || '').slice(0, 20),
      disp: cs.display, vis: cs.visibility, op: cs.opacity,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      op2: !!el.offsetParent || el === document.body,
      readOnly: el.readOnly, disabled: el.disabled,
    })
  }
  return { total: document.querySelectorAll('*').length, fields: out }
})()`

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  for (const u of list) {
    await tab.setViewport(880, 520)
    await tab.navigate(u)
    await new Promise((r) => setTimeout(r, 1400))
    const p = await tab.evalJs(PROBE)
    console.log(`\n${"=".repeat(90)}\n### ${u}\n    元素总数 ${p.total} · 表单控件 ${p.fields.length}`)
    for (const f of p.fields) {
      const boxed = f.w > 0 && f.h > 0
      console.log(
        `  ${boxed ? "▪" : "·"} <${f.tag.toLowerCase()}${f.type ? " type=" + f.type : ""}>` +
        ` ${f.w}×${f.h} @(${f.x},${f.y})` +
        ` disp=${f.disp} vis=${f.vis}` +
        ` id="${f.id}" name="${f.name}"` +
        (f.ph ? ` ph="${f.ph}"` : "") + (f.aria ? ` aria="${f.aria}"` : "") +
        (f.title ? ` title="${f.title}"` : "") +
        (f.val ? ` val="${f.val}"` : "")
      )
    }
    const { blocks } = await tab.evalJs(EXTRACT_BLOCKS)
    const kinds = {}
    for (const b of blocks) kinds[b.kind] = (kinds[b.kind] || 0) + 1
    console.log(`  提取器块：${JSON.stringify(kinds)}`)
    // 搜索框候选判定：文字模式下的「主输入框」应该选谁？
    const main = p.fields.filter((f) => f.w > 80 && f.h > 12 && f.disp !== "none" && f.vis !== "hidden"
      && /^(INPUT|TEXTAREA)$/.test(f.tag) && f.type !== "hidden")
    console.log(`  可见可输入控件 ${main.length} 个：` +
      main.slice(0, 4).map((f) => `${f.type || "text"}[${f.ph || f.name || f.id || "?"}]`).join(" | "))
  }
} finally {
  try { await edge.quit() } catch {}
}
