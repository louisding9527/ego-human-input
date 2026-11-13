import { createHash } from "node:crypto";

const CHALLENGE_HOST = /^safe\./i;
const CHALLENGE_PATH = /(captcha|intercept|blankpage|verify|challenge|antibot|risk|blocked)/i;
const API_PATH = /(\/api\/|\/ajax\/|\/json\/|getconditionitem|getcondition|querylist|searchlist|listquery)/i;
const LOGIN_PATH = /(login|signin|passport)/i;

export function shortHash(value, len = 8) {
  return createHash("sha1").update(String(value ?? ""), "utf8").digest("hex").slice(0, len);
}

// 权限按 origin 存，所以引导工具要的是 origin，不是完整 URL。
export function toOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

export function parseUrl(url) {
  try {
    const parsed = new URL(String(url));
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname, search: parsed.search };
  } catch {
    return { host: "", path: "", search: "" };
  }
}

export function isApiEndpoint(url) {
  const { path } = parseUrl(url);
  return API_PATH.test(path);
}

export function classifyUrl(url, baseHost) {
  const { host, path, search } = parseUrl(url);
  if (!host) return { ok: false, reason: "unparsable-url", host, path };

  if (CHALLENGE_HOST.test(host)) return { ok: false, reason: "challenge-host", host, path };
  if (CHALLENGE_PATH.test(path)) return { ok: false, reason: "challenge-path", host, path };
  if (search && /backurl|redirect/i.test(search)) return { ok: false, reason: "challenge-param", host, path };
  if (baseHost && host !== baseHost && !host.endsWith(`.${baseHost}`)) {
    return { ok: false, reason: "host-drift", host, path };
  }
  if (LOGIN_PATH.test(path)) return { ok: false, reason: "login-required", host, path };
  return { ok: true, reason: null, host, path };
}

export function resultFingerprint(items) {
  return shortHash((items || []).slice(0, 12).join("|"));
}

// 页面哨兵：只装 addEventListener 与 MutationObserver，不挂全局对象、不改原型、不包 fetch。
// 状态留在安装函数的闭包里，只能通过一次自定义事件读回；随机通道名，故不可枚举。
// 静默写检测靠「信任输入时间戳 + 值变化比对」：读取时扫一遍输入控件，值变过且
// 近期没有信任输入，才算一次旁路写入。
export const PROBE_FN = ({ channel }) => {
  const probe = {};
  try {
    dispatchEvent(new CustomEvent(channel, { detail: probe }));
  } catch {
    /* 通道不可用：继续安装 */
  }
  if (probe.out) return; // 同一文档里已装过，不重复计数

  const rec = { untrusted: 0, silentWrite: 0, mutations: 0, lastTrusted: -1e9, seen: new Map() };
  const valueOf = (el) => String(el && el.value !== undefined ? el.value : (el && el.textContent) || "").slice(0, 200);

  const scan = () => {
    if (!document.body) return;
    const nodes = document.querySelectorAll("input,textarea,select,[contenteditable=true]");
    const next = new Map();
    const quiet = performance.now() - rec.lastTrusted > 200;
    for (let i = 0; i < nodes.length && i < 80; i += 1) {
      const el = nodes[i];
      const current = valueOf(el);
      const before = rec.seen.get(el);
      if (quiet && before !== undefined && before !== current) rec.silentWrite += 1;
      next.set(el, current);
    }
    rec.seen = next;
  };

  try {
    new MutationObserver((list) => {
      rec.mutations += list.length;
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* 观察失败：计数停在 0，不假装有数据 */
  }

  for (const type of ["pointerdown", "mousedown", "keydown", "input", "change"]) {
    addEventListener(type, (event) => {
      if (!event.isTrusted) {
        rec.untrusted += 1;
        return;
      }
      rec.lastTrusted = performance.now();
      const el = event.target;
      if (el && el.nodeType === 1) rec.seen.set(el, valueOf(el));
    }, true);
  }

  addEventListener(channel, (event) => {
    scan();
    if (!event.detail) return;
    event.detail.out = {
      untrusted: rec.untrusted,
      silentWrite: rec.silentWrite,
      mutations: rec.mutations,
      lastTrustedAgo: Math.round(performance.now() - rec.lastTrusted),
    };
  }, true);
};

export const SENTINEL_FN = ({ channel }) => {
  const detail = {};
  try {
    dispatchEvent(new CustomEvent(channel, { detail }));
  } catch {
    return null;
  }
  return detail.out || null;
};
