// textbrowser.js —— 「真·文字浏览器」渲染器
//
// 与旧的截图降采样方案的根本区别：
//   旧：整页截图 → 4x8 降采样 → 字符画   ← 文字和二维码一起变成噪声
//   新：DOM 提取文字 → 终端原生字符排版   ← 文字 100% 清晰
//       图片/二维码区域单独裁剪 → 转小尺寸字符画填入
//
// 这是 w3m / lynx 的思路：文字走文本流，图形走旁路。

import { strWidth, truncateByWidth, C } from "./term.js"
import { EXTRACT_BLOCKS, PAGE_META } from "./extract.js"
import { qrFromPng, qrToCells, planQrLayout, isQrCandidate } from "./qr.js"

// ── 图片「信息量」阈值（阈值来自 tests/probe-artinfo.mjs 对真实页面的实测）──
// flat = 渲染结果里最常见字符的占比。实测：
//   懒加载占位图（还没加载出来的灰底）  flat = 1.00，distinct = 1
//   logo / 纯色横幅                     flat ≈ 0.71–0.86
//   真正的新闻照片                      flat = 0.22–0.54，distinct = 5–8
// 渲染成一大片同一个字符的图在终端里就是噪点，占了好几行却读不出任何东西。
export const ART_DROP_FLAT = 0.85    // ≥ 这个值：降级成一行占位（纯色/占位图）
export const ART_SHRINK_FLAT = 0.60  // ≥ 这个值：行数减半（留个影就行，别占半屏）
import { layout, wrapByWidth } from "./layout.js"
import { pngToMediaArt } from "./ascii.js"

/**
 * 在文字模式的页面上叠加「可交互标记 / 当前选中高亮」。
 *
 * 和旧的网格叠加（stampPickerOverlay）的根本区别：
 *   旧：直接改字符网格的像素格，x 轴用 colsPerPx 把 CSS 像素折算成列。
 *   新：**文字模式没有「像素 → 列」的线性映射** —— 一个终端格是一个汉字/字母，
 *       位置由折行结果决定，与 CSS 像素不再一一对应。硬套 colsPerPx
 *       只会在宽字符处越界、在折行处错位。
 *
 * 所以改成文字浏览器惯用的表达：**整行高亮 + 左侧行首标记**。
 *   ① 视口内每个可交互元素所在行，行首打一个 `·`（暗金）—— 让用户看到哪行可点
 *   ② 当前选中项：所在行整行铺暗红底 + 行首 `▸`
 *   ③ Tab 焦点：所在行整行铺暗金底 + 行首 `▶`
 * 行号由 lineOfY() 给出（文档坐标 → 渲染行），媒体展开已由 makeLineMapper 处理。
 *
 * @param {object} o
 *   - rows:          renderTextPage 产出的行（就地修改）
 *   - width:         终端宽（用于补齐 run 长度）
 *   - els:           元素清单 [{ x, y, w, h, i, inVp }]，坐标为文档绝对坐标
 *   - showNumbers:   是否标记视口内可交互元素（行首 `·`）
 *   - pickInfo:      当前选中元素
 *   - focusInfo:     当前 Tab 焦点元素
 *   - lineOfY:       (y, x) => 渲染行索引
 *   - pxPerRow:      退化折算时每行代表的像素高度
 *   - viewOffsetY:   退化折算用的偏移
 *   - yOffset:       当前行窗口偏移（lineOfY 已含时可省略）
 * @returns {boolean} 是否改动了内容
 */
