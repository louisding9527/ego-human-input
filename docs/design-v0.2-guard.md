# 设计稿：ego-human-input 护栏与预警 v0.2

依据：《猎聘反爬触发记录_2026-11-13》。三次拦截分别为 40 分钟 12 轮同序列、2 分钟重复点击、3 分钟 5 次搜索。v0.1 的两道闸门（令牌桶、minGap）在这三次里一次未触发，限额守的是总速率，站点守的是结构重复。

## 1. 边界：禁写不禁读

**动作必须由指针或按键发起。** 读取已存在的信息不设限。

| 允许 | 禁止 |
| --- | --- |
| snapshot、读 DOM 文本/属性/可见性/rect | `el.click()`、`dispatchEvent`、`submit`、`requestSubmit` |
| `page.url` / `title` / `info` / 已缓存 network 事件 | 改 `value` / `innerHTML` / `checked` / `disabled` |
| 读 cookie、localStorage（只读） | 写 storage / cookie / 权限 |
| Resource Timing、已发生的请求记录 | 新发 fetch / XHR / WebSocket |
| 预警期加大读取频率、翻 sqlite | `scrollIntoView` / `window.scrollTo` 瞬移 |
| `h.inspect.*` 全部方法 | 操作非 active 标签页 |
| — | goto 到 XHR-only 端点（`/api/*`、`getConditionItem` 类） |
| — | 点视口外或不可见元素 |
| — | `insertText` 一次注入 >12 字符；正文用 `paste()` |

执行三层：

1. `tools/lint-script.mjs` 静态扫描，业务脚本里出现 `page.evaluate` / `page.fetch` / `.click(` / `dispatchEvent` / `.value =` / `localStorage` / `scrollIntoView` 即拒绝运行。
2. 页面哨兵：`isTrusted=false` 的输入事件、无指针动作时的值写入、无指针动作时的新请求。
3. API 层：业务脚本拿不到 `page`，只有 `h.*`；`h.click` 只走指针路径，`h.goto` 先做 URL 分类。

## 2. 模块

| 文件 | 职责 |
| --- | --- |
| `lib/store.mjs` | sqlite 打开、建表、写事件/告警、查询与聚合 |
| `lib/score.mjs` | 纯函数：间隔 CV、序列重复率、失败率、综合评分、分档 |
| `lib/guard.mjs` | 纯函数：URL 分类、API 端点判定、结果指纹；页面侧探针 |
| `lib/alert.mjs` | 状态机 NORMAL/WARN/ESCALATED/HALTED 与决策 |
| `lib/human.mjs` | 编排：gate、动作、哨兵、事后校验、search |
| `tools/lint-script.mjs` | 静态禁令检查 |
| `tools/alert.mjs` | 给 agent 的 CLI：list / show / decide |

## 3. 动作分类与配额

五类：`search`、`detail`、`write`、`nav`、`read`。每类独立小时配额与最小间隔。

| 类型 | 判定 | 默认配额 | 间隔 |
| --- | --- | --- | --- |
| search | 提交查询（URL query 变化 / 结果容器刷新） | 6/h | 45–120s |
| detail | 打开详情页 | 8/h | 30–60s |
| write | 收藏、分组、投递、发消息 | 10/h | 15–40s |
| nav | 翻页、返回列表、页内跳转 | 20/h | 8–25s |
| read | 停顿与滚轮 | 不计配额 | — |

`goto` 进搜索页算 `nav`，不额外计 `search`；只有真正提交才计 `search`。

配额记在 `budget_use`，按 `hour + host + action` 主键，跨进程生效。

## 4. 搜索专项

搜索在猎聘阈值最低，单独加四条：

1. **连续搜索上限 3 次**。之后必须打开一份详情或做 ≥60s 阅读，否则 S17 停。
2. **同词 24 小时不重搜**。关键词编辑距离 <2 视为同词变体，计密度不计次数（S18）。
3. **结果指纹必须变化**。取结果列表前 12 条的标识 hash 拼接；与上次相同则判 `suspect_cache`，连续 2 次停（S16）。
4. **搜索必须走 `h.search()`**：点关键词框 → 清空 → 逐字输入 → 停顿 → 回车或点搜索 → 等结果容器变化。禁止 `goto` 表单端点取控件。

日志多记三列：`kw_hash`（8 位）、`result_fp`（8 位）、`result_n`。

## 5. 异常目录

触发即进预警或熔断。

