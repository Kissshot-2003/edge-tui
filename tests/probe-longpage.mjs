// ── 超长页面提取边界探针 ────────────────────────────────────────────
// 回归背景：EXTRACT_MAX_TOP 曾是 40000px（约 45 屏），论坛/评论区/搜索结果
// 一律在这个高度被静默切断 —— 症状「页面加载总是停止在某个位置」。
// 修法：上界放宽到 400000px，真被截断时在断点放一行写明原因的提示块。
//
// ① 60000px 页（旧代码必断）：45000px 处的标题必须出现在整页提取里
// ② 450000px 页（新上界内）：400000px 以下被丢，提示块必须出现且写明区块数
// ③ 元素清单：45000px 处的可点元素必须被 enumerateInteractive 枚举（旧代码同病）
import { launchEdge } from "../src/cdp.js"
import { buildTextPage } from "../src/textbrowser.js"
import http from "node:http"

let pass = 0, fail = 0
function ok(name, cond, info = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${info ? "  " + info : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${info}`) }
}

// ① 60000px：30000px 上山、45000px 深谷 + 可点按钮（旧上界 40000 必切掉深谷）
const PAGE_A = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div style="height:30000px"> filler </div>
<h2 id="mid">山腰界碑</h2>
<div style="height:14500px"> filler2 </div>
<h2 id="deep">深谷石刻</h2>
<button id="deepbtn" style="display:block;margin:8px 0">深谷按钮</button>
<div style="height:500px"> end </div>
</body></html>`

// ② 450000px：395000px 在界内、405000px 在界外（旧上界下 45000 就没了，
//    新上界下 395000 可见、405000 被切且出现提示块）
const PAGE_B = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div style="height:395000px"> filler-a </div>
<h2 id="inbound">界内碑</h2>
<div style="height:10000px"> filler-b </div>
<h2 id="outbound">界外碑</h2>
<div style="height:40000px"> tail </div>
</body></html>`

function serve(page) {
  return new Promise((res) => {
    const s = http.createServer((q, r) => {
      r.setHeader("content-type", "text/html; charset=utf-8")
      r.end(page)
    })
    s.listen(0, "127.0.0.1", () => res([s, `http://127.0.0.1:${s.address().port}/`]))
  })
}

let edge
try {
  edge = await launchEdge({ width: 900, height: 600 })
  const tab = edge.tab

  // ── ① 60000px 页 ──
  {
    const [server, base] = await serve(PAGE_A)
    await tab.navigate(base, { timeoutMs: 10000 })
    await new Promise((r) => setTimeout(r, 350))
    const page = await buildTextPage(tab, { width: 80, viewport: false, indent: 1 })
    const all = page.lines.map((l) => l.text || "").join("\n")
    ok("①a 山腰 30000px 处内容可见（对照组）", all.includes("山腰界碑"))
    ok("①b ★ 深谷 45000px 处内容可见（旧代码在此截断）", all.includes("深谷石刻"))
    const els = await tab.enumerateInteractive(900, 600)
    ok("①c ★ 深谷按钮进元素清单（旧代码同样丢失）", els.some((e) => /深谷按钮/.test(e.text || "")),
      `共 ${els.length} 个元素`)
    server.close()
  }

  // ── ② 450000px 页 ──
  {
    const [server, base] = await serve(PAGE_B)
    await tab.navigate(base, { timeoutMs: 10000 })
    await new Promise((r) => setTimeout(r, 350))
    const page = await buildTextPage(tab, { width: 80, viewport: false, indent: 1 })
    const all = page.lines.map((l) => l.text || "").join("\n")
    ok("②a 395000px 界内内容可见", all.includes("界内碑"))
    ok("②b 405000px 界外内容不出现（硬上界仍生效）", !all.includes("界外碑"))
    ok("②c ★ 截断提示块出现且写明原因", all.includes("页面过长") && all.includes("未加载"),
      all.split("\n").find((l) => l.includes("页面过长"))?.slice(0, 60) || "无提示行")
    server.close()
  }
} catch (e) {
  console.log("ERR", e?.stack || e); fail++
} finally {
  try { edge?.quit() } catch {}
}

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
