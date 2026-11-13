# 设计：ego-human-input skill

## 1. 交付形态

用户级 skill 目录，与本机 ego-browser skill 同级：

```
~/.agents/skills/ego-human-input/
  SKILL.md                 # 触发与使用说明（AI 读）
  lib/human.mjs            # 运行时库（业务脚本 import）
  lib/profile.mjs          # 站点识别 + 档案合并
  profiles/base.json       # 模板默认值
  profiles/sites.json      # 六站条目
  examples/timeline.mjs    # 可跑通的示例（验收 A9）
  references/profiles.md   # 调参说明（用户读）
```

运行时状态不放 skill 目录，避免升级覆盖：

```
~/.ego-human-input/
  state.json               # 跨轮限速状态
  timeline-YYYYMMDD.jsonl  # 动作时间线
```

不放 ego-browser skill 目录的原因：该目录由 `ego-browser upgrade` 管理，升级会覆盖。

## 2. 调用契约

业务脚本不直接调 `page.mouse`。改为拿一个 human 句柄：

```js
const { human } = await import('file:///<SKILL_DIR>/lib/human.mjs');

const h = await human.create(page);            // 自动识别站点
console.log(h.site());                          // { host, siteKey, profile, effective }

await h.click("loc=role:button[name='登录']");
await h.type("周杰伦");
await h.read(2);                                // 2 秒级停顿 + 滚轮
await h.scroll(1);
await h.gate();                                 // 显式节流（也可由 click/type 内部自动调用）
await h.flush();                                // 落盘时间线与限速状态
```

`human.create` 也可以接受覆盖：`human.create(page, { profile: "strict" })`。

每个方法返回 receipt 对象（动作名、耗时、降级标记），便于业务脚本断言。

## 3. 站点识别

**主匹配**：`page.url()` 取 hostname，小写、去 `www.`，按内置站点表的后缀匹配。匹配规则用「域名后缀相等」而不是 `includes`，防止 `evil-liepin.com` 命中。

**未命中**：用 `base.json` 的 `unknown` 档。该档频率取低值、停顿取高值，不抛错。

**二级探测（只降不升）**：`page.evaluate` 检查挑战页特征：

- `window._cf_chl_opt` 存在，或 `/cdn-cgi/challenge-platform/` 脚本存在
- `document.querySelector('#challenge-form, #captcha, .geetest_panel')` 命中
- 响应头 `cf-ray`（走 `page.cdp("Network.responseReceived")` 缓存，不可用时跳过）

命中任一，把有效档位降一级（`balanced → strict`），并在 receipt 里标 `degraded: "challenge-detected"`。检测不到就不升降。

**合并顺序**：`base.json` → `sites.json[siteKey]` → `~/.ego-human-input/overrides.json` → 调用参数。后层覆盖前层，逐字段深合并。

## 4. 参数结构

```json
{
  "rate":     { "perMinute": 18, "burst": 2, "minGapMs": [800, 2400] },
  "mouse":    { "trajectory": ["bezier", "jitter", "overshoot"], "samples": [12, 26],
                "stepMs": [6, 16], "landingJitterPx": 3, "clickDelayMs": [40, 90] },
  "keyboard": { "charMs": [55, 150], "spaceMs": [90, 220],
                "cjkGroupMs": [300, 1200], "typoEveryGroups": 2, "typoRate": 0.02 },
  "scroll":   { "deltaPx": [120, 400], "segments": [2, 5], "segmentMs": [80, 300] },
  "pause":    { "readMs": [5000, 8000], "leadInMs": [500, 1500], "scrollTimes": [1, 2] },
  "guards":   { "detectChallenge": true, "maxActionsPerPage": 60 }
}
```

所有区间是 `[min, max]`，取值用均匀分布。不做正态分布：参数少时均匀更容易理解和调。

`sites.json` 里每站初始只有 `{ "rate": {}, "pause": {} }` 这样的空覆盖，等价于模板。用户按需填。

## 5. 坐标解析（本设计的核心难点）

ego 的 `page.click(selector)` 走原生输入但不接受绝对坐标；`snapshot` 有 `loc=` 但没有坐标。所以拟人轨迹需要一条 ref → rect 的链路。

`h.rect(locator)` 的策略，按顺序尝试：

1. `css:` / `href:` 前缀：转成可执行选择器，`page.evaluate` 求 `getBoundingClientRect()`。
2. `loc=role:NAME[name='TEXT']`：转成 `page.evaluate` 里的「按 role 映射到标签 + 文本匹配」扫描。只覆盖 button / link / textbox / checkbox 等常见 role。
3. 业务脚本直接传 `{ selector }` 或 `{ x, y }`：跳过解析。
4. 以上都失败：返回 `null`。

`null` 时降级为 `page.click(locator, { delay })`：有原生跳变，但没有轨迹。receipt 标 `degraded: "no-coords"`。降级不能抛错，否则业务脚本在非常规页面上直接失败。

