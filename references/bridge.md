# 与 ego-browser 的边界

ego-browser 的指南由二进制打印（`ego-browser skill`，当前 v2.2.1），随 ego lite 版本变。
本文件只固定两者之间**不稳定、曾经打架**的部分：谁负责哪类动作、一轮怎么收尾、
哪些系统级操作必须交回 `page.*`。

## 一条总规则

- **人类车道**：站内用户级输入（点、打、滚、按、导航）。只经 `h.*`。
- **系统车道**：观察与浏览器自有操作（看、截图、弹窗、上传、下载、页签）。只经 `page.*` / `task.*`。
- 分界线是**动作类型**，不是 `page.` 这个前缀。旧版「业务脚本里不出现 `page.*`」已废止。

理由：`page.click` 会绕过配额、轨迹、哨兵与预警，等于以为在拟人、其实在跳变。
反过来，`page.snapshot` / `page.acceptDialog` / `page.setInputFiles` 是读操作或浏览器自有操作，
没有「人手」可以模拟，硬包一层只会制造假事件。

## 车道对照

| 动作 | 车道 | 用法 |
| --- | --- | --- |
| 点击、双击、悬停、拖拽 | 人类 | `h.click(target)`，需双击/拖拽的场景见下文「缺口」 |
| 输入文字、按键、清空 | 人类 | `h.type` / `h.press` / `h.clearField` |
| 滚动、阅读停顿 | 人类 | `h.read()` / `h.scroll()` |
| 站内导航 | 人类 | `h.goto(url)` |
| 页面观察 | 系统 | `page.snapshot()` / `page.info()` / `page.url()` / `h.inspect.*` |
| 等状态 | 系统 | `page.waitForSelector` / `waitForURL` / `waitForFunction`，或 `h.waitFor` |
| 截图 | 系统 | `h.inspect.screenshot()` 或 `page.screenshot()` |
| 原生对话框 | 系统 | `page.acceptDialog()` / `page.dismissDialog()` |
| 上传 | 系统 | `page.setInputFiles()` / `page.waitForFileChooser()` |
| 下载 | 系统 | `page.waitForEvent("download")` → `saveAs(绝对路径)` |
| 新标签页 | 系统 | 先 `page.waitForEvent("popup")` 再 `h.click`，然后 `task.adopt()` |
| 原生 select | 系统 | `page.selectOption()` |
| 页签、交权、收尾 | 系统 | `task.tabs()` / `task.adopt()` / `h.handOff()` / `h.finish()` |
| 剪贴板粘贴 | 系统 | `page.keyboard.paste()`（原生粘贴快捷键，属真实按键；其余 `page.keyboard.*` 仍禁用） |

## 禁止清单（只禁输入类，不禁读）

- `page.click` / `dblclick` / `hover` / `dragAndDrop` / `fill` / `press` / `focus`。
- `page.mouse.*`、`page.keyboard.type|insertText|press|down|up`。
- `page.goto` / `page.reload`：`create()` 之前那一次引导导航例外（库要靠它认站点）。
- `page.fetch`：不发新请求。要看页面自己发了什么用 `h.inspect.requests()`。
- `page.evaluate` 写状态；只读统计可以，并写 `// lint-allow`。
- `page.cdp`：仅诊断轮可用，写 `// lint-allow cdp`，该轮不计入 run 与门禁。
- DOM 侧：`dispatchEvent`、`form.submit`、`.value=`、`innerHTML/checked=`、`scrollIntoView`、改 storage。

跑前过一遍：`node tools/lint-script.mjs <脚本>`。

## 一轮的生命周期

1. 认领空间（指南「Starting and ending a reply」整段照抄）：`user → claimTaskSpace`，
   `agentDelegatedToUser → takeOverTaskSpace`，`agent → taskSpace(id)`。
2. `page.goto` 引导一次，`human.create(page, { space: task })`。
3. 干活。
4. 收尾，见下表。

| 情况 | 收尾动作 | 下一轮 |
| --- | --- | --- |
| 正常做完 | `await h.finish()`（先 flush 再 `task.finish({keep})`） | 新目标新空间 |
| 要留页面给用户看 | `await h.finish({ keep: ["p2"] })` | `claimTaskSpace` 后 `adopt` |
| 验证码 / 登录 / 人工步骤 | `await h.handOff({ reason })`（先 flush 再 `task.handOff()`） | `takeOverTaskSpace` |
| `session-long` / `daily-quota` / `budget` | `await h.finish()`，干净停，不交权 | 换 run 或等窗口 |
| 其他异常 | `await h.flush("blocked")`，不 `finish()` | 同空间继续 |

