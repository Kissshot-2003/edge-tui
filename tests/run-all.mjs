// 统一测试入口：串行跑每个套件，汇总通过/失败。
//
// 为什么不用 shell 循环：渲染类测试会 spawn 子进程（Edge headless），
// 从 bash 的 for 循环里调用时，超时/信号会传播到整个进程组，
// 表现成 SIGTERM 假失败。这里用 Node 的 spawn 逐个跑，各自独立。
//
// ── 环境闸门（别删）──
// 一批套件依赖真实站点（知乎 / 必应）。这些站点会对同一出口 IP 的高频自动化
// 访问返回**拦截页**：知乎给的是「安全验证 · 系统监测到您的网络环境存在异常」，
// 页面只剩 6 个块、0 个媒体、0 个控件。此时断言必然全灭，但那是**环境受限**，
// 不是代码回归。
//
// 这个区分必须做出来，因为**误报的测试套件比没有测试更糟** ——
// 一旦「跑出来是红的」变成常态，真正红了的那次也就没人看了。
// 所以在跑之前先探一次活口：探到拦截就把依赖它的套件标成「跳过」，
// 并在汇总里写明原因。要强行跑（比如换了个网络）加 --force-live。

import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"

const NODE = process.execPath
const here = import.meta.dirname
const ROOT = path.join(here, "..")

// 套件分组：核心（快，无网络）→ 回归 → 文字模式（较慢，需联网/启动 Edge）
//   live 字段 = 这个套件依赖哪个真实站点（跑之前会先探该站点的活口）
const SUITES = [
  { name: "test-imports", tag: "核心" },
  { name: "test-term", tag: "核心" },
  { name: "test-keys", tag: "核心" },
  { name: "test-cdp", tag: "核心" },
  { name: "test-cdp-methods", tag: "核心" },
  { name: "test-tabs", tag: "核心" },
  { name: "test-history", tag: "核心" },
  { name: "test-download", tag: "核心" },
  { name: "test-vp", tag: "核心" },
  { name: "test-input", tag: "核心", live: "example" },
  { name: "test-ansi-integrity", tag: "核心", live: "example" },
  { name: "test-loadhangs", tag: "核心" },
  { name: "test-noreload", tag: "核心" },
  { name: "test-searchguard", tag: "核心" },
  { name: "test-find", tag: "核心" },
  { name: "test-zhihu-fix", tag: "回归", live: "zhihu" },
  { name: "test-zhihu-flow", tag: "回归", live: "zhihu" },
  { name: "test-picker-logic", tag: "回归", live: "zhihu" },
  { name: "test-textmode-e2e", tag: "文字模式", live: "zhihu" },
  { name: "test-textmode-picker", tag: "文字模式", live: "zhihu" },
  { name: "test-textmode-scroll", tag: "文字模式" },
  { name: "test-overlay-align", tag: "文字模式", live: "zhihu" },
  { name: "test-fold", tag: "文字模式" },
  { name: "test-field", tag: "表单控件", live: "bing" },
  { name: "test-inputpath", tag: "表单控件", live: "bing" },
  { name: "test-mouse", tag: "鼠标交互" },
  { name: "test-qr-scan", tag: "二维码", live: "zhihu" },
]

// ── 活口探测 ──
// 判据要能区分「站点拦了」和「站点挂了」和「网线掉了」，所以三类都探：
//   · URL 被重定向到 /account/unhuman（知乎的验证页）、标题含「安全验证」
//   · 正文短到不正常（拦截页都只剩一句话）
//   · 关键元素不存在（知乎登录页的二维码 canvas / 必应的搜索框）
const CANARY = {
  zhihu: {
    url: "https://www.zhihu.com/signin",
    probe: `(() => {
      const txt = (document.body && document.body.innerText || '').trim()
      return {
        url: location.href, title: document.title, len: txt.length,
        canvas: document.querySelectorAll('canvas,img').length,
        hint: txt.slice(0, 80).replace(/\\s+/g, ' '),
      }
    })()`,
    verdict: (r) => {
      if (/unhuman|安全验证|验证码|captcha/i.test(r.url + " " + r.title)) return `被拦截：${r.title || r.url}`
      if (r.len < 120) return `页面内容异常少（${r.len} 字）：${r.hint}`
      if (r.canvas === 0) return "登录页没有二维码/图片元素，疑似降级页面"
      return null
    },
  },
  bing: {
    url: "https://cn.bing.com/",
    probe: `(() => {
      const txt = (document.body && document.body.innerText || '').trim()
      return {
        url: location.href, title: document.title, len: txt.length,
        hasBox: !!document.querySelector('#sb_form_q, input[type=search]'),
        hint: txt.slice(0, 80).replace(/\\s+/g, ' '),
      }
    })()`,
    verdict: (r) => {
      if (r.len < 40) return `页面内容异常少（${r.len} 字）：${r.hint}`
      if (!r.hasBox) return "找不到搜索框，疑似降级/拦截页面"
      return null
    },
  },
  example: {
    url: "https://example.com",
    probe: `(() => {
      const txt = (document.body && document.body.innerText || '').trim()
      return { url: location.href, title: document.title, len: txt.length, hint: txt.slice(0, 80).replace(/\\s+/g, ' ') }
    })()`,
    verdict: (r) => (/Example Domain/i.test(r.title + r.hint) ? null : `拿不到 example.com 内容（${r.len} 字）：${r.hint}`),
  },
}

