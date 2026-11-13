# 档案与调参

## 三层覆盖

参数最终值 = `base.json` 的档位默认 → `sites.json[站点]` 的 `overrides` → `~/.ego-human-input/overrides.json` 的 `sites[站点]`（最后一层优先）。

`~/.ego-human-input/overrides.json` 是本地覆盖，不需要重装 skill。格式：

```json
{
  "sites": {
    "liepin.com": { "rate": { "perMinute": 8 }, "pause": { "readMs": [9000, 14000] } },
    "*": { "keyboard": { "typoRate": 0.5 } }
  }
}
```

`"*"` 对所有站点生效，优先级低于具体站点。

## 站点识别

取页面 hostname，小写、去 `www.`，按域名标签边界做后缀匹配。`m.liepin.com` 命中 `liepin.com`；`evil-liepin.com` 不命中。

未命中任何站点时用 `base.json` 的 `unknown` 档，默认 `strict`。不会报错。

## 档位

三档：`strict`、`balanced`（默认）、`fast`。差异只在数值，维度结构相同。

- `strict`：每分钟 10 次动作，停顿 7~11 秒。
- `balanced`：每分钟 18 次，停顿 5~8 秒。
- `fast`：每分钟 30 次，停顿 3~5 秒。

临时换档不改文件：`human.create(page, { profile: "strict" })`。
临时改频率：`human.create(page, { perMinute: 6 })`。

## 字段

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| `rate.perMinute` | 每分钟动作数上限 | 令牌桶速率 |
| `rate.burst` | 允许的突发次数 | 默认 2 |
| `rate.minGapMs` | 两个动作之间的最小间隔 | `[min, max]`，每段重新取随机 |
| `mouse.trajectory` | 轨迹族候选 | `bezier` / `jitter` / `overshoot`，每次随机挑一个 |
| `mouse.samples` | 中间采样点数 | 会被夹到 10~28 |
| `mouse.stepMs` | 每个采样点之间的等待 | 太大会明显变慢 |
| `mouse.landingJitterPx` | 落点抖动像素 | 先落到附近再校正 |
| `mouse.clickDelayMs` | 按下到抬起的时长 | 越小越机械 |
| `mouse.hoverMs` | 点击前悬停 | 模拟确认目标 |
| `keyboard.charMs` | 拉丁字符间间隔 | |
| `keyboard.spaceMs` | 空格后间隔 | 词间停顿 |
| `keyboard.cjkGroupMs` | 中文词组间间隔 | 300~1200 是默认区间 |
| `keyboard.typoEveryGroups` | 每几组后插入一次误输入 | `0` 为关闭 |
| `keyboard.typoRate` | 到点时真的错的概率 | 默认 1，即必定错一次 |
| `scroll.deltaPx` | 单次滚轮位移 | 分段滚，不是一次滚完 |
| `scroll.segments` | 一次滚动的段数 | |
| `scroll.segmentMs` | 段间间隔 | |
| `pause.readMs` | 停留时长 | 用户要求 5~8 秒 |
| `pause.leadInMs` | 进入停顿时先静默多久 | 模拟"先看一眼" |
| `pause.scrollTimes` | 停顿中滚几次 | |
| `guards.detectChallenge` | 是否检测挑战页 | 默认开 |
| `guards.maxActionsPerPage` | 单页动作数上限 | 超了只记录，不阻断 |

## 关掉某一维

```js
const h = await human.create(page, { off: ["mouse"] });
```

可取 `mouse`、`keyboard`、`scroll`、`pause`、`rate`。关闭后该维度退化为原始的 ego 行为，其余维度不受影响。用于排查"到底哪一层在起作用"。

## 改完怎么验证

跑一次动作，看 `~/.ego-human-input/timeline-YYYYMMDD.jsonl`：

- `read` 条目的 `total` 是否落在你的区间。
- `scroll` 条目的 `segments` 是否符合预期。
- `type` 条目的 `ops` 数量是否合理（中文按词组算，不是按字）。
- `click` 条目的 `degraded` 是否为 `no-coords`。占比高说明该站的选择器解析不出来，改用 `{x, y}` 坐标或 `css=` 选择器。

更细的事件统计用 `examples/timeline.mjs`，它在页面内装了监听器，能打印 mousemove 数量、最小间隔、不同间隔个数、滚轮次数与 delta 去重值。

## 0.2 新增字段

### `budget`

按动作类型分小时配额与最小间隔。

```json
"budget": {
  "search": { "perHour": 6, "gap": [45000, 120000] },
  "detail": { "perHour": 8, "gap": [30000, 60000] },
  "write":  { "perHour": 10, "gap": [15000, 40000] },
  "nav":    { "perHour": 20, "gap": [8000, 25000] }
}
```

配额按「小时 + 域名 + 类型」记在 sqlite，跨进程累计。`gap` 是同类动作的最小间隔，覆盖原来的全局 `rate.minGapMs`。

### `search`

```json
"search": { "maxConsecutive": 3, "nearDupDistance": 2, "requireDetailAfter": 3 }
```

- `maxConsecutive`：连续搜索多少次后必须开详情或长读。
- `nearDupDistance`：关键词编辑距离小于该值视为同一词变体。
- `requireDetailAfter`：与 `maxConsecutive` 配对使用。

### `alert`

```json
"alert": { "windowMs": 1800000, "reviewTimeoutMs": 1800000 }
```

- `windowMs`：评分回看窗口。
- `reviewTimeoutMs`：无裁决时按规则结论兜底的等待时长。

## 不要做的事

- 不要为了"更像人"把 `samples` 调到 28 以上或 `stepMs` 调到 50 以上。一次移动会变成数秒，业务跑不动，而且长时间匀速微移本身也不像人。
- 不要把 `minGapMs` 设成固定值。所有区间都是随机取值，写死等于制造规律。
- 不要靠切 profile 或换账号来"降低风险"。本 skill 保护的是真实登录态，换号是相反方向。