**视口外**：rect 落在视口外或 `y < 0` 时，先 `page.evaluate(el.scrollIntoView({block:'center'}))`，重新求 rect，再走轨迹。

**已接受的限制**：中文 role 名、复杂 aria 结构、跨 iframe 的 ref 解析成功率不高，降级路径是常态而非异常。文档要写明这点。

## 6. 轨迹算法

三种族，按权重随机选（0.5 / 0.3 / 0.2）：

| 族 | 做法 | 拟真点 |
| --- | --- | --- |
| bezier | 三次贝塞尔，两个控制点在 AB 垂直方向各偏移 ±15% 距离 | 人手弧线 |
| jitter | 线性插值 + 垂直噪声，幅度按 `sin(πt)` 中间大两端小 | 轻微手抖 |
| overshoot | 先到目标外 8~20px，再回拉 | 瞄准过冲 |

采样点数 `n = clamp(round(dist / 12), 10, 28)`。每点之间**真实 `await sleep()`**，基础 6~16ms；首尾 15% 区间乘 2（加减速）。

**必须显式说明的坑**：`mouse.move(x, y, { steps })` 的 `steps` 在一次 CDP 调用内插值，事件时间戳几乎相同。用它做拟人等于没做。只能多次调用 `move`。

鼠标位置是 TaskSpace 级共享的，模块内维护单一 `cur`，不按 Page 分开。

## 7. 键盘

**分流**：文本含 CJK（`/[\u4e00-\u9fff]/`）走中文分支，否则拉丁分支。混合文本按段切分。

**拉丁**：逐字符 `keyboard.type(ch)`，字符间 55~150ms，空格后 90~220ms。

**中文**：没有逐键按键事件，`keyboard.type` 对中文只能合成。按标点与空格切词组，`keyboard.insertText(词组)`，词组间 300~1200ms。模拟的是「输入法整段上屏」的节奏，不是拼音逐键。

**误输入**：每 2 组后，按 `typoRate` 打错一个字符，停 80~180ms，`Backspace`，再继续。中文分支改为「删掉一个词组重打」，因为中文没有单字符退格语义。

**禁用**：`keyboard.paste()` 是瞬时行为，任何拟人场景都不用它。

## 8. 停顿与滚轮组合

`h.read(seconds)`：

1. 等 `leadInMs`（500~1500ms），模拟"看完当前屏"。
2. 滚 `scrollTimes`（1~2）次，每次 `segments`（2~5）段，每段 delta 120~400，段间 80~300ms。滚轮位置先移到页面中部，避免在边栏上滚。
3. 等剩余时间。
4. 全程不需要真实 sleep 精确到毫秒，误差 ±10% 可接受。

## 9. 节流与跨轮状态

令牌桶：容量 `burst`，按 `perMinute` 回填。每次 `click` / `type` / `read` 前隐式 `gate()`。

跨轮问题：每轮脚本是独立进程，内存态丢失，连续多轮会叠加超速。做法是启动时读 `~/.ego-human-input/state.json`，结束前写回 `{ host, tokens, lastRefill }`。

并发多脚本写同一个文件会互相覆盖。MVP 接受近似，不做文件锁；文档写明「同时跑两个脚本时限速不精确」。

## 10. 停机与异常

- 探测到挑战页：走 R7 交接流程 —— 停止拟人、写现场到时间线、`task.handOff()`、输出说明。不抛裸错，不重试绕行。
- `task.handOff()` 之后：句柄进入 frozen，任何方法抛错。
- 单页动作数超过 `maxActionsPerPage`：提示可能陷入循环，不自动继续。
- 页面跳转导致 rect 失效：`h.click` 前每次都重新求 rect，不复用缓存。

## 10.1 开工体检

`human.create()` 里跑一次 `page.evaluate` 取 `webdriver / ua / webglRenderer / tz`，加上 `profiles()` 的 profile 名，组成体检对象。

判定规则：`webdriver === true` 或 UA 含 `Headless` 时返回 `warnings` 数组，不阻断。调用方 `console.log(h.health)` 就能看到。不做自动修正 —— ego 的启动方式不归 skill 管。

## 10.2 环境体检的意义

真机真浏览器已解决指纹层（`webdriver=false`、真 GPU、真时区已实测）。剩下的失败模式是「连错 profile、用错端口、跑在另一个 ego 实例上」。这类错误比被检测更常见，体检就是为它做的。

## 11. 技术未知（实现阶段先验证）

1. 单轮脚本能否容纳 3 次 5~8 秒停顿而不被框架超时打断。验证方式：跑一个 30 秒脚本，看是否正常返回。
2. `page.evaluate` 在部分站点是否被 CSP 或跨域 iframe 挡住，导致求 rect 失败率过高。
3. `page.cdp("Network.responseReceived")` 能否拿到响应头；拿不到就只靠页面特征探测。

这三条都不改变架构，只影响降级路径的比例。

## 12. 回滚

纯新增目录，不修改 ego-browser skill、不改业务代码。回滚 = 删 `~/.agents/skills/ego-human-input/` 与 `~/.ego-human-input/`。
