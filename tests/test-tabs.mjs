// 多标签页回归测试
//
// 交互模型参考 OpenCode V2 TUI：横向标签栏、编号指示、Ctrl+数字 直跳、
// Ctrl+Tab 轮换、Ctrl+W 关闭、Ctrl+Shift+T 重开。
//
// 分三层测，因为这三层会各自独立地坏：
//   ① CDP 层：能不能真的开出一个**独立的页面**（Target.createTarget），
//      它的标题/地址是不是自己的 —— 这一层坏了，标签栏会全部显示同一个页面。
//   ② 解码层：Ctrl+数字 / Ctrl+Tab 能不能被解出来。
//      ⚠️ 传统终端里 Ctrl+Tab 与普通 Tab 是**同一个字节**，Ctrl+1 与 '1' 也是
//      同一个字节 —— 所以必须走 CSI-u（kitty 协议）/ win32 输入模式。
//      这一层坏了，标签栏能看、但切不动。
//   ③ 状态层：切标签时各页保留自己的标题/地址，不串页。
//      这一层坏了，切过去显示的还是上一个页面的内容。
//
// ⚠️ 必须在 import run.mjs **之前**设好，否则它会自己跑 main() 去启动浏览器
process.env.EDGE_TUI_NO_MAIN = "1"

import { launchEdge } from "../src/cdp.js"
import { createKeyDecoder } from "../src/keys.js"
let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const pageHtml = (t) =>
  `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${t}</title></head>` +
  `<body><h1>${t}</h1><p>${"页面内容 ".repeat(60)}</p></body></html>`
const dataUrl = (t) => "data:text/html;charset=utf-8," + encodeURIComponent(pageHtml(t))

console.log("══ 多标签页（tabs）══\n")

// ── ① CDP 层：开/关第二个页面 ──
console.log("── ① CDP：开/关第二个页面 ──")
{
  const edge = await launchEdge({ width: 800, height: 600 })
  try {
    ok("launchEdge 提供了 newPage/closePage",
      typeof edge.newPage === "function" && typeof edge.closePage === "function")
    ok("首个页面带 targetId", !!edge.targetId)

    const p2 = await edge.newPage()
    ok("新页面拿到独立的 targetId", !!p2.targetId && p2.targetId !== edge.targetId,
      `${edge.targetId} vs ${p2.targetId}`)

    await p2.tab.navigate(dataUrl("第二个标签页"), { timeoutMs: 8000 })
    const info2 = await p2.tab.pageInfo()
    ok("新页面能独立导航（标题是它自己的）", info2.t === "第二个标签页", `title=${info2.t}`)

    const info1 = await edge.tab.pageInfo()
    ok("原页面不受影响（没被新页面的导航带走）",
      !/第二个标签页/.test(info1.t || "") && !/第二个标签页/.test(info1.u || ""),
      `title=${info1.t} url=${info1.u}`)

    // 关掉它
    await edge.closePage(p2.targetId)
    await new Promise((r) => setTimeout(r, 400))
    let stillThere = false
    try {
      const r = await fetch(`http://127.0.0.1:${edge.port}/json/list`)
      const arr = await r.json()
      stillThere = arr.some((t) => t.id === p2.targetId)
    } catch {}
    ok("closePage 之后该目标从页面列表里消失", !stillThere)
  } catch (e) {
    fail++
    console.log(`  ✗ 异常：${e?.stack || e}`)
  } finally {
    try { await edge.quit() } catch {}
  }
}

// ── ② 解码层：Ctrl 修饰键 ──
console.log("\n── ② 解码：Ctrl 修饰键（CSI-u / win32 / 原始字节）──")
{
  const d1 = createKeyDecoder()
  const e1 = d1.push(Buffer.from("\x1b[49;5u"))            // Ctrl+1
  ok("CSI-u：Ctrl+1", e1.length === 1 && e1[0].name === "char"
    && e1[0].sequence === "1" && e1[0].ctrl === true, JSON.stringify(e1))

  const d2 = createKeyDecoder()
  const e2 = d2.push(Buffer.from("\x1b[9;5u"))              // Ctrl+Tab
  ok("CSI-u：Ctrl+Tab", e2.length === 1 && e2[0].name === "tab" && e2[0].ctrl === true,
    JSON.stringify(e2))

  const d3 = createKeyDecoder()
  const e3 = d3.push(Buffer.from("\x1b[9;2u"))              // Shift+Tab
  ok("CSI-u：Shift+Tab", e3.length === 1 && e3[0].name === "tab" && e3[0].shift === true,
    JSON.stringify(e3))

  const d4 = createKeyDecoder()
  const e4 = d4.push(Buffer.from([0x17]))                    // 原始 Ctrl+W
  ok("原始字节：Ctrl+W", e4.length === 1 && e4[0].sequence === "w" && e4[0].ctrl === true,
    JSON.stringify(e4))

  const d5 = createKeyDecoder()
  // win32 输入模式字段序：ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
  //                            65  30  119   1    8   0    ← Cs=8 = LEFT_CTRL_PRESSED
  const e5 = d5.push(Buffer.from("\x1b[65;30;119;1;8;0_"))
  ok("win32 模式：Ctrl+W", e5.length === 1 && e5[0].sequence === "w" && e5[0].ctrl === true,
    JSON.stringify(e5))

  const d6 = createKeyDecoder()
  const e6 = d6.push(Buffer.from("\x1b[?u"))                 // kitty 协议查询
  ok("kitty 查询序列不会泄漏成字符",
    !e6.some((e) => e.name === "char") && d6.pendingBytes === 0, JSON.stringify(e6))
}

