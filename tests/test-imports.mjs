// 静态导入检查：抓「调用了某个模块的导出，却没把它 import 进来」这类 bug。
//
// 为什么必须有（真实事故）：
//   加入折叠内容功能时，run.mjs 里写了两处 `applyFoldState(...)`，
//   但 import 语句漏了它 —— textbrowser.js 导出了、run.mjs 却没用进来。
//   后果不是"折叠功能不生效"这么轻：
//     · captureText 每次抓页都在那一行抛 ReferenceError
//     · capture() 的 catch 只更新状态栏，页面区照旧渲染上一次成功抓到的 textPage
//     · 于是**按后退、刷新、打开链接，画面都纹丝不动**
//   用户报的是「无法使用 back」，而真正的原因是漏了一个导入。
//   这类 bug 不会让 node --check 报错，也不会让任何测试变红 ——
//   只有真的在浏览器里跑一遍才暴露。所以需要一道静态检查兜底。
import fs from "node:fs"
import path from "node:path"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const ROOT = path.join(import.meta.dirname, "..")

/** 收集一个模块的导出名 */
function exportsOf(src) {
  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split(/\s+as\s+/)
      const n = (t[1] || t[0] || "").trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  return names
}

/** 收集 import 进来的绑定名（含 `import * as ns`） */
function importsOf(src) {
  const names = new Set()
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/gm)) {
    const clause = m[1]
    const braced = clause.match(/\{([^}]*)\}/)
    if (braced) {
      for (const part of braced[1].split(",")) {
        const t = part.trim().split(/\s+as\s+/)
        const n = (t[1] || t[0] || "").trim()
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
      }
    }
    const def = clause.replace(/\{[^}]*\}/, "").split(",")[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(def)) names.add(def)
  }
  return names
}

/** 本模块自己声明的顶层/函数内绑定（粗粒度：全文匹配声明关键字） */
function localsOf(src) {
  const names = new Set()
  for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of src.matchAll(/(?:^|\s)(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // 函数参数、catch 参数、解构赋值……一律视为已声明，宁可漏报也不要误报
  for (const m of src.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*\(|\(|,)\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) names.add(m[1])
  return names
}

/**
 * 找出「被当作函数调用、但不是本地声明、也没导入」的名字。
 * 只认 `NAME(` 这种调用位置，且前面不能是 `.`（排除 obj.method()）。
 *
 * ⚠️ 还要排除**方法定义**：`class A { async submitField(fid) { … } }` 里的
 * `submitField(` 长得和调用一模一样，localsOf 又不认识"类方法"这种绑定，
 * 于是 cdp.js 定义 submitField 会被报成"调用了 inputpath 的 submitField 却没导入"。
 * 判据：整行就是 `[async] NAME(args) {` —— 那是定义，不是调用。
 */
function undefinedCalls(src, candidates) {
  const bag = new Set([...candidates])
  const missing = []
  for (const n of bag) {
    const re = new RegExp(`(?<![.\\w$])${n.replace(/\$/g, "\\$")}\\s*\\(`, "g")
    const defRe = new RegExp(`(^|[\\n{;])\\s*(?:async\\s+)?${n.replace(/\$/g, "\\$")}\\s*\\([^()]*\\)\\s*\\{`)
    if (defRe.test(src)) continue          // 这是方法/函数定义
    if (re.test(src)) missing.push(n)
  }
  return missing
}

console.log("══ 静态导入检查 ══\n")

// ── ① 自检：检查器本身必须能发现「漏导入」 ──
{
  const fakeSrc = `import { alpha } from "./a.js"\nalpha()\nbeta(1)\nobj.gamma()\nfunction delta() {}\ndelta()\nclass K { async eps(one) { this.eps(one) } }\n`
  // 走完整流程：先用「导入 ∪ 本地声明」把可用的名字挑出去，剩下的才谈得上"缺失"
  const have = new Set([...importsOf(fakeSrc), ...localsOf(fakeSrc)])
  const cands = ["alpha", "beta", "gamma", "delta", "eps"].filter((n) => !have.has(n))
  const missing = undefinedCalls(fakeSrc, cands)
  ok("自检：导入的 alpha 被识别为可用", have.has("alpha"))
  ok("自检：本地声明的 delta 被识别为可用", have.has("delta"))
  ok("自检：只有漏导入的 beta 被判为缺失调用", missing.join(",") === "beta", `missing=[${missing.join(",")}]`)
  ok("自检：方法调用 obj.gamma() 不误报", !missing.includes("gamma"))
  ok("自检：类方法定义 eps(...) 不算跨模块调用", !missing.includes("eps"), `missing=[${missing.join(",")}]`)
}

// ── ② src/*.js 之间的相互引用 ──
const srcDir = path.join(ROOT, "src")
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"))
const exp = {}
for (const f of files) exp[f] = exportsOf(fs.readFileSync(path.join(srcDir, f), "utf8"))

for (const f of files) {
  const src = fs.readFileSync(path.join(srcDir, f), "utf8")
  const have = new Set([...importsOf(src), ...localsOf(src)])
  // 候选 = 本文件 imported 的模块的导出 + 所有 src 模块的导出（名字冲突也算潜在问题）
  const cands = new Set()
  for (const other of files) for (const n of exp[other]) cands.add(n)
  for (const n of have) cands.delete(n)
  const missing = undefinedCalls(src, [...cands])
  ok(`src/${f}：调用的跨模块函数都已导入`, missing.length === 0, missing.join(","))
}

// ── ③ run.mjs（本次事故的现场）──
{
  const src = fs.readFileSync(path.join(ROOT, "run.mjs"), "utf8")
  const have = new Set([...importsOf(src), ...localsOf(src)])
  const cands = new Set()
  for (const f of files) for (const n of exp[f]) cands.add(n)
  for (const n of have) cands.delete(n)
  const missing = undefinedCalls(src, [...cands])
  ok("run.mjs：调用的 src 导出都已导入", missing.length === 0, missing.join(","))
  // 明确点名本次事故的函数，防止将来有人把 import 又删掉
  ok("run.mjs：applyFoldState 已导入（折叠功能的事故点）",
    /import\s*\{[^}]*\bapplyFoldState\b[^}]*\}/.test(src))
  ok("run.mjs：fieldDisplayName / fieldKindName 已导入（表单控件）",
    /import\s*\{[^}]*\bfieldDisplayName\b[^}]*\}/.test(src) &&
    /import\s*\{[^}]*\bfieldKindName\b[^}]*\}/.test(src))
  ok("run.mjs：已导入的名字确实是被用到的（防无用导入堆积）",
    ["applyFoldState", "buildTextPage", "renderTextPage"].every(
      (n) => new RegExp(`(?<![.\\w$])${n}\\s*\\(`).test(src)))
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
