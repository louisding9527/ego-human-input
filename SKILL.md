---
name: ego-human-input
description: 需要用浏览器（ego-browser / ego-lite）操作真实站点时读本技能：打开页面、点击、填表、登录、翻页、抓取数据、做 web app 测试与 QA。它是 ego-browser 的唯一入口，包含 ego-browser 的调用契约与一层拟人输入（点击轨迹、输入节奏、滚动停顿、配额、停手与交权）。先读这里，再按本文要求跑 `ego-browser skill` 取版本匹配的指南。
metadata:
  version: "0.8.0"
  date: "2026-11-13"
---

# ego-human-input

ego-browser 给 agent 一双眼睛：真实 Chromium、真实登录态、页面可读可看。
这一层给一双手：点击、输入、滚动落在人类行为的分布里，而不是靠限速器祈祷。

## 何时加载

用 ego-browser 操作真实站点时都用它。以下情况是硬需求：

- 连续点击、翻页、批量打开详情，需要控制节奏。
- 需要在表单或搜索框里输入文字，包括中文。
- 需要「像人一样看一眼再操作」，即停顿加滚轮。
- 站点有风控，不想让行为显得规律。
- 需要在一轮结束时正确关空间、或把控制权交还给用户。

纯读一个本地页面、单次截图、不落任何输入的场景可以不用。不用库就没有配额、
没有停手通知，也没有收尾语义。

## 入口契约（先读这段）

1. **指南不在本文里。** 先跑 `ego-browser skill`，按它打印的指南走；那份指南随
   ego lite 版本变。输出里如果缺少 `[ego-browser:skill] end of guide` 这一行，
   说明被截断了：重定向到文件再分段读。
2. **版本敏感的东西一律不复制。** 安装与升级、清 cookie/缓存、平台差异，看
   `~/.local/share/ego/ego-skills/references/`（稳定链接，永远指向当前 active 版本）。
3. **冲突的裁决在 [references/bridge.md](references/bridge.md)。** 它规定谁负责哪类动作、
   一轮怎么收尾、哪些系统操作必须交回 `page.*`。本文与指南对不上时以它为准。
4. **本库是库，不是程序。** 一组 ESM 模块，跑在 `ego-browser nodejs` 的同一个进程里，
   不启动独立浏览器。

```js
const { human } = await import("file:///C:/Users/<用户名>/.agents/skills/ego-human-input/lib/human.mjs");
```

安装位置决定 import 路径，Windows 默认就是上面那条。`lib/` 与 `profiles/` 必须保持
仓库相对布局，搬走会静默降级成空档案。

## 最小用法

```js
const task = await taskSpace("liepin 候选人筛选");
const page = task.page("p1");
await page.goto("https://www.liepin.com/");        // create() 之前的引导导航

const h = await human.create(page, { space: task }); // 识别站点、体检、装哨兵、dwell 后返回
console.log(h.site());                              // { host, siteKey, profile }
console.log(h.health.warnings);                     // 体检告警，空数组为正常

await h.click("loc=role:button[name='登录']");       // 有坐标走轨迹
await h.type("周杰伦");
await h.read();                                     // 5~8s 停顿 + 1~2 次滚轮
console.log(await h.finish());                      // 先落盘，再关空间
```

`{ space: task }` 不是必须的，但注入后 `h.finish()` / `h.handOff()` 才能替你收尾。
不注入就得自己在脚本里调 `task.finish()` / `task.handOff()`。

## API

