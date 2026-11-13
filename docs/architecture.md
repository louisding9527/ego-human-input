# 架构与缺口

给维护者读。讲层与层之间的契约、现在缺什么、先补什么。
设计判断与演进叙事在 [README](../README.md)，agent 用法在 [SKILL.md](../SKILL.md)，验收记录在 [validation.md](../validation.md)。

## 1. 分层

```
业务脚本 / agent
      │  只依赖 lib/human.mjs 的句柄
      ▼
┌──────────────────────────────────────────────────────────┐
│ 契约层  lib/human.mjs                                       │
│  装配：配置 → 站点档案 → store → 状态机 → 动作层 → 会话层   │
│  闸门  gate()：会话形状 / 冷却 / 配额预留 / 间隔 / 令牌桶   │
│  落库  logAction()：events + timeline                     │
│  收尾  flush()（幂等）/ finish() / handOff()：落盘 + 关空间  │
│  配方  lib/recipes.mjs：意图执行、经验落库                 │
└──────────────────────────────────────────────────────────┘
      │                          │                    │
      ▼                          ▼                    ▼
┌────────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│ 动作层 actions.mjs │  │ 会话层 session.mjs│  │ 适配层 browser.mjs │
│ 指针/按键、落点、  │  │ dwell、时长、日   │  │ 唯一接触 Page 的   │
│ 事后校验、巡检     │  │ 总量、休息、读写比│  │ 地方；page-fns     │
└────────────────────┘  └──────────────────┘  └────────────────────┘
      │                          │                    │
      ▼                          ▼                    ▼
┌──────────────────────────────────────────────────────────┐
│ 纯函数层（无 I/O）                                         │
│ trace 轨迹 · keyboard 键盘计划 · timing 时序采样           │
│ score 风险聚合 · recipe 插值校验 · bucket 令牌桶           │
│ profile 站点解析 · locator 定位符 · guard URL 判定与哨兵    │
│ observe 观测折算 · verify 断言与对照 · notes 经验分层       │
└──────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────┐
│ 状态层 store.mjs（SQLite WAL） · alert.mjs（四态状态机）    │
│ 数据：profiles/*.json · thresholds.json · ~/.ego-human-input│
└──────────────────────────────────────────────────────────┘
```

依赖方向单向向下：纯函数层不得 import 状态层，状态层不得 import 契约层。
`browser.mjs` 是唯一 import `page-fns.mjs` 的地方；`actions.mjs` 只认 `browser` 的方法名，
因此换成假的 browser 就能跑全链路测试。

## 2. 契约

**句柄**。业务脚本 `import lib/human.mjs` 拿到 `h`。输入类动作只能经 `h.*`；
观察与浏览器自有操作（snapshot、弹窗、上传、下载、页签）走 `page.*` / `task.*`，
分界与清单见 [references/bridge.md](../references/bridge.md)。lint 按动作类型判，不按 `page.` 前缀。

**注入**。`create(page, { browser?, sleep?, rand?, now?, store?, dbPath?, notify?, onBlock?, space? })`。
依赖都可替换：假 browser 跑行为测试，假 sleep 跳过真实等待，固定 rand 复现采样，假 now 控制时钟。
`space` 是 ego-lite 的 TaskSpace 句柄，注入后 `finish()` / `handOff()` 才能代你收尾；
不注入时这两个方法报可执行的错，库本身不认 `taskSpace` 全局。

**动作**。每个动作依次经过：会话闸门 → 冷却/配额/间隔 → 定位 → 前置校验 → 指针/按键 → 事后校验 → 落库。
任一环节失败抛 `HumanWarn` 或 `HumanBlocked`，**不降级**。配额是预留-确认两段式，
没发生指针交互的失败会 `budgetRelease` 还回去。

**会话**。`session.before(action)` 管六件事：单次时长、日总量、休息间隔、工作时段衰减、读写配比、
以及「连续搜索到配额仍不开详情」。形状（dwell、时长、动作数）经 `observe()` 进断言。

**时序**。所有等待与间隔走 `lib/timing.mjs`：区间内对数正态 + 同 key 的 AR(1) 相关。
动作层与契约层不得直接调 `Math.random`（有测试盯着）。

**观测**。`events.meta` 存动作内部的间隔序列（点击的采样点间隔、按键间隔、滚动分段位移与间隔），
`observe()` 折算成中位 CV，`verify` 据此断言「不是等距」。

**判定**。`tools/verify-human.mjs` 只读冻结阈值，不读运行时覆盖。
agent 可以改参数、配方、经验，不可以改阈值。

**经验**。`site_notes.scope` 取 `site | global | deprecated`。
`global` 只能由 `tools/site.mjs promote` 按机械规则写入：kind 属于 `hint|timing`、无 selector、跨 ≥2 站点各命中 ≥2 次。