// ── ③ 状态层：各页保留自己的状态 ──
console.log("\n── ③ 状态：切标签不串页 ──")
{
  const { __test } = await import("../run.mjs")
  const T = __test.tabState
  // 先给一个假的终端（标签栏的宽度从 term 取）
  __test.install({
    tabLike: { id: "A" },
    page: null,
    totalRows: 0,
    termLike: { width: 80, height: 30, render() {}, clear() {}, destroy() {} },
  })
  T.seed([
    { tab: { id: "A" }, title: "页面 A", url: "https://a.test/" },
    { tab: { id: "B" }, title: "页面 B", url: "https://b.test/" },
    { tab: { id: "C" }, title: "页面 C", url: "https://c.test/" },
  ])
  ok("播种了 3 个标签页", T.count() === 3, `${T.count()}`)
  ok("初始在第 1 个", T.active() === 0)
  ok("第 1 个的标题正确", T.activeTitle() === "页面 A", T.activeTitle())

  T.switchTab(1)
  ok("切到第 2 个后标题正确", T.activeTitle() === "页面 B", T.activeTitle())
  ok("切到第 2 个后地址正确", T.activeUrl() === "https://b.test/", T.activeUrl())

  T.cycleTab(1)
  ok("轮换到第 3 个", T.active() === 2 && T.activeTitle() === "页面 C",
    `active=${T.active()} title=${T.activeTitle()}`)

  T.cycleTab(1)
  ok("轮换回第 1 个（环绕）", T.active() === 0 && T.activeTitle() === "页面 A",
    `active=${T.active()} title=${T.activeTitle()}`)

  T.cycleTab(-1)
  ok("反向轮换到最后一个", T.active() === 2 && T.activeTitle() === "页面 C",
    `active=${T.active()} title=${T.activeTitle()}`)

  T.switchTab(0)
  ok("各页标题仍然各自独立", T.titles().join("|") === "页面 A|页面 B|页面 C",
    T.titles().join("|"))
  ok("各页地址仍然各自独立", T.urls().join("|") === "https://a.test/|https://b.test/|https://c.test/",
    T.urls().join("|"))

  // 标签栏渲染：三个标签都要在，编号 1/2/3
  const strip = T.strip()
  ok("标签栏画出了 3 个标签", /\[1\]/.test(strip) && /\[2\]/.test(strip) && /\[3\]/.test(strip),
    JSON.stringify(strip.slice(0, 60)))
  ok("标签栏里是各页自己的标题",
    /页面 A/.test(strip) && /页面 B/.test(strip) && /页面 C/.test(strip),
    JSON.stringify(strip.slice(0, 80)))
  ok("标签栏宽度不超终端宽度", strip.length <= 80, `len=${strip.length}`)

  // 新建 / 关闭
  __test.setEdge({
    newPage: async () => ({ tab: { id: "D" }, targetId: "td" }),
    closePage: async () => {},
  })
  await T.newTab()
  ok("新建后变成 4 个", T.count() === 4, `${T.count()}`)
  ok("新标签页成为当前页", T.active() === 3, `active=${T.active()}`)

  T.closeTab(1)
  ok("关闭后剩 3 个", T.count() === 3, `${T.count()}`)
  ok("关掉的是第 2 个", T.titles().join("|") === "页面 A|页面 C|",
    T.titles().join("|"))
}

