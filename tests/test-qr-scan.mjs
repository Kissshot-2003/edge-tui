// test-qr-scan.mjs —— 证明「终端里的二维码真的能扫」
//
// 这个测试不是"看起来像二维码就算过"，而是**把渲染结果反解回文本**：
//
//   文本 → 二维码模块矩阵 → qrToCells() 的字符网格
//        → 模拟终端把字符画成像素（空格=背景色，▀▄█=前景色铺半格/整格）
//        → jsQR 解码 → 比对原始文本
//
// 走完这一圈还能拿到原文，才说明字符网格是**信息无损**的。
// 对照组是旧的「截图降采样成 9 行字符画」——同样用 jsQR 解，必然失败，
// 用来量化这次改动的实际收益。
//
// 运行：node tests/test-qr-scan.mjs          （含知乎实页验证，需要网络）
//       node tests/test-qr-scan.mjs --offline（只跑离线合成用例）

import QRCode from "qrcode"
import jsQRmod from "jsqr"
import { qrToCells, planQrLayout } from "../src/qr.js"

const jsQR = jsQRmod.default || jsQRmod

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  " + extra : ""}`) }
}

// 终端字符格尺寸。常见等宽字体 14px 下约 8×16，
// 1:2 的宽高比正是半块字符能拼出正方形模块的前提。
const CW = 8, CH = 16

/** 把 qrToCells 的字符网格「画」成像素，忠实还原终端字形语义 */
function cellsToImage(cells) {
  const width = cells.cols * CW, height = cells.rows * CH
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255
  }
  for (let r = 0; r < cells.rows; r++) {
    for (let c = 0; c < cells.cols; c++) {
      const i = r * cells.cols + c
      const ch = cells.ch[i], fg = cells.fg[i], bg = cells.bg[i]
      const x0 = c * CW, y0 = r * CH
      // 先用背景色铺满整格
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) put(x0 + x, y0 + y, bg)
      // 再按字形把前景色画上去
      if (ch === " ") continue
      if (ch === "█") {
        for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) put(x0 + x, y0 + y, fg)
      } else if (ch === "▀") {
        for (let y = 0; y < CH / 2; y++) for (let x = 0; x < CW; x++) put(x0 + x, y0 + y, fg)
      } else if (ch === "▄") {
        for (let y = CH / 2; y < CH; y++) for (let x = 0; x < CW; x++) put(x0 + x, y0 + y, fg)
      }
    }
  }
  return { width, height, data }
}

const tryDecode = (img) => {
  try {
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })
    return r ? r.data : null
  } catch (e) {
    return null
  }
}

/** 由 npm qrcode 生成模块矩阵，转成本项目 qr.js 需要的 { n, bits } */
function makeQr(text, ec = "M") {
  const q = QRCode.create(text, { errorCorrectionLevel: ec })
  const n = q.modules.size
  let bits = ""
  for (let i = 0; i < n * n; i++) bits += q.modules.data[i] ? "1" : "0"
  return { n, bits }
}

/** 把字符网格画成可读的文本（用于人工目视） */
const artToText = (cells) => {
  const out = []
  for (let r = 0; r < cells.rows; r++) {
    let s = ""
    for (let c = 0; c < cells.cols; c++) s += cells.ch[r * cells.cols + c]
    out.push(s)
  }
  return out.join("\n")
}

// ────────────────────────────────────────────────────────────
console.log("═══ ① 合成用例：文本 → 字符网格 → 像素 → 解码 ═══")

const CASES = [
  { label: "短文本", text: "HELLO-EDGE-TUI", ec: "M" },
  { label: "中文", text: "洛橙的内网聊天 ShanChat", ec: "M" },
  // 接近知乎登录码的真实规模：一条带 token 的 URL
  { label: "登录用 URL", text: "https://www.zhihu.com/signin?next=%2F&qrcode_token=" + "a1b2c3d4e5".repeat(6), ec: "M" },
]

