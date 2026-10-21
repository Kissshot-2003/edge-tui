// 表单控件测试：输入框在文字模式里「看得见 + 打得进 + 提交得了」。
//
// 为什么必须有（用户原话：「Bing 页面看不到搜索的输入框，无法搜索」）：
//   <input> 自身没有文字节点、又不是媒体块 —— 旧提取器走到「叶子文字块」那句
//   时 directText 为空，直接 continue。于是必应首页那个 659×42、明明白白可见的
//   搜索框在文字模式里**完全不存在**，页面看上去根本没有搜索功能。
//   而旧的输入流程又要求「先按 Tab 聚焦输入框再按 i」，两个坑叠在一起就是死路。
//
// 判据必须用**真实链路**：真聚焦（focusField）→ 真打字（Input.insertText）
// → 值回流到渲染行 → 真回车（提交）。只断言"提取出了控件"不足以说明能用。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage, renderTextPage, renderedRowCount, makeLineMapper, fieldDisplayName, fieldRowInPage } from "../src/textbrowser.js"
import { strWidth } from "../src/term.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const OFFLINE = process.argv.includes("--offline")
const PC = 78
const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "field-page.html")).href

const flat = (res) => res.rows.map((r) => r.map((x) => x.t).join(""))
const rowWidths = (res) => res.rows.map((r) =>
  r.reduce((a, x) => a + (x.w !== undefined ? x.w : strWidth(String(x.t ?? ""))), 0))
const findRow = (rows, kw) => rows.findIndex((s) => s.includes(kw))

