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

// 本地页面（data: / about: / file: / blob:）没有主机名，按 "local" 归并：
// 它们不联网、没有站点可冒犯，用于离线演示与自测；host-drift 只对网络页面成立。
const LOCAL_SCHEME = /^(data|about|file|blob):/i;

export function parseUrl(url) {
  const raw = String(url);
  if (LOCAL_SCHEME.test(raw)) {
    if (/^(data|about):/i.test(raw)) return { host: "local", path: "/", search: "" };
    try {
      const parsed = new URL(raw);
      return { host: "local", path: parsed.pathname || "/", search: parsed.search };
    } catch {
      return { host: "local", path: "/", search: "" };
    }
  }
  try {
    const parsed = new URL(raw);
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

  const rec = { untrusted: 0, silentWrite: 0, mutations: 0, lastTrusted: -1e9, muteUntil: -1e9, seen: new Map() };
  const valueOf = (el) => String(el && el.value !== undefined ? el.value : (el && el.textContent) || "").slice(0, 200);

  const scan = () => {
    if (!document.body) return;
    const nodes = document.querySelectorAll("input,textarea,select,[contenteditable=true]");
    const next = new Map();
    const muted = performance.now() < rec.muteUntil;
    const quiet = !muted && performance.now() - rec.lastTrusted > 200;
    for (let i = 0; i < nodes.length && i < 80; i += 1) {
      const el = nodes[i];
      const current = valueOf(el);
      const before = rec.seen.get(el);
      if (quiet && before !== undefined && before !== current) rec.silentWrite += 1;
      next.set(el, current);
    }
    rec.seen = next;
  };

  const bump = (list) => {
    rec.mutations += list.length;
  };
  const observer = (() => {
    try {
      return new MutationObserver(bump);
    } catch {
      return null;
    }
  })();
  const watch = { childList: true, attributes: true, characterData: true, subtree: true };
  // 同源 iframe 是独立 document，顶层观察器看不到它的变化。把观察器挂到每个
  // 能读到的 frame 上；frame 可能在装完之后才加载，所以每次读哨兵时补挂一次。
  const attachFrames = () => {
    if (!observer) return;
    for (const frame of document.querySelectorAll("iframe,frame")) {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.documentElement) observer.observe(doc.documentElement, watch);
      } catch {
        /* 跨源 frame 读不到，跳过 */
      }
    }
  };
  try {
    if (observer) observer.observe(document.documentElement, watch);
    attachFrames();
  } catch {
    /* 观察失败：计数停在 0，不假装有数据 */
  }

  for (const type of ["pointerdown", "mousedown", "keydown", "input", "change"]) {
    addEventListener(type, (event) => {
      if (!event.isTrusted) {
        // 系统车道（原生 select / 文件上传 / 粘贴）由浏览器自己发这些事件，不是旁路输入。
        // 库在动之前会通过 h.system() 声明一段静默窗口，窗口内的非信任事件不计。
        if (performance.now() < rec.muteUntil) {
          const el = event.target;
          if (el && el.nodeType === 1) rec.seen.set(el, valueOf(el));
          return;
        }
        rec.untrusted += 1;
        return;
      }
      rec.lastTrusted = performance.now();
      const el = event.target;
      if (el && el.nodeType === 1) rec.seen.set(el, valueOf(el));
    }, true);
  }

  addEventListener(channel, (event) => {
    if (event.detail && event.detail.mute) {
      rec.muteUntil = performance.now() + Number(event.detail.ms || 2000);
      return;
    }
    scan();
    attachFrames();
    if (!event.detail) return;
    event.detail.out = {
      untrusted: rec.untrusted,
      silentWrite: rec.silentWrite,
      mutations: rec.mutations,
      lastTrustedAgo: Math.round(performance.now() - rec.lastTrusted),
    };
  }, true);
};

// 让哨兵在一段时间内把「非信任 input/change」当作系统车道操作，而不是旁路写入。
export const PROBE_MUTE_FN = ({ channel, ms }) => {
  dispatchEvent(new CustomEvent(channel, { detail: { mute: true, ms } }));
  return true;
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
