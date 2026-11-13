---
name: ego-browser
description: 兼容入口 —— 浏览器操作的正文已并入 ego-human-input。需要打开网页、点击、填表、登录、抓数据、做 web app 测试时，加载 ego-human-input，不要在本文件里找指南。
metadata:
  version: "0.8.0"
  date: "2026-11-13"
  bootstrap: "true"
---

# ego-browser（兼容入口）

真正的技能是 **ego-human-input**。加载它。

它包含本技能原来的调用契约（空间与轮次、观察、系统级操作），
以及一层拟人输入（轨迹、节奏、配额、停手与交权）。

## 只留三件事

1. 指南由二进制打印，不在文件里：先跑 `ego-browser skill`，读它输出的全部内容。
   结尾应有 `[ego-browser:skill] end of guide` 这一行；缺了就是被截断，重定向到文件再分段读。
2. 安装、升级、清 cookie/缓存：看
   `~/.local/share/ego/ego-skills/references/`（稳定链接，永远指向当前 active 版本）。
   本文件是 `~/.agents/skills/ego-browser` 的链接目标，由 ego-human-input 仓库维护；
   ego lite 升级不会覆盖它，但也不会更新它。
3. 两者冲突时以 ego-human-input 的 `references/bridge.md` 为准。
