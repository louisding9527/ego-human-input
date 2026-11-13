# 验收记录

按版本累计。v0.1 在 example.com 上验证机制，v0.2 起按猎聘三次拦截记录加固，v0.3 起改为原子动作 + 经验数据，v0.4 加配方层。

---

# v0.1（2026-11-10）机制验证

环境：ego-browser 0.6.2.8 / chromium 156 / node v24.22.1，Windows。

单测 12/12。实测（example.com，本机）：

| 项 | 结果 |
| --- | --- |
| 轨迹 | 一次移动 20–63 个 mousemove，相邻最小间隔 12ms，不同间隔 10 种以上 |
| 停顿 | read 7.1–8.7 秒，含 1–2 次滚轮，delta 去重 5–7 种 |
| 事件来源 | `isTrusted` 全真，untrusted 计数 0 |
| 中文输入 | 单测验证按词组整段插入，组间 300–400ms |
| 误输入 | 单测验证每 2 组后注入退格 |

# v0.2（2026-11-13）护栏与预警

单测 23/23。实测：

| 项 | 结果 |
| --- | --- |
| 挑战页 | 注入 `#captcha` 后抛 `HumanBlocked`，`alerts` 落 `rule_decision=abort` |
| 裁决 CLI | `list` / `show` / `decide` 跑通，`show` 输出评分、嫌疑、30 分钟分布、最近 8 条事件 |
| 跨进程冷却 | `decide abort` 后下一进程 `halted`，`click` 抛冷却，剩 120 分钟 |
| 点击无响应 | 同目标第二次 `s4-noop` 熔断 |
| lint | 六条反例全中（DOM click、dispatchEvent、写 value、page.fetch、localStorage、scrollIntoView） |
| 未实现 | S11/S15（需 Network 域，与 ego 事件缓冲冲突）、S14（业务层） |

# v0.3（2026-11-13）原子动作与经验表

猎聘实测后重构。

- 删除 `h.search()` 组合方法；新增 `focus` / `press` / `clearField` / `waitFor` / `note` / `notes`。
- 新增 `site_notes` 表与 `tools/site.mjs`、`tools/export.mjs`。
- 修 `chainRepeat`：单页 SPA 下所有动作同路径，重复率恒为 1.0，触发过假 WARN。改为「不同路径少于 3 个时不计」。

猎聘实测：

| 项 | 结果 |
| --- | --- |
| 搜索提交 | 成功，共 3000+ 位人选。路径：点输入框 → 打字 → Enter 生成 chip → 点『搜 索』 |
| 只点『搜 索』不按 Enter | 失败，blur 清空 ant-select 输入，搜成空串 |
| 预算闸门 | nav 12/12 时抛 `HumanWarn(budget)` 并落 `alerts` |
| 误报 | 修复前 `chainRepeat` 必中（100%），修复后同操作 `state=normal, alerts=0` |
| 收藏 / 投递 | 未验证，卡在结果卡片是 div 非 a |

# v0.4（2026-11-13）配方层

原子直调每步一次模型往返，成本过高。加配方：意图 → 步骤数组 → 原子动作。

猎聘搜索，7 步：

```
run: { intent: 'search', steps: 7, ms: 95656 }
result cards: 30
```

一次调用跑完，agent 只发一次意图。对比原子直调同一流程：墙钟 3–5 分钟、约 6 次往返。

首轮 `step 0` 抛 `s1-missing`（页面未渲染完），18 毫秒返回，没有误动作。加 3.5 秒等待后通过。

# v0.5（2026-11-13）经验表分维度

`site_notes` 从「host + 自由文本」改为「platform + intent + kind」，配方失败自动落坑。

| 维度 | 取值 |
| --- | --- |
| platform | 站点 key，如 liepin.com，子域共享一份 |
| intent | search / favorite / apply 等动作意图，`*` 表示通用 |
| kind | hint / pitfall / selector / timing |

唯一性靠 platform + intent + kind + text，重复写入只累加 `hits`。按意图查询时一并返回 `*` 通用经验。

配方失败自动写一条 `pitfall`，记第几步、哪个 op、什么原因。

老库迁移：`openStore()` 检测缺列自动 `ALTER TABLE`，并把 `platform` 回填为 `host`；再把 `h.liepin.com` 这类子域归并到 `liepin.com`。

单测 25/25，新增用例覆盖：同意图去重计数、跨意图隔离、通用经验随意图返回、不同平台互不串。

---

# v0.6（2026-11-13）可判定

把「像人」从形容词变成可执行断言。

| 项 | 内容 |
| --- | --- |
| 观测 | `events` 新增 `landing_px` / `move_points` / `travel_px`；老库自动 `ALTER` 迁移 |
| 落点 | 由「先抖动再回到几何中心」改为元素内非中心采样；元素过小（<10px）回退中心并记为 0 |
| 阈值 | `profiles/thresholds.json` 冻结，**工程值，未校准**；门禁只读它 |
| 门禁 | `tools/verify-human.mjs` 六条断言 + 基线对照，失败退出码 1 |
| 经验 | `site_notes.scope`（site/global）；`tools/site.mjs promote` 按机械规则晋升 |
| 迭代 | `iterations` 表 + `tools/iterate.mjs record/list/show/decide` |
| 清理 | 删除从未写入的 `rounds` 表；timeline 只记 pathname，不再写完整 URL |

实测：

