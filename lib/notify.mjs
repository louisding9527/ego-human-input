// 停手通知：把「现在需要你接管」变成一次能打扰到人的信号。
// 只用浏览器通知一条通道：一份代码同时覆盖 Windows 和 macOS，零依赖、零密钥。
// 硬约束（2026-11-13 实测）：需要安全上下文（https / localhost）、需要页面活着、
// 且 Notification.permission 必须已 granted —— 授权只能由人点一次，脚本无法代劳。
import { HumanWarn } from "./errors.mjs";

export const CHANNELS = ["browser", "none"];

// 每类停顿都要说清「你该做什么」，否则通知只是噪音。
export const BLOCK_HINTS = {
  challenge: "在浏览器里完成人机验证，然后告诉我",
  "challenge-host": "页面被带到挑战域名，处理完告诉我",
  "challenge-path": "页面被带到挑战路径，处理完告诉我",
  "login-required": "登录后告诉我",
  host_drift: "页面跳到了别的域名，确认是否继续",
  untrusted_input: "检测到非真人输入，检查是不是有别的脚本在操作这个页面",
  budget: "小时配额用完，等下一小时或换站点",
  "soft_toast": "站点给了软提示，先停一会儿再决定",
  "session-long": "这一次坐得太久，休息后再开新的一次",
  "daily-quota": "今天的量到了，明天再来",
  "search-no-detail": "连续搜索没开详情，先打开一个详情页",
  "s4-noop-repeat": "同一处点了两次没反应，看看页面是不是变了",
  cooldown: "处在冷却期，到点再继续",
  frozen: "已经冻结，先看日志再看要不要继续",
};

export function buildMessage({ site = "", path = "", trigger = "", runId = "", extra = "" } = {}) {
  const hint = BLOCK_HINTS[trigger] || "停手了，看看发生了什么";
  const where = `${site}${path}`.replace(/\/+$/, "") || site || "unknown";
  return {
    title: `需要你接管：${trigger || "blocked"}`,
    body: `${where}　${hint}${extra ? `　${extra}` : ""}（run ${runId || "-"}）`,
    tag: `ego-human-input-${runId || "run"}`,
  };
}

export function createNotifier({ browser = null, config = {} } = {}) {
  const channel = CHANNELS.includes(config.channel) ? config.channel : "browser";
  const state = { channel, sent: 0, failed: 0, lastReason: "" };

  async function send(message) {
    if (!message || typeof message.title !== "string") throw new HumanWarn({ trigger: "notify-bad-message" });
    if (channel === "none") return { ok: false, reason: "disabled" };
    if (!browser?.notify) return { ok: false, reason: "no-browser" };

    let permission = "unknown";
    try {
      permission = await browser.notifyPermission();
    } catch {
      permission = "unknown";
    }
    if (permission !== "granted") {
      state.failed += 1;
      state.lastReason = `permission:${permission}`;
      return { ok: false, reason: state.lastReason };
    }
    try {
      const result = await browser.notify(message);
      if (result === "sent") {
        state.sent += 1;
        state.lastReason = "";
        return { ok: true, reason: "sent" };
      }
      state.failed += 1;
      state.lastReason = `send:${result}`;
      return { ok: false, reason: state.lastReason };
    } catch (error) {
      state.failed += 1;
      state.lastReason = `error:${String(error?.message || error).slice(0, 80)}`;
      return { ok: false, reason: state.lastReason };
    }
  }

  return { channel, send, status: () => ({ ...state, permission: null }) };
}
