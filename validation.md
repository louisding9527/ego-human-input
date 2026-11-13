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

### 停手通知的实测（2026-11-13）

| 事实 | 结果 |
| --- | --- |
| `Notification` 可用性 | ego-lite 页面里存在，`isSecureContext=true`，初始 `permission=default` |
| 触发授权 | 真实鼠标点击按钮后 `requestPermission()` 生效，Chrome 原生气泡弹出 |
| ego-lite 的反应 | **主动停下脚本**并报 `A browser permission prompt for notifications has appeared`，空间转为 `agentDelegatedToUser` |
| 引导工具 | `tools/notify-setup.mjs` 两步：先弹气泡，用户点「允许」，再 `--check` 验证并试发 |
| 未授权时 | 时间线记 `notify {ok:false, reason:"permission:default"}`，门禁不受影响 |
| 端到端 | 真站触发 `challenge-host` 熔断 → `notify {ok:true, reason:"sent"}`，系统通知真的弹出 |
| 残留浮层 | 首次引导失败后浮层留在页面上：脚本被 ego-lite 杀掉，没人收尾 → 已改成自愈：45 秒自动移除、权限变化 1.5 秒后移除、右上角 × 可手动关 |

结论：**通知链路可用，但授权必须是人点的那一下**。ego-lite 会在那一刻收走控制权，
所以“一键完成授权”不成立，工具只能做成“弹出来 → 你点 → 再验证”。

---

# v0.8（2026-11-13）合并 ego-browser

方向：ego-browser 的技能正文并入本项目，本项目成为浏览器任务的默认入口。
ego-browser 的指南仍由 `ego-browser skill` 打印（v2.2.1），所以只合并**稳定契约**：
车道划分、轮次收尾、升级守卫。裁决写在 [references/bridge.md](references/bridge.md)。

| 项 | 结果 |
| --- | --- |
| 单测 | **100/100** 通过（v0.7 的 88 条 + 桥接 11 条 + 门禁样本规则 1 条） |
| 车道 | lint 从「禁 `page.*` 前缀」改为「禁输入类动作」；`page.snapshot/acceptDialog/setInputFiles/selectOption/waitForEvent/keyboard.paste` 放行，`page.click/fill/mouse/keyboard.type` 仍拦；`create()` 之前的引导导航放行 |
| 收尾 | 新增 `h.finish()`（先 flush 再 `task.finish`）与 `h.handOff()`（先 flush 再 `task.handOff`），都幂等；`flush()` 幂等，连调不再二次 `endRun` / 二次 close（此前会抛 `ERR_INVALID_STATE`） |
| 所有权 | 修正映射：`user → claimTaskSpace`、`agentDelegatedToUser → takeOverTaskSpace`（旧文档三处互斥） |
| iframe | 同源 frame 递归下钻，累计偏移后按顶层视口给坐标；跨源 frame 抛 `frame-cross-origin`，不再一律 `s1-missing` |
| 视觉通道 | `h.inspect.screenshot()` + `h.click({x,y})`；坐标点击打 `direct` 标记，不参与落点断言（门禁输出里显示 `n/a（N 个坐标点击）`） |
| 门禁 | `type-cv` 改为「最长序列 ≥ 8 个间隔才断言」，样本不足记 n/a：5 个字符的 CV 落在 0.09 是常事，旧规则会误判 |
| 入口 | 两个技能共存，以本技能为准；**不改 ego-browser 目录、不镜像它的文件**（各机器路径不同，升级换目录）。路径一律由 `tools/where.mjs` 运行时解析 |
| 路径自检 | `node tools/where.mjs` 打印仓库路径、`importUrl`、ego lite 技能目录（从宿主注册的 ego-browser 链接解析）与 `egoReferences` |
| 离线闭环 | `examples/timeline.mjs` 改为 data: 页面，不联网、不跳站；`parseUrl` 把 `data/about/file/blob` 归并为 host `local` |

### 真机实测（2026-11-13，离线 data: 页面）

跑 `examples/timeline.mjs`：点按钮（改标题）→ 点输入框 → 输入 `hello world` → 阅读。

| 项 | 实测 |
| --- | --- |
| 门禁 | **11/11**（`run-mwewdumj-wh0x`） |
| 落点 | 偏移 17.2 / 12.1px，居中率 0%，中位 12.1px |
| 移动 | 142 个采样点，56 种不同间隔，最小 14ms |
| 按键 | 13 次，间隔 CV 0.219 |
| 非信任输入 | 0；滚轮 `isTrusted` 全真 |
| 收尾 | `h.finish()` 返回 `{finished:true, kept:[]}`，空间已关，无残留 |