export function overlayRuns(o) {
  const rows = o.rows
  if (!rows || !rows.length) return false
  const width = o.width || 80
  const viewY = o.viewOffsetY || 0
  const pxPerRow = o.pxPerRow || 8

  // 文档 y → 渲染行索引。优先用调用方给的映射（跟着真实文字行走），
  // 否则退化成按像素线性折算。
  const rowOfY = o.lineOfY || ((y) => Math.round((y - viewY) / pxPerRow))

  let touched = false

  // 把 runs 补齐到 width，保证叠加不会丢尾部空白
  const ensure = (line) => {
    let used = 0
    for (const r of line) used += r.w !== undefined ? r.w : strWidth(String(r.t ?? ""))
    if (used < width) line.push({ t: " ".repeat(width - used), fg: C.text, bg: C.bg, w: width - used })
    return line
  }

  // 元素覆盖的渲染行范围（传完整矩形，mapper 才能做二维重叠匹配）
  const rowSpanOf = (info) => {
    if (!info || !Number.isFinite(info.y)) return null
    const h = Number.isFinite(info.h) ? info.h : 0
    const r0 = rowOfY(info.y, info.x, info.w, info.h)
    const r1 = rowOfY(info.y + Math.max(0, h - 1), info.x, info.w, info.h)
    // 防御：多栏页面上 y 与 y+h-1 万一匹配到不同栏的锚点，跨度会突然很大
    // （比如 5…23），整片铺底色会把画面糊掉。跨度不合理时只认起始行。
    if (!Number.isFinite(r0) || !Number.isFinite(r1) || Math.abs(r1 - r0) > 4) return { r0, r1: r0 }
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1) }
  }

  // 行首放一个标记字符。列 0 是「标记槽」—— 文字行的缩进位（indent:1 的那个空格），
  // 所以可以安全覆写。⚠️ 必须先允许覆写**已有标记**：
  //   可交互标记 `·` 先画，选中标记 `▸` 后画；若只认「首字符是空白」，
  //   `▸` 看到 `·验证码登录` 就不敢写了，选中项反而没有标记。
  const MARKER_AT_0 = /^(?:\s|[·▸▶])/
  const mark = (row, ch, col3) => {
    if (row < 0 || row >= rows.length) return
    const line = ensure(rows[row])
    let x = 0
    for (let i = 0; i < line.length; i++) {
      const r = line[i]
      const w = r.w !== undefined ? r.w : strWidth(String(r.t ?? ""))
      if (x + w > 0) {
        const t = String(r.t ?? "")
        // ⚠️ 必须展开原 run（`...r`）：这里重建对象时如果只写 t/fg/bg/w，
        // 挂在 run 上的 `src`（鼠标命中用的来源块）就被抹掉了 ——
        // 症状是「有标记的那些行点不动」，而没标记的行反而正常。
        if (MARKER_AT_0.test(t)) line[i] = { ...r, t: ch + t.slice(1), fg: col3, w }
        else if (x > 0) line[i - 1] = { ...line[i - 1], t: ch, fg: col3 }
        touched = true
        return
      }
      x += w
    }
  }

  const GOLD = [239, 199, 103]
  const RED = [239, 130, 98]

  // ① 可交互标记：只在视口内标，否则整页都是点，反而看不出重点
  if (o.showNumbers && o.els?.length) {
    for (const el of o.els) {
      if (!el.inVp) continue
      const span = rowSpanOf(el)
      if (span) mark(span.r0, "·", GOLD)
    }
  }

  // 整行铺底色（保持前景文字色不变，只换背景 —— 不牺牲可读性）。
  // rows 每帧由 renderTextPage 重新生成，不需要额外"擦除"上一帧的高亮。
  const paintRow = (row, bg) => {
    if (row < 0 || row >= rows.length) return
    const line = ensure(rows[row])
    for (let i = 0; i < line.length; i++) line[i] = { ...line[i], bg }
    touched = true
  }

  // ② 选中项：暗红底 + `▸`
  const pickSpan = rowSpanOf(o.pickInfo)
  if (pickSpan) {
    for (let r = pickSpan.r0; r <= pickSpan.r1; r++) paintRow(r, [58, 26, 22])
    mark(pickSpan.r0, "▸", RED)
  }

  // ③ Tab 焦点：暗金底 + `▶`（放在选中项之后，两者重叠时以焦点为准）
  const focusSpan = rowSpanOf(o.focusInfo)
  if (focusSpan) {
    for (let r = focusSpan.r0; r <= focusSpan.r1; r++) paintRow(r, [56, 46, 20])
    mark(focusSpan.r0, "▶", GOLD)
  }

  // 收尾：把被覆写过的行重新规整到严格 width。
  // 叠加是「改字符不改长度」的，但重建字符串时宽度可能漂移 1 列。
  // 这里统一校正，保证页面区边框不被顶出去。
  if (touched) {
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i]
      let w = 0
      for (const r of line) w += r.w !== undefined ? r.w : strWidth(String(r.t ?? ""))
      if (w === width) continue
      if (w < width) {
        line.push({ t: " ".repeat(width - w), fg: C.text, bg: C.bg, w: width - w })
      } else {
        // 超宽：按宽度裁剪重建
        let acc = 0
        const fixed = []
        for (const r of line) {
          const rw = r.w !== undefined ? r.w : strWidth(String(r.t ?? ""))
          if (acc + rw <= width) { fixed.push(r); acc += rw }
          else {
            const room = width - acc
            if (room > 0) fixed.push({ ...r, t: truncateByWidth(String(r.t ?? ""), room), w: room })
            acc = width
            break
          }
        }
        rows[i] = fixed
      }
    }
  }

  return touched
}

/**
 * 表单控件的可读名称。
 *
 * name/id 经常是 sb_form_q、txtUserName 这种机器标识，直接显示出来对用户毫无帮助
 * （必应首页的搜索框会变成「搜索框「q」」，比不显示还糟）。
 * 所以 name/id 只在「像人话」时才用来兜底：含中文、或者有 4 个字符以上、
 * 且不是 q/s/search/txt 这类通用占位名。
 */
const GENERIC_FIELD_TOKEN =
  /^(?:sb_?form_?)?(?:q|s|wd|kw|key|query|search|keywords?|input|txt|text|searchbox|search-?box|id|name)$/i

/**
 * name/id 里「对用户有意义」的词。凑不出这种词就别显示 ——
 * 百度的搜索框 id 是 chat-textarea，显示成「文本域「chat-textarea」」
 * 对用户是纯噪声，不如只写「文本域」。
 */
const SEMANTIC_FIELD_RE =
  /(e-?mail|邮箱|phone|mobile|电话|手机|user(name)?|用户|pass(word)?|密码|search|搜索|keyword|关键词|comment|评论|message|留言|标题|title|昵称|nick|captcha|验证码|code|date|日期|url|链接|address|地址|name|qq|wechat|微信)/i

/**
 * placeholder 是否长得像「输入提示」。
 *
 * ⚠️ 有的站点把 placeholder 当**轮播广告位**用：百度首页搜索框的 placeholder
 * 是一条会轮换的新闻标题（实测「南方医科大学学生疑坠亡同学发声」→
 * 「中国女排3比0菲律宾女排」），把它当控件名显示出来，用户会以为
 * 搜索框挂着一条不相干的新闻 —— 其实那只是占位符。
 * 判据：短的（≤12 字）或含输入提示词（搜索/请输入/邮箱…）才算提示。
 */
const PLACEHOLDER_HINT =
  /(搜索|请输入|输入|查找|关键词|关键字|用户名|密码|邮箱|电话|手机号|姓名|评论|留言|标题|search|enter|type|keywords?|e-?mail|phone|user(name)?|comment|name)/i

function looksLikeInputHint(v) {
  const s = String(v || "").trim()
  if (!s) return false
  // 不要用「长度短」当判据：百度的轮播标题有的只有 6 个字（「亚运会今日赛程」）。
  // 必须真的含输入提示词才算。
  return PLACEHOLDER_HINT.test(s)
}

export function fieldDisplayName(f) {
  if (!f) return ""
  const human = (s) => {
    const v = String(s || "").trim()
    if (!v) return ""
    if (/[\u4e00-\u9fa5]/.test(v)) return v
    if (GENERIC_FIELD_TOKEN.test(v)) return ""
    return v.length >= 4 ? v : ""
  }
  const ph = human(f.ph)
  // placeholder 只有「像输入提示」才拿来当名字 —— 否则就是站点在拿它放广告/新闻
  const name = human(f.name), id = human(f.id)
  const ident = (name && SEMANTIC_FIELD_RE.test(name)) || (id && SEMANTIC_FIELD_RE.test(id))
  return human(f.label) || (ph && looksLikeInputHint(f.ph) ? ph : "") || (ident ? (name || id) : "")
}

