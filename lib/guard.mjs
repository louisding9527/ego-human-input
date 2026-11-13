import { createHash } from "node:crypto";

const CHALLENGE_HOST = /^safe\./i;
const CHALLENGE_PATH = /(captcha|intercept|blankpage|verify|challenge|antibot|risk|blocked)/i;
const API_PATH = /(\/api\/|\/ajax\/|\/json\/|getconditionitem|getcondition|querylist|searchlist|listquery)/i;
const LOGIN_PATH = /(login|signin|passport)/i;

export function shortHash(value, len = 8) {
  return createHash("sha1").update(String(value ?? ""), "utf8").digest("hex").slice(0, len);
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

export const PROBE_FN = () => {
  if (window.__hi) return;
  const rec = {
    untrusted: 0,
    silentWrite: 0,
    orphanRequest: 0,
    mutations: 0,
    lastTrustedInput: -1e9,
    installed: true,
  };
  window.__hi = rec;
  const stamp = () => {
    rec.lastTrustedInput = performance.now();
  };
  try {
    new MutationObserver((list) => {
      rec.mutations += list.length;
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* observe failed: keep counting disabled */
  }
  for (const type of ["pointerdown", "mousedown", "keydown", "input"]) {
    addEventListener(type, (event) => {
      if (!event.isTrusted) rec.untrusted += 1;
      else stamp();
    }, true);
  }
  const silent = () => {
    if (performance.now() - rec.lastTrustedInput > 200) rec.silentWrite += 1;
  };
  for (const proto of [window.HTMLInputElement, window.HTMLTextAreaElement, window.HTMLSelectElement]) {
    if (!proto) continue;
    const desc = Object.getOwnPropertyDescriptor(proto.prototype, "value");
    if (!desc || !desc.set) continue;
    Object.defineProperty(proto.prototype, "value", {
      configurable: true,
      get: desc.get,
      set(value) {
        silent();
        return desc.set.call(this, value);
      },
    });
  }
  const checkOrphan = () => {
    if (performance.now() - rec.lastTrustedInput > 2000) rec.orphanRequest += 1;
  };
  if (window.fetch) {
    const original = window.fetch;
    window.fetch = function patched(...args) {
      checkOrphan();
      return original.apply(this, args);
    };
  }
  if (window.XMLHttpRequest) {
    const send = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function patched(...args) {
      checkOrphan();
      return send.apply(this, args);
    };
  }
};

export const SENTINEL_FN = () => (window.__hi ? {
  untrusted: window.__hi.untrusted,
  silentWrite: window.__hi.silentWrite,
  orphanRequest: window.__hi.orphanRequest,
  mutations: window.__hi.mutations,
} : null);

export const SOFT_TOAST_FN = () => {
  const nodes = [...document.querySelectorAll("[class*=toast],[class*=message],[class*=notice],[role=alert]")];
  const text = nodes.map((n) => (n.innerText || "").trim()).filter(Boolean).join(" ").slice(0, 200);
  return /频繁|稍后|异常|限制|too many|rate limit/i.test(text) ? text : null;
};