// ── ④ 按键 → 切页：整条链路 ──
console.log("\n── ④ 按键真的能切标签页 ──")
{
  const { __test } = await import("../run.mjs")
  const T = __test.tabState
  __test.install({
    tabLike: { id: "A" },
    page: null,
    totalRows: 0,
    termLike: { width: 80, height: 30, render() {}, clear() {}, destroy() {} },
  })
  T.seed([
    { tab: { id: "A" }, title: "页面 A", url: "https://a.test/" },
    { tab: { id: "B" }, title: "页面 B", url: "https://b.test/" },
    { tab: { id: "C" }, title: "页面 C", url: "https://c.test/" },
  ])

  // Ctrl+Tab → 下一个
  __test.handleKey({ name: "tab", ctrl: true })
  ok("Ctrl+Tab 切到下一个标签页", T.active() === 1, `active=${T.active()}`)
  ok("切过去后标题是那一页的", T.activeTitle() === "页面 B", T.activeTitle())

  // Ctrl+Shift+Tab → 上一个
  __test.handleKey({ name: "tab", ctrl: true, shift: true })
  ok("Ctrl+Shift+Tab 切回上一个", T.active() === 0, `active=${T.active()}`)

  // Ctrl+3 → 直跳第 3 个
  __test.handleKey({ name: "char", sequence: "3", ctrl: true })
  ok("Ctrl+3 直跳到第 3 个", T.active() === 2, `active=${T.active()}`)

  // Ctrl+0 → 第 10 个（只有 3 个时应当无效，而不是跳到第 0 个）
  __test.handleKey({ name: "char", sequence: "0", ctrl: true })
  ok("Ctrl+0 在没有第 10 个标签页时不乱跳", T.active() === 2, `active=${T.active()}`)

  // 单键退路
  __test.handleKey({ name: "char", sequence: "]" })
  ok("单键 ] 轮换到下一个（环绕到第 1 个）", T.active() === 0, `active=${T.active()}`)
  __test.handleKey({ name: "char", sequence: "2" })
  ok("单键 2 直跳到第 2 个", T.active() === 1, `active=${T.active()}`)

  // 单键 w 关闭
  const before = T.count()
  __test.handleKey({ name: "char", sequence: "w" })
  ok("单键 w 关闭当前标签页", T.count() === before - 1, `${before} → ${T.count()}`)

  // Ctrl+字母**不是文字**：不能漏进输入框
  __test.handleKey({ name: "char", sequence: "o" })
  ok("按 o 进入地址栏输入模式", __test.state().mode === "goto", __test.state().mode)
  __test.handleKey({ name: "char", sequence: "a", ctrl: true })
  ok("Ctrl+A 不会把 'a' 打进输入框", __test.state().inputValue === "",
    JSON.stringify(__test.state().inputValue))
  __test.handleKey({ name: "char", sequence: "x" })
  ok("普通字符照常进入输入框", __test.state().inputValue === "x",
    JSON.stringify(__test.state().inputValue))
}

// ── ⑤ target=_blank 的链接要开成新标签页 ──
console.log("\n── ⑤ target=_blank → 新标签页 ──")
{
  const edge = await launchEdge({ width: 1000, height: 700 })
  try {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>开窗测试</title></head>
<body><a id="plain" href="https://example.com/plain">普通链接</a>
<a id="blank" href="https://example.com/child" target="_blank">新窗口链接</a>
</body></html>`
    const tab = edge.tab
    await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html), { timeoutMs: 8000 })
    const els = await tab.enumerateInteractive(1000, 700)
    // 元素清单里没有 href 字段（浏览器侧的 __etuiEls 才有），
    // 所以按可见文字定位。
    const plainIdx = els.findIndex((e) => e.text === "普通链接")
    const blankIdx = els.findIndex((e) => e.text === "新窗口链接")
    ok("找到了两个链接", plainIdx >= 0 && blankIdx >= 0, `plain=${plainIdx} blank=${blankIdx}`)

    const p1 = await tab.probeNewWindow(plainIdx)
    ok("普通链接不判为新窗口", p1.newWindow === false, JSON.stringify(p1))

    const p2 = await tab.probeNewWindow(blankIdx)
    ok("target=_blank 的链接判为新窗口", p2.newWindow === true, JSON.stringify(p2))
    ok("给出的是绝对地址", p2.url === "https://example.com/child", String(p2.url))

    // 收编站点自己开出来的窗口：确认 attachTarget 能接管一个已存在的 target
    const created = await edge.newPage()
    ok("能新建并接管一个标签页", !!created.tab && !!created.targetId)
    await edge.closePage(created.targetId)
  } catch (e) {
    fail++
    console.log(`  ✗ 异常：${e?.stack || e}`)
  } finally {
    try { await edge.quit() } catch {}
  }
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
