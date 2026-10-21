// 不经 TTY：直接驱动 run.mjs 的 picker 逻辑所依赖的 cdp 能力
// 验证「清单 → 移动 → 定位 → 点击」整条链路（即按键处理器里真正调用的东西）
import { launchEdge } from "../src/cdp.js"

const CELL_W = 4, CELL_H = 8
const PC = 108, PR = 28
const edge = await launchEdge({ width: PC * CELL_W, height: PR * CELL_H })
const { tab } = edge
let pass = 0, fail = 0
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); ok ? pass++ : fail++ }

try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(PC * CELL_W, PR * CELL_H)
  await new Promise((r) => setTimeout(r, 300))
  await tab.scrollTarget()

  // enterPicker() 的等价流程：枚举全页元素，从视口内首项开始
  const all = await tab.enumerateInteractive(PC * CELL_W, PR * CELL_H)
  check("枚举全页元素", all.length > 0, `${all.length} 项`)
  const firstVp = all.findIndex((e) => e.inVp)
  check("找到视口内的起始项", firstVp >= 0, firstVp >= 0 ? `index=${firstVp}` : "无")
  let pickInfo = all[firstVp >= 0 ? firstVp : 0]
  console.log(`    起始选中: [${pickInfo.i + 1}] ${pickInfo.tag} ${pickInfo.text}`)

  // pickMove(down) 的等价流程：逐项下移 + scrollElIntoView 定位
  console.log("\n  模拟连续按 ↓（每步应滚动定位到该项）:")
  for (let k = 1; k <= 8; k++) {
    const cur = all.findIndex((e) => e.i === pickInfo.i)
    const next = (((cur < 0 ? 0 : cur) + 1) % all.length + all.length) % all.length
    pickInfo = all[next]
    const box = await tab.scrollElIntoView(pickInfo.i)
    const vh = PR * CELL_H
    const visible = box && box.visH > 0 && box.visY >= 0 && box.visY < vh
    console.log(`    ↓${k} [${pickInfo.i + 1}] ${pickInfo.tag.padEnd(11)} ${pickInfo.text.slice(0, 18).padEnd(20)} ` +
      `visY=${box ? Math.round(box.visY) : "?"} visH=${box ? Math.round(box.visH) : "?"} ${visible ? "✓可见" : "✗不可见"}`)
    if (!visible) fail++
  }
  check("连续下移均能把选中项带进视野", fail === 0)

  // pickActivate() 的等价流程：点击「手机号」输入框
  console.log("\n  定位并点击「手机号」:")
  const phone = all.find((e) => e.type === "tel" && /手机号/.test(e.text))
  const box2 = await tab.scrollElIntoView(phone.i)
  check("滚入视口", box2 && box2.visH > 0, box2 ? `visY=${Math.round(box2.visY)}` : "")
  const c = await tab.clickIndex(phone.i)
  check("点击未越界", c && !c.offscreen, c ? `(${Math.round(c.cx)},${Math.round(c.cy)}) 视口 ${PC * CELL_W}x${PR * CELL_H}` : "")
  await new Promise((r) => setTimeout(r, 300))
  await tab.insertText("13900139000")
  await new Promise((r) => setTimeout(r, 300))
  const v = await tab.evalJs(`document.querySelector('input[type=tel]')?.value || ''`)
  check("输入生效", /1390/.test(v), `值=${JSON.stringify(v)}`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
} finally {
  edge.quit()
}
