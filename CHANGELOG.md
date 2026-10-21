# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-10-21

### Added

- **多标签页**：顶部横向标签栏（`[编号] 标题`，当前标签高亮）。
  - 每个标签页是**一个真实的 Chromium 页面**（`Target.createTarget` + 独立 CDP 连接），
    各自保留 URL、标题、滚动位置、折叠展开状态、页内查找高亮、渲染模式。
  - 切换标签是**纯内存**操作（状态快照 / 恢复），不重新抓页。
  - 按键沿用 **OpenCode V2 TUI** 的模型：`Ctrl+Tab` / `Ctrl+Shift+Tab` 轮换、
    `Ctrl+1`–`Ctrl+9` / `Ctrl+0` 直跳、`Ctrl+W` 关闭、`Ctrl+Shift+T` 重开、`Ctrl+T` 新建。
  - 终端不报修饰键时（传统 conhost）提供**单键退路**：
    `t` 新建、`T` 重开、`w` 关闭、`[` / `]` 轮换、`1`–`0` 直跳。
  - 上限 12 个标签页。
- `--user-agent=UA`：伪装 UA，绕开 headless 下部分站点的降级（必应返回精简版首页）。
- `LICENSE`（MIT 正文，之前 README 声明了 MIT 但仓库里没有许可证文件）。
- `tests/test-tabs.mjs`：多标签页回归（CDP 开/关页面 · 修饰键解码 · 各页状态隔离 ·
  按键→切页整条链路），40 条断言，已并入 `tests/run-all.mjs`。

### Changed

- **按键解码层支持修饰键**：
  - 新增 **CSI-u**（kitty 键盘协议 `ESC [ <code> ; <mods> u`）——
    这是唯一能区分 `Ctrl+Tab` / `Ctrl+数字` 与普通 `Tab` / 数字的编码。
  - **win32 输入模式**（`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`）现在会读出
    `Cs` 控制键状态，产出 `ctrl` / `alt` / `shift` 标志。
  - 原始 `0x01`–`0x1a` 现在解析成 `Ctrl+字母` 事件（之前被静默吞掉），
    连带修好了输入模式里的 `Ctrl+A` / `Ctrl+Z`（此前判断条件写错了字段，永远不触发）。
- 标签栏占用 1 行终端高度（`CHROME_ROWS` 3 → 4）。
- `启动.bat` 不再写死 node 路径：优先用 `PATH` 上的 `node`，找不到才回退到内置副本。

### Fixed

- **后退 / 前进从来没生效过**。CDP 协议里**没有** `Page.goBack` / `Page.goForward`
  这两个方法（历史上就是这么写的），于是每次调用都报
  `'Page.goBack' wasn't found`，错误又被 `.catch()` 吞进状态栏 ——
  用户只看到「按了没反应」，**加载失败之后更是完全无路可退**。
  现在改用 `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`，
  并在退到头 / 进到头时给出人话提示（「没有更早的页面了」）。
- **加载失败时不再显示 Chrome 的错误页内容**（抓回来只有「无法访问此网站」几个字），
  改为自绘一页：写明原因、失败地址，以及**「按 b / Backspace 返回」**
  —— 人在这一刻最想做的就是回去。
- 后退 / 前进之后，状态栏会报出退到了哪一页（`← 已返回 · <url>`），
  不再只是笼统的「就绪」。
- 输入模式里的 `Ctrl+A`（全选）/ `Ctrl+Z`（撤销）此前因判断了 `key.name`
  （实际是 `"char"`，值在 `key.sequence`）而**永远不生效**；
  `pressCombo` 也传错了参数（要字母本身，不是 `"char"`）。
- 解码层开始产出带修饰键的 char 事件后，**带 Ctrl/Alt 的字符不再被当成文字**
  （`isPlainChar`）：否则 `Ctrl+A` 会在输入框里打出一个字面量 "a"。
- `tests/test-noreload.mjs` 不再把 chrome 行数抄一遍（页面区高度一变就错位，
  失败原因还跟被测行为无关），改为使用导出的 `PAGE_ROWS()` / `CHROME_ROWS` / `FOOT_ROWS`。

### Removed

- 清理调试产物：`crash.log`、`demo-snapshot.txt`、`_s.bin`、`_s.err`
  （并加入 `.gitignore`）。
- **纳入版本控制**：此前这个项目有 3600+ 行代码却**零版本控制**。
  现在已 `git init` 并提交首个版本。

## [1.3.0] - 2026-09-28

- 文字模式全量渲染：滚动不再触发整页重抓（行窗口纯内存移动）。
- 加载等待策略：改成"新文档就位 + 内容连续两拍不变"，每一步都有硬上限；
  超时返回降级画面而不是冻死。
- 页内查找、书签/历史、持久 profile（登录态跨会话保留）、二维码无损直读。
- 环境闸门：测试套件区分"被站点拦截"与"真回归"。

## [1.0.0] - 2026-09-14

- 首个可用版本：Edge 内核驱动、文字模式、元素清单、表单输入、鼠标命中。
