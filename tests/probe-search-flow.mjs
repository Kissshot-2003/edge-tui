// 复现用户投诉的完整搜索旅程：
//   ① 在搜索框里打字 —— 字有没有显示在控件行上？
//   ② 退格 —— 删不删得掉？
//   ③ 回车 —— 搜索结果有没有出现？
//
// 用户原话：「搜索结果无法显示，输入法在搜索框无法正常显示，输入关键字不可退格」
//
// 本探针**照抄 run.mjs 的真实调用顺序**（不是直连 CDP 的简化版）：
//   primaryField() → focusField() → 逐字符 insertText + fieldValue 回流 → paint 的数据流
// 这样才能区分"CDP 能用"和"我们的链路能用"。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, fieldDisplayName } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { EXTRACT_BLOCKS } from "../src/extract.js"

const URLS = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const TARGET = URLS[0] || "https://cn.bing.com/"

const PC = 78
const flat = (res) => res.rows.map((r) => r.map((x) => x.t).join(""))

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab

try {
  await tab.setViewport(880, 520)
  console.log(`══ 打开 ${TARGET} ══`)
  await tab.navigate(TARGET)
  await new Promise((r) => setTimeout(r, 1800))

  // ── 照抄 run.mjs#primaryField ──
  let page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const pageFields = () => (page.fields || []).filter((f) => f && f.kind === "field")
  const primary = pageFields()
    .filter((f) => !f.btn && !f.disabled && !f.readonly)
    .sort((a, b) => (b.score - a.score) || (a.y - b.y))[0]

  console.log(`控件总数 ${pageFields().length}，主输入框：`,
    primary ? `fid=${primary.fid} score=${primary.score} ${primary.w}x${primary.h}` : "(无)")
  if (!primary) { console.log("✗ 没有主输入框，后面全部无法进行"); process.exit(1) }
  console.log("  名称推断 =", JSON.stringify(fieldDisplayName(primary)))

  const fr = await tab.focusField(primary.fid)
  console.log(`focusField → ${JSON.stringify(fr)}`)

  const ar = await tab.activeRect()
  console.log("activeRect →", JSON.stringify(ar))
  if (!ar || ar.fid === null) console.log("  ⚠ activeRect 没报出 fid —— run.mjs 会走 primaryField 兜底")

  const field = () => (page.fields || []).find((f) => String(f.fid) === String(primary.fid))

  const show = (tag) => {
    const res = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0, activeFid: primary.fid })
    const rows = flat(res)
    const r = rows.find((s) => s.includes("搜索框") || s.includes("输入框"))
    const w = res.rows.find((x) => x.map((y) => y.t).join("").includes("搜索框"))
    const width = w ? w.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0) : 0
    console.log(`  ${tag} value=${JSON.stringify(field()?.value)}`)
    console.log(`      行=${JSON.stringify((r || "").trim())}  行宽=${width}`)
  }

  // ── ① 打字：逐字符 insertText（完全照 run.mjs 的 pageinput 分支）──
  console.log("\n── ① 打字（逐字符 insertText + fieldValue 回流）──")
  for (const ch of ["安", "徽", "安", "徽"]) {
    await tab.insertText(ch)
    await new Promise((r) => setTimeout(r, 90))
    const v = await tab.fieldValue(primary.fid)
    // 模拟 syncActiveField 的早退条件
    const f = field()
    const early = (v === null || v === f.value)
    if (!early) f.value = v
    console.log(`  打入 ${ch} → fieldValue=${JSON.stringify(v)}  change=${!early}`)
  }
  show("打字后")

  // ── ② 退格 ──
  console.log("\n── ② 退格（tab.pressBackspace 直连，看 CDP 层能不能删）──")
  for (let i = 0; i < 2; i++) {
    await tab.pressBackspace()
    await new Promise((r) => setTimeout(r, 120))
    const v = await tab.fieldValue(primary.fid)
    const f = field()
    const early = (v === null || v === f.value)
    if (!early) f.value = v
    console.log(`  退格 → fieldValue=${JSON.stringify(v)}  change=${!early}`)
  }
  show("退格后")

  // ── ②' 退格：用 keyTap("Backspace", text:"") 的变体对照 ──
  console.log("\n── ②' 对照：不同派发方式谁真的删得掉 ──")
  for (const [label, fn] of [
    ["keyDown+keyUp（现状）", () => tab.keyTap("Backspace", "Backspace", 8)],
    ["keyDown(text:'')+keyUp", () => tab.keyTap("Backspace", "Backspace", 8, "")],
    ["keyDown(text:'\\b')+keyUp", () => tab.keyTap("Backspace", "Backspace", 8, "\b")],
    ["rawKeyDown+keyUp", async () => {
      await tab.conn.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
      await tab.conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    }],
  ]) {
    await tab.evalJs(`(() => { const el = document.querySelector('[data-etui-field="${primary.fid}"]'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } })()`)
    await tab.evalJs(`(() => { const el = document.querySelector('[data-etui-field="${primary.fid}"]'); window.__before = el.value })()`)
    await fn()
    await new Promise((r) => setTimeout(r, 120))
    const v = await tab.fieldValue(primary.fid)
    const before = await tab.evalJs("window.__before")
    console.log(`  ${label.padEnd(24)} ${JSON.stringify(before)} → ${JSON.stringify(v)}  ${before !== v ? "✓ 删掉了" : "✗ 没反应"}`)
  }

  // ── ③ 清理后真的搜一次 ──
  console.log("\n── ③ 清空 → 输入关键词 → 回车 → 结果页 ──")
  await tab.evalJs(`(() => { const el = document.querySelector('[data-etui-field="${primary.fid}"]'); if (el) { el.focus(); el.value = '' } })()`)
  await tab.insertText("安徽 招标")
  console.log("  值 =", JSON.stringify(await tab.fieldValue(primary.fid)))
  const url0 = await tab.evalJs("location.href")
  await tab.pressEnter()
  for (const ms of [500, 1000, 2000, 3500]) {
    await new Promise((r) => setTimeout(r, ms === 500 ? 500 : 1000))
    const u = await tab.evalJs("location.href")
    console.log(`  +${ms}ms URL = ${u.slice(0, 120)}  ${u !== url0 ? "（已跳转）" : "（未跳转）"}`)
  }
  const url1 = await tab.evalJs("location.href")
  console.log(`  最终 ${url1 === url0 ? "✗ 根本没跳转 —— 回车没生效" : "✓ 已在新地址"}`)

  const raw = await tab.evalJs(EXTRACT_BLOCKS)
  const blocks = raw.blocks || []
  const textChars = blocks.filter((b) => b.kind === "text").reduce((a, b) => a + (b.text || "").length, 0)
  console.log(`  结果页块数=${blocks.length} 文字块字数=${textChars} 媒体=${blocks.filter((b) => b.kind === "media").length} 折叠=${(raw.folds || []).length} 控件=${(raw.fields || []).length}`)

  const p2 = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const r2 = renderTextPage(p2, { width: PC, maxRows: 9999, yOffset: 0 })
  const rows2 = flat(r2)
  console.log(`  渲染总行数 = ${r2.totalRows}`)
  console.log("  前 24 行：")
  for (const s of rows2.slice(0, 24)) console.log("    │ " + s.replace(/\s+$/, ""))

  // 结果页有没有真的结果条目
  const hitWords = ["安徽", "招标", "自投", "结果", "搜索工具"]
  console.log(`  命中关键词：${hitWords.filter((w) => rows2.join("\n").includes(w)).join(" ") || "(无)"}`)
  const bodyLen = await tab.evalJs("document.body.innerText.length")
  console.log(`  document.body.innerText 长度 = ${bodyLen}`)
  console.log(`  标题 = ${await tab.evalJs("document.title")}`)
} catch (e) {
  console.log("✗ 异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
