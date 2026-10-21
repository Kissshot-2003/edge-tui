// 浏览器历史（后退 / 前进）回归测试
//
// 用户原话：「加载网页失败了就无法回退」。
// 真实原因：CDP **没有** Page.goBack / Page.goForward 这两个方法，
// 历史上写的就是它们 → 每次都报 "'Page.goBack' wasn't found"，
// 错误被 catch 吞进状态栏 → 用户只看到"按了没反应"。
// 也就是说**后退/前进这个功能从来没生效过**，失败页更是完全无路可退。
// 正确做法：Page.getNavigationHistory + Page.navigateToHistoryEntry。
//
// 这里盯住三件事：
//   ① 失败之后仍然能退回去（最关键的场景）
//   ② 后退/前进真的换了页面
//   ③ 退到头 / 进到头时给的是**人话**，不是 CDP 的方法名
import { launchEdge } from "../src/cdp.js"

const good = "data:text/html;charset=utf-8," + encodeURIComponent(
  "<!DOCTYPE html><html><head><meta charset='utf-8'><title>好页面</title></head><body><h1>好页面</h1></body></html>")
const bad = "http://127.0.0.1:9/definitely-not-here"   // 连接被拒

const edge = await launchEdge({ width: 900, height: 600 })
const tab = edge.tab
let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}
try {
  await tab.navigate(good, { timeoutMs: 8000 })
  ok("正常页加载成功", (await tab.pageInfo()).t === "好页面")

  await tab.navigate(bad, { timeoutMs: 8000 })
  const after = await tab.pageInfo()
  ok("失败后确实是错误页", /^chrome-error:/.test(after.u || ""), after.u)

  // 后退（从错误页退回去）
  let err = null
  try { await tab.history(-1) } catch (e) { err = e }
  const back = await tab.pageInfo()
  ok("从错误页后退能回到上一页", !err && back.t === "好页面",
    err ? "抛错：" + err.message : `title=${back.t}`)

  // 前进
  err = null
  try { await tab.history(1) } catch (e) { err = e }
  const fwd = await tab.pageInfo()
  ok("前进能回到错误页", !err && /^chrome-error:/.test(fwd.u || ""),
    err ? "抛错：" + err.message : `u=${fwd.u}`)

  // 退到头（历史里还有 about:blank，所以要一直退到真的没有为止）
  err = null
  for (let i = 0; i < 10 && !err; i++) { try { await tab.history(-1) } catch (e) { err = e } }
  ok("退到头时给出人话提示（不是 CDP 错误名）",
    !!err && /没有更早的页面/.test(err.message), err ? err.message : "（没有报错，异常）")

  // 进到头
  err = null
  for (let i = 0; i < 10 && !err; i++) { try { await tab.history(1) } catch (e) { err = e } }
  ok("进到头时给出人话提示", !!err && /没有更晚的页面/.test(err.message),
    err ? err.message : "（没有报错，异常）")

  console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
} catch (e) {
  console.log("异常：", e?.stack || e)
} finally {
  try { await edge.quit() } catch {}
}
process.exit(fail ? 1 : 0)
