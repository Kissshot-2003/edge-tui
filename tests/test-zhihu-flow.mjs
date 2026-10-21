// 最终验收：模拟用户「上知乎找不到登录入口」的完整流程
import { launchEdge } from "../src/cdp.js"
import { pngToGrid } from "../src/ascii.js"

const CELL_W = 4, CELL_H = 8
const PAGE_BG = [11, 23, 38]
const W = 110, H = 36
const PC = W - 2, PR = H - 3 - 5

const edge = await launchEdge({ width: PC * CELL_W, height: PR * CELL_H })
const { tab } = edge
let pass = 0, fail = 0
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); ok ? pass++ : fail++ }

const render = async (label) => {
  const g = pngToGrid(await tab.screenshot(false), CELL_W, CELL_H, PAGE_BG, { contrast: 1.35 })
  console.log(`\n────── ${label} ──────`)
  for (let r = 0; r < Math.min(g.rows, PR); r++) {
    let line = ""
    for (let c = 0; c < PC; c++) {
      const i = r * g.cols + c
      line += i < g.chars.length ? String.fromCharCode(g.chars[i]) : " "
    }
    const t = line.replace(/\s+$/, "")
    if (t.trim()) console.log(t)
  }
}

try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(PC * CELL_W, PR * CELL_H)
  await new Promise((r) => setTimeout(r, 300))

  console.log("【场景】用户打开知乎登录页")
  await render("初始视图")

  console.log("\n【步骤 1】按 v 打开元素清单，枚举视口内可交互元素")
  const els = await tab.enumerateInteractive(PC * CELL_W, PR * CELL_H)
  const inVp = els.filter((e) => e.inVp)
  check("枚举成功", els.length > 0, `全页 ${els.length} 项`)
  check("视口内有可交互元素", inVp.length > 0, `${inVp.length} 项`)
  inVp.forEach((e) => console.log(`      [${e.i + 1}] ${e.tag}${e.type ? ":" + e.type : ""} — ${e.text}`))

  console.log("\n【步骤 2】滚动定位到「手机号」输入框（原本在视口外）")
  const phone = els.find((e) => e.type === "tel" && /手机号/.test(e.text))
  check("找到手机号输入框", !!phone, phone ? `初始 y=${phone.y}（视口高 ${PR * CELL_H}）` : "")
  if (phone) {
    const box = await tab.scrollElIntoView(phone.i)
    check("滚动后进入视口", box && box.y >= 0 && box.y + box.h <= PR * CELL_H, box ? `y=${Math.round(box.y)}` : "")
    await render("滚动定位后的表单")

    console.log("\n【步骤 3】真实鼠标点击输入框并输入手机号")
    const c = await tab.clickIndex(phone.i)
    await new Promise((r) => setTimeout(r, 300))
    await tab.insertText("13800138000")
    await new Promise((r) => setTimeout(r, 400))
    const v = await tab.evalJs(`document.querySelector('input[type=tel]')?.value || ''`)
    check("点击 + 输入生效", /1380/.test(v), `输入框值 = ${JSON.stringify(v)}`)
    await render("输入手机号后")
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
} finally {
  edge.quit()
}
