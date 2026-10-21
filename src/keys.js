// 终端输入解码：字节流 → 键盘/鼠标/粘贴事件
//
// 为什么要把这段从 run.mjs 里搬出来：
//
// ① 原来它是**内联在 stdin 回调里的一坨 if/else**，没法单独测。
//    而终端输入解码恰恰是最容易"看起来对、实际漏字节"的地方 ——
//    漏掉的字节不会报错，会**变成普通字符打进网页的输入框**，
//    症状是"搜索结果不对 / 输入框里有乱码"，从 DOM 侧完全看不出来。
//
// ② 原实现对「认不出来的 CSI 序列」是**按固定长度跳 3 字节**：
//        else { keyBuf = keyBuf.subarray(3); continue }
//    但 CSI 的长度是可变的（`ESC [ < 0 ; 1 0 ; 5 M` 有 11 字节）。
//    后果：括号粘贴 `ESC[200~...ESC[201~`、win32 输入模式
//    `ESC[86;52;252;1;0;0_`、终端焦点事件 `ESC[I` 全都被切碎，
//    剩下的尾巴 `200~` / `;252;1;0;0_` 会被当成**用户打的字**送进页面。
//
// ③ 独立成模块后，`tests/test-keys.mjs` 可以逐字节地喂输入、逐事件断言，
//    包括「chunk 在任意位置切开」这种真实网络/管道才会出现的边界。
//
// ── 事件形状 ──
//   { name: "char", sequence: "安" }
//   { name: "return" | "tab" | "backspace" | "escape" | "delete"
//          | "up" | "down" | "left" | "right" | "home" | "end"
//          | "pageup" | "pagedown" | "shift-tab" }
//   { name: "paste", text: "整段粘贴内容" }
//   { name: "mouse", ev: {cb,x,y,release} }   // 已解出的 SGR 原文
//   { name: "focus-in" | "focus-out" }        // 终端焦点事件（一般忽略）
//
// ── 三条硬约束 ──
//   1. **绝不泄漏字节**：任何可识别序列之外的字节，要么整条吃掉，要么整条留在
//      缓冲区等下一批，不production 生 "半截当字符" 的事件。
//   2. **不完整 = null**：序列被 chunk 切开时必须等待，不能报错、不能跳。
//   3. **ESC 单独到达要延迟**：Esc 键和序列头都是 0x1b，无法从字节区分。
//      所以孤立 ESC 不立即产出事件，由调用方在 ~40ms 后调 flushEscape() 确认。

import { parseSgrMouse } from "./mouse.js"

export const BRACKET_PASTE_ON = "\x1b[?2004h"
export const BRACKET_PASTE_OFF = "\x1b[?2004l"

const ESC = 0x1b
const CSI_END_MARK = Buffer.from("\x1b[201~")

/** CSI 终结字节：0x40–0x7E */
const isCsiFinal = (b) => b >= 0x40 && b <= 0x7e
/** CSI 参数字节：0x20–0x3F */
const isCsiParam = (b) => b >= 0x20 && b <= 0x3f

/**
 * 扫一条 CSI：`ESC [ <参数…> <终结字节>`。
 * @returns {{params:string, final:string, len:number}|{bad:true, len:number}|null}
 *          null = 数据不完整，等下一批。
 */
function scanCsi(buf, from) {
  let i = from
  while (i < buf.length) {
    const b = buf[i]
    if (isCsiFinal(b)) {
      return { params: buf.subarray(from, i).toString("latin1"), final: String.fromCharCode(b), len: i + 1 }
    }
    if (!isCsiParam(b)) {
      // 参数字节里出现了不该有的东西 —— 我们认错了开头（可能是一段不可打印数据）。
      // 整段吃掉，**绝不能把尾巴留给字符分支**。
      return { bad: true, len: i + 1 }
    }
    i++
  }
  return null
}

/** 扫一条 OSC：`ESC ] … (BEL | ESC \)`。返回 len 或 null */
function scanOsc(buf, from) {
  let i = from
  while (i < buf.length) {
    if (buf[i] === 0x07) return { len: i + 1 }
    if (buf[i] === ESC && buf[i + 1] === 0x5c) return { len: i + 2 }
    if (buf[i] === ESC) return null            // ESC 可能是 ST 的开头，等下一批
    i++
  }
  return null
}

const CSI_KEYS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab" }
const SS3_KEYS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" }
const TILDE_KEYS = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown" }

/** win32 输入模式的虚拟键码（只在 Uc==0 时才用得上） */
const VK_KEYS = {
  8: "backspace", 9: "tab", 13: "return", 27: "escape", 46: "delete",
  33: "pageup", 34: "pagedown", 35: "end", 36: "home", 37: "left", 38: "up", 39: "right", 40: "down",
}

/**
 * 把一条 CSI 翻成事件。
 * ⚠️ 认不出来的一律返回 null —— **不能返回"未知"让调用方去猜**。
 */
