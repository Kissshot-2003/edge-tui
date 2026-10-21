// 探查：知乎登录页在「文字模式」里的行分布
// 目的：确认「验证码登录 / 密码登录 / 手机号」这些登录入口落在第几行，
//       从而判断首屏是否够用、需要滚动多少。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage } from "../src/textbrowser.js"

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1800))

  const W = 98
  const page = await buildTextPage(tab, { width: W, viewport: false, indent: 1, maxMediaRows: 14 })
  const res = renderTextPage(page, { width: W, maxRows: 9999, yOffset: 0 })

  console.log(`总行数 ${res.totalRows} · 块 ${page.blocks.length} · 排版行 ${page.lines.length}\n`)

  // 列出所有含关键字的行号
  const keys = ["验证码登录", "密码登录", "开通机构号", "手机号", "获取短信验证码", "忘记密码", "登录", "中国", "扫一扫", "其他扫码"]
  const flat = res.rows.map((r) => r.map((x) => x.t).join(""))
  for (const k of keys) {
    const hits = flat.map((t, i) => (t.includes(k) ? i + 1 : 0)).filter(Boolean)
    console.log(`  ${k.padEnd(16)} → 行 ${hits.join(", ") || "（未出现）"}`)
  }

  console.log("\n── 前 40 行内容 ──")
  flat.slice(0, 40).forEach((t, i) => {
    const s = t.replace(/\s+$/, "")
    if (s.trim()) console.log(String(i + 1).padStart(3) + "|" + s.slice(0, 80))
    else console.log(String(i + 1).padStart(3) + "|")
  })

  // 媒体块各占多少行
  console.log("\n── 媒体块占行 ──")
  let ln = 0
  for (const l of page.lines) {
    if (l.type === "media") console.log(`  ${l.tag} ${l.alt || ""} ${l.srcW}×${l.srcH} → 起始行 ${ln + 1}, 约 ${l.art ? l.art.rows + 2 : 2} 行`)
    if (l.type === "media") ln += l.art ? l.art.rows + 2 : 2
    else if (l.type === "blank") ln += 1
    else ln += l.wrapped || 1
  }
} finally {
  try { await edge.quit() } catch {}
}