/** 表单控件的类型名（用于「搜索框 / 输入框 / 文本域 …」这一列） */
export function fieldKindName(f) {
  if (!f) return "控件"
  if (f.btn) return "按钮"
  if (f.type === "search") return "搜索框"
  if (f.tag === "TEXTAREA") return "文本域"
  if (f.tag === "SELECT") return "下拉框"
  if (f.type === "password") return "密码框"
  if (f.type === "checkbox" || f.type === "radio") return "勾选框"
  if (f.type === "file") return "文件选择"
  return "输入框"
}

/** 从页面提取块并排版成终端行 */
export async function buildTextPage(tab, opts = {}) {
  const width = opts.width || 80
  const meta = await tab.evalJs(PAGE_META)
  // ⚠️ 提取器返回的是 { blocks, folds }（不是裸数组）——
  // folds 是「被站点折叠起来的内容」清单，见 extract.js 顶部注释。
  const ex = await tab.evalJs(EXTRACT_BLOCKS)
  let blocks = Array.isArray(ex) ? ex : (ex?.blocks || [])
  const folds = Array.isArray(ex?.folds) ? ex.folds : []
  // 表单控件清单（kind:'field' 的那些块）。run.mjs 按 score 挑「主搜索框」，
  // 用户按 i 时直接聚焦它 —— 不必先 Tab 蒙一遍。
  const fields = Array.isArray(ex?.fields) ? ex.fields
    : blocks.filter((b) => b.kind === "field")
  const droppedHidden = ex?.droppedHidden || 0

  // ⚠️ EXTRACT_BLOCKS 是在**页面里**跑的，返回值过一次 JSON 序列化 ——
  // blocks 里的 field 块和 fields 清单里的记录是**两份独立拷贝**。
  // 输入时我们只改 fields 里那一份的 value（syncActiveField），
  // 若不让它们指向同一个对象，用户打进去的字永远不会出现在渲染行上。
  if (fields.length) {
    const byFid = new Map(fields.map((f) => [f.fid, f]))
    blocks = blocks.map((b) => (b.kind === "field" && byFid.has(b.fid) ? byFid.get(b.fid) : b))
  }

  // 块的坐标是「布局坐标」（与滚动无关）。而 Page.captureScreenshot 的 clip
  // 用的是**视口坐标** —— 实测：页面滚过 200px 后，按布局坐标截出来的是空白。
  // 所以每次截图前都要把滚动量减掉。
  const scrollX = Number.isFinite(meta.scrollLayoutX) ? meta.scrollLayoutX : (meta.scrollX || 0)
  const scrollY = Number.isFinite(meta.scrollLayoutY) ? meta.scrollLayoutY : (meta.scrollY || 0)

  // 视口过滤：只保留当前可见范围内的块（含少量上下余量），
  // 滚动到底部时靠 scrollY 决定看到哪些。
  // 块坐标是「布局坐标」（与滚动无关），所以要先减掉总滚动量还原到视口位置。
  if (opts.viewport !== false) {
    const sy = Number.isFinite(meta.scrollLayoutY) ? meta.scrollLayoutY : (meta.scrollY || 0)
    const top = sy - 40
    const bot = sy + meta.innerH + 40
    blocks = blocks.filter((b) => b.y + b.h >= top && b.y <= bot)
  }

  const lines = layout(blocks, { width, indent: opts.indent ?? 1 })

  // 折叠行挂上 fold 记录（渲染层要显示「展开控件名 + 多少字」）
  if (folds.length) {
    const fm = new Map(folds.map((f) => [f.id, f]))
    for (const l of lines) {
      if (l.type === "fold") l.fold = fm.get(l.block.foldId) || null
    }
  }

  // 媒体块 → 裁剪截图 → 转字符画
  const medias = []
  lines.forEach((l, i) => {
    if (l.type === "media") medias.push({ ...l.block, lineIdx: i })
  })

  if (medias.length) {
    // ── 媒体分级：按「信息密度」而不是「原始尺寸」决定给几行 ──
    //
    // 文字浏览器的第一性原理：文字是内容，图是插图。
    // 旧公式对每个媒体一律给 maxRows 行，于是 20×20 的图标和 138×138 的
    // 二维码同样占 14 行 —— 知乎登录页 4 个媒体块吃掉 66/98 行，
    // 「验证码登录」被挤到第 42 行，首屏只有 28 行，用户根本找不到登录入口。
    //
    // 现在分四档：
    //   qrcode 二维码/条码 —— 承载数据，必须看清定位角（大）
    //   photo  大图       —— 只需轮廓示意（中）
    //   small  中图       —— 一笔带过（小）
    //   icon   小图标     —— 纯装饰，不给图，只留一行占位
    const tierOf = (m) => {
      const minSide = Math.min(m.w, m.h)
      const maxSide = Math.max(m.w, m.h)
      // 二维码判定：alt 提示词，或 CANVAS 上的近正方形（知乎是 <canvas>）
      const isQR = /二维码|扫码|条码|qr\s*code|barcode/i.test(m.alt || "") ||
        (m.tag === "CANVAS" && Math.abs(m.w - m.h) < 10 && m.w >= 88)
      if (isQR) return { tier: "qrcode", maxRows: opts.maxQrRows ?? 9 }
      if (minSide < 40) return { tier: "icon", maxRows: 0 }
      if (maxSide >= 200) return { tier: "photo", maxRows: opts.maxMediaRows ?? 6 }
      return { tier: "small", maxRows: 3 }
    }

    const jobs = medias.map((m) => {
      const { tier, maxRows } = tierOf(m)
      // 图标不解析：它没有任何可读信息，占位一行就够
      if (tier === "icon") return { ...m, tier, cols: 0, rows: 0, art: null }

      const aspect = m.w / m.h
      // 自然降采样约 6:1，再夹到可用宽度与给定额度
      let cols = Math.round(m.w / 6)
      cols = Math.max(6, Math.min(cols, Math.min(width - 6, 40)))
      // 终端字符宽高比约 1:2 → 列数 ≈ 行数 × 2 × aspect
      let rows = Math.max(1, Math.min(maxRows, Math.round(cols / (2 * aspect))))
      // 行数一旦被上限截断，若反过来按行数推列数会把横向缩到只剩几列，
      // 宽图（如 128×81 的 LOGO）就退化成一小撮噪点。
      // 这里宁可接受轻微纵向压缩，也保住能辨认的横向轮廓。
      if (rows >= maxRows) {
        cols = Math.max(12, Math.min(cols, Math.round(maxRows * 2 * aspect)))
      } else {
        cols = Math.max(4, Math.min(cols, Math.round(rows * 2 * aspect)))
      }
      return { ...m, tier, cols, rows }
    })

    // ── 抓图必须设预算，否则"内容丰富"的页面就是"卡住"的页面 ⚠️ ──
    //
    // 每张图都是一次串行 CDP 截图往返。一页 40 张图 = 40 次往返，
    // 期间界面完全不动、进度条卡在"正在加载…" —— 用户看到的就是「莫名其妙的卡住」。
    // 同类项目的取舍：Carbonyl 干脆不抓图（连续出帧，看到什么算什么）；
    // Browsh 只抓可视区并给出 `timeout`；w3m/lynx 完全不抓。
    // 我们按「预算」抓：先抓信息量最大的（二维码 → 大图 → 中图），
    // 超出预算 / 超时 / 被用户中断的，退化成一行**写明原因**的占位。
    const lim = opts.limits || {}
    const deadline = Number.isFinite(lim.deadline) ? lim.deadline : Infinity
    const maxShots = Number.isFinite(lim.maxShots) ? lim.maxShots : Infinity
    // 二维码优先：它承载数据（能扫码登录），字符画只是表意，顺序不能反过来
    const PRIORITY = { qrcode: 0, photo: 1, small: 2 }
    const order = jobs.filter((j) => j.rows > 0)
      .sort((a, b) => (PRIORITY[a.tier] ?? 3) - (PRIORITY[b.tier] ?? 3))
    let shots = 0
    let skipped = 0

    for (const j of order) {
      if (lim.isAborted && lim.isAborted()) { j.skipped = "已中断"; skipped++; continue }
      if (shots >= maxShots) { j.skipped = `超出本次抓图预算（${maxShots} 张）`; skipped++; continue }
      if (Date.now() > deadline) { j.skipped = "超出本次加载时间预算"; skipped++; continue }
      shots++
      // 每 3 张报一次进度 —— 抓图期间界面必须有动静，静止 = "卡住"
      if (lim.onProgress && (shots === 1 || shots % 3 === 0)) {
        try { lim.onProgress(shots, order.length) } catch {}
      }

      // ── 二维码优先：无损读出模块矩阵 ──
      // 截的是**原始分辨率**位图（2× 超采样），不做任何降采样，
      // 然后按模块识别出 n×n 矩阵 —— 这一步是无损的，画到终端后能真扫出来。
      // 走截图而不是 canvas.getImageData()：跨域图片会把 canvas 污染成
      // "只写不读"，getImageData 直接抛 SecurityError（知乎登录页就是），
      // 而截图走浏览器自己的合成结果，不受同源策略限制。
      if (isQrCandidate(j)) {
        try {
          const png = await tab.screenshotClip(j.x - scrollX, j.y - scrollY, j.w, j.h, { scale: 2 })
          const qr = qrFromPng(png)
          if (qr) {
            const plan = planQrLayout(qr, { width, maxRows: opts.qrMaxRows ?? 22 })
            const cells = qrToCells(qr, { margin: plan.margin, style: plan.style })
            j.qr = qr
            j.qrCells = cells
            j.qrPlan = plan
            j.tier = "qrcode"
            j.cols = cells.cols
            j.rows = cells.rows
            j.art = { cols: cells.cols, rows: cells.rows }
            continue
          }
        } catch (e) {
          j.qrError = String(e?.message || e)
        }
        // 识别失败就落回下面的字符画（比如方形的 logo 被误判成候选）
      }

      try {
        // ⚠️ clip 是视口坐标，块的 y 是布局坐标 —— 不减掉滚动量会截空。
        const png = await tab.screenshotClip(j.x - scrollX, j.y - scrollY, j.w, j.h)
        const art = pngToMediaArt(png, j.cols, j.rows)
        // ── 按「信息量」取舍（阈值来自 tests/probe-artinfo.mjs 的实测）──
        // 渲染出来一大片同一个字符的图，在终端里就是一块噪点：
        //   · flat=1.00 / distinct=1  → 懒加载占位图（还没加载出来的灰底）
        //   · flat≈0.86               → logo / 纯色横幅
        //   · 真正的照片              → flat 0.22–0.54、distinct 5–8
        // 澎湃新闻首页实测：8 张占位图 × 8 行 = **64 行纯 `*` 噪点**挤在正文里。
        // 这种图降级成一行占位，把行数还给正文。
        if (art.flat >= ART_DROP_FLAT) {
          j.skipped = `低信息量图（${(art.flat * 100).toFixed(0)}% 是同一种字符）`
        } else if (art.flat >= ART_SHRINK_FLAT && j.rows >= 4) {
          // 中等偏低：留个影就行，别让它占半屏
          const rows2 = Math.max(2, Math.floor(j.rows / 2))
          const cols2 = Math.max(6, Math.min(j.cols, Math.round(rows2 * 2 * (j.w / Math.max(1, j.h)))))
          j.rows = rows2
          j.cols = cols2
          j.art = pngToMediaArt(png, j.cols, j.rows)
        } else {
          j.art = art
        }
      } catch (e) {
        j.art = null
        j.error = String(e?.message || e)
      }
    }
    if (skipped && lim.onFinish) { try { lim.onFinish({ shots, skipped, total: order.length }) } catch {} }

    // 回填到行序列
    let k = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l.type !== "media") continue
      const j = jobs[k++]
      if (!j) continue
      l.art = j.art
      l.cols = j.cols
      l.rows = j.rows
      l.tier = j.tier
      l.alt = j.alt
      l.tag = j.tag
      l.srcW = j.w
      l.srcH = j.h
      l.qrCells = j.qrCells || null
      l.qrInfo = j.qr || null
      l.qrPlan = j.qrPlan || null
      l.skipped = j.skipped || null
    }
  }

  return { meta, blocks, lines, linesBase: lines, folds, fields, droppedHidden }
}

