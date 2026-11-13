# 护栏与预警

v0.2 起，所有动作都要过三道关：禁令、异常目录、预警状态机。本文件是规则手册。

## 1. 边界：禁写不禁读

动作必须由指针或按键发起。读取已存在的信息不设限。

**允许**：`h.inspect.*`、snapshot、读 DOM 文本/属性/rect、读 cookie、读已发生的请求记录、翻 sqlite。

**禁止**：DOM `click()`、`dispatchEvent`、`form.submit()`、直接写 `value`/`innerHTML`/`checked`、`page.fetch`、新发 XHR、改 storage/cookie、`scrollIntoView` 瞬移、操作非前台标签页、点不可见元素、`insertText` 一次注入 >12 字符。

静态检查：

```bash
node tools/lint-script.mjs your-script.mjs
```

命中即 `exit 1` 并给行号。业务脚本里不应出现 `page.*`，只用 `h.*`。

## 2. 动作分类与配额

| 类型 | 判定 | balanced 配额 | 间隔 |
| --- | --- | --- | --- |
| search | 提交查询 | 6/h | 45–120s |
| detail | 打开详情 | 8/h | 30–60s |
| write | 收藏、投递、发消息 | 10/h | 15–40s |
| nav | 翻页、跳转 | 20/h | 8–25s |
| read | 停顿、滚轮 | 不计 | — |

配额按 `小时 + 域名 + 类型` 存 sqlite，跨进程生效。超限抛 `HumanWarn`。

## 3. 搜索专项

库不再提供 `search()` 组合方法。搜索由你按站点实际情况用原子动作拼：`focus` → `clearField` → `type` → `press("Enter")` → `click(提交按钮, {as:"search"})` → `waitFor(结果容器)`。

提交那一下用 `{as:"search"}` 标记，配额与统计才会记到搜索头上。

- 连续 3 次搜索且期间没开详情 → 停（S17）。
- 与上次关键词编辑距离 <2 → 记 `s18-near-dup`，计入密度不计次数。
- 结果指纹与前次相同 → 标 `suspect_cache`（S16），连续 2 次停。

各站点的控件差异写进 `site_notes`，不进库。

## 4. 异常目录

| # | 异常 | 行为 |
| --- | --- | --- |
| S1 | 元素 0×0 / 找不到 | 滚轮逼近 12 次仍不可见 → 抛 |
| S2 | 元素被遮挡 | 抛，不强点 |
| S3 | disabled | 抛 |
| S4 | 点击无响应（URL 与 DOM 都没变） | 记录 `s4-noop`；同目标第 2 次 → 熔断 |
| S5 | 跳离原域 | 进 WARN |
| S6 | 挑战页（URL 或 DOM 特征） | 立即停，ESCALATED |
| S7 | 遮罩 | 由 S2 覆盖 |
| S8 | 元素被替换 | 每次点击前重新定位 |
| S9 | 页面未就绪 | 结果等待超时，记 `s9-no-results` |
| S10 | 同动作连败 | 由 S4 计数覆盖 |
| S11 | HTTP 403/429/503 | 未实现（需开 Network 域，与 ego 事件缓冲冲突） |
| S12 | 登录态失效 | 路径命中 login → 停 |
| S13 | 软提示 toast | 命中「频繁/稍后/异常/限制」→ 进 WARN |
| S14 | 计数未变 | 由业务层读回校验，本库不介入 |
| S15 | 限流头 | 未实现（同 S11） |
| S16 | 结果集未变 | 标 `suspect_cache` |
| S17 | 只搜不开 | 停 |
| S18 | 近重复关键词 | 记标志 |

## 5. 预警状态机

```
NORMAL --硬信号--> ESCALATED
NORMAL --软信号 / 巡检 score>=30--> WARN
WARN --score<30--> NORMAL（退避 60-120s）
WARN --30..69--> HALTED（冷却 10-20min）
WARN --score>=70--> ESCALATED
ESCALATED --decide--> NORMAL / HALTED
HALTED --到点--> NORMAL
```

冻结期间 `gate()` 抛 `HumanWarn`，`inspect` 与 sqlite 读照常。

评分：search_burst 30、search_no_detail 25、search_same_fp 20、search_interval_cv 15、chain_repeat 15、fail_rate 15、alerts_7d 10、orphan_request 5/次（上限 15）、silent_write 5/次（上限 10）。

## 6. 查看与裁决

```bash
node tools/alert.mjs list
node tools/alert.mjs show --id 12
node tools/alert.mjs decide --id 12 --decision abort --reason "3 轮同序列"
```

`show` 打印诊断块：站点、触发原因、评分、嫌疑特征、30 分钟动作分布、搜索形态、最近 8 条事件。

决策写入 `alerts` 表并落 `host_state` 冷却。冷却期内 `gate()` 直接抛，脚本起不来动作。

## 7. 数据

`~/.ego-human-input/human.db`（SQLite，WAL）：

| 表 | 内容 |
| --- | --- |
| `runs` | 每次脚本执行 |
| `events` | 每个动作：时间、路径、类型、目标哈希、成败、耗时、标志、关键词哈希、结果指纹 |
| `alerts` | 预警：触发、证据、规则结论、最终结论、决策人 |
| `budget_use` | 小时配额用量 |
| `host_state` | 站点冷却状态 |

不记录姓名、简历 ID、输入文本、页面 HTML。路径只存 pathname，目标只存 8 位哈希。
