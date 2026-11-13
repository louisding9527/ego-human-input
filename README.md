# ego-human-input

给 [ego-browser（ego-lite）](https://github.com/CitroLabs/ego-lite) 加一层"像人"的输入：鼠标走曲线、键盘分节奏、浏览插停顿，并按站点控制操作频率与预警。

这是一个 Claude/Codex 风格的 **skill 包**：装上后由 AI 在浏览器任务里加载使用，也被业务脚本直接 `import`。

English: a human-like input layer and anti-bot-pacing guard for ego-lite, packaged as an agent skill.

## 为什么做这个

真实账号上的自动化，输的地方通常不是"点得快"，而是"点得太像机器"：

- 一串动作的间隔固定、顺序固定、没有鼠标轨迹；
- 点完没反应就重试，重试被算进行为密度；
- 用 DOM `click()` 代替指针，事件里没有 `mousedown/mouseup`；
- 同一个接口被反复进入，形成可识别的请求节奏。

本项目把这些拆成可测的规则：动作频率、轨迹、击键节奏、异常目录、预警状态机，并把"每站怎么点"沉淀成数据而不是代码。

## 结构

```
SKILL.md              AI 读的使用说明
lib/                  运行时库
  human.mjs           句柄：原子动作、配额、哨兵、预警
  recipe.mjs          配方参数插值与校验
  guard.mjs           URL 分类、页面哨兵
  alert.mjs           预警状态机
  score.mjs           风险评分（纯函数）
  store.mjs           SQLite：事件、告警、配额、经验、配方
  trace.mjs           鼠标轨迹算法
  keyboard.mjs        键盘节奏与中文分段
profiles/             参数档案（strict / balanced / fast）+ 站点表
tools/                lint-script / alert / site / recipe / export
tests/                单测（25 条）
examples/             可跑通的示例
docs/                 设计与实施记录
```

## 三条设计原则

**1. 禁写不禁读。** 改变页面状态或产生新请求的动作，必须由指针或按键发起；只读取已存在的信息不设限。`tools/lint-script.mjs` 静态拦截 DOM 点击、直接写值、`fetch`、`scrollIntoView` 等。

**2. 库只出原子动作。** 不提供 `search()` 这类业务组合。站点差异靠数据：`site_notes`（平台 + 意图 + 类型）与 `recipes`（意图 → 步骤数组）。

**3. 意图一层，执行一层。** `h.run("search", {kw})` 一次调用跑完一条 7 步配方（实测 95 秒），而不是让模型为每一步做一次往返（3–5 分钟）。

## 快速开始

```bash
git clone https://github.com/louisding9527/ego-human-input.git
cd ego-human-input
node --test "tests/*.test.mjs"
```

装进本机 skill 目录（Windows 用 junction，改动即时生效）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux：

```bash
./install.sh
```

用：

```js
const { human } = await import("file:///<SKILL_DIR>/lib/human.mjs");

const h = await human.create(page, { task });
console.log(h.site(), h.health.warnings);

await h.click("loc=role:button[name='登录']");
await h.type("周杰伦");
await h.read();
await h.flush();
```

## 预警

动作链路出现异常（跳走、挑战页、点击无响应、只搜不开、结果不换）时，库会停手并落一条告警：

```bash
node tools/alert.mjs list
node tools/alert.mjs show --id 12
node tools/alert.mjs decide --id 12 --decision backoff --reason "..."
```

冻结期间只读可用（`h.inspect.*`），可以继续看页面、翻日志。

## 数据

`~/.ego-human-input/human.db`（SQLite，WAL）：

| 表 | 内容 |
| --- | --- |
| runs | 每次脚本执行 |
| events | 每个动作：时间、路径、类型、目标哈希、成败、耗时、标志 |
| alerts | 预警：触发、证据、规则结论、最终结论、决策人 |
| budget_use | 小时配额用量 |
| host_state | 站点冷却 |
| site_notes | 平台 / 意图 / 类型的交互经验 |
| recipes | 意图 → 步骤数组，带版本与成败计数 |

不含姓名、简历 ID、输入文本、页面 HTML。

```bash
node tools/export.mjs --out ./out   # 每张表导成 jsonl + csv
```

## 状态

v0.5.0，开发中。已在 ego-browser + Chromium 实测机制（轨迹、事件来源、配额、预警、配方执行），真实站点的收藏与投递流程尚未验证。

详见 [validation.md](validation.md)。

## 明确不做

浏览器指纹伪造、TLS/JA3 伪装、代理与 IP 轮换、账号池、验证码与封禁页绕过。ego-lite 跑在真实机器与真实登录态上，改指纹只会自相矛盾。

## License

MIT
