// 页面内函数：这些在浏览器里跑，不能引用 Node 侧的任何东西。
// 只做「读」与「定位」，写操作一律走指针/按键，由 actions 层发起。

export const BOX_FN = ({ selector, role }) => {
  const visible = (el) => {
    if (!el || el.getClientRects().length === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const TAGS = {
    button: "button,[role=button],input[type=submit],input[type=button]",
    link: "a[href]",
    textbox: "input,textarea,[contenteditable=true]",
    checkbox: "input[type=checkbox]",
    radio: "input[type=radio]",
    combobox: "select,[role=combobox]",
    tab: "[role=tab]",
    menuitem: "[role=menuitem]",
    listitem: "[role=listitem]",
  };
  let el = null;
  if (selector) el = [...document.querySelectorAll(selector)].find(visible) || null;
  if (!el && role) {
    const pool = [...document.querySelectorAll(TAGS[role.role] || "*")].filter(visible);
    const name = (role.name || "").trim();
    el = pool.find((node) => text(node) === name) || pool.find((node) => text(node).includes(name)) || null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    x: cx,
    y: cy,
    w: r.width,
    h: r.height,
    vw: window.innerWidth,
    vh: window.innerHeight,
    occluded: !!top && !(top === el || el.contains(top) || top.contains(el)),
    disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
  };
};

export const TEXT_FN = ({ selector, role, max }) => {
  const visible = (el) => el && el.getClientRects().length > 0;
  let el = null;
  if (selector) el = [...document.querySelectorAll(selector)].find(visible) || null;
  if (!el && role) {
    el = [...document.querySelectorAll("*")].find((n) => visible(n) && (n.innerText || "").trim() === role.name) || null;
  }
  return el ? String(el.innerText || el.value || "").slice(0, max || 120) : null;
};

export const FOCUS_FN = ({ selector, editable }) => {
  const active = document.activeElement;
  if (!active) return false;
  if (editable) {
    const tag = String(active.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || active.isContentEditable === true;
  }
  try {
    return !!(active.matches && active.matches(selector));
  } catch {
    return false;
  }
};

export const PAGE_STATE_FN = () => ({
  url: location.href,
  title: String(document.title || "").slice(0, 80),
  ready: document.readyState,
  path: location.pathname,
});

export const HEALTH_FN = () => {
  const gl = document.createElement("canvas").getContext("webgl");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return {
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
};

export const CHALLENGE_FN = () => {
  const signals = [];
  if (window._cf_chl_opt) signals.push("cf_chl");
  if (document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')) signals.push("cf_script");
  if (document.querySelector("#captcha,.geetest_panel,#challenge-form,.nc-container")) signals.push("captcha_widget");
  if (/验证|人机|Just a moment|Attention Required|Access Denied/i.test(document.title || "")) signals.push("title");
  if (/(captcha|intercept|blankpage|verify)/i.test(location.pathname)) signals.push("url");
  return signals;
};

export const SOFT_TOAST_FN = () => {
  const nodes = [...document.querySelectorAll("[class*=toast],[class*=message],[class*=notice],[role=alert]")];
  const text = nodes.map((n) => (n.innerText || "").trim()).filter(Boolean).join(" ").slice(0, 200);
  return /频繁|稍后|异常|限制|too many|rate limit/i.test(text) ? text : null;
};

export const NOTIFY_PERMISSION_FN = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

export const NOTIFY_FN = ({ title, body, tag }) => {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "granted") return Notification.permission;
  try {
    new Notification(title, { body, tag });
    return "sent";
  } catch {
    return "error";
  }
};
