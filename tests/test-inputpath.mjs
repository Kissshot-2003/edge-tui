// 输入路径回归测试：打字 / 退格 / 提交的「自愈」能力
//
// 用户投诉原话：「搜索结果无法显示，输入法在搜索框无法正常显示，输入关键字不可退格」。
//
// 本测试的重点不是"功能能用"（test-field 已覆盖），而是三件事：
//   ① **复现病灶**：站点把输入框节点换掉后，CDP 输入是**静默失效**的
//      （不报错、返回值正常、控件 value 一个字节都不变）——
//      三个症状（打不进 / 退不掉 / 搜不出）其实都是它
//   ② 证明 src/inputpath.js 的两级自愈真的能把键送进去，并如实报告走了哪级
//   ③ 证明提交看门狗能识别「回车没反应」，从而让 run.mjs 走搜索地址兜底
//
// 「节点被替换」不是假想场景：SPA 重挂载、框架重渲染、站点 focus 后换新节点
// 都很常见，而静态页面手工测试永远复现不了 —— 所以病灶必须用测试钉住。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import { typeIntoField, backspaceField, submitField, VIA } from "../src/inputpath.js"
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
const jsFixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "jssearch-page.html")).href

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab

const fieldOf = (page, pred) => (page.fields || []).find(pred)
const readVal = (fid) => tab.fieldValue(fid)
const setVal = (fid, v) => tab.evalJs(`(() => {
  const el = document.querySelector('[data-etui-field="${fid}"]')
  if (!el) return null
  el.value = ${JSON.stringify(v)}
  try { el.setSelectionRange(${JSON.stringify(v)}.length, ${JSON.stringify(v)}.length) } catch (e) {}
  return el.value
})()`)

/**
 * 把控件节点整个换掉，**保留 data-etui-field 属性**。
 * 这正是真实站点上「输入框被重挂载」的情形：选择器还能找到它，
 * 但浏览器内部记住的焦点元素仍是那个已经被摘掉的旧节点。
 */
const swapNode = (fid) => tab.evalJs(`(() => {
  const old = document.querySelector('[data-etui-field="${fid}"]')
  if (!old) return false
  const nu = document.createElement(old.tagName === 'TEXTAREA' ? 'textarea' : 'input')
  for (const a of old.attributes) nu.setAttribute(a.name, a.value)
  nu.value = old.value
  old.replaceWith(nu)
  return true
})()`)

/** 让 focus() 彻底失效：模拟"站点自绘控件 / 焦点被强势抢走"，逼出自愈的最后一级 */
const breakFocus = (fid) => tab.evalJs(`(() => {
  const el = document.querySelector('[data-etui-field="${fid}"]')
  if (!el) return false
  el.focus = function () {}
  return true
})()`)

const waitUrlChange = async (url0, totalMs) => {
  for (let w = 0; w < totalMs; w += 150) {
    await new Promise((r) => setTimeout(r, 150))
    try {
      const u = await tab.evalJs("location.href")
      if (u && u !== url0) {
        await new Promise((r) => setTimeout(r, 420))   // 等新文档真的提交
        return u
      }
    } catch {}
  }
  return ""
}

