// 诊断：临时 profile 到底有多大、多少文件，删除为什么慢？
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { launchEdge } from "../src/cdp.js"
import { pathToFileURL } from "node:url"

const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "fold-page.html")).href

function survey(dir) {
  let files = 0, bytes = 0
  const walk = (d) => {
    let es
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else { files++; bytes += fs.statSync(p).size }
      } catch {}
    }
  }
  walk(dir)
  return { files, mb: (bytes / 1048576).toFixed(1) }
}

const edge = await launchEdge({ width: 1200, height: 800 })
const tab = edge.tab
await tab.setViewport(880, 520)
await tab.navigate(fixture)
await tab.navigate(fixture)
await tab.navigate("about:blank", { timeoutMs: 5000 })

console.log("profile 目录：", edge.profileDir)
console.log("  内容：", JSON.stringify(survey(edge.profileDir)))

// 看看 Edge 到底起了几个进程
const pid = Number(execFileSync("powershell", ["-NoProfile", "-Command",
  `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*` + edge.profileDir.replace(/\\/g, "\\\\") + `*' } | Measure-Object).Count`],
  { encoding: "utf8" }).trim())
console.log(`带本 profile 的 msedge.exe 进程数：${isNaN(pid) ? "?" : pid}`)

let t = Date.now()
try { edge.tab.close() } catch {}
console.log(`ws.close()            ${Date.now() - t}ms`)

// 分别量：只 rm，和 taskkill 后再 rm
t = Date.now()
let okRm = true
try { fs.rmSync(edge.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }) } catch { okRm = false }
console.log(`删前未 taskkill：rmSync ${Date.now() - t}ms  ok=${okRm}`)
console.log(`  删后残留：${fs.existsSync(edge.profileDir) ? JSON.stringify(survey(edge.profileDir)) : "已删净"}`)

process.exit(0)