| # | 异常 | 检测 | 处置 |
| --- | --- | --- | --- |
| S1 | 元素 0×0 或不可见 | rect 宽高任一为 0 | 等 800ms 重测，仍 0 抛 |
| S2 | 元素被遮挡 | `elementFromPoint` 不是它或后代 | 抛，不强点 |
| S3 | disabled | `disabled` / `aria-disabled` | 抛 |
| S4 | 点击无响应 | 300ms 内无导航、无 DOM 变更、无请求 | 记 noop，同目标 2 次熔断 |
| S5 | 跳离原域 | 动作后 host ≠ 初始 host | 硬信号，停 |
| S6 | 挑战页 | URL 特征 + DOM 特征 | 硬信号，停 |
| S7 | 遮罩挡住 | mask 覆盖目标中心 | 先关弹窗，关不掉抛 |
| S8 | 元素被替换 | rect 两次不同 / 引用 detached | 重定位，最多 2 次 |
| S9 | 页面未就绪 | readyState / 网络空闲超时 | 退避重试 3 次 |
| S10 | 同动作连败 | 同 target_hash 失败 ≥2 | 熔断，冷却 30 分钟 |
| S11 | HTTP 异常 | 403 / 429 / 503 / 空 body | 硬信号，停 |
| S12 | 登录态失效 | 跳登录页 | 停，handOff |
| S13 | 软提示 | toast 含 频繁/稍后/异常/限制 | 硬信号，停 |
| S14 | 计数未变 | 业务层读回校验 | 熔断，不重试 |
| S15 | 限流头 | `Retry-After`、`X-RateLimit-*` | 按头部冷却 |
| S16 | 结果集未变 | 结果指纹相同 | 标 suspect_cache，2 次停 |
| S17 | 只搜不开 | 连续 3 次 search 且 detail=0 | 停，进 WARN |
| S18 | 近重复关键词 | 编辑距离 <2 | 计密度不计次数 |

## 6. 日志（sqlite，`~/.ego-human-input/human.db`，WAL）

| 表 | 字段 |
| --- | --- |
| `runs` | id, started_at, ended_at, host, profile, skill_ver, outcome |
| `events` | ts, run_id, seq, host, path(≤80), action, target_kind, target_hash(8), ok, ms, flags, kw_hash, result_fp, result_n |
| `rounds` | run_id, host, kind, started_at, ended_at, actions, outcome |
| `budget_use` | hour, host, action, used, limit_n |
| `alerts` | ts, run_id, host, level, trigger, evidence, rule_decision, final_decision, decided_by, resolved_at |
| `host_state` | host, mode, until, reason, updated_at |

`path` 只存 pathname，不存 query。不记姓名、简历 ID、输入文本、页面 HTML。`evidence` 是 JSON 摘要。

预警触发与决策双写：`alerts` 一行 + `events` 两条（`alert_trigger`、`alert_decision`）。

## 7. 预警状态机

```
NORMAL --硬信号--> ESCALATED
NORMAL --软信号 / 巡检 score>=30--> WARN
WARN --score<30--> NORMAL (退避 60-120s)
WARN --30..69--> HALTED (冷却 10-20min, 配额降一档)
WARN --score>=70--> ESCALATED
ESCALATED --decide--> NORMAL / HALTED
HALTED --until 到点--> NORMAL
```

- 冻结粒度是整个 TaskSpace；冻结期间 `gate()` 抛 `HumanWarn`，`inspect` 与 sqlite 读不受影响。
- 诊断预算 8 秒，超时按「信息不足」处理。
- 决策来源：`rule`（分数）、`agent`（CLI 写回）、`timeout`（超时兜底）。
- 兜底：score ≥70 时 30 分钟内无裁决按 abort；30–69 超时按 backoff。
- 去抖：同 host 5 分钟内只开一条 pending 告警。

评分权重（0–100，封顶 100）：

| 特征 | 条件 | 分 |
| --- | --- | --- |
| search_burst | 10 分钟内 search ≥3 | +30 |
| search_no_detail | 连续 5 次 search 且 detail=0 | +25 |
| search_same_fp | 结果指纹重复 | +20 |
| search_interval_cv | 搜索间隔 CV <0.2 | +15 |
| chain_repeat | 3 元组序列重复率 >0.6 | +15 |
| fail_rate | >0.3 | +15 |
| alerts_7d | ≥3 | +10 |
| orphan_request | 每次 | +5，上限 15 |
| silent_write | 每次 | +5，上限 10 |

## 8. 配置

`profiles/base.json` 增 `budget`、`search`、`alert` 三段，档位仍为 strict/balanced/fast。第五节三项（detail 配额、启动硬拒绝、fast 档）本轮不动，维持原值。

## 9. 验收

全部离线，不碰猎聘：

- 本地 http 服务提供假页面：`/captchaPage_PC`、`/v/intercept/blankpage`、0×0 按钮、遮罩、无响应按钮、慢加载、会 `dispatchEvent` 的页。
- 断言：URL 分类、S1–S18 命中、alerts 落库、events 字段完整、状态机四态转移、评分边界。
- 单测覆盖纯函数：CV、重复率、评分、分档、编辑距离、lint 规则。

## 10. 风险

- 哨兵 hooking `fetch` 可能与站点 CSP 或 SW 冲突，失败时降级为不统计，不阻断。
- `silentWrite` 会被框架受控输入误伤，权重低、只诊断不阻断。
- 诊断期间页面可能已跳到挑战页，读取全部包 try/catch。
