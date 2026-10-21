#!/usr/bin/env node
// edge-tui —— Edge 内核驱动的终端浏览器
//
// 界面参考 CodeWhale TUI：深蓝底 + 橙红圆角输入框 + 底部状态行。
// 渲染管线：Edge headless → CDP 截图 → 字符网格 → 自绘 ANSI（行级 diff）

import { launchEdge } from "./src/cdp.js"
import { pngToGrid } from "./src/ascii.js"
import { buildTextPage, renderTextPage, applyFoldState, renderedRowCount, overlayRuns, makeLineMapper, fieldDisplayName, fieldKindName, fieldRowInPage } from "./src/textbrowser.js"
import { createTerm, C, strWidth, truncateByWidth, truncateLeft } from "./src/term.js"
import { MOUSE_ON, MOUSE_OFF, classifyMouse, hitTestRows, buildClickIndex, rowCandidates, matchElement } from "./src/mouse.js"
import { createKeyDecoder, BRACKET_PASTE_ON, BRACKET_PASTE_OFF } from "./src/keys.js"
import { typeIntoField as typeIntoFieldRaw, backspaceField as backspaceFieldRaw, submitField, VIA } from "./src/inputpath.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

// ── 网格单元尺寸 ──
// 终端字符宽高比通常约 1:2，4x8 能出较方正的图像。
// 仅「图片模式」(--image) 用；文字模式不经过像素网格。
const CELL_W = 4
const CELL_H = 8
const PAGE_BG = [11, 23, 38]   // 与 C.bg 一致，用于半透明混合
// 对比度 > 1 拉开墨量差距，让小字号文字在字符画里更清楚
const CONTRAST = Number(process.env.EDGE_TUI_CONTRAST) || 1.35

// ── 渲染模式 ──
//   text  真·文字浏览器（默认）：DOM 提取文字 → 终端原生字符排版；
//         图片/二维码单独裁剪 → 小尺寸字符画
//   image 旧的整页截图降采样方案（保留作为对照，--image 切换）
//
// 为什么要默认 text：4×8 的像素格装不下 14px 的表单文字，
// 整页降采样会把「文字和二维码一起变成噪声」。
const RENDER_MODE = process.argv.includes("--image") ? "image" : "text"
let renderMode = RENDER_MODE

// ── 日志 ──
const LOG_PATH = path.join(import.meta.dirname, "crash.log")
const logErr = (...a) => {
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + a.join(" ") + "\n") } catch {}
}

const urlArg = process.argv.slice(2).find((a) => !a.startsWith("--")) || "https://cn.bing.com"
const dumpMode = process.argv.includes("--dump")
const cleanMode = process.argv.includes("--clean")
const debugMode = !!process.env.EDGE_TUI_DEBUG

// --user-agent=XXX：伪装 UA。
//
// **默认就伪装**：headless 下部分站点会主动降级 —— 必应返回的是精简版首页
// （无导航、无背景图），实测正文只剩 21 个字，等于半个浏览器。
// 真正的浏览器发的是普通 UA，headless 才是那个异常。
// `--raw-ua` 可以关掉伪装（排查站点行为差异时用）。
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0"
const userAgentArg = process.argv.includes("--raw-ua")
  ? null
  : ((process.argv.find((a) => a.startsWith("--user-agent=")) || "").slice("--user-agent=".length) || DEFAULT_UA)

// ── 数据目录与持久化 ──
// 默认持久 profile（登录态跨会话保留，像常见浏览器一样）；
// --fresh 本次用一次性 profile（旧行为）；--reset-profile 清空持久 profile 后再启动。
// 书签/历史也存在这里，独立于 profile（清 profile 不丢书签）。
const DATA_DIR = process.env.EDGE_TUI_DATA
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "edge-tui")
const PROFILE_DIR = path.join(DATA_DIR, "profile")
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads")   // 下载目录（真浏览器也有这回事）
const freshMode = process.argv.includes("--fresh")
const resetProfileMode = process.argv.includes("--reset-profile")

// ── 清理历史遗留的临时 profile ──
// Edge headless 的 user-data-dir 会残留；正常退出由 cdp.js 的 cleanup 回收，
// 但强杀进程时仍会遗留，这里提供一次性清扫入口。
function purgeStaleProfiles() {
  const tmp = os.tmpdir()
  let n = 0, freed = 0
  try {
    for (const d of fs.readdirSync(tmp)) {
      if (!d.startsWith("edge-tui-")) continue
      const p = path.join(tmp, d)
      try {
        const size = dirSize(p)
        fs.rmSync(p, { recursive: true, force: true })
        freed += size; n++
      } catch {}
    }
  } catch {}
  return { n, freed }
}

function dirSize(dir) {
  let s = 0
  const walk = (x) => {
    let entries
    try { entries = fs.readdirSync(x, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const f = path.join(x, e.name)
      try {
        if (e.isDirectory()) walk(f)
        else s += fs.statSync(f).size
      } catch {}
    }
  }
  walk(dir)
  return s
}

/**
 * 启动时顺手清扫**上一次崩溃/强杀**留下的临时 profile。
 *
 * 为什么需要：正常退出时 cdp.js 会删掉自己的 profile，但进程被强杀
 * （任务管理器、终端被关、Ctrl+Break）时来不及删。不清理的话 temp 里会
 * 越积越多（实测积到过 368MB），而且每个都是几十 MB 的 Edge 缓存。
 *
 * 两条安全约束：
 *   · 只删**超过 15 分钟没被动过**的 —— 同时跑着另一个实例时不会误删它；
 *   · 一次最多删 5 个 —— 别让启动被一堆残留拖慢。
 */
function autoPurgeStaleProfiles(maxAgeMs = 15 * 60 * 1000, limit = 5) {
  let n = 0
  try {
    const tmp = os.tmpdir()
    const now = Date.now()
    for (const d of fs.readdirSync(tmp)) {
      if (n >= limit) break
      if (!d.startsWith("edge-tui-")) continue
      const p = path.join(tmp, d)
      try {
        if (now - fs.statSync(p).mtimeMs < maxAgeMs) continue
        fs.rmSync(p, { recursive: true, force: true })
        n++
      } catch {}
    }
  } catch {}
  if (n) logErr(`[cleanup] 启动时清扫了 ${n} 个上次残留的 profile 目录`)
  return n
}

// ── 书签 / 历史的持久化存储 ──
// 存在 DATA_DIR 下、独立于 profile：清 profile（重新登录）不会丢书签历史。
// 写盘用同步 + try/catch：存不了也不能把浏览搞挂，顶多这次不记住。
function loadJsonList(file) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
function saveJsonList(file, arr) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(arr, null, 1))
  } catch (e) { logErr(`[store] 写 ${file} 失败:`, e?.message || e) }
}
let bookmarks = loadJsonList("bookmarks.json")
let history = loadJsonList("history.json")

/** 记录一条历史：连续同一地址只刷新时间/标题（capture 每次渲染都会跑，必须去抖） */
function recordHistory(url, ttl) {
  if (!url || /^chrome-error:|^about:blank|^data:/.test(url)) return
  const last = history[0]
  if (last && last.u === url) {
    last.t = ttl || last.t
    last.ts = Date.now()
    return
  }
  history.unshift({ u: url, t: String(ttl || url).slice(0, 120), ts: Date.now() })
  if (history.length > 1000) history.length = 1000
  saveJsonList("history.json", history)
}

/** 收藏当前页（按地址去重；重复收藏 = 提示已存在） */
function addBookmark() {
  if (navFailed || !curUrl || /^chrome-error:/.test(curUrl)) {
    statusKind = "err"
    status = "当前页面加载失败，没有可收藏的地址"
    return paint()
  }
  if (bookmarks.some((b) => b.u === curUrl)) {
    statusKind = "info"
    status = "这个地址已在书签里 · /bm 查看"
    return paint()
  }
  bookmarks.unshift({ u: curUrl, t: String(title || curUrl).slice(0, 120), ts: Date.now() })
  saveJsonList("bookmarks.json", bookmarks)
  statusKind = "ok"
  status = "已收藏 · /bm 查看"
  paint()
}

/** 列表模式下删除当前选中项（书签/历史都支持） */
function listDelete() {
  const items = listKind === "bm" ? bookmarks : history
  if (!items.length || listSel >= items.length) return
  const [gone] = items.splice(listSel, 1)
  if (listSel >= items.length) listSel = Math.max(0, items.length - 1)
  saveJsonList(listKind === "bm" ? "bookmarks.json" : "history.json", items)
  statusKind = "ok"
  status = `已删除：${String(gone?.t || gone?.u || "").slice(0, 40)}`
  paint()
}

/** 列表模式下移动选中项 */
function listMove(dir) {
  const items = listKind === "bm" ? bookmarks : history
  if (!items.length) return
  listSel = Math.max(0, Math.min(items.length - 1, listSel + dir))
  const it = items[listSel]
  statusKind = "ok"
  status = `[${listSel + 1}/${items.length}] ${String(it.t || it.u).slice(0, 46)}`
  paint()
}

// ── 全局状态 ──
let term = null
let edge = null
let tab = null
let shuttingDown = false

let grid = null            // 图片模式的当前字符网格
let textPage = null        // 文字模式的排版结果（buildTextPage 的返回）
let textRows = null        // 文字模式的渲染行（renderTextPage 的返回）
let mapLine = null         // 文档 y → 渲染行 的映射（给叠加层用）
let curUrl = ""
let title = ""
let scrollPos = "top"      // top | middle | bottom
let scrollHost = "window"  // window | el —— 谁在滚
let scrollYPx = 0          // 当前滚动位置（文档像素），文字模式按像素滚动
let viewH = 600            // 视口 CSS 高度
let viewW = 900            // 视口 CSS 宽度
let mode = "normal"        // normal | goto | cmd | pageinput | pick | find | list
let inputValue = ""
let inputSelectAll = false   // 地址栏「全选待替换」：打完第一个字就覆盖整个网址
let status = "正在启动 Edge…"
let statusKind = "info"    // info | ok | err | busy
let focusInfo = null
let pageEls = []           // 当前页可交互元素清单
let pickInfo = null        // 元素清单模式的当前选中项
let dragFrom = null        // 拖拽的起点元素（g 两次按下之间的记忆）
let textRowOffset = 0      // 文字模式：页面区从排版结果的第几行开始显示
let textTotalRows = 0      // 文字模式：排版结果总行数（决定最大滚动偏移）
let foldOpen = new Set()   // 已展开的折叠内容 id（e 切换；换页/刷新时清空）
let activeField = null     // 正在输入的页面控件块（i 进入输入模式时确定）
// 输入模式的「本地回显」：页面控件的当前值。
// 为什么必须有：底部输入框原来在 pageinput 模式下永远只显示占位提示，
// 用户打完字在**最该出现文字的地方**什么也看不到（尤其控件行被滚出屏幕时），
// 会直接判定成"输入法坏了"。这里把它镜像到输入框里，输入永远可见。
let pageEcho = ""
let inputPending = false   // enterPageInput 正在异步解析焦点
let pendingKeys = []       // 解析焦点期间用户已经打进来的键（解析完按序补送）
let lastEscapeTimer = null
let keyLog = null          // EDGE_TUI_KEYS=1 时的按键日志句柄（排查 IME/终端差异）
let pasteOn = false        // 是否已开启括号粘贴上报
let startupNote = ""       // 启动环境提示（用户第一次按键后消失）
let mediaNote = ""         // 上次抓图预算的结论（跳过了几张图）—— 状态栏要如实说

// ── 页内查找（/ 进入，n/N 跳转）──
let findQuery = ""         // 当前查找词
let findHits = []          // 命中的**渲染行**绝对行号（textRowOffset 是相对它的偏移）
let findCur = -1           // 当前停在哪个命中（findHits 下标）
const FIND_BG = [84, 62, 26]       // 普通命中：暗金铺底
const FIND_BG_CUR = [188, 142, 38] // 当前命中：亮金铺底

// ── 书签 / 历史（列表视图：/bm /his，B 收藏）──
let listKind = null        // "bm" | "his"（mode==="list" 时的列表类型）
let listSel = 0

// ── 加载预算与中断 ──
//
// 用户反馈「总是会有莫名其妙的页面加载卡住」。根因是**任何一步都可能无限等**：
//   ① 旧 cdp.navigate 等 Page.loadEventFired 最多 25s（广告/埋点卡住就等满）
//   ② 之后的 settle() 又要求 readyState==='complete'，最多再 12s
//   ③ 抓图是串行 CDP 往返，图多的页面几十秒没动静
//   ④ alert()/confirm() 会**阻塞渲染进程**，不处理就永久冻死
// 现在每一步都有上限，超限就**降级渲染 + 说明原因**，而不是冻着不动。
const NAV_TIMEOUT_MS = Number(process.env.EDGE_TUI_NAV_TIMEOUT) || 12000
const MEDIA_MAX_SHOTS = Number(process.env.EDGE_TUI_MAX_SHOTS) || 24
const CAPTURE_BUDGET_MS = Number(process.env.EDGE_TUI_CAPTURE_BUDGET) || 20000
let captureDeadline = 0    // 本次 capture 的绝对截止时刻（毫秒）
let captureAborted = false // 用户按 Esc 中断本次 capture
let captureTimedOut = false
let navState = null        // 最近一次导航的结果（超时/错误要如实报给用户）
let captureTimer = null
let navFailed = null       // Chrome 的内部错误页（chrome-error://）→ 加载失败要明说
let requestedUrl = ""      // 用户/程序想要打开的地址（错误页时地址栏仍显示它）
let lastGoodUrl = ""       // 最近一次成功加载的地址
let captureError = null    // 上次抓页失败的原文 —— 有值时页面区显示错误而不是旧内容
let fieldSyncTimer = null
let busy = false
let pendingPaint = false
let prevScreen = null
let progressTimer = null
let progress = null        // { label, pct }
let lastVp = null          // 上次视口 "WxH"，避免重复 setViewport
let shotDebounce = null
let spinIdx = 0
let renderSeq = 0          // 渲染序号，防止过期的异步渲染覆盖新画面
let clickIndex = null      // 当前屏「渲染行 → 来源块」的索引（鼠标命中用）
let elsCache = null        // 缓存的元素清单（鼠标点击要拿编号做真实点击）
let elsCacheKey = null     // 缓存对应的页面标记；换页/展开折叠后失效
let mouseOn = !process.argv.includes("--no-mouse")   // --no-mouse：交给终端做文本选择

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// ── 多标签页 ──
//
// 交互模型参考 **OpenCode V2 TUI** 的标签栏：横向条、每个标签带编号、
// Ctrl+数字 直跳、Ctrl+Tab 轮换、Ctrl+W 关闭、Ctrl+Shift+T 重开。
//
// 实现方式：**保存/恢复快照**，而不是把几十个全局变量塞进一个 per-tab 对象。
// 这些变量散落在整个文件里（渲染、输入、查找、滚动、元素清单…），
// 改成参数传递等于一次大范围重写，风险远大于收益。
// 切标签时把当前全局存进快照，切回来时再写回 —— 现有逻辑一行都不用动。
const tabStates = []        // 每个标签页的完整状态快照
const tabMeta = []          // 显示用元信息（标题/地址），实时更新，标签栏要用
let activeTab = 0           // 当前标签页下标
let currentTargetId = null  // 当前标签页在 CDP 里的 targetId（关页面时要用）
const closedTabs = []       // 最近关闭的标签页（Ctrl+Shift+T 重开）
const TAB_LIMIT = 12        // 标签页上限：每个标签页是一个真实的 Chromium 页面

// 每个 URL 记住一次滚动位置（文字模式下的排版行号）。
//
// 为什么浏览器自己那套不够：浏览器会恢复**页面**的滚动位置，但文字模式是
// 「整页排好版、挪行窗口」——用户看到的位置是**排版行号**，浏览器管不着。
// 不自己记的话，「后退」回到上一页会直接跳回顶部，长页面上尤其明显。
const scrollMemo = new Map()   // url → textRowOffset

/** 记住当前页面的滚动位置（离开之前调用） */
function rememberScroll() {
  if (curUrl) scrollMemo.set(curUrl, textRowOffset)
}

/** 回到某个页面后恢复它的滚动位置 */
function restoreScroll(url) {
  const off = url ? scrollMemo.get(url) : null
  if (off == null) return
  const maxOff = Math.max(0, textTotalRows - PAGE_ROWS())
  textRowOffset = Math.max(0, Math.min(maxOff, off))
  rerenderText()
}

/** 把当前全局状态打包成某个标签页的快照 */
function snapshotTabState() {
  return {
    tab, targetId: currentTargetId,
    grid, textPage, textRows, mapLine,
    curUrl, title,
    scrollPos, scrollHost, scrollYPx,
    renderMode, textRowOffset, textTotalRows,
    foldOpen: [...foldOpen],
    pageEls,
    findQuery, findHits: [...findHits], findCur,
    navState, navFailed, requestedUrl, lastGoodUrl, captureError,
    status, statusKind, mediaNote,
    lastVp, elsCache, elsCacheKey, clickIndex,
  }
}

/** 把快照写回全局（= 切到某个标签页） */
function restoreTabState(s) {
  tab = s.tab
  currentTargetId = s.targetId
  grid = s.grid; textPage = s.textPage; textRows = s.textRows; mapLine = s.mapLine
  curUrl = s.curUrl; title = s.title
  scrollPos = s.scrollPos; scrollHost = s.scrollHost; scrollYPx = s.scrollYPx
  renderMode = s.renderMode; textRowOffset = s.textRowOffset; textTotalRows = s.textTotalRows
  foldOpen = new Set(s.foldOpen)
  pageEls = s.pageEls
  findQuery = s.findQuery; findHits = [...s.findHits]; findCur = s.findCur
  navState = s.navState; navFailed = s.navFailed
  requestedUrl = s.requestedUrl; lastGoodUrl = s.lastGoodUrl; captureError = s.captureError
  status = s.status; statusKind = s.statusKind; mediaNote = s.mediaNote
  lastVp = s.lastVp; elsCache = s.elsCache; elsCacheKey = s.elsCacheKey; clickIndex = s.clickIndex
  // 交互态是**瞬时**的：切标签就退出输入/选择/查找，不跨标签继承
  // （否则切回来会发现"我还在往上一个页面里打字"）。
  mode = "normal"; inputValue = ""; pageEcho = ""
  activeField = null; pickInfo = null; dragFrom = null
  pendingKeys = []; inputPending = false; helpVisible = false
  // 切标签会**作废正在跑的抓取**：它抓的是上一个标签页的页面，
  // 继续跑下去只会把结果写进新标签页（串页）。这里直接把在飞的抓取停掉：
  // renderSeq++ 让所有在飞的渲染结果失效，captureAborted 让它尽早收手。
  captureAborted = true
  renderSeq++
  clearTimeout(captureTimer); captureTimer = null
  clearInterval(progressTimer); progressTimer = null
  progress = null
  busy = false
}

/** 把当前全局存进当前标签页的快照 */
function saveActiveTabState() {
  if (tabStates[activeTab]) tabStates[activeTab] = snapshotTabState()
}

/** 实时同步显示用元信息（标签栏要立刻反映当前页标题） */
function syncTabMeta() {
  if (!tabMeta[activeTab]) tabMeta[activeTab] = { title: "", url: "" }
  tabMeta[activeTab].title = title
  tabMeta[activeTab].url = curUrl
}

/** 新标签页的干净初始状态（不重置 renderMode —— 新标签沿用当前渲染模式） */
function resetTabGlobals() {
  grid = null; textPage = null; textRows = null; mapLine = null
  curUrl = ""; title = ""; scrollPos = "top"; scrollHost = "window"; scrollYPx = 0
  textRowOffset = 0; textTotalRows = 0
  foldOpen = new Set(); activeField = null; pageEls = []
  findQuery = ""; findHits = []; findCur = -1
  navState = null; navFailed = null; requestedUrl = ""; lastGoodUrl = ""; captureError = null
  status = ""; statusKind = "info"; mediaNote = ""
  lastVp = null; elsCache = null; elsCacheKey = null; clickIndex = null
  mode = "normal"; inputValue = ""; pageEcho = ""
  pickInfo = null; dragFrom = null; pendingKeys = []; inputPending = false
  helpVisible = false
}