/**
 * 应用「折叠内容展开状态」，把已展开的折叠行就地拆成「标题 + 正文」多行。
 *
 * 为什么在文字层展开而不是去点页面上的按钮：
 *   ① 站点的展开控件大多是 div + React 合成事件，点了还可能触发埋点/跳转；
 *   ② 折叠内容的**文字本来就在 DOM 里**（display:none 只是不渲染），
 *      直接读出来最稳，不依赖站点 JS、不产生副作用；
 *   ③ 纯文字层展开是瞬时的 —— 不需要重新抓页面、不需要重新截图。
 * 代价：内容若要靠点击后的网络请求才注入（如「加载更多评论」），这里展开不了，
 * 那种情况交给 run.mjs 的 E（真实点击页面控件后重新提取）。
 *
 * ⚠️ 必须**幂等**：每次都从 linesBase 重建，而不是在 page.lines 上追加 ——
 *    否则反复按 e 会把正文重复插进去。
 *
 * @param {object} page   buildTextPage 的返回
 * @param {Set|Array} openIds  已展开的折叠 id
 * @param {number} width  终端宽度（正文需要重新折行 —— 排版层已经定稿，不会再折）
 */
export function applyFoldState(page, openIds, width = 80) {
  const base = page.linesBase || page.lines
  const open = openIds instanceof Set ? openIds : new Set(openIds || [])
  const out = []
  for (const l of base) {
    if (l.type !== "fold") { out.push(l); continue }
    const f = l.fold
    if (!f || !open.has(l.block.foldId)) { out.push(l); continue }

    const ind = l.indent ?? 1
    out.push({
      type: "text",
      text: `▾ ▣ ${f.label || "折叠内容"} · 已展开 ${f.len} 字 · 按 e 收起`,
      indent: ind,
      style: { foldHead: true },
      item: l.block,
    })
    const avail = Math.max(8, width - (ind + 2))
    const paras = String(f.text || "").split("\n").map((s) => s.trim()).filter(Boolean)
    paras.forEach((p, i) => {
      if (i > 0) out.push({ type: "blank" })
      for (const w of wrapByWidth(p, avail)) {
        out.push({ type: "text", text: w, indent: ind + 2, style: { foldBody: true }, item: l.block })
      }
    })
    if (f.truncated) {
      out.push({
        type: "text", text: `…（原文超过 ${f.len} 字，此处截断）`,
        indent: ind + 2, style: { foldBody: true }, item: l.block,
      })
    }
  }
  page.lines = out
  return out
}