**迭代**。`iterations` 一行 = 一次改动。`generation` 同一 (site, intent) 内递增。
状态 `pending | kept | reverted`，改动后必须过一次门禁才能 `kept`。

## 3. v0.7 补完的缺口

审计出的六项全部落地，每项都有可跑的测试，不再靠真站试错。

| 缺口 | 做法 | 验收 |
| --- | --- | --- |
| 契约层未拆分、无自动化覆盖 | 拆成 browser / page-fns / locator / actions / recipes / session；`human.mjs` 729 → 254 行 | `tests/actions.test.mjs`（11 条，闸门顺序与失败路径）、`tests/browser.test.mjs`（4 条，参数形状） |
| 会话层不存在 | `lib/session.mjs`：dwell、时长、日总量、休息、工作时段、读写配比；`requireDetailAfter` 从死配置变闸门规则 | `tests/session.test.mjs`（9 条）；门禁三条会话断言 |
| 页面哨兵自身可被探测 | 去掉 `window.__hi`、原型 setter、fetch/XHR 包装；状态在闭包里，随机名事件读回；静默写改「信任时间戳 + 值比对」 | `tests/sentinel.test.mjs`（5 条，含「全局命名空间必须干净」） |
| 时间分布均匀 | `lib/timing.mjs` 对数正态 + AR(1)；全链路改走注入的 timing | `tests/timing.test.mjs`（7 条，中位数/尾部/中段占比/相关性） |
| 观测粒度只到单次动作 | `events.meta` 存间隔序列；`observe` 出中位 CV；门禁加两条 CV 断言 | 同上 + `tests/human-likeness.test.mjs` 的等距反例 |
| 配额在定位前扣除 | `gate()` 返回预留句柄，失败路径 `release()` | `tests/actions.test.mjs` 的三条失败路径 + `tests/guard.test.mjs` 的用量归还 |
| 四处小不一致 | `waitFor` 支持 role、插值严格模式、`limit_n` 冲突更新、lint 进测试 | `tests/actions.test.mjs`、`tests/guard.test.mjs` |

## 4. 仍然缺的

**真人样本校准**。所有阈值都是工程值（`thresholds.json` 里 `calibrated: false`）。
落点偏移 3px、CV 0.15/0.2、dwell 300ms 这些数字没有依据真人数据，只是「明显非机器」的下限。
校准方法：录真实浏览器会话的指针与按键间隔，取低分位数作为下限；在此之前，宁可标注「未校准」也不假装精确。

**更多真站复测**。2026-11-13 已在 h.liepin.com 跑通一轮（11/11，见 [validation.md](../validation.md)），
并因此修掉两个只有真站才暴露的问题：`evaluate(fn, undefined)` 被 ego-lite 拒绝、中文整段一次上屏。
但一次复测不是统计结论：跨站点（zhipin / 51job）、跨意图（收藏、投递）、跨时段都还没跑，
夜间衰减、休息间隔、自动补阅读在真实流量下的影响也未观察。

**并发配额**。`budget_use` 是「读一次再写一次」，多进程同时起跑仍可能一起过限。
要真锁就得用 SQLite 事务（`BEGIN IMMEDIATE`）把读改写包起来，代价是写锁竞争。
当前按单进程使用设计，多进程场景记在文档里，不假装没有。

**通知只有一条通道**。浏览器通知要求安全上下文、活着的页面、以及一次人工授权；
换机器、换 profile、清了站点权限都要重授权。没有授权时只能靠 `alerts` 表事后查，
「及时触达」这件事就退化成「回来以后翻记录」。要真正脱离浏览器，就得加一个外部通道
（ntfy / 机器人），那是十行代码，但引入网络与密钥，v0.7 不做。

**会话与配方的交互**。自动补阅读插在写动作前，会改变配方的时间轴。
目前只在 `nav/write/search/detail` 四类动作前触发，短读 1–2 秒；
如果真站复测发现它会打乱某些流程，admission 条件需要收窄。

## 5. 优先级

1. 真站复测（P0）——v0.7 的所有改动都还没有真实流量背书。
2. 真人样本校准阈值（P1）——决定「像人」的下限是拍脑袋还是有依据。
3. 并发配额事务化（P2）——只有多进程并用时才需要。
4. 会话与配方的交互收窄（P2）——看复测结果再决定。

## 6. 不做什么

- 不做指纹伪造：真机、真 GPU、真登录态已经一致，改反而制造矛盾。
- 不做验证码绕过：遇到挑战停手、留证据、交给人。
- 不做多账号轮换：那是绕过封禁，不是拟人。
