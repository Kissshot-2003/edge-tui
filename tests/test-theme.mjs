// 从 codewhale TUI 截图提取精确配色
import fs from "node:fs"
import { PNG } from "pngjs"

const img = PNG.sync.read(fs.readFileSync("../_ref/codewhale-tui.png"))
const px = (x, y) => {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const hex = (p) => "#" + p.map((v) => v.toString(16).padStart(2, "0")).join("")

console.log("尺寸:", img.width, "x", img.height)
const probes = {
  "终端外框/最背景": [3, 3],
  "主背景": [500, 250],
  "背景偏上": [700, 60],
  "logo 点阵": [100, 100],
  "标题 codewhale 蓝": [285, 22],
  "版本号灰": [400, 22],
  "副标题灰": [290, 46],
  "New session 蓝": [280, 106],
  "提示文字灰": [280, 133],
  "输入框边框": [12, 344],
  "输入框内背景": [400, 352],
  "提示符 >": [22, 352],
  "placeholder 文字": [70, 352],
  "[↑] 青色": [1010, 352],
  "Full Access 红": [60, 411],
  "operate 紫": [255, 411],
  "scheduled 浅蓝": [450, 411],
  "MCP 绿": [820, 411],
  "connecting 绿": [950, 411],
  "GLM-5.3 蓝灰": [30, 438],
  "max 灰": [110, 438],
  "/help 灰": [1000, 438],
}
for (const [name, [x, y]] of Object.entries(probes)) {
  console.log(name.padEnd(24, " "), hex(px(x, y)), JSON.stringify(px(x, y)))
}