/** 切换到第 i 个标签页 */
function switchTab(i) {
  if (i < 0 || i >= tabStates.length) return
  if (i === activeTab) return
  saveActiveTabState()
  activeTab = i
  restoreTabState(tabStates[i])
  syncTabMeta()
  statusKind = "info"
  status = `标签页 ${i + 1}/${tabStates.length} · ${title || curUrl || "空白页"}`
  paint()
}

/** 轮换标签页（dir: +1 下一个 / -1 上一个） */
function cycleTab(dir) {
  if (tabStates.length <= 1) return
  const n = tabStates.length
  switchTab((activeTab + dir + n) % n)
}

/**
 * 把一个已经建好的页面（新建的 / 从浏览器收编来的）加进标签页列表并切过去。
 */
function pushTab(created) {
  tab = created.tab
  currentTargetId = created.targetId
  resetTabGlobals()
  tabStates.push(snapshotTabState())
  tabMeta.push({ title: "", url: "" })
  activeTab = tabStates.length - 1
  syncTabMeta()
}

/**
 * 站点自己开出来的窗口（window.open 等）→ 收编成新标签页。
 *
 * 真浏览器里这会开一个新标签页；以前我们管不了（只有一个 tab），
 * 只能眼睁睁看着它在后台开一个我们管不到的窗口 —— 用户看到的是"点了没反应"。
 */
async function adoptTab(created) {
  saveActiveTabState()
  pushTab(created)
  statusKind = "busy"
  status = "站点开出了新窗口 → 已收编为新标签页"
  paint()
  await capture(true)
}

/**
 * 点击前先问一句：这个链接会不会开新窗口？会的话**我们自己开成新标签页**。
 *
 * 比"让浏览器去开、我们再去接管"更稳：不用等浏览器的窗口事件，
 * 也不会漏掉被拦掉的弹窗。而且当前页面保持不动 —— 和真浏览器一致。
 *
 * force=true 时不管 target 是什么都开新标签页（中键点 / Ctrl+点）。
 */
async function openInNewTabIfNeeded(idx, force = false) {
  if (idx == null || idx < 0) return false
  try {
    const info = await tab.probeNewWindow(idx)
    if (!info?.url) return false
    if (!force && !info.newWindow) return false
    await newTab(info.url)
    return true
  } catch {
    return false   // 探测失败就按老路走（当前标签打开），别把点击弄没了
  }
}

/** 新建标签页 */
async function newTab(url) {
  if (!edge?.newPage) {
    statusKind = "err"; status = "当前环境不支持多标签页"
    paint(); return
  }
  if (tabStates.length >= TAB_LIMIT) {
    statusKind = "err"; status = `标签页已达上限（${TAB_LIMIT} 个）`
    paint(); return
  }
  saveActiveTabState()
  statusKind = "busy"; status = "正在新建标签页…"
  paint()
  let created
  try {
    created = await edge.newPage()
  } catch (e) {
    statusKind = "err"
    status = `新建标签页失败：${String(e?.message || e).slice(0, 60)}`
    paint()
    return
  }
  pushTab(created)
  if (url) {
    await goto(url)
  } else {
    statusKind = "ok"
    status = `新标签页 ${activeTab + 1}/${tabStates.length} · 按 o 输入网址`
    paint()
  }
}
/** 关闭标签页 */
function closeTab(i) {
  if (i < 0 || i >= tabStates.length) return
  const s = tabStates[i]
  try { s.tab?.close?.() } catch {}
  try { edge?.closePage?.(s.targetId) } catch {}
  closedTabs.push(s)
  if (closedTabs.length > 10) closedTabs.shift()
  tabStates.splice(i, 1)
  tabMeta.splice(i, 1)

  if (tabStates.length === 0) {
    // 最后一个标签页也关了 —— 回到"空白起点"：再开一个新标签页。
    activeTab = 0
    newTab().catch(() => {})
    return
  }
  if (i === activeTab) {
    activeTab = Math.min(i, tabStates.length - 1)
    restoreTabState(tabStates[activeTab])
  } else if (i < activeTab) {
    activeTab--
  }
  syncTabMeta()
  statusKind = "info"
  status = `已关闭标签页 · 剩 ${tabStates.length} 个`
  paint()
}

/** 重开最近关闭的标签页 */
async function reopenTab() {
  const s = closedTabs.pop()
  if (!s) {
    statusKind = "info"; status = "没有可重开的标签页"
    paint(); return
  }
  if (!edge?.newPage) {
    statusKind = "err"; status = "当前环境不支持多标签页"
    paint(); return
  }
  saveActiveTabState()
  statusKind = "busy"; status = "正在重开标签页…"
  paint()
  let created
  try {
    created = await edge.newPage()
  } catch (e) {
    closedTabs.push(s)
    statusKind = "err"
    status = `重开失败：${String(e?.message || e).slice(0, 60)}`
    paint()
    return
  }
  pushTab(created)
  if (s.url) await goto(s.url)
  else paint()
}

function safeShutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(progressTimer)
  clearTimeout(shotDebounce)
  try { term?.destroy() } catch {}
  // 鼠标上报必须先关：万一进程在开启状态下崩掉，不退出的终端会一直
  // 把鼠标事件吞掉，用户连"选中文字复制"都做不到。
  try { if (mouseOn) process.stdout.write(MOUSE_OFF) } catch {}
  // 括号粘贴也必须关：留在开启状态会让终端之后粘贴时多包一层转义序列，
  // 影响用户在其他程序里的粘贴（和鼠标上报是同一类「必须还原」的全局状态）。
  try { if (pasteOn) process.stdout.write(BRACKET_PASTE_OFF) } catch {}
  try { clearTimeout(lastEscapeTimer) } catch {}
  try { process.stdin.setRawMode?.(false) } catch {}
  try { process.stdin.pause?.() } catch {}
  try { process.stdout.write("\x1b[?1049l") } catch {}
  try { edge?.quit() } catch {}
  process.exit(code)
}

process.on("uncaughtException", (e) => {
  logErr("uncaughtException:", e?.stack || e)
  safeShutdown(1)
})
process.on("unhandledRejection", (e) => {
  logErr("unhandledRejection:", e?.stack || e)
  safeShutdown(1)
})

// ── 布局度量 ──
function W() { return term.width }
function H() { return term.height }

// 屏幕行分配：
//   0        标签栏（多标签页）
//   1        顶栏（标题 + 滚动位置）
//   2        地址栏
//   3        分隔线
//   4..n     页面区（pr 行）
//   n+1      分隔线
//   n+2      输入框上边
//   n+3      输入框内容
//   n+4      输入框下边
//   n+5      状态栏
//   n+6      提示行
const CHROME_ROWS = 4           // 标签栏 + 顶栏 + 地址栏 + 分隔线
// ⚠️ 是 6 不是 5：分隔线 + 输入框(3行) + 状态栏 + **提示行**，正好 6 行。
// 常量写成 5 会让 buildRows 比终端多推 1 行，而 term.render 是
// `Math.min(screenRuns.length, rows)` —— 被裁掉的永远是最后一行，
// 也就是「提示行」。症状：快捷键提示（含 `e 展开折叠`）永远看不见，
// 而其它行看起来完全正常，所以很多轮都没被发现。
const FOOT_ROWS = 6

function PAGE_ROWS() { return Math.max(3, H() - CHROME_ROWS - FOOT_ROWS) }
function PAGE_COLS() { return Math.max(8, W() - 2) }   // 左右各留 1 列画边框

function hline(ch = "─", w = W()) { return ch.repeat(Math.max(1, w)) }

// ── 加载进度 ──
function startProgress(label) {
  progress = { label, pct: 6 }
  clearInterval(progressTimer)
  progressTimer = setInterval(() => {
    if (!progress) return
    progress.pct = Math.min(94, progress.pct + 2 + Math.random() * 7)
    spinIdx = (spinIdx + 1) % SPINNER.length
    paint()
  }, 220)
  paint()
}

function stopProgress() {
  clearInterval(progressTimer)
  progressTimer = null
  paint()
}

function progressBar(len) {
  const pct = progress?.pct ?? 0
  const n = Math.round((pct / 100) * len)
  return "█".repeat(n) + "░".repeat(Math.max(0, len - n))
}

function scheduleShot(ms = 260) {
  clearTimeout(shotDebounce)
  shotDebounce = setTimeout(() => capture(false), ms)
}

let helpVisible = false

// ── 页面区内容：图片模式（整页字符网格） ──
function gridPageRows(pc, pr) {
  const out = []
  if (!grid) return out
  for (let r = 0; r < pr; r++) {
    const runs = []
    let c = 0
    while (c < pc) {
      const gi = r * grid.cols + c
      if (gi >= grid.chars.length) break
      const ch = grid.chars[gi]
      const fg = [grid.color[gi * 3], grid.color[gi * 3 + 1], grid.color[gi * 3 + 2]]
      // 合并颜色相近的连续同字符格，减少输出体积
      let nc = c + 1
      while (nc < pc) {
        const g2 = r * grid.cols + nc
        if (g2 >= grid.chars.length) break
        if (grid.chars[g2] !== ch) break
        const dr = Math.abs(grid.color[g2 * 3] - fg[0]) +
          Math.abs(grid.color[g2 * 3 + 1] - fg[1]) +
          Math.abs(grid.color[g2 * 3 + 2] - fg[2])
        if (dr > 52) break
        nc++
      }
      runs.push({
        t: String.fromCharCode(...grid.chars.subarray(gi, gi + (nc - c))),
        fg, bg: C.bg, w: nc - c,
      })
      c = nc
    }
    const used = runs.reduce((a, r2) => a + r2.w, 0)
    if (used < pc) runs.push({ t: " ".repeat(pc - used), fg: C.text, bg: C.bg, w: pc - used })
    out.push(runs)
  }
  return out
}

// ── 页面区内容：文字模式（DOM 文字 + ASCII 媒体块） ──
// 滚动偏移由 scrollRow 管理（行级），不再按像素裁剪。
function textPageRows(pc, pr) {
  if (!textPage) return []
  const res = renderTextPage(textPage, {
    width: pc, maxRows: pr, yOffset: textRowOffset,
    // 正在输入的控件要画成 ▶ + 金色，用户才知道字符会打到哪儿
    activeFid: activeField ? activeField.fid : undefined,
  })
  textRows = res
  // 鼠标命中索引：渲染行 → 这一行上的来源块。
  // 必须在 overlayRuns 改行之前建好也不行、之后也不行 —— 无所谓，
  // 因为改行时是 `{...r}` 展开的，src 不会被抹掉（见 overlayRuns#mark 的注释）。
  clickIndex = buildClickIndex(res.rows)
  return res.rows
}

// ── 完整按键帮助 ──
//
// 以前按 ? 只在提示行多出一长串字 —— 一屏放不下，滚也滚不到，
// 等于"记不住快捷键"。现在按 ? 直接铺满整个页面区，能上下翻。
const HELP_ITEMS = [
  ["j / k / ↓ / ↑", "上下滚动"],
  ["d / u", "上下半页"],
  ["g / G / Home / End", "跳到页首 / 页尾"],
  ["o  或  Ctrl+L", "地址栏：输入网址或搜索词（Ctrl+L 会带出当前网址）"],
  ["r  或  Ctrl+R", "刷新当前页"],
  ["b / ← / Backspace", "后退（会恢复上一页的滚动位置）"],
  ["f / →", "前进"],
  ["/  或  Ctrl+F", "页内查找 · n / N 在命中间跳转"],
  ["B  或  Ctrl+D", "收藏当前页"],
  ["/bm", "书签列表"],
  ["/his", "历史列表"],
  ["i", "输入模式：打字直接进页面控件"],
  ["v", "元素清单：↑↓ 选择 · Enter 真实点击"],
  ["e / E", "展开折叠内容 / 真去点页面上的展开控件"],
  ["m", "切换文字模式 / 图片模式"],
  ["Tab", "在链接与表单之间循环聚焦"],
  ["t  或  Ctrl+T", "新建标签页"],
  ["w  或  Ctrl+W", "关闭当前标签页"],
  ["T  或  Ctrl+Shift+T", "重开最近关闭的标签页"],
  ["[ / ]  或  Ctrl+Tab", "上一个 / 下一个标签页"],
  ["1…9 / 0  或  Ctrl+1…9", "直跳到第 n 个标签页"],
  [":", "命令模式：/reload /back /forward /text /image /copy /pdf /dl /mouse …"],
  ["?", "开关本帮助"],
  ["q / Ctrl+C", "退出"],
]
let helpOffset = 0

function helpPageRows(pc, pr) {
  const out = []
  const bodyRows = Math.max(1, pr - 1)
  const maxOff = Math.max(0, HELP_ITEMS.length - bodyRows)
  helpOffset = Math.max(0, Math.min(maxOff, helpOffset))
  const push = (t, fg) => {
    const w = strWidth(t)
    const row = [{ t, fg, bg: C.bg, w }]
    if (w < pc) row.push({ t: " ".repeat(pc - w), fg: C.text, bg: C.bg, w: pc - w })
    out.push(row)
  }
  push(truncateByWidth(
    ` 按键说明 ${helpOffset + 1}-${Math.min(HELP_ITEMS.length, helpOffset + bodyRows)}/${HELP_ITEMS.length} · j/k 翻页 · ? 或 Esc 关闭 `, pc), C.gold)
  for (let i = 0; i < bodyRows; i++) {
    const it = HELP_ITEMS[helpOffset + i]
    if (!it) { push(""); continue }
    const keyW = Math.min(22, Math.max(10, pc - 24))
    const k = truncateByWidth(it[0], keyW).padEnd(keyW)
    push(truncateByWidth(k + "  " + it[1], pc), C.cyan)
  }
  return out
}

// ── 加载失败（导航失败）时的页面区 ──
//
// 为什么不直接显示 Chrome 的错误页内容：抓回来只有「无法访问此网站」那几行，
// 而用户真正需要知道的是**现在该怎么办** —— 返回 / 重试 / 换地址。
// 失败页尤其要写清楚「按 b 能回去」，因为人在这一刻最想做的就是回去。
function navFailRows(pc, pr) {
  const out = []
  const nf = navFailed || {}
  const lines = [
    { t: " ✖ 无法访问 " + safeHost(nf.url || ""), fg: C.err },
    { t: "   " + (nf.reason || "未知错误") + (nf.url ? `  ${nf.url}` : ""), fg: C.dim },
    { t: "   按 b / Backspace 返回 · 按 r 重试 · 按 o 换个地址 · 按 /his 看历史", fg: C.cyan },
  ]
  for (let i = 0; i < pr; i++) {
    const l = lines[i]
    const t = l ? truncateByWidth(l.t, pc) : ""
    const w = strWidth(t)
    const row = l ? [{ t, fg: l.fg, bg: C.bg, w }] : []
    if (w < pc) row.push({ t: " ".repeat(pc - w), fg: C.text, bg: C.bg, w: pc - w })
    out.push(row)
  }
  return out
}

// ── 抓页失败时的页面区 ──
// **不能用旧画面顶替**。实盘事故：run.mjs 漏导入 applyFoldState，
// captureText 每次都抛异常，而 catch 只更新状态栏、页面区照旧渲染
// 上一次成功抓到的 textPage —— 于是"后退"按下去页面纹丝不动，
// 用户报告的是「无法使用 back」，而不是「程序报错了」。
// 失败必须显式、显眼，否则它会被当成功能缺陷。
function errorPageRows(pc, pr) {
  const out = []
  const lines = [
    " ✖ 抓页失败 · 画面已停更（不是页面本身的问题）",
    " " + String(captureError).slice(0, Math.max(10, pc - 4)),
    " 按 r 重试 · 按 m 换渲染模式 · 按 q 退出",
  ]
  for (let i = 0; i < pr; i++) {
    const t = i < lines.length ? truncateByWidth(lines[i], pc) : ""
    const w = strWidth(t)
    const row = [{ t, fg: i === 0 ? C.err : C.dim, bg: C.bg, w }]
    if (w < pc) row.push({ t: " ".repeat(pc - w), fg: C.text, bg: C.bg, w: pc - w })
    out.push(row)
  }
  return out
}

/**
 * 书签 / 历史的列表视图（mode==="list"）。
 * 不做弹窗面板，直接替换页面区 —— 文字浏览器里这是最不容易和页面内容混在一起的画法。
 * 每项一行：`▸ 标题 · host/路径`，选中行整行铺底色。
 */
function listPageRows(pc, pr) {
  const items = listKind === "bm" ? bookmarks : history
  const rows = []
  const pushRow = (runs) => {
    const used = runs.reduce((a, r) => a + (r.w ?? strWidth(r.t)), 0)
    rows.push([...runs, ...(used < pc ? [{ t: " ".repeat(pc - used), fg: C.text, bg: C.bg, w: pc - used }] : [])])
  }
  const head = listKind === "bm"
    ? `书签 ${items.length} 条 · ↑↓ 选择 · Enter 打开 · x 删除 · Esc 退出`
    : `历史（新→旧）${items.length} 条 · ↑↓ 选择 · Enter 打开 · x 删除 · Esc 退出`
  pushRow([{ t: truncateByWidth(head, pc), fg: C.gold, bg: C.bg, w: Math.min(pc, strWidth(head)) }])
  const bodyN = Math.max(0, pr - 2)
  const start = Math.max(0, Math.min(listSel - Math.floor(bodyN / 2), items.length - bodyN))
  for (let i = 0; i < bodyN; i++) {
    const idx = start + i
    const it = items[idx]
    if (!it) { rows.push([{ t: " ".repeat(pc), fg: C.text, bg: C.bg, w: pc }]); continue }
    const sel = idx === listSel
    const mark = sel ? "▸ " : "  "
    const hostPath = (() => { try { const u = new URL(it.u); return u.host + (u.pathname === "/" ? "" : u.pathname) } catch { return it.u } })()
    const room = pc - strWidth(mark)
    const t0 = truncateByWidth(String(it.t || it.u), Math.max(8, Math.floor(room * 0.55)))
    const t1 = truncateLeft(" · " + hostPath, Math.max(0, room - strWidth(t0)))
    const w0 = strWidth(t0), w1 = strWidth(t1)
    const line = [
      { t: mark, fg: sel ? C.err : C.bg, bg: sel ? C.bg : C.bg, w: strWidth(mark) },
      { t: t0, fg: sel ? C.fg : C.text, bg: sel ? [70, 34, 24] : C.bg, w: w0 },
      { t: t1, fg: sel ? C.fg : C.dim, bg: sel ? [70, 34, 24] : C.bg, w: w1 },
    ]
    const used = strWidth(mark) + w0 + w1
    if (used < pc) line.push({ t: " ".repeat(pc - used), fg: C.text, bg: sel ? [70, 34, 24] : C.bg, w: pc - used })
    rows.push(line)
  }
  while (rows.length < pr) rows.push([{ t: " ".repeat(pc), fg: C.text, bg: C.bg, w: pc }])
  return rows.slice(0, pr)
}

// ── 终端标题 ──
//
// 真浏览器会把窗口标题设成当前页面标题（标签页上直接看得到）。
// 终端里对应的是 OSC 0/2 —— 任务栏、窗口列表、终端标签上都能看到。
let lastTermTitle = ""
function setTermTitle(t) {
  const s = t ? `${String(t).replace(/[\x00-\x1f]/g, " ").slice(0, 60)} — edge-tui` : "edge-tui"
  if (s === lastTermTitle) return
  lastTermTitle = s
  try { process.stdout.write(`\x1b]0;${s}\x07`) } catch {}
}

