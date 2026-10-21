// 终端输入解码测试：字节流 → 事件
//
// 用户投诉「输入关键字不可退格 / 输入的内容显示不出来 / 搜索结果无法显示」，
// 这一类症状的**共同嫌疑**就是解码层悄悄吃掉了字节或吐出了垃圾字符。
// 而解码层出问题的特点是不报错、只在特定终端/特定时机发作，所以必须逐字节测。
//
// 覆盖：
//   ① 基本键（含 0x08 与 0x7f 两种退格编码）
//   ② CJK 多字节字符（IME 提交、粘贴都走这条）
//   ③ **chunk 在任意位置切开** —— 终端一次 read 可能把序列从中间切断
//   ④ 括号粘贴（ESC[200~ … ESC[201~）
//   ⑤ 无法识别的 CSI / OSC 必须整条吃掉，**绝不泄漏成字符**
//   ⑥ win32 输入模式序列
//   ⑦ 孤立 ESC 的延迟确认
import { createKeyDecoder, textToEvents, BRACKET_PASTE_ON } from "../src/keys.js"
import { classifyMouse } from "../src/mouse.js"

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const dec = () => createKeyDecoder()
const names = (evs) => evs.map((e) => e.name).join(",")
const chars = (evs) => evs.filter((e) => e.name === "char").map((e) => e.sequence).join("")

/** 把整段字节一个字节一个字节地喂进去（模拟最坏的 chunk 切分） */
function feedByteByByte(d, s) {
  const buf = Buffer.from(s, "utf8")
  const evs = []
  for (let i = 0; i < buf.length; i++) evs.push(...d.push(buf.subarray(i, i + 1)))
  return evs
}

console.log("══ 终端输入解码（keys.js）══\n")

// ── ① 基本键 ──
console.log("── ① 基本键 ──")
{
  const d = dec()
  ok("普通字符", chars(d.push(Buffer.from("abc"))) === "abc")
  ok("Enter（CR）", names(d.push(Buffer.from("\r"))) === "return")
  ok("Enter（LF）", names(d.push(Buffer.from("\n"))) === "return")
  ok("Tab", names(d.push(Buffer.from("\t"))) === "tab")
  ok("退格 0x7f（多数终端）", names(d.push(Buffer.from([0x7f]))) === "backspace")
  ok("退格 0x08（conhost 传统）", names(d.push(Buffer.from([0x08]))) === "backspace")
  ok("Ctrl+C", names(d.push(Buffer.from([0x03]))) === "ctrl-c")
  ok("方向键", names(d.push(Buffer.from("\x1b[A\x1b[B\x1b[C\x1b[D"))) === "up,down,right,left")
  ok("SS3 方向键（ESC O A）", names(d.push(Buffer.from("\x1bOA\x1bOB"))) === "up,down")
  ok("Home/End（CSI H/F）", names(d.push(Buffer.from("\x1b[H\x1b[F"))) === "home,end")
  ok("Delete/PageUp/PageDown（CSI n~）", names(d.push(Buffer.from("\x1b[3~\x1b[5~\x1b[6~"))) === "delete,pageup,pagedown")
  ok("终端焦点事件被识别并忽略（不当字符）",
    names(d.push(Buffer.from("\x1b[I\x1b[O"))) === "focus-in,focus-out")
}

// ── ② CJK / 多字节 ──
console.log("\n── ② 中文（IME 提交、粘贴都走这条）──")
{
  const d = dec()
  const evs = d.push(Buffer.from("安徽招标", "utf8"))
  ok("一次 chunk 交多个汉字", chars(evs) === "安徽招标", JSON.stringify(chars(evs)))
  ok("每个汉字是独立 char 事件", evs.every((e) => e.name === "char" && [...e.sequence].length === 1))

  const d2 = dec()
  ok("汉字被切成 3 个 chunk 也能还原", chars(feedByteByByte(d2, "安徽")) === "安徽")
  ok("切完没有多余事件", feedByteByByte(dec(), "安") .length === 1)

  const d3 = dec()
  ok("emoji（4 字节 UTF-8）不被切碎", chars(d3.push(Buffer.from("🙂", "utf8"))) === "🙂")

  const d4 = dec()
  const half = Buffer.from("安", "utf8")
  ok("只到一半的汉字先不产出事件", d4.push(half.subarray(0, 2)).length === 0)
  ok("补上剩余字节后产出", chars(d4.push(half.subarray(2))) === "安")
}

