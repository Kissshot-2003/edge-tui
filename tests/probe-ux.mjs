// UX 实测：像用户一样打开一批真实网页，把**第一屏**原样打出来给人看。
// 目的：找出"用起来很糟糕"具体糟在哪，而不是靠读代码猜。
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const NODE = process.execPath
const OUT = process.argv[2] || "_ux.txt"
const PAGES = [
  ["必应首页", "https://cn.bing.com/"],
  ["百度首页", "https://www.baidu.com/"],
  ["知乎热榜", "https://www.zhihu.com/hot"],
  ["GitHub Trending", "https://github.com/trending"],
  ["Hacker News", "https://news.ycombinator.com/"],
  ["维基百科首页", "https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5"],
  ["澎湃新闻", "https://www.thepaper.cn/"],
]

const lines = []
for (const [name, url] of PAGES) {
  const bin = path.join(ROOT, "_ux.bin")
  try {
    execFileSync(NODE, ["run.mjs", url, "--dump"], { cwd: ROOT, stdio: ["ignore", fs.openSync(bin, "w"), "ignore"] })
    const frame = execFileSync(NODE, ["tests/replay-dump.mjs", bin], { cwd: ROOT, encoding: "utf8" })
    lines.push(`\n\n${"█".repeat(100)}\n█ ${name}   ${url}\n${"█".repeat(100)}\n`)
    lines.push(frame)
  } catch (e) {
    lines.push(`\n\n${"█".repeat(100)}\n█ ${name}   ${url}\n█  打开失败：${String(e?.message || e).slice(0, 120)}\n`)
  }
  try { fs.unlinkSync(bin) } catch {}
}
fs.writeFileSync(path.join(ROOT, OUT), lines.join(""), "utf8")
console.log(`已写入 ${OUT}（${lines.join("").length} 字符）`)
