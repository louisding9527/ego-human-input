# 实施计划：ego-human-input 护栏与预警 v0.2

## 顺序与状态

| 层 | 内容 | 状态 |
| --- | --- | --- |
| L0 | SQLite 日志（store.mjs）、事件与告警落库 | 完成 |
| L1 | 禁令 lint（tools/lint-script.mjs）+ 页面哨兵（guard.PROBE_FN） | 完成 |
| L2 | 硬刹车：URL 分类、挑战页、域漂移、登录页 | 完成 |
| L3 | 异常目录 S1–S4、S6、S9、S12、S13、S16–S18 | 完成 |
| L4 | 分型配额（budget）+ 轮内间隔 | 完成 |
| L5 | 预警状态机（alert.mjs）+ 裁决 CLI（tools/alert.mjs） | 完成 |

L3 未覆盖 S7（由 S2 覆盖）、S11/S15（需 Network 域，与 ego 事件缓冲冲突）、S14（业务层职责）。

## 改动文件

- 新增：`lib/store.mjs`、`lib/score.mjs`、`lib/guard.mjs`、`lib/alert.mjs`、`lib/errors.mjs`、`tools/lint-script.mjs`、`tools/alert.mjs`、`references/guard.md`、`tests/guard.test.mjs`
- 改写：`lib/human.mjs`（接入 store、machine、哨兵、配额、search、inspect、goto）
- 改数据：`profiles/base.json` 增 `budget` / `search` / `alert`
- 文档：`SKILL.md`、`references/profiles.md`、`README.md`、`validation.md`

## 验证命令

```bash
node --test "tests/*.test.mjs"
node tools/lint-script.mjs examples/timeline.mjs
ego-browser nodejs -e "await import('file:///<SKILL_DIR>/examples/timeline.mjs')"
node tools/alert.mjs list
```

## 验收结果

- 单测 23/23。
- 注入 `#captcha` → `HumanBlocked`，alerts 落库，状态 escalated。
- `decide abort` 后跨进程冷却生效，120 分钟内 `click` 抛 `HumanWarn`。
- 点击无响应记 `s4-noop`，同目标第 2 次熔断。
- lint 正例通过、六条反例全中。

## 回滚

全部为新增文件与向后兼容的字段扩展。回滚 = 恢复 `lib/human.mjs` 到 0.1 版本并删除新增模块；`human.db` 可直接删。

## 遗留

- 真实站点未验证（有意）。
- `silentWrite` 有框架误伤，权重已压低。
- S11/S15 需要另找网络侧信号来源，暂缺。