/**
 * 把排版结果转成 buildRows 需要的 runs 数组。
 * @param {object} page  buildTextPage 的返回
 * @param {object} o     { width, maxRows, yOffset }
 * @returns {{ rows: Array<Array<run>>, totalRows: number }}
 */
export function renderTextPage(page, o = {}) {
  const width = o.width || 80
  const maxRows = o.maxRows || 30
  const yOffset = o.yOffset || 0
  const rows = []

  // ── 必须完整渲染所有行，最后再切片取窗口 ──
  // 早期写法在循环里写 `if (rows.length >= maxRows + yOffset) break`，
  // 结果 totalRows 永远等于 maxRows + yOffset —— 调用方据此算出的
  // 「最大滚动偏移」恒为 0，长页面根本滚不动。
  // 这个 bug 很隐蔽：首屏看起来完全正常，只有往下滚才发现到底了。
  // 现在无条件生成全部行，由末尾的 slice 决定窗口。
  const mkTextRun = (txt, style, w, src) => {
    let fg = C.text
    if (style?.link) fg = C.blue
    if (style?.heading) fg = C.accent
    if (style?.big) fg = C.fg
    if (style?.bold && !style?.link) fg = C.fg
    if (style?.dim && !style?.link) fg = C.weak
    if (style?.foldHead) fg = C.gold     // 折叠内容标题（和选中高亮同色，表示"可操作"）
    if (style?.foldBody) fg = C.dim      // 展开出来的正文：稍暗，与页面原生正文区分开
    if (style?.fieldInput) fg = C.cyan   // 可输入控件（青色 = 可以打进去）
    if (style?.fieldBtn) fg = C.gold     // 提交/按钮
    if (style?.fieldOff) fg = C.weak     // 禁用/只读
    if (style?.fieldActive) fg = C.gold  // 正在输入的控件
    // src = 这段字符来自哪个 DOM 块。鼠标命中判定全靠它（见 mouse.js#hitTestRows）：
    // run 的宽度是截断后的真实占用，反查「点在哪个块上」比事后拿坐标猜准得多。
    return { t: txt, fg, bg: C.bg, w: w !== undefined ? w : strWidth(txt), src }
  }

  for (const l of page.lines) {
    // 不再提前中断：必须完整渲染才能算出 totalRows

    if (l.type === "blank") {
      rows.push([{ t: " ".repeat(width), fg: C.text, bg: C.bg, w: width }])
      continue
    }

    // ── 折叠内容标记行（未展开状态）──
    // 站点的「展开全文 / 查看更多」在文字浏览器里曾经是**死路**：
    // 文字看不到（display:none 被过滤），点了又可能跳转。
    // 现在这里直接把「这里有一段 X 字的折叠内容」讲清楚，按 e 就能就地读全文。
    if (l.type === "fold") {
      const f = l.fold || {}
      // 顺序讲究：先给「可操作信息」，最后才是内容预览 ——
      // 一旦宽到要截断，被截掉的是预览而不是按键提示。
      const preview = String(f.text || "").split("\n").find((s) => s.trim()) || ""
      const lab = `▸ ▣ 折叠内容 · ${f.label || "展开"} · ${f.len || 0} 字 · 按 e 展开` +
        (preview ? ` │ ${preview.trim()}` : "")
      const ind = l.indent ?? 1
      const clipped = truncateByWidth(" ".repeat(ind) + lab, width)
      const cw = strWidth(clipped)
      rows.push([
        { t: clipped, fg: C.gold, bg: C.bg, w: cw, src: l.block },
        { t: " ".repeat(Math.max(0, width - cw)), fg: C.text, bg: C.bg, w: Math.max(0, width - cw) },
      ])
      continue
    }

    // ── 表单控件行 ──
    // 投诉的根子：必应的搜索框在文字模式里**完全不存在**（提取器只认文字块/媒体块）。
    // 现在每个控件固定占一行：前面画个 ▢，可输入的是青色、提交按钮是金色、
    // 禁用/只读是灰色，行尾写明「按 i 输入」。
    // 正在输入的那个控件换成 ▶ 并标「输入中」—— 用户总得知道字符会打到哪儿去。
    if (l.type === "field") {
      const list = l.blocks || (l.block ? [l.block] : [])
      const ind = l.indent ?? 1
      const runs = []
      let used = 0
      if (ind > 0) { runs.push({ t: " ".repeat(ind), fg: C.text, bg: C.bg, w: ind }); used = ind }

      let first = true
      let hasEditable = false
      const push = (t, style, src) => {
        if (!t) return
        const sep = first ? "" : "  "
        const room = width - used
        if (room <= 0) return
        const clipped = truncateByWidth(sep + t, room)
        if (!clipped) return
        const w = strWidth(clipped)
        runs.push(mkTextRun(clipped, style, w, src))
        used += w
        first = false
      }

      for (const f of list) {
        if (!f) continue
        const active = o.activeFid !== undefined && f.fid === o.activeFid
        if (f.btn) {
          push("[ " + (f.value || f.label || "提交") + " ]", { fieldBtn: true }, f)
          continue
        }
        const kind = fieldKindName(f)
        const nm = fieldDisplayName(f)
        const body = (active ? "▶ " : "▢ ") + kind + (nm ? "「" + nm + "」" : "") +
          (f.disabled ? " · 已禁用"
            : f.readonly ? " · 只读"
            : f.value ? " ▸ " + f.value : " · 空")
        push(body, active ? { fieldActive: true }
          : f.disabled || f.readonly ? { fieldOff: true } : { fieldInput: true }, f)
        if (!f.disabled && !f.readonly) hasEditable = true
      }
      if (hasEditable) push("按 i 输入", { dim: true })

      if (used < width) runs.push({ t: " ".repeat(width - used), fg: C.text, bg: C.bg, w: width - used })
      rows.push(runs)
      continue
    }

    if (l.type === "media") {
      const alt = l.alt ? " " + l.alt : ""
      const dim = `${l.srcW}×${l.srcH}`

      // ── 二维码无损档 ──
      // 模块矩阵是从页面直接读的（canvas/img 的像素），不是截图降采样，
      // 所以这里是 1 模块 = 1 个（或半对）字符的**无丢失**映射。
      // 画出来的东西手机能真扫出来，不同于下面那些"只能看出轮廓"的字符画。
      if (l.qrCells) {
        const g = l.qrCells
        const lab = `─ ${l.tag} 二维码 ${g.n}×${g.n} 模块 · 无损直读，可直接扫 `
        const labClipped = truncateByWidth(lab, Math.max(0, width - 2))
        const labW = strWidth(labClipped)
        rows.push([
          { t: labClipped, fg: C.accent, bg: C.bg, w: labW, src: l.block },
          { t: "─".repeat(Math.max(0, width - labW)), fg: C.borderDim, bg: C.bg, w: Math.max(0, width - labW) },
        ])

        // 居中。左右留白用页面底色（不是白色）—— 白色静区由 art 自己带，
        // 这样二维码四周是"白框 + 页面底"，定位角轮廓才清晰。
        const padLeft = Math.max(0, Math.floor((width - g.cols) / 2))
        for (let r = 0; r < g.rows; r++) {
          const runs = []
          if (padLeft > 0) runs.push({ t: " ".repeat(padLeft), fg: C.text, bg: C.bg, w: padLeft })
          // 合并相邻同色格：41 列的二维码不合并会产出 800+ 个 run，
          // 每帧几十 KB 的 ANSI，白白拖慢重绘。
          let c = 0
          while (c < g.cols) {
            const i = r * g.cols + c
            const ch = g.ch[i], fgc = g.fg[i], bgc = g.bg[i]
            let n2 = c + 1
            while (n2 < g.cols) {
              const i2 = r * g.cols + n2
              if (g.ch[i2] !== ch) break
              const f2 = g.fg[i2], b2 = g.bg[i2]
              if (f2[0] !== fgc[0] || f2[1] !== fgc[1] || f2[2] !== fgc[2]) break
              if (b2[0] !== bgc[0] || b2[1] !== bgc[1] || b2[2] !== bgc[2]) break
              n2++
            }
            runs.push({ t: ch.repeat(n2 - c), fg: fgc, bg: bgc, w: n2 - c })
            c = n2
          }
          const used = padLeft + g.cols
          if (used < width) runs.push({ t: " ".repeat(width - used), fg: C.text, bg: C.bg, w: width - used })
          rows.push(runs)
        }
        continue
      }

      // ── 图标档 / 未抓取档：不给图，一行占位 ──
      // 20×20 的 favicon / 无障碍徽标没有任何可读信息，
      // 把它放大成 14 行字符画只会把正文挤出首屏。
      // 「未抓取」（超预算/超时/用户中断）也走这里 —— 但**必须写明原因**，
      // 否则用户只会觉得"图莫名其妙没了"，而看不出是我们主动省的。
      if (!l.art) {
        const why = l.skipped ? ` · 未抓取（${l.skipped}）` : ""
        const tag = `  ▫ ${l.tag}${alt} ${dim}${why}`
        const clipped = truncateByWidth(tag, width)
        rows.push([
          { t: clipped, fg: C.weak, bg: C.bg, w: strWidth(clipped), src: l.block },
          { t: " ".repeat(Math.max(0, width - strWidth(clipped))), fg: C.text, bg: C.bg, w: Math.max(0, width - strWidth(clipped)) },
        ])
        continue
      }

      // ── 有图档：标签行 + 字符画，不再加下框线（省一行，画面更紧凑）──
      // 标签用「截断后的宽度」算剩余横线 —— 否则长 alt
      // （如「本站提供适老化无障碍服务」）会被截断，但横线仍按原长算，
      // 行总宽就成了 width+1，页面区左右边框被顶出去。
      const label = `─ ${l.tag}${alt} ${dim} `
      const labelClipped = truncateByWidth(label, Math.max(0, width - 2))
      const labelW = strWidth(labelClipped)
      const restW = Math.max(0, width - labelW)
      rows.push([
        { t: labelClipped, fg: C.weak, bg: C.bg, w: labelW, src: l.block },
        { t: "─".repeat(restW), fg: C.borderDim, bg: C.bg, w: restW },
      ])

      // 居中的字符画。art.cols 可能贴着 width-4，加上左右留白不能超宽，
      // 超出时裁掉（宁可少画几列，也不能顶破页面区边框）。
      const artW = Math.min(l.art.cols, Math.max(1, width))
      const padLeft = Math.max(0, Math.floor((width - artW) / 2))
      for (let r = 0; r < l.art.rows; r++) {
        const runs = [{ t: " ".repeat(padLeft), fg: C.text, bg: C.bg, w: padLeft }]
        let c = 0
        while (c < artW) {
          const gi = r * l.art.cols + c
          const ch = String.fromCharCode(l.art.chars[gi])
          const fg = [l.art.color[gi * 3], l.art.color[gi * 3 + 1], l.art.color[gi * 3 + 2]]
          let nc = c + 1
          while (nc < artW) {
            const g2 = r * l.art.cols + nc
            if (String.fromCharCode(l.art.chars[g2]) !== ch) break
            const d = Math.abs(l.art.color[g2 * 3] - fg[0]) +
              Math.abs(l.art.color[g2 * 3 + 1] - fg[1]) +
              Math.abs(l.art.color[g2 * 3 + 2] - fg[2])
            if (d > 60) break
            nc++
          }
          runs.push({
            t: String.fromCharCode(...l.art.chars.subarray(gi, gi + (nc - c))),
            fg, bg: C.bg, w: nc - c,
          })
          c = nc
        }
        const used = runs.reduce((a, x) => a + (x.w || 0), 0)
        if (used < width) runs.push({ t: " ".repeat(width - used), fg: C.text, bg: C.bg, w: width - used })
        else if (used > width) {
          // 理论上不会发生；真发生了就截掉尾部，保证行宽守恒
          let acc = 0
          const fixed = []
          for (const x of runs) {
            const w = x.w || 0
            if (acc + w <= width) { fixed.push(x); acc += w }
            else {
              const room = width - acc
              if (room > 0) fixed.push({ ...x, t: truncateByWidth(String(x.t), room), w: room })
              acc = width
              break
            }
          }
          runs.length = 0
          runs.push(...fixed)
        }
        rows.push(runs)
      }
      continue
    }

    // 文字行
    //
    // 一行可能是多个「行内合并」的块拼出来的（`登录 注册 帮助` 这种导航行）。
    // 所以这里按 segs 逐段生成 run，每段带自己的样式和来源块：
    //   · 点击能分辨「这一段是哪个链接」—— 否则点「注册」会打开「登录」
    //   · 每段用自己的颜色 —— 原来整行套合并样式，一个链接会把整行染蓝
    // 宽度守恒靠「先截断、再量宽」保证：每段都按剩余可用列数截，总和必然 ≤ width。
    const indent = l.indent ?? 1
    const lead = l.style?.link ? "› " : ""
    const prefix = " ".repeat(indent) + lead
    const segs = (l.segs && l.segs.length)
      ? l.segs
      : [{ t: l.text, src: l.src || l.item, style: l.style }]

    const runs = []
    let used = 0
    const pushSeg = (t, style, src) => {
      if (!t) return
      const room = width - used
      if (room <= 0) return
      const clipped = truncateByWidth(t, room)
      if (!clipped) return
      const w = strWidth(clipped)
      runs.push(mkTextRun(clipped, style, w, src))
      used += w
    }
    // 前缀跟着首段的颜色走，保持和原来一模一样的观感
    if (prefix) pushSeg(prefix, segs[0]?.style, segs[0]?.src)
    for (const sg of segs) pushSeg(sg.t, sg.style, sg.src)

    if (used < width) runs.push({ t: " ".repeat(width - used), fg: C.text, bg: C.bg, w: width - used })
    rows.push(runs)
  }

  return { rows: rows.slice(yOffset, yOffset + maxRows), totalRows: rows.length }
}

