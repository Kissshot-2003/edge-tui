import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]

/** 同步小睡（cleanup 在 process.exit 里跑，没有 await 的机会） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {}
}

/**
 * 杀掉整个进程树。
 *
 * ⚠️ `child.kill()` 在 Windows 上只终止**直接子进程**（TerminateProcess），
 * Edge 的渲染/GPU/utility/crashpad 子进程会活下来继续往临时 profile 里写东西 ——
 * 实测：一边 rmSync 一边残留 705 个文件 / 30.8MB（比删之前还多），
 * 删除耗时 5–25 秒并且最终失败。表现就是"按 q 退出之后终端卡很久"，
 * 而且每次运行都往 temp 里漏一个几十 MB 的 profile 目录。
 * 所以必须按**进程树**杀：Windows 用 `taskkill /T /F`，类 Unix 用进程组。
 */
function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      try { process.kill(-pid, "SIGKILL") } catch { process.kill(pid, "SIGKILL") }
    }
  } catch { /* 进程可能已经没了 —— 正常 */ }
}

export function findEdge() {
  for (const p of EDGE_PATHS) if (fs.existsSync(p)) return p
  throw new Error("msedge.exe not found")
}

/**
 * 后台删除临时 profile —— **绝不阻塞主进程退出**。
 *
 * ⚠️ 为什么不用同步 rmSync：实测 Windows 上 Edge 正在优雅关闭/句柄未释放时，
 * 在退出关键路径上同步 rmSync 会**无限阻塞**（症状：--dump 出完帧进程挂死，
 * 探针实证卡在 rmSync 里 >40s）。改为 spawn 一个 detached 子进程去删，
 * 自带 20s 自杀定时器；删不掉（EBUSY 等）就留给下次启动的
 * autoPurgeStaleProfiles() 清扫（它有年龄与数量限制，就是干这个的）。
 */
export function rmProfileDetached(dir) {
  try {
    const code = `
      const fs = require("fs")
      const guard = setTimeout(() => process.exit(0), 20000)
      guard.unref()
      try { fs.rmSync(${JSON.stringify(dir)}, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) } catch (e) {}
      process.exit(0)
    `
    spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  } catch { /* spawn 失败：留给下次启动的清扫 */ }
}

class CDPConn {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.onClose = null
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)) 
        else resolve(msg.result)
      } else if (msg.method) {
        const evs = this.listeners.get(msg.method)
        if (evs) for (const fn of evs) fn(msg.params)
      }
    })
    // ── 连接断掉必须**立刻**让所有在飞的调用失败 ⚠️
    // 没有这一段的话：Edge 崩了 / 被外部杀掉之后，每个 pending 调用都要
    // 各自干等到 30 秒超时才 reject。界面上就是"点了一下，然后一动不动两分钟"。
    // 一次崩溃就能把整屏冻死，而用户看到的只是"卡住"，完全看不出原因。
    const fail = (why) => {
      if (this.closed) return
      this.closed = true
      const e = new Error(`CDP 连接已断开（${why}）`)
      for (const [, p] of this.pending) p.reject(e)
      this.pending.clear()
      try { this.onClose?.(e) } catch {}
    }
    ws.addEventListener("close", () => fail("浏览器已退出"))
    ws.addEventListener("error", () => fail("连接错误"))
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  off(method, fn) {
    const evs = this.listeners.get(method)
    if (!evs) return
    const i = evs.indexOf(fn)
    if (i >= 0) evs.splice(i, 1)
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已断开"))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        reject(e)
        return
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}（${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  }
}

