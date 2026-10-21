// 生成一份「终端里到底长什么样」的演示快照。
// 用途：给用户/未来的自己看文字模式的真实观感，同时作为「首屏能看到什么」的验收证据。
//
//   node tests/make-demo.mjs
//   → demo-snapshot.txt
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = path.resolve(import.meta.dirname, "..")
const NODE = process.execPath

const run = (args, out) => execFileSync(NODE, args, { cwd: ROOT, stdio: ["ignore", fs.openSync(out, "w"), "ignore"] })
const snap = (bin) => execFileSync(NODE, ["tests/replay-dump.mjs", bin], { cwd: ROOT, encoding: "utf8" })

const out = []
const head = (t) => out.push(`\n${"═".repeat(100)}\n${t}\n${"═".repeat(100)}\n`)

head("① example.com —— 普通文章页：文字逐字清晰，链接带 › 标记，英文按空格折行")
run(["run.mjs", "https://example.com", "--dump"], "demo-1.bin")
out.push(snap("demo-1.bin"))

head("② 知乎登录页 —— 二维码走「无损直读」，画出来能真扫")
out.push("当初的投诉是「只是图片用ASCII重构，文字要保留啊，二维码完全花了什么都看不清」。\n" +
  "现在分两条路：文字全是终端原生字符（可读可选中）；二维码**不降采样** ——\n" +
  "直接从页面读原始分辨率位图、还原 49×49 的模块矩阵，再 1 模块 1 字符画出来。\n" +
  "打开页面时若码没被完整显示，会自动把行窗口对齐过去（缺一半的码扫不出来）。\n" +
  "验证方式见 tests/test-qr-scan.mjs：把渲染结果反解回文本，解出的正是\n" +
  "https://www.zhihu.com/account/scan/login/...\n")
run(["run.mjs", "https://www.zhihu.com/signin", "--dump"], "demo-2.bin")
out.push(snap("demo-2.bin"))

head("③ 图片模式（按 m 切换 / --image）—— 同一页的整页降采样，对照用")
out.push("注意正文在这个模式下糊成一团 —— 这就是为什么文字模式是默认值。\n")
run(["run.mjs", "--image", "https://example.com", "--dump"], "demo-3.bin")
out.push(snap("demo-3.bin"))

head("④ 长文档的行级滚动 —— 总行数正确上报，滚动精确到行")
out.push("旧版 renderTextPage 在循环里提前 break，totalRows 恒等于 maxRows，\n" +
  "导致长页面「滚不动」；现在完整生成后再切片。\n")
out.push(execFileSync(NODE, ["tests/test-textmode-scroll.mjs"], { cwd: ROOT, encoding: "utf8" }))

head("⑤ 折叠内容 —— 「展开全文 / 查看更多」在文字浏览器里不再是死路")
out.push("投诉是「很多文字部分被页面折叠了看不全，无法点击展开和查看详细」。\n" +
  "根因：折叠内容多为 display:none（或 closed <details>），旧提取器一律过滤掉，\n" +
  "于是正文整段消失，只剩一个点不动的站点按钮。\n" +
  "现在把隐藏子树连文字一起读出来，登记成一条标记（写明控件名 + 字数 + 按键），\n" +
  "按 e 就地插进文本流 —— 纯文字层展开，不点页面、不依赖站点 JS、无副作用。\n" +
  "需要「展开后链接可点」时按 E：真去点页面控件再重新提取（有防误操作过滤）。\n")
// 真机整屏（本地 fixture，无需联网）：注意看状态栏右侧的 `折叠 0/2 处 (e)`
out.push("整屏（本地 fixture 页，文字模式默认界面）：\n")
run(["run.mjs", pathToFileURL(path.join(ROOT, "tests", "fixtures", "fold-page.html")).href, "--dump"], "demo-5.bin")
out.push(snap("demo-5.bin"))
out.push("\n同一页的收起 / 展开两态对照：\n")
out.push(execFileSync(NODE, ["tests/dump-fold.mjs"], { cwd: ROOT, encoding: "utf8" }))
out.push(execFileSync(NODE, ["tests/test-fold.mjs"], { cwd: ROOT, encoding: "utf8" }))