/**
 * 建立「文档 y → 渲染行索引」映射，供叠加层把元素框画到正确行上。
 *
 * 为什么不能直接用 (y - scrollY) / 行高：
 *   文字模式下每行装的是「一段文字」，不是 8px 像素条。一行可能对应
 *   16px 的导航项，也可能是折行后 3 行的一段说明。所以必须记住
 *   「哪一块文字被排到了第几行」，再用块自身的 y 去插值。
 *
 * 做法：取每个文字行的源块 y，排序后线性插值到目标行号；
 * 块之间的间隙（空行）也按比例落进去，视觉上足够贴近。
 */
/**
 * 一条排版行最终会占几个渲染行。
 * 必须与 renderTextPage 的实际 push 次数严格一致，否则叠加层会错位：
 *   blank            → 1
 *   media 无图（图标档）→ 1（占位行）
 *   media 有图        → 1（标签行） + art.rows（不再有下框线）
 *   text             → 1（layout 已按宽度折好行）
 */
export function renderedRowCount(l) {
  if (!l) return 1
  if (l.type === "media") return l.art ? 1 + (l.art.rows || 0) : 1
  // field 行：不管一行里合并了几个控件，都只占 1 行
  return 1
}

/**
 * 某个表单控件落在**第几个渲染行**上（找不到返回 -1）。
 *
 * 用途：按 `i` 进输入模式时把控件行滚进可视窗口 —— 控件行在屏幕外时
 * 用户打完字什么都看不见，会被判定成"输入法坏了"。
 *
 * ⚠️ 必须在 `page.lines` 上用 `renderedRowCount` 累加，**不要**另做一次
 * 全量 `renderTextPage` 再回头找行号：媒体块按 `qrMaxRows` / `maxMediaRows`
 * 展开，参数与当前窗口不一致时算出的行号就不一样（有二维码的页面必错）。
 * 这里与 `renderTextPage` 用的是同一套行数记账，所以天然对齐。
 *
 * @param {object} page buildTextPage 的返回
 * @param {number|string} fid 控件的 data-etui-field 编号
 */