### 实测抓到的两个真缺陷（已修）

1. **点击基线取晚了 → 成功点击被判 noop**。`actions.click` 原本在点击**之后**才取
   `mutations` 与 URL 基线，同步改 DOM 的点击（改标题、切 class）在点击返回时已经计数，
   于是第一次判 `s4-noop`、第二次同目标直接 `s4-noop-repeat` 冻结。
   修法：基线移到点击之前；另加焦点指纹（`ACTIVE_FN`），点进输入框只移焦点也算有效交互，
   否则「点输入框再打字」每次都被记成失败。
2. **`page.evaluate` 传 `undefined`** 是 v0.7 已修的项，这里复查仍成立（`browser.mjs` 单实参）。

### 已知限制（v0.8 新增）

- 跨源 iframe（登录框、验证码框、支付框）读不到 `contentDocument`，只能交给人。
  这不是缺陷，是不跨源猜坐标的取舍。
- 坐标点击不参与落点断言，纯 canvas 流程的「人味」由轨迹与间隔断言代理；
  门禁会报 `directClicks` 数量，供人工复核。
- `session-long` / `daily-quota` 是干净停，走 `h.finish()`；`handOff` 只用于挑战页与人工步骤。

### 真机走查（2026-11-13，8 个场景）

目标：把桥接契约里最容易打架的地方真跑一遍，不是纸上推演。环境：ego lite 0.6.3.12 / 指南 v2.2.1 / Windows。

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 原生 select（`page.selectOption`） | **冻结**：`untrusted_input` count=2。系统车道改值派发非信任 `input`/`change`，被哨兵当旁路输入 |
| 2 | 文件上传（`page.setInputFiles`） | 同上，同一个冻结 |
| 3 | 同源 iframe 点击 | 坐标下钻正确（`inFrame:true`），但 frame 内变更不在顶层观察器里，判定拿不到证据 |
| 4 | 跨源 iframe 点击 | 修复后抛 `frame-cross-origin`，带 `crossOrigin:1`，不冻结、不吃配额 |
| 5 | 点击后弹 `confirm` | `h.click` 抛 `PageDialogOpenedError`（ego-lite 拒绝 evaluate）；且配额槽未释放 |
| 6 | `target=_blank` 弹新标签 | `task.adopt(popup)` 报 `requires an untracked page`；popup 其实已带 label（实测 `p2`） |
| 7 | 附件下载 | `h.click` 命中链接（点击事件触发、页面不跳转），但 **ego-lite 不发 download 事件**；`page.click` 能发 |
| 8 | 跨站导航（host-drift） | 正确抛 `HumanWarn host_drift` 并冻结；空间仍归 agent，需人工收拾 |

修复（全部落地并回归）：

1. `h.select` / `h.upload` / `h.system`：动之前广播一段静默窗口，哨兵把窗口内的非信任
   `input`/`change` 当系统车道，不计入 `untrusted`/`silentWrite`。修完同一场景
   `untrusted=0, silentWrite=0`。
2. 哨兵把 MutationObserver 挂到同源 frame 的 `documentElement` 上，frame 内变更可见；
   跨源 frame 跳过。因此去掉了「按 `inFrame` 放行」的捷径，frame 内的点击按真实变化判定。
3. 点击证据收紧：焦点只有在落到**可编辑控件**时才算证据（点进 iframe 也会改顶层
   activeElement，之前会把空点击判成功）；另外标签数变化、`{ expect }`、处理过对话框都算。
4. 对话框：`h.click(target, { onDialog: "accept"|"dismiss" })`，并修掉异常路径不释放配额槽。
5. 下载：确认只有 `page.click` 路径发 download 事件，禁则里加这一条例外（`// lint-allow download`）。
6. popup：文档改为用事件返回的 `label` 继续，`adopt` 只用于 unknown 标签。

复跑（修复后）：popup `label=p2`、标题 `Example Domain`、`finish` 正常；下载
`gh_2.40.0_checksums.txt` → `saveAs` 落盘 1760 字节；iframe 同源点击五个事件齐全；
跨源报 `frame-cross-origin`；单测 104/104。

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
