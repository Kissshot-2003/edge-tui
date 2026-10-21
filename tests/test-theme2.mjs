// 精确提取：对每个目标区域做"最亮/最饱和像素"采样（文字抗锯齿后取核心色）
import fs from "node:fs"
import { PNG } from "pngjs"

const img = PNG.sync.read(fs.readFileSync("../_ref/codewhale-tui.png"))
const W = img.width
const at = (x, y) => {
  const i = (y * W + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const hex = (p) => "#" + p.map((v) => v.toString(16).padStart(2, "0")).join("")
const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]

// 区域内取亮度最高的像素（文字核心色）+ 出现频率最高的像素（背景色）
function sample(name, x0, y0, x1, y1) {
  const hist = new Map()
  let brightest = [0, 0, 0], bl = -1
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = at(x, y)
      const l = luma(p)
      if (l > bl) { bl = l; brightest = p }
      const k = p.join(",")
      hist.set(k, (hist.get(k) || 0) + 1)
    }
  }
  const bg = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]
  const bgp = bg[0].split(",").map(Number)
  console.log(name.padEnd(22, " "), "亮=" + hex(brightest), " 底=" + hex(bgp), " [" + bg[1] + "px]")
  return { brightest, bg: bgp }
}

console.log("=== 区域采样 ===")
sample("标题区(codewhale)", 270, 15, 440, 32)
sample("版本号区", 440, 15, 600, 32)
sample("副标题斜杠提示", 270, 40, 620, 56)
sample("New session", 270, 96, 435, 118)
sample("提示文字", 270, 124, 950, 142)
sample("输入框边框(上)", 10, 340, 1068, 348)
sample("输入框内", 30, 348, 950, 382)
sample("提示符>", 18, 348, 34, 378)
sample("placeholder", 48, 348, 265, 378)
sample("[↑]", 985, 348, 1040, 378)
sample("Full Access", 20, 402, 200, 424)
sample("operate", 240, 402, 330, 424)
sample("scheduled", 395, 402, 535, 424)
sample("MCP", 800, 402, 848, 424)
sample("connecting", 910, 402, 1050, 424)
sample("GLM-5.3", 14, 428, 106, 452)
sample("max", 106, 428, 160, 452)
sample("/help", 968, 428, 1050, 452)
sample("logo 点阵", 60, 40, 230, 190)