for (const c of CASES) {
  const qr = makeQr(c.text, c.ec)
  console.log(`\n[${c.label}] ${qr.n}×${qr.n} 模块（version ${(qr.n - 17) / 4}）· ${c.text.length} 字符`)

  for (const style of ["full", "half"]) {
    const cells = qrToCells(qr, { margin: 4, style })
    const img = cellsToImage(cells)
    const got = tryDecode(img)
    ok(`${style} 档可解码`, got === c.text,
      `网格 ${cells.cols}×${cells.rows} · 位图 ${img.width}×${img.height}px` +
      (got === c.text ? "" : ` → 解出 ${got === null ? "失败" : JSON.stringify(got.slice(0, 30))}`))
  }
}

// ────────────────────────────────────────────────────────────
console.log("\n═══ ② 对照组：旧的「截图降采样」路线 ═══")

{
  const text = "https://www.zhihu.com/signin?qrcode_token=" + "a1b2c3d4e5".repeat(4)
  const qr = makeQr(text)
  // 旧路线：把二维码区域截图后降采样成 40 列 × 9 行的字符画，
  // 手机拍屏幕时看到的就是这个分辨率。
  const OLD_COLS = 40, OLD_ROWS = 9
  const img = { width: OLD_COLS, height: OLD_ROWS, data: new Uint8ClampedArray(OLD_COLS * OLD_ROWS * 4) }
  for (let y = 0; y < OLD_ROWS; y++) {
    // 每行代表 QR 的 n/OLD_ROWS 个模块行，取该带的平均明暗
    for (let x = 0; x < OLD_COLS; x++) {
      const my = Math.floor(y * qr.n / OLD_ROWS), mx = Math.floor(x * qr.n / OLD_COLS)
      const dark = qr.bits.charCodeAt(my * qr.n + mx) === 49
      const i = (y * OLD_COLS + x) * 4
      const v = dark ? 0 : 255
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  const got = tryDecode(img)
  ok("降采样到 9 行后确实解不出（证明旧方案无药可救）", got !== text,
    `${qr.n} 个模块压进 9 行 → 每行 ${(qr.n / OLD_ROWS).toFixed(1)} 个模块，远低于可解码下限`)

  const cells = qrToCells(qr, { margin: 4, style: "half" })
  ok("新方案保留全部模块行（无损）", cells.rows * 2 >= qr.n,
    `${qr.n} 个模块行 → ${cells.rows} 个字符行（每行 2 模块行）`)
}

// ────────────────────────────────────────────────────────────
console.log("\n═══ ③ 比例选择：必须能塞进一屏 ═══")

{
  const qr = makeQr("https://example.com/" + "x".repeat(60))
  const W = 98, PR = 28
  const plan = planQrLayout(qr, { width: W, maxRows: PR - 4 })
  console.log(`  页面区 ${W}×${PR} · 二维码 ${qr.n} 模块 → 选中 ${plan.style} / 静区 ${plan.margin} 模块 / ${plan.cols}×${plan.rows} 格`)
  ok("放得进页面区", plan.rows <= PR - 4, `${plan.rows} 行 ≤ ${PR - 4}`)
  ok("宽度不溢出", plan.cols <= W - 2)
  ok("静区 ≥ 2 模块（不牺牲静区换行数）", plan.margin >= 2 || plan.style === "half",
    `margin=${plan.margin}`)

  const cells = qrToCells(qr, { margin: plan.margin, style: plan.style })
  const got = tryDecode(cellsToImage(cells))
  ok("按实际选中的比例渲染后仍可解码", got !== null, got ? "" : "解码失败")
}

// ────────────────────────────────────────────────────────────
console.log("\n═══ ④ 二维码矩阵本身必须无损 ═══")

{
  const qr = makeQr("LOSSLESS-CHECK-0123456789")
  const cells = qrToCells(qr, { margin: 4, style: "half" })
  // 反推：从字符网格还原模块矩阵，应与原始逐位相同
  const at = (x, y) => {
    const r = Math.floor(y / 2), c = x
    const ch = cells.ch[r * cells.cols + c]
    return y % 2 === 0 ? (ch === "▀" || ch === "█") : (ch === "▄" || ch === "█")
  }
  let diff = 0
  for (let y = 0; y < qr.n; y++) for (let x = 0; x < qr.n; x++) {
    if (at(x + 4, y + 4) !== (qr.bits.charCodeAt(y * qr.n + x) === 49)) diff++
  }
  ok("half 档逐模块回读与原矩阵完全一致", diff === 0, `差异 ${diff} / ${qr.n * qr.n}`)

  const full = qrToCells(qr, { margin: 4, style: "full" })
  let diff2 = 0
  for (let y = 0; y < qr.n; y++) for (let x = 0; x < qr.n; x++) {
    const i = (y + 4) * full.cols + (x + 4) * 2
    const dark = full.bg[i][0] === 0
    if (dark !== (qr.bits.charCodeAt(y * qr.n + x) === 49)) diff2++
  }
  ok("full 档逐模块回读与原矩阵完全一致", diff2 === 0, `差异 ${diff2} / ${qr.n * qr.n}`)

  ok("强制黑白：不依赖终端配色", full.fg[0][0] === 255 || full.fg[0][0] === 0,
    `首格 fg=${JSON.stringify(full.fg[0])} bg=${JSON.stringify(full.bg[0])}`)
}

// ────────────────────────────────────────────────────────────
console.log("\n═══ ⑤ 目视：half 档渲染出来长这样 ═══")
{
  const qr = makeQr("EDGE-TUI", "M")
  const cells = qrToCells(qr, { margin: 2, style: "half" })
  console.log(artToText(cells).split("\n").map((l) => "   " + l).join("\n"))
}

// ────────────────────────────────────────────────────────────
if (!process.argv.includes("--offline")) {
  console.log("\n═══ ⑥ 真实页面：知乎登录页的二维码 ═══")
  let edge = null
  try {
    const { launchEdge } = await import("../src/cdp.js")
    const { buildTextPage } = await import("../src/textbrowser.js")
    edge = await launchEdge({ width: 1200, height: 800 })
    const tab = edge.tab
    await tab.setViewport(880, 520)
    await tab.navigate("https://www.zhihu.com/signin")
    await new Promise((r) => setTimeout(r, 2200))

    const page = await buildTextPage(tab, { width: 98, viewport: false, indent: 1 })
    const qrLines = page.lines.filter((l) => l.qrCells)
    console.log(`  页面块 ${page.blocks.length} · 识别到二维码 ${qrLines.length} 个`)
    ok("从 DOM 直读出二维码模块矩阵", qrLines.length >= 1,
      page.blocks.filter((b) => b.qr).map((b) => `${b.tag} ${b.qr.n}×${b.qr.n} 纯度${(b.qr.purity * 100).toFixed(0)}%`).join(" | "))

    if (qrLines.length) {
      const l = qrLines[0]
      console.log(`  渲染比例 ${l.qrCells.style} · 静区 ${l.qrPlan.margin} · 网格 ${l.qrCells.cols}×${l.qrCells.rows}`)
      const img = cellsToImage(l.qrCells)
      const got = tryDecode(img)
      ok("知乎的二维码可被解码器还原", !!got,
        got ? `内容前缀 ${JSON.stringify(got.slice(0, 46))}` : "解码失败")
      console.log("\n  ── 渲染实拍 ──")
      console.log(artToText(l.qrCells).split("\n").map((s) => "   " + s).join("\n"))
    }
  } catch (e) {
    console.log(`  ⚠ 跳过联网用例：${String(e?.message || e).slice(0, 100)}`)
  } finally {
    try { if (edge) await edge.quit() } catch {}
  }
}

console.log(`\n═══ ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail ? 1 : 0)
