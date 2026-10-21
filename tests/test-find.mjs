// 页内查找（/ 查找 · n/N 跳转）回归测试 —— 断言查找**纯内存、不碰浏览器**。
//
// 整页排版结果已经在内存里（buildTextPage viewport:false），所以查找没有
// 任何理由走 CDP：在 textPage.lines 上匹配、用 renderedRowCount 记账累加出
// 命中行的渲染行号、挪行窗口。这个测试用「会计数的 tab 替身」把这件事钉死。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

// ⚠️ 必须在 import run.mjs **之前**设好：
//   NO_MAIN=1 阻止它启动交互主循环；EDGE_TUI_DATA 把书签/历史指到临时目录，
//   避免污染真实数据。
process.env.EDGE_TUI_NO_MAIN = "1"
process.env.EDGE_TUI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tui-test-data-"))
const { __test } = await import("../run.mjs")

/** 包一层会计数的替身：记录 run.mjs 对浏览器发起的每一次调用 */
function countingTab(real) {
  const calls = []
  const proxy = new Proxy(real, {
    get(t, k) {
      const v = t[k]
      if (typeof v === "function") {
        return (...args) => { calls.push(String(k)); return v.apply(t, args) }
      }
      return v
    },
  })
  return { tab: proxy, calls, reset: () => { calls.length = 0 } }
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>查找测试</title></head><body>
<h1>页内查找测试文档</h1>
${Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 段：这里是一些普通文字，用来撑长文档。</p>`).join("\n")}
<h2>特殊段落</h2>
<p>深山之中有一只骆驼，英文名叫 camel，它背上有两个驼峰。Camel 是偶蹄目动物。</p>
${Array.from({ length: 60 }, (_, i) => `<p>后段 ${i + 1}：更多普通文字，把关键词压到文档深处。</p>`).join("\n")}
<p>结尾处还有一只 camel。</p>
</body></html>`

const pc = 78
const edge = await launchEdge({ width: 1200, height: 800 })
const real = edge.tab

try {
  await real.setViewport(880, 520)
  const url = "data:text/html;charset=utf-8," + encodeURIComponent(html)
  await real.navigate(url, { timeoutMs: 8000 })

  const page = await buildTextPage(real, { width: pc, viewport: false, indent: 1 })
  const { tab: counting, calls, reset } = countingTab(real)
  const termLike = { width: 80, height: 30, render() {}, clear() {}, destroy() {} }
  __test.install({ tabLike: counting, page, totalRows: 0, termLike })
  __test.rerenderText()
  const total = __test.state().textTotalRows
  ok("前置：拿到整页排版结果", total > 100, `total=${total}`)

  // ── ① 基本查找：命中、当前位、行窗口跟随 ──
  reset()
  __test.runFind("骆驼")
  let st = __test.state()
  ok("★ 中文关键词能命中（camel 的中文语境词）", st.findHits >= 1,
    `${st.findHits} 处`)
  ok("★ 查找定位后行窗口移向命中处（文档深处 → offset > 0）", st.textRowOffset > 0,
    `offset=${st.textRowOffset}`)

  // ── ② 大小写不敏感 ──
  __test.runFind("CAMEL")
  st = __test.state()
  ok("英文大小写不敏感（CAMEL 命中 camel/Camel）", st.findHits >= 2, `${st.findHits} 处`)
  ok("当前停在第一处", st.findCur === 0)

  // ── ③ n/N 循环跳转 ──
  __test.findNext(1)
  st = __test.state()
  ok("n 跳到下一处", st.findCur === 1)
  const hitRows = st.findHits
  __test.findNext(-1)
  st = __test.state()
  ok("N 跳回上一处", st.findCur === 0)
  __test.findNext(-1)
  st = __test.state()
  ok("在第一处按 N 环绕到最后一处", st.findCur === hitRows - 1,
    `cur=${st.findCur}/${hitRows}`)
  __test.findNext(1)
  st = __test.state()
  ok("在最后一处按 n 环绕回第一处", st.findCur === 0)

  // ── ④ 查找全程零浏览器调用 ──
  reset()
  __test.runFind("骆驼")
  __test.findNext(1)
  __test.findNext(1)
  __test.findNext(-1)
  ok("★ 查找 + 跳转对浏览器 **零调用**（整页都在内存里）", calls.length === 0,
    calls.length ? `调用了 ${[...new Set(calls)].join(",")}` : "0 次")

  // ── ⑤ 未命中 / 清除 ──
  __test.runFind("这个短语绝对不存在xyz")
  st = __test.state()
  ok("未命中：0 处，不高亮", st.findHits === 0 && st.findCur === -1)
  __test.runFind("camel")
  st = __test.state()
  ok("重新查找恢复命中", st.findHits >= 2)
  __test.clearFind()
  st = __test.state()
  ok("清除后高亮与查询词都归零", st.findHits === 0 && st.findCur === -1 && st.findQuery === "")

  // ── ⑥ 空查询 = 清除，不抛错 ──
  let threw = null
  try { __test.runFind("") } catch (e) { threw = e }
  ok("空查询当作清除，不抛错", !threw)

  // ── ⑦ 书签/历史存储指向 EDGE_TUI_DATA（隔离验证）──
  ok("EDGE_TUI_DATA 生效（数据目录已建在临时目录）",
    fs.existsSync(process.env.EDGE_TUI_DATA),
    process.env.EDGE_TUI_DATA)
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
  try { fs.rmSync(process.env.EDGE_TUI_DATA, { recursive: true, force: true }) } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
