---
name: ego-human-input
description: 让 ego-browser（ego-lite）的鼠标键盘行为接近真人，并按站点控制操作频率。当任务涉及浏览器自动化、拟人输入、防反爬、控制点击与输入节奏、页面浏览停顿、滚轮滚动时使用。不用于指纹伪造、验证码绕过或多账号轮换。
metadata:
  version: "0.6.0"
  date: "2026-11-13"
---

# ego-human-input

## 何时加载

用 ego-browser 操作真实站点，且任务会出现以下任一情况时：

- 连续点击、翻页、批量打开详情，需要控制节奏。
- 需要在表单里输入文字，包括中文。
- 需要"像人一样看一眼再操作"，即停顿加滚轮。
- 站点有风控，不想让行为显得规律。

不需要时（单次截图、读一个页面、纯本地页面）不要加载，它只会让脚本变慢。

## 先决条件

1. 已装 ego-browser，先跑 `ego-browser skill` 读它的使用指南。
2. 业务脚本由 `ego-browser nodejs` 运行。本 skill 是库，不是独立程序。
3. 安装位置决定 import 路径。装上后把下面的 `<SKILL_DIR>` 换成本机实际目录：

```js
const { human } = await import("file:///<SKILL_DIR>/lib/human.mjs");
```

本机默认装法（Windows）：`<SKILL_DIR>` 为 `C:/Users/<用户名>/.agents/skills/ego-human-input`。
示例脚本自己用 `import.meta.url` 定位，`examples/` 与 `tests/` 里的文件复制到别处也能跑。

## 最小用法

```js
const task = await taskSpace("liepin 候选人筛选");
const page = task.page("p1");
await page.goto("https://www.liepin.com/");

const h = await human.create(page);   // 识别站点，加载档案
console.log(h.site());                          // { host, siteKey, profile }
console.log(h.health.warnings);                 // 体检告警，空数组为正常

await h.click("loc=role:button[name='登录']");   // 有坐标走轨迹，没有降级
await h.type("周杰伦");
await h.read();                                 // 5~8s 停顿 + 1~2 次滚轮
await h.scroll();                               // 单独滚一次
console.log(await h.flush());                   // 落盘时间线与限速状态
```

## API

| 方法 | 说明 |
| --- | --- |
| `create(page, { profile?, dbPath?, store? })` | 识别站点、体检、装哨兵、起 run、接管冷却；返回句柄 |
| `h.site()` / `h.params()` / `h.health` | 站点档案 / 生效参数 / 环境体检 |
| `h.goto(url)` | 导航入口，先判 URL 与 API 端点 |
| `h.click(target, {as})` | 指针轨迹点击；`as` 决定配额类型 |
| `h.focus(locator)` | 点一下并确认焦点，失败再点一次 |
| `h.type(text, {as})` | 分拉丁/中文，含误输入与退格 |
| `h.press(key)` | 单次按键，`ControlOrMeta+A` 这类同 Playwright |
| `h.clearField()` | 全选 + 退格，清空当前输入框 |
| `h.waitFor(locator, {state,timeout})` | 等元素出现，超时返回 `{ok:false}` 不抛 |
| `h.read(seconds?)` / `h.scroll()` | 停顿加滚轮 / 单独滚一次 |
| `h.note({area,text,selector})` / `h.notes(area?)` | 记录、读取当前站点的交互经验 |
| `h.inspect.*` | 只读：`rect / text / pageState / sentinel / requests / query` |
| `h.state()` / `h.alerts()` / `h.decide()` | 预警状态 / 待裁决 / 写回裁决 |
| `h.flush()` | 落 sqlite、时间线、结束 run |

**原子操作原则**：库不提供 `search()` 这类业务组合。搜索、投递、收藏都由你按站点实际情况用上面这些原子动作拼出来。拼接经验写进 `h.note()`，下次同站点直接读。

## 配方：一次意图，一次往返

原子直调的问题是每步一次模型往返。7 步的流程，光是“想下一步”就要 2–3 分钟。所以把**走通的序列**存成配方，之后只发意图。