head("⑥ 表单控件 —— 「看不到搜索框、无法搜索」的修复")
out.push("投诉是「Bing 页面看不到搜索的输入框，无法搜索」。\n" +
  "根因：<input> 自身没有文字节点、也不是媒体块 —— 旧提取器走到「只收叶子文字块」\n" +
  "那一步时 directText 为空，直接跳过。于是必应首页那个 659×42、明明白白可见的\n" +
  "搜索框在文字模式里**完全不存在**。\n" +
  "现在控件是文本流里的一等公民：青色=可输入、金色=提交按钮、灰色=禁用/只读，\n" +
  "按 i 直接聚焦页面主搜索框（不需要先 Tab 蒙），打字只重绘不重抓整页。\n")
out.push("整屏（本地 fixture 页）：\n")
run(["run.mjs", pathToFileURL(path.join(ROOT, "tests", "fixtures", "field-page.html")).href, "--dump"], "demo-6.bin")
out.push(snap("demo-6.bin"))
out.push("\n真实站点（必应）首屏，搜索框在文字流里的位置：\n")
run(["run.mjs", "https://cn.bing.com/", "--dump"], "demo-7.bin")
out.push(snap("demo-7.bin"))
out.push(execFileSync(NODE, ["tests/test-field.mjs"], { cwd: ROOT, encoding: "utf8" }))

head("⑦ 鼠标 —— 参考 Browsh：终端里「看到就点」才是主路径")
out.push("键盘路径（Tab 循环 / v 元素清单）是没鼠标时的兜底，不能当主路径：\n" +
  "它们要求用户先知道有这两个功能，再盯着屏幕找行号。Browsh 最值得抄的就是这一点。\n" +
  "我们没 native 依赖，自己解 SGR 扩展编码（ESC [ < Cb ; Cx ; Cy M）：\n" +
  "  左键点链接  → 真实点击（_blank 也在本标签打开）\n" +
  "  左键点控件  → 聚焦并进入输入模式，直接打字\n" +
  "  左键点折叠  → 就地展开/收起**这一处**\n" +
  "  滚轮         → 上下滚动（文字模式按行，瞬时）\n" +
  "点空白 / 纯文字段落不做任何动作 —— 文字模式是重排过的，终端列和页面 x\n" +
  "之间没有线性关系，按像素反推去乱点很容易误触广告或提交按钮。\n" +
  "整屏观感：见上面 ⑤⑥ 两节，提示行现在写着「鼠标: 点链接/控件/折叠 · 滚轮翻页」。\n")
out.push(execFileSync(NODE, ["tests/test-mouse.mjs"], { cwd: ROOT, encoding: "utf8" }))

head("⑧ 输入路径 —— 「打不进 / 退不掉 / 搜不出」是同一个根因")
out.push("投诉是「搜索结果无法显示，输入法在搜索框无法正常显示，输入关键字不可退格」。\n" +
  "看着是三件事，实测下来是一个根因：Input.insertText 把字送进浏览器**内部记住的\n" +
  "焦点元素**，不是 document.activeElement。站点把输入框节点换掉之后（SPA 重挂载、\n" +
  "框架重渲染），内部焦点仍指着**已经被摘掉的旧节点** —— 字打进虚空，\n" +
  "不报错、返回值正常、控件 value 一个字节都不变。\n" +
  "于是：打字→屏幕没反应；退格→值本来没进去；回车→提交空值。\n" +
  "对照实验（tests/probe-node-swap.mjs）：\n")