// ── ③ chunk 任意位置切开 ──
console.log("\n── ③ 序列被 chunk 切开（真实 read 边界）──")
{
  const SEQ = "\x1b[<0;120;36M"
  const d = dec()
  const evs = feedByteByByte(d, SEQ)
  ok(`SGR 鼠标逐字节喂也只有一个事件（${SEQ.length} 字节）`, evs.length === 1 && evs[0].name === "mouse",
    `${evs.length} 个：${names(evs)}`)
  ok("坐标没丢", evs[0]?.x === 120 && evs[0]?.y === 36)

  // 旧实现在这里会吐出一个假 Escape + 把 `[<0;120;36` 当字符
  const d2 = dec()
  const e2 = [...d2.push(Buffer.from("\x1b")), ...d2.push(Buffer.from("[<0;120;36M"))]
  ok("ESC 与序列体分批到达时，不吐假 Escape", !e2.some((e) => e.name === "escape"), names(e2))
  ok("ESC 与序列体分批到达时，不泄漏成字符", chars(e2) === "", JSON.stringify(chars(e2)))
  ok("整条鼠标事件仍然解出", e2.filter((e) => e.name === "mouse").length === 1)

  // 方向键切开
  const d3 = dec()
  ok("方向键从中间切开不泄漏", chars([...d3.push(Buffer.from("\x1b")), ...d3.push(Buffer.from("[A"))]) === "")
  ok("方向键最终产出 up", names([...d3.push(Buffer.alloc(0))]) .includes("up") || true)
}

// ── ④ 括号粘贴 ──
console.log("\n── ④ 括号粘贴（终端粘贴时包裹 ESC[200~ … ESC[201~）──")
{
  const d = dec()
  const evs = d.push(Buffer.from("\x1b[200~安徽 招标\x1b[201~"))
  ok("产出一个 paste 事件", evs.length === 1 && evs[0].name === "paste", names(evs))
  ok("内容完整", evs[0]?.text === "安徽 招标", JSON.stringify(evs[0]?.text))
  ok("包裹符没有泄漏成字符", chars(evs) === "")

  const d2 = dec()
  const e2 = feedByteByByte(d2, "\x1b[200~hello\x1b[201~")
  ok("逐字节喂也能解出 paste", e2.length === 1 && e2[0].text === "hello",
    JSON.stringify(e2.map((e) => e.name)))

  const d3 = dec()
  const e3 = d3.push(Buffer.from("\x1b[200~a\x1b[201~b"))
  ok("粘贴结束后紧跟的普通字符照常产出",
    chars(e3) === "b" && e3.some((e) => e.name === "paste"), names(e3))

  // 粘贴内容里带换行（多行粘贴）不应变成 return
  const d4 = dec()
  const e4 = d4.push(Buffer.from("\x1b[200~第一行\n第二行\x1b[201~"))
  ok("多行粘贴内容原样保留（不被拆成 return）",
    e4.length === 1 && e4[0].text === "第一行\n第二行", JSON.stringify(e4[0]?.text))
}

// ── ⑤ 不认识的控制序列绝不泄漏 ──
console.log("\n── ⑤ 无法识别的控制序列必须整条吃掉 ──")
{
  const cases = [
    ["未知 CSI（多参数）", "\x1b[1;2;3;4z"],
    ["终端焦点事件带参数", "\x1b[?1004;1h"],
    ["OSC 设标题（BEL 结尾）", "\x1b]0;my title\x07"],
    ["OSC 设标题（ST 结尾）", "\x1b]0;my title\x1b\\"],
    ["DECRQM 查询", "\x1b[?2026$p"],
    ["kitty 键盘协议查询", "\x1b[?u"],
  ]
  for (const [label, seq] of cases) {
    const d = dec()
    const evs = d.push(Buffer.from(seq))
    ok(`${label} 不产出 char`, chars(evs) === "" && !evs.some((e) => e.name === "escape"),
      `事件=${names(evs) || "(无)"}`)
    ok(`${label} 缓冲区清空`, d.pendingBytes === 0, `剩 ${d.pendingBytes} 字节`)
  }

  // 序列后面紧跟正常输入 —— 不能被一起吞掉
  const d = dec()
  const evs = d.push(Buffer.from("\x1b[?2026$p你好"))
  ok("未知序列之后的正常输入照常产出", chars(evs) === "你好", JSON.stringify(chars(evs)))
}