try {
  await tab.setViewport(880, 520)

  // ══ ① 复现病灶：节点被替换 → CDP 输入静默失效 ══
  console.log("── ① 复现病灶：输入框节点被替换 → CDP 输入静默失效 ──")
  await tab.navigate(fixture)
  await new Promise((r) => setTimeout(r, 700))
  let page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  let sf = fieldOf(page, (f) => f.type === "search")
  ok("夹具里找到搜索框", !!sf, sf ? `fid=${sf.fid} score=${sf.score}` : "")

  await tab.focusField(sf.fid)
  await tab.insertText("基线")
  ok("焦点正常时 insertText 生效", (await readVal(sf.fid)) === "基线", `=${JSON.stringify(await readVal(sf.fid))}`)

  await setVal(sf.fid, "")
  await swapNode(sf.fid)
  ok("节点已替换（选择器仍能找到它）", (await tab.evalJs(`!!document.querySelector('[data-etui-field="${sf.fid}"]')`)) === true)
  ok("isFocusedField 如实报告「焦点已不在」", (await tab.isFocusedField(sf.fid)) === false)

  await tab.insertText("丢失")
  const afterSwap = await readVal(sf.fid)
  ok("★ 节点被替换后 insertText **静默无效**（不报错、值不变）", afterSwap === "",
    `value=${JSON.stringify(afterSwap)} ← 这就是「打了字屏幕上没反应」的病灶`)

  await tab.pressBackspace()
  ok("★ 同样的原因，pressBackspace 也静默无效", (await readVal(sf.fid)) === "",
    "← 这就是「不能退格」的病灶（值本来就没进去，自然没什么可删）")

  // ══ ② 自愈第 1 级：重新聚焦 ══
  console.log("\n── ② 自愈第 1 级：重新聚焦再送 ──")
  await setVal(sf.fid, "")
  let r = await typeIntoField(tab, sf, "安")
  ok("打字自愈成功", r.value === "安", `value=${JSON.stringify(r.value)} via=${r.via}`)
  ok("如实报告走了 refocus 一级", r.via === VIA.REFOCUS, `via=${r.via}`)
  ok("控件里确实有值了", (await readVal(sf.fid)) === "安")

  r = await backspaceField(tab, sf)
  ok("退格自愈成功（打字那一轮已经把焦点修好，退格可以直送）",
    r.value === "" && (r.via === VIA.DIRECT || r.via === VIA.REFOCUS),
    `value=${JSON.stringify(r.value)} via=${r.via}`)

  // ══ ③ 自愈第 2 级：focus() 也失效 → DOM 级注入 ══
  console.log("\n── ③ 自愈第 2 级：focus() 也失效 → DOM 级注入 ──")
  await setVal(sf.fid, "")
  await swapNode(sf.fid)
  await breakFocus(sf.fid)
  r = await typeIntoField(tab, sf, "徽")
  ok("focus 失效时仍能打字", r.value === "徽", `value=${JSON.stringify(r.value)} via=${r.via}`)
  ok("如实报告走了 DOM 一级", r.via === VIA.DOM, `via=${r.via}`)

  // React/Vue 之类受控组件：DOM 级注入必须派发 input 事件，否则框架会把值抹回去
  await tab.evalJs(`(() => {
    const el = document.querySelector('[data-etui-field="${sf.fid}"]')
    window.__inputEvents = 0
    el.addEventListener('input', () => { window.__inputEvents++ })
    return true
  })()`)
  r = await typeIntoField(tab, sf, "省")
  ok("DOM 级注入派发了 input 事件（受控组件才不会被抹回原值）",
    (await tab.evalJs("window.__inputEvents")) >= 1, `${await tab.evalJs("window.__inputEvents")} 次`)
  r = await backspaceField(tab, sf)
  ok("focus 失效时仍能退格", r.value === "徽", `value=${JSON.stringify(r.value)} via=${r.via}`)
  ok("退格也报告 DOM 一级", r.via === VIA.DOM, `via=${r.via}`)

  await setVal(sf.fid, "")
  r = await backspaceField(tab, sf)
  ok("空值上退格不报错、值仍为空", r.value === "", `value=${JSON.stringify(r.value)}`)

  // ══ ④ 焦点在别的控件上时，不许把字打到别处 ══
  console.log("\n── ④ 焦点跑偏时不许污染别的控件 ──")
  await tab.navigate(fixture)
  await new Promise((r2) => setTimeout(r2, 600))
  page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  sf = fieldOf(page, (f) => f.type === "search")
  const ta = (page.fields || []).find((f) => f.tag === "TEXTAREA")
  ok("夹具里有文本域可做「干扰控件」", !!ta, ta ? `fid=${ta.fid}` : "")
  if (ta) {
    await tab.evalJs(`(() => {
      const el = document.querySelector('[data-etui-field="${ta.fid}"]')
      el.value = ''; el.focus(); return true
    })()`)
    // 无自愈的直送：字会进到**文本域**里（实测行为）
    await tab.insertText("污")
    ok("对照：直送会把字打进当前聚焦的文本域（所以必须先把焦点修回来）",
      (await readVal(ta.fid)) === "污", `textarea=${JSON.stringify(await readVal(ta.fid))}`)
    await tab.evalJs(`(() => { const el = document.querySelector('[data-etui-field="${ta.fid}"]'); el.value=''; return true })()`)

    await setVal(sf.fid, "")
    r = await typeIntoField(tab, sf, "安")
    ok("自愈路径把字送进了目标搜索框", r.value === "安", `via=${r.via}`)
    ok("★ 干扰控件没有被写入", (await readVal(ta.fid)) === "", `textarea=${JSON.stringify(await readVal(ta.fid))}`)
  }

  // ══ ⑤ 提交看门狗 ══
  console.log("\n── ⑤ 提交看门狗 ──")
  await tab.navigate(fixture)
  await new Promise((r2) => setTimeout(r2, 600))
  page = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  sf = fieldOf(page, (f) => f.type === "search")
  await tab.focusField(sf.fid)
  await setVal(sf.fid, "必应测试")
  await tab.evalJs("window.__submitted = ''")
  let sub = await submitField(tab, sf, waitUrlChange, 500)
  ok("回车能触发 <form> 的隐式提交", (await tab.evalJs("window.__submitted")) === "必应测试",
    `__submitted=${JSON.stringify(await tab.evalJs("window.__submitted"))}`)
  ok("表单不跳转时看门狗如实报告「未跳转」（不假装成功）", sub.ok === false, `via=${sub.via} how=${sub.how}`)

  await tab.navigate(jsFixture)
  await new Promise((r2) => setTimeout(r2, 600))
  const jp = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
  const jf = fieldOf(jp, (f) => f.type === "search")
  ok("JS 搜索夹具里找到搜索框", !!jf, jf ? `fid=${jf.fid}` : "")
  await tab.focusField(jf.fid)
  await setVal(jf.fid, "安徽招标")
  await tab.evalJs("window.__jsSubmitted = ''")
  sub = await submitField(tab, jf, waitUrlChange, 700)
  ok("★ 不在表单里的搜索框：回车无反应被识别出来", sub.ok === false, `via=${sub.via} how=${sub.how}`)
  ok("报告出「回车未引起跳转」这一原因（run.mjs 据此判搜索场景后走搜索地址兜底）",
    sub.how === "enter-nochange", `how=${sub.how}`)
  ok("回车确实没有产生任何提交", (await tab.evalJs("window.__jsSubmitted")) === "")

  // ══ ⑥ 真站端到端：打字 → 提交 → **结果页真的有内容** ══
  if (!OFFLINE) {
    console.log("\n── ⑥ 真站端到端（必应）──")
    try {
      await tab.navigate("https://cn.bing.com/")
      await new Promise((r2) => setTimeout(r2, 1800))
      const bp = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
      const bf = (bp.fields || []).filter((f) => f.kind === "field" && !f.btn && !f.disabled && !f.readonly)
        .sort((a, b) => b.score - a.score)[0]
      ok("必应首页找到主搜索框", !!bf, bf ? `fid=${bf.fid} score=${bf.score}` : "")

      await tab.focusField(bf.fid)
      await setVal(bf.fid, "")
      const vias = []
      for (const ch of ["安", "徽", "招", "标"]) vias.push((await typeIntoField(tab, bf, ch)).via)
      const v = await readVal(bf.fid)
      ok("逐字打进必应搜索框", v === "安徽招标", `value=${JSON.stringify(v)} via=${[...new Set(vias)].join(",")}`)

      const short = await backspaceField(tab, bf)
      ok("在必应里退格生效", short.value === "安徽招", `value=${JSON.stringify(short.value)} via=${short.via}`)
      await typeIntoField(tab, bf, "标")
      ok("退格后能继续补字", (await readVal(bf.fid)) === "安徽招标", `=${JSON.stringify(await readVal(bf.fid))}`)

      const before = await tab.evalJs("location.href")
      const s2 = await submitField(tab, bf, waitUrlChange, 3000)
      ok("回车真的跳到了结果页", s2.ok === true && s2.url !== before, `via=${s2.via}`)
      if (s2.url) {
        console.log(`     结果页：${s2.url.slice(0, 88)}`)
        // 等结果真的长出来（流式渲染的搜索页在地址变化后才开始填内容）
        let txt = ""
        for (let i = 0; i < 25; i++) {
          await new Promise((r2) => setTimeout(r2, 250))
          const rp = await buildTextPage(tab, { width: PC, viewport: false, indent: 1 })
          txt = (rp.blocks || []).filter((b) => b.kind === "text").map((b) => b.text).join("\n")
          if (txt.length > 400) break
        }
        ok("结果页真的提取出了内容（不是空白/半成品页）", txt.length > 400, `${txt.length} 字`)
        ok("结果页含搜索关键词", txt.includes("安徽") || txt.includes("招标"),
          txt.replace(/\s+/g, " ").slice(0, 60))
      }
    } catch (e) {
      ok("必应端到端", false, String(e?.message || e).slice(0, 100))
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
