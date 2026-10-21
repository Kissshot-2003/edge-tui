// 「直达搜索地址」兜底的判别守卫（looksLikeSearch）—— 离线纯函数断言。
//
// 背景（2026-09 真实投诉，见 tests/probe-sms.mjs）：登录页输完手机号按回车，
// AJAX 站点不跳转是正确行为；旧代码却把地址不变当提交失败，再把输入内容
// **当搜索词直接跳 Bing** —— 用户看到「获取验证码把整个页面刷新了」。
// 修复后兜底必须先过 looksLikeSearch：只有像搜索框的控件才允许跳。
// 这个测试把「手机号/验证码框不许命中」钉死 —— 命中就是回归。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.EDGE_TUI_NO_MAIN = "1"
process.env.EDGE_TUI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tui-test-data-"))
const { __test } = await import("../run.mjs")

let pass = 0, fail = 0
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

const L = __test.looksLikeSearch

// ── 不许命中：登录/表单控件（误伤 = 手机号被当搜索词跳走）──
ok("手机号框（placeholder 请输入手机号）不命中", L({ type: "text", ph: "请输入手机号", label: "" }) === false)
ok("验证码框不命中", L({ type: "text", ph: "请输入验证码", label: "短信验证码" }) === false)
ok("手机号登录按钮文案不命中", L({ type: "text", ph: "", label: "手机号快捷登录" }) === false)
ok("普通文本框不命中", L({ type: "text", ph: "请输入用户名", label: "" }) === false)
ok("密码框不命中", L({ type: "password", ph: "密码", label: "" }) === false)
ok("空字段不命中", L(null) === false)
ok("空对象不命中", L({}) === false)

// ── 必须命中：搜索场景（否则搜索框回车没反应时失去兜底）──
ok("type=search 命中", L({ type: "search", ph: "", label: "" }) === true)
ok("placeholder 含「搜索」命中", L({ type: "text", ph: "搜索", label: "" }) === true)
ok("placeholder 含「关键词」命中", L({ type: "text", ph: "请输入关键词", label: "" }) === true)
ok("aria-label「Search GitHub」命中", L({ type: "text", ph: "", label: "Search GitHub" }) === true)
ok("文案「百度一下」命中", L({ type: "text", ph: "百度一下", label: "" }) === true)
ok("文案「搜一下」命中", L({ type: "text", ph: "", label: "搜一下" }) === true)

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══`)
process.exit(fail ? 1 : 0)