// ── 标签栏（参考 OpenCode V2 TUI：横向条 + 编号 + 当前项高亮）──
//
// 为什么用「编号」而不是「状态图标」做主指示：状态图标要靠颜色区分，
// 在不支持真彩的终端里会退化成同一个字符；编号在任何终端都能读，
// 而且和 Ctrl+数字 直跳一一对应。
function tabStripRow() {
  const w = W()
  const runs = []
  let used = 0
  for (let i = 0; i < tabStates.length; i++) {
    const meta = tabMeta[i] || {}
    const isActive = i === activeTab
    const num = (i + 1) % 10
    const raw = meta.title || meta.url || "新标签页"
    // 正在加载的标签页前面挂个转圈（真浏览器标签上也有这个）
    const spin = (isActive && busy) ? SPINNER[spinIdx] + " " : ""
    const label = truncateByWidth(`${spin}[${num}] ${raw}`, 26)
    const cell = " " + label + " "
    const cw = strWidth(cell)
    if (used + cw > w) break
    runs.push({ t: cell, fg: isActive ? C.bg : C.weak, bg: isActive ? C.accent : C.chrome, w: cw })
    used += cw
  }
  const pad = Math.max(0, w - used)
  if (pad) runs.push({ t: " ".repeat(pad), fg: C.weak, bg: C.chrome, w: pad })
  return runs
}

// ── 整屏组装渲染 ──
function buildRows() {
  const w = W()
  const rows = []

  // ⓪ 标签栏
  rows.push(tabStripRow())

  // ① 顶栏：◆ edge-tui  <标题>              ⟨渲染模式⟩ ⟨滚动位置⟩
  const brand = " ◆ "
  const name = "edge-tui"
  const titleText = title || curUrl || "…"
  // 模式标签顺带报出**整页总行数** —— 这是"一次渲染整页"最直观的证据：
  // 数字不动就说明滚动没有重新加载（用户问过："每动一下就要重新加载，
  // 是不能一次渲染整个页面吗"）。放顶栏是因为它常驻可见，
  // 不受状态栏里"导航超时/跳过了几张图"之类提示的挤占。
  const modeTag = renderMode === "text"
    ? (textTotalRows ? ` 文字 ${textTotalRows}行 ` : " 文字 ")
    : " 图片 "
  const headLeft = [
    { t: brand, fg: C.accent, bg: C.chrome, w: 3 },
    { t: name, fg: C.fg, bg: C.chrome, w: name.length },
    { t: modeTag, fg: renderMode === "text" ? C.purple : C.weak, bg: C.chrome, w: strWidth(modeTag) },
  ]
  const headLeftW = 3 + name.length + strWidth(modeTag)
  // 滚动位置：顶/中/底 + 百分比（真浏览器会告诉你"还有多少"）
  const posLabel = scrollPos === "bottom" ? "底" : scrollPos === "middle" ? "中" : "顶"
  const pctText = (renderMode === "text" && textTotalRows > 1)
    ? ` ${Math.round((textRowOffset / Math.max(1, textTotalRows - PAGE_ROWS())) * 100)}%` : ""
  const posTag = posLabel + pctText
  const posW = strWidth(posTag) + 2
  const room = Math.max(0, w - headLeftW - posW)
  rows.push([
    ...headLeft,
    { t: truncateByWidth(titleText, room), fg: C.accent, bg: C.chrome, w: room },
    { t: " " + posTag + " ", fg: C.weak, bg: C.chrome, w: posW },
  ])

  // ② 地址栏：URL + 右侧进度/就绪
  const addrLabel = " 地址 "
  const addrLeftW = strWidth(addrLabel)
  if (progress) {
    const label = " " + SPINNER[spinIdx] + " " + progress.label + " "
    const bar = progressBar(16)
    const pct = " " + String(Math.round(progress.pct)).padStart(3, " ") + "% "
    const rightW = strWidth(label) + 16 + strWidth(pct)
    const urlRoom = Math.max(0, w - addrLeftW - rightW)
    rows.push([
      { t: addrLabel, fg: C.weak, bg: C.chrome, w: addrLeftW },
      { t: truncateLeft(curUrl || "…", urlRoom), fg: C.text, bg: C.chrome, w: urlRoom },
      { t: label, fg: C.accent, bg: C.chrome, w: strWidth(label) },
      { t: bar, fg: C.blue, bg: C.chrome, w: 16 },
      { t: pct, fg: C.dim, bg: C.chrome, w: strWidth(pct) },
    ])
  } else {
    const right = " 就绪 "
    const rightW = strWidth(right)
    const urlRoom = Math.max(0, w - addrLeftW - rightW)
    rows.push([
      { t: addrLabel, fg: C.weak, bg: C.chrome, w: addrLeftW },
      { t: truncateLeft(curUrl || "…", urlRoom), fg: C.text, bg: C.chrome, w: urlRoom },
      { t: right, fg: C.weak, bg: C.chrome, w: rightW },
    ])
  }

  // ③ 分隔线
  rows.push([{ t: hline("─", w), fg: C.borderDim, bg: C.bg }])
  // ④ 页面区
  const pr = PAGE_ROWS(), pc = PAGE_COLS()
  const pageRows = captureError ? errorPageRows(pc, pr)
    : navFailed ? navFailRows(pc, pr)
    : helpVisible ? helpPageRows(pc, pr)
    : mode === "list" ? listPageRows(pc, pr)
    : renderMode === "text" ? textPageRows(pc, pr) : gridPageRows(pc, pr)
  for (let r = 0; r < pr; r++) {
    const inner = pageRows[r]
    if (inner && inner.length) {
      rows.push([{ t: "│", fg: C.borderDim, bg: C.bg, w: 1 }, ...inner, { t: "│", fg: C.borderDim, bg: C.bg, w: 1 }])
    } else {
      rows.push([
        { t: "│", fg: C.borderDim, bg: C.bg, w: 1 },
        { t: " ".repeat(pc), fg: C.text, bg: C.bg, w: pc },
        { t: "│", fg: C.borderDim, bg: C.bg, w: 1 },
      ])
    }
  }

  // ⑤ 分隔线
  rows.push([{ t: hline("─", w), fg: C.borderDim, bg: C.bg }])

  // ⑥ 输入框（橙红圆角，仿 codewhale）
  // 总宽固定为 w：╭ + (w-2) 个 ─ + ╮
  const boxW = Math.max(4, w)
  const innerW = boxW - 2
  const prompt = mode === "pageinput" ? "» " : mode === "cmd" ? "» " : "› "
  // pageinput 模式下输入框显示**页面控件的当前值**（本地回显），不再是占位提示。
  // 这样即使控件行被滚出屏幕、"正在输入的控件"高亮看不见，
  // 用户也能在最顺手的位置确认自己打进去了什么、退格删掉了什么。
  const boxText = mode === "pageinput" ? pageEcho : inputValue
  const isPlaceholder = !boxText
  const shown = boxText || placeholderFor(mode)
  const caret = mode !== "normal" ? "▌" : ""
  const hintRight = inputHint(mode)
  const hintW = strWidth(hintRight)
  const labelRoom = Math.max(0, innerW - hintW)
  const label = truncateByWidth(prompt + shown + caret, labelRoom)
  const labelPad = Math.max(0, labelRoom - strWidth(label))

  rows.push([{ t: "╭" + "─".repeat(innerW) + "╮", fg: C.border, bg: C.bg }])
  rows.push([
    { t: "│", fg: C.border, bg: C.bg, w: 1 },
    { t: label + " ".repeat(labelPad), fg: isPlaceholder ? C.weak : C.fg, bg: C.bg, w: labelRoom },
    { t: hintRight, fg: C.cyan, bg: C.bg, w: hintW },
    { t: "│", fg: C.border, bg: C.bg, w: 1 },
  ])
  rows.push([{ t: "╰" + "─".repeat(innerW) + "╯", fg: C.border, bg: C.bg }])

  // ⑦ 状态栏
  const kindColor = statusKind === "err" ? C.err
    : statusKind === "ok" ? C.cyan
      : statusKind === "busy" ? C.gold
        : C.purple
  const dot = busy ? SPINNER[spinIdx] : "◆"
  const statusText = " " + dot + " " + status
  const foldTag = foldHint()
  const foldW = strWidth(foldTag)
  const helpTag = " ? 帮助 "
  const helpW = strWidth(helpTag)
  const statusRoom = Math.max(0, w - helpW - foldW)
  const st = truncateByWidth(statusText, statusRoom)
  rows.push([
    { t: st + " ".repeat(Math.max(0, statusRoom - strWidth(st))), fg: kindColor, bg: C.bgDeep, w: statusRoom },
    ...(foldW ? [{ t: foldTag, fg: C.gold, bg: C.bgDeep, w: foldW }] : []),
    { t: helpTag, fg: C.weak, bg: C.bgDeep, w: helpW },
  ])

  // ⑧ 提示行
  rows.push([
    { t: truncateByWidth(keyHint(mode).replace(/  +/g, "  "), w), fg: C.dim, bg: C.bgDeep },
  ])

  return rows
}

function placeholderFor(m) {
  if (m === "goto") return "输入网址或搜索词，回车打开"
  if (m === "cmd") return "/reload  /back  /forward  /top  /end  /bm  /his  /quit  /text  /image"
  if (m === "find") return "页内查找：输入关键词回车定位（n/N 跳转）"
  if (m === "list") return listKind === "bm" ? "书签列表 · Enter 打开 · x 删除" : "历史列表 · Enter 打开 · x 删除"
  if (m === "pageinput") return "按键直接发送到页面"
  if (m === "upload") return "输入文件完整路径，多个用 | 分隔"
  if (m === "pick") return "↑↓ 选择 · Enter 点击/h 悬停/d 双击/g 拖拽/u 上传"
  return "输入网址…（o 聚焦此处，: 输入命令，/ 页内查找）"
}

function inputHint(m) {
  if (m === "pageinput") return "[Esc 退出] "
  if (m === "pick" || m === "list") return "[Esc 退出] "
  if (m === "find") return "[Enter 定位] "
  if (m === "upload") return "[Enter 上传] "
  if (m === "goto" || m === "cmd") return "[Enter 执行] "
  return "[? 帮助] "
}

function keyHint(m) {
  if (m === "pick") return "元素清单 · ↑↓/j k 选择 · Enter 点击 · h 悬停 · d 双击 · g 拖拽 · u 上传 · Esc 退出"
  if (m === "list") return (listKind === "bm" ? "书签" : "历史") + " · ↑↓/j k 选择 · Enter 打开 · x 删除 · Esc 退出"
  if (helpVisible) {
    return "按键说明 · j/k 翻页 · ? 或 Esc 关闭"
  }
  if (m === "pageinput") return "输入模式 · 打字直接进页面 · Enter 提交/回车 · Backspace 退格 · Ctrl+V 粘贴中文最可靠 · ↑↓ 选建议 · Tab 换控件 · Esc 退出"
  return "鼠标: 点链接/控件/折叠 · 滚轮翻页   j/k 滚动   i 输入框   / 查找   B 收藏   Tab 链接   v 元素清单   e 展开折叠   Backspace 后退   Enter 打开   o 网址   t 新标签页   ? 帮助   q 退出"
}

/** 文字模式 ↔ 图片模式 切换 */
function toggleRenderMode() {
  renderMode = renderMode === "text" ? "image" : "text"
  lastVp = null           // 两种模式的视口尺寸不同，必须重设
  textRowOffset = 0
  if (renderMode === "image") { textPage = null; textRows = null; mapLine = null }
  else grid = null
  statusKind = "info"
  status = renderMode === "text"
    ? "已切到文字模式（DOM 取字，媒体走字符画）"
    : "已切到图片模式（整页字符画）"
  capture(true)
}

function paint() {
  if (pendingPaint || !term) return
  pendingPaint = true
  try {
    // 元素清单的标记需要叠加到页面内容上。
    // 文字模式下不能像旧网格那样直接改像素格（一个终端格 = 一个汉字，
    // 没有「元素落在第几格」的线性映射），改为「整行铺底色 + 行首标记」，
    // 行号走 makeLineMapper 的二维重叠匹配。详见 textbrowser.js#overlayRuns。
    if (mode === "pick" && renderMode === "text" && textPage) {
      stampPickerOverlayText()
    }
    // 页内查找的高亮：命中行铺底色，当前命中更亮。滚动后 rerenderText 重建
    // textRows，每次 paint 前重新盖章 —— 幂等，覆盖同一批行。
    if (renderMode === "text" && textPage && findHits.length && mode !== "list") {
      stampFindOverlay()
    }
    const rows = buildRows()
    const key = JSON.stringify(rows)
    if (key === prevScreen) return
    prevScreen = key
    term.render(rows)
  } catch (e) {
    logErr("paint:", e?.stack || e)
  } finally {
    pendingPaint = false
  }
}

// ── 等待页面出现实际文本内容（避免抓到一个"还没长出来的"页面） ──
//
// ⚠️ 老判据是「文本 > 120 字 **或** a/img/input > 4 个就返回」，在搜索结果页
// 上会**瞬间返回**：Bing 的骨架里那几条"跳至内容 / 辅助功能反馈"链接就够数了，
// 于是我们抓到的是一张只有十几字的半成品页 —— 用户看到的就是
// **「搜索结果无法显示」**（实测：结果页只提取到 11 字，实测见
//  tests/test-inputpath.mjs 的端到端断言）。
//
// 现在的判据是「**内容稳定**」而不是「内容够多」：
//   · 文本已经很丰富（>1500 字）→ 直接返回，不必等（长文章不浪费时间）
//   · 否则连续 3 次读数完全一致（约 0.4s 没有新东西）→ 认定稳定
//   · 完全空白且文档已 complete 连续 3 次 → 确实是空页，不再空等
async function waitContent(timeoutMs = 6000, t = tab) {
  const t0 = Date.now()
  let last = -1, stable = 0, blank = 0
  // SPA 是「先渲染壳、再 hydration 注水」：抓得太早就只有导航菜单没有正文。
  // waitForReady 已等了至少 1.2s，这里再补 0.6s —— 总共给框架约 2s 注水时间。
  const MIN_DWELL_MS = 600
  while (Date.now() - t0 < timeoutMs) {
    let p = null
    const elapsed = Date.now() - t0
    try {
      // ⚠️ 一次 evaluate 拿齐三个信号。以前是三次分开的 evalJs ——
      // 每轮 3 次往返 × 至少 3 轮 = 固定 9 次往返，纯属白等。
      p = await t.evalJs(`(() => ({
        n: (document.body && document.body.innerText || '').replace(/\\s+/g,'').length,
        k: document.querySelectorAll('a,img,input').length,
        ready: document.readyState === 'complete',
      }))()`)
    } catch {}
    if (!p) { await new Promise((r) => setTimeout(r, 150)); continue }
    if (elapsed >= MIN_DWELL_MS && p.n > 1500) return
    if (p.n === 0 && p.k === 0) {
      if (p.ready && ++blank >= 3) return
    } else blank = 0
    const score = p.n + p.k * 4
    if (score > 0 && score === last) {
      if (++stable >= 3) return
    } else stable = 0
    last = score
    await new Promise((r) => setTimeout(r, 150))
  }
}

// ── 视口 + 抓取 ──
// 两种渲染模式的公共外壳：设视口 → 等内容 → 复位滚动（可选）→ 取页面信息
// → 各自抓内容。图片模式走整页截图降采样，文字模式走 DOM 提取。
async function capture(resetScroll = false) {
  const seq = ++renderSeq
  // ⚠️ 抓取是异步的、跨越好几个 await。期间用户可能**切了标签页** ——
  // 那时全局 tab 已经指向别的页面，下面每一句 tab.xxx() 都会打到**错误的页**上
  // （症状：新标签页的视口被改、URL 被旧页覆盖、内容串页）。
  // 所以全程只认开头抓住的那一个引用；中途发现换页就整次丢弃。
  const myTab = tab
  const abandoned = () => myTab !== tab
  busy = true
  captureAborted = false
  captureTimedOut = false
  captureDeadline = Date.now() + CAPTURE_BUDGET_MS
  mediaNote = ""
  statusKind = "busy"
  startProgress("正在加载…")
  // ── 硬看门狗 ──
  // 超时不是"报错退出"，而是**降级**：让抓图循环立刻收手、把已经拿到的
  // 部分渲染出来，并在状态栏说明"这是已加载部分"。冻结的界面比不完整的页面糟糕得多。
  clearTimeout(captureTimer)
  captureTimer = setTimeout(() => {
    if (!busy) return
    if (abandoned()) return          // 标签页已切换：别把旧页的超时写到新页上
    captureTimedOut = true
    captureAborted = true
    statusKind = "busy"
    status = "抓取超时，先显示已加载的部分…"
    paint()
  }, CAPTURE_BUDGET_MS)
  try {
    const pc = PAGE_COLS(), pr = PAGE_ROWS()
    // 图片模式的视口 = 网格像素尺寸；文字模式只需要一个「合理的桌面宽度」，
    // 让页面呈现桌面版布局（窄视口会触发移动版，DOM 结构完全不同）。
    const vpW = renderMode === "image" ? pc * CELL_W : Math.max(880, pc * 9)
    const vpH = renderMode === "image" ? pr * CELL_H : Math.max(520, pr * 19)
    const vpKey = vpW + "x" + vpH
    if (lastVp !== vpKey) {
      lastVp = vpKey
      await myTab.setViewport(vpW, vpH)
      // 尺寸变化会让页面重排，需给一点时间
      await new Promise((r) => setTimeout(r, 180))
    }
    await waitContent(6000, myTab)
    if (abandoned()) return   // 标签页已切换：这次抓取作废（状态由切换方接管）
    if (captureAborted) {
      // 看门狗已经判死这次抓取：不再提取 / 不再截图，直接说清情况
      captureError = "抓取超时：页面长时间没有稳定内容（按 r 重试，或 Esc 放弃）"
      busy = false
      statusKind = "err"
      status = "抓取超时 · 已停止等待 · r 重试"
      clearTimeout(captureTimer)
      stopProgress()
      paint()
      return
    }
    if (resetScroll) {
      try { await myTab.scrollTarget() } catch {}
      await myTab.evalJs("(()=>{window.scrollTo(0,0); if(window.__etuiScrollEl) window.__etuiScrollEl.scrollTop=0})()")
      textRowOffset = 0
      await new Promise((r) => setTimeout(r, 120))
    }

    const info = await myTab.pageInfo()
    // ⚠️ 导航失败时 Chrome 会把地址换成内部的 `chrome-error://chromewebdata/`，
    // 并渲染一张「嗯… 无法访问此页面」的错误页。旧代码照单全收：
    // 地址栏显示一串对用户毫无意义的内部地址，状态栏还写着「就绪」——
    // 用户输入的网址打不开，界面上却**没有任何失败的迹象**。
    // 现在识别出来：地址栏保留用户输入的那个网址，状态栏明确说「加载失败 + 原因」。
    navFailed = null
    if (/^chrome-error:/.test(info.u || "")) {
      let reason = ""
      try {
        reason = await myTab.evalJs(
          "(() => { const m = (document.body && document.body.innerText || '').match(/ERR_[A-Z_]+/); return m ? m[0] : '' })()")
      } catch {}
      navFailed = { url: requestedUrl || lastGoodUrl || "", reason: reason || "未知错误" }
      curUrl = navFailed.url
      title = `无法访问 · ${navFailed.reason}`
    } else {
      if (info.u && !/^chrome-error:/.test(info.u)) lastGoodUrl = info.u
      curUrl = info.u
      title = info.t || info.u
      // 像常见浏览器一样记历史（连续同一地址只刷新时间；加载失败页不记）。
      // dump 模式是排查/快照用的，探针访问不该污染真实历史。
      if (!dumpMode) recordHistory(curUrl, title)
    }
    // 标签栏要立刻反映当前页标题
    syncTabMeta()
    setTermTitle(title)
    const sp = await myTab.scrollState()
    viewW = sp?.iw || vpW
    viewH = sp?.ih || vpH
    scrollYPx = sp?.y || 0
    if (sp) scrollHost = sp.host

    if (navFailed) {
      // 失败页**不抓**：Chrome 错误页的内容对用户没有价值（就是"无法访问"四个字），
      // 真正该显示的是「返回 / 重试 / 换地址」这些操作指引。
      textPage = null; textRows = null; mapLine = null; grid = null
      textTotalRows = 0
    } else {
      const applied = renderMode === "text"
        ? await captureText(pc, pr, seq, myTab)
        : await captureGrid(pc, pr, myTab)
      if (applied === null) return   // 被更新的抓取取代：交给它
      if (applied === false) return  // 标签页已切换：这次作废
    }
    if (seq !== renderSeq) return   // 已被更新的渲染取代
    // 重抓之后排版行号全部变了：查找高亮必须清掉（否则高亮落在错误的内容上）
    findHits = []
    findCur = -1
    findQuery = ""

    if (sp) {
      scrollPos = sp.y <= 1 ? "top" : sp.y + sp.ih >= sp.sh - 4 ? "bottom" : "middle"
    }
    captureError = null
    busy = false
    clearTimeout(captureTimer)
    const note = captureQualityNote()
    statusKind = note ? "info" : "ok"
    // 如实说明这次抓取是不是"完整"的 —— 用户有权知道看到的是不是全部。
    // 文字模式下顺带报出总行数：**整页已经在内存里**，滚动/翻页不会再重新加载。
    // 不写出来用户就会以为"每动一下都在重新加载"（以前确实如此，见 scrollPx）。
    status = note || startupNote
      || (renderMode === "text" && textTotalRows
        ? `就绪 · 全文 ${textTotalRows} 行已装入内存（滚动不再重新加载）`
        : "就绪")
    stopProgress()
    paint()
  } catch (e) {
    if (abandoned()) return          // 标签页已切换：这个错属于旧页
    logErr("capture:", e?.stack || e)
    clearTimeout(captureTimer)
    // 宁可显示错误，也不要显示过期的旧页面 —— 后者会被误读成"某个功能坏了"
    captureError = String(e?.message || e)
    busy = false
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    stopProgress()
    paint()
  }
}