console.log("══ 表单控件（文字模式）══\n")

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
try {
  await tab.setViewport(880, 520)
  await tab.navigate(fixture)
  await new Promise((r) => setTimeout(r, 700))

  const page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const fields = page.fields || []
  const fld = (pred) => fields.find(pred)

  // ── ① 提取：控件必须被登记成 kind:'field' ──
  ok("提取到表单控件 ≥ 6 个", fields.length >= 6, `${fields.length} 个：${fields.map((f) => f.type).join(",")}`)
  const search = fld((f) => f.type === "search")
  ok("搜索框被识别（type=search）", !!search, search ? `${search.w}×${search.h} score=${search.score}` : "")
  ok("搜索框是「主输入框」（score 最高）",
    !!search && fields.filter((f) => !f.btn && !f.disabled).every((f) => f.score <= search.score),
    fields.filter((f) => !f.btn).map((f) => `${f.type}:${f.score}`).join(" "))
  ok("文本域被识别", !!fld((f) => f.tag === "TEXTAREA"))
  ok("下拉框被识别", !!fld((f) => f.tag === "SELECT"))
  ok("提交按钮被识别（input[type=submit] 没有文字节点，以前直接消失）",
    fields.some((f) => f.btn && /搜索/.test(f.value)))
  ok("禁用/只读被标记", fields.some((f) => f.disabled) && fields.some((f) => f.readonly))
  ok("控件编号写进了 DOM（data-etui-field），焦点反查才有依据",
    (await tab.evalJs("document.querySelectorAll('[data-etui-field]').length")) === fields.length,
    `DOM 里 ${await tab.evalJs("document.querySelectorAll('[data-etui-field]').length")} 个`)

  // ── ② 排版：控件占行，且同行的输入框+提交按钮合并 ──
  const fieldLines = page.lines.filter((l) => l.type === "field")
  ok("控件被排成行", fieldLines.length >= 4, `${fieldLines.length} 行`)
  const searchLine = fieldLines.find((l) => l.blocks.some((b) => b.type === "search"))
  ok("搜索框与提交按钮合并在同一行", !!searchLine && searchLine.blocks.length === 2,
    `blocks=${searchLine?.blocks.map((b) => b.btn ? "btn" : b.type).join("+")}`)
  const res0 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  const t0 = flat(res0)
  const t0Text = t0.join("\n")
  ok("下拉框的各个选项没有各自成行（北京/广州/深圳 不应作为独立行出现）",
    !t0.some((s) => /^\s*北京\s*$/.test(s) || /^\s*广州\s*$/.test(s) || /^\s*深圳\s*$/.test(s)))
  ok("控件行排在正文之前（DOM 文档顺序）",
    findRow(t0, "搜索框") < findRow(t0, "控件下面的正文必须照常出现"))
  ok("控件下面的正文照常出现", findRow(t0, "控件下面的正文必须照常出现") > 0)

  // ── ③ 渲染：可读、可发现 ──
  const sRow = t0[findRow(t0, "搜索框")]
  ok("渲染行写明这是搜索框", /▢ 搜索框/.test(sRow), sRow.trim().slice(0, 60))
  ok("渲染行给出按键提示", /按 i 输入/.test(sRow))
  ok("用 <label> 当名称，而不是 name=q 这种机器标识", /「站内搜索」/.test(sRow))
  ok("有值的控件显示当前值", t0.some((s) => /输入框「邮箱」 ▸ 已有内容@example\.com/.test(s)))
  ok("下拉框显示当前选中项", t0.some((s) => /下拉框「城市」 ▸ 上海/.test(s)))
  ok("禁用的控件标注「已禁用」", t0.some((s) => /已禁用/.test(s)))
  ok("只读的控件标注「只读」", t0.some((s) => /只读/.test(s)))
  ok("只读/禁用控件不提示「按 i 输入」",
    !t0.some((s) => /已禁用/.test(s) && /按 i 输入/.test(s)))
  ok("行宽守恒（所有渲染行 === 78）", rowWidths(res0).every((w) => w === PC),
    `宽度集合 ${[...new Set(rowWidths(res0))].join(",")}`)
  const acc = page.lines.reduce((a, l) => a + renderedRowCount(l), 0)
  ok("renderedRowCount 累加 === totalRows", acc === res0.totalRows, `${acc} vs ${res0.totalRows}`)
  const map = makeLineMapper(page, { yOffset: 0, pxPerRow: 8 })
  const mapped = map(search.y, search.x, search.w, search.h)
  ok("坐标→渲染行映射能定位到控件行", t0[mapped]?.includes("搜索框"), `y=${search.y} → row ${mapped}`)

  // ── 控件行号（进输入模式时要把这一行滚进可视窗口，见坑 #40）──
  const frow = fieldRowInPage(page, search.fid)
  ok("fieldRowInPage 给出搜索框所在的渲染行", frow >= 0 && /搜索框/.test(t0[frow] || ""),
    `row=${frow} 内容=${JSON.stringify((t0[frow] || "").trim().slice(0, 40))}`)
  ok("fieldRowInPage 与 makeLineMapper 落在同一行（两处记账不许漂移）", frow === mapped,
    `fieldRowInPage=${frow} vs mapLineMapper=${mapped}`)
  ok("不存在的控件编号返回 -1", fieldRowInPage(page, "no-such-fid") === -1)
  const taRow = fieldRowInPage(page, fld((f) => f.tag === "TEXTAREA").fid)
  ok("文本域的行号也是对的（多控件时不会串行）",
    taRow > frow && /文本域/.test(t0[taRow] || ""), `row=${taRow}`)

  // ── ④ 真实链路：聚焦 → 打字 → 值回流 → 退格 → 提交 ──
  const fr = await tab.focusField(search.fid)
  ok("focusField 真的聚焦了控件", !!fr && fr.ok === true, fr ? `${fr.tag} type=${fr.type}` : "null")
  const ar = await tab.activeRect()
  ok("activeRect 报出同一个控件编号", !!ar && ar.fid === search.fid, `fid=${ar?.fid} vs ${search.fid}`)

  await tab.insertText("必应测试")
  const v1 = await tab.fieldValue(search.fid)
  ok("insertText 打进了输入框", v1 === "必应测试", `value="${v1}"`)

  // 模拟 run.mjs#syncActiveField：把值写回块 → 重绘 → 用户看得见自己打的字
  const live = page.fields.find((f) => f.fid === search.fid)
  live.value = v1
  const res1 = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0 })
  const t1 = flat(res1)
  ok("打进去的字出现在控件行上（值回流的位置正确）",
    t1.some((s) => s.includes("搜索框") && s.includes("必应测试")),
    t1.find((s) => s.includes("搜索框"))?.trim().slice(0, 70) || "")
  ok("值回流后行宽仍守恒", rowWidths(res1).every((w) => w === PC))

  // 正在输入的控件要看得出来（run.mjs 传 activeFid）
  const resA = renderTextPage(page, { width: PC, maxRows: 9999, yOffset: 0, activeFid: search.fid })
  ok("正在输入的控件画成 ▶", flat(resA).some((s) => /▶ 搜索框/.test(s)))

  await tab.pressBackspace()
  const v2 = await tab.fieldValue(search.fid)
  ok("退格真的删掉了字符", v2 === "必应测", `value="${v2}"`)

  await tab.insertText("试")
  await tab.pressEnter()
  await new Promise((r) => setTimeout(r, 300))
  const submitted = await tab.evalJs("window.__submitted || ''")
  ok("回车触发了表单提交", submitted === "必应测试", `__submitted="${submitted}"`)

  // ── ⑤ 名称解析：机器标识不该露给用户 ──
  ok("通用占位名 q 被过滤掉", fieldDisplayName({ label: "", ph: "", name: "q", id: "sb_form_q" }) === "")
  ok("有中文名称时用中文", fieldDisplayName({ label: "站内搜索", name: "q" }) === "站内搜索")
  ok("有意义的英文 id 仍可使用", fieldDisplayName({ id: "userName" }) === "userName")

  // ── ⑥ 真实站点（必应）──
  if (!OFFLINE) {
    console.log("\n  ── 真实站点 ──")
    for (const [label, url] of [
      ["必应首页", "https://cn.bing.com/"],
      ["必应结果页", "https://www.bing.com/search?q=%E6%B5%8B%E8%AF%95"],
    ]) {
      try {
        await tab.navigate(url)
        await new Promise((r) => setTimeout(r, 1500))
        const p = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
        const fs2 = p.fields || []
        const s2 = fs2.filter((f) => f.type === "search")
        ok(`${label}：识别到搜索框`, s2.length >= 1, s2.map((f) => `${f.w}×${f.h} score=${f.score}`).join(","))
        const editable = fs2.filter((f) => !f.btn && !f.disabled && !f.readonly)
        ok(`${label}：搜索框是 score 最高的可输入控件`,
          s2.length > 0 && editable.every((f) => f.score <= s2[0].score),
          editable.map((f) => `${f.type}:${f.score}`).join(" "))
        const rr = renderTextPage(p, { width: PC, maxRows: 9999, yOffset: 0 })
        const line = flat(rr).find((s) => s.includes("搜索框"))
        ok(`${label}：搜索框在页面区里看得见`, !!line, line?.trim().slice(0, 70) || "(未渲染出控件行)")
        ok(`${label}：实际聚焦 + 打字生效`, await (async () => {
          if (!s2.length) return false
          const fr2 = await tab.focusField(s2[0].fid)
          if (!fr2?.ok) return false
          await tab.insertText("etui")
          const v = await tab.fieldValue(s2[0].fid)
          // 恢复到原值，避免污染后续断言
          await tab.evalJs(`(() => {
            const el = document.querySelector('[data-etui-field="${s2[0].fid}"]')
            if (el) el.value = el.value.replace(/etui$/, '')
          })()`)
          return /etui/.test(String(v))
        })())
      } catch (e) {
        ok(`${label}：实站检查`, false, String(e?.message || e).slice(0, 80))
      }
    }
  }
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