| 方法 | 说明 |
| --- | --- |
| `create(page, { profile?, dbPath?, store?, notify?, onBlock?, space? })` | 识别站点、体检、装哨兵、起 run；先 dwell 再返回。`space` 传 TaskSpace 句柄 |
| `h.session()` | 本次会话形状：dwell、时长、读写数、自动补读次数、休息次数 |
| `h.site()` / `h.params()` / `h.health` | 站点档案 / 生效参数 / 环境体检 |
| `h.goto(url)` | 导航入口，先判 URL 与 API 端点 |
| `h.click(target, {as})` | 指针轨迹点击；`target` 是 locator 或 `{x,y}` |
| `h.focus(locator)` | 点一下并确认焦点，失败再点一次 |
| `h.type(text, {as})` | 分拉丁/中文，含误输入与退格 |
| `h.press(key)` | 单次按键，`ControlOrMeta+A` 这类同 Playwright |
| `h.clearField()` | 全选 + 退格，清空当前输入框 |
| `h.waitFor(locator, {state,timeout})` | 等元素出现，超时返回 `{ok:false}` 不抛 |
| `h.read(seconds?)` / `h.scroll()` | 停顿加滚轮 / 单独滚一次 |
| `h.note({area,text,selector})` / `h.notes(area?)` | 记录、读取当前站点的交互经验 |
| `h.inspect.*` | 只读：`rect / text / pageState / sentinel / requests / screenshot / query` |
| `h.state()` / `h.alerts()` / `h.decide()` | 预警状态 / 待裁决 / 写回裁决 |
| `h.flush(outcome?)` | 落 sqlite、时间线、结束 run。幂等，不关空间 |
| `h.finish({keep?})` | 收尾：先 flush，再 `task.finish({keep})`。幂等 |
| `h.handOff({reason?})` | 停手交权：先 flush，再 `task.handOff()`。幂等 |

**原子操作原则**：库不提供 `search()` 这类业务组合。搜索、投递、收藏都由你按站点实际
情况用上面这些原子动作拼出来。拼接经验写进 `h.note()`，下次同站点直接读。

## 车道：什么该用 `h.*`，什么该用 `page.*`

- 站内用户级输入（点、打、滚、按、导航）：只经 `h.*`。
- 观察与浏览器自有操作（snapshot、截图、弹窗、上传、下载、页签、原生 select）：只经 `page.*` / `task.*`。

旧版「业务脚本里不出现 `page.*`」已废止：那条规则和指南强制的 `page.acceptDialog`、
`page.setInputFiles` 直接对撞。现在是按动作类型禁，完整清单见
[references/bridge.md](references/bridge.md)。

## 配方：一次意图，一次往返

原子直调的问题是每步一次模型往返。7 步的流程，光是「想下一步」就要 2–3 分钟。
所以把**走通的序列**存成配方，之后只发意图。

```js
const recipe = h.recipes();                    // 该域名已有的意图
await h.run("search", { kw: "供应链总监" });    // 一次调用，内部逐步执行
```

走通后存下来，参数用 `{{kw}}` 占位：

```js
await h.saveRecipe("search", [
  { op: "click", target: "role:link[name='找人']", as: "nav" },
  { op: "focus", target: "css=#rc_select_1" },
  { op: "clearField" },
  { op: "type", text: "{{kw}}", as: "nav" },
  { op: "press", key: "Enter" },
  { op: "click", target: "role:button[name='搜 索']", as: "search" },
  { op: "read", seconds: 6 },
]);
```

可用 `op`：`click` / `focus` / `clearField` / `type` / `press` / `waitFor` / `read` /
`expectText` / `expectUrl`。配方只覆盖人类车道；弹窗、上传、下载、页签不进配方。

失败时抛 `HumanWarn{trigger:"recipe-failed", step, op, cause}`，带当前 URL。
这时回到原子动作手工走一遍，走通再 `saveRecipe` 覆盖（版本号 +1，`fail_count` 累加）。

```bash
node tools/recipe.mjs list --host h.liepin.com
node tools/recipe.mjs show --host h.liepin.com --intent search
```

## 会话节奏由库管，不用你算

一个 run 就是「坐下来干一次活」，库自己维持下面这些形状（数值在 `profiles/base.json` 的 `session` 段）：

| 行为 | 触发 | 越界时 |
| --- | --- | --- |
| 落地先看 | `create()` 返回前 | 固定 dwell 0.8–2.5s |
| 休息 | 每 60 个动作 | 停 20–45s |
| 读写配比 | 写动作前发现读太少 | 自动补一次 1 秒短阅读，记 `autoReads` |
| 单次时长 | 超过 90 分钟 | 抛 `session-long`，换一次 run 重来 |
| 日总量 | 当日超过 400 个动作 | 抛 `daily-quota`，当天停手 |
| 工作时段 | 8 点前 / 23 点后 | 间隔乘 1.8 |
| 只搜不开 | 连续 3 次搜索仍没开详情 | 抛 `search-no-detail` |

**慢是设计，不是故障**。看到脚本「卡」两秒，那是 dwell 或自动补读，不是 BUG；
`h.session()` 能看到补了几次。`session-long` / `daily-quota` 是干净停：`h.finish()`
收尾，不要交权；也不要为了继续而新开 TaskSpace。

