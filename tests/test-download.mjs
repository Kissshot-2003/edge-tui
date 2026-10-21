// 下载回归测试
//
// 真浏览器里点下载链接会把文件存到下载目录。
// headless Chrome 默认**取消**下载 —— 不显式开 Browser.setDownloadBehavior 的话，
// 点下载链接**什么都不会发生**（界面一点动静都没有）。
//
// 这个测试盯住三件事：
//   ① 设了 downloadPath 之后，文件真的落盘
//   ② Browser.downloadWillBegin / downloadProgress 事件真的来了
//   ③ Browser.setDownloadBehavior 存在（Page.setDownloadBehavior **不存在** ——
//      和当初那个不存在的 Page.goBack 一个路数）
import { launchEdge } from "../src/cdp.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

console.log("══ 下载 ══\n")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etui-dl-test-"))
const edge = await launchEdge({ width: 900, height: 600, downloadPath: dir })
try {
  const events = []
  edge.onDownload((info) => events.push(info))

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>下载</title></head>
<body><a id="dl" href="data:text/plain;charset=utf-8,%E4%B8%8B%E8%BD%BD%E6%88%90%E5%8A%9F" download="hello.txt">下载</a>
</body></html>`
  const tab = edge.tab
  await tab.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html), { timeoutMs: 8000 })
  await tab.evalJs("document.getElementById('dl').click()")

  // 等下载落盘（事件是异步的：文件先改名，"completed" 事件后到）
  let file = null
  let done = null
  for (let i = 0; i < 60 && !(file && done); i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (!file) {
      const f = fs.readdirSync(dir).filter((n) => !n.endsWith(".crdownload"))
      if (f.length) file = f[0]
    }
    if (!done) done = events.find((e) => e.phase === "progress" && e.state === "completed")
  }
  ok("文件真的落盘了", !!file, file ? path.join(dir, file) : `目录内容=${JSON.stringify(fs.readdirSync(dir))}`)
  ok("文件名是页面给的（hello.txt）", file === "hello.txt", String(file))
  if (file) {
    const body = fs.readFileSync(path.join(dir, file), "utf8")
    ok("内容完整", body.includes("下载成功"), JSON.stringify(body.slice(0, 30)))
  }

  const will = events.find((e) => e.phase === "willBegin")
  ok("收到了 downloadWillBegin 事件", !!will, will ? `suggestedFilename=${will.suggestedFilename}` : "")
  ok("收到了 downloadProgress(completed) 事件", !!done, done ? `filePath=${done.filePath}` : "")
  ok("完成事件带回了落盘路径", !!done?.filePath)
} catch (e) {
  fail++
  console.log(`  ✗ 异常：${e?.stack || e}`)
} finally {
  try { await edge.quit() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