/** CSI-u（kitty 键盘协议）：ESC [ <code> ; <mods> u。
 *  mods-1 的位：1=shift 2=alt 4=ctrl。
 *  这是**唯一**能区分 Ctrl+Tab / Ctrl+数字 的编码 —— 传统终端里它们与普通
 *  Tab / 数字是同一个字节。 */
function csiUToEvent(params) {
  const parts = params.split(";")
  const code = Number(parts[0])
  if (!Number.isFinite(code) || code <= 0) return null
  const mods = parts.length > 1 ? Number(parts[1]) : 1
  const m = Number.isFinite(mods) && mods > 0 ? mods - 1 : 0
  const ev = codeToEvent(code)
  if (!ev) return null
  if (m & 1) ev.shift = true
  if (m & 2) ev.alt = true
  if (m & 4) ev.ctrl = true
  return ev
}

const CSIU_NAMES = { 9: "tab", 13: "return", 27: "escape", 8: "backspace", 127: "backspace" }
function codeToEvent(code) {
  const n = CSIU_NAMES[code]
  if (n) return { name: n }
  if (code >= 0x20 && code <= 0x7e) return { name: "char", sequence: String.fromCharCode(code) }
  return null
}

function csiToEvent(params, final, st) {
  if (final === "_") return win32Event(params)          // win32 输入模式
  if (final === "u") return csiUToEvent(params)        // kitty 键盘协议（带修饰键）
  if (final === "~") {
    const n = Number(params.replace(/^\?/, "").split(";")[0])
    if (n === 200) { st.paste = true; return null }     // 括号粘贴开始
    if (n === 201) { st.paste = false; return null }    // 括号粘贴结束
    const k = TILDE_KEYS[n]
    return k ? { name: k } : null
  }
  if (final === "M" && params === "") { st.x10Mouse = true; return null }   // 老式 X10 鼠标头
  const k = CSI_KEYS[final]
  if (k) return { name: k }
  // `ESC [ I` / `ESC [ O`：终端获得/失去焦点。认出来并忽略，比当垃圾吃掉更有用。
  if (final === "I") return { name: "focus-in" }
  if (final === "O") return { name: "focus-out" }
  // `ESC [ ? 2004 h` 之类：模式设置，忽略。**必须在末尾**，因为它也以 h/l 结尾。
  return null
}

/**
 * win32 输入模式：`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`
 * 这是 Windows Terminal 在应用开启 `?9001h` 后发的东西。
 * 我们不主动开启（会破坏别的终端），但**必须能解析** ——
 * 用户自己/别的工具把它打开时，否则整条序列会被切碎打进页面。
 */
function win32Event(params) {
  const p = params.split(";").map(Number)
  if (p.length < 4) return null
  const [vk, , uc, kd, cs] = p
  if (kd !== 1) return null                 // 只处理按下，抬起忽略
  // Windows 控制键位：1=右Alt 2=左Alt 4=右Ctrl 8=左Ctrl 16=Shift
  const m = cs || 0
  const flags = () => ({
    ...(m & 16 ? { shift: true } : {}),
    ...(m & 3 ? { alt: true } : {}),
    ...(m & 12 ? { ctrl: true } : {}),
  })
  if (uc > 0) {
    if (uc === 13) return { name: "return", ...flags() }
    if (uc === 8 || uc === 127) return { name: "backspace", ...flags() }
    if (uc === 9) return { name: "tab", ...flags() }
    if (uc === 27) return { name: "escape", ...flags() }
    if (uc === 3) return { name: "ctrl-c", ...flags() }
    if (uc >= 0x20) return { name: "char", sequence: String.fromCodePoint(uc), ...flags() }
  }
  const k = VK_KEYS[vk]
  return k ? { name: k, ...flags() } : null
}

/** UTF-8 首字节 → 序列总长度（1 表示 ASCII） */
function utf8Len(b) {
  if ((b & 0xe0) === 0xc0) return 2
  if ((b & 0xf0) === 0xe0) return 3
  if ((b & 0xf8) === 0xf0) return 4
  return 1
}

/**
 * 创建一个有状态解码器。
 * @param {(ev:object)=>object} [onMouse]  鼠标事件的可选翻译钩子（例如 classifyMouse）
 */
