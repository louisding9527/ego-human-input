# 架构与缺口

给维护者读。讲层与层之间的契约、现在缺什么、先补什么。
设计判断与演进叙事在 [README](../README.md)，agent 用法在 [SKILL.md](../SKILL.md)，验收记录在 [validation.md](../validation.md)。

## 1. 分层

```
业务脚本 / agent
      │  只依赖 lib/human.mjs 的句柄
      ▼
┌──────────────────────────────────────────┐
│ 契约层  lib/human.mjs                     │  create() → 句柄；页面引用不外泄（写路径）
│  ├ 闸门   gate()：预警态 / 小时配额 / 间隔 │
│  ├ 动作   click / focus / type / press /  │
│  │        clearField / waitFor / read /   │
│  │        scroll / goto / move            │
│  ├ 校验   checkAfterAction()：URL 分类 /  │
│  │        挑战页 / 软提示 / 哨兵 / noop   │
│  └ 编排   配方执行、经验落库               │
└──────────────────────────────────────────┘
      │                                │
      ▼                                ▼
┌───────────────────┐        ┌──────────────────────┐
│ 纯函数层（无 I/O） │        │ 状态层               │
│ trace  轨迹         │        │ store  SQLite 读写    │
│ keyboard 键盘计划   │        │ alert  四态状态机     │
│ score  风险聚合     │        │  裁决来源 rule/agent/│
│ recipe 插值与校验   │        │  timeout             │
│ bucket 令牌桶       │        └──────────────────────┘
│ profile 站点解析    │                │
│ guard  URL 判定     │                ▼
│ notes  经验分层     │        ┌──────────────────────┐
│ observe 观测折算    │        │ 数据层               │
│ verify 断言与对照   │        │ profiles/*.json      │
└───────────────────┘        │ thresholds.json      │
                              │ ~/.ego-human-input/  │
                              │   human.db (WAL)     │
                              │   timeline-*.jsonl   │
                              └──────────────────────┘
```

依赖方向单向向下：纯函数层不得 import 状态层，状态层不得 import 契约层。
`human.mjs` 是唯一可以同时看到页面、状态与纯函数的地方。

## 2. 契约

**句柄**。业务脚本 `import lib/human.mjs` 拿到 `h`。写操作只能经 `h.*`，读操作经 `h.inspect.*`。
业务脚本确实持有 `page`（ego-lite 的 `task.page()`），但 lint 会拦住 `page.*` 的写路径。

**动作**。每个动作依次经过：闸门 → 定位 → 前置校验 → 指针/按键 → 事后校验 → 落库。
任一环节失败抛 `HumanWarn` 或 `HumanBlocked`，**不降级**。

**判定**。`tools/verify-human.mjs` 只读冻结阈值，不读运行时覆盖。
agent 可以改参数、配方、经验，不可以改阈值。

**经验**。`site_notes.scope` 取 `site | global | deprecated`。
`global` 只能由 `tools/site.mjs promote` 按机械规则写入：kind 属于 `hint|timing`、无 selector、跨 ≥2 站点各命中 ≥2 次。

**迭代**。`iterations` 一行 = 一次改动。`generation` 同一 (site, intent) 内递增。
状态 `pending | kept | reverted`，改动后必须过一次门禁才能 `kept`。

## 3. 已知缺口

按「影响判定可信度」排序。每条给出可验收的完成标准。

### P0-1 契约层未拆分，无自动化覆盖

`lib/human.mjs` 约 660 行，一个 `create()` 闭包同时承担闸门、动作、校验、编排、落库。
没有 page 适配器，行为测试无从下手，现有 37 条单测全部只覆盖纯函数层。

完成标准：`create()` 接收可注入的 page 替身；`click/type/read` 的闸门顺序、失败路径、
落库字段在无浏览器环境下有测试；`human.mjs` 降到 300 行以内。

### P0-2 会话层不存在

现在只有动作级与小时级控制。缺：落地后先看的 dwell、读写配比约束、单会话作业时长上限、
日总量配额、工作时段衰减、休息间隔。`profile.requireDetailAfter` 写在配置里但从未被消费。

完成标准：一个 run 的会话形状可被 `observe()` 算出（首动作前 dwell、会话时长、日累计动作数），
且 `verify-human` 对其有断言。`requireDetailAfter` 要么实现、要么从配置删除。

### P0-3 页面哨兵自身可被探测

`guard.mjs` 注入的 `window.__hi`、对 `HTMLInputElement.prototype.value` 的 setter 覆写、
对 `fetch`/`XHR.send` 的包装，都能被页面脚本枚举到。自审机制本身成了自动化痕迹。

完成标准：页面内只保留 `addEventListener` 与 `MutationObserver`（不可枚举）；
静默写检测改用「信任输入时间戳 + 值变化比对」，不再改原型。

### P1-1 时间分布是均匀的

`range()` 全部均匀采样。真人按键间隔近似对数正态，且相邻间隔相关。均匀分布可被时序统计识别。

完成标准：`trace.mjs` / `keyboard.mjs` 提供 `lognormal` 采样族，单测断言分位数落在目标区间，
且相邻样本相关性为正；`human.mjs` 不再直接调用 `Math.random`，统一走注入的 `rng`。

### P1-2 观测粒度只到单次动作

已记录落点偏移、移动点数、路径长度。缺速度曲线、按键间隔序列、滚动分段时长。
L2 回归只能比中位数，比不了分布形状。

完成标准：`events` 增加可选的 `meta` JSON 列，按动作类型存最小必要序列；
`verify` 能对间隔序列做分位断言。

### P1-3 配额在定位前扣除

`click()` 先 `gate()` 再定位。目标不存在时抛 `s1-missing`，配额照样消耗。

完成标准：配额改为预留-确认两段式；失败路径释放预留。单测覆盖。

### P2-1 小的不一致

- `waitFor` 只支持 `css=` / `href=`，`role=` 抛 `wait-needs-css`。
- `recipe.interpolate` 缺参数时静默替换成空串，可能把空关键词打进输入框。
- `budgetTake` 的 `limit_n` 在冲突时不更新；并发多进程仍会互相覆盖。
- `tools/lint-script.mjs` 需手工跑，未接入任何自动步骤。

## 4. 优先级

1. P0-3（哨兵可探测）——不改反而有负作用，改动小。
2. P1-3（配额两段式）——小而明确。
3. P0-1（拆分 + 适配器）——解锁后续所有行为测试。
4. P0-2（会话层）——决定「像人」能走多远。
5. P1-1 / P1-2——分布质量与观测粒度。
6. P2-1——顺手修。

## 5. 不做什么

- 不做指纹伪造：真机、真 GPU、真登录态已经一致，改反而制造矛盾。
- 不做验证码绕过：遇到挑战停手、留证据、交给人。
- 不做多账号轮换：那是绕过封禁，不是拟人。
