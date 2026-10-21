// DOM → 结构化块序列
//
// 这是「真·文字浏览器」的核心：不再把整页截图降采样成字符噪声，
// 而是从 DOM 直接提取「文字块 + 媒体块」的有序序列，交给终端用原生字符排版。
// 好处：文字 100% 清晰可读、可复制、可搜索，不受字符画分辨率限制。
//
// 输出块结构：
//   { kind:'text',  x, y, w, h, text, fs, fw, color, href, bold, heading, pre }
//   { kind:'media', x, y, w, h, tag, alt }   ← IMG/CANVAS/VIDEO，由调用方截该区域转 ASCII
//   { kind:'fold',  x, y, w, h, foldId, label, len }  ← 被站点折叠起来的内容（见下）
//   { kind:'field', x, y, w, h, tag, type, fid, label, ph, value, score }
//                                            ← 表单控件（输入框/文本域/下拉框/提交按钮）
//
// 返回值是 **{ blocks, folds, fields, droppedHidden }**：
//   blocks —— 按 DOM 文档顺序的块序列
//   folds  —— 折叠内容清单 [{ id, label, reason, len, text, x, y, w, h }]
//             text 是折叠起来的**全文**（已剥离 script/style、按块级元素补了换行），
//             文字浏览器可以完全不点页面、直接把这段文字就地展开。
//   fields —— 表单控件清单，字段与 kind:'field' 的块一一对应。
//             fid 是编号，同时写进 DOM 的 data-etui-field 属性，
//             供 cdp.js#focusField / fieldValue 精确定位（不依赖坐标点击）。
//
// 坐标系为**布局坐标**（`getBoundingClientRect()` 还原掉自身之外所有滚动祖先的
// scrollTop/scrollLeft）。这样坐标**与页面滚动无关**：
//
//   文字模式下排版只做一次，之后用户按 Tab / 走元素清单都可能让页面滚起来。
//   如果用视口相对坐标，页面一滚，之前提取的块坐标就全废了，
//   叠加层（`v` 元素清单的行首标记/整行高亮）会整体偏移。
//   早期版本漏了这一步：顶部注释写着"含滚动偏移"，代码却直接用 `r.x/r.y`。
//
// ⚠️ 只用 `window.scrollY` 还不够 —— 很多站点（知乎登录页就是）body 不滚，
//    内容放在固定高度的 overflow:auto 容器里，必须把容器的 scrollTop 也加回来。