| 项 | 结果 |
| --- | --- |
| 单测 | 37/37 通过（新增 12 条：定位符、落点、观测、断言、对照、经验归一与晋升、迁移、迭代、门禁 CLI） |
| 合成回放样例门禁 | 6/6 通过，落点中位偏移 10.5px。**事件流是造的，用于验证机制，未在真站复测** |
| 历史 run 门禁 | 3/6：「落点」「落点中位」「移动采样点」失败，因老数据没有观测列 |
| 迁移 | 旧库（无 scope / 无 landing_px / 有 rounds）打开后补列、删 rounds，事件可回读 |
| 未实现 | 会话形状、配额两段式、哨兵改造；见 docs/architecture.md 缺口清单 |

---

# v0.7（2026-11-13）会话与分布

把 architecture.md 里审计出的六处缺口补完。全部是本地可复跑的测试，**没有真站复测**。

| 项 | 内容 |
| --- | --- |
| 分层 | `human.mjs` 729 → 254 行；拆出 browser / page-fns / locator / actions / recipes / session；四个依赖可注入 |
| 会话 | `lib/session.mjs`：dwell、单次时长、日总量、休息、工作时段、读写配比；`requireDetailAfter` 从死配置变闸门规则 |
| 哨兵 | 去掉全局对象、原型 setter、fetch/XHR 包装；随机名事件读回；静默写改「信任时间戳 + 值比对」 |
| 配额 | 预留-确认两段式，失败路径 `budgetRelease`；顺手修掉令牌桶 state 未写回（限速此前实际没生效） |
| 时序 | `lib/timing.mjs` 对数正态 + AR(1)；全链路走注入的 timing |
| 观测 | `events.meta` 存间隔序列；`observe` 出中位 CV |
| 门禁 | 6 条 → 11 条：加步长 CV、按键 CV、首动作 dwell、会话时长、日总量 |
| 小修 | `waitFor` 支持 role、插值严格模式（缺参抛 `missing-param`）、`limit_n` 冲突更新、lint 进测试 |

实测：

| 项 | 结果 |
| --- | --- |
| 单测 | 81/81 通过（v0.6 的 37 条 + 新增 44 条） |
| 新增覆盖 | 动作层 11 条、适配层 4 条、会话层 9 条、哨兵 5 条、时序 7 条、端到端 1 条、其余 5 条 |
| 断言数 | `verify-human` 11 条；缺数据（没有落点序列/没有起止时间）一律判 FAIL，不给「没观测=合格」 |
| 端到端 | 假浏览器跑完一次会话 → `flush` → 真门禁判 11/11，证明库自己产出的 run 能过自己的门禁 |
| 合成回放样例 | 11/11 通过；**事件流是造的，仅验证机制** |
| 历史 run | 仍会 FAIL：老数据没有 `meta` 与 `meta` 序列，追认不了 |
| 令牌桶 | 修复后 `rate.perMinute` 才真正生效；此前 `take()` 的 state 没有写回，限速形同虚设 |
| 未验证 | 真站节奏、真人样本校准、多进程并发配额；见 docs/architecture.md §4 |

### 真站复测（2026-11-13，h.liepin.com）

v0.7 的改动此前只在合成事件流与假浏览器上验过，这一步拿真站跑一轮。

流程：`create()` → 落地先看 → 读 2s → 聚焦关键词框 → 清空 → 中文输入「供应链总监」→
Enter 成 chip → 点「搜 索」→ 读 6s。
环境：ego lite 0.6.3.12 / 真 Chromium / 已登录账号 / Windows。

| 项 | 真站实测 |
| --- | --- |
| 门禁 | **11/11**（`run-mwetm4mp-1wra`） |
| 非信任输入 / 静默写 | 0 / 0；哨兵只装监听，页面内没有全局对象 |
| 落点 | 3 次点击，偏移 9.3 / 5.4 / 5.8px，居中率 0% |
| 移动 | 45 / 64 / 53 个采样点，路径 1144 / 1361 / 794px，步长间隔 CV 0.241 |
| 按键 | 3 次输入法上屏，间隔 898 / 518 / 636ms，CV 0.232 |
| 读写比 | 4 读 / 4 写 = 100% |
| 会话 | 首动作前停留 4633ms，时长 4min，当日 109 个动作 |
| 结果 | 关键词 chip 生成，候选人列表正常渲染 |

复测抓到两个只有真站才暴露的问题（已修）：

1. `page.evaluate(fn, undefined)` 被 ego-lite 拒绝（`argument must be JSON-serializable`）。
   适配层此前总是传两个实参，而 `create()` 第一步就读体检，于是**真站上根本起不来**。
   现在无参数时只传一个实参，并有单测盯着实参个数。
2. 中文整段一次 `insertText`：5 个字只产生 1 个 input 事件。真人用输入法按词上屏，
   通常 2–3 次 commit；改成 ≤2 字一组。改之前那轮真站门禁的 `type-cv` 是 n/a（样本不足）。

这次是 **1 次复测**，不是统计结论。跨站点、跨意图、跨时段仍需多跑。

---

# 复跑命令

```bash
node --test "<SKILL_DIR>/tests/*.test.mjs"
node tools/lint-script.mjs examples/timeline.mjs
node tools/verify-human.mjs
node tools/verify-human.mjs --baseline <runId>
node tools/recipe.mjs list --host liepin.com
node tools/site.mjs list --platform liepin.com --intent search
node tools/site.mjs promote
node tools/iterate.mjs list --site liepin.com
node tools/export.mjs --out ./out
```
