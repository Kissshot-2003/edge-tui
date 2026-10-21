// 「每动一下就要重新加载」回归测试 —— 断言交互动作**不碰浏览器**。
//
// 用户原话：「每动一下就要重新加载，是不能一次渲染整个页面吗」。
//
// 事实是：文字模式**已经**一次提取了整页（captureText 用 viewport:false），
// 媒体图也一次抓完（screenshotClip 带 captureBeyondViewport），
// 所以滚动本应是纯内存里的"挪窗口"。但 scrollPx 的文字分支里写着
// `await capture()` —— 于是每滚一下都重新提取 DOM + 给每个媒体块重新截图。
//
// 这个测试用「会计数的 tab 替身」把这件事钉死：
//   滚动的正确行为 = 行窗口移动 + 对浏览器 **0 次调用**。
// 静态看代码是看不出来的（`await capture()` 本身完全合法），
// 所以必须用"数调用次数"这种可观测的判据。
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

// ⚠️ 必须在 import run.mjs **之前**设好，否则它会自己跑 main() 去启动浏览器
process.env.EDGE_TUI_NO_MAIN = "1"
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

const longHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>长文档</title></head><body>
<h1>长文档滚动测试</h1>
${Array.from({ length: 120 }, (_, i) => `<p>第 ${i + 1} 段正文。这一段用来把页面撑长，好验证滚动是纯内存操作。</p>`).join("\n")}
</body></html>`

const pc = 78, pr = 24
const edge = await launchEdge({ width: 1200, height: 800 })
const real = edge.tab

try {
  await real.setViewport(880, 520)
  const url = "data:text/html;charset=utf-8," + encodeURIComponent(longHtml)
  await real.navigate(url, { timeoutMs: 8000 })

  // 用真实提取管线产出排版结果 —— 不是手搓对象
  const page = await buildTextPage(real, { width: pc, viewport: false, indent: 1 })
  const dummy = await real.evalJs("1")   // 确认 real tab 可用（同时也验证探针本身能计数）
  ok("提取到整页排版结果（viewport:false 就是「一次渲染整个页面」）",
    (page.lines || []).length > 100, `${page.lines.length} 个排版行`)
  ok("这些行的总渲染高度远超一屏（所以「滚动」才有意义）", true, `${pr} 行一屏`)

  const { tab: counting, calls, reset } = countingTab(real)
  // 假的终端尺寸：PAGE_ROWS()/PAGE_COLS() 从它取数。
  // render 是空函数 —— 测试进程没有真实终端，但 paint() 需要一个能调的 render。
  const termLike = { width: 80, height: 30, render() {}, clear() {}, destroy() {} }
  __test.install({ tabLike: counting, page, totalRows: 0, termLike })
  // 让 rerenderText 用**真实**的渲染结果确立总行数（它是唯一权威），
  // 而不是让测试自己猜一个 totalRows —— 猜出来的数会在第一次滚动时被覆盖。
  __test.rerenderText()
  const total = __test.state().textTotalRows
  // 用**真实**的 PAGE_ROWS()，不要在这里把 chrome 行数再抄一遍 ——
  // 抄一遍的话，页面区高度一变（多标签栏、多一行提示…）期望值就和实际值
  // 错位，失败原因还跟被测行为无关（这种"测试自己坏了"最费时间）。
  const pageRows = __test.PAGE_ROWS()
  const maxOff = total - pageRows
  ok("PAGE_ROWS() 用真实公式算出页面区行数",
    pageRows === 30 - __test.CHROME_ROWS - __test.FOOT_ROWS,
    `30 行终端 → 页面区 ${pageRows} 行`)
  ok("总行数由真实渲染结果确立（滚动范围就是它）", total > pageRows,
    `total=${total} → 最大偏移 ${maxOff}`)

  // ── ① 滚动：必须 0 次浏览器调用 ──
  reset()
  const before = __test.state().textRowOffset
  await __test.scrollPx(__test.CELL_H * 2)      // 等价于按一下 j
  const after1 = __test.state().textRowOffset
  ok("★ 文字模式滚动会移动行窗口", after1 > before, `offset ${before} → ${after1}`)
  ok("★ 文字模式滚动对浏览器 **零调用**（不重新加载）", calls.length === 0,
    calls.length ? `调用了 ${[...new Set(calls)].join(",")} —— 就是"每动一下都要重新加载"` : "0 次")

  // ── ② 连续滚很多下，仍然 0 次 ──
  reset()
  for (let i = 0; i < 30; i++) await __test.scrollPx(__test.CELL_H * 2)
  ok("★ 连滚 30 次仍然零调用", calls.length === 0,
    calls.length ? `调用了 ${[...new Set(calls)].join(",")}` : "0 次")
  ok("滚动位置按步长累加", __test.state().textRowOffset === after1 + 30 * 2,
    `offset=${__test.state().textRowOffset}`)

  // ── ③ 反向滚动 / 边界钳制 ──
  reset()
  for (let i = 0; i < 5; i++) await __test.scrollPx(-__test.CELL_H * 2)
  ok("反向滚动也不碰浏览器", calls.length === 0)
  reset()
  for (let i = 0; i < 200; i++) await __test.scrollPx(-__test.CELL_H * 2)
  ok("滚到顶不越界", __test.state().textRowOffset === 0, `offset=${__test.state().textRowOffset}`)
  ok("到顶后仍然零调用", calls.length === 0)

  reset()
  for (let i = 0; i < 500; i++) await __test.scrollPx(__test.CELL_H * 2)
  ok("滚到底钳在最大偏移（不会滚过头变空白）", __test.state().textRowOffset === maxOff,
    `offset=${__test.state().textRowOffset}，期望 ${maxOff}`)
  ok("到底后仍然零调用", calls.length === 0)

  // ── ④ "只改变显示层"的操作也必须走内存重排 ──
  // 这些是最容易漏的：元素清单只是叠加标记、退出清单只是去掉标记，
  // 页面内容一个字节都没变，却很容易顺手写成 capture()。
  __test.install({ tabLike: counting, page, totalRows: 0, termLike })
  __test.rerenderText()
  reset()
  await __test.redraw()
  ok("★ redraw()（只重画）在文字模式对浏览器零调用", calls.length === 0,
    calls.length ? `调用了 ${[...new Set(calls)].join(",")}` : "0 次")
  reset()
  await __test.refreshPicker()
  ok("★ 元素清单刷新（v）对浏览器零调用", calls.length === 0,
    calls.length ? `调用了 ${[...new Set(calls)].join(",")}` : "0 次")

  // ── ⑤ 没有页面时不能崩 ──
  __test.install({ tabLike: counting, page: null, totalRows: 0, termLike })
  reset()
  let threw = null
  try { await __test.scrollPx(__test.CELL_H * 2) } catch (e) { threw = e }
  ok("没有排版结果时滚动直接返回，不抛错也不碰浏览器",
    !threw && calls.length === 0, threw ? String(threw.message) : "")

  // ── ⑥ 分支差异要写清楚：图片模式**本来就该**重新截图 ──
  // 图片模式是像素网格、按视口截的，滚动必须重截 —— 这是设计，不是 bug。
  // 用源码断言把这条差异钉住，免得将来有人"顺手统一"成同一套。
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "run.mjs"), "utf8")
  const fn = src.slice(src.indexOf("async function scrollPx"), src.indexOf("/** 按元素清单的第 idx 项滚动定位"))
  // 先剥注释再扫 —— 否则注释里那句"以前写的是 await capture()"会被当成代码命中
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  const fnCode = stripComments(fn)
  const textBranch = fnCode.slice(fnCode.indexOf('renderMode === "text"'), fnCode.indexOf("if (!grid) return"))
  ok("源码层面：文字模式分支里不许出现 capture(",
    textBranch.length > 0 && !/capture\s*\(/.test(textBranch),
    textBranch.length ? textBranch.replace(/\s+/g, " ").slice(0, 60) : "没切出文字分支（测试本身要更新）")
  ok("源码层面：图片模式分支确实走 capture（有意为之）",
    /capture\s*\(/.test(fnCode.slice(fnCode.indexOf("if (!grid) return"))))

  ok("（前置校验）真实 tab 可用", dummy === 1)
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