/**
 * 停止加载（Esc）—— 相当于浏览器的"停止"按钮。
 *
 * 逐级做三件事，越靠前越轻：
 *   ① 打标记：正在跑的 capture 会在下一个检查点收手（抓图循环 / waitContent 之后）
 *   ② 停掉进度条与看门狗，立刻解除 busy —— 界面马上可以操作
 *   ③ 真的让浏览器停止加载（Page.stopLoading）：这样等着的 load/子资源直接结束，
 *      也省掉后续无谓的等待
 */
function stopCapture() {
  captureAborted = true
  captureTimedOut = false
  clearTimeout(captureTimer)
  busy = false
  stopProgress()
  try { tab?.stopLoading?.().catch?.(() => {}) } catch {}
  statusKind = "info"
  status = "已停止加载（显示的是已加载部分）· r 重试"
  paint()
}

/**
 * 这次抓取是否需要提醒用户「你看到的不是全部」。
 * 三种情况都要说，且要说清是哪一种 —— 否则用户只感到"页面怪怪的"。
 */
/** 从 URL 里抠出主机名（给状态栏用，别把整个带参数的地址塞进去） */
function safeHost(u) {
  try { return new URL(u).host || u } catch { return String(u || "").slice(0, 40) }
}

function captureQualityNote() {
  const parts = []
  if (navFailed) parts.push(`无法访问 ${safeHost(navFailed.url)}（${navFailed.reason}）· b 返回 · r 重试`)
  if (navState?.errorText && !/^net::ERR_ABORTED$/.test(navState.errorText)) {
    parts.push(`导航失败：${navState.errorText}`)
  }
  if (captureTimedOut || navState?.state === "timeout") {
    parts.push("加载超时，显示的是已加载部分（r 重试）")
  }
  if (captureAborted) parts.push("已被 Esc 中断，显示的是已加载部分")
  if (mediaNote) parts.push(mediaNote)
  if (tab?.dialog) parts.push(`已自动关闭 ${tab.dialogCount} 个页面弹窗（${tab.dialog.type}）`)
  navState = null
  return parts.join(" · ")
}

// ── 图片模式：整页截图 → 4x8 降采样 → 字符网格 ──
// 核心修复：不再用 Math.max(..., 400) 钳制高度。
// 请求多高就设多高，网格行数严格等于 PAGE_ROWS()，杜绝底部串位。
async function captureGrid(pc, pr, t = tab) {
  const png = await t.screenshot(false)
  // 抓图期间用户切了标签页 → 这次结果属于别的页面，丢弃
  if (t !== tab) return false
  grid = pngToGrid(png, CELL_W, CELL_H, PAGE_BG, { contrast: CONTRAST })
  // 只取前 pr 行，裁掉多余部分，使网格与页面区严格对齐
  if (grid.rows > pr) {
    const keep = pr * grid.cols
    grid.chars = grid.chars.subarray(0, keep)
    grid.color = grid.color.subarray(0, keep * 3)
    grid.rows = pr
  }
  if (debugMode) {
    console.error(`[debug:grid] ${grid.rows}x${grid.cols} vp=${pc}x${pr} px=${grid.pw}x${grid.ph} luma=${grid.avgLuma?.toFixed(0)} lightText=${grid.lightText}`)
  }
  return true
}

// ── 文字模式：DOM 提取 → 终端原生字符排版（图片走旁路裁剪） ──
//
// 返回值：true=已应用 · null=被更新的抓取取代 · false=标签页已切换（作废）
async function captureText(pc, pr, seq, t = tab) {
  const page = await buildTextPage(t, {
    width: pc,
    viewport: false,          // 全页提取；可见范围交由行偏移控制
    indent: 1,
    maxMediaRows: Math.max(4, Math.min(12, Math.floor(pr / 3))),
    // 二维码必须**整块落在页面区内**：手机一次只能拍到一屏，
    // 缺一半的码解不出来。减 1 是给上面那行标签留位置。
    qrMaxRows: Math.max(8, pr - 1),
    // ── 抓图预算 + 进度回调 ──
    // 没有预算的话，图多的页面就是"卡住"的页面：每张图一次串行截图往返，
    // 期间界面完全静止。有了预算，超出的部分退化成一行写明原因的占位，
    // 而且抓图过程中状态栏会动（"正在抓取图片 6/24"）—— 有动静就不像卡死。
    limits: {
      deadline: captureDeadline || Infinity,
      maxShots: MEDIA_MAX_SHOTS,
      isAborted: () => captureAborted,
      onProgress: (done, total) => {
        if (t !== tab) return          // 标签页已切换：别把旧页的进度写到新页上
        statusKind = "busy"
        status = `正在抓取图片 ${done}/${total}…（Esc 停止）`
        paint()
      },
      onFinish: ({ shots, skipped, total }) => {
        if (t !== tab) return
        mediaNote = `已抓 ${shots}/${total} 张图，${skipped} 张因预算/超时跳过`
      },
    },
  })
  if (seq !== undefined && seq !== renderSeq) return null   // 被更新的抓取取代
  // 抓取期间用户切了标签页 → 这次结果属于**别的**页面，丢弃。
  // 不丢弃的话会把旧页的内容写进新标签页（串页）。
  if (t !== tab) return false
  textPage = page
  // 重抓之后 textPage 是全新对象，activeField 指着旧的 —— 按编号重新指认。
  // （不重新指认的话，输入模式里打进去的字会"显示不出来"，
  //   因为它改的是已被丢弃的那份拷贝。）
  if (activeField) activeField = (textPage.fields || []).find((f) => f.fid === activeField.fid) || null
  // 折叠内容按当前展开状态重建（必须用 applyFoldState 而不是手工往 lines 里塞，
  // 它每次都从 linesBase 重算，幂等）
  applyFoldState(textPage, foldOpen, pc)
  // 行级滚动：只要没超过内容底部，保留用户当前的滚动位置
  const res = renderTextPage(textPage, { width: pc, maxRows: pr, yOffset: textRowOffset })
  textTotalRows = res.totalRows
  if (process.env.EDGE_TUI_DEBUG) {
    logErr(`[capture] 块 ${textPage.blocks.length} · 折叠 ${textPage.folds.length} · 控件 ${textPage.fields.length} · 排版 ${textPage.lines.length} 行（总 ${textTotalRows}）`)
  }
  const maxOff = Math.max(0, res.totalRows - pr)
  if (textRowOffset > maxOff) textRowOffset = maxOff

  // ── 二维码必须整块落在页面区里 ──
  // 它在文本流里的位置是页面决定的，很可能正好卡在页面区下沿 ——
  // 露一半的二维码手机解不出来（缺了左下定位角）。
  // 所以只要页面上有二维码、而它当前没被完整显示，就把行窗口对齐过去。
  //
  // 只在 textRowOffset === 0（刚打开页面）时做：用户自己滚动过之后
  // 再强行拉回去会很讨厌，而且每次滚动都会重跑 captureText。
  if (textRowOffset === 0 && pr > 0) {
    let acc = 0
    for (const l of textPage.lines) {
      if (l.qrCells) {
        const need = 1 + l.qrCells.rows          // 标签行 + 二维码本体
        if (acc + need > pr) {
          textRowOffset = Math.min(maxOff, Math.max(0, acc))
          if (debugMode) console.error(`[debug:text] 对齐二维码：行 ${acc}..${acc + need - 1}（页面区 ${pr} 行）`)
        }
        break
      }
      acc += renderedRowCount(l)
    }
  }

  mapLine = makeLineMapper(textPage, { yOffset: textRowOffset, pxPerRow: CELL_H, viewOffsetY: 0 })
  if (debugMode) {
    console.error(`[debug:text] blocks=${textPage.blocks.length} lines=${textPage.lines.length} total=${res.totalRows} off=${textRowOffset} vp=${viewW}x${viewH}`)
  }
  return true
}

// ── 只用内存里的排版结果重绘 ──
// 折叠内容的展开/收起走这条路：排版结果已经全在内存里，
// 展开只是「把折叠行的正文插进文本流」，不需要重新抓页面、不需要重新截图，
// 也不依赖站点 JS（点不到、点了跳转的风险都不存在）。
function rerenderText() {
  if (!textPage) return
  const pc = PAGE_COLS(), pr = PAGE_ROWS()
  const res = renderTextPage(textPage, {
    width: pc, maxRows: pr, yOffset: textRowOffset,
    activeFid: activeField ? activeField.fid : undefined,
  })
  textRows = res                       // 不更新它，鼠标命中就会用上一帧的行
  clickIndex = buildClickIndex(res.rows)
  textTotalRows = res.totalRows
  const maxOff = Math.max(0, res.totalRows - pr)
  if (textRowOffset > maxOff) textRowOffset = maxOff
  mapLine = makeLineMapper(textPage, { yOffset: textRowOffset, pxPerRow: CELL_H, viewOffsetY: 0 })
  paint()
}

/** 底部提示行里的折叠状态 */
function foldHint() {
  if (renderMode !== "text" || !textPage) return ""
  const folds = textPage.folds || []
  if (!folds.length) return ""
  const op = folds.filter((f) => foldOpen.has(f.id)).length
  return ` 折叠 ${op}/${folds.length} 处 (e) `
}

/** e：展开 / 收起本页的折叠内容 */
function toggleFolds() {
  if (renderMode !== "text") {
    statusKind = "err"
    status = "折叠展开只在文字模式下可用（按 m 切回文字模式）"
    paint()
    return
  }
  if (!textPage) return
  const folds = textPage.folds || []
  if (!folds.length) {
    const d = textPage.droppedHidden || 0
    statusKind = "info"
    status = d > 0
      ? `本页没有可展开的折叠内容（另有约 ${d} 字隐藏文本找不到对应控件，按 E 试页面侧展开）`
      : "本页没有检测到折叠内容"
    paint()
    return
  }
  const allOpen = folds.every((f) => foldOpen.has(f.id))
  if (allOpen) {
    foldOpen = new Set()
  } else {
    foldOpen = new Set(folds.map((f) => f.id))
  }
  const words = folds.reduce((a, f) => a + f.len, 0)
  applyFoldState(textPage, foldOpen, PAGE_COLS())
  elsCacheKey = null      // 展开/收起改变了可见元素，编号缓存作废
  statusKind = "ok"
  status = allOpen
    ? `已收起 ${folds.length} 处折叠内容`
    : `已展开 ${folds.length} 处折叠内容（共 ${words} 字，正文以暗色显示）`
  rerenderText()
}

/**
 * E：页面侧展开 —— 真的去点站点自己的「展开/更多」控件，然后重新提取。
 *
 * 为什么还需要它：文字层展开只能拿到**已经在 DOM 里**的内容。
 * 「查看更多评论」「加载更多」这类要靠点击后发请求才注入的内容，
 * 只能真点。这条路径有副作用（会动页面），所以做了防误操作过滤（见 cdp.js）。
 */