export function fieldRowInPage(page, fid) {
  if (!page || fid === undefined || fid === null) return -1
  let acc = 0
  for (const l of page.lines || []) {
    const hit = l.type === "field"
      && (l.blocks || []).some((b) => b && b.fid !== undefined && String(b.fid) === String(fid))
    if (hit) return acc
    acc += renderedRowCount(l)
  }
  return -1
}

/**
 * 建立「布局坐标 → 渲染行索引」映射，供叠加层把元素标记画到正确行上。
 *
 * ⚠️ 不能用「y 单调插值」。阅读顺序用的是 DOM 文档顺序（见 extract.js），
 * 多栏页面的 y 会来回折返 —— 知乎登录页先排完左栏扫码面板（y 38…584），
 * 再排右栏登录表单（y 159…563）。单调插值会把这次折返当成"同一段"，
 * 于是 y=159 被夹在 y=38 和 y=241 之间算成第 3 行，而实际是第 23 行。
 * 症状：元素清单的行首标记与整行高亮统统印在页面顶部。
 *
 * ⚠️ 也不能只用「y 最近」。多栏布局里两栏的纵区间是**交叠**的：
 * 「打开知乎App」（左栏 y 241…262）和「中国 +86」（右栏 y 245…264）
 * 都会认领 y≈245，只按 y 找必然认错栏。
 *
 * 正确做法是**二维矩形重叠匹配**：
 *   ① 取与目标矩形重叠面积最大的锚点 —— 真正在二维上"盖住"它的那一行
 *   ② 完全没有重叠时（元素是包裹层、本身不是文字块）退化为最近距离
 * 所以 mapper 的签名是 (y, x, w, h)；只传 y 会失去横向分辨力。
 *
 * 目标行号是**渲染行**（renderTextPage 输出的行号），不是排版行号：
 * 媒体块会展开成多行（标签 + 字符画），必须用 renderedRowCount() 累加。
 *
 * @param {object} page  buildTextPage 的返回
 * @param {object} o     { yOffset, pxPerRow, viewOffsetY }
 * @returns {(y:number, x?:number, w?:number, h?:number) => number}
 */
