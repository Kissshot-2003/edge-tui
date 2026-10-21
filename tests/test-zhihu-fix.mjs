// 验收：知乎登录页 —— 滚动容器感知 + 元素清单 + 真实鼠标点击
import { launchEdge } from "../src/cdp.js"

const W = 392, H = 224
const edge = await launchEdge({ width: W, height: H })
const { tab } = edge
let pass = 0, fail = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`)
  ok ? pass++ : fail++
}

try {
  await tab.navigate("https://www.zhihu.com/signin")
  await new Promise((r) => setTimeout(r, 2500))

  console.log("\n【1】滚动目标识别")
  const host = await tab.scrollTarget()
  check("识别出内层滚动容器", host === "el", `host=${host}`)
  const st0 = await tab.scrollState()
  check("读到容器高度", st0.sh > st0.ih, `sh=${st0.sh} ih=${st0.ih} cls=${st0.cls}`)

  console.log("\n【2】滚动容器感知滚动")
  await tab.scrollBy(200)
  const st1 = await tab.scrollState()
  check("scrollBy 生效", st1.y > 0, `scrollTop ${st0.y} → ${st1.y}`)
  await tab.scrollBy(-200)
  const st2 = await tab.scrollState()
  check("反向滚动生效", st2.y < st1.y, `scrollTop ${st1.y} → ${st2.y}`)

  console.log("\n【3】元素枚举")
  const els = await tab.enumerateInteractive(W, H)
  check("枚举到元素", els.length > 0, `${els.length} 项`)
  const inVp = els.filter((e) => e.inVp)
  check("视口内元素可识别", inVp.length > 0, `${inVp.length} 项在视口内`)
  const pwdTab = els.find((e) => e.text === "密码登录")
  check("找到「密码登录」（div 非原生控件）", !!pwdTab, pwdTab ? `tag=${pwdTab.tag} idx=${pwdTab.i}` : "未找到")

  console.log("\n【4】滚动定位到视口外元素（手机号输入框）")
  const phone = els.find((e) => e.type === "tel" && /手机号/.test(e.text))
  if (phone) {
    check("手机号输入框初始在视口外", !phone.inVp, `y=${phone.y}`)
    const box = await tab.scrollElIntoView(phone.i)
    check("滚入后获得坐标", !!box, box ? `y=${Math.round(box.y)}（布局坐标）` : "")
    // ⚠️ box.x/y 现在是**布局坐标**（抵消了所有滚动祖先），不能再拿它判「在视口内」。
    // 「在视口内」要看 visY/visH —— 那是元素矩形与视口的交集。
    check("滚入后落在视口内",
      box && box.visH > 0 && box.visY >= 0 && box.visY + box.visH <= H + 1,
      box ? `visY=${Math.round(box.visY)} visH=${Math.round(box.visH)} H=${H}` : "")
  } else {
    check("找到手机号输入框", false, "未找到")
  }

  console.log("\n【5】真实鼠标点击 div 标签页")
  const t = await tab.clickIndex(pwdTab.i)
  check("派发点击成功", !!t, t ? `(${Math.round(t.cx)},${Math.round(t.cy)})` : "")
  await new Promise((r) => setTimeout(r, 900))
  const after = await tab.evalJs(`(() => ({
    active: document.querySelector('.SignFlow-tab--active')?.innerText?.trim(),
    pwd: !!document.querySelector('input[type=password]')
  }))()`)
  check("页面状态真的切换了", after.active === "密码登录" && after.pwd, `tab=${after.active} 密码框=${after.pwd}`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
} finally {
  edge.quit()
}