export class EdgeTab {
  constructor(conn, wsUrl) {
    this.conn = conn
    this.events = []
    // ── 页面生命周期状态（每次导航重置）──
    this.navToken = 0
    this.life = { init: false, DOMContentLoaded: false, load: false }
    this.dialog = null        // 最近一次被自动关掉的 JS 弹窗（诊断用）
    this.dialogCount = 0
    conn.on("Page.lifecycleEvent", (p) => {
      // `init` = 新文档已经建立（导航已提交）。这是"我看到的是新页面"的硬证据。
      if (p.name === "init") this.life.init = true
      else if (p.name === "DOMContentLoaded") this.life.DOMContentLoaded = true
      else if (p.name === "load") this.life.load = true
    })
    // 兜底：有些情况下 lifecycle 不一定齐，传统事件也认
    conn.on("Page.frameNavigated", (p) => { if (!p?.frame?.parentId) this.life.init = true })
    conn.on("Page.domContentEventFired", () => { this.life.DOMContentLoaded = true })
    conn.on("Page.loadEventFired", () => { this.life.load = true })

    // ── 原生 JS 弹窗（alert / confirm / prompt）必须自动关掉 ⚠️ ──
    // 它们会**阻塞渲染进程**：不关掉的话 Runtime.evaluate 和
    // Page.captureScreenshot 全部不会返回，整个程序一动不动 ——
    // 这是最难排查的一类"卡住"，因为页面本身完全正常、日志里什么都没有。
    // 浏览器给用户的预期也是"弹窗要自己处理"，所以我们 accept 掉并记一笔。
    conn.on("Page.javascriptDialogOpening", (p) => {
      this.dialogCount++
      this.dialog = { type: p.type, message: String(p.message || "").slice(0, 120) }
      this.conn.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {})
    })
  }

  async enable() {
    await this.conn.send("Page.enable")
    await this.conn.send("Runtime.enable")
    // 细粒度生命周期（DOMContentLoaded / load / networkAlmostIdle …）
    // —— 这是 Playwright 判断"能开始干活了"的同一套信号。
    try { await this.conn.send("Page.setLifecycleEventsEnabled", { enabled: true }) } catch {}
  }

  /**
   * 等页面「可以看了」。**绝不无限等**。
   *
   * 为什么不能等 `load` 事件：`load` 要等**所有**子资源（广告、埋点、
   * 大图、第三方 iframe）都结束。任何一个卡住，`load` 就永远不来 ——
   * 旧实现为此等了 25 秒，之后又跑一个最多 12 秒、还要求
   * `readyState === 'complete'` 的 settle() → **单次导航最长冻 37 秒**。
   * 用户看到的就是「莫名其妙的页面加载卡住」。
   *
   * 更阴的是**阻塞解析的 `<script src>`**：请求不返回时 HTML 解析器就停在那儿，
   * DOMContentLoaded 和 `readyState !== 'loading'` **永远不会发生** ——
   * 静态页面手工测试完全复现不出来（本地脚本总是立刻返回），
   * 但线上被墙/被拦的统计脚本天天这样。所以判据里**不能**出现 readyState。
   *
   * 同类项目的做法（抄结论，不抄代码）：
   *   · Playwright/Puppeteer：默认 waitUntil:'load' 是**又慢又脆**的选项，官方文档
   *     明说重广告站点要改 'domcontentloaded'；并强调**永远不要 timeout=0**
   *     （那会把"慢加载"变成"静默死循环"）。
   *   · Browsh：`render_delay = 100ms` —— DOM 就绪后再给 100ms 落定，`timeout = 30s`
   *     是硬上限。它**不要求** load 事件。
   *   · Carbonyl：根本不"等加载" —— 连续出帧，什么时候画出来什么时候算。
   *   · w3m / lynx / elinks：纯 HTTP，收到 body 就渲染，从不等子资源。
   *
   * 所以判据是「**新文档已就位 且 内容连续两次读数不变**」：
   *   ① 内容已经丰富（文本 > 1500）→ 立刻返回
   *   ② 新文档确认 + 内容稳定两拍 → 返回（≈ Browsh 的 render_delay 之意）
   *   ③ 超时 → **返回 degraded 而不是抛错**：把已拿到的部分渲染出来，
   *      并在状态栏说明"超时，显示的是已加载部分"。
   *      宁可给半张页面，也不要给一屏冻结。
   *
   * 「新文档已就位」用三重判据，任何一条成立即可 —— 单靠事件会漏（data: URL、
   * 同文档跳转），单靠 URL 也会漏（SPA 改 URL 但不换文档）：
   *   · 导航前打下的 `data-etui-prev` 标记消失（换文档了）
   *   · 收到 lifecycle 的 `init` / `Page.frameNavigated`（主框架）
   *   · location.href 与导航前不同
   *
   * @returns {{state:'ready'|'stable'|'timeout'|'error', degraded:boolean, ms:number, textLen:number}}
   */
  async waitForReady({ timeoutMs = 12000, errorText = "", prevHref = "" } = {}) {
    const t0 = Date.now()
    // 导航本身就失败（域名解析不了 / 连接被拒 / 被 abort）→ 立刻回报，不用等
    if (errorText && !/^net::ERR_ABORTED$/.test(errorText)) {
      return { state: "error", degraded: false, ms: 0, textLen: 0, errorText }
    }
    let last = -1
    let stable = 0
    let len = 0
    let empty = 0
    // 「什么都没有」的宽限期：`<head>` 里的阻塞脚本会让解析器停住、
    // `document.body` **根本不存在** → 探测得到 0 文本 0 节点。
    // 这种页面等再久也不会变（没有"部分内容"可等），所以给它一个远小于
    // 总超时的宽限期就收手 —— 空页面就应该快速给出"空"的结论。
    const EMPTY_GRACE_MS = 4000
    // SPA 是「先渲染壳、再 hydration 注水」—— 只看读数稳定会在壳刚出现时返回，
    // 把整页内容漏掉（实测 GitHub Trending 只剩 1 行）。静态页 readyState 很快
    // 变成 complete，照常快速返回，不受这个下限拖累。
    const MIN_DWELL_MS = 1200
    while (Date.now() - t0 < timeoutMs) {
      const elapsed = Date.now() - t0
      let probe = null
      try {
        probe = await this.evalJs(`(() => ({
          ready: document.readyState,
          href: location.href,
          same: !!(document.documentElement && document.documentElement.hasAttribute('data-etui-prev')),
          text: (document.body && document.body.innerText || '').replace(/\\s+/g, '').length,
          nodes: document.querySelectorAll('a,img,input,button,h1,h2,p').length,
        }))()`)
      } catch {
        // 导航切换的瞬间 evaluate 会失败（上下文被销毁）—— 正常，重试即可
        await new Promise((r) => setTimeout(r, 80))
        continue
      }
      len = probe.text
      // 还在看旧文档 → 不能拿它的"稳定"当结论（否则会渲染上一页）
      const freshDoc = !probe.same || this.life.init || (probe.href && probe.href !== prevHref)
      // ── 最短停留时间 ⚠️ ──
      // SPA（React/Vue）是先渲染壳、再 hydration 注水的。只看「读数稳定两拍」
      // 会在壳刚出现、正文还没注水时就返回 —— 实测 GitHub Trending 只抓到
      // 1 行（Skip to content），整页内容全丢。
      // 所以要等够最短停留时间；已经 complete 的静态页不受影响（照常快速返回）。
      const dwellOk = elapsed >= MIN_DWELL_MS || probe.ready === "complete"
      if (freshDoc && dwellOk && len > 1500) {
        return { state: "ready", degraded: false, ms: elapsed, textLen: len }
      }

      const score = probe.text + probe.nodes * 4
      // 空页面的宽限：`<head>` 里的阻塞脚本会让解析器停住、`document.body`
      // **根本不存在** → 0 文本 0 节点，等再久也不会变（没有"部分内容"可等）。
      // 但如果文档已经 `complete` 且仍是空的，那就更快能下结论了 ——
      // 没有任何待办资源，不必再耗满宽限期。
      if (freshDoc && score === 0 && (probe.ready === "complete" || elapsed > EMPTY_GRACE_MS)) {
        if (++empty >= 2) return { state: "stalled", degraded: true, ms: Date.now() - t0, textLen: 0 }
      } else empty = 0

      if (freshDoc && dwellOk && score > 0 && score === last) {
        if (++stable >= 2) return { state: "stable", degraded: false, ms: Date.now() - t0, textLen: len }
      } else {
        stable = 0
      }
      last = score
      await new Promise((r) => setTimeout(r, 130))
    }
    return { state: "timeout", degraded: true, ms: Date.now() - t0, textLen: len }
  }

  /**
   * 导航。**永不抛超时错**，也不无限等。
   * @returns {{errorText:string, state:string, degraded:boolean, ms:number, textLen:number}}
   */
  async navigate(url, { timeoutMs = 12000 } = {}) {
    this.navToken++
    this.life = { init: false, DOMContentLoaded: false, load: false }
    // 给当前（旧）文档打个标记：新文档里不会有它 —— 用来确认"看到的是新页面"，
    // 避免把上一页的"内容稳定"误判成新页已就绪。
    let prevHref = ""
    try {
      prevHref = await this.evalJs("location.href")
      await this.evalJs("document.documentElement && document.documentElement.setAttribute('data-etui-prev','1')")
    } catch {}
    let res = null
    try {
      res = await this.conn.send("Page.navigate", { url })
    } catch (e) {
      return { errorText: String(e?.message || e), state: "error", degraded: false, ms: 0, textLen: 0 }
    }
    const r = await this.waitForReady({ timeoutMs, errorText: res?.errorText || "", prevHref })
    return { errorText: res?.errorText || "", ...r }
  }

  /**
   * 「落定」：等 DOM 不再变化。
   * ⚠️ 旧实现最多跑 40 轮（约 12 秒）**且要求 `readyState === 'complete'`** ——
   * 有卡住的子资源时 complete 永远不来，于是每一轮都白跑满。现在两者都收紧：
   * 只看"读数稳定"，并且有轮数上限。
   */
  async settle(maxRounds = 12, timeoutMs = 4000) {
    const t0 = Date.now()
    let prev = null
    for (let i = 0; i < maxRounds && Date.now() - t0 < timeoutMs; i++) {
      let s
      try {
        s = await this.evalJs("(document.readyState || '') + '|' + ((document.documentElement && document.documentElement.scrollHeight) || 0)")
      } catch {
        await new Promise((r) => setTimeout(r, 100))
        continue
      }
      if (s === prev) return
      prev = s
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  /**
   * 停止加载（对应浏览器的"停止"按钮）。
   * 卡在等子资源时，这是唯一能让浏览器**立刻**收手的办法 ——
   * 否则那些挂着的请求会一直拖住 load 事件与后续的一切等待。
   */
  async stopLoading() {
    try { await this.conn.send("Page.stopLoading") } catch {}
  }

  async setViewport(w, h) {
    await this.conn.send("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    })
  }

  async screenshot(captureBeyondViewport = false) {
    const { data } = await this.conn.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport,
      fromSurface: true,
    })
    return Buffer.from(data, "base64")
  }

  /**
   * 按精确像素尺寸截图。
   * 关键：先设视口，再截图，且截图后不做任何会改变布局的操作。
   * 返回 { png, width, height } —— 尺寸取自视口设置值而非 PNG 解码结果，
   * 这样网格尺寸与页面区行数严格一致，不会出现底部串位。
   */
  async screenshotExact(cssWidth, cssHeight) {
    await this.setViewport(cssWidth, cssHeight)
    // 给 Edge 一帧时间落定布局，否则截到旧尺寸
    await new Promise((r) => setTimeout(r, 120))
    const png = await this.screenshot(false)
    return { png, width: cssWidth, height: cssHeight }
  }

  /**
   * 截取页面指定区域（文档坐标，CSS 像素）。
   * 用于「文字浏览器」模式：只把媒体块（图片/二维码）区域转字符画，
   * 文字部分完全走 DOM，不经过像素。
   */
  /**
   * 截取页面的一块区域。
   * @param {number} x @param {number} y 文档坐标（page CSS px，与滚动无关）
   * @param {boolean} [fromViewport] 为 true 时 x/y 按视口坐标解释
   * @param {number} [scale] 缩放倍率，>1 时超采样，给小图做像素级分析用
   */
  async screenshotClip(x, y, w, h, opts = {}) {
    const scale = opts.scale || 1
    const { data } = await this.conn.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: { x, y, width: w, height: h, scale },
      captureBeyondViewport: true,
    })
    return Buffer.from(data, "base64")
  }

  /** 批量截取多个区域（顺序执行，避免 CDP 并发问题） */
  async screenshotClips(regions) {
    const out = []
    for (const r of regions) {
      try {
        out.push(await this.screenshotClip(r.x, r.y, r.w, r.h, { scale: r.scale }))
      } catch {
        out.push(null)
      }
    }
    return out
  }

  async evalJs(expr, returnByValue = true) {
    const { result, exceptionDetails } = await this.conn.send("Runtime.evaluate", {
      expression: expr, returnByValue, awaitPromise: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "JS error")
    return result.value
  }

  async pageInfo() {
    // ⚠️ documentElement 在**页面正在跳转**的那一瞬间是 null
    // （新文档还没建好，旧文档已经拆了）。不挡一下就是
    // "Cannot read properties of null (reading 'scrollHeight')" ——
    // 抓页正好撞上跳转时抛出，界面直接报错而不是降级。
    return this.evalJs("({u: location.href, t: document.title, sh: (document.documentElement && document.documentElement.scrollHeight) || 0})")
  }

  /**
   * 打印成 PDF（真浏览器的「打印 → 存为 PDF」）。
   * 返回 base64 的 PDF 数据。
   */
  async printToPdf({ landscape = false } = {}) {
    const { data } = await this.conn.send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      landscape,
    })
    return data
  }

  /**
   * 后退 / 前进。
   *
   * ⚠️ **CDP 里没有 `Page.goBack` / `Page.goForward` 这两个方法**。
   * 历史上这里写的就是这两个不存在的名字，于是每次调用都报
   * "'Page.goBack' wasn't found" —— 也就是说**这个功能从来没生效过**，
   * 而错误被 catch 吞进状态栏，用户只看到"按了没反应"。
   *
   * 正确做法：先取历史列表（Page.getNavigationHistory），再跳到相邻条目
   *（Page.navigateToHistoryEntry）。
   *
   * @param {number} step -1 后退 / +1 前进
   */
  async history(step) {
    const h = await this.conn.send("Page.getNavigationHistory")
    const idx = h.currentIndex + step
    if (idx < 0 || idx >= h.entries.length) {
      throw new Error(step < 0 ? "没有更早的页面了" : "没有更晚的页面了")
    }
    const entry = h.entries[idx]
    await this.conn.send("Page.navigateToHistoryEntry", { entryId: entry.id })
    await new Promise((r) => setTimeout(r, 400))
    await this.settle()
    return entry.url
  }

  /**
   * 找出页面上真正负责滚动的容器。
   * 很多站点（知乎、微博等）body 不滚动，而是把内容放在一个 overflow:auto
   * 的固定高度容器里，此时 window.scrollBy / window.scrollY 完全无效。
   * 策略：先看 window 能否滚；不能则找「内容溢出最严重」的可滚动元素。
   */
  async scrollTarget() {
    return this.evalJs(`(() => {
      window.__etuiScrollEl = null
      const doc = document.documentElement
      if (doc.scrollHeight - window.innerHeight > 8) return 'window'
      let best = null, bestOver = 8
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue
        const over = el.scrollHeight - el.clientHeight
        if (over > bestOver) { bestOver = over; best = el }
      }
      if (!best) return null
      window.__etuiScrollEl = best
      return 'el'
    })()`)
  }

  /** 读取当前滚动位置与总高度（兼容内层滚动容器） */
  async scrollState() {
    return this.evalJs(`(() => {
      const el = window.__etuiScrollEl
      if (el && el.isConnected) {
        return { y: el.scrollTop, sh: el.scrollHeight, ih: el.clientHeight,
                 iw: el.clientWidth || window.innerWidth, host: 'el',
                 cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40) }
      }
      return { y: window.scrollY, sh: (document.documentElement && document.documentElement.scrollHeight) || 0,
               ih: window.innerHeight, iw: window.innerWidth, host: 'window' }
    })()`)
  }

  /** 相对当前滚动位置滚动；自动作用于正确的滚动容器 */
  async scrollBy(px) {
    await this.evalJs(`(() => {
      const el = window.__etuiScrollEl
      if (el && el.isConnected) { el.scrollTop += ${px}; return el.scrollTop }
      window.scrollBy(0, ${px})
      return window.scrollY
    })()`)
  }

  /**
   * 把当前聚焦元素滚进视野。
   * 依次尝试最近的滚动祖先 scrollIntoView，回退到内层容器与 window。
   */
  async ensureVisible() {
    // 返回的 x/y 同样是**文档绝对坐标**（+ 滚动偏移），与 EXTRACT_BLOCKS 一致；
    // 调用方拿它去查渲染行才不会错位。
    return this.evalJs(`(() => {
      const el = document.activeElement
      if (!el) return null
      const SX = () => window.scrollX, SY = () => window.scrollY
      let p = el.parentElement
      while (p && p !== document.body) {
        const cs = getComputedStyle(p)
        if (/(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight - p.clientHeight > 8) {
          const er = el.getBoundingClientRect(), pr = p.getBoundingClientRect()
          if (er.top < pr.top || er.bottom > pr.bottom) {
            p.scrollTop += er.top - pr.top - (pr.height - er.height) / 2
          }
          const r2 = el.getBoundingClientRect()
          return { x: r2.x + SX(), y: r2.y + SY(), w: r2.width, h: r2.height, host: 'el',
                   text: (el.innerText || el.value || el.placeholder || '').slice(0, 80), tag: el.tagName }
        }
        p = p.parentElement
      }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.x + SX(), y: r.y + SY(), w: r.width, h: r.height, host: 'window',
               text: (el.innerText || el.value || el.placeholder || '').slice(0, 80), tag: el.tagName }
    })()`)
  }

  /**
   * 把指定元素滚进视野（用于元素清单模式定位）。
   * 同时做水平居中：窄视口下表单常比视口宽，只滚纵向仍会裁掉右侧。
   */
  async scrollElIntoView(idx) {
    return this.evalJs(`(() => {
      const els = window.__etuiEls
      const el = els && els[${idx}]
      if (!el || !el.isConnected) return null
      const vh = window.innerHeight, vw = window.innerWidth
      // 先纵向居中：优先用最近的滚动祖先
      let p = el.parentElement
      let handledY = false
      while (p && p !== document.body) {
        const cs = getComputedStyle(p)
        if (/(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight - p.clientHeight > 8) {
          const er = el.getBoundingClientRect(), pr = p.getBoundingClientRect()
          if (er.top < pr.top || er.bottom > pr.bottom) {
            p.scrollTop += er.top - pr.top - (pr.height - er.height) / 2
          }
          handledY = true
          break
        }
        p = p.parentElement
      }
      if (!handledY) el.scrollIntoView({ block: 'center', inline: 'center' })
      // 再横向居中：元素比视口宽时也尽量把左缘带进来
      let q = el.parentElement
      while (q && q !== document.body) {
        const cs = getComputedStyle(q)
        if (/(auto|scroll|overlay)/.test(cs.overflowX) && q.scrollWidth - q.clientWidth > 8) {
          const er = el.getBoundingClientRect(), qr = q.getBoundingClientRect()
          if (er.left < qr.left || er.right > qr.right) {
            q.scrollLeft += er.left - qr.left - (qr.width - er.width) / 2
          }
          break
        }
        q = q.parentElement
      }
      const r = el.getBoundingClientRect()
      const l = Math.max(0, r.x), t = Math.max(0, r.y)
      const rr = Math.min(vw, r.x + r.width), bb = Math.min(vh, r.y + r.height)
      // x/y/w/h 报文档绝对坐标（与 EXTRACT_BLOCKS / enumerateInteractive 一致），
      // visX/visY/visW/visH 是「元素与视口的交集」，用于判断是否真的可点。
      return { x: r.x + window.scrollX, y: r.y + window.scrollY,
               w: r.width, h: r.height,
               visX: l, visY: t, visW: Math.max(0, rr - l), visH: Math.max(0, bb - t),
               clipped: r.width > vw || r.x < 0 }
    })()`)
  }

  /**
   * 枚举页面上所有「可见且可交互」的元素，编号后供用户按键选择。
   * 这是解决「Tab 只能到达原生控件、点不到 div 按钮」的关键：
   * 站点大量用 div/span + onclick 实现交互，Tab 永远聚焦不到。
   */
  async enumerateInteractive(inVpW, inVpH) {
    // ⚠️ x/y 报出的是**文档绝对坐标**（+ 滚动偏移），与 EXTRACT_BLOCKS 同一个空间，
    // 这样 makeLineMapper 才能把元素映射到正确的渲染行。
    // 而 inVp 用的是原始视口坐标 —— 两者不能混用。
    // 早期版本这里报的是视口相对坐标，页面一滚动就和文字块对不上了。
    //
    // ⚠️⚠️ `out` 与 `window.__etuiEls` **必须严格同序同长**。
    // 早期写法是分两次查询：out 按「矩形去重」（seen）筛，而 __etuiEls 只是
    // `querySelectorAll(sel).filter(尺寸)` —— 保留全部重复项。只要页面上有
    // 一组同尺寸元素（必应导航的图标、列表项的按钮…），两个数组的下标就错开了，
    // 于是 `clickIndex(i)` 点的是**另一个元素**。
    // 症状：本地单元素页面一切正常，真实站点「点了没反应 / 点 A 开了 B」。
    // 现在一次遍历同时建两个数组，从结构上排除错位。
    //
    // ⚠️⚠️ 同源 iframe 一并递归枚举（登录组件/验证码/支付面板大量内嵌 iframe）。
    // 元素 rect 是**它所在文档视口**的坐标，必须叠加每层 iframe 的偏移
    // 才能换算到主文档坐标系；跨源 iframe 读不到 contentDocument，安全跳过。
    return this.evalJs(`(() => {
      const seen = new Set()
      const out = []
      const pool = []          // 与 out 下标一一对应的真实元素
      const SX = window.scrollX, SY = window.scrollY
      const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=tab], [role=link], [role=checkbox], [role=switch], [onclick], [tabindex]:not([tabindex="-1"]), [onmouseover], [onmouseenter]'
      // 收集 doc 内的可交互元素；ox/oy 是 doc 视口原点在**主文档视口**里的坐标
      function collect(doc, ox, oy, depth) {
        const win = doc.defaultView
        for (const e of doc.querySelectorAll(sel)) {
          const cs = win.getComputedStyle(e)
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue
          const r = e.getBoundingClientRect()
          if (r.width < 2 || r.height < 2) continue
          const mx = r.x + ox, my = r.y + oy    // 主文档视口坐标
          // 只保留最内层元素，避免父子同时入列
          const key = Math.round(mx) + ',' + Math.round(my) + ',' + Math.round(r.width) + ',' + Math.round(r.height)
          if (seen.has(key)) continue
          seen.add(key)
          const txt = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label')
            || e.getAttribute('title') || '').replace(/\\s+/g, ' ').trim()
          out.push({
            i: out.length,
            tag: e.tagName,
            type: e.type || '',
            text: txt.slice(0, 44) || '(' + e.tagName.toLowerCase() + ')',
            x: Math.round(mx + SX), y: Math.round(my + SY),
            w: Math.round(r.width), h: Math.round(r.height),
            inVp: my >= 0 && my + r.height <= ${inVpH} && mx + r.width > 0 && mx < ${inVpW},
          })
          pool.push(e)
        }
        // 同源 iframe 递归（限深 3，防病态嵌套）；跨源读 contentDocument 会抛
        if (depth < 3) {
          for (const f of doc.querySelectorAll('iframe,frame')) {
            try {
              const d = f.contentDocument
              if (!d) continue
              const fr = f.getBoundingClientRect()
              collect(d, ox + fr.x, oy + fr.y, depth + 1)
            } catch (err) { /* 跨源 iframe：忽略 */ }
          }
        }
      }
      collect(document, 0, 0, 0)
      window.__etuiEls = pool
      return out
    })()`)
  }

  /**
   * 在元素中心派发真实鼠标事件。
   * 之前用 el.click() 对知乎这类站点无效（React 合成事件 + 事件委托），
   * 必须走 Input 域注入真实的 mousePressed/mouseReleased。
   */
  async realClick(cx, cy, clicks = 1) {
    const base = { x: Math.round(cx), y: Math.round(cy), button: "left", modifiers: 0 }
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, buttons: 0 })
    // 双击 = 两组 press/release，第二组 clickCount:2 —— 与真实浏览器的连击语义一致
    // （dblclick 事件、选中文本都由 Chromium 依 clickCount 合成）。
    for (let c = 1; c <= clicks; c++) {
      await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: c, buttons: 1 })
      await new Promise((r) => setTimeout(r, 40))
      await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: c, buttons: 0 })
      if (c < clicks) await new Promise((r) => setTimeout(r, 30))
    }
  }

  /**
   * 元素清单第 idx 个元素 → **主文档视口**坐标的盒子。
   * ⚠️ el.getBoundingClientRect() 返回的是元素**所在文档**视口的坐标；
   * 元素在同源 iframe 里时必须把每一层 <iframe> 的矩形叠上去，
   * 否则坐标直接落到错误的页面位置（iframe 内点击错位/落空的根因）。
   */
  async _boxFor(idx) {
    return this.evalJs(`(() => {
      const el = window.__etuiEls && window.__etuiEls[${idx}]
      if (!el || !el.isConnected) return null
      function vpRect(e) {
        const r = e.getBoundingClientRect()
        let ox = 0, oy = 0
        let w = (e.ownerDocument && e.ownerDocument.defaultView) || null
        while (w && w.frameElement) {
          const fr = w.frameElement.getBoundingClientRect()
          ox += fr.x; oy += fr.y
          w = w.parent
        }
        return { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height }
      }
      const vw = window.innerWidth, vh = window.innerHeight
      const r = vpRect(el)
      const l = Math.max(0, r.x), t = Math.max(0, r.y)
      const rr = Math.min(vw, r.x + r.width), bb = Math.min(vh, r.y + r.height)
      const tag = el.tagName
      const text = (el.innerText || el.value || el.placeholder || '').slice(0, 44)
      if (rr <= l || bb <= t) return { cx: 0, cy: 0, offscreen: true, tag, text }
      // 交集中心；再夹到视口内并留 1px 余量，避免贴边被判定为视口外
      const cx = Math.min(vw - 1, Math.max(1, (l + rr) / 2))
      const cy = Math.min(vh - 1, Math.max(1, (t + bb) / 2))
      return { cx, cy, offscreen: false, tag, text }
    })()`)
  }

  /** 双击元素清单中的第 idx 个元素（真实鼠标事件，clickCount 语义） */
  async dblClickIndex(idx) {
    const box = await this._boxFor(idx)
    if (!box || box.offscreen) return box
    await this.realClick(box.cx, box.cy, 2)
    return box
  }

  /**
   * 把第 a 个元素**真实拖拽**到第 b 个元素的位置。
   * mousePressed → 分步 mouseMoved（带 buttons:1）→ mouseReleased：
   * 滑块验证码、拖拽排序列表都依赖中间的 mousemove 序列，
   * 一步到位的「按下即松开」会直接掉回原点。
   * 两端都必须在视口内（拖拽中途没法滚动）。
   */
  async dragEls(fromIdx, toIdx) {
    const a = await this._boxFor(fromIdx)
    const b = await this._boxFor(toIdx)
    if (!a || !b || a.offscreen || b.offscreen) return { a, b }
    // ⚠️ 拖拽前必须清空文本选区：双击（如查词/选词）会留下一个看不见的内部
    // 选区状态，随后按住拖动时 Chromium 会判定为「拖拽选中的文字」派发
    // dragstart，进入原生拖放模式 —— 后续所有 mouseMoved 被吞掉，
    // 滑块纹丝不动（症状：moves 只到 1 就停、mouseup 不触发）。 removeAllRanges 即解。
    try { await this.evalJs("(() => { const s = getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); return 0 })()") } catch {}
    const mk = (x, y, buttons) => ({ type: "mouseMoved", x, y, button: "left", buttons })
    await this.conn.send("Input.dispatchMouseEvent", mk(a.cx, a.cy, 0))
    await this.conn.send("Input.dispatchMouseEvent",
      { type: "mousePressed", x: a.cx, y: a.cy, button: "left", clickCount: 1, buttons: 1 })
    await new Promise((r) => setTimeout(r, 90))   // 滑块类控件要先「按住」一小会儿
    const steps = 14
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(a.cx + ((b.cx - a.cx) * i) / steps)
      const y = Math.round(a.cy + ((b.cy - a.cy) * i) / steps)
      await this.conn.send("Input.dispatchMouseEvent", mk(x, y, 1))
      await new Promise((r) => setTimeout(r, 24))
    }
    await new Promise((r) => setTimeout(r, 90))
    await this.conn.send("Input.dispatchMouseEvent",
      { type: "mouseReleased", x: b.cx, y: b.cy, button: "left", clickCount: 1, buttons: 0 })
    return { a, b }
  }

  /**
   * 给元素清单里的第 idx 个 <input type=file> 设置本地文件。
   * 浏览器安全模型不允许页面 JS 给文件控件赋值 —— 唯一正道是 CDP：
   * 拦截 file chooser → 点击控件 → 事件里拿 backendNodeId → DOM.setFileInputFiles。
   * 这条路径对同源 iframe 里的控件同样有效（事件自带 backendNodeId）。
   * 写入后补发 input/change —— setFileInputFiles 不保证派发，站点全靠 change 更新「已选文件」。
   */
  async uploadToIndex(idx, files) {
    const check = await this.evalJs(`(() => {
      const el = window.__etuiEls && window.__etuiEls[${idx}]
      if (!el || !el.isConnected) return { ok: false, why: 'gone' }
      if (el.tagName !== 'INPUT' || (el.type || '') !== 'file') return { ok: false, why: 'notfile' }
      return { ok: true }
    })()`)
    if (!check.ok) return check
    let chooser = null
    const onOpen = (p) => { chooser = p }
    this.conn.on("Page.fileChooserOpened", onOpen)
    try {
      await this.conn.send("Page.setInterceptFileChooserDialog", { enabled: true })
      const box = await this._boxFor(idx)
      if (!box || box.offscreen) return { ok: false, why: box ? "offscreen" : "gone" }
      await this.realClick(box.cx, box.cy)
      for (let i = 0; i < 30 && !chooser; i++) await new Promise((r) => setTimeout(r, 100))
      if (!chooser) return { ok: false, why: "nochooser" }
      await this.conn.send("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId })
      await this.evalJs(`(() => {
        const el = window.__etuiEls && window.__etuiEls[${idx}]
        if (!el) return
        try { el.dispatchEvent(new Event('input', { bubbles: true })) } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })) } catch (e) {}
      })()`)
      return { ok: true, mode: chooser.mode || "selectSingle" }
    } finally {
      try { await this.conn.send("Page.setInterceptFileChooserDialog", { enabled: false }) } catch {}
      this.conn.off("Page.fileChooserOpened", onOpen)
    }
  }

  /**
   * 点击元素清单中的第 idx 个元素（真实鼠标事件）。
   * 关键：不能直接用元素中心 —— 元素可能部分超出视口
   * （知乎登录表单宽 400+，视口只有 432，输入框中心 x=438 已在视口外），
   * 此时 elementFromPoint 返回 null，点击落空。改为取「元素与视口的交集中心」。
   */
  async clickIndex(idx, opts = {}) {
    // ── 「新标签打开」掰成「本标签打开」 ──
    // 文字浏览器只有一个 tab。点 target=_blank 的链接，Chromium 会在后台
    // 静默开一个新标签，当前页地址不变、画面不变 —— 用户看到的就是
    // 「点了没反应」。实测必应顶部导航（图片/视频/翻译…）全是 _blank，
    // 首页 34 个带 href 的链接里大半如此。
    //
    // 处理两层：锚点自身的 target 属性，和 <base target=...>（很多站点靠它
    // 全局重定向新窗口，此时锚点的 target 属性其实是空的）。
    // 只改属性不删元素，页面跳走后自然作废；即使没跳走也只是让这个链接
    // 下次仍在本标签打开 —— 对单标签浏览器来说本来就是想要的行为。
    if (opts.sameTab !== false) {
      try { await this.evalJs(this._neutralizeTarget(idx)) } catch {}
    }
    const box = await this._boxFor(idx)
    if (!box) return null
    if (box.offscreen) return box
    await this.realClick(box.cx, box.cy)
    return box
  }

  /**
   * 这个元素是个链接吗？点击后会不会**开新窗口**？它的绝对地址是什么？
   *
   * 以前只有一个 tab，所以一律把 target 改掉、把链接劫持到当前标签
   * （_neutralizeTarget）—— 那是"单标签时代"的权宜之计。
   * 现在有标签页了，真浏览器的做法是**开成新标签页**。
   *
   * 判据要覆盖两种写法：
   *   · 锚点自带 target="_blank"
   *   · 页面用 <base target="_blank"> 全局指定（此时锚点上的 target 是空的）
   *
   * url 字段**总是**给出绝对地址（只要这是个链接）——
   * 中键点 / Ctrl+点要"不管 target 是什么都开新标签页"，那时需要的是地址。
   *
   * @returns {{newWindow:boolean, url:string|null}}
   */
  async probeNewWindow(idx) {
    return this.evalJs(`(() => {
      const el = window.__etuiEls && window.__etuiEls[${idx}]
      if (!el) return { newWindow: false, url: null }
      const a = (el.tagName === 'A') ? el : (el.closest && el.closest('a'))
      if (!a) return { newWindow: false, url: null }
      const href = a.getAttribute('href')
      if (!href) return { newWindow: false, url: null }
      if (href.startsWith('#') || href.startsWith('javascript:')) return { newWindow: false, url: null }
      let abs = null
      try { abs = new URL(href, location.href).href } catch {}
      if (!abs) return { newWindow: false, url: null }
      let target = String(a.getAttribute('target') || '').trim().toLowerCase()
      if (!target) {
        const b = document.querySelector('base[target]')
        target = String((b && b.getAttribute('target')) || '').trim().toLowerCase()
      }
      const isNewWindow = target !== '' && target !== '_self'
      return { newWindow: isNewWindow, url: abs }
    })()`)
  }

  /** 把选中元素（及其 <a> / <base>）的 target 临时改成本标签 */
  _neutralizeTarget(idx) {
    return `(() => {
      const el = window.__etuiEls && window.__etuiEls[${idx}]
      if (!el) return 0
      let n = 0
      const fix = (node) => {
        if (!node || !node.hasAttribute || !node.hasAttribute('target')) return
        node.setAttribute('data-etui-target', node.getAttribute('target') || '')
        node.removeAttribute('target')
        n++
      }
      try { fix(el.closest && el.closest('a')) } catch {}
      if (el.tagName === 'A') fix(el)
      for (const b of document.querySelectorAll('base[target]')) fix(b)
      return n
    })()`
  }

  /**
   * 页面侧「展开」：把站点自己折叠起来的内容真正打开。
   *
   * 分两步，从最安全到最有副作用：
   *   ① 不需要点击的：`<details>` 直接 open、`-webkit-line-clamp` / max-height 截断
   *      直接解除。这几类占「展开全文 / 阅读全部」的大头，且没有任何副作用。
   *   ② 需要点击的：文本含「展开/更多/详情/全文…」的控件，派发**真实鼠标事件**
   *      （站点多用 div + React 合成事件，el.click() 无效，见坑 #15）。
   *
   * 防误操作（这功能会真的动页面）：
   *   · 跳过 <form> 内的控件（怕触发提交）
   *   · 跳过 type=submit 的按钮
   *   · 跳过带真实 href 的 <a>（怕跳走页面）—— 只认 href="#" / 无 href 的
   *   · 一次最多点 12 个
   *
   * @returns {{unclamped:number, clicked:number, targets:string[]}}
   */
  async expandPageControls() {
    const unclamped = await this.evalJs(`(() => {
      let n = 0
      const hits = []
      for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; n++; hits.push('DETAILS#' + (d.id || '')) }
      for (const e of document.querySelectorAll('body *')) {
        if (e.tagName === 'HTML' || e.tagName === 'BODY') continue
        const cs = getComputedStyle(e)
        const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
        const clipped = /(hidden|clip)/.test(cs.overflowY || '') &&
          e.scrollHeight > e.clientHeight + 8 && cs.maxHeight !== 'none'
        if (!clamp && !clipped) continue
        if (!clamp && e.scrollHeight <= e.clientHeight + 8) continue
        if (clamp) e.style.webkitLineClamp = 'unset'
        if (clipped) e.style.maxHeight = 'none'
        e.style.overflow = 'visible'
        n++
        if (hits.length < 8) hits.push(e.tagName + (e.id ? '#' + e.id : '') + (clamp ? ':clamp' : '') + (clipped ? ':maxh' : ''))
      }
      window.__etuiUnclamped = hits
      return n
    })()`)

    const targets = await this.evalJs(`(() => {
      const RE = /展开|更多|详情|全文|显示全部|查看全部|收起|继续阅读|点击查看|more|expand|detail|show|view|read/i
      const out = []
      const sel = 'a,button,summary,[role=button],[role=tab],[aria-expanded],[onclick],[tabindex]'
      for (const e of document.querySelectorAll(sel)) {
        if (out.length >= 12) break
        const cs = getComputedStyle(e)
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue
        const r = e.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        if (e.closest('form')) continue
        if (e.tagName === 'BUTTON' && String(e.type || '').toLowerCase() === 'submit') continue
        const href = e.getAttribute('href') || ''
        if (e.tagName === 'A' && href && !href.startsWith('#')) continue
        const aria = e.getAttribute('aria-expanded')
        const txt = (e.getAttribute('aria-label') || e.innerText || e.textContent || '')
          .replace(/\\s+/g, ' ').trim()
        const byAria = aria === 'false'
        if (!byAria && (!txt || txt.length > 24 || !RE.test(txt))) continue
        out.push(e)
      }
      window.__etuiExpand = out
      return out.map((e) => ({ tag: e.tagName, text: (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20) }))
    })()`)

    let clicked = 0
    const done = []
    for (let i = 0; i < (targets?.length || 0); i++) {
      // 每次都重新测位置：前一次点击可能让后面的元素移位
      const box = await this.evalJs(`(() => {
        const e = window.__etuiExpand && window.__etuiExpand[${i}]
        if (!e || !e.isConnected) return null
        e.scrollIntoView({ block: 'center', inline: 'nearest' })
        const r = e.getBoundingClientRect()
        const vw = window.innerWidth, vh = window.innerHeight
        const l = Math.max(0, r.x), t = Math.max(0, r.y)
        const rr = Math.min(vw, r.x + r.width), bb = Math.min(vh, r.y + r.height)
        if (rr <= l || bb <= t) return null
        return { cx: Math.min(vw - 1, Math.max(1, (l + rr) / 2)), cy: Math.min(vh - 1, Math.max(1, (t + bb) / 2)) }
      })()`)
      if (!box) continue
      try {
        await this.realClick(box.cx, box.cy)
        clicked++
        done.push(targets[i].text || targets[i].tag)
        await new Promise((r) => setTimeout(r, 140))
      } catch (e) { /* 单个控件失败不影响其余 */ }
    }
    return { unclamped, unclampedTargets: (await this.evalJs("window.__etuiUnclamped || []")) || [], clicked, targets: done }
  }

  async focusLink(dir) {
    // 与 enumerateInteractive 一致：报出**布局坐标**（抵消滚动偏移），
    // 调用方才能拿它去查渲染行。视口坐标只用于判断要不要滚。
    return this.evalJs(`(() => {
      const els = [...document.querySelectorAll('a[href], button, input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=reset]):not([type=file]), textarea, select, [tabindex]')]
        .filter(e => e.offsetParent !== null || e === document.activeElement)
      if (!els.length) return null
      const idx = els.indexOf(document.activeElement)
      const el = els[(((idx < 0 ? 0 : idx) + ${dir}) % els.length + els.length) % els.length]
      el.focus()
      const r = el.getBoundingClientRect()
      let dx = window.scrollX || 0, dy = window.scrollY || 0
      let p = el.parentElement
      while (p) {
        if (p.scrollTop) dy += p.scrollTop
        if (p.scrollLeft) dx += p.scrollLeft
        p = p.parentElement
      }
      return { x: r.x + dx, y: r.y + dy, w: r.width, h: r.height,
               text: (el.innerText || el.value || el.placeholder || '').slice(0, 80), tag: el.tagName }
    })()`)
  }

  async clickFocused() {
    // 优先派发真实鼠标事件；对纯链接可用 href 兜底
    const box = await this.evalJs(`(() => {
      const el = document.activeElement
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height,
               href: el.tagName === 'A' ? el.href : '', tag: el.tagName }
    })()`)
    if (!box) return false
    if (box.href) { await this.evalJs(`location.href = ${JSON.stringify(box.href)}`); return box.href }
    if (box.w < 2 || box.h < 2) return false
    await this.realClick(box.cx, box.cy)
    return true
  }

  // ── 表单控件：按编号定位（不依赖坐标点击）──
  //
  // 为什么不用坐标点击来聚焦：窄视口下表单常比整个视口还宽
  // （知乎手机号输入框 x=317 w=241，视口只有 432px 宽），
  // 中心点落在视口外 → elementFromPoint 返回 null → 点击落空（坑 #14）。
  // extract.js 在提取时已经把编号写进 `data-etui-field`，这里直接查就行。
  async focusField(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el || !el.isConnected) return null
      // preventScroll：聚焦不该顺带把页面滚起来 ——
      // 页面一滚，这次抓取里所有块的布局坐标就都要重算。
      try { el.focus({ preventScroll: true }) } catch (e) { el.focus() }
      const ok = document.activeElement === el
      const r = el.getBoundingClientRect()
      return {
        ok,
        tag: el.tagName,
        type: el.type || '',
        x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.getAttribute('aria-label') || el.placeholder || el.value || '').slice(0, 60),
      }
    })()`)
  }

  /**
   * 当前页面焦点元素的矩形 + 它的控件编号。
   * 报的是**布局坐标**（与 EXTRACT_BLOCKS / enumerateInteractive 一致）。
   * fid 取自 extract.js 写进 DOM 的 data-etui-field —— 有它就说明
   * 焦点落在我们提取过的表单控件上，可以精确知道"用户这会儿在打哪个框"。
   */
  async activeRect() {
    return this.evalJs(`(() => {
      const el = document.activeElement
      if (!el || el === document.body || el === document.documentElement) return null
      const r = el.getBoundingClientRect()
      let dx = window.scrollX || 0, dy = window.scrollY || 0
      let p = el.parentElement
      while (p) {
        if (p.scrollTop) dy += p.scrollTop
        if (p.scrollLeft) dx += p.scrollLeft
        p = p.parentElement
      }
      let fid = null
      try { fid = el.getAttribute && el.getAttribute('data-etui-field') } catch (e) {}
      return {
        x: Math.round(r.x + dx), y: Math.round(r.y + dy),
        w: Math.round(r.width), h: Math.round(r.height),
        fid: fid === null ? null : Number(fid),
        tag: el.tagName, type: el.type || '',
        text: (el.value || el.placeholder || el.getAttribute('aria-label') || el.innerText || '').slice(0, 60),
      }
    })()`)
  }

  /**
   * 焦点是否**真的**落在这个控件上。
   *
   * 为什么不能只看 `document.activeElement` 就下结论：CDP 的
   * `Input.insertText` / 按键派发走的是浏览器**内部记住的焦点元素**，
   * 站点把输入框节点换掉之后，那个内部目标会指向**已经脱离文档的旧节点**，
   * 于是按键全部打进虚空 —— 实测见 tests/probe-node-swap.mjs。
   * 所以这里同时要求「是文档里活着的节点」+「是当前 activeElement」。
   */
  async isFocusedField(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      return !!el && el.isConnected && document.activeElement === el
    })()`)
  }

  /** 读回某个控件当前的 value（每次按键后同步显示用，比整页重抽便宜得多） */
  async fieldValue(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el || !el.isConnected) return null
      if (el.tagName === 'SELECT') {
        const o = el.selectedOptions && el.selectedOptions[0]
        return o ? (o.textContent || '').replace(/\\s+/g, ' ').trim() : ''
      }
      // contenteditable 富文本没有 value —— 读纯文本（与站点读取语义最接近）
      if (el.isContentEditable) {
        return String(el.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000)
      }
      // ⚠️ 上限必须**远大于**任何可能被输入的内容：src/inputpath.js 用返回值
      // 做"这一键到底进没进去"的判据，截断会让比较失真（长文本追加时前 N 字符不变）。
      // 显示侧的截断交给渲染层，这里只管如实取回。
      return String(el.value || '').replace(/\\s+/g, ' ').slice(0, 2000)
    })()`)
  }

  // ── 页面 JS 输入交互（Input 域） ──
  async insertText(text) {
    await this.conn.send("Input.insertText", { text })
  }

  /**
   * DOM 级插入：`Input.insertText` 没吃进去时的兜底。
   *
   * 什么时候会走到这里：焦点其实不在控件上（用户中途点了别处）、站点把
   * 输入框换成了自绘组件、或终端送来的字被别的层拦了。CDP 的
   * `Input.insertText` 在这些情况下**静默无效** —— 不报错、值也不变，
   * 表现出来就是「打了字屏幕上没反应」。
   *
   * ⚠️ 必须用原型上的 value setter，不能直接 `el.value = x`：
   * React / Vue 会在 `value` 属性上装自己的 setter 跟踪改动，
   * 绕过它赋值会被框架判定成"值没变"，随后的重渲染把内容抹掉。
   * 这是给 React 受控组件注入值的标准姿势。
   */
  async insertTextDom(fid, text) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el) return null
      try { el.focus({ preventScroll: true }) } catch (e) { try { el.focus() } catch (e2) {} }
      // contenteditable 富文本：value setter 不存在 —— 走 Selection + execCommand，
      // 它会保留 undo 栈并自动派发 input 事件（与真实键入最接近的注入方式）。
      if (el.isContentEditable) {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
          document.execCommand('insertText', false, ${JSON.stringify(text)})
        } else {
          // 焦点不在选区内：把光标放 到内容末尾再插
          const range = document.createRange()
          range.selectNodeContents(el); range.collapse(false)
          if (sel) { sel.removeAllRanges(); sel.addRange(range) }
          document.execCommand('insertText', false, ${JSON.stringify(text)})
        }
        return String(el.innerText || '').replace(/\\s+/g, ' ')
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                               : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const v = String(el.value ?? '')
      const s = (el.selectionStart ?? v.length)
      const e = (el.selectionEnd ?? s)
      const nv = v.slice(0, s) + ${JSON.stringify(text)} + v.slice(e)
      if (setter) setter.call(el, nv); else el.value = nv
      const pos = s + ${JSON.stringify(text)}.length
      try { el.setSelectionRange(pos, pos) } catch (err) {}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return nv
    })()`)
  }

  /** DOM 级退格：同上，删掉光标前（或选区）的一个字符 */
  async backspaceDom(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el) return null
      try { el.focus({ preventScroll: true }) } catch (e) { try { el.focus() } catch (e2) {} }
      if (el.isContentEditable) {
        // execCommand('delete') 删光标前一个字符（或整个选区），带 input 事件
        document.execCommand('delete', false)
        return String(el.innerText || '').replace(/\\s+/g, ' ')
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                               : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const v = String(el.value ?? '')
      let s = (el.selectionStart ?? v.length)
      let e = (el.selectionEnd ?? s)
      let nv, pos
      if (s === e && s > 0) { nv = v.slice(0, s - 1) + v.slice(s); pos = s - 1 }
      else { nv = v.slice(0, s) + v.slice(e); pos = s }        // 有选区 → 整段删掉
      if (setter) setter.call(el, nv); else el.value = nv
      try { el.setSelectionRange(pos, pos) } catch (err) {}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return nv
    })()`)
  }

  /**
   * 显式提交表单：回车没生效时的兜底。
   *
   * 顺序是刻意的 —— `requestSubmit()` 会走完整的提交流程（触发 submit 事件、
   * 跑表单校验、执行站点的 onsubmit），最接近"用户真的按了回车"；
   * 点真实提交按钮次之；`form.submit()` 会**跳过** submit 事件与校验，
   * 所以放在最后，只在前面都无效时才用。
   */
  async submitField(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el) return 'noel'
      try { el.focus({ preventScroll: true }) } catch (e) {}
      const form = el.form || (el.closest && el.closest('form'))
      if (!form) return 'noform'
      try {
        if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'requestSubmit' }
      } catch (e) {}
      try {
        const btn = form.querySelector('button[type=submit], input[type=submit], button:not([type])')
        if (btn) { btn.click(); return 'click-button' }
      } catch (e) {}
      try { form.submit(); return 'form.submit' } catch (e) {}
      return 'failed'
    })()`)
  }

  /** 定位某个控件的提交按钮（诊断「回车为什么没提交」时用） */
  async describeField(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el) return null
      const form = el.form || (el.closest && el.closest('form'))
      return {
        focused: document.activeElement === el,
        value: String(el.value ?? '').slice(0, 80),
        inForm: !!form,
        formAction: form ? String(form.getAttribute('action') || '') : '',
        formMethod: form ? String(form.getAttribute('method') || 'get') : '',
        hasSubmit: form ? !!form.querySelector('button[type=submit], input[type=submit], button:not([type])') : false,
      }
    })()`)
  }

  /**
   * 派发一次按键。
   * ⚠️ `text` 不是可有可无的装饰 —— 它决定浏览器会不会走**默认行为**。
   * 实测（tests/probe-enter.mjs）：
   *   只发 keyDown，浏览器只产生 keydown 事件；带 text:"\r" 才会补出 keypress，
   *   而 `<form>` 的隐式提交挂在 keypress 之后的默认行为上。
   *   不带 text 的症状是「在搜索框里按回车毫无反应」—— 事件层的问题，
   *   从 DOM 侧完全看不出来。
   */
  async keyTap(key, code, vk, text = undefined, modifiers = 0) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    const down = text === undefined ? base : { ...base, text, unmodifiedText: text }
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyDown", ...down })
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  /** 修饰键位掩码（CDP 约定）：Alt=1 Ctrl=2 Meta=4 Shift=8 */
  static get MOD() { return { ALT: 1, CTRL: 2, META: 4, SHIFT: 8 } }

  async pressEnter() {
    await this.keyTap("Enter", "Enter", 13, "\r")
  }

  async pressBackspace() {
    await this.keyTap("Backspace", "Backspace", 8)
  }

  async pressTab() {
    await this.keyTap("Tab", "Tab", 9)
  }

  async pressArrow(dir, modifiers = 0) {
    const map = {
      up: ["ArrowUp", "ArrowUp", 38],
      down: ["ArrowDown", "ArrowDown", 40],
      left: ["ArrowLeft", "ArrowLeft", 37],
      right: ["ArrowRight", "ArrowRight", 39],
    }[dir]
    if (map) await this.keyTap(map[0], map[1], map[2], undefined, modifiers)
  }

  /** 输入框内的编辑键（Home/End/Delete/翻页）—— 传统浏览器里这些键直接作用于焦点控件 */
  async pressEditKey(name) {
    const map = {
      home: ["Home", "Home", 36],
      end: ["End", "End", 35],
      delete: ["Delete", "Delete", 46],
      pageup: ["PageUp", "PageUp", 33],
      pagedown: ["PageDown", "PageDown", 34],
    }[name]
    if (map) await this.keyTap(map[0], map[1], map[2])
  }

  /** 组合键（Ctrl+A / Ctrl+Z / Shift+Tab …）。mods 是 cdp.MOD 位掩码 */
  async pressCombo(keyName, mods) {
    const map = {
      a: ["a", "KeyA", 65, "\x01"],
      c: ["c", "KeyC", 67, "\x03"],
      x: ["x", "KeyX", 88, "\x18"],
      z: ["z", "KeyZ", 90, "\x1a"],
      v: ["v", "KeyV", 86, "\x16"],
      tab: ["Tab", "Tab", 9, "\t"],
    }[keyName]
    if (!map) return false
    await this.keyTap(map[0], map[1], map[2], map[3], mods)
    return true
  }

  /**
   * 悬停：把鼠标**移到**元素上但不点击。
   * 真实浏览器里大量菜单/下拉/提示是 hover 展开的 —— 只有 mouseMoved、
   * 没有 pressed，站点的 mouseenter/mouseover 才会触发而不会误触点击。
   * 返回元素盒（与 clickIndex 同款交集中心算法，元素跑出视口也能 hover）。
   */
  async hoverEl(idx) {
    const box = await this.evalJs(`(() => {
      const el = window.__etuiEls && window.__etuiEls[${idx}]
      if (!el || !el.isConnected) return null
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth, vh = window.innerHeight
      const l = Math.max(0, r.x), t = Math.max(0, r.y)
      const rr = Math.min(vw, r.x + r.width), bb = Math.min(vh, r.y + r.height)
      if (rr <= l || bb <= t) return { offscreen: true, text: (el.innerText || '').slice(0, 40) }
      const cx = Math.min(vw - 1, Math.max(1, (l + rr) / 2))
      const cy = Math.min(vh - 1, Math.max(1, (t + bb) / 2))
      return { cx, cy, offscreen: false, text: (el.innerText || '').slice(0, 40) }
    })()`)
    if (!box || box.offscreen) return box
    await this.conn.send("Input.dispatchMouseEvent",
      { type: "mouseMoved", x: Math.round(box.cx), y: Math.round(box.cy), button: "none", buttons: 0, modifiers: 0 })
    return box
  }

  /**
   * 原生 <select> 换选项：selectedIndex 平移 delta，发 input+change。
   * change 必须发 —— 站点几乎都在 change 上响应选择（input 反而少用）。
   * 返回新选中文本；到底/到头返回 null 并不动。
   */
  async selectStep(fid, delta) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el || el.tagName !== 'SELECT' || !el.isConnected) return null
      const i = el.selectedIndex + (${delta})
      if (i < 0 || i >= el.options.length) return null
      el.selectedIndex = i
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      const o = el.selectedOptions && el.selectedOptions[0]
      return o ? (o.textContent || '').replace(/\\s+/g, ' ').trim() : ''
    })()`)
  }

  /**
   * 对控件发 change 事件 —— 对齐真实浏览器的「失焦时发 change」语义。
   * 站点大量校验挂在 change 上（手机号格式、联动下拉），只发 input 的话
   * 用户输完退出输入模式，站点毫无反应。
   * 只发 change 不动焦点：发 blur 会把站点自己的焦点逻辑搅乱。
   */
  async fireChange(fid) {
    return this.evalJs(`(() => {
      const el = (function find(d){ try { var e = d.querySelector('[data-etui-field="${fid}"]'); if (e) return e } catch (x) {} for (var k = 0; k < d.frames.length; k++) { try { var c = d.frames[k].document; if (c && c !== d) { var r = find(c); if (r) return r } } catch (x) {} } return null })(document)
      if (!el || !el.isConnected) return false
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  async focusedTag() {
    return this.evalJs(`document.activeElement?.tagName || ""`)
  }

  close() {
    this.conn.ws.close()
  }

  /**
   * 优雅关闭浏览器（Browser.close）。
   * 为什么必须有：退出时如果直接 TerminateProcess 杀树，**内存里的 Cookie
   * 数据库来不及刷盘** —— 用户登录的会话就丢了（localStorage 有写前日志不受影响，
   * 所以症状是"localStorage 还在但全部网站都要重新登录"）。
   * Browser.close 让 Edge 走正常关闭流程，Cookie 才会写进磁盘。
   */
  async browserClose() {
    return this.conn.send("Browser.close", {})
  }
}

/**
 * 启动 Edge。
 *
 * profileDir 不传（默认）→ 一次性临时 profile，退出即删 —— 测试与探针用这个。
 * 传入 profileDir → **持久 profile**：Cookies/LocalStorage/登录会话都留在里面，
 * 下次启动还在 —— 这是「像常见浏览器」的第一块拼图（否则每个网站每次都要重新登录）。
 * 持久模式下退出只杀进程树，**绝不删目录**。
 */
export async function launchEdge({ width = 1280, height = 900, profileDir = null, userAgent = null, downloadPath = null } = {}) {
  const exe = findEdge()
  // 是否临时 profile：决定退出时要不要删目录。持久 profile 删掉就是让用户重新登录。
  const tempProfile = !profileDir
  if (!profileDir) profileDir = path.join(os.tmpdir(), "edge-tui-" + crypto.randomBytes(4).toString("hex"))
  fs.mkdirSync(profileDir, { recursive: true })

  let child = null
  let cleaned = false
  // 无论正常退出、异常退出还是 Ctrl+C，都要回收 Edge 进程与临时 profile
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    const t0 = Date.now()
    const pid = child?.pid
    try { child?.kill() } catch {}
    // ⚠️ 必须杀**整棵树**，否则 Edge 的子进程会活下来继续往 profile 里写，
    // 删除必然失败并且很慢（见 killTree 的注释）。
    killTree(pid)
    const tKill = Date.now() - t0
    // 进程被终止 ≠ 文件句柄立刻回收，给系统一点时间（同步小睡）
    sleepSync(260)
    // 持久 profile（登录态保留）只杀进程、绝不删目录 —— 删了等于让用户重新登录。
    // 临时 profile 走 detached 后台删除：同步 rmSync 在退出关键路径上会被
    // 未释放的句柄无限阻塞（实测 --dump 挂死 40s+，见 rmProfileDetached 注释）；
    // 删不掉的留给下次启动的 autoPurgeStaleProfiles()。
    if (tempProfile) rmProfileDetached(profileDir)
    if (process.env.EDGE_TUI_DEBUG) {
      console.error(`[debug:cleanup] kill=${tKill}ms rm=detached${tempProfile ? "" : "（持久 profile 不删）"}`)
    }
  }
  process.once("exit", cleanup)
  process.once("SIGINT", () => { cleanup(); process.exit(130) })
  process.once("SIGTERM", () => { cleanup(); process.exit(143) })

  child = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--disable-features=Translate",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    // 伪装 UA：headless 下部分站点会主动降级（必应返回精简版首页）。
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    "about:blank",
  ], { stdio: "ignore", windowsHide: true })

  let port
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const f = path.join(profileDir, "DevToolsActivePort")
    if (!fs.existsSync(f)) continue
    // Edge 刚创建该文件时可能仍被持有写锁（Windows EBUSY），需重试读取
    try {
      const txt = fs.readFileSync(f, "utf8").trim()
      const first = txt.split(/\r?\n/)[0]
      if (!first) continue
      // ⚠️ 持久 profile 里这个文件是**上一次会话**留下的：新实例可能还没把它
      // 覆写成新端口，直接采信就会对着已死的旧端口轮询到最后（"no page target"）。
      // 所以端口必须 HTTP 实测可用才算数 —— 测不通就继续等新实例覆写。
      try {
        const v = await fetch(`http://127.0.0.1:${first}/json/version`, { signal: AbortSignal.timeout(600) })
        if (v.ok) { port = first; break }
      } catch {}
    } catch (e) {
      if (e.code !== "EBUSY" && e.code !== "EPERM" && e.code !== "EACCES") throw e
    }
  }
  if (!port) {
    cleanup()
    // 持久 profile 下最常见的失败原因：另一个实例正占着同一个 profile
    // （Chromium 的 user-data-dir 同时只能被一个进程使用）。
    throw new Error(tempProfile
      ? "Edge DevToolsActivePort timeout"
      : "Edge DevToolsActivePort timeout —— 若已有一个 edge-tui 实例在运行请先退出，或用 --fresh 临时开一个")
  }

  // 找 page 类型 target 的 ws
  let wsUrl, targetId
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const tabs = await res.json()
      const page = tabs.find((t) => t.type === "page")
      if (page) { wsUrl = page.webSocketDebuggerUrl; targetId = page.id; break }
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!wsUrl) throw new Error("no page target")

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
  })
  const conn = new CDPConn(ws)

  const tab = new EdgeTab(conn, wsUrl)
  await tab.enable()
  await tab.setViewport(width, height)

  // ── 浏览器级连接（多标签页：创建 / 关闭 target 都要走它）──
  // `/json/version` 给的 webSocketDebuggerUrl 是 browser target，只有它能
  // `Target.createTarget` / `Target.closeTarget`。页面级 ws 做不到。
  let bconn = null
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`)
    const vj = await v.json()
    const bwsUrl = vj.webSocketDebuggerUrl
    if (bwsUrl) {
      const bws = new WebSocket(bwsUrl)
      await new Promise((resolve, reject) => {
        bws.addEventListener("open", resolve)
        bws.addEventListener("error", reject)
      })
      bconn = new CDPConn(bws)
    }
  } catch { bconn = null }

  // ── 接管一个已经存在的页面 target ──
  // 自己开的标签页、以及站点自己开出来的窗口（target=_blank / window.open）
  // 都走这一条：拿到 targetId → 找到它的调试地址 → 建一条独立的 CDP 连接。
  const attachTarget = async (tid) => {
    let u = null
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`)
        const arr = await r.json()
        const p = arr.find((t) => t.id === tid)
        if (p?.webSocketDebuggerUrl) { u = p.webSocketDebuggerUrl; break }
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!u) throw new Error("接管标签页失败：拿不到页面调试地址")
    const ws2 = new WebSocket(u)
    await new Promise((resolve, reject) => {
      ws2.addEventListener("open", resolve)
      ws2.addEventListener("error", reject)
    })
    const conn2 = new CDPConn(ws2)
    const t = new EdgeTab(conn2, u)
    await t.enable()
    await t.setViewport(width, height)
    return { tab: t, targetId: tid, conn: conn2 }
  }

  /** 新开一个页面 target，返回它自己的 EdgeTab（已 enable + 设好视口） */
  const newPage = async () => {
    if (!bconn) throw new Error("浏览器级连接不可用，无法新建标签页")
    const { targetId: tid } = await bconn.send("Target.createTarget", { url: "about:blank" })
    try {
      return await attachTarget(tid)
    } catch (e) {
      try { await bconn.send("Target.closeTarget", { targetId: tid }) } catch {}
      throw e
    }
  }

  /** 关闭一个页面 target */
  const closePage = async (tid) => {
    if (!bconn || !tid) return
    try { await bconn.send("Target.closeTarget", { targetId: tid }) } catch {}
  }

  // ── 目标发现：站点自己开出来的窗口 ──
  //
  // ── 下载 ──
  //
  // headless Chrome 默认**取消**下载：不设这个，点下载链接什么都不会发生
  // （真浏览器里这是最基础的能力之一）。
  //
  // ⚠️ 用的是 **Browser** 域的 setDownloadBehavior —— `Page.setDownloadBehavior`
  // **不存在**（和当初那个不存在的 `Page.goBack` 一个路数：名字看着很像，
  // 报出来是 "'Page.setDownloadBehavior' wasn't found"）。
  //
  // 配套的 Browser.downloadWillBegin / Browser.downloadProgress 事件能给出
  // 文件名和进度，交给上层报给用户。
  const downloadHooks = []
  if (bconn && downloadPath) {
    try {
      fs.mkdirSync(downloadPath, { recursive: true })
      await bconn.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath,
        eventsEnabled: true,
      })
    } catch { /* 没开成也不算致命：只是下载不了 */ }
    bconn.on("Browser.downloadWillBegin", (p) => {
      for (const fn of downloadHooks) { try { fn({ phase: "willBegin", ...p }) } catch {} }
    })
    bconn.on("Browser.downloadProgress", (p) => {
      for (const fn of downloadHooks) { try { fn({ phase: "progress", ...p }) } catch {} }
    })
  }

  // ── 目标发现：新开的页面（target=_blank / window.open）──
  //
  // 真浏览器里，点 target=_blank 的链接、或者页面调 window.open()，
  // 都会**开一个新标签页**。以前只有一个 tab，只能把这些链接劫持到当前标签
  // （_neutralizeTarget）—— 那时候是没办法，现在有了标签页就不该再劫持。
  //
  // 怎么把「站点开的窗口」和「我们自己开的标签页」区分开？靠两个判据：
  //   · 自己用 Target.createTarget 开的，**没有 openerId**（它不是从某个页面开出来的）
  //   · 站点用 rel=noopener 开的，也没有 openerId，但**自带 http(s) 地址**
  // 所以规则是：有 openerId 就收编；没有 openerId 就看地址是不是 http(s)。
  // 顺带排除 Edge 自己的内部页（edge://…、chrome://…）和扩展后台页。
  const newTargetHooks = []
  if (bconn) {
    try { await bconn.send("Target.setDiscoverTargets", { discover: true }) } catch {}
    bconn.on("Target.targetCreated", (p) => {
      const ti = p?.targetInfo
      if (!ti || ti.type !== "page") return
      const url = String(ti.url || "")
      const isOurs = url === "about:blank" && !ti.openerId
      if (isOurs) return
      const isSiteWindow = !!ti.openerId || /^https?:/i.test(url)
      if (!isSiteWindow) return
      for (const fn of newTargetHooks) { try { fn(ti) } catch {} }
    })
  }

  const quit = () => {
    // 先优雅关闭（Browser.close）：Cookie 等内存态要靠正常关闭流程才落盘，
    // 直接杀树会丢登录态（localStorage 不受影响，症状极具迷惑性）。
    // ⚠️ 优先用**浏览器级**连接：首个标签页可能已经被用户关掉了，
    // 那时 tab 的连接已经断了，靠它发 Browser.close 是发不出去的。
    try {
      if (bconn) bconn.send("Browser.close").catch(() => {})
      else tab.browserClose().catch(() => {})
    } catch {}
    // 给 Browser.close 最多 ~3s 的落盘宽限。⚠️ 忙等（sleepSync）期间事件循环
    // 不转，child.exitCode 永远读不到更新 —— 这个循环**不是**「等它退出」，
    // 而是固定 3s 宽限；真正的收割靠下面 cleanup 的 killTree。
    for (let i = 0; i < 20; i++) sleepSync(150)
    try { tab.close() } catch {}
    cleanup()
  }
  return {
    tab, targetId, port, profileDir, quit, newPage, closePage, attachTarget,
    // 注册"站点自己开出了窗口"的回调（window.open 等）
    onNewTarget: (fn) => { newTargetHooks.push(fn) },
    // 注册下载进度回调
    onDownload: (fn) => { downloadHooks.push(fn) },
  }
}
