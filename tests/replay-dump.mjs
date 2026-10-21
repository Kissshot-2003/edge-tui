// 把 run.mjs 的输出字节流还原成「人眼看到的终端画面」。
//
// 用途：终端里看到的是一堆带色 ANSI，没法直接读。dump 模式把字节流写到文件后，
// 用这个脚本模拟终端行为（按光标定位写字符、处理 \x1b[K 清行），
// 还原成纯文本网格，就能逐行核对版式。
//
// 关键：必须模拟「按列覆写」而不是「追加」—— render 用行级 diff，
// 同一行会被多次定位写入（写入新内容 + 清尾），追加式还原会把它们串成一长条。
//
// 用法：
//   node run.mjs <url> --dump > out.bin
//   node tests/replay-dump.mjs out.bin [--raw]

import fs from "node:fs"

const file = process.argv[2]
if (!file) {
  console.error("用法: node tests/replay-dump.mjs <dump文件> [--raw]")
  process.exit(1)
}
const raw = process.argv.includes("--raw")

const s = fs.readFileSync(file, "utf8")

// 模拟屏幕：rows 行 × cols 列的字符数组
const lines = new Map()     // row(1-based) -> string[]
let curRow = 1, curCol = 0  // curCol 是「显示列」，CJK 占 2 列

const lineAt = (r) => {
  if (!lines.has(r)) lines.set(r, [])
  return lines.get(r)
}

// 双宽字符占两列：第 2 列是"延续格"，它本身不输出任何字符。
// 用哨兵值标记，打印时映射成空串 —— 早期写法往里塞 ""，
// 而打印用的是 `c || " "`（空串是 falsy）→ 每个汉字后面多出一个幽灵空格，
// 快照看起来像 `打 开 知 乎 App`，容易被误判成排版 bug。
const CONT = "\u0000"

const putChar = (r, col, ch) => {
  const arr = lineAt(r)
  while (arr.length <= col) arr.push(" ")
  arr[col] = ch
}

const clearToEnd = (r, col) => {
  const arr = lineAt(r)
  if (col < arr.length) arr.length = col
}

let i = 0
while (i < s.length) {
  if (s[i] === "\x1b") {
    const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i))
    if (m) {
      const [, params, final] = m
      if (final === "H") {
        const p = params.split(";")
        curRow = parseInt(p[0]) || 1
        curCol = (parseInt(p[1]) || 1) - 1
      } else if (final === "K") {
        // 0 = 光标到行尾；2 = 整行
        if (params === "2") lines.set(curRow, [])
        else clearToEnd(curRow, curCol)
      }
      // SGR 颜色 / ?25l / ?25h / 0m 等对文本内容无影响
      i += m[0].length
      continue
    }
    i += 1
    continue
  }
  // 按「码点」走：s 已是 JS 字符串，用 codePointAt 才能正确跨过代理对
  const cp = s.codePointAt(i)
  const ch = String.fromCodePoint(cp)
  i += ch.length          // 代理对在 JS 字符串里占 2 个 index
  // 宽字符（CJK）占 2 列
  const wide = cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000)
  putChar(curRow, curCol, ch)
  if (wide) { putChar(curRow, curCol + 1, CONT); curCol += 2 } else curCol += 1
}

const rows = [...lines.keys()].sort((a, b) => a - b)
const maxRow = rows.length ? rows[rows.length - 1] : 0
// 显示宽度：CJK 等双宽字符算 2 列。
// 用 `shown.length` 会把汉字当 1 列，报出来的"最宽"偏小，看不出行宽是否守恒。
const dispWidth = (str) => {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0)
    const isWide = cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3ffff))
    w += isWide ? 2 : 1
  }
  return w
}
let widest = 0
for (let r = 1; r <= maxRow; r++) {
  const arr = lines.get(r)
  if (!arr) { console.log(String(r).padStart(3) + "|"); continue }
  const t = arr.map((c) => (c === CONT ? "" : c || " ")).join("")
  const shown = raw ? t : t.replace(/\s+$/, "")
  const w = dispWidth(shown)
  if (w > widest) widest = w
  console.log(String(r).padStart(3) + "|" + shown)
}
console.log(`\n── ${maxRow} 行 · 最宽 ${widest} 列 ──`)
