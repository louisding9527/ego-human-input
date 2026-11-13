# ego-human-input

给 [ego-browser（ego-lite）](https://github.com/CitroLabs/ego-lite) 加一层"像人"的输入，并按站点控制操作频率与风险。

它是 agent skill：装上后由 AI 加载使用，也被业务脚本直接 `import`。

```js
const { human } = await import("file:///<SKILL_DIR>/lib/human.mjs");
const h = await human.create(page, { task });
await h.run("search", { kw: "供应链总监" });   // 一次意图，内部执行整条配方
await h.flush();
```

---

## 一、要解决的问题

这套东西不是从"怎么更像人"出发设计的，是从三次真实拦截反推出来的。

| 现象 | 实际动作量 | 结果 |
| --- | --- | --- |
| 40 分钟内 12 轮"搜索→开详情→收藏→回列表" | 约 39 次动作 | 图形验证码 |
| 2 分钟内同一按钮反复点（保存没生效，重试） | 集中 6 次无效点击 | 图形验证码 |
| 3 分钟 5 轮"进搜索页→改词→提交" | 10 次动作，0 次开详情 | 定时封禁 2 小时 |

对照当时已有的限速器（18 次/分钟、最小间隔 0.8–2.4 秒）：三次里它的占用率分别是 5%、18%、18%，**一次都没触发**。

结论：站点拦的不是"总速率"，是**结构重复**。固定的动作顺序、固定的间隔、没有鼠标轨迹、点完不读页面。

所以设计目标从"限速"改成三件事：

1. 让动作由指针和按键产生，行为特征与人工一致；
2. 让"同一序列反复出现"在触发阈值前被自己拦住；
3. 出问题时立刻停、留证据、可复盘。

## 二、五条设计原则

**1. 禁写不禁读。**
改变页面状态或产生新请求的动作，必须由指针或按键发起；读取已存在的信息不设限。`tools/lint-script.mjs` 静态拦截 DOM `click()`、`dispatchEvent`、直接写 `value`、`page.fetch`、`scrollIntoView`。页面内还驻留哨兵，统计 `isTrusted=false` 的输入事件。

**2. 库只出原子动作。**
不提供 `search()`、`favorite()` 这类业务组合。站点差异靠数据：`site_notes`（平台 + 意图 + 类型）和 `recipes`（意图 → 步骤数组）。库本身与站点无关。

**3. 意图一层，执行一层。**
原子直调的问题不是原子性，是**每一步都要一次模型往返**。7 步的流程，光"想下一步"就 3–5 分钟。配方把走通的序列固化，agent 只发意图：同一条流程实测 95 秒。

**4. 数据优于代码。**
经验、配方、配额用量、告警全部落 SQLite。改行为不用改代码，换站点不用改代码，导出就能横向分析。

**5. 失败要快，要留证据。**
页面没渲染就点 → 18 毫秒返回 `s1-missing`，不发出任何错误点击。失败时带第几步、哪个 op、当前 URL，并自动写一条 `pitfall` 经验。

## 三、架构

```
agent
  │  h.run("search", {kw}) / h.click / h.type / h.read
  ▼
human 句柄（lib/human.mjs）—— 唯一入口，业务拿不到 page
  │
  ├─ 三道闸门：配额与间隔 · 预警状态 · 冻结
  ├─ 原子动作：focus / clearField / type / press / click / waitFor / read / scroll
  ├─ 事后校验：URL 分类、挑战页、软提示、事件来源、无响应点击
  └─ 落库：events / alerts / budget_use / site_notes / recipes
  │
  ▼
ego-lite（真实 Chromium + 真实登录态）
```

| 模块 | 职责 | 边界 |
| --- | --- | --- |
| `lib/human.mjs` | 句柄、闸门、动作编排 | 不实现站点逻辑 |
| `lib/guard.mjs` | URL 分类、API 端点判定、页面哨兵 | 纯函数 + 页面注入 |
| `lib/alert.mjs` | 预警四态状态机与决策 | 不碰页面 |
| `lib/score.mjs` | 风险评分、CV、序列重复率 | 纯函数，可单测 |
| `lib/store.mjs` | SQLite 读写与聚合 | 无业务语义 |
| `lib/recipe.mjs` | 参数插值、步骤校验 | 纯函数 |
| `lib/trace.mjs` | 鼠标轨迹三族 | 纯函数，注入随机源 |
| `lib/keyboard.mjs` | 键盘节奏、中文分段、误输入 | 纯函数，输出动作计划 |
| `lib/bucket.mjs` | 令牌桶 | 纯函数 |

## 四、一次动作的生命周期

以 `h.click()`（`lib/human.mjs:359`）为例：

1. **闸门 `gate()`**（`lib/human.mjs:293`）
   - 预警状态检查：`halted` 抛冷却，`warn/escalated` 抛待裁决；
   - 小时配额：`budget_use` 按 `小时 + 平台 + 动作类型` 累加，超限抛 `budget`；
   - 同类最小间隔 + 全局令牌桶。
2. **目标定位**：`loc` / `css=` / `role:name` 三种定位符求 rect；视口外用滚轮逐步逼近（不用 `scrollIntoView`，那是瞬移）。
3. **前置校验**：0×0 抛 `s1-zero`，被遮挡抛 `s2-occluded`，`disabled` 抛 `s3-disabled`。拿不到坐标直接抛，**不降级成原生跳变点击**——静默降级会让拟人形同虚设。
4. **轨迹**：随机选轨迹族，逐点 `mouse.move` + 真实 `sleep`，落点抖动后再校正。
5. **点击**：`mouse.click` 带按下时长。
6. **事后校验 `checkAfterAction()`**（`lib/human.mjs:240`）：URL 分类（挑战域/挑战路径/域漂移/登录页）、挑战页 DOM 特征、软提示 toast、哨兵里的 `untrusted` 事件。
7. **无响应检测**：300ms 内 URL 与 DOM 都没动 → 记 `s4-noop`，同目标 30 分钟内第二次 → 熔断。
8. **巡检**：每 5 个动作算一次风险分，跨阈值进 WARN。
9. **落库**：`events` 一行（路径只存 pathname，目标只存 8 位哈希）。

## 五、预警状态机

```
NORMAL ──硬信号──────────────► ESCALATED
NORMAL ──软信号 / 巡检≥30──► WARN
WARN ──<30──► NORMAL（退避 60–120s）
WARN ──30–69──► HALTED（冷却 10–20min）
WARN ──≥70──► ESCALATED
ESCALATED ──decide──► NORMAL / HALTED
HALTED ──到点──► NORMAL
```

- 冻结粒度是整个 TaskSpace，冻结期间 `gate()` 抛错但 `h.inspect.*` 照常可用——诊断得能读。
- 评分（0–100，封顶）：搜索爆发 30、连续搜索无详情 25、结果指纹重复 20、搜索间隔 CV<0.2 15、序列重复 15、失败率 15、7 天告警 10、无动作请求 5/次（上限 15）、无动作改值 5/次（上限 10）。
- 决策来源：`rule` / `agent`（CLI 写回）/ `timeout`（30 分钟兜底）。
- 冷却写 `host_state`，**跨进程生效**：被封后下一个脚本起来直接 `halted`，不会一上班就补刀。

## 六、配方：意图到执行

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

await h.run("search", { kw: "供应链总监" });   // 95 秒，一次调用
```

- 可用 op：`click / focus / clearField / type / press / waitFor / read / expectText / expectUrl`。
- 失败抛 `recipe-failed{step, op, cause, url}`，`fail_count` 累加，同时自动写一条 `pitfall` 经验。
- 配方里的每一步仍走同一套原子动作与闸门，安全性不因封装而降低。
- 配方按平台键存储，子域共享；版本号递增，保留成败计数用于判断哪条配方经常坏。

## 七、数据模型

`~/.ego-human-input/human.db`（SQLite，WAL）。

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `runs` | host, profile, ver, outcome | 一次脚本执行 |
| `events` | ts, path, action, target_hash, ok, ms, flags, kw_hash, result_fp | 动作流水，聚合的原料 |
| `alerts` | trigger, evidence, rule_decision, final_decision, decided_by | 预警与裁决，可对账"谁判的、判对没有" |
| `budget_use` | hour, platform, action, used, limit | 小时配额，跨进程 |
| `host_state` | mode, until, reason | 站点冷却 |
| `site_notes` | platform, intent, kind, text, selector, hits | 交互经验 |
| `recipes` | platform, intent, steps, version, ok_count, fail_count | 意图配方 |

设计约束：不存姓名、简历 ID、输入文本、页面 HTML；路径只存 pathname，目标只存 8 位哈希。导出 `tools/export.mjs` 出 jsonl + csv，可直接分析。

## 八、算法

**鼠标轨迹三族**（按权重随机）：贝塞尔（控制点垂直偏移 15% 距离）、抖动（垂直噪声按 `sin(πt)` 中间大两端小）、过冲回拉（先越过 8–20px 再修回）。采样点 12–26 个，每点之间真实等待 6–20ms，首尾 15% 区间减速。

关键取舍：`mouse.move` 的 `steps` 参数在一次 CDP 调用内插值，事件时间戳几乎相同，**拟人价值为零**。只能多次调用。

**键盘**：拉丁逐键，词内 55–150ms，空格后 90–220ms；中文没有逐键事件，按词组整段插入，组间 300–1200ms；每 2 组按概率注入一次错字 + 退格。

**评分**：间隔变异系数（CV < 0.2 判规律）、三元组序列重复率（不同路径少于 3 个时不计，避免单页 SPA 误杀）、失败率、7 天告警数。

## 九、关键决策与代价

| 决策 | 理由 | 放弃 |
| --- | --- | --- |
| 坐标拿不到就抛，不降级 | 静默降级 = 以为在拟人，其实在跳变 | 覆盖更多页面，需要更准的定位符 |
| 中文整段插入 | 中文没有 keydown 序列 | 输入法选词节奏 |
| 配方存数据不存代码 | 换站不改库 | 配方得靠实测攒，攒之前是慢的 |
| 冻结期间只允许读 | 诊断要能看页面 | 冻结期不能自救，必须等裁决 |
| 探测只降不升 | 误判不能把节奏调激进 | 站点变松时不会自动加速 |
| 不做指纹伪造 | 真机真 GPU 已一致，改反而矛盾 | 无法对抗按指纹评分的高级风控 |

## 十、实测

| 项 | 数据 |
| --- | --- |
| 轨迹 | 一次移动 20–63 个 `mousemove`，最小间隔 12ms，间隔值 10 种以上 |
| 事件来源 | `isTrusted` 全真，`untrusted` 计数 0 |
| 停顿 | 5–11 秒，含 1–2 次分段滚轮 |
| 配额 | nav 12/12 时抛 `budget` 并落告警 |
| 冷却 | 裁决 abort 后下一进程 `halted`，剩 120 分钟 |
| 配方 | 7 步 95.7 秒，一次调用；原子直调同流程 3–5 分钟 |
| 失败 | 页面未渲染时 18 毫秒返回 `s1-missing`，零误动作 |

单测 25 条，覆盖：定位符与 URL 分类、CV 与重复率边界、评分封顶、配额递增、告警创建与裁决、状态机冻结与恢复、配方插值与校验、经验去重与意图隔离、lint 正反例。

完整记录见 [validation.md](validation.md)。

## 十一、限制

- 真实站点只验证到搜索链路，收藏与投递未完成：结果卡片是 `div` 不是 `a`，还没定准点击目标。
- `role:` 定位依赖文本匹配，复杂 aria 结构下会失败（失败即抛，不降级）。
- HTTP 403/429 的响应头级检测未实现：读响应头要开 `Network` 域，而 `page.events()` 会清空 ego 的事件缓冲，可能干扰弹窗与下载等待。
- 并发跑多个脚本时，跨进程配额与冷却会互相覆盖。
- `silentWrite` 会被前端框架的受控输入误伤，权重已压低，仅作诊断。

## 十二、开发

```bash
node --test "tests/*.test.mjs"
node tools/lint-script.mjs examples/timeline.mjs
```

装上（Windows 用 junction，改动即时生效）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux：`./install.sh`。

设计文档在 [docs/](docs/)，按阶段记录了 v0.1 拟人层与 v0.2 护栏层的取舍过程。

## License

MIT