out.push(execFileSync(NODE, ["tests/probe-node-swap.mjs"], { cwd: ROOT, encoding: "utf8" }))
out.push("\n修法（src/inputpath.js）：每个动作都是「先查焦点 → 送 → 读回校验 → 逐级兜底」，\n" +
  "  direct(真实按键) → refocus(重新聚焦再送) → dom(原型 setter + 派发 input 事件)。\n" +
  "「先查焦点」不能省：焦点在别的控件上时直接送字，字会落进**那个**控件。\n" +
  "自愈会留痕（状态栏「已自动重新聚焦」/ crash.log 的 [input] …走了兜底路径）——\n" +
  "静默自愈和静默失败在日志上没区别。\n" +
  "配套还修了两件事：\n" +
  "  · 输入解码从 run.mjs 抽到 src/keys.js：原来对认不出的 CSI **跳固定 3 字节**，\n" +
  "    括号粘贴 / win32 输入模式 / 终端焦点事件都会被切碎，剩下的尾巴当用户打的字\n" +
  "    送进搜索框；孤立 ESC 立即产出 Escape（切开的鼠标序列会先吐一个假 Esc，\n" +
  "    再把 `[<0;120;36M` 打进输入框）。\n" +
  "  · waitContent 判据从「内容够多」改成「**内容稳定**」：老判据在搜索结果页上\n" +
  "    被那几条「跳至内容 / 辅助功能反馈」链接瞬间满足 → 抓到一张 11 字的半成品页。\n" +
  "    修好后同一页提取 **1181 字**（见 test-inputpath 的端到端断言）。\n")
out.push(execFileSync(NODE, ["tests/test-keys.mjs"], { cwd: ROOT, encoding: "utf8" }))
out.push(execFileSync(NODE, ["tests/test-inputpath.mjs"], { cwd: ROOT, encoding: "utf8" }))

head("⑨ 加载不卡住 —— 「总是莫名其妙的页面加载卡住」")
out.push("查下来不是一处问题，而是**每一步都可能无限等**，而且每一步单独看都「很合理」：\n" +
  "  · 等 Page.loadEventFired 最多 25s —— 广告/埋点/大图任一卡住，load 就永远不来\n" +
  "  · 之后的 settle() 最多 12s，还要求 readyState==='complete' —— 有挂起子资源时\n" +
  "    complete 永远不来，每轮白等（单次导航最长冻 37 秒）\n" +
  "  · 抓图串行无上限 —— 40 张图 = 40 次 CDP 往返，界面完全静止\n" +
  "  · alert()/confirm() 完全没处理 —— 弹窗**阻塞渲染进程**，evaluate/截图全不返回\n" +
  "  · WebSocket 断开不通知在飞调用 —— Edge 崩一次，界面冻两分钟\n" +
  "\n同类项目的做法（抄结论不抄代码）：\n" +
  "  · w3m / lynx / elinks：纯 HTTP，收到 body 就渲染，**从不等子资源**\n" +
  "  · Browsh：DOM 就绪 + render_delay=100ms，timeout=30s 硬上限，**不等 load**\n" +
  "  · Carbonyl：**根本不「等加载」** —— 连续出帧，什么时候画出来什么时候算\n" +
  "  · Playwright/Puppeteer：默认 waitUntil:'load' 最慢最脆，官方推荐 domcontentloaded；\n" +
  "    强调**绝不 timeout=0**（会把慢加载变成静默死循环）；networkidle 有埋点时可能永不返回\n" +
  "\n结论一致：别把「所有资源加载完」当可用条件。现在判据是\n" +
  "「新文档就位 + 内容连续两拍不变」，并且每一步都有硬上限，超时就**降级渲染 + 说明原因**。\n" +
  "⚠️ 判据里绝不能出现 readyState：<head> 里一个不返回的 <script src> 会让解析器直接停住，\n" +
  "DOMContentLoaded 和 readyState!=='loading' **都永远不会发生** —— 本地脚本总是立刻返回，\n" +
  "所以静态页面手工测试永远复现不出来，但线上被墙/被拦的统计脚本天天这样。\n" +
  "\n四种「卡死」的本地复现（一个永不回应的 HTTP 服务器，用**墙上时钟**断言）：\n")
out.push(execFileSync(NODE, ["tests/test-loadhangs.mjs"], { cwd: ROOT, encoding: "utf8" }))

fs.writeFileSync(path.join(ROOT, "demo-snapshot.txt"), out.join(""), "utf8")
for (const f of ["demo-1.bin", "demo-2.bin", "demo-3.bin", "demo-5.bin", "demo-6.bin", "demo-7.bin"]) { try { fs.unlinkSync(path.join(ROOT, f)) } catch {} }
console.log("已生成 demo-snapshot.txt")