/** 逐个探活。返回 { zhihu: { ok, reason }, ... } */
async function probeHosts(hosts) {
  const out = {}
  let edge = null
  try {
    // ⚠️ Windows 绝对路径（D:\…）不能直接 import() ——
    // 默认加载器只认 file:/data:/node: 这几种 scheme，会抛
    // 「Only URLs with a scheme in: file, data, and node are supported」。
    // 必须先过 pathToFileURL。
    const { launchEdge } = await import(pathToFileURL(path.join(ROOT, "src", "cdp.js")).href)
    edge = await launchEdge({ width: 1200, height: 800 })
    const tab = edge.tab
    await tab.setViewport(880, 520)
    for (const h of hosts) {
      const c = CANARY[h]
      if (!c) { out[h] = { ok: true, reason: "" }; continue }
      try {
        await tab.navigate(c.url)
        // 知乎的验证页是客户端跳转过来的，等久一点才看得到
        await new Promise((r) => setTimeout(r, h === "zhihu" ? 2600 : 1600))
        const info = await tab.evalJs(c.probe)
        const bad = c.verdict(info || {})
        out[h] = bad ? { ok: false, reason: bad } : { ok: true, reason: "" }
      } catch (e) {
        out[h] = { ok: false, reason: "探测失败：" + String(e?.message || e).slice(0, 80) }
      }
      process.stdout.write(`  ${out[h].ok ? "✓" : "⊘"} ${h.padEnd(9)} ${out[h].ok ? "可达" : out[h].reason}\n`)
    }
  } catch (e) {
    for (const h of hosts) out[h] = { ok: false, reason: "无法启动浏览器：" + String(e?.message || e).slice(0, 80) }
  } finally {
    try { edge?.quit() } catch {}
  }
  return out
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const forceLive = process.argv.includes("--force-live")
const noLive = process.argv.includes("--no-live")
let list = only.length ? SUITES.filter((s) => only.some((o) => s.name.includes(o))) : SUITES

const runOne = (s) => new Promise((resolve) => {
  const t0 = Date.now()
  const p = spawn(NODE, [path.join(here, s.name + ".mjs")], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    // detached: 让子进程自成进程组，父进程的信号不会误伤它
    detached: false,
  })
  let out = ""
  p.stdout.on("data", (d) => { out += d })
  p.stderr.on("data", (d) => { out += d })
  const killTimer = setTimeout(() => { try { p.kill("SIGKILL") } catch {} }, 180000)
  p.on("close", (code) => {
    clearTimeout(killTimer)
    const ms = Date.now() - t0
    // 提取套件自己的计数行（各套件格式不一，宽松匹配）
    const m = out.match(/(\d+)\s*通过\s*[/·]\s*(\d+)\s*失败/)
    resolve({
      name: s.name, tag: s.tag, code, ms, out,
      pass: m ? +m[1] : null, fail: m ? +m[2] : null,
    })
  })
})

console.log("\n═══ edge-tui 测试总览 ═══\n")

// ── 环境闸门 ──
const liveHosts = [...new Set(list.map((s) => s.live).filter(Boolean))]
const health = {}
const skipped = []
if (liveHosts.length && !forceLive) {
  if (noLive) {
    console.log("环境探测：--no-live，直接跳过所有依赖真实站点的套件\n")
    for (const h of liveHosts) health[h] = { ok: false, reason: "指定了 --no-live" }
  } else {
    console.log("环境探测（真实站点可达性）：")
    Object.assign(health, await probeHosts(liveHosts))
    console.log("")
  }
  if (liveHosts.length && !noLive) { /* 已探测 */ }
}

const results = []
for (const s of list) {
  const h = s.live ? health[s.live] : null
  if (h && !h.ok && !forceLive) {
    skipped.push({ ...s, reason: h.reason })
    console.log(`⊘ ${s.name.padEnd(26)} ${s.tag.padEnd(6)} 跳过（${s.live} ${h.reason}）`)
    continue
  }
  process.stdout.write(`· ${s.name.padEnd(26)} ${s.tag.padEnd(6)} `)
  const r = await runOne(s)
  results.push(r)
  const mark = r.code === 0 ? "✓" : "✗"
  const counts = r.pass !== null ? ` ${r.pass}/${r.pass + r.fail}` : ""
  console.log(`${mark}${counts}  ${(r.ms / 1000).toFixed(1)}s`)
  if (r.code !== 0) {
    const tail = r.out.trim().split("\n").slice(-6).map((l) => "    " + l).join("\n")
    console.log(tail)
  }
}

const failed = results.filter((r) => r.code !== 0)
const totalPass = results.reduce((a, r) => a + (r.pass || 0), 0)
const totalFail = results.reduce((a, r) => a + (r.fail || 0), 0)
console.log(`\n── ${results.length} 个套件 · ${results.length - failed.length} 通过 · ${failed.length} 失败` +
  (skipped.length ? ` · ${skipped.length} 跳过` : ""))
if (totalPass || totalFail) console.log(`── 断言 ${totalPass} 通过 / ${totalFail} 失败`)
if (failed.length) console.log(`── 失败套件: ${failed.map((f) => f.name).join(", ")}`)
if (skipped.length) {
  console.log(`── 跳过套件（环境受限，不是回归，别当红看）:`)
  for (const s of skipped) console.log(`     ${s.name}（${s.live} ${s.reason}）`)
  console.log(`   要强行跑：node tests/run-all.mjs --force-live ${skipped.map((s) => s.name).join(" ")}`)
}
console.log("")
process.exit(failed.length ? 1 : 0)
