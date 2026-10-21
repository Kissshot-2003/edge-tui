// 存成 PDF 的回归测试
//
// 真浏览器有「打印 → 存为 PDF」。CDP 里有 Page.printToPDF，
// 但方法名看着像就一定会存在 —— 所以这里实测一次：
// ① 方法真的存在（不是 "'Page.printToPDF' wasn't found"）
// ② 返回的是**合法的 PDF**（文件头是 %PDF-）
import { launchEdge } from "../src/cdp.js"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

console.log("══ 存成 PDF ══\n")

const edge = await launchEdge({ width: 900, height: 600 })
try {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PDF 测试</title></head>
<body><h1>要变成 PDF 的一页</h1><p>${"正文内容 ".repeat(80)}</p></body></html>`
  const tab = edge.tab
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html), { timeoutMs: 8000 })
  await new Promise((r) => setTimeout(r, 300))

  let err = null, data = null
  try { data = await tab.printToPdf() } catch (e) { err = e }
  ok("Page.printToPDF 存在且能跑通", !!data,
    err ? String(err.message).slice(0, 70) : `${Math.round((data?.length || 0) / 1024)} KB(base64)`)
  if (data) {
    const buf = Buffer.from(data, "base64")
    ok("返回的是 base64 数据", buf.length > 100, `${buf.length} 字节`)
    ok("文件头是 %PDF-", buf.subarray(0, 5).toString("latin1") === "%PDF-",
      JSON.stringify(buf.subarray(0, 8).toString("latin1")))
    ok("尾部有 %%EOF", buf.subarray(-6).toString("latin1").includes("%%EOF"),
      JSON.stringify(buf.subarray(-6).toString("latin1")))
  }
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
