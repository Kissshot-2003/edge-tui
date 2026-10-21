// 渲染快照：把 out.txt 按真实行还原成可读画面（剥离 ANSI，按行号定位）
import fs from "node:fs"

const file = process.argv[2] || "out.txt"
const s = fs.readFileSync(file, "utf8")
const esc = "\x1b"
const ESC_RE = new RegExp(esc + "\\[[0-9;?]*[a-zA-Z]", "g")

const parts = s.split(new RegExp(esc + "\\[(\\d+);1H"))
const lines = new Map()
for (let i = 1; i < parts.length; i += 2) {
  const n = Number(parts[i])
  let content = (parts[i + 1] || "").replace(new RegExp(esc + "\\[K", "g"), "").replace(ESC_RE, "")
  lines.set(n, content)
}
const maxN = Math.max(...lines.keys(), 0)
console.log(`── 渲染快照（共 ${maxN} 行）──`)
for (let n = 1; n <= maxN; n++) {
  const raw = lines.get(n)
  if (raw === undefined) { console.log(String(n).padStart(2, "0") + "|  <空>"); continue }
  console.log(String(n).padStart(2, "0") + "|" + raw + "|")
}
