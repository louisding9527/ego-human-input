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

# 复跑命令

```bash
node --test "<SKILL_DIR>/tests/*.test.mjs"
node tools/lint-script.mjs examples/timeline.mjs
node tools/recipe.mjs list --host liepin.com
node tools/site.mjs list --platform liepin.com --intent search
node tools/export.mjs --out ./out
```