## 必须知道的五个事实

1. **不要用 `mouse.move` 的 `steps` 做拟人。** ego-lite 的 `mouse.move` 没有 `steps` 参数
   （那是 Playwright 语义）。本库逐点调用并真实等待。
2. **中文没有逐键事件。** `keyboard.type` 对中文只能整段合成。本库按词组 `insertText`，
   组间 300~1200ms，模拟输入法上屏。
3. **坐标可能拿不到。** `snapshot` 有 `loc=` 但没有坐标。本库尝试解析 `css:` / `href:` /
   `role:`，解析不到就抛 `s1-missing`。同源 iframe 会自动下钻；跨源 iframe 抛
   `frame-cross-origin`。两种都不降级成 `page.click`。
4. **挑战页要交给人。** 检测到验证码或 Cloudflare 挑战时抛 `HumanBlocked`。
   不要重试、不要换 profile、不要绕；用 `h.handOff()` 把控制权交出去。
5. **节拍不替代等待。** `h.read()` 是加在人看完之后的停顿；等结果仍然用 `h.waitFor()`
   或 `page.waitForSelector()`。指南说「避免固定延迟」指的是别拿固定延迟当等待条件。

配方还有一个硬规矩：`{{kw}}` 这类占位符缺参数时直接抛 `missing-param`，
**不会把空串打进输入框**。

## 禁止事项

**只禁非人写的输入，不禁读。** 完整清单在 [references/bridge.md](references/bridge.md)。

- 不用 DOM `click()`、`dispatchEvent`、`form.submit()`，不直接写 `value`/`innerHTML`/`checked`。
- 不用 `page.click/fill/hover/press/focus`、`page.mouse.*`、`page.keyboard.type|insertText|press`。
- 不发新请求（`page.fetch`）。`page.goto` / `page.reload` 只在 `create()` 之前那一次引导导航里用。
- 不 `scrollIntoView` 瞬移，不操作非前台页（需要新页签时先 `waitForEvent("popup")` 再 `adopt`）。
- 不调用 `page.cdp("egoAutomated.disable")`，诊断轮除外（写 `// lint-allow cdp`，该轮不计入门禁）。
- 不 import Playwright / Puppeteer，不为躲检测切 profile 或换号，不自动解验证码。

跑前过一遍 `node tools/lint-script.mjs <脚本>`。lint 按上面两条车道判定，不按 `page.` 前缀一刀切。

## 一轮怎么收尾

| 情况 | 收尾 |
| --- | --- |
| 正常做完 | `await h.finish()`；要留页面给用户看就 `h.finish({ keep: ["p2"] })` |
| 验证码 / 登录 / 人工步骤 | `await h.handOff({ reason: "challenge" })`，下一轮 `takeOverTaskSpace(id)` |
| `session-long` / `daily-quota` / `budget` | `await h.finish()`，干净停，不交权 |
| 其他异常 | `await h.flush("blocked")`，**不** `finish()`，同空间继续 |

三条硬规矩：只 flush 不收尾会泄漏空间；`handOff()` 之后不要再 `finish()`；
脚本抛错直接退出时 `flush()` 不会自动发生，收尾要放在 `try/finally` 里。

## 停手会通知你

停手不等于交出去了。库会在冻结的那一刻发一条**浏览器通知**，说清三件事：在哪个站点、
为什么停、你该做什么（登录 / 完成人机验证 / 等配额恢复）。一份代码同时覆盖 Windows 与 macOS。

授权每个站点做一次：

```bash
node tools/notify-setup.mjs h.liepin.com            # 弹出 Chrome 授权气泡
# 到 ego-lite 窗口点「允许」
node tools/notify-setup.mjs --check h.liepin.com    # 验证并试发一条
```

为什么是两步：Chrome 要求 `requestPermission()` 由真实点击触发，而 ego-lite 一旦检测到
权限气泡，就会停下脚本、把空间交给用户（`A browser permission prompt ... has appeared`）。
所以引导做完第一步必然退出——**这是设计，不是失败**。下一轮必须
`takeOverTaskSpace(spaceId)` 才能继续。权限按 origin 存在浏览器 profile 里，
换站点、换 profile、清了站点数据都要重新授权。