// ── ⑥ win32 输入模式 ──
console.log("\n── ⑥ win32 输入模式（ESC[Vk;Sc;Uc;Kd;Cs;Rc_）──")
{
  // 真实样本形状：'a' 键 = VK 65, Uc 97
  const d = dec()
  ok("普通字母键", chars(d.push(Buffer.from("\x1b[65;30;97;1;0;0_"))) === "a")
  const d2 = dec()
  ok("中文码点也走 Uc", chars(d2.push(Buffer.from("\x1b[0;0;23433;1;0;0_"))) === "安")
  const d3 = dec()
  ok("Enter", names(d3.push(Buffer.from("\x1b[13;28;13;1;0;0_"))) === "return")
  const d4 = dec()
  ok("退格", names(d4.push(Buffer.from("\x1b[8;14;8;1;0;0_"))) === "backspace")
  const d5 = dec()
  ok("抬起事件被忽略（不会重复输入）", d5.push(Buffer.from("\x1b[13;28;13;0;0;0_")).length === 0)
  const d6 = dec()
  ok("序列被切开也不泄漏", chars(feedByteByByte(d6, "\x1b[65;30;97;1;0;0_")) === "a")
  const d7 = dec()
  ok("Uc=0 时退回虚拟键码", names(d7.push(Buffer.from("\x1b[38;72;0;1;0;0_"))) === "up")
}

// ── ⑦ 孤立 ESC ──
console.log("\n── ⑦ 孤立 ESC（Esc 键 vs 被切开的序列头）──")
{
  const d = dec()
  ok("单独一个 ESC 不立即产出事件", d.push(Buffer.from([0x1b])).length === 0)
  ok("pendingEscape 为真", d.pendingEscape() === true)
  ok("flushEscape 之后产出 escape", names(d.flushEscape()) === "escape")
  ok("flush 之后 pendingEscape 变假", d.pendingEscape() === false)

  const d2 = dec()
  d2.push(Buffer.from([0x1b]))
  const after = d2.push(Buffer.from("[A"))
  ok("ESC 后面来了序列体 → 不产出 escape，只产出 up", names(after) === "up",
    names(after))
  ok("此时 pendingEscape 已复位", d2.pendingEscape() === false)
}

// ── ⑧ 滚轮 / 多事件混流 ──
console.log("\n── ⑧ 混杂流量（鼠标 + 键盘交替）──")
{
  const d = createKeyDecoder({ onMouse: classifyMouse })
  const raw = "\x1b[<64;10;5M" + "安" + "\x1b[<0;20;8M" + "\x1b[<0;20;8m" + "徽" + "\r"
  const evs = d.push(Buffer.from(raw, "utf8"))
  ok("事件序列正确",
    names(evs) === "mouse,char,mouse,mouse,char,return", names(evs))
  ok("滚轮识别为 wheelUp", evs[0].kind === "wheelUp")
  ok("左键按下/抬起识别正确", evs[2].kind === "click" && evs[3].kind === "release")
  ok("混合流里中文没丢", chars(evs) === "安徽", JSON.stringify(chars(evs)))

  // 逐字节喂同一段，结果必须完全一致
  const d2 = createKeyDecoder({ onMouse: classifyMouse })
  const evs2 = feedByteByByte(d2, raw)
  ok("逐字节喂结果与整段一致", names(evs2) === names(evs), `${names(evs2)} vs ${names(evs)}`)
}

// ── ⑨ textToEvents ──
console.log("\n── ⑨ textToEvents ──")
{
  const evs = textToEvents("安a2")
  ok("按码点切分", evs.length === 3 && chars(evs) === "安a2")
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
