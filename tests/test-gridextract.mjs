// 诊断：按每行实际宽度还原栅格（不假设列宽）
import fs from "node:fs"

const s = fs.readFileSync("../out.txt", "utf8")
const esc = String.fromCharCode(27)
const ESC_RE = new RegExp(esc + "\\[[0-9;?]*[a-zA-Z]", "g")

// 提取每行：以 "行号;1H" 为分隔
const parts = s.split(new RegExp(esc + "\\[(\\d+);1H"))
// parts[0] 是前置，之后 [行号, 内容, 行号, 内容...]
const lines = new Map()
for (let i = 1; i < parts.length; i += 2) {
  const n = Number(parts[i])
  let content = parts[i + 1] || ""
  content = content.replace(new RegExp(esc + "\\[K", "g"), "")
  content = content.replace(ESC_RE, "")
  lines.set(n, content)
}
const maxN = Math.max(...lines.keys())
console.log("行数:", maxN)
for (let n = 1; n <= Math.min(maxN, 40); n++) {
  const raw = lines.get(n) ?? ""
  // 用显示宽度切：先找 | ... | 的边界
  const m = raw.match(/^\|([\s\S]*)\|$/)
  const body = m ? m[1] : raw
  const w = [...body].reduce((a, ch) => a + (ch.codePointAt(0) > 0x2000 ? 2 : 1), 0)
  console.log(String(n).padStart(2, "0") + `[${String(w).padStart(3)}]|` + body.slice(0, 100) + "|")
}