```js
console.log(await h.notifyPermission());   // granted / default / denied / unsupported
```

没有授权不会报错，只会降级：时间线记一条 `notify {ok:false}`，门禁不受影响。
**别把「没收到通知」当成「没停手」。**

真正的交权由 `h.handOff()` 完成（它先落盘再 `task.handOff()`）：

```js
const h = await human.create(page, {
  space: task,
  onBlock: async () => { await h.handOff({ reason: "challenge" }); },
});
```

`space.ownership` 变成 `user`；下一轮先 `claimTaskSpace(spaceId)`（用户点过之后）或
`takeOverTaskSpace(spaceId)`（空间停在 `agentDelegatedToUser`）再继续。
映射反了就会调错 API：`user → claimTaskSpace`，`agentDelegatedToUser → takeOverTaskSpace`。

## 预警

动作链路一出现异常（跳走、挑战页、点击无响应、只搜不开、结果不换），库会停手并写一条告警：

```bash
node tools/alert.mjs list
node tools/alert.mjs show --id 12
node tools/alert.mjs decide --id 12 --decision backoff --reason "..."
```

冻结期间只读可用。规则细节见 [references/guard.md](references/guard.md)。

## 跑完要过门禁

```bash
node tools/verify-human.mjs                     # 最近一次 run
node tools/verify-human.mjs --run <id>          # 指定 run
node tools/verify-human.mjs --baseline <id>     # 与基线对照，任一分项退化 >5% 判失败
```

十一条断言：非信任输入为 0、无降级、落点不扎堆中心、落点中位偏移、移动采样点下限、
步长间隔 CV、按键间隔 CV、读写比下限、首动作前停留、会话时长上限、当日动作总量。
失败退出码为 1。阈值冻结在 `profiles/thresholds.json`，**agent 不许改**。

改动参数或配方后要记账：

```bash
node tools/iterate.mjs record --site liepin.com --intent search --kind param \
  --before '{"gap":[45000,120000]}' --after '{"gap":[60000,150000]}' \
  --rationale "..." --trigger budget
node tools/iterate.mjs list --site liepin.com
node tools/iterate.mjs decide --id 1 --outcome kept --reason "门禁 6/6"
```

同一 (站点, 意图) 连续 3 代没有改善就停手，升级为告警等人工裁决。

## 站点交互经验

经验按三个维度归档，不写进代码：

| 维度 | 取值 | 说明 |
| --- | --- | --- |
| `platform` | 站点 key，如 `liepin.com` | 用注册域名，子域共享一份 |
| `intent` | `search` / `favorite` / `apply` …，`*` 表示通用 | 一条经验归属某个动作意图 |
| `kind` | `hint` / `pitfall` / `selector` / `timing` | 是什么类型的经验 |
| `scope` | `site` / `global` | 只对本站点有效，还是跨站点通用 |

```js
const general = h.notes();          // 该平台全部
const forSearch = h.notes("search"); // 只带 search 与通用（*）
await h.note({ intent: "search", kind: "pitfall", text: "...", selector: "css=#rc_select_1" });
```

```bash
node tools/site.mjs list --platform liepin.com --intent search
node tools/site.mjs add --platform liepin.com --intent search --kind pitfall --text "..."
node tools/site.mjs promote            # 按机械规则把可通用经验晋升为 global
```

同平台 + 同意图 + 同类型 + 同文本只累加 `hits`。跨站晋升是机械判定：kind 属于
`hint` / `timing`、没有 selector、在 ≥2 个平台各命中 ≥2 次。selector 与 pitfall 永不通用。

## 导出数据

`~/.ego-human-input/human.db` 是标准 SQLite 单文件。

```bash
node tools/export.mjs --out ./out        # 每张表导成 jsonl + csv，附 summary.json
```

表：`runs`、`events`、`iterations`、`budget_use`、`alerts`、`host_state`、`site_notes`、`recipes`。
导出的是行为与经验，不含姓名、简历 ID、输入文本。

## 调参

档案在 `profiles/` 下。站点匹配、三层覆盖、配额与字段含义见 [references/profiles.md](references/profiles.md)。

## 示例

`examples/timeline.mjs` 是可跑通的最小闭环，会打印事件统计，用来验证拟人是否真的生效。
`examples/liepin-search.mjs` 演示原子动作拼接、经验回写与 `h.finish()` 收尾。
