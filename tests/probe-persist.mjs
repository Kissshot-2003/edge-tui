// 持久 profile 探针：验证「登录态跨会话保留」——
// 同一个 profileDir 启动 → 写 Cookie → 退出 → 再启动 → Cookie 必须还在。
// 这是持久 profile 的决定性证据（目录存在不算数，数据能读回来才算）。
import { launchEdge } from "../src/cdp.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PROFILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "edge-tui", "profile-probe")
// 从干净状态开始
try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const URL = "https://example.com/"

// ── 第 1 个会话：写 Cookie + localStorage ──
let e1 = null
try {
  e1 = await launchEdge({ width: 880, height: 520, profileDir: PROFILE })
  await e1.tab.navigate(URL, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 600))
  await e1.tab.evalJs(`(() => {
    document.cookie = "etui_probe=persist_ok; max-age=86400; path=/";
    try { localStorage.setItem("etui_probe", "persist_ok") } catch {}
    return document.cookie
  })()`)
  ok("会话 1：Cookie 已写入", true)
} catch (e) {
  fail++; console.log(`  ✗ 会话 1 异常：${e?.stack || e}`)
} finally {
  try { e1?.quit() } catch {}
}

// 给 Edge 子进程完全退出留点时间（quit 已同步杀树，但保守一点）
await new Promise((r) => setTimeout(r, 800))

// ── 第 2 个会话：读回来 ──
let e2 = null
try {
  e2 = await launchEdge({ width: 880, height: 520, profileDir: PROFILE })
  await e2.tab.navigate(URL, { timeoutMs: 10000 })
  await new Promise((r) => setTimeout(r, 600))
  const got = await e2.tab.evalJs(`(() => ({
    cookie: (document.cookie.match(/etui_probe=([^;]+)/) || [])[1] || "",
    ls: (() => { try { return localStorage.getItem("etui_probe") || "" } catch { return "" } })(),
  }))()`)
  ok("★ 会话 2：Cookie 读回来了（登录态保留的核心证据）", got?.cookie === "persist_ok",
    `cookie=${JSON.stringify(got?.cookie)}`)
  ok("★ 会话 2：localStorage 也读回来了", got?.ls === "persist_ok",
    `ls=${JSON.stringify(got?.ls)}`)
} catch (e) {
  fail++; console.log(`  ✗ 会话 2 异常：${e?.stack || e}`)
} finally {
  try { e2?.quit() } catch {}
}

// ── 退出后 profile 目录必须还在（持久模式下绝不删）──
await new Promise((r) => setTimeout(r, 600))
ok("退出后 profile 目录仍在（没有被 cleanup 删掉）", fs.existsSync(PROFILE))
// 一次性临时 profile 的对照：退出后目录应当被删
let tmpGone = false
try {
  const tmp = os.tmpdir()
  tmpGone = !fs.readdirSync(tmp).some((d) => d.startsWith("edge-tui-") &&
    (() => { try { return Date.now() - fs.statSync(path.join(tmp, d)).mtimeMs < 60000 } catch { return false } })())
} catch {}
ok("对照：临时 profile 退出后已被清理（原行为不变）", tmpGone)

// 清理探针自己的 profile
try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