```js
const recipe = h.recipes();               // 该域名已有的意图
await h.run("search", { kw: "供应链总监" });  // 一次调用，内部逐步执行
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

可用 `op`：`click` / `focus` / `clearField` / `type` / `press` / `waitFor` / `read` / `expectText` / `expectUrl`。

失败时抛 `HumanWarn{trigger:"recipe-failed", step, op, cause}`，带当前 URL。这时回到原子动作手工走一遍，走通再 `saveRecipe` 覆盖（版本号 +1，`fail_count` 累加）。

安全性不变：配方里的每一步都走同一套原子动作，配额、哨兵、预警一道不少。

```bash
node tools/recipe.mjs list --host h.liepin.com
node tools/recipe.mjs show --host h.liepin.com --intent search
```

## 必须知道的四个事实

1. **不要用 `mouse.move` 的 `steps` 做拟人。** 它在一次 CDP 调用内插值，事件时间戳几乎相同。本库是逐点调用并真实等待。
2. **中文没有逐键事件。** `keyboard.type` 对中文只能整段合成。本库按词组 `insertText`，组间 300~1200ms，模拟输入法上屏。
3. **坐标可能拿不到。** `snapshot` 有 `loc=` 但没有坐标。本库尝试解析 `css:` / `href:` / `role:`，解析不到就抛 `s1-missing`，**不降级成 `page.click`**。降级等于以为在拟人、其实在跳变，所以要改定位符，不要绕过。
4. **挑战页要交给人。** 检测到验证码或 Cloudflare 挑战时抛 `HumanBlocked`。不要重试、不要换 profile、不要绕。

## 禁止事项

**只禁非人写的操作，不禁读。**

- 不用 DOM `click()`、`dispatchEvent`、`form.submit()`，不直接写 `value`/`innerHTML`/`checked`。
- 不发新请求（`page.fetch`、evaluate 里的 fetch/XHR），不 goto 到 `getConditionItem` 这类接口端点。
- 不改 storage / cookie，不 `scrollIntoView` 瞬移，不操作非前台页。
- 读用 `h.inspect.*`。业务脚本里不出现 `page.*`，跑前过一遍 `node tools/lint-script.mjs <脚本>`。
- 不调用 `page.cdp("egoAutomated.disable")`。
- 不 import Playwright / Puppeteer，不为躲检测切 profile 或换号，不自动解验证码。

## 预警

动作链路一出现异常（跳走、挑战页、点击无响应、只搜不开、结果不换），库会停手并写一条告警，等你或 agent 裁决：

```bash
node tools/alert.mjs list
node tools/alert.mjs show --id 12
node tools/alert.mjs decide --id 12 --decision backoff --reason "..."
```

冻结期间只读可用。规则细节见 [references/guard.md](references/guard.md)。

## 跑完要过门禁

每次跑完，用门禁检查这一次的行为是否仍在人类区间内：

```bash
node tools/verify-human.mjs                     # 最近一次 run
node tools/verify-human.mjs --run <id>          # 指定 run
node tools/verify-human.mjs --baseline <id>     # 与基线对照，任一分项退化 >5% 判失败
```

六条断言：非信任输入为 0、无降级、落点不扎堆中心、落点中位偏移、移动采样点下限、读写比下限。
失败退出码为 1。阈值冻结在 `profiles/thresholds.json`，**agent 不许改**。

改动参数或配方后要记账，改了什么、为什么、门禁前后如何：

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

开工前按意图读：

```js
const general = h.notes();          // 该平台全部
const forSearch = h.notes("search"); // 只带 search 与通用（*）
```

踩到新情况后落一条：

```js
await h.note({
  intent: "search",
  kind: "pitfall",
  text: "关键词框是 ant-select，输入后必须按 Enter 生成 chip，再点『搜 索』；直接点会因 blur 清空",
  selector: "css=#rc_select_1",
});
```

配方失败会自动落一条 `kind: "pitfall"`、`intent` 为当前意图的经验，写明第几步、什么原因，不用手工记。

命令行：

```bash
node tools/site.mjs list --platform liepin.com --intent search
node tools/site.mjs add --platform liepin.com --intent search --kind pitfall --text "..."
node tools/site.mjs promote            # 按机械规则把可通用经验晋升为 global
```

同平台 + 同意图 + 同类型 + 同文本只累加 `hits`，不产生重复行。

跨站晋升是机械判定，不靠语义：kind 属于 `hint` / `timing`、没有 selector、
在 ≥2 个平台各命中 ≥2 次。selector 与 pitfall 永不通用。

## 导出数据

`~/.ego-human-input/human.db` 是标准 SQLite 单文件，任何 SQLite 客户端都能直接打开。

```bash
node tools/export.mjs --out ./out        # 每张表导成 jsonl + csv，附 summary.json
```

表：`runs`、`events`、`iterations`、`budget_use`、`alerts`、`host_state`、`site_notes`、`recipes`。导出的是行为与经验，不含姓名、简历 ID、输入文本。

## 调参

档案在 `profiles/` 下。站点匹配、三层覆盖、配额与字段含义见 [references/profiles.md](references/profiles.md)。

## 示例

`examples/timeline.mjs` 是可跑通的最小闭环，会打印事件统计，用来验证拟人是否真的生效。