export function createKeyDecoder({ onMouse } = {}) {
  let buf = Buffer.alloc(0)
  const st = { paste: false, pasteText: "", x10Mouse: false, x10Buf: [] }
  let sawEscape = false

  function push(chunk) {
    if (chunk && chunk.length) buf = Buffer.concat([buf, chunk])
    const out = []
    drain(out)
    sawEscape = buf.length === 1 && buf[0] === ESC
    return out
  }

  function emit(out, ev) {
    if (!ev) return
    if (ev.name === "mouse") {
      // 鼠标事件**始终**带上原始字段（cb/x/y/release），再叠加翻译结果。
      // 翻译失败也照样上报 —— 丢了它，调用方就得自己去猜"为什么点了没反应"。
      const m = { name: "mouse", cb: ev.ev.cb, x: ev.ev.x, y: ev.ev.y, release: !!ev.ev.release }
      if (onMouse) Object.assign(m, onMouse(ev.ev) || {})
      out.push(m)
      return
    }
    out.push(ev)
  }

  function drain(out) {
    while (buf.length) {
      const b = buf[0]

      // ── 括号粘贴内部：只找 ESC[201~ ──
      if (st.paste) {
        const end = buf.indexOf(CSI_END_MARK)
        if (end < 0) {
          // 终结符可能被切开 —— 留最后 5 字节不打进去，免得 `\x1b[20` 混进正文
          const keep = Math.min(buf.length, CSI_END_MARK.length - 1)
          const cut = buf.length - keep
          st.pasteText += buf.subarray(0, cut).toString("utf8")
          buf = buf.subarray(cut)
          return
        }
        st.pasteText += buf.subarray(0, end).toString("utf8")
        buf = buf.subarray(end + CSI_END_MARK.length)
        st.paste = false
        const text = st.pasteText
        st.pasteText = ""
        if (text) out.push({ name: "paste", text })
        continue
      }

      // ── X10 鼠标：ESC [ M 之后紧跟 3 个字节（各 +32）──
      if (st.x10Mouse) {
        while (buf.length >= 1 && st.x10Buf.length < 3) {
          st.x10Buf.push(buf[0] - 32)
          buf = buf.subarray(1)
        }
        if (st.x10Buf.length < 3) return
        const [cb, x, y] = st.x10Buf
        st.x10Buf = []
        st.x10Mouse = false
        emit(out, { name: "mouse", ev: { cb, x, y, release: false } })
        continue
      }

      if (b === ESC) {
        // 孤立 ESC：可能是 Esc 键，也可能是被切开的序列头 —— 不产出事件，等 flush 或下一批
        if (buf.length < 2) return
        const b1 = buf[1]

        if (b1 === 0x5b) {                                  // ESC [
          // SGR 鼠标要排在通用 CSI 前面：它内部有自己的扫描器
          if (buf.length >= 3 && buf[2] === 0x3c) {
            const ev = parseSgrMouse(buf, 0)
            if (!ev) return                                  // 不完整，等下一批
            buf = buf.subarray(ev.len)
            if (!ev.bad) emit(out, { name: "mouse", ev })
            continue
          }
          const r = scanCsi(buf, 2)
          if (!r) return                                    // 不完整，等下一批
          buf = buf.subarray(r.len)
          if (!r.bad) emit(out, csiToEvent(r.params, r.final, st))
          continue
        }

        if (b1 === 0x5d) {                                  // OSC
          const r = scanOsc(buf, 2)
          if (!r) return
          buf = buf.subarray(r.len)
          continue                                          // OSC 一律忽略
        }

        if (b1 === 0x4f) {                                  // SS3（ESC O 开头）
          if (buf.length < 3) return
          const c = String.fromCharCode(buf[2])
          buf = buf.subarray(3)
          if (SS3_KEYS[c]) out.push({ name: SS3_KEYS[c] })
          continue
        }

        // 其余 ESC 双字节（ESC c / ESC 7 / ESC = / Alt+key…）整条吃掉
        buf = buf.subarray(2)
        continue
      }

      if (b < 0x20 || b === 0x7f) {
        buf = buf.subarray(1)
        if (b === 0x03) out.push({ name: "ctrl-c" })
        else if (b === 0x0d || b === 0x0a) out.push({ name: "return" })
        else if (b === 0x09) out.push({ name: "tab" })
        else if (b === 0x08 || b === 0x7f) out.push({ name: "backspace" })
        else if (b >= 0x01 && b <= 0x1a) {
          // Ctrl+字母：0x01='a' … 0x1a='z'（0x03/0x08/0x09/0x0a/0x0d 已在上面特判）
          out.push({ name: "char", sequence: String.fromCharCode(0x60 + b), ctrl: true })
        }
        continue
      }

      const len = utf8Len(b)
      if (buf.length < len) return                          // 多字节字符被切开
      const s = buf.subarray(0, len).toString("utf8")
      buf = buf.subarray(len)
      // 非法 UTF-8（toString 出 \uFFFD）不要往页面里送
      if (s.includes("\uFFFD")) continue
      emit(out, { name: "char", sequence: s })
    }
  }

  return {
    push,
    /** 缓冲区里是否只剩一个孤立的 ESC（调用方据此起定时器） */
    pendingEscape: () => sawEscape,
    /** 确认「那个 ESC 就是 Esc 键」 */
    flushEscape() {
      if (!sawEscape) return []
      sawEscape = false
      buf = Buffer.alloc(0)
      return [{ name: "escape" }]
    },
    /** 还没消费的字节数（调试/测试用） */
    get pendingBytes() { return buf.length },
  }
}

/**
 * 把一段「用户意图文本」按 UTF-8 边界切成独立的 char 事件。
 * 粘贴、IME 一次性提交多字、以及测试都用它。
 */
export function textToEvents(text) {
  const out = []
  for (const ch of [...text]) out.push({ name: "char", sequence: ch })
  return out
}
