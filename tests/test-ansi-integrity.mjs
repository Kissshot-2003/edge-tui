// 校验：run.mjs 输出到终端的字节流里，ANSI 序列必须完整且不污染网格内容
import { spawn } from "node:child_process"

// 用**当前正在跑的** node（process.execPath），不要写死某个绝对路径 ——
// 写死的路径在别人的机器上、或者 node 升级后就会失效，
// 症状是"spawn ENOENT"，跟被测的 ANSI 完整性毫无关系。
const NODE = process.execPath
const child = spawn(NODE, ["run.mjs", "https://example.com", "--dump"], {
  cwd: import.meta.dirname + "/..",
  windowsHide: true,
})

let buf = Buffer.alloc(0)
child.stdout.on("data", (d) => { buf = Buffer.concat([buf, d]) })
child.stderr.on("data", () => {})

child.on("close", () => {
  const s = buf.toString("binary")
  // 找出所有 CSI 序列（完整：ESC [ 参数 终字节）
  const seqs = s.match(/\x1b\[[0-9;?]*[A-Za-z]/g) || []
  // OSC 序列（ESC ] … BEL 或 ST）**也是完整的转义序列** —— 终端标题就是用它设的
  // （OSC 0;标题 BEL）。以前这个检查器只认 CSI，把合法的 OSC 当成了"残缺序列"。
  const oscs = s.match(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g) || []
  // 把完整序列挖掉后，剩下的 ESC 就是「没被终结」的残缺序列
  const stripped = s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")

  const broken = stripped.match(/\x1b/g) || []

  console.log(`输出字节数: ${buf.length}`)
  console.log(`完整 CSI 序列: ${seqs.length}`)
  console.log(`完整 OSC 序列: ${oscs.length}`)
  console.log(`残缺序列（未被终字节收尾的 ESC）: ${broken.length}`)

  // 真正要验证的：把合法 CSI 全部挖掉后，剩余文本里不该再有 ESC。
  // （\x1b[H / \x1b[12;1H 这类定位序列是渲染必需的，属合法 CSI。）
  const printable = stripped.replace(/\x1b/g, "")
  const escLeft = stripped.length - printable.length
  console.log(`剔除合法 CSI 后残留 ESC: ${escLeft}`)

  // 额外检查：正文里不应出现 CSI 参数字面量（如把 38;2;239;130;98m 当文本打印）
  const literalLeak = /(?:^|[^\x1b])\[\d+(?:;\d+)*m/.test(printable)
  console.log(`正文出现裸 SGR 字面量: ${literalLeak ? "是（异常）" : "否"}`)

  const ok = broken.length === 0 && escLeft === 0 && !literalLeak
  console.log(ok ? "\n✓ ANSI 字节流干净" : "\n✗ 存在损坏的转义序列")
  process.exitCode = ok ? 0 : 1
})
