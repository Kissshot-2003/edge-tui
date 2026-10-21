import { createTerm, C } from "../src/term.js"

const term = createTerm()
term.render([
  [
    { t: " ◆ ", fg: C.accent, bg: C.chrome, w: 3 },
    { t: "edge-tui ", fg: C.fg, bg: C.chrome, w: 9 },
    { t: "搜索 - Microsoft 必应", fg: C.accent, bg: C.chrome },
    { t: " 浏览 ", fg: C.dim, bg: C.chrome, w: 4 },
  ],
  [{ t: "+" + "-".repeat(70) + "+", fg: C.border, bg: C.bg }],
  [
    { t: "|", fg: C.border, bg: C.bg, w: 1 },
    { t: "##@@@@%%::..", fg: [120, 200, 180], bg: C.bg },
    { t: "|", fg: C.border, bg: C.bg, w: 1 },
  ],
  [{ t: " > ", fg: C.accent, bg: C.chrome, w: 3 }, { t: "https://www.bing.com", fg: C.fg, bg: C.chrome }],
])
term.destroy()