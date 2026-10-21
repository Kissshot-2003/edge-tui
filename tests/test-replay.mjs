// 把 --dump 输出重放成带颜色的真实终端画面，用于视觉验收
import fs from "node:fs"

const file = process.argv[2] || "out.txt"
const s = fs.readFileSync(file, "utf8")
const esc = "\x1b"
const ESC_RE = new RegExp(esc + "\\[[0-9;?]*[a-zA-Z]", "g")

const parts = s.split(new RegExp(esc + "\\[(\\d+);1H"))
const lines = new Map()
for (let i = 1; i < parts.length; i += 2) {
  const n = Number(parts[i])
  const content = (parts[i + 1] || "").replace(new RegExp(esc + "\\[K", "g"), "")
  lines.set(n, content)
}
const maxN = Math.max(...lines.keys(), 0)
for (let n = 1; n <= maxN; n++) {
  const raw = lines.get(n)
  if (raw === undefined) continue
  process.stdout.write(raw.replace(ESC_RE, "") + "\n")
}