export function makeLineMapper(page, o = {}) {
  const yOffset = o.yOffset || 0
  const pxPerRow = o.pxPerRow || 8
  const viewY = o.viewOffsetY || 0

  const anchors = []
  let rowAcc = 0
  for (const l of page.lines) {
    // 媒体行与表单控件行带 block（布局行不是文字块，没有 item）；
    // 文字行带 item。两者都要做锚点，否则元素清单的标记找不到这些行。
    const src = (l.type === "media" || l.type === "field") ? l.block : l.item
    if (src && Number.isFinite(src.y)) {
      const hasX = Number.isFinite(src.x)
      const w = Number.isFinite(src.w) ? src.w : 0
      anchors.push({
        y0: src.y,
        y1: src.y + (Number.isFinite(src.h) ? src.h : 0),
        x0: hasX ? src.x : 0,
        x1: hasX ? src.x + w : Infinity,
        hasX,
        row: rowAcc,
      })
    }
    rowAcc += renderedRowCount(l)
  }
  if (!anchors.length) return (y) => Math.round((y - viewY) / pxPerRow)

  // 有重叠的一律优先于无重叠：分数加上一个大常数
  const OVERLAP_BONUS = 1e9

  return (y, x, w, h) => {
    const hasX = Number.isFinite(x)
    const ew = Number.isFinite(w) && w > 0 ? w : 1
    const eh = Number.isFinite(h) && h > 0 ? h : 1
    const ex0 = hasX ? x : 0
    const ex1 = hasX ? x + ew : Infinity
    const ey0 = y
    const ey1 = y + eh

    let best = anchors[0]
    let bestScore = -Infinity
    for (const a of anchors) {
      // 横向重叠：无 x 信息时视为完全重叠（退化成纯纵向匹配）
      const ox = hasX ? Math.min(a.x1, ex1) - Math.max(a.x0, ex0) : 1
      const oy = Math.min(a.y1, ey1) - Math.max(a.y0, ey0)

      let score
      if (ox > 0 && oy > 0) {
        score = OVERLAP_BONUS + ox * oy
      } else {
        // 无重叠：用「矩形间距的平方」取负，越小越优
        const ddx = hasX ? Math.max(0, Math.max(a.x0 - ex1, ex0 - a.x1)) : 0
        const ddy = Math.max(0, Math.max(a.y0 - ey1, ey0 - a.y1))
        score = -(ddx * ddx + ddy * ddy)
      }
      if (score > bestScore) { bestScore = score; best = a }
    }
    return best.row - yOffset
  }
}