export const EXTRACT_BLOCKS = String.raw`(() => {
  const out = []
  const folds = []
  const fields = []
  const seen = new Set()
  // 找不到展开控件、只能整段丢掉的隐藏文字总量（纯诊断用）
  let droppedHidden = 0
  // 因超出 EXTRACT_MAX_TOP 被丢弃的**顶层子树**个数（子树整体 skip，不重复计）
  let droppedDeep = 0
  // 最深的被丢弃位置 —— 提示块要放在那里，而不是放在固定的界上
  let deepestDropped = 0

  // 表单控件的封顶。正常页面几个到几十个，病态页面（几百个字段的筛选器）
  // 会瞬间把正文挤出几十屏，所以设一个上限。
  const MAX_FIELDS = 80

  // 子树级跳过集合。用 TreeWalker 的 FILTER_REJECT 实现 —— 一旦 REJECT，
  // 整棵子树都不会再被访问。这样：
  //   · display:none 的容器只在「容器」这一层报一次，不会每个子元素各报一次
  //   · closed <details> 里除 summary 外的内容各报一次 → 不会重复
  const skip = new Set()

  // closed <details> 的折叠标记必须排在 summary **之后**。
  // 若在遇到 <details> 时就 push，提示行会印在问题标题上面，读起来是反的。
  const foldAfter = new Map()

  // 折叠正文的长度上限：个别 SPA 会把整个隐藏应用壳塞在一个 display:none 里，
  // 不加限制会产出几百 KB 的文本。
  const MAX_FOLD_TEXT = 12000
  // ── 超长页面的提取下界（⚠️ 曾经是 40000，是「加载总是停在某个位置」的元凶）──
  //
  // 这里限制的是**文档布局高度**：块坐标是布局坐标，r.top 超过它的元素被丢弃。
  // 40000px 只有约 45 屏 —— 论坛帖子、新闻评论区、商品列表、搜索结果页
  // 轻松超过，于是所有页面都在同一个高度断掉，再往下滚动就是空白，
  // 用户看到的正是「页面加载总是停止在某个位置」。
  // 放大到 400000px（≈440 屏）：覆盖 virtually 所有真实长页；
  // 同时仍是硬上界 —— 防御无限滚动 feed（scrollHeight 可以涨到百万像素级）
  // 把提取拖死。真被截断时在断点处放一行**写明原因**的提示块（见 walker 后）。
  const EXTRACT_MAX_TOP = 400000
  // 折叠正文的长度下限：标记行本身就要占一行，内容不足两行（约 80 字）时
  // 标记比内容还贵。实测见 addFold 里的注释（GitHub/百度首页的会话横幅与下拉菜单）。
  const MIN_FOLD_TEXT = 80

  // 视口坐标 → 布局坐标（抵消所有滚动祖先 + window 的滚动）
  const layoutXY = (el, r) => {
    let dx = window.scrollX || 0, dy = window.scrollY || 0
    let p = el.parentElement
    while (p) {
      if (p.scrollTop) dy += p.scrollTop
      if (p.scrollLeft) dx += p.scrollLeft
      p = p.parentElement
    }
    return [r.x + dx, r.y + dy]
  }

  const hidden = (el, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden') return true
    if (Number(cs.opacity) < 0.05) return true
    return false
  }

  const hasTextDeep = (n) => (n.innerText || '').trim().length > 0

  const parseColor = (c) => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]
  }

  // ── 折叠内容探测 ─────────────────────────────────────────────
  //
  // 背景：很多站点的正文是「折叠」的 —— <details>、display:none 的手风琴、
  // 或者点击「展开全文 / 查看更多」才注入的内容。初版提取器对 display:none
  // 一律 continue，于是这些内容在文字浏览器里**整段消失**，用户只看到
  // 「展开全文」四个字，点又点不出来。用户的原话是
  // 「很多文字部分被页面折叠了看不全，无法点击展开和查看详细」。
  //
  // 做法：把隐藏子树**连文字一起**读出来，但不直接铺进正文（会污染版面），
  // 而是登记成一条「折叠内容」标记 + 全文备用。展开由文字层完成，
  // 不依赖站点 JS（见 textbrowser.js#applyFoldState）。
  //
  // 判据刻意收紧到「必须能找到展开控件」：否则页面上所有隐藏的菜单、
  // 弹窗模板、埋点 div 都会被当成折叠内容。
  const EXPAND_RE = /展开|更多|详情|全文|显示全部|查看全部|收起|继续阅读|点击查看|more|expand|detail|show|view|read/i
  const FOLD_SKIP_TAG = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD|META|LINK|TITLE|BASE|SVG|PATH|INPUT|SELECT|TEXTAREA)$/
  const BLOCKISH = /^(P|DIV|LI|UL|OL|TR|TD|TH|SECTION|ARTICLE|H[1-6]|BLOCKQUOTE|PRE|TABLE|DD|DT|FIGURE|FIGCAPTION|ASIDE|HEADER|FOOTER|NAV|MAIN|FORM)$/

  // 读隐藏子树的可读文本：剥掉 script/style，块级元素之间补换行。
  // 注意用递归而不是 innerText —— 元素不可渲染时 innerText 回退到 textContent，
  // 会把 <script> 的代码也一起带出来。
  const textOf = (root) => {
    let s = ''
    const walk = (node, depth) => {
      if (depth > 24 || s.length > MAX_FOLD_TEXT) return
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (s.length > MAX_FOLD_TEXT) return
        if (c.nodeType === 3) { s += c.nodeValue }
        else if (c.nodeType === 1) {
          const tag = c.tagName
          if (FOLD_SKIP_TAG.test(tag)) continue
          if (tag === 'BR') { s += '\n'; continue }
          const blk = BLOCKISH.test(tag)
          if (blk && s && !s.endsWith('\n')) s += '\n'
          walk(c, depth + 1)
          if (blk && s && !s.endsWith('\n')) s += '\n'
        }
      }
    }
    walk(root, 0)
    return s.replace(/[ \t\u00a0]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
  }

  const isInteractive = (e) =>
    /^(A|BUTTON|SUMMARY|INPUT|SELECT|TEXTAREA)$/.test(e.tagName) ||
    e.hasAttribute('role') || e.hasAttribute('onclick') ||
    e.hasAttribute('tabindex') || e.hasAttribute('aria-expanded')

  // 这个元素自身是不是一个「展开控件」？
  const expandLabelOf = (e) => {
    const raw = e.getAttribute('aria-label') || ''
    if (raw && raw.length <= 28 && EXPAND_RE.test(raw)) return raw
    const tc = e.textContent || ''
    if (!tc || tc.length > 40) return ''
    const t = tc.replace(/\s+/g, ' ').trim()
    if (!t || t.length > 28) return ''
    return EXPAND_RE.test(t) ? t : ''
  }

  // 在一个子树里找一个可见的展开控件
  const toggleIn = (node) => {
    if (!node || node.nodeType !== 1) return null
    if (isVisible(node)) {
      const lb = expandLabelOf(node)
      if (lb && isInteractive(node)) return node
    }
    const kids = node.querySelectorAll(
      'a,button,summary,[role=button],[role=tab],[role=link],[onclick],[tabindex],[aria-expanded],span,em,i,b,strong,label,p,div')
    const lim = Math.min(kids.length, 120)
    for (let i = 0; i < lim; i++) {
      const c = kids[i]
      if (!isVisible(c)) continue
      const lb = expandLabelOf(c)
      if (!lb) continue
      if (!isInteractive(c) && getComputedStyle(c).cursor !== 'pointer') continue
      return c
    }
    return null
  }

  const isVisible = (e) => {
    if (!e || e.nodeType !== 1 || !e.isConnected) return false
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) return false
    const r = e.getBoundingClientRect()
    return r.width >= 2 && r.height >= 2
  }

  // 给一段隐藏内容找「它对应的那个展开控件」（用来当锚点 + 给用户一个标题）
  const findToggle = (el) => {
    // ① aria-controls / aria-owns 直接指名，最可靠
    if (el.id) {
      try {
        const id = CSS.escape(el.id)
        for (const s of ['[aria-controls="' + id + '"]', '[aria-owns="' + id + '"]']) {
          const t = document.querySelector(s)
          if (isVisible(t)) return t
        }
      } catch (e) {}
    }
    // ② 紧随其后的兄弟 —— 最常见的写法：<div style="display:none">…</div><a>展开全文</a>
    for (let n = el.nextElementSibling, k = 0; n && k < 3; n = n.nextElementSibling, k++) {
      const t = toggleIn(n)
      if (t) return t
    }
    // ③ 向上 3 层，在祖先容器里找（含 aria-expanded 语义控件）
    let scope = el.parentElement, depth = 0
    while (scope && depth < 3 && scope !== document.body) {
      const head = scope.querySelector('[aria-expanded]')
      if (isVisible(head)) return head
      const t = toggleIn(scope)
      if (t) return t
      scope = scope.parentElement
      depth++
    }
    return null
  }

  const addFold = ({ text, reason, anchor, sourceTag, afterEl }) => {
    // ⚠️ 折叠标记本身就要占一行。内容不足两行（约 80 字）时，**标记比内容还贵**。
    // 实测（tests/probe-ux.mjs）：GitHub Trending 首页 10 个折叠里 6 个是
    // 「You signed in with another tab…」这类会话横幅（13–79 字），百度首页 14 个
    // 里全是「更多 · 37 字」这种下拉菜单 —— 首屏被折叠标记线占掉 5–9 行。
    // 真正值得暴露的"展开全文"正文通常是几百上千字。
    if (text.length < MIN_FOLD_TEXT) return
    if (folds.length >= 200) return   // 病态页面（几百个隐藏弹窗模板）直接封顶
    let clipped = text
    let truncated = false
    if (clipped.length > MAX_FOLD_TEXT) { clipped = clipped.slice(0, MAX_FOLD_TEXT); truncated = true }
    const id = 'f' + folds.length
    const r = anchor.getBoundingClientRect()
    const [ax, ay] = layoutXY(anchor, r)
    const label = ((anchor.tagName === 'SUMMARY'
        ? (anchor.innerText || anchor.textContent || '')
        : (anchor.innerText || anchor.textContent || ''))
      ).replace(/\s+/g, ' ').trim().slice(0, 26) || '展开'
    const rec = {
      id, reason, label, len: clipped.length, truncated,
      text: clipped, sourceTag,
      x: Math.round(ax), y: Math.round(ay),
      w: Math.round(r.width), h: Math.round(r.height),
    }
    folds.push(rec)
    const blk = {
      kind: 'fold',
      x: rec.x, y: rec.y, w: rec.w, h: rec.h,
      foldId: id, label: rec.label, len: rec.len, reason,
    }
    if (afterEl) {
      const arr = foldAfter.get(afterEl) || []
      arr.push(blk)
      foldAfter.set(afterEl, arr)
    } else {
      out.push(blk)
    }
    return rec
  }

  // ── 采用 DOM 文档顺序，而不是几何坐标排序 ──
  // 理由：网页是绝对定位的小字，按 (y,x) 排序会把左右两栏交错在一起
  // （知乎登录页左栏二维码面板与右栏表单 y 区间重叠，几何排序必然串行）。
  // 而 DOM 顺序本身就是作者编排的阅读顺序 —— 左栏读完读右栏，最后读页脚，
  // 完全符合人的习惯，也正是 w3m/lynx 的做法。
  // 坐标仅用于「判断块之间的关系」（同行合并、间距给空行），不再用于排序。
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      return skip.has(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  let el
  while ((el = walker.nextNode())) {
    const cs = getComputedStyle(el)
    const tag = el.tagName

    // ── ① 隐藏子树：要么登记成「折叠内容」，要么整棵丢掉 ──
    //
    // ⚠️ display:none 用 REJECT 是安全的：子元素不可能比父元素更可见。
    //   而 visibility:hidden 不行 —— 子元素可以 visibility:visible 覆盖回来
    //   （站点常用的"隐藏菜单但露出一个角"写法），所以那种情况只 continue。
    if (cs.display === 'none') {
      skip.add(el)
      if (!/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|HEAD|META|LINK|TITLE|BASE|INPUT|SELECT|TEXTAREA|BR)$/.test(tag)) {
        const text = textOf(el)
        if (text.length >= 12) {
          const tg = findToggle(el)
          if (tg) addFold({ text, reason: 'hidden', anchor: tg, sourceTag: tag })
          else droppedHidden += text.length
        }
      }
      continue
    }

    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue

    // ── ② closed <details>：内容在 <details> 里，控件是 <summary> ──
    if (tag === 'DETAILS') {
      if (!el.hasAttribute('open')) {
        const summary = el.querySelector(':scope > summary')
        let txt = ''
        for (const c of [...el.children]) {
          if (c === summary) continue
          txt += textOf(c) + '\n'
        }
        txt = txt.replace(/\n{3,}/g, '\n\n').trim()
        if (txt.length >= 12) {
          for (const c of [...el.children]) if (c !== summary) skip.add(c)   // 这些子树不再单独访问
          // 锚点用 summary —— 它才是用户看得到的那一行
          addFold({ text: txt, reason: 'details', anchor: summary || el, sourceTag: tag, afterEl: summary || null })
        }
        // 内容不足 12 字：不登记折叠、也不跳过子树，让它照常提取（等于默认展开）
      }
      continue
    }

    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (r.bottom < -3000 || r.top > EXTRACT_MAX_TOP) {
      // 整棵子树标记 skip：TreeWalker 对 skip 里的节点返回 FILTER_REJECT，
      // 不再下访 —— 计数因此是「顶层块数」而不是所有后代元素数，
      // 同时也省掉了对超长尾部的无谓遍历。
      skip.add(el)
      droppedDeep++
      // 必须走 layoutXY（布局坐标）：r.top 是提取瞬间的视口坐标，
      // 页面滚着的时候直接拿来当块 y 会与其它块错开一个滚动量。
      const ly = layoutXY(el, r)[1]
      if (ly > deepestDropped) deepestDropped = ly
      continue
    }

    // ── ②½ iframe：登录组件、验证码、支付面板大量内嵌 iframe ──
    // 同源 iframe 的文字直接并进主文档流（一个文字块），用户至少看得见里面
    // 有什么；交互（点按钮/打字）走元素清单的递归枚举 + 真实键盘鼠标。
    // 跨源 iframe 读 contentDocument 会被浏览器安全模型拦住 —— 如实标注占位，
    // 不假装读到了。
    if (tag === 'IFRAME' || tag === 'FRAME') {
      skip.add(el)   // 不再访问其后备内容（<iframe>fallback</iframe>）
      if (r.width >= 12 && r.height >= 12) {
        const [ix, iy] = layoutXY(el, r)
        let inner = ''
        let cross = false
        try {
          const d = el.contentDocument
          if (d && d.body) inner = (d.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
          else if (!d) cross = true   // data:/about:blank 类 opaque origin：返回 null 而不是抛
        } catch (e) { cross = true }
        if (inner) {
          out.push({
            kind: 'text', tag: 'IFRAME',
            x: Math.round(ix), y: Math.round(iy),
            w: Math.round(r.width), h: Math.round(r.height),
            text: inner.slice(0, 4000),
            fs: 16, fw: 400, color: [0, 0, 0],
            href: '', bold: false, heading: false, align: '', block: true,
          })
        } else {
          out.push({
            kind: 'media', tag: 'IFRAME',
            x: Math.round(ix), y: Math.round(iy),
            w: Math.round(r.width), h: Math.round(r.height),
            alt: cross ? '（跨域 iframe，内容不可读）' : '（空 iframe）',
          })
        }
      }
      continue
    }

    // 媒体块：IMG / CANVAS / VIDEO / PICTURE（二维码是 <canvas class="Qrcode-qrcode">）
    if (/^(IMG|CANVAS|VIDEO|PICTURE)$/.test(tag)) {
      if (r.width >= 12 && r.height >= 12) {
        const key = 'm' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width)
        if (!seen.has(key)) {
          seen.add(key)
          const [mx, my] = layoutXY(el, r)
          out.push({
            kind: 'media', tag,
            x: Math.round(mx), y: Math.round(my),
            w: Math.round(r.width), h: Math.round(r.height),
            alt: el.getAttribute('alt') || el.getAttribute('aria-label') || '',
          })
        }
      }
      continue
    }

    // ── ③ 表单控件：输入框 / 文本域 / 下拉框 / 提交按钮 ──
    //
    // 用户投诉原话：「Bing 页面看不到搜索的输入框，无法搜索」。
    // 根因：<input> **自身没有文字节点**，也不是媒体块 —— 走到下面
    // 「只收叶子文字块」那段时 directText 为空，直接 continue。
    // 于是必应首页那个 659×42、明明白白可见的搜索框，在文字模式里
    // **完全不存在**：页面看上去根本没有搜索功能，而 Tab 又未必能聚焦到它。
    //
    // 所以表单控件必须是一等公民：既要在文本流里占一行（看得见），
    // 又要能被精确定位并按编号聚焦（打得进，见 cdp.js#focusField）。
    // 走的不是坐标点击 —— 窄视口下表单常比视口宽，坐标点击会落空（坑 #14）。
    // contenteditable 富文本（在线编辑器、评论框、聊天输入框…）也是一等公民：
    // 没有 value 属性、不是 INPUT —— 老判定直接漏掉，用户看到的编辑器"不存在"。
    const isRich = tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' &&
      (() => { try { return !!el.isContentEditable } catch (e) { return false } })()
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || isRich) {
      const type = isRich ? 'richtext'
        : (el.getAttribute('type') || (tag === 'INPUT' ? 'text' : tag.toLowerCase())).toLowerCase()
      if (type !== 'hidden' && fields.length < MAX_FIELDS) {
        const fid = fields.length
        // 在 DOM 上留个锚点。只加一个 data-* 属性，不改样式、不改行为。
        try { el.setAttribute('data-etui-field', String(fid)) } catch (e) {}
        const [fx, fy] = layoutXY(el, r)

        // 标签：<label for> → 包裹式 <label> → aria-label/title → placeholder → name/id
        const labelOf = () => {
          if (el.id) {
            try {
              const lb = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
              if (lb) { const t = (lb.innerText || '').replace(/\s+/g, ' ').trim(); if (t) return t }
            } catch (e) {}
          }
          const wl = el.closest('label')
          if (wl) { const t = (wl.innerText || '').replace(/\s+/g, ' ').trim(); if (t) return t }
          return el.getAttribute('aria-label') || el.getAttribute('title') || ''
        }

        const isBtn = /^(submit|button|reset|image)$/.test(type)
        let val = ''
        if (isBtn) {
          val = String(el.value || el.getAttribute('alt') || '')
        } else if (tag === 'SELECT') {
          const so = el.selectedOptions && el.selectedOptions[0]
          val = so ? (so.textContent || '') : ''
        } else if (isRich) {
          val = String(el.innerText || '')
        } else {
          val = String(el.value || '')
        }
        val = val.replace(/\s+/g, ' ').trim().slice(0, 60)

        // 「是不是页面主搜索框」—— 按 i 时优先聚焦它。
        // 判据按可靠性排序：type=search > name/id 是 q/query/wd… > 在搜索语义的表单里。
        // 必应的搜索结果页两个都命中（type=search + name=q + 在 role=search 里）。
        const nm = (el.getAttribute('name') || '') + ' ' + (el.id || '') +
          ' ' + (el.getAttribute('placeholder') || '') + ' ' + labelOf()
        let score = 0
        if (type === 'search') score += 100
        if (/^(q|query|wd|kw|keyword|s|search|key)$/i.test((el.getAttribute('name') || '').trim())) score += 40
        if (/搜索|检索|search/i.test(nm)) score += 25
        try {
          if (el.closest('[role=search], form[role=search], form[action*="search" i], form[action*="/s" i]')) score += 30
        } catch (e) {}
        if (type === 'textarea') score -= 10
        if (el.disabled) score -= 200
        if (el.readOnly) score -= 60
        if (type === 'checkbox' || type === 'radio') score -= 40
        if (/captcha|验证码/i.test(nm)) score -= 15
        if (r.width >= 120) score += 10

        const rec = {
          kind: 'field',
          tag, type, btn: isBtn, fid,
          x: Math.round(fx), y: Math.round(fy),
          w: Math.round(r.width), h: Math.round(r.height),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          label: labelOf().replace(/\s+/g, ' ').trim().slice(0, 60),
          ph: (el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          value: val,
          disabled: !!el.disabled,
          readonly: !!el.readOnly,
          checked: !!el.checked,
          score,
        }
        fields.push(rec)
        out.push(rec)
        // <select> 的 <option> 都是有文字的子元素 —— 不剪掉它们，
        // 每个选项都会单独排一行，一个省市区三级下拉能灌进上百行。
        if (tag === 'SELECT') skip.add(el)
        // contenteditable 同理：内容已在 field 行回显，再走文字块就是双呈现
        if (isRich) skip.add(el)
      }
      continue
    }

    // 只收「叶子文字块」：自身含文字，且没有含文字/媒体的子元素
    const kids = [...el.childNodes]
    const elemKids = kids.filter(n => n.nodeType === 1 && hasTextDeep(n))
    const mediaKids = kids.filter(n => n.nodeType === 1 && /^(IMG|CANVAS|VIDEO|PICTURE)$/.test(n.tagName))
    if (elemKids.length || mediaKids.length) {
      // 容器本身不产出文字块，但 closed <details> 挂在这儿的折叠标记要补上
      const pend0 = foldAfter.get(el)
      if (pend0) out.push(...pend0)
      continue
    }

    let directText = kids.filter(n => n.nodeType === 3).map(n => n.textContent).join('')
    // 图标字体（iconfont）用的是私有区码位（U+E000–U+F8FF），终端字体没有对应字形，
    // 渲染出来就是空白 —— 于是出现「› 」这种**空链接行**（百度首页实测一堆）。
    // 全角/零宽字符同理。剥掉之后纯图标块会因 t 为空被自然丢弃。
    const t = (directText || el.innerText || '')
      .replace(/[\uE000-\uF8FF\u200B-\u200F\uFEFF\uFFF9-\uFFFE\uFFFD]/g, '')
      .replace(/\s+/g, ' ').trim()

    const pend = foldAfter.get(el)
    if (!t) { if (pend) out.push(...pend); continue }

    const key = 't' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + t.slice(0, 24)
    if (seen.has(key)) { if (pend) out.push(...pend); continue }
    seen.add(key)

    const fw = parseInt(cs.fontWeight) || 400
    const [bx, by] = layoutXY(el, r)
    out.push({
      kind: 'text', tag,
      x: Math.round(bx), y: Math.round(by),
      w: Math.round(r.width), h: Math.round(r.height),
      text: t,
      fs: parseFloat(cs.fontSize) || 16,
      fw,
      color: parseColor(cs.color),
      href: (el.closest('a')?.getAttribute('href') || ''),
      bold: fw >= 600,
      heading: /^H[1-6]$/.test(tag),
      align: cs.textAlign,
      // display 类型影响行内还是块级
      block: !/^(SPAN|A|B|I|EM|STRONG|CODE|LABEL|SMALL|SUB|SUP)$/.test(tag),
    })
    if (pend) out.push(...pend)
  }

  // ── 截断提示：真被界切掉的，必须在断点处如实说明，而不是让页面"神秘地"没了 ──
  // y 放在最深被丢弃块处（提示行出现在内容断掉的位置，读起来是顺的）。
  if (droppedDeep > 0) {
    const docH = (document.documentElement && document.documentElement.scrollHeight) || 0
    out.push({
      kind: 'text', tag: 'DIV',
      x: 0, y: Math.round(deepestDropped),
      w: Math.min(1100, window.innerWidth || 900), h: 40,
      text: '── 页面过长，此位置以下约 ' + droppedDeep + ' 个区块未加载（页面总高 ' +
        Math.round(docH / 1000) + 'k 像素）──',
      fs: 15, fw: 600, color: [130, 130, 130],
      href: '', bold: true, heading: false, align: 'center', block: true,
    })
  }

  return { blocks: out, folds, fields, droppedHidden, droppedDeep }
})()`

/** 页面基础信息 */
export const PAGE_META = `({
  url: location.href,
  title: document.title,
  scrollY: window.scrollY,
  scrollX: window.scrollX,
  innerH: window.innerHeight,
  innerW: window.innerWidth,
  docH: document.documentElement.scrollHeight,
  scrollHost: (() => {
    const d = document.documentElement
    if (d.scrollHeight - window.innerHeight > 8) return 'window'
    let best = null, over = 8
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue
      const o = el.scrollHeight - el.clientHeight
      if (o > over) { over = o; best = el }
    }
    if (best) { window.__etuiScrollEl = best; return 'el' }
    return 'window'
  })(),
  // 提取块坐标时抵消掉的总滚动量。块的坐标是「布局坐标」（与滚动无关），
  // 想还原成当前视口内的位置就要减掉它 —— 视口过滤用得上。
  scrollLayoutY: (() => {
    let dy = window.scrollY || 0
    const se = window.__etuiScrollEl
    if (se && se.isConnected) dy += se.scrollTop || 0
    return dy
  })(),
  scrollLayoutX: (() => {
    let dx = window.scrollX || 0
    const se = window.__etuiScrollEl
    if (se && se.isConnected) dx += se.scrollLeft || 0
    return dx
  })(),
})`