async function expandOnPage() {
  if (renderMode !== "text") {
    statusKind = "err"
    status = "页面侧展开只在文字模式下可用（按 m 切回文字模式）"
    paint()
    return
  }
  statusKind = "busy"
  status = "正在点开页面上的「展开 / 更多」控件…"
  paint()
  try {
    const n = await tab.expandPageControls()
    await new Promise((r) => setTimeout(r, 650))
    foldOpen = new Set()
    elsCacheKey = null
    await capture()
    const left = (textPage?.folds || []).length
    statusKind = "ok"
    status = `页面侧展开：解除截断 ${n.unclamped} 处 · 点击控件 ${n.clicked} 个（${(n.targets || []).slice(0, 3).join("/") || "无"}）· 余下折叠 ${left} 处`
  } catch (e) {
    logErr("expandOnPage:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
  }
  paint()
}

// ── 滚动 ──
// 关键修复：很多站点不用 body 滚动，而是把内容塞进一个固定高度的
// overflow:auto 容器（知乎的 .SignFlowHomepage：scrollHeight 1002 / clientHeight 224）。
// 此时 window.scrollBy 完全无效，window.scrollY 永远是 0，页面看起来「不能滚」。
// 所以每次滚动前先问页面「谁在滚」，再对正确的目标下手。
async function scrollPx(dy) {
  // 帮助面板是**在页面区里翻的**，不是滚页面
  if (helpVisible) {
    const per = Math.max(1, Math.round(dy / CELL_H))
    const bodyRows = Math.max(1, PAGE_ROWS() - 1)
    helpOffset = Math.max(0, Math.min(Math.max(0, HELP_ITEMS.length - bodyRows), helpOffset + per))
    paint()
    return
  }
  if (renderMode === "text") {
    if (!textPage) return
    // 文字模式的滚动是「行级」的：整页**已经在内存里排好版**了
    // （captureText 用 viewport:false 提取全文，媒体图也一次抓完），
    // 挪窗口就行 —— 不碰浏览器、不重新提取 DOM、不重新截图，瞬时完成。
    //
    // ⚠️ 这里以前写的是 `await capture()`，也就是**每滚一下都重新抓整页**
    // （含 waitContent 的内容稳定等待 + 每个媒体块重新截图）。
    // 用户的原话是「每动一下就要重新加载」—— 就是这一行造成的。
    // 文字模式下滚动**没有任何理由**碰浏览器。
    const pr = PAGE_ROWS()
    const maxOff = Math.max(0, textTotalRows - pr)
    const step = Math.round(dy / CELL_H)
    const next = Math.max(0, Math.min(maxOff, textRowOffset + step))
    if (next === textRowOffset) return
    textRowOffset = next
    rerenderText()
    return
  }
  if (!grid) return
  try {
    await tab.scrollTarget()
    await tab.scrollBy(dy)
    await new Promise((r) => setTimeout(r, 60))
  } catch (e) {
    logErr("scrollPx:", e?.stack || e)
  }
  await capture()
}

/** 按元素清单的第 idx 项滚动定位（元素清单模式用） */
async function scrollToEl(idx) {
  // ── 文字模式：完全不碰浏览器滚动 ──
  // 排版结果已经全在内存里，让页面滚动对显示毫无帮助，反而有副作用：
  // 页面一滚，之前提取的块坐标（布局坐标，见 extract.js）就和当前视口错位了。
  // 所以这里只挪「行窗口」，瞬时完成，也不重新抓页面。
  if (renderMode === "text" && textPage) {
    const el = pageEls[idx]
    if (el) {
      pickInfo = { ...el, i: idx }
      const map = makeLineMapper(textPage, { yOffset: 0, pxPerRow: CELL_H, viewOffsetY: 0 })
      const want = map(el.y, el.x)
      if (Number.isFinite(want)) {
        textRowOffset = Math.max(0, Math.min(Math.max(0, textTotalRows - PAGE_ROWS()), want - Math.floor(PAGE_ROWS() / 3)))
      }
      if (mode === "pick") {
        status = `元素清单 ${idx + 1}/${pageEls.length} · ${String(el.text || el.tag).slice(0, 30)} · ↑↓ 选择 · Enter 点击 · h 悬停 · Esc 退出`
      }
    }
    paint()
    return
  }

  try {
    const box = await tab.scrollElIntoView(idx)
    if (box) pickInfo = { ...pageEls[idx], ...box, i: idx }
  } catch (e) {
    logErr("scrollToEl:", e?.stack || e)
  }
  await capture()
}
async function goto(inp) {
  if (!inp) return
  const raw = inp.trim()
  if (raw.startsWith("/")) {
    const cmd = raw.slice(1).toLowerCase()
    switch (cmd) {
      case "reload": case "r":
        statusKind = "busy"; status = "正在刷新…"
        return capture(true)
      case "back": case "b":
        return prevPage()
      case "forward": case "f":
        return nextPage()
      case "top":
        return scrollPx(-100000)
      case "end":
        return scrollPx(100000)
      case "text":
        if (renderMode !== "text") return toggleRenderMode()
        statusKind = "info"; status = "已经是文字模式"
        return paint()
      case "image":
        if (renderMode !== "image") return toggleRenderMode()
        statusKind = "info"; status = "已经是图片模式"
        return paint()
      case "quit": case "q":
        return safeShutdown()
      // 书签 / 历史列表。列表视图直接替换页面区（listPageRows），Esc 退出。
      case "bm": case "bookmark": case "bookmarks":
        if (!bookmarks.length) {
          statusKind = "info"
          status = "书签还是空的 · 打开页面后按 B 收藏"
          return paint()
        }
        mode = "list"; listKind = "bm"; listSel = 0
        statusKind = "info"
        status = `书签 ${bookmarks.length} 条 · Enter 打开 · x 删除 · Esc 退出`
        return paint()
      case "his": case "history":
        if (!history.length) {
          statusKind = "info"
          status = "历史还是空的"
          return paint()
        }
        mode = "list"; listKind = "his"; listSel = 0
        statusKind = "info"
        status = `历史 ${history.length} 条 · Enter 打开 · x 删除 · Esc 退出`
        return paint()
      // 鼠标上报会接管终端的拖选行为。想复制屏幕文字时切掉它，
      // 比记住"按住 Shift"更直观（Shift 在很多终端里也有效，两条路都留着）。
      case "dl": case "download": case "downloads":
        statusKind = "ok"
        status = `下载目录：${DOWNLOAD_DIR}`
        return paint()
      case "copy": case "cp":
        if (copyToClipboard(curUrl)) {
          statusKind = "ok"
          status = `已复制网址：${curUrl}`
        } else {
          statusKind = "err"
          status = "复制失败：系统里找不到剪贴板命令（clip / pbcopy / xclip）"
        }
        return paint()
      case "pdf": case "print":
        return saveAsPdf()
      case "mouse":
        mouseOn = !mouseOn
        process.stdout.write(mouseOn ? MOUSE_ON : MOUSE_OFF)
        statusKind = "info"
        status = mouseOn
          ? "鼠标已启用 · 点链接/控件/折叠 · 滚轮翻页"
          : "鼠标已交还终端 · 现在可以拖选复制文字（: /mouse 再开）"
        return paint()
      default:
        statusKind = "err"; status = `未知命令: ${raw}`
        return paint()
    }
  }
  let u = raw.replace(/^(https?:\/\/)+(https?:\/\/)+/i, "$2")
  // file: / data: / about: 也要放行 —— 文字浏览器读本地 HTML 是刚需，
  // 而按"搜索词"处理会变成一次莫名其妙的必应搜索（曾经把 file:///… 搜成 NXDOMAIN）。
  if (!/^https?:\/\//i.test(u) && !/^(about|file|data|view-source):/i.test(u)) {
    // 无点号 / 含空格 → 当成搜索词。搜索地址由 searchUrlFor 统一构造，
    // 不要在这里再写一份（提交兜底也要用它，两份迟早会走偏）。
    u = /\s/.test(u) || !/\./.test(u) ? searchUrlFor(u) : `https://${u}`
  }
  requestedUrl = u
  statusKind = "busy"
  status = `正在打开 ${u}`
  startProgress("正在打开…")
  focusInfo = null
  activeField = null     // 换页了，旧控件已经不存在
  captureError = null
  elsCacheKey = null     // 元素编号全部作废（鼠标点击拿它做真实点击）
  lastVp = null   // 新页面重新设视口，确保布局按当前尺寸重算
  activeField = null
  pageEcho = ""
  rememberScroll()   // 离开当前页前记住它的位置，回头（后退）时能恢复
  try {
    // navigate 现在是「有界等待」：它**不会**为了等 load 事件把我们卡住，
    // 返回的是"我等到什么程度"（ready / stable / timeout / error）。
    const nav = await tab.navigate(u, { timeoutMs: NAV_TIMEOUT_MS })
    navState = nav
    if (nav.state === "timeout") {
      logErr(`[nav] 超时 ${nav.ms}ms（已提取 ${nav.textLen} 字）：${u}`)
    } else if (nav.errorText) {
      logErr(`[nav] 错误 ${nav.errorText}：${u}`)
    }
  } catch (e) {
    logErr("goto navigate:", e?.stack || e)
  }
  await capture(true)
}

async function enterPicker() {
  statusKind = "busy"
  status = "正在枚举页面可交互元素…"
  paint()
  try {
    // 每次收集前重置滚动目标缓存，避免跨页残留
    await tab.scrollTarget()
    // 枚举全页元素（不限视口）：文字模式的页面区行数有限，很多入口在折叠线以下。
    // 列表里全部列出，选中时自动滚动定位，用户不必先猜要滚到哪里。
    const all = await tab.enumerateInteractive(viewW, viewH)
    if (!all.length) {
      statusKind = "err"
      status = "页面上没有可交互元素"
      paint()
      return
    }
    pageEls = all
    // 优先从视口内的第一个元素开始，避免一进来就跳走
    const firstVp = all.findIndex((e) => e.inVp)
    mode = "pick"
    pickInfo = all[firstVp >= 0 ? firstVp : 0]
    statusKind = "ok"
    status = `元素清单：共 ${all.length} 项（视口内 ${all.filter((e) => e.inVp).length}）· ↑↓ 选择 · Enter 点击 · Esc 退出`
    await refreshPicker()
  } catch (e) {
    logErr("enterPicker:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

/**
 * 只重画当前内容。
 * 文字模式：整页已在内存 → 纯重排（不碰浏览器）。
 * 图片模式：像素网格只能按视口重截 → 必须重新 capture。
 *
 * ⚠️ 新增"只改变显示层"的操作时一律用它，别直接写 `capture()` ——
 * 那会变成"每动一下都要重新加载"（见坑 #49）。
 */
function redraw() {
  if (renderMode === "text" && textPage) { rerenderText(); return Promise.resolve() }
  return capture()
}

/** 重新抓取并叠加元素标记 */
async function refreshPicker() {
  // 元素清单只是在**已有的排版结果**上叠加标记 —— 文字模式下没有理由重抓页面。
  // 直接 capture() 的话：按下 v 就要重新提取 DOM + 给每个媒体块重新截图，
  // 又是"动一下就重新加载"。
  await redraw()
  // 文字模式不印逐项编号 —— 页面上直接就是可读文字，几十个编号会盖住内容。
  // 只画「视口内可交互行」的 · 标记与当前选中行的 ▸ + 底色（见 overlayRuns）。
  paint()
}

/** 在网格上叠加编号标签与当前选中框（图片模式） */
function stampPickerOverlayGrid() {
  if (!grid || !pageEls.length) return
  const w = grid.cols, h = grid.rows
  const put = (x, y, ch, col) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const gi = y * w + x
    grid.chars[gi] = ch.charCodeAt(0)
    grid.color[gi * 3] = col[0]; grid.color[gi * 3 + 1] = col[1]; grid.color[gi * 3 + 2] = col[2]
  }
  const putStr = (x, y, s, col) => {
    for (let i = 0; i < s.length; i++) put(x + i, y, s[i], col)
  }
  // 只给「视口内」的元素打编号：全页动辄几十上百项，
  // 全打上去会把画面糊死，反而看不清。视口外的靠 ↑↓ 选中时自动滚入。
  for (const el of pageEls) {
    if (!el.inVp) continue
    const x = Math.floor(el.x / CELL_W)
    const y = Math.floor(el.y / CELL_H)
    const label = String(el.i + 1)
    putStr(Math.max(0, x), Math.max(0, y), label, [239, 199, 103])
  }
  // 选中项：高亮边框（用与视口的交集，避免元素部分在视口外时框子画到屏幕外）
  if (pickInfo) {
    const sx = pickInfo.visX !== undefined ? pickInfo.visX : pickInfo.x
    const sy = pickInfo.visY !== undefined ? pickInfo.visY : pickInfo.y
    const sw = pickInfo.visW !== undefined ? pickInfo.visW : pickInfo.w
    const sh = pickInfo.visH !== undefined ? pickInfo.visH : pickInfo.h
    if (sw > 0 && sh > 0) {
      const x0 = Math.floor(sx / CELL_W)
      const x1 = Math.ceil((sx + Math.max(sw, CELL_W)) / CELL_W)
      const y0 = Math.floor(sy / CELL_H)
      const y1 = Math.ceil((sy + Math.max(sh, CELL_H)) / CELL_H)
      for (let x = Math.max(0, x0); x < Math.min(x1, w); x++) {
        put(x, y0, "#", [239, 130, 98])
        put(x, y1 - 1, "#", [239, 130, 98])
      }
      for (let y = Math.max(0, y0); y < Math.min(y1, h); y++) {
        put(x0, y, "#", [239, 130, 98])
        put(x1 - 1, y, "#", [239, 130, 98])
      }
    }
  }
}

/**
 * 文字模式的元素清单叠加。
 * 与图片模式的关键差异：**没有「像素 → 列」的线性映射** ——
 * 一个终端格是一个汉字/字母，位置由折行决定。所以不再画按像素算出来的方框，
 * 改为「整行铺底色 + 行首标记」（见 textbrowser.js#overlayRuns 的注释）。
 * y 走 mapLine（makeLineMapper，跟着真实文字行，不是 8px 像素条）。
 */
function stampPickerOverlayText() {
  if (!textPage || !textRows) return
  const pc = PAGE_COLS()
  if (!mapLine) return
  overlayRuns({
    rows: textRows.rows,
    width: pc,
    els: pageEls,
    showNumbers: true,
    pickInfo,
    focusInfo,
    lineOfY: mapLine,
    pxPerRow: CELL_H,
  })
  // 叠加层改了 rows 的引用内容，但 textRows.rows 与 buildRows 取的是同一份，
  // 所以这里不需要回写；直接让 buildRows 重新读一次即可。
}

// ── 页内查找（/ 进入，Enter 定位，n/N 跳转，Esc 取消高亮）──
//
// 整页排版结果已经在内存里（buildTextPage viewport:false），所以查找**纯内存**：
// 在 textPage.lines 上匹配，命中行的「渲染行号」用 renderedRowCount 记账累加出来
// （与二维码对齐用的是同一套行数账本，不会漂移）。不碰浏览器、不重新抓页。

function enterFind() {
  if (renderMode !== "text" || !textPage) {
    statusKind = "err"
    status = "页内查找只在文字模式下可用（按 m 切回文字模式）"
    return paint()
  }
  mode = "find"
  inputValue = findQuery        // 沿用上次的查找词（vim 惯例，改一个字母比重打快）
  statusKind = "info"
  status = "页内查找 · 输入关键词回车定位 · Esc 取消"
  paint()
}

function runFind(q) {
  findHits = []
  findCur = -1
  findQuery = q
  if (!q) { statusKind = "info"; status = "已清除查找高亮"; rerenderText(); return }
  const needle = q.toLowerCase()
  let acc = 0
  for (const l of textPage.lines) {
    if (l.type === "text" && typeof l.text === "string" && l.text.toLowerCase().includes(needle)) {
      findHits.push(acc)
    }
    acc += renderedRowCount(l)
  }
  if (!findHits.length) {
    statusKind = "info"
    status = `本页未找到「${q}」`
    return paint()
  }
  findGoto(0)
}

function findGoto(i) {
  if (!findHits.length) return
  findCur = ((i % findHits.length) + findHits.length) % findHits.length
  const row = findHits[findCur]
  const pr = PAGE_ROWS()
  textRowOffset = Math.max(0, Math.min(Math.max(0, textTotalRows - pr), row - Math.floor(pr / 3)))
  statusKind = "ok"
  status = `「${findQuery}」 第 ${findCur + 1}/${findHits.length} 处 · n 下一个 · N 上一个 · Esc 取消高亮`
  rerenderText()
}

function findNext(dir) {
  if (!findHits.length) {
    statusKind = "info"
    status = "还没有查找结果 · 按 / 查找"
    return paint()
  }
  findGoto(findCur + dir)
}

function clearFind() {
  if (!findHits.length && !findQuery) return paint()
  findHits = []
  findCur = -1
  findQuery = ""
  if (renderMode === "text" && textPage) rerenderText()
  else paint()
}

/** 查找高亮：命中行整行铺底色（当前命中更亮）。每次 paint 前盖章，幂等。 */
function stampFindOverlay() {
  if (!textRows) return
  const curAbs = findCur >= 0 && findCur < findHits.length ? findHits[findCur] : -1
  const hitSet = new Set(findHits)
  const rows = textRows.rows
  for (let i = 0; i < rows.length; i++) {
    const abs = textRowOffset + i
    if (!hitSet.has(abs)) continue
    const bg = abs === curAbs ? FIND_BG_CUR : FIND_BG
    // ⚠️ 必须展开原 run：run 上挂着 src（鼠标命中用的来源块），只写 t/bg 会抹掉它
    rows[i] = rows[i].map((r) => ({ ...r, bg }))
  }
}

// ── 按键处理 ──

/**
 * 这个按键是不是「要当成普通文字」的？
 *
 * 解码层现在会产出**带修饰键**的 char 事件（Ctrl+A、Ctrl+W…）。
 * 它们**不是文字** —— 不挡掉的话，Ctrl+A 会在输入框里打出一个字面量 "a"，
 * 页面输入模式更是会把 Ctrl+A 当成「选中全部 + 打了个 a」。
 */
function isPlainChar(key) {
  return key.name === "char" && key.sequence >= " " && !key.ctrl && !key.alt
}

/**
 * 聚焦地址栏（Ctrl+L）—— 像浏览器那样：把当前网址带出来并全选，
 * 打完第一个字就把它替换掉。
 */
function focusAddressBar() {
  mode = "goto"
  inputValue = curUrl || ""
  inputSelectAll = true
  statusKind = "info"
  status = "地址栏 · 直接输入新地址即可覆盖当前网址 · Esc 取消"
  paint()
}

/** 刷新当前页 */
function reload() {
  statusKind = "busy"
  status = "正在刷新…"
  elsCacheKey = null
  capture(true).catch(() => {})
}

/**
 * 复制到系统剪贴板。
 *
 * 真浏览器里地址栏的网址是可以直接复制的；终端里鼠标选中会被鼠标上报抢走，
 * 所以这里给一条明确的通路。
 *
 * 各平台用的命令不一样：Windows 是 clip，macOS 是 pbcopy，
 * Linux 上 xclip / wl-copy / xsel 都有可能（挨个试）。
 */
function copyToClipboard(text) {
  const t = String(text || "")
  if (!t) return false
  const candidates = process.platform === "win32"
    ? [["clip", []]]
    : process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
  for (const [cmd, args] of candidates) {
    try {
      const c = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
      c.on("error", () => {})
      c.stdin.write(t)
      c.stdin.end()
      return true
    } catch { /* 试下一个 */ }
  }
  return false
}

/** 存成 PDF（真浏览器的「打印 → 存为 PDF」） */
async function saveAsPdf() {
  try {
    statusKind = "busy"
    status = "正在生成 PDF…"
    paint()
    const data = await tab.printToPdf()
    const dir = path.join(DATA_DIR, "pdf")
    fs.mkdirSync(dir, { recursive: true })
    const base = (title || safeHost(curUrl) || "page")
      .replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60)
    const file = path.join(dir, `${base}.pdf`)
    fs.writeFileSync(file, Buffer.from(data, "base64"))
    statusKind = "ok"
    status = `已存为 PDF → ${file}`
    paint()
  } catch (e) {
    statusKind = "err"
    status = `生成 PDF 失败：${String(e?.message || e).slice(0, 46)}`
    paint()
  }
}

/**
 * 页面输入相关的异步操作：**出错要说出来**。
 *
 * 这些操作以前全是 `.catch(() => {})` —— 静默失败。
 * 症状是「我按了 Ctrl+A / 方向键 / Home，没反应」，界面却毫无线索，
 * 是最难自查的一类问题（和「'Page.goBack' wasn't found」一个路数：
 * 错误被吞掉之后，只剩下"按了没反应"这个没法定位的现象）。
 */
function pageOp(promise, what) {
  Promise.resolve(promise).catch((e) => {
    statusKind = "err"
    status = `${what}失败：${String(e?.message || e).slice(0, 46)}`
    paint()
  })
}

function handleKey(key) {
  if (mode === "pick") {
    if (key.name === "escape") {
      mode = "normal"
      pickInfo = null
      if (dragFrom) {
        dragFrom = null
        status = "已取消拖拽"
      } else {
        status = "已退出元素清单"
      }
      statusKind = "info"
      // 只是去掉叠加的标记，页面内容没变 —— 别整页重抓
      redraw()
      return
    }
    if (key.name === "down" || (key.name === "char" && (key.sequence === "j" || key.sequence === "J"))) {
      pickMove(1)
      return
    }
    if (key.name === "up" || (key.name === "char" && (key.sequence === "k" || key.sequence === "K"))) {
      pickMove(-1)
      return
    }
    if (key.name === "return") {
      // 文件控件按 Enter 不是「点击」而是「选文件」—— 真实浏览器里点它开的
      // 就是文件选择器；TUI 里原生 chooser 毫无意义，直接进上传流程。
      if (pickInfo && pickInfo.tag === "INPUT" && pickInfo.type === "file") {
        pickUploadStart()
      } else {
        pickActivate()
      }
      return
    }
    // d = 双击（真实连击语义：dblclick 事件 + 选中文本）
    if (key.name === "char" && key.sequence === "d") {
      pickDblClick()
      return
    }
    // g = 拖拽：第一次按标记起点，移到目标元素再按一次落下。
    // 滑块验证码、拖拽排序列表都是「按住 → 移动 → 松开」的三段真实鼠标序列。
    if (key.name === "char" && key.sequence === "g") {
      pickDrag()
      return
    }
    // u = 上传（仅文件控件）：输入本地路径 → CDP 写入
    if (key.name === "char" && key.sequence === "u") {
      pickUploadStart()
      return
    }
    // h = 悬停（不点击）。大量导航菜单/下拉/提示是 hover 展开的 ——
    // 真实浏览器里鼠标移过去就出现，这里用 mouseMoved 等价模拟；
    // hover 展开的子菜单随后可以用 ↑↓/Enter 点击（鼠标停在子项上时
    // 浏览器会保持父菜单的 hover 链，与真实浏览器行为一致）。
    if (key.name === "char" && key.sequence === "h") {
      pickHover()
      return
    }
    // 元素清单模式下也允许展开/收起折叠内容 —— 它和"选中哪个元素"无关
    if (key.name === "char" && key.sequence === "e") { toggleFolds(); return }
    if (key.name === "char" && key.sequence === "E") { expandOnPage(); return }
    return
  }

  if (mode === "find") {
    if (key.name === "escape") {
      mode = "normal"
      inputValue = ""
      statusKind = "info"
      status = "已取消查找"
      paint()
      return
    }
    if (key.name === "return") {
      const v = inputValue.trim()
      mode = "normal"
      inputValue = ""
      runFind(v)        // 空串 = 清除高亮
      return
    }
    if (key.name === "backspace") { inputValue = inputValue.slice(0, -1); paint(); return }
    if (isPlainChar(key)) { inputValue += key.sequence; paint() }
    return
  }

  // ── 书签 / 历史列表视图 ──
  if (mode === "list") {
    if (key.name === "escape" || (key.name === "char" && key.sequence === "q")) {
      mode = "normal"
      listKind = null
      statusKind = "info"
      status = "就绪"
      paint()
      return
    }
    if (key.name === "up" || (key.name === "char" && key.sequence === "k")) { listMove(-1); return }
    if (key.name === "down" || (key.name === "char" && key.sequence === "j")) { listMove(1); return }
    if (key.name === "return") {
      const items = listKind === "bm" ? bookmarks : history
      const it = items[listSel]
      if (!it) return
      mode = "normal"
      listKind = null
      goto(it.u).catch((e) => { statusKind = "err"; status = String(e?.message || e); paint() })
      return
    }
    if (key.name === "char" && (key.sequence === "x" || key.sequence === "d")) { listDelete(); return }
    return
  }

  if (mode === "pageinput") {
    if (key.name === "escape") {
      // 对齐真实浏览器：失焦时发 change —— 站点大量校验（手机号格式、
      // 联动下拉、表单状态）挂在 change 上，只发 input 的话退出输入模式
      // 后站点毫无反应。只发 change 不动焦点（发 blur 会搅乱站点焦点逻辑）。
      const f = activeField
      mode = "normal"
      activeField = null
      pageEcho = ""
      statusKind = "info"
      status = "已退出输入模式"
      if (f?.fid != null) {
        // change 可能引发站点联动（联动下拉、校验提示）—— 轻量回读刷新显示
        tab.fireChange(f.fid)
          .then(() => syncActiveField(true))
          .then(() => { paint() })
          .catch(() => {})
      }
      paint()
      return
    }
    // ── 焦点还没解析完（刚按 i）──
    // 这段时间里用户的按键**先存起来**，绝不能落进 normal 分支：
    // 拼音首字母里 c/e/s/h/i 恰好都是快捷键，e 会去展开折叠、h 会直接后退一页。
    // 症状就是"按 i 之后打的头几个字跑到别的地方去了"。
    if (inputPending) {
      if (isPlainChar(key)) pendingKeys.push({ kind: "char", ch: key.sequence })
      else if (key.name === "backspace") pendingKeys.push({ kind: "backspace" })
      else if (key.name === "return") pendingKeys.push({ kind: "return" })
      paint()
      return
    }
    if (key.name === "return") {
      // 回车 = 提交。这里主动退出输入模式：提交后页面会跳走，控件已经不存在了，
      // 留在输入模式会让下一次按键打到一个不存在的元素上。
      pageSubmit()
      return
    }
    if (key.name === "backspace") {
      pageBackspace()
      return
    }
    // ↑↓：搜索建议下拉（必应/百度都有）；左右：文本光标。
    // 焦点在原生 <select> 上时 ↑↓ 改选项（真实浏览器同款），发 input+change。
    if (key.name === "up" || key.name === "down") {
      const d = key.name === "up" ? -1 : 1
      if (activeField?.tag === "SELECT") {
        tab.selectStep(activeField.fid, d).then((v) => {
          if (v === null) return            // 到头/到底，不动
          activeField.value = v
          pageEcho = v
          statusKind = "ok"
          status = `已选：${v} · Esc 退出`
          paint()
          scheduleShot(320)
        }).catch((e) => {
          statusKind = "err"
          status = `选择失败：${String(e?.message || e).slice(0, 46)}`
          paint()
        })
        return
      }
      pageOp(tab.pressArrow(key.name, key.shift ? 8 : 0).then(() => scheduleShot(320)), "方向键")
      return
    }
    if (key.name === "left" || key.name === "right") {
      pageOp(tab.pressArrow(key.name, key.shift ? 8 : 0).then(() => scheduleShot(200)), "方向键")
      return
    }
    // 编辑键：输入框内的 Home/End/Delete/翻页（传统浏览器里直接作用于焦点控件）
    if (/^(home|end|delete|pageup|pagedown)$/.test(key.name || "")) {
      pageOp(tab.pressEditKey(key.name).then(() => scheduleShot(200)), "编辑键")
      return
    }
    // Ctrl 组合进页面（Ctrl+C 全局退出 / Ctrl+V 粘贴另有通道，不在这里）：
    // Ctrl+A 全选、Ctrl+Z 撤销 —— 富文本/多行输入必备
    if (key.ctrl && /^(a|z)$/.test(key.sequence || "")) {
      // ⚠️ pressCombo 要的是**字母本身**（"a"/"z"），不是 key.name
      // （key.name 是 "char"）—— 传错的话 pressCombo 查表查不到，直接静默返回。
      pageOp(tab.pressCombo(key.sequence, 2).then(() => scheduleShot(200)), "Ctrl 组合键")
      return
    }
    // Tab：换到下一个控件（页面原生 Tab 顺序），换完按 data-etui-field 反查是谁，
    // 否则状态栏会一直显示上一个控件的名字。
    if (key.name === "tab") {
      if (key.ctrl) { cycleTab(key.shift ? -1 : 1); return }
      tab.pressTab().then(async () => {
        try {
          const info = await tab.activeRect()
          if (info) {
            focusInfo = info
            const nf = resolveField(info.fid)
            // 焦点可能被 Tab 带到了一个**不是输入框**的元素（按钮/链接）上。
            // 那种情况下继续当输入模式用会让打字全部落空，如实说出来更有用。
            if (nf && !nf.btn) {
              activeField = nf
              pageEcho = String(nf.value ?? "")
              status = `输入模式 · ${fieldName(activeField)} · Esc 退出`
            } else {
              activeField = null
              pageEcho = ""
              status = `焦点已移到（不可输入的）${(info.tag || "元素").toLowerCase()} · 再按 Tab 继续 · Esc 退出`
            }
          }
        } catch {}
        scheduleShot(220)
      }).catch((e) => {
        statusKind = "err"
        status = `切换控件失败：${String(e?.message || e).slice(0, 46)}`
        paint()
      })
      return
    }
    if (isPlainChar(key)) {
      // 只重绘，不整页重抓 —— 见 syncActiveField 的注释
      typeIntoField(key.sequence)
    }
    return
  }

  if (mode !== "normal") {
    if (key.name === "escape") {
      mode = "normal"
      inputValue = ""
      inputSelectAll = false
      statusKind = "info"
      status = "就绪"
      paint()
      return
    }
    if (key.name === "return") {
      const v = inputValue
      const wasUpload = mode === "upload"
      mode = "normal"
      inputValue = ""
      inputSelectAll = false
      if (wasUpload) {
        if (v.trim()) uploadFiles(v.trim())
        else paint()
        return
      }
      if (v.trim()) goto(v.trim()).catch((e) => { statusKind = "err"; status = String(e?.message || e); paint() })
      else paint()
      return
    }
    if (key.name === "backspace") { inputValue = inputValue.slice(0, -1); paint(); return }
    if (isPlainChar(key)) {
      if (inputSelectAll) {
        // 地址栏「全选待替换」：第一个字直接把整个网址盖掉（和浏览器一致）
        inputValue = key.sequence
        inputSelectAll = false
      } else {
        inputValue += key.sequence
      }
      paint()
    }
    return
  }

  switch (key.name) {
    // Esc = 停止加载（浏览器的"停止"按钮）。
    // 之前没有任何中断手段：一旦某页卡在等子资源/抓图上，只能干等或退出程序。
    case "escape":
      if (busy) stopCapture()
      else if (helpVisible) { toggleHelp() }
      else if (findHits.length || findQuery) {
        clearFind()
        statusKind = "info"
        status = "已取消查找高亮"
        paint()
      }
      else { statusKind = "info"; status = "就绪"; paint() }
      break
    case "char":
      // Ctrl 组合：标签页相关（参考 OpenCode V2 TUI）
      //
      // ⚠️ 只有**报修饰键的终端**（Windows Terminal / kitty 协议的 CSI-u、
      // 或 win32 输入模式）才送得出 Ctrl+数字 / Ctrl+Tab —— 传统终端里
      // 它们和普通数字、Tab 是同一个字节。所以下面还有一套单键退路。
      if (key.ctrl) {
        // Ctrl+Shift+T（重开）与 Ctrl+T（新建）要分开：
        // CSI-u 终端能区分（sequence 是 "T" / "t"）；
        // 只发原始字节的终端里 Ctrl+T 与 Ctrl+Shift+T 是同一个字节（0x14），
        // 那种情况下按 Ctrl+T 走"新建"（更常用），重开留给单键 "T"。
        if (key.sequence === "T") { reopenTab().catch(() => {}); break }
        if (key.sequence === "t") { newTab().catch(() => {}); break }
        if (key.sequence === "w" || key.sequence === "W") { closeTab(activeTab); break }
        // 浏览器习惯键位
        if (key.sequence === "l" || key.sequence === "L") { focusAddressBar(); break }
        if (key.sequence === "r" || key.sequence === "R") { reload(); break }
        if (key.sequence === "f" || key.sequence === "F") { enterFind(); break }
        if (key.sequence === "d" || key.sequence === "D") { addBookmark(); break }
        if (/^[0-9]$/.test(key.sequence)) {
          // Ctrl+1..9 跳到第 n 个标签页，Ctrl+0 跳到第 10 个
          const n = key.sequence === "0" ? 10 : Number(key.sequence)
          switchTab(n - 1)
          break
        }
        break
      }
      switch (key.sequence) {
        case "q": safeShutdown(); break
        // 页内查找（vim 惯例）：/ 进入，n/N 在命中间跳转
        case "/": case "／": enterFind(); break
        case "n": findNext(1); break
        case "N": findNext(-1); break
        // B（大写）= 收藏当前页；小写 b 已被后退占用
        case "B": addBookmark(); break
        // 文字模式下 j/k 走「一行/两行文本」，而不是像素 —— 文本行高比像素行大得多
        case "j": case "J": scrollPx(renderMode === "text" ? 2 * CELL_H * 2 : CELL_H * 2); break
        case "k": case "K": scrollPx(renderMode === "text" ? -2 * CELL_H * 2 : -CELL_H * 2); break
        case "d": scrollPx(Math.floor(PAGE_ROWS() / 2) * CELL_H); break
        case "u": scrollPx(-Math.floor(PAGE_ROWS() / 2) * CELL_H); break
        case "g": scrollPx(-100000); break
        case "G": scrollPx(100000); break
        case "r": reload(); break
        case "i": case "I": enterPageInput(); break
        case "v": case "V": enterPicker(); break
        case "m": case "M": toggleRenderMode(); break
        case "o":
          mode = "goto"
          inputValue = ""
          statusKind = "info"
          status = "输入网址，回车打开，Esc 取消"
          paint()
          break
        case ":": case "：":
          mode = "cmd"
          inputValue = ""
          statusKind = "info"
          status = "命令: /reload /back /forward /top /end /bm /his /mouse /quit"
          paint()
          break
        case "b": case "h": prevPage(); break
        case "f": case "l": nextPage(); break
        case "?": case "？": toggleHelp(); break
        // 标签页退路：终端不报修饰键时（传统 conhost 不发 CSI-u），
        // 用单键操作，语义与 Ctrl+* 一致。
        case "t": newTab().catch(() => {}); break
        case "T": reopenTab().catch(() => {}); break
        case "w": closeTab(activeTab); break
        case "[": cycleTab(-1); break
        case "]": cycleTab(1); break
        default:
          if (/^[0-9]$/.test(key.sequence)) {
            const n = key.sequence === "0" ? 10 : Number(key.sequence)
            switchTab(n - 1)
          }
          break
      }
      break
    // Backspace = 后退。浏览器后来因为"焦点在表单里误触"取消了这个键位，
    // 但文字浏览器里没有任何输入焦点可言，它是最顺手的后退键。
    // （实盘：用户报「无法使用 back」，一部分是漏导入导致的假象，见 capture()；
    //   但把 Backspace 接上后退，这条路径才算真正闭环。）
    case "backspace": prevPage(); break
    case "down": scrollPx(CELL_H * 2); break
    case "up": scrollPx(-CELL_H * 2); break
    case "home": scrollPx(-100000); break
    case "end": scrollPx(100000); break
    case "right": nextPage(); break
    case "left": prevPage(); break
    case "tab":
      if (key.ctrl) { cycleTab(key.shift ? -1 : 1); break }
      focusNext(1); break
    case "shift-tab":
      if (key.ctrl) { cycleTab(-1); break }
      break
    case "return": openFocused(); break
  }
}

function toggleHelp() {
  helpVisible = !helpVisible
  if (helpVisible) helpOffset = 0
  statusKind = "info"
  status = helpVisible ? "按键说明 · j/k 翻页 · ? 或 Esc 关闭" : "就绪"
  paint()
}

// ── 表单控件：聚焦与输入 ─────────────────────────────────────────
//
// 用户投诉：「Bing 页面看不到搜索的输入框，无法搜索」。
// 提取层与渲染层已经让控件看得见了（extract.js 的 kind:'field' + 控件行渲染），
// 这里负责「打得进」。
//
// 旧逻辑是「先按 Tab 聚焦输入框再按 i」—— 这在必应首页是死路：
// 用户根本看不出哪个是搜索框（文字模式里它压根没显示），
// Tab 顺序也不一定把它排在前面，于是卡在提示里出不来。
// 现在按 i **直接聚焦页面的主搜索框**（按 score 判定，见 extract.js）。

function pageFields() {
  if (!textPage) return []
  return (textPage.fields || []).filter((f) => f && f.kind === "field")
}

/** 页面上的「主输入框」：分数最高且可编辑的那个（必应首页就是搜索框） */
function primaryField() {
  const cands = pageFields().filter((f) => !f.btn && !f.disabled && !f.readonly)
  if (!cands.length) return null
  return cands.slice().sort((a, b) => (b.score - a.score) || (a.y - b.y))[0]
}

/** 按 data-etui-field 编号反查控件块（换页后编号会重排，必须重新查） */
function resolveField(fid) {
  if (fid === null || fid === undefined) return null
  return pageFields().find((f) => String(f.fid) === String(fid)) || null
}

function fieldName(f) {
  if (!f) return ""
  const nm = fieldDisplayName(f)
  return fieldKindName(f) + (nm ? "「" + nm.slice(0, 20) + "」" : "")
}

function startPageInput(f, info) {
  activeField = f || null
  if (info) focusInfo = info
  mode = "pageinput"
  pageEcho = String(f?.value ?? "")
  statusKind = "ok"
  status = `输入模式 · ${fieldName(f) || "页面控件"} · 打字直接进页面 · Enter 提交 · Esc 退出`
  revealFieldRow(f)
  paint()
}

/**
 * 把控件所在的那一行带进可视窗口。
 *
 * 为什么：按 i 之后用户会立刻开始打字，但如果控件行正好在页面区之外
 * （长页面、或者用户之前滚过），屏幕上**什么都看不到** —— 打进去的字、
 * 甚至"正在输入的控件"高亮全在视野外。用户会判定成"输入法/输入框坏了"。
 * 底部输入框的本地回显是第一层保险，这是第二层。
 */
function revealFieldRow(f) {
  if (!f || !textPage || renderMode !== "text") return
  const pr = PAGE_ROWS()
  // 行号一律问 fieldRowInPage（它和 renderTextPage 共用 renderedRowCount 记账）。
  // 不要在 run.mjs 里自己再算一遍 —— 两处记账迟早会漂移（见坑 #40）。
  const want = fieldRowInPage(textPage, f.fid)
  if (want < 0) return
  const maxOff = Math.max(0, textTotalRows - pr)
  if (want < textRowOffset || want >= textRowOffset + pr) {
    textRowOffset = Math.max(0, Math.min(maxOff, want - Math.floor(pr / 3)))
  }
}

/** 按 i 进入输入模式（焦点解析是异步的，期间按键会被缓冲，见 enterPageInput） */
async function enterPageInput() {
  if (mode === "pageinput" || inputPending) return
  // ⚠️ 先切模式再解析焦点：解析要跑两三个 CDP 往返（几十毫秒），
  // 期间用户已经开始打字了。留在 normal 模式下，这些字会被当成快捷键 ——
  // 拼音首字母 c/e/s/h/i 里 e 是"展开折叠"、h 是"后退一页"。
  mode = "pageinput"
  inputPending = true
  pendingKeys = []
  activeField = null
  pageEcho = ""
  statusKind = "busy"
  status = "正在聚焦页面输入框…"
  paint()

  let ok = false
  try {
    // ① 页面上已经聚焦着某个输入控件 → 直接进
    let cur = null
    try { cur = await tab.activeRect() } catch {}
    if (cur && cur.fid !== null && cur.fid !== undefined) {
      const f = resolveField(cur.fid)
      if (f && !f.btn) { startPageInput(f, cur); ok = true }
    }
    // ② 页面有主输入框 → 直接聚焦它（必应/百度/淘宝的搜索框都走这条）
    if (!ok) {
      const f = primaryField()
      if (f) {
        let info = null
        try {
          const r = await tab.focusField(f.fid)
          if (r && r.ok) info = { ...r, text: fieldName(f) }
        } catch (e) { logErr("focusField:", e?.stack || e) }
        if (info) { startPageInput(resolveField(f.fid) || f, info); ok = true }
      }
    }
    // ③ 都没有 → 退回「Tab 一次再看」的老路
    if (!ok) {
      try { await focusNext(1) } catch {}
      let cur2 = null
      try { cur2 = await tab.activeRect() } catch {}
      if (cur2 && cur2.fid !== null && cur2.fid !== undefined) {
        const f2 = resolveField(cur2.fid)
        if (f2 && !f2.btn) { startPageInput(f2, cur2); ok = true }
      }
    }
    if (!ok) {
      mode = "normal"
      statusKind = "err"
      status = pageFields().length ? "本页控件都不可输入（禁用/只读）"
        : "本页没有输入框 · 按 v 用元素清单找可交互元素"
    }
  } catch (e) {
    logErr("enterPageInput:", e?.stack || e)
    mode = "normal"
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
  } finally {
    inputPending = false
    paint()
  }

  // 解析期间打进来的键：按原顺序补送，一个都不丢
  const buffered = pendingKeys
  pendingKeys = []
  for (const k of buffered) {
    if (!ok) break
    if (k.kind === "char") await typeIntoField(k.ch)
    else if (k.kind === "backspace") await pageBackspace()
    else if (k.kind === "return") { await pageSubmit(); break }
  }
  if (buffered.length && ok) {
    statusKind = "ok"
    status = `输入模式 · ${fieldName(activeField)} · 补送了 ${buffered.length} 个按键 · Enter 提交 · Esc 退出`
    paint()
  }
}

/** 把读回来的值写进块 + 重绘 + 更新状态栏。f/value 都可能为 null（控件没了） */
function applyFieldValue(f, v, before) {
  if (v === null) {
    // 控件从 DOM 里消失了：多半是页面已经跳走
    statusKind = "info"
    status = "控件已随页面变化消失 · Esc 退出输入模式 · 按 r 刷新"
    mode = "normal"
    activeField = null
    pageEcho = ""
    paint()
    return false
  }
  if (v === before) {
    // 连 DOM 级注入都没改动值 —— 这种情况必须说出来，不能装作成功。
    // 静默失败正是这一整轮投诉的根源。
    if (via === VIA.DOM) {
      statusKind = "err"
      status = "该控件拒绝输入（站点自绘 / 被拦截）· 试试按 v 用元素清单点击它"
      paint()
    }
    return false
  }
  f.value = v
  pageEcho = v
  paint()
  statusKind = "ok"
  const healed = via === VIA.REFOCUS ? "（已自动重新聚焦）" : via === VIA.DOM ? "（已改用 DOM 输入）" : ""
  status = `输入模式 · ${fieldName(f)} · ${v ? v.length + " 字：" + v.slice(-24) : "空"}${healed} · Enter 提交 · Esc 退出`
  return true
}

/**
 * 打字/退格串行化。
 *
 * 每一键都要跑「查焦点 → 送 → 读回」好几次 CDP 往返，若让它们并发跑，
 * 前一个键的"修焦点"还没落地、后一个键已经开始判断"焦点在不在"，
 * 读数就会互相干扰。串行化把「按键顺序 = 落地顺序」变成保证，
 * 而不是碰巧成立。队列里出错不会卡住后续按键。
 */
let inputQueue = Promise.resolve()
function queueInput(fn) {
  inputQueue = inputQueue
    .then(fn)
    .catch((e) => logErr("queueInput:", e?.stack || e))
  return inputQueue
}

/**
 * 打字：**带校验**的输入（真正的实现在 src/inputpath.js，那里可离线单测）。
 *
 * 为什么不能只发一次 `Input.insertText` 就完事：
 * 它在「焦点不在控件上」时是**静默无效**的 —— 不抛错、值也不变。
 * 表现出来就是用户说的「输入的内容在搜索框里显示不出来」，
 * 随后「退格也删不掉」（本来就没进去），
 * 最后「搜索结果出不来」（提交的是空值）。三个症状其实是同一个根因。
 */
function typeIntoField(ch) {
  return queueInput(async () => {
    const f = activeField
    if (!f || !tab) return
    const before = String(f.value ?? "")
    let r
    try { r = await typeIntoFieldRaw(tab, f, ch) } catch (e) { logErr("typeIntoField:", e?.stack || e); return }
    logKeyPath("type", ch, r.via)
    applyFieldValue(f, r.value, before, r.via)
  })
}

/** 退格：同样带校验与兜底（用户投诉「输入关键字不可退格」） */
function pageBackspace() {
  return queueInput(async () => {
    const f = activeField
    if (!f || !tab) return
    const before = String(f.value ?? "")
    let r
    try { r = await backspaceFieldRaw(tab, f) } catch (e) { logErr("backspaceField:", e?.stack || e); return }
    logKeyPath("backspace", "", r.via)
    applyFieldValue(f, r.value, before, r.via)
  })
}

/** 自愈发生时留痕 —— 静默的自愈和没自愈在日志上没区别，那就白做了 */
function logKeyPath(op, arg, via) {
  if (via === VIA.DIRECT || via === VIA.LOST) return
  logErr(`[input] ${op} ${JSON.stringify(arg)} 走了兜底路径：${via}`)
}

/** 搜索词 → 搜索地址（回车彻底没反应时的最后兜底） */
function searchUrlFor(q) {
  return `https://cn.bing.com/search?q=${encodeURIComponent(q)}`
}

/**
 * 这个控件像不像搜索框？只有像，回车没反应时才允许「直达搜索地址」兜底。
 *
 * 为什么判得这么保守：兜底误伤的代价极高 —— 在登录页把用户刚输的
 * 手机号当搜索词跳去 Bing，用户看到的就是「获取验证码把整个页面
 * 刷新了」（2026-09 真实投诉，见 tests/probe-sms.mjs）。
 * 判据：type=search、控件文案（placeholder/aria-label）带搜索字样、
 * 或当前页本来就是搜索引擎。
 */
function looksLikeSearch(f) {
  if (!f) return false
  if (f.type === "search") return true
  const hay = `${f.type || ""} ${f.ph || ""} ${f.label || ""}`.toLowerCase()
  if (/search|搜索|搜一下|关键词|查找|百度一下|google|bing|duckduck/.test(hay)) return true
  try {
    const host = new URL(textPage?.meta?.url || curUrl || "about:blank").hostname
    return /(^|\.)(bing\.com|google\.[a-z.]+|baidu\.com|sogou\.com|so\.com|duckduckgo\.com)$/.test(host)
  } catch { return false }
}

/**
 * 回车提交：**带看门狗**（实现在 src/inputpath.js#submitField）。
 *
 * 发一次真实回车，用地址变化做成功判据。地址没变 ≠ 失败：
 * AJAX 表单（登录、发验证码）本来就不跳转 —— 此时如实报告并抓一帧
 * 让用户看到站点的弹层/提示反馈。只有确认是**搜索场景**
 * （looksLikeSearch：type=search / 文案带搜索字样 / 搜索引擎站点）
 * 才允许「拿关键词直达搜索地址」兜底 —— 否则会把用户刚输的手机号
 * 当搜索词跳走，表现就是「获取验证码把整个页面刷新了」。
 */
async function pageSubmit() {
  // 先把还没落地的按键排空：否则回车可能跑在最后一个字前面，提交的是残缺关键词
  try { await inputQueue } catch {}
  const f = activeField
  const keyword = String(f?.value ?? pageEcho ?? "").trim()
  mode = "normal"
  activeField = null
  statusKind = "busy"
  status = "已发送回车，等待页面响应…"
  paint()

  let r = { ok: false, via: "none", how: null, url: "" }
  try {
    r = await submitField(tab, f, waitUrlChange,
      1600)
  } catch (e) {
    logErr("submitField:", e?.stack || e)
  }
  if (r.ok) {
    logErr(`[input] submit 成功路径：${r.via}`)
    await capture(true)
    return
  }

  // 回车没有引起跳转 —— 在 AJAX 表单（登录、发验证码、即时搜索建议…）上
  // 这是**正确行为**：站点用弹层/提示响应，地址本来就不该变，真实浏览器同样如此。
  // 只有确认这是搜索场景，才允许「拿关键词直达搜索地址」兜底 ——
  // 否则会把用户刚输的手机号当搜索词跳走（"获取验证码刷新整页"的元凶之一）。
  if (keyword && looksLikeSearch(f)) {
    status = `页面未响应提交，改为直达搜索：${keyword.slice(0, 20)}`
    paint()
    await goto(searchUrlFor(keyword))
    return
  }
  statusKind = "info"
  status = "回车已发送 · 页面未跳转（AJAX 表单属正常）· 按 r 刷新查看页面反馈"
  paint()
  await capture(true)
}

/**
 * 轮询等地址变化，变了返回新地址，超时返回 ""。
 *
 * 检出变化后再稳一小会儿：地址变化和**新文档提交**不是同一时刻，
 * 立刻抓的话很可能抓到上一页（旧文档在新文档提交前一直挂着）。
 */
async function waitUrlChange(url0, totalMs) {
  const step = 150
  for (let waited = 0; waited < totalMs; waited += step) {
    await new Promise((r) => setTimeout(r, step))
    try {
      const u = await tab.evalJs("location.href")
      if (u && u !== url0) {
        await new Promise((r) => setTimeout(r, 420))
        return u
      }
    } catch {}
  }
  return ""
}

/**
 * 输入后把控件里的值读回来重绘 —— **不跑整页 capture**。
 *
 * 完整 capture 会重新提取 DOM，并**给页面上每个图片/二维码重新截图**
 * （知乎那种页面 4 个媒体块、二维码还要 2× 超采样），
 * 每敲一个字符都跑一遍又慢又闪。
 * 这里只做一次 evalJs 读 value，然后重绘内存里已有的排版结果。
 */
function syncActiveField(immediate = false) {
  const f = activeField
  if (!f || !tab) return
  clearTimeout(fieldSyncTimer)
  const run = async () => {
    try {
      const v = await tab.fieldValue(f.fid)
      applyFieldValue(f, v, String(f.value ?? ""))
    } catch (e) { /* 控件可能已随导航消失，忽略 */ }
  }
  if (immediate) run()
  else fieldSyncTimer = setTimeout(run, 60)
}

/**
 * 粘贴：整段一次性送进去。
 *
 * ① 终端把粘贴内容包在 `ESC[200~ … ESC[201~` 里（我们主动开了 2004h），
 *    解码层已经把它还原成一整段文本 —— 这里不做逐字符模拟，
 *    否则 500 字的粘贴会变成 500 次 CDP 往返。
 * ② 粘贴中文是**目前最可靠的输入中文的方式**：绕开了 IME 组合过程，
 *    终端直接把 UTF-8 交给我们。用户反馈"输入法打不进搜索框"时，
 *    先在别处打好复制过来粘，这条路是通的。
 */
async function handlePaste(text) {
  if (!text) return
  const clean = text.replace(/\r\n?|\n/g, " ")
  if (mode === "pageinput" || inputPending) {
    if (inputPending) { for (const ch of [...clean]) pendingKeys.push({ kind: "char", ch }); paint(); return }
    const f = activeField
    if (!f) { statusKind = "info"; status = "粘贴的内容无处可去（没有聚焦的控件）"; paint(); return }
    await queueInput(async () => {
      const before = String(f.value ?? "")
      let r
      try { r = await typeIntoFieldRaw(tab, f, clean) } catch (e) { logErr("handlePaste:", e?.stack || e); return }
      logKeyPath("paste", clean.slice(0, 20), r.via)
      applyFieldValue(f, r.value, before, r.via)
    })
    return
  }
  if (mode === "goto" || mode === "cmd" || mode === "upload" || mode === "find") { inputValue += clean; paint(); return }
  statusKind = "info"
  status = `已忽略粘贴的 ${clean.length} 字 · 按 i 或 o 进入输入状态后再粘贴`
  paint()
}


function prevPage() {
  statusKind = "busy"
  status = "← 返回…"
  paint()
  lastVp = null
  activeField = null      // 换页后控件编号会重排，旧引用必须丢掉
  pageEcho = ""
  captureError = null
  elsCacheKey = null
  rememberScroll()
  tab.history(-1)
    .then((u) => capture(false).then(() => {
      // 说清楚「退到哪一页了」—— 否则用户按了后退只看到状态栏变"就绪"，
      // 分不清是退回去了还是根本没反应。
      restoreScroll(u)
      statusKind = "ok"
      status = `← 已返回 · ${u}`
      paint()
    }))
    .catch((e) => { statusKind = "err"; status = String(e?.message || e); paint() })
}

function nextPage() {
  statusKind = "busy"
  status = "→ 前进…"
  paint()
  lastVp = null
  activeField = null
  pageEcho = ""
  captureError = null
  elsCacheKey = null
  rememberScroll()
  tab.history(1)
    .then((u) => capture(false).then(() => {
      restoreScroll(u)
      statusKind = "ok"
      status = `→ 已前进 · ${u}`
      paint()
    }))
    .catch((e) => { statusKind = "err"; status = String(e?.message || e); paint() })
}

// ── 元素清单模式：上下选择 ──
async function pickMove(dir) {
  if (!pageEls.length) return
  const cur = pageEls.findIndex((e) => e.i === pickInfo?.i)
  const next = (((cur < 0 ? 0 : cur) + dir) % pageEls.length + pageEls.length) % pageEls.length
  pickInfo = pageEls[next]
  statusKind = "ok"
  const clip = pickInfo.clipped ? " ⚠元素比视口宽，仅部分可见" : ""
  status = `[${pickInfo.i + 1}/${pageEls.length}] ${pickInfo.tag} · ${pickInfo.text}${clip}`
  await scrollToEl(pickInfo.i)
}

/**
 * 点击之后等页面"真的动了"。
 *
 * 固定 `setTimeout(700)` 有两个毛病：
 *   · 点了**跳转链接**时，新文档 700ms 内没提交完的话，紧接着的 capture 读到的
 *     还是**上一页** —— 表现成"点了没反应"，然后过一会儿又突然变了；
 *   · 点了页内操作（展开/翻页/加购）时又白等 700ms。
 * 所以改成"盯着 URL 看"：变了就再稳一小会儿；没变就按最小等待继续。
 */
async function waitAfterClick(maxMs = 1600, settleMs = 420) {
  let url0 = ""
  try { url0 = await tab.evalJs("location.href") } catch {}
  const step = 120
  for (let w = 0; w < maxMs; w += step) {
    await new Promise((r) => setTimeout(r, step))
    try {
      const u = await tab.evalJs("location.href")
      if (u && u !== url0) {
        await new Promise((r) => setTimeout(r, settleMs))   // 等新文档提交
        return true
      }
    } catch { /* 导航切换瞬间 evaluate 会失败，正常 */ }
  }
  return false
}

/**
 * 悬停选中元素（不点击）。hover 展开的菜单/提示用。
 * 注意不动 pickInfo/mode —— 悬停后清单还开着，可以继续 ↑↓ 换、Enter 点。
 */
async function pickHover() {
  if (!pickInfo) return
  statusKind = "busy"
  status = `悬停 [${pickInfo.i + 1}] ${pickInfo.text}…`
  paint()
  try {
    if (renderMode === "text") {
      try { await tab.scrollElIntoView(pickInfo.i) } catch {}
      await new Promise((r) => setTimeout(r, 90))
    }
    const box = await tab.hoverEl(pickInfo.i)
    if (!box) {
      statusKind = "err"
      status = "元素已失效（页面可能已跳转），按 r 重新枚举"
    } else if (box.offscreen) {
      statusKind = "err"
      status = "元素完全在视口外，无法悬停；先滚动页面再试"
    } else {
      statusKind = "ok"
      status = `已悬停 ${box.text ? `「${box.text.slice(0, 24)}」` : ""} · hover 菜单已可展开 · ↑↓ 换项 · Enter 点击`
    }
    // hover 展开的菜单需要重抓才能看见（但别清 elsCache —— 清单还要用）
    await capture()
  } catch (e) {
    logErr("pickHover:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

// ── 元素清单模式：双击（真实连击，dblclick/选中文本由 Chromium 合成）──
async function pickDblClick() {
  if (!pickInfo) return
  statusKind = "busy"
  status = `双击 [${pickInfo.i + 1}] ${pickInfo.text}…`
  paint()
  try {
    if (renderMode === "text") {
      try { await tab.scrollElIntoView(pickInfo.i) } catch {}
      await new Promise((r) => setTimeout(r, 90))
    }
    const box = await tab.dblClickIndex(pickInfo.i)
    if (!box || box.offscreen) {
      statusKind = "err"
      status = !box ? "元素已失效（页面可能已跳转），按 r 重新枚举" : "元素完全在视口外，先滚动页面再试"
      paint()
      return
    }
    await waitAfterClick()
    mode = "normal"
    pickInfo = null
    elsCacheKey = null
    lastVp = null
    await capture(true)
  } catch (e) {
    logErr("pickDblClick:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

// ── 元素清单模式：拖拽（g 标起点 → 移动选择 → 再按 g 落下）──
// 滑块验证码 / 拖拽排序：必须是「按住 → 分步移动 → 松开」的真实鼠标序列，
// 两端元素都要在视口内（拖拽中途没法滚动）。
function pickDrag() {
  if (!pickInfo) return
  if (!dragFrom) {
    dragFrom = pickInfo
    statusKind = "busy"
    status = `拖拽起点 [${dragFrom.i + 1}] ${dragFrom.text.slice(0, 24)} · ↑↓ 移到目标 · 再按 g 落下 · Esc 取消`
    paint()
    return
  }
  const from = dragFrom
  dragFrom = null
  statusKind = "busy"
  status = `拖拽 [${from.i + 1}] → [${pickInfo.i + 1}]…`
  paint()
  tab.dragEls(from.i, pickInfo.i).then((r) => {
    if (!r.a || !r.b || r.a.offscreen || r.b.offscreen) {
      statusKind = "err"
      status = "拖拽失败：两端必须都在视口内（先滚动页面再标起点）"
      paint()
      return
    }
    statusKind = "info"
    status = `已拖拽 [${from.i + 1}] → [${pickInfo.i + 1}] · 滑块/排序如无反应按 r 重抓`
    paint()
    elsCacheKey = null
    lastVp = null
    capture(true).catch(() => {})
  }).catch((e) => {
    logErr("pickDrag:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  })
}

// ── 元素清单模式：文件上传入口（仅 input[type=file]）──
function pickUploadStart() {
  if (!pickInfo) return
  if (pickInfo.tag !== "INPUT" || pickInfo.type !== "file") {
    statusKind = "err"
    status = "选中的不是文件选择控件（input[type=file]）"
    paint()
    return
  }
  mode = "upload"
  inputValue = ""
  statusKind = "info"
  status = `给 [${pickInfo.i + 1}] 选择文件：输入完整路径（多个用 | 分隔）`
  paint()
}

async function uploadFiles(raw) {
  const files = raw.split("|").map((s) => s.trim()).filter(Boolean)
  if (!files.length || !pickInfo) {
    statusKind = "err"
    status = "没有给出文件路径"
    paint()
    return
  }
  const target = pickInfo
  pickInfo = null
  statusKind = "busy"
  status = `上传 ${files.length} 个文件到 [${target.i + 1}]…`
  paint()
  try {
    const r = await tab.uploadToIndex(target.i, files)
    if (r.ok) {
      statusKind = "info"
      status = `已选择文件（${r.mode}）· 站点没反应就按 r 重抓`
    } else {
      const why = {
        gone: "元素已失效（页面可能已跳转）",
        notfile: "目标不是文件控件",
        offscreen: "控件在视口外，先滚动页面",
        nochooser: "未触发文件选择器（站点可能用自定义上传 UI）",
      }[r.why] || r.why
      statusKind = "err"
      status = `上传失败：${why}`
    }
  } catch (e) {
    logErr("uploadFiles:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
  }
  paint()
  elsCacheKey = null
  await capture(true).catch(() => {})
}

// ── 元素清单模式：真实鼠标点击 ──
async function pickActivate() {
  if (!pickInfo) return
  statusKind = "busy"
  status = `点击 [${pickInfo.i + 1}] ${pickInfo.text}…`
  paint()
  try {
    // 文字模式：元素清单导航时我们故意没滚页面（见 scrollToEl），
    // 所以点击前必须先把它带进视口 —— clickIndex 只在元素与视口有交集时才能派发坐标。
    if (renderMode === "text") {
      try { await tab.scrollElIntoView(pickInfo.i) } catch {}
      await new Promise((r) => setTimeout(r, 90))
    }
    // target=_blank 的链接 → 开成新标签页（真浏览器的行为），
    // 当前页面保持不动。
    if (await openInNewTabIfNeeded(pickInfo.i)) {
      mode = "normal"
      pickInfo = null
      statusKind = "ok"
      status = "已在新标签页打开"
      paint()
      return
    }
    const box = await tab.clickIndex(pickInfo.i)
    if (!box) {
      statusKind = "err"
      status = "元素已失效（页面可能已跳转），按 r 重新枚举"
      paint()
      return
    }
    if (box.offscreen) {
      statusKind = "err"
      status = "元素完全在视口外，无法点击；先滚动页面再试"
      paint()
      return
    }
    await waitAfterClick()
    mode = "normal"
    focusInfo = null
    pickInfo = null
    lastVp = null
    elsCacheKey = null
    await capture()
    statusKind = "ok"
    status = `已点击 ${box.tag} ${box.text}`
    paint()
  } catch (e) {
    logErr("pickActivate:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

// ── 鼠标 ────────────────────────────────────────────────────────
//
// 参考 Browsh：终端里做浏览器，「看到就点」才是本能。键盘路径
// （Tab 循环 / v 元素清单）是给没有鼠标的场景兜底的，不能当主路径。
// Browsh 靠 tcell 直接拿鼠标事件；我们没有 native 依赖，自己解 SGR 序列
// （见 src/mouse.js），代价很小。
//
// 行为刻意保守：
//   · 只认左键单击 + 滚轮。右键/中键留给终端自己的菜单与粘贴。
//   · 点到的格必须真的属于某个 DOM 块才动。文字模式是**重排**过的，
//     终端列和页面 x 之间没有线性关系，按像素反推页面坐标去乱点
//     很容易误触广告位或提交按钮。
//   · 不命中就只给一句提示，绝不做猜测性操作。

function handleMouse(m) {
  if (!m) return

  // 滚轮：任何模式下都当作滚动
  if (m.kind === "wheelUp" || m.kind === "wheelDown") {
    const up = m.kind === "wheelUp"
    scrollPx((up ? -1 : 1) * (renderMode === "text" ? 3 * CELL_H : CELL_H * 2))
    return
  }
  // 中键点 / Ctrl+点 = 在新标签页打开（真浏览器就这么做的）
  const wantNewTab = m.button === 1 || m.ctrl === true
  if (m.kind !== "click" || (m.button !== 0 && m.button !== 1)) return

  // 输入框 / 地址栏 / 命令 / 上传 / 查找模式正在编辑时，鼠标不参与，避免误触丢输入
  if (mode === "goto" || mode === "cmd" || mode === "upload" || mode === "find") return

  const y = m.y - 1, x = m.x - 1                    // SGR 是 1 起，转 0 起
  if (y < CHROME_ROWS) return                       // 顶栏/地址栏
  const pageRow = y - CHROME_ROWS
  if (pageRow >= PAGE_ROWS()) return                // 状态栏/提示行

  if (renderMode !== "text") {
    statusKind = "info"
    status = "鼠标点击只支持文字模式（按 m 切回）· 滚轮两种模式都能用"
    paint()
    return
  }
  if (mode === "pick") {
    statusKind = "info"
    status = "元素清单模式下用 ↑↓ 选择、Enter 点击（Esc 先退出）"
    paint()
    return
  }
  // ⚠️ 返回值必须往上传：这是「发了不等」的异步链，抛错会走到
  // process.on("unhandledRejection")，那里直接 safeShutdown 退出程序 ——
  // 一次点击出意外就能把整个浏览器关掉。调用方统一挂 catch。
  return activateAtRow(pageRow, x, wantNewTab)
}

/** 页面区内的一格 → 它属于哪个 DOM 块 → 执行对应动作 */
async function activateAtRow(pageRow, col, wantNewTab = false) {
  if (!textPage || !textRows?.rows) return
  const rows = textRows.rows
  let src = hitTestRows(rows, pageRow, col)

  // 兜底：这一行没有精确 src（截断后的续行、字符画、被叠加层改写的行）。
  // 整行只对应一个块时，按行认也是对的；对应多个就沉默 —— 猜错更糟。
  if (!src) {
    const cands = rowCandidates(clickIndex, pageRow)
    if (cands.length === 1) src = cands[0]
  }

  if (!src) {
    statusKind = "info"
    status = "这一格不是可点击的元素 · 按 v 打开元素清单"
    paint()
    return
  }

  if (src.kind === "fold") return toggleFoldById(src.foldId)
  if (src.kind === "field") return focusFieldBlock(src)
  return openBlock(src, wantNewTab)
}

/** 点折叠标记 = 就地展开/收起（和按 e 等价，只不过只影响你点的那一处） */
function toggleFoldById(id) {
  if (id === undefined || id === null) return
  const f = (textPage.folds || []).find((x) => x.id === id)
  if (!f) return
  if (foldOpen.has(id)) foldOpen.delete(id)
  else foldOpen.add(id)
  applyFoldState(textPage, foldOpen, PAGE_COLS())
  elsCacheKey = null       // 展开会改变可见元素，缓存的编号作废
  statusKind = "ok"
  status = foldOpen.has(id)
    ? `已展开「${f.label || "折叠内容"}」共 ${f.len} 字 · 再点一次收起`
    : `已收起「${f.label || "折叠内容"}」`
  rerenderText()
}

/** 点控件 = 聚焦并进入输入模式（和「Tab 到它再按 i」等价，但直达） */
async function focusFieldBlock(f) {
  if (f.disabled || f.readonly) {
    statusKind = "info"
    status = `该控件不可输入（${f.disabled ? "已禁用" : "只读"}）`
    paint()
    return
  }
  try {
    const info = await tab.focusField(f.fid)
    if (!info?.ok) {
      statusKind = "err"
      status = "控件已失效（页面可能已变化），按 r 刷新"
      paint()
      return
    }
    activeField = f
    focusInfo = { ...info, fid: f.fid }
    mode = "pageinput"
    pageEcho = String(f.value ?? "")
    statusKind = "info"
    status = `输入模式 · ${fieldName(f)} · Enter 提交 · Esc 退出`
    revealFieldRow(f)
    paint()
    // 只是把焦点按到控件上，页面内容没变 —— 不要整页重抓
    // （那会重新提取 DOM 并给每个媒体块重新截图，用户看到的就是"点了下就刷新"）。
    // 只需要把控件当前值读回来刷新显示。
    syncActiveField(true)
    statusKind = "info"
    status = `输入模式 · ${fieldName(f)} · Enter 提交 · Esc 退出`
    paint()
  } catch (e) {
    logErr("focusFieldBlock:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

/**
 * 点链接/按钮：优先「真实点击」，退化为改地址。
 *
 * 为什么优先真实点击：站点大量用 React 合成事件 + 事件委托，
 * 直接改 location 有些入口根本不生效（外链拦截、SPA 路由、埋点跳转）。
 * 只有在元素清单里找不到对应项时，才退回用 href 直接导航。
 */
async function openBlock(src, wantNewTab = false) {
  const label = String(src.text || src.href || "元素").replace(/\s+/g, " ").trim().slice(0, 30)
  statusKind = "busy"
  status = `打开 ${label}…`
  paint()
  try {
    const els = await pageElsForClick()
    const m = matchElement(els, src)
    if (m && m.index >= 0) {
      if (renderMode === "text") {
        // clickIndex 只在元素与视口有交集时能派发坐标；文字模式从不真的滚页面
        // （见 scrollToEl 的注释），所以点击前必须先把它带进视口。
        try { await tab.scrollElIntoView(m.index) } catch {}
        await new Promise((r) => setTimeout(r, 80))
      }
      // 中键点 / Ctrl+点 → 强制开成新标签页（真浏览器的行为）
      if (wantNewTab) {
        const opened = await openInNewTabIfNeeded(m.index, true)
        if (opened) {
          mode = "normal"
          activeField = null
          pageEcho = ""
          focusInfo = null
          pickInfo = null
          lastVp = null
          elsCacheKey = null
          statusKind = "ok"
          status = "已在新标签页打开"
          paint()
          return
        }
      }
      // target=_blank 的链接 → 开成新标签页
      if (await openInNewTabIfNeeded(m.index)) {
        mode = "normal"
        activeField = null
        pageEcho = ""
        focusInfo = null
        pickInfo = null
        lastVp = null
        elsCacheKey = null
        statusKind = "ok"
        status = "已在新标签页打开"
        paint()
        return
      }
      const box = await tab.clickIndex(m.index)
      if (box && !box.offscreen) {
        await waitAfterClick()
        mode = "normal"
        activeField = null
        pageEcho = ""
        focusInfo = null
        pickInfo = null
        lastVp = null
        elsCacheKey = null
        await capture(true)
        statusKind = "ok"
        status = `已点击 ${box.tag} ${box.text}`
        paint()
        return
      }
    }
    if (src.href && !/^javascript:/i.test(src.href)) {
      const base = textPage?.meta?.url || curUrl || "about:blank"
      let abs
      try { abs = new URL(src.href, base).href } catch { abs = null }
      if (abs) return goto(abs)
    }
    statusKind = "err"
    status = "这个块没有可点击的目标 · 按 v 打开元素清单"
    paint()
  } catch (e) {
    logErr("openBlock:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

/**
 * 拿元素清单（带缓存）。每次点击都重新枚举要 50–150ms，
 * 而编号只在「换页 / 页面结构变了」时才失效，所以按页面 URL 缓存。
 * 换页、展开折叠、页面侧展开都会把 elsCacheKey 置空。
 */
async function pageElsForClick() {
  const key = (textPage?.meta?.url || curUrl || "") + "|" + viewW + "x" + viewH
  if (elsCache && elsCacheKey === key) return elsCache
  elsCache = await tab.enumerateInteractive(viewW, viewH)
  elsCacheKey = key
  return elsCache
}

async function focusNext(dir) {
  try {
    focusInfo = await tab.focusLink(dir)
    if (!focusInfo) {
      statusKind = "err"
      status = "页面上没有可聚焦元素"
      paint()
      return
    }
    // 用容器感知的滚动把焦点元素带进视野（兼容内层 overflow 容器）
    const vis = await tab.ensureVisible()
    if (vis) focusInfo = vis
    if (renderMode === "text" && textPage) {
      // 文字模式：把行窗口挪到焦点元素所在行附近，并保留高亮。
      // 同样**不重新抓页** —— 排版结果就在内存里，重抓一遍纯属浪费
      // （用户反馈的「每动一下就要重新加载」）。
      const map = makeLineMapper(textPage, { yOffset: 0, pxPerRow: CELL_H, viewOffsetY: 0 })
      const want = map(focusInfo.y, focusInfo.x)
      if (Number.isFinite(want)) {
        textRowOffset = Math.max(0, Math.min(Math.max(0, textTotalRows - PAGE_ROWS()), want - Math.floor(PAGE_ROWS() / 3)))
      }
      rerenderText()
    } else {
      await capture()
    }
    // 图片模式：在网格上画金色高亮框标记当前焦点
    if (renderMode === "image" && grid) {
      const w = grid.cols, h = grid.rows
      const x0 = Math.floor(focusInfo.x / CELL_W)
      const x1 = Math.ceil((focusInfo.x + Math.max(focusInfo.w, CELL_W)) / CELL_W)
      const y0 = Math.floor(focusInfo.y / CELL_H)
      const y1 = Math.ceil((focusInfo.y + Math.max(focusInfo.h, CELL_H)) / CELL_H)
      const GOLD = [239, 199, 103]
      const paintCell = (x, y) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return
        const gi = y * w + x
        grid.chars[gi] = 0x23   // '#'
        grid.color[gi * 3] = GOLD[0]; grid.color[gi * 3 + 1] = GOLD[1]; grid.color[gi * 3 + 2] = GOLD[2]
      }
      for (let x = Math.max(0, x0); x < Math.min(x1, w); x++) { paintCell(x, y0); paintCell(x, y1 - 1) }
      for (let y = Math.max(0, y0); y < Math.min(y1, h); y++) { paintCell(x0, y); paintCell(x1 - 1, y) }
    }
    statusKind = "ok"
    status = `焦点: ${(focusInfo.text || focusInfo.tag || "").slice(0, 40)}`
    paint()
  } catch (e) {
    logErr("focusNext:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

async function openFocused() {
  if (!focusInfo) {
    statusKind = "err"
    status = "先按 Tab 选中链接"
    paint()
    return
  }
  statusKind = "busy"
  status = `回车打开: ${(focusInfo.text || "").slice(0, 30)}`
  paint()
  try {
    await tab.clickFocused()
    await new Promise((r) => setTimeout(r, 400))
    focusInfo = null
    lastVp = null
    await capture(true)
  } catch (e) {
    logErr("openFocused:", e?.stack || e)
    statusKind = "err"
    status = String(e?.message || e).slice(0, 70)
    paint()
  }
}

// ── 启动 ──

/**
 * 终端环境探测：Windows 传统控制台（conhost）对中文输入法支持很差。
 * 判据：win32 + 没有 WT_SESSION（Windows Terminal）+ 没有 TERM_PROGRAM（VS Code 等）。
 */
function terminalEnvNote() {
  if (process.platform !== "win32") return ""
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM) return ""
  return "提示：检测到 Windows 传统控制台（conhost）。中文输入法在这里常常打不出字 —— "
    + "建议改用 Windows Terminal 运行，或先在别处打好中文再 Ctrl+V 粘贴（粘贴一定可用）。"
}

async function main() {
  if (cleanMode) {
    const { n, freed } = purgeStaleProfiles()
    console.log(`已清理 ${n} 个残留 profile 目录，释放 ${(freed / 1048576).toFixed(1)} MB`)
    process.exit(0)
  }

  // 终端环境提示：Windows 传统控制台（conhost）里的中文输入法经常**完全没有反应**
  // —— 那是 conhost 的 IME 与原始模式（raw mode）不对付，不是本程序的问题，
  // 但从界面上看不出区别，用户会一直以为"输入框坏了"。提前说明比事后解释有用。
  const envNote = terminalEnvNote()
  if (envNote) {
    logErr("[env] " + envNote)
    // ⚠️ dump 模式下 stdout 就是终端转储本身，多写一行会污染它
    // （tests/replay-dump.mjs 会跟着解析失败）。所以只在交互模式下打印。
    if (!dumpMode) { try { process.stdout.write(envNote + "\n") } catch {} }
  }
  startupNote = envNote
  // 上次异常退出留下的临时 profile 顺手清掉（有年龄与数量限制，见函数注释）
  autoPurgeStaleProfiles()

  // --reset-profile：清空持久 profile（登录态全部重来）。书签/历史不受影响。
  if (resetProfileMode) {
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
      console.log(`已清空持久 profile：${PROFILE_DIR}`)
    } catch (e) {
      console.error("清空失败：", e?.message || e)
      process.exit(1)
    }
  }

  term = createTerm()
  term.clear()
  process.stdout.write("\x1b[?1049h")

  if (!dumpMode) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    // 开启鼠标上报（SGR 扩展编码）。注意这会接管终端的鼠标：
    // 用户想「按住拖选文字」时得按住 Shift（xterm 系终端的通用约定），
    // 或者用 --no-mouse 启动。
    if (mouseOn) process.stdout.write(MOUSE_ON)
    // 括号粘贴上报：终端会把一次粘贴包在 ESC[200~ … ESC[201~ 里，
    // 让我们能一次性拿到整段文本（而不是被拆成几百个单字符事件）。
    // 这也是**目前输入中文最可靠的路子**：粘贴绕开了 IME 组合过程。
    process.stdout.write(BRACKET_PASTE_ON)
    pasteOn = true

    // 按键日志：排查「输入法打不进去 / 某个键没反应」时的决定性证据 ——
    // 它会记录终端**实际送来的**每一个事件，从而区分
    //   「终端根本没发字节」 和 「我们收到了但没处理对」。
    // 用法：set EDGE_TUI_KEYS=1 && node run.mjs  然后看 crash.log 里的 [keys]
    if (process.env.EDGE_TUI_KEYS) {
      keyLog = true
      logErr("[keys] 按键日志已开启（EDGE_TUI_KEYS=1）")
    }

    const decoder = createKeyDecoder({ onMouse: classifyMouse })

    const dispatch = (ev) => {
      if (!ev) return
      if (startupNote) {
        // 用户一动手就不再占着状态栏。注意 status 里可能还留着那段提示文本，
        // 不清掉的话：提示已经不做数了，屏幕却还挂着它。
        if (status === startupNote) status = "就绪"
        startupNote = ""
      }
      if (keyLog) {
        logErr(`[keys] ${ev.name}${ev.sequence !== undefined ? " " + JSON.stringify(ev.sequence) : ""}`
          + `${ev.text !== undefined ? " len=" + ev.text.length : ""}`
          + `${ev.kind ? " " + ev.kind : ""}`)
      }
      if (ev.name === "mouse") {
        // 兜住整条异步链：handleMouse → activateAtRow → openBlock 里任何
        // 一处漏出来的异常，都会变成 unhandledRejection 把程序直接关掉。
        Promise.resolve()
          .then(() => handleMouse(ev))
          .catch((e) => {
            logErr("handleMouse:", e?.stack || e)
            statusKind = "err"
            status = String(e?.message || e).slice(0, 70)
            paint()
          })
        return
      }
      if (ev.name === "paste") {
        Promise.resolve()
          .then(() => handlePaste(ev.text))
          .catch((e) => {
            logErr("handlePaste:", e?.stack || e)
            statusKind = "err"
            status = String(e?.message || e).slice(0, 70)
            paint()
          })
        return
      }
      if (ev.name === "ctrl-c") { safeShutdown(); return }
      if (ev.name === "focus-in" || ev.name === "focus-out") return
      handleKey(ev)
    }

    process.stdin.on("data", (chunk) => {
      try {
        for (const ev of decoder.push(chunk)) dispatch(ev)
      } catch (e) {
        logErr("decode:", e?.stack || e)
        return
      }
      // 孤立 ESC 的延迟确认：Esc 键和"被切开的序列头"都是 0x1b，字节上没法区分。
      // 给它 40ms —— 真有后续字节就会先到达并取消这个定时器。
      clearTimeout(lastEscapeTimer)
      if (decoder.pendingEscape()) {
        lastEscapeTimer = setTimeout(() => {
          try { for (const ev of decoder.flushEscape()) dispatch(ev) } catch {}
        }, 40)
      }
    })
  }

  // 用启动时的终端尺寸初始化视口，避免首帧用默认值再重排
  const initW = PAGE_COLS() * CELL_W
  const initH = PAGE_ROWS() * CELL_H
  // dump 模式（排查/快照用）强制一次性 profile：别把探针访问写进真实历史
  const useTempProfile = freshMode || dumpMode
  edge = await launchEdge(useTempProfile
    ? { width: initW, height: initH, userAgent: userAgentArg, downloadPath: DOWNLOAD_DIR }
    : { width: initW, height: initH, profileDir: PROFILE_DIR, userAgent: userAgentArg, downloadPath: DOWNLOAD_DIR })
  tab = edge.tab
  currentTargetId = edge.targetId
  // 第一个标签页（启动时打开的那一页）
  tabStates.length = 0
  tabMeta.length = 0
  tabStates.push(snapshotTabState())
  tabMeta.push({ title: "", url: "" })
  activeTab = 0
  // 站点自己开出来的窗口（window.open 等）→ 收编成新标签页
  edge.onNewTarget?.((info) => {
    edge.attachTarget(info.targetId)
      .then((created) => adoptTab(created))
      .catch((e) => logErr("adopt:", e?.stack || e))
  })
  // 下载：headless Chrome 默认会**取消**下载，所以下载行为是显式开的。
  // 事件到了就把文件名和结果报给用户 —— 否则点了下载链接，界面一点动静都没有。
  let downloading = ""
  edge.onDownload?.((info) => {
    if (info.phase === "willBegin") {
      downloading = info.suggestedFilename || "文件"
      statusKind = "busy"
      status = `正在下载 ${downloading}…`
      paint()
    } else if (info.phase === "progress") {
      if (info.state === "completed") {
        statusKind = "ok"
        status = `已下载 ${downloading} → ${info.filePath || DOWNLOAD_DIR}`
        paint()
      } else if (info.state === "canceled") {
        statusKind = "err"
        status = `下载被取消：${downloading}`
        paint()
      }
    }
  })
  lastVp = PAGE_COLS() + "x" + PAGE_ROWS()
  if (!useTempProfile && !startupNote) {
    startupNote = "登录态已保留（持久 profile）· --fresh 临时会话 · --reset-profile 清空登录"
  }

  await goto(urlArg)
  if (dumpMode) {
    // dump 模式：等进度条收尾后再退出，保证快照反映最终状态
    clearInterval(progressTimer)
    progressTimer = null
    progress = null
    busy = false
    // 快照也要如实反映"加载失败/不完整"，否则 dump 出来的画面会骗人
    const dumpNote = captureQualityNote()
    statusKind = dumpNote ? "info" : "ok"
    status = dumpNote || "就绪"
    prevScreen = null
    paint()
    await new Promise((r) => setTimeout(r, 150))
    safeShutdown(0)
  }
  await new Promise(() => {})
}

// ── 测试挂载点 ──────────────────────────────────────────────────
//
// 为什么要开这个口子：本项目最容易被"改回去"的一类 bug 是
// **交互动作触发了整页重抓**（用户原话：「每动一下就要重新加载」——
// 根因就是 `scrollPx` 的文字模式分支里写着 `await capture()`）。
// 这类 bug 从静态代码上看不出来（那行本身完全合法），
// 也测不了：run.mjs 要真实 TTY 才能驱动。
// 所以用 `EDGE_TUI_NO_MAIN=1` 让它在测试进程里可被 import，
// 再由 `tests/test-noreload.mjs` 塞进一个"会计数"的 tab 替身，
// 断言「文字模式滚动对浏览器零调用」。
//
// 传进来的页面必须是 buildTextPage 的真实产物（不是手搓对象），
// 否则测的就只是测试自己。
export const __test = {
  CELL_H,
  CHROME_ROWS,
  FOOT_ROWS,
  PAGE_ROWS,
  looksLikeSearch,      // 回车兜底判别（见 tests/test-searchguard.mjs / probe-sms.mjs）
  install({ tabLike, page, totalRows, pageRows, renderModeValue = "text", termLike }) {
    tab = tabLike
    textPage = page
    textTotalRows = totalRows ?? 0
    renderMode = renderModeValue
    textRowOffset = 0
    textRows = null
    mapLine = null
    // PAGE_ROWS()/PAGE_COLS() 要从 term 取尺寸；测试里给个假的即可
    // （paint() 会因为没有真实 term 而自行跳过，不会真的输出）
    if (termLike) term = termLike
    return { pageRows: pageRows ?? (termLike ? PAGE_ROWS() : 0) }
  },
  state: () => ({ renderMode, textRowOffset, textTotalRows, hasPage: !!textPage,
    findQuery, findHits: findHits.length, findCur, mode, inputValue }),
  runFind,
  findNext,
  clearFind,
  scrollPx,
  rerenderText,
  redraw,
  refreshPicker,
  // 直接驱动按键处理：验证「按 Ctrl+Tab 真的切了标签页」这一整条链路
  // （按键 → 解码 → handleKey → 切页），而不只是测切页函数本身。
  handleKey,
  // 滚动位置记忆（后退/前进时恢复）
  setScroll: (url, off) => { curUrl = url; textRowOffset = off; textTotalRows = 1000 },
  scrollState: () => ({ url: curUrl, off: textRowOffset }),
  rememberScroll,
  restoreScroll,
  // ── 多标签页的测试钩子 ──
  // 用假的 tab 替身驱动标签逻辑（不开真浏览器）：
  // 切标签是纯内存操作，测它不需要真的开页面。
  setEdge: (e) => { edge = e },
  tabState: {
    seed(items) {
      tabStates.length = 0
      tabMeta.length = 0
      activeTab = 0
      for (const it of items) {
        tabStates.push({
          ...snapshotTabState(),
          tab: it.tab, title: it.title, curUrl: it.url, targetId: it.targetId ?? null,
        })
        tabMeta.push({ title: it.title, url: it.url })
      }
      restoreTabState(tabStates[0])
    },
    count: () => tabStates.length,
    active: () => activeTab,
    titles: () => tabStates.map((s) => s.title),
    urls: () => tabStates.map((s) => s.curUrl),
    activeTitle: () => title,
    activeUrl: () => curUrl,
    // 标签栏渲染出来的纯文本（没有 term 时返回空串）
    strip: () => (term ? tabStripRow().map((r) => r.t).join("") : ""),
    newTab, closeTab, switchTab, cycleTab,
  },
}

if (!process.env.EDGE_TUI_NO_MAIN) {
  main().catch((e) => {
    logErr("main:", e?.stack || e)
    console.error("启动失败：", e?.message || e)
    safeShutdown(1)
  })
}
