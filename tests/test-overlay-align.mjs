// 叠加层对齐测试：`makeLineMapper` 是否把元素映射到
// 「真正印着这段文字的那一行」。
//
// 为什么必须有：媒体块会展开成多行（标签 + 字符画），所以排版行号 ≠ 渲染行号。
// 早期 mapper 直接拿 page.lines 的下标当渲染行号 → 图片以下的元素框整体上移错位，
// 表现是 `v` 元素清单的编号印在错误的行上、选中框框住无关内容。
// 这类 bug 不会让任何断言变红（行宽仍然守恒），只能靠「框住的是不是它自己」来验。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, overlayRuns, makeLineMapper, renderedRowCount } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const PC = 98
console.log("══ 叠加层对齐（文字模式）══\n")

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 1800))

  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const res = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  const flat = res.rows.map((r) => r.map((x) => x.t).join(""))

  // ① renderedRowCount 累加出来的总行数必须与 renderTextPage 完全一致
  const counted = page.lines.reduce((a, l) => a + renderedRowCount(l), 0)
  ok("renderedRowCount 累加 === renderTextPage 的 totalRows", counted === res.totalRows,
    `累加 ${counted} vs 渲染 ${res.totalRows}`)

  // ② 媒体块确实展开了（否则这个测试没意义）
  const medias = page.lines.filter((l) => l.type === "media")
  const expanded = medias.filter((m) => renderedRowCount(m) > 1)
  ok("存在展开成多行的媒体块（测试前提）", expanded.length >= 1,
    `${expanded.length}/${medias.length} 个媒体占 ${expanded.map((m) => renderedRowCount(m)).join(",")} 行`)

  // ③ 核心断言：元素的矩形映射到的行，应该就是印着它自己文字的那一行
  const map = makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 })
  await tab.scrollTarget()
  const els = await tab.enumerateInteractive(880, 520)

  const probes = ["验证码登录", "密码登录", "开通机构号", "其他扫码方式", "打开知乎App", "中国"]
  let hit = 0, tried = 0
  for (const kw of probes) {
    const el = els.find((e) => String(e.text || "").includes(kw) && Number.isFinite(e.y))
    if (!el) continue
    tried++
    const expectRow = flat.findIndex((t) => t.includes(kw))
    // 必须传完整矩形：多栏页面靠 x/w 的二维重叠才能认对栏
    const gotRow = map(el.y, el.x, el.w, el.h)
    const near = expectRow >= 0 && Math.abs(gotRow - expectRow) <= 1
    if (near) hit++
    ok(`「${kw}」映射到正确行`, near, `期望 ${expectRow} 实际 ${gotRow}（y=${el.y} x=${el.x}）`)
  }
  ok("映射命中率 ≥ 80%", tried > 0 && hit / tried >= 0.8, `${hit}/${tried}`)

  // ④ 只给 y（不给 x/w）应该明显更差 —— 证明横向信息是必需的，不是可有可无
  let yOnlyHit = 0
  for (const kw of probes) {
    const el = els.find((e) => String(e.text || "").includes(kw) && Number.isFinite(e.y))
    if (!el) continue
    const expectRow = flat.findIndex((t) => t.includes(kw))
    if (expectRow >= 0 && Math.abs(map(el.y) - expectRow) <= 1) yOnlyHit++
  }
  ok("只传 y 明显更差（说明二维匹配是必需的）", yOnlyHit < hit, `只传 y ${yOnlyHit}/${tried} vs 完整矩形 ${hit}/${tried}`)

  // ⑤ 叠加后行宽仍守恒
  const target = els.find((e) => String(e.text || "").includes("验证码登录"))
  if (target) {
    const rowsCopy = res.rows.map((r) => r.map((x) => ({ ...x })))
    overlayRuns({
      rows: rowsCopy, width: PC, pxPerRow: 8, viewOffsetY: 0,
      lineOfY: makeLineMapper(page, { yOffset: 0, pxPerRow: 8, viewOffsetY: 0 }),
      pickInfo: { ...target, i: target.i ?? 0 },
      focusInfo: null,
      showNumbers: true,
      els,
    })
    const ws = rowsCopy.map((r) => r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
    ok("叠加后行宽全 = " + PC, ws.every((w) => w === PC), `集合 {${[...new Set(ws)].join(",")}}`)

    // 高亮走的是「整行铺底色 + 行首标记」（文字模式没有像素→列的线性映射，
    // 画不出按像素算的方框），所以这里查行首的 ▸ 标记。
    const markRows = rowsCopy
      .map((r, i) => (String(r[0]?.t ?? "").startsWith("▸") ? i : -1))
      .filter((i) => i >= 0)
    const expectRow = flat.findIndex((t) => t.includes("验证码登录"))
    const near = markRows.some((r) => Math.abs(r - expectRow) <= 3)
    ok("选中标记 ▸ 画在了目标元素附近", near, `标记行 ${markRows.join(",") || "无"} vs 文字行 ${expectRow}`)

    // 并且确实铺了底色（bg 不再是页面底色）
    const tinted = rowsCopy.filter((r) => r.some((x) => Array.isArray(x.bg) && x.bg[0] === 58 && x.bg[1] === 26))
    ok("选中行铺了高亮底色", tinted.length >= 1, `${tinted.length} 行`)
  }
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ ${pass} 通过 · ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
