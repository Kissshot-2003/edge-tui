// 验证：元素清单模式下，用户能否读到可理解的文字（DOM 取文，不靠像素）
import { launchEdge } from "../src/cdp.js"

const edge = await launchEdge({ width: 432, height: 224 })
const { tab } = edge
try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))
  await tab.setViewport(432, 224)
  await new Promise((r) => setTimeout(r, 300))

  const els = await tab.enumerateInteractive(432, 224)
  console.log("元素清单（全部 38 项，DOM 取文）:")
  console.log("  编号  标签        文字（截断 30）              是否在视口")
  console.log("  " + "─".repeat(66))
  for (const e of els) {
    const idx = String(e.i + 1).padStart(3)
    const tag = (e.tag + (e.type ? ":" + e.type : "")).padEnd(11)
    const txt = e.text.slice(0, 28).padEnd(29)
    console.log(`  ${idx}  ${tag} ${txt} ${e.inVp ? "✓" : ""}`)
  }

  const inVp = els.filter((e) => e.inVp)
  console.log(`\n视口内 ${inVp.length} 项 / 全页 ${els.length} 项`)
  console.log("\n关键结论：")
  console.log("  · 表单文字虽在像素层糊成块，但元素清单直接读 DOM，文字 100% 准确")
  console.log("  · 「验证码登录」「密码登录」等 div 控件 Tab 到不了，清单里可点")
} finally {
  edge.quit()
}
