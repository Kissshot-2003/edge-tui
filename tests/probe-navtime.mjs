// 计时探针：导航到底花了多久？哪一段慢？
import { launchEdge } from "../src/cdp.js"
import { pathToFileURL } from "node:url"
import path from "node:path"

const fixture = pathToFileURL(path.join(import.meta.dirname, "fixtures", "fold-page.html")).href
const t = () => Date.now()

let t0 = t()
const edge = await launchEdge({ width: 1200, height: 800 })
console.log(`launchEdge            ${t() - t0}ms`)
const tab = edge.tab

t0 = t()
await tab.setViewport(880, 520)
console.log(`setViewport           ${t() - t0}ms`)

for (let i = 1; i <= 3; i++) {
  t0 = t()
  const r = await tab.navigate(fixture)
  console.log(`navigate(fixture) #${i}   ${t() - t0}ms  state=${r.state} ms=${r.ms} textLen=${r.textLen}`)
}

const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent("<h1>数据页</h1><p>" + "字".repeat(200) + "</p>")
for (let i = 1; i <= 2; i++) {
  t0 = t()
  const r = await tab.navigate(dataUrl)
  console.log(`navigate(data:) #${i}     ${t() - t0}ms  state=${r.state} ms=${r.ms} textLen=${r.textLen}`)
}

// 同文档跳转（hash）—— 标记不会消失，看会不会白等满超时
t0 = t()
const r = await tab.navigate(fixture + "#x", { timeoutMs: 12000 })
console.log(`navigate(same-doc)    ${t() - t0}ms  state=${r.state} ms=${r.ms}`)

t0 = t()
await tab.navigate("about:blank", { timeoutMs: 8000 })
console.log(`navigate(about:blank) ${t() - t0}ms`)

t0 = t()
await edge.quit()
console.log(`edge.quit             ${t() - t0}ms`)