硬规矩：

- `flush()` 幂等，连调两次是安全的；但它只写本地库，不会关空间。**只 flush 不收尾会泄漏空间。**
- `handOff()` 之后**不要**再 `finish()`，空间已经归用户。
- 不许为了从卡住、超时、被拦的页面里脱身而新开 TaskSpace。
- 脚本抛错退出时 `flush()` 不会自动发生：`runs.ended_at` 会为空。用 `try/finally` 包住收尾。

## 观察的写法

- 节拍不替代等待：`h.read()` 是**加**在人看完之后的停顿，等结果仍然用 `waitFor*`。
  指南说「避免固定延迟」指的是别拿固定延迟当等待条件，与拟人停顿不冲突。
- snapshot 的 `@21` ref 只有 `page.*` 能用。要让 `h.click` 命中同一个元素，
  用 `loc=css:` / `loc=role:` / `loc=href:` 重新描述它，或把 `h.inspect.rect()` 的坐标传给 `h.click({x,y})`。
- 视口外的元素由 `h.*` 自己用滚轮逼近（最多 6 次），不用 `scrollIntoView`。
  指南里 `page.click` 的「自动滚轮入视口」只在系统车道成立，人类车道不借道。

## 系统级缺口怎么补

- **iframe**：同源 frame 会自动下钻（累计偏移后按顶层视口给坐标）。跨源 frame 读不到
  `contentDocument`，抛 `frame-cross-origin`。跨源登录框、支付框、验证码框都属于「交给人」。
- **canvas / 无 DOM 语义**：`const shot = await h.inspect.screenshot({ path: "C:/tmp/a.png" })`
  看图挑坐标，再 `h.click({ x, y })` / `h.move(x, y)` / `h.scroll()`。坐标是 CSS 像素。
  坐标点击会被打上 `direct` 标记，不参与落点断言（没有元素中心可比），
  门禁会报 `directClicks` 数量；一个全走坐标的 run 需要人工复核。
- **富文本 / 表格**：`h.type` 对中文按词组 `insertText`，对 contenteditable 有效。
  需要带 HTML 结构粘贴时用 `page.keyboard.paste({ text, html })`。
- **原生对话框**：`h.click` 触发的 `confirm` 不会自动处理。点击后立刻
  `await page.acceptDialog()` 或 `page.dismissDialog()`；拿不准就 `await page.info()` 看。
- **下载**：必须在同一脚本里 `saveAs` 到绝对路径。`h.flush()` 不会搬临时文件。
- **新标签页**：`h.click` 不返回 popup 句柄。要接管就在点击前
  `const popup = page.waitForEvent("popup")`，点击后 `await task.adopt(await popup)`。

## 旧说法修正

| 旧说法 | 现状 |
| --- | --- |
| 收尾只 `h.flush()` | 必须 `h.finish()`；flush 幂等但不关空间 |
| `ownership=user → takeOverTaskSpace` | 反了：`user → claimTaskSpace`，`agentDelegatedToUser → takeOverTaskSpace` |
| 「业务脚本里不出现 `page.*`」 | 改为按动作类型禁，见上表 |
| 「`mouse.move` 的 `steps` 在一次 CDP 内插值」 | ego-lite 的 `mouse.move` 没有 `steps` 参数，那是 Playwright 语义；本库逐点调用并真实等待 |
| 「`page.click` 等于跳变」 | 指南的 `page.click` 会自动滚轮入视口；本库仍不用它，理由是绕过闸门与配额 |
| `h.create(page, { profile })` 与指南的 `profileId` | 两件事：前者覆盖站点行为档案，后者是建空间时选的浏览器用户档案 |
| 中文只能整段合成 | 指南未载此限制；本库仍按词组 `insertText`，因为逐键 CJK 不存在可信事件 |

## 版本守卫

- 指南版本变了先读 `ego-browser skill` 输出，再跑 `node --test "tests/*.test.mjs"` 与 `tools/lint-script.mjs`。
- 入口壳 `skill/ego-browser/SKILL.md` 只做跳转，不含版本敏感内容；安装、清状态文档用
  `~/.local/share/ego/ego-skills/references/`（稳定链接，永远指向当前 active 版本）。
- 实测基线：ego lite 0.6.3.12 / 指南 v2.2.1 / 本库 0.8.0。
