// 表单控件的「自愈式」输入路径：打字 / 退格 / 提交
//
// 为什么单独成模块：这三个动作是用户投诉的焦点 ——
//   「搜索结果无法显示，输入法在搜索框无法正常显示，输入关键字不可退格」
//
// ── 病灶（已用 tests/probe-node-swap.mjs 实测复现）──
// CDP 的 `Input.insertText` 把字送进浏览器**内部记住的那个焦点元素**，
// 而不是 `document.activeElement`。当站点把输入框节点整个换掉
// （SPA 重挂载、focus 后换新节点、框架重渲染 —— 真实站点上极常见）时：
//
//   站点替换节点 → 内部焦点仍指着**已经被摘掉的旧节点**
//   → `Input.insertText` 把字打进一个脱离文档的元素
//   → **不报错、返回值正常、输入框 value 一个字节都不变**
//
// 实测（probe-node-swap.mjs）：
//   A 正常聚焦后 insertText("A")     → value="A"     ✓
//   B 节点被替换后 insertText("B")   → value=""      ✗ 完全静默失效
//   C 重新聚焦再送 insertText("C")   → value="C"     ✓ 一级自愈即可恢复
//   E 焦点在 textarea 时送字         → 字进了 textarea，搜索框纹丝不动
//
// 于是用户看到的三个症状其实是同一个根因的三个侧面：
//   打字   → 屏幕上没反应            → "输入法/输入框坏了"
//   退格   → 值本来就没变，删不掉     → "不能退格"
//   回车   → 提交的是空值/没提交      → "搜索结果出不来"
//
// ── 所以每一步都做三件事 ──
//   ① 先查焦点   焦点不在目标控件上就**先修再送**，不能让这一键落到别的控件里
//   ② 送完校验   读回 value 比对，**不假设成功**
//   ③ 逐级兜底   重新聚焦再送 → DOM 级注入（原型 setter + input 事件）
//
// 返回值里的 `via` 明确告诉调用方**是靠哪一级成功的** ——
// 自愈必须是看得见的，否则"静默自愈"和"静默失败"在日志上没区别。

/** 成功路径，越靠前越"真实" */
export const VIA = {
  DIRECT: "direct",       // 焦点本来就在，真实按键 / insertText 一次成功
  REFOCUS: "refocus",     // 焦点跑偏了，重新聚焦后成功
  DOM: "dom",             // 焦点修不回来 → DOM 级注入（原型 setter + input 事件）
  LOST: "lost",           // 控件已从 DOM 消失（页面跳走 / 卸载）
}

/** 读回控件当前值；控件不存在返回 null */
async function readValue(tab, f) {
  try { return await tab.fieldValue(f.fid) } catch { return null }
}

/** 焦点是否**真的**在目标控件上 */
async function isFocused(tab, f) {
  try { return await tab.isFocusedField(f.fid) === true } catch { return false }
}

async function refocus(tab, f) {
  try { const r = await tab.focusField(f.fid); return !!(r && r.ok) } catch { return false }
}

/**
 * 按「策略表」逐个尝试，第一个让 value 发生变化的策略即为成功。
 * 每一级都读回校验 —— 这是本模块存在的全部理由。
 */
async function trySteps(tab, f, steps) {
  // 焦点已经跑偏时，第一级会把字打进**别的控件**里（实测场景 E），
  // 所以直接从"先修焦点"那一级开始，不要先污染别处。
  const start = (await isFocused(tab, f)) ? 0 : 1
  for (let i = start; i < steps.length; i++) {
    const before = await readValue(tab, f)
    if (before === null) return { value: null, via: VIA.LOST }
    try { await steps[i].run() } catch { /* 读回校验会兜住 */ }
    const after = await readValue(tab, f)
    if (after === null) return { value: null, via: VIA.LOST }
    if (after !== before) return { value: after, via: steps[i].via }
  }
  const v = await readValue(tab, f)
  if (v === null) return { value: null, via: VIA.LOST }
  return { value: v, via: VIA.DOM }      // 全试过了还是没变 → 如实报告最后一次兜底
}

/**
 * 往控件里打字（带自愈）。
 * @returns {{value:string|null, via:string}}
 */
export function typeIntoField(tab, f, text) {
  return trySteps(tab, f, [
    { via: VIA.DIRECT, run: () => tab.insertText(text) },
    { via: VIA.REFOCUS, run: async () => { await refocus(tab, f); await tab.insertText(text) } },
    { via: VIA.DOM, run: () => tab.insertTextDom(f.fid, text) },
  ])
}

/**
 * 控件内退格（带自愈）。
 * @returns {{value:string|null, via:string}}
 */
export function backspaceField(tab, f) {
  return trySteps(tab, f, [
    { via: VIA.DIRECT, run: () => tab.pressBackspace() },
    { via: VIA.REFOCUS, run: async () => { await refocus(tab, f); await tab.pressBackspace() } },
    { via: VIA.DOM, run: () => tab.backspaceDom(f.fid) },
  ])
}

/**
 * 提交（带看门狗）。
 *
 * 发一次**真实回车**（pressEnter 带 text:"\r"，会走浏览器的隐式提交与
 * 站点的 keydown / submit 处理器），之后只用地址变化做成功判据。
 *
 * 为什么不再 requestSubmit 兜底（2026-09 修订，见 tests/probe-sms.mjs）：
 *   · 隐式提交在 pressEnter 里已经发生过；站点若用 onsubmit 拦下默认行为
 *     （AJAX 登录、发验证码），地址不变是**正确行为**，真实浏览器也一样 ——
 *     再强制 requestSubmit 等于把站点的提交流程再触发一遍（重复发码/重复登录），
 *     要么被同样拦下、纯属空转；
 *   · 更糟的是老调用链在"仍未跳转"后会把输入内容当搜索词直接跳 Bing ——
 *     在登录页输完手机号按回车 → 整页跳去搜索结果，用户看到的就是
 *     「获取验证码把整个页面刷新了」。
 * 搜索框的兜底改由 run.mjs#pageSubmit 在**确认是搜索场景**后处理。
 *
 * @param {(url0:string,totalMs:number)=>Promise<string>} waitUrlChange
 * @returns {{ok:boolean, via:string, url:string, how?:string}}
 */
export async function submitField(tab, f, waitUrlChange, timeout = 1600) {
  let url0 = ""
  try { url0 = await tab.evalJs("location.href") } catch {}

  // 回车之前先把焦点修好 —— 焦点在别处时，回车会被**那个控件**消化掉
  if (!(await isFocused(tab, f))) await refocus(tab, f)

  try { await tab.pressEnter() } catch {}
  const url = await waitUrlChange(url0, timeout)
  if (url) return { ok: true, via: "enter", url }
  return { ok: false, via: "none", how: "enter-nochange", url: url0 }
}
