import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolveProfile } from "./profile.mjs";
import { planPoints, pickFamily, landingPoint } from "./trace.mjs";
import { planKeys } from "./keyboard.mjs";
import { createBucket, take } from "./bucket.mjs";
import { openStore } from "./store.mjs";
import { createMachine } from "./alert.mjs";
import { HumanWarn, HumanBlocked } from "./errors.mjs";
import { classifyUrl, isApiEndpoint, shortHash, parseUrl, PROBE_FN, SENTINEL_FN, SOFT_TOAST_FN } from "./guard.mjs";
import { scoreMetrics, classifyScore } from "./score.mjs";
import { interpolate, validateSteps } from "./recipe.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(homedir(), ".ego-human-input");
const SKILL_VER = "0.6.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
const range = ([lo, hi]) => lo + Math.random() * (hi - lo);

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function parseLocator(locator) {
  const raw = String(locator ?? "").replace(/^loc=/, "");
  if (raw.startsWith("css=")) return { kind: "css", value: raw.slice(4) };
  if (raw.startsWith("href=")) return { kind: "href", value: raw.slice(5) };
  const role = raw.match(/^role:([a-z]+)(?:\[name=(['"])(.*?)\2\])?$/);
  if (role) return { kind: "role", value: { role: role[1], name: role[3] || "" } };
  return { kind: "css", value: raw };
}

const BOX_FN = ({ selector, role }) => {
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

const TEXT_FN = ({ selector, role, max }) => {
  const visible = (el) => el && el.getClientRects().length > 0;
  let el = null;
  if (selector) el = [...document.querySelectorAll(selector)].find(visible) || null;
  if (!el && role) {
    el = [...document.querySelectorAll("*")].find((n) => visible(n) && (n.innerText || "").trim() === role.name) || null;
  }
  return el ? String(el.innerText || el.value || "").slice(0, max || 120) : null;
};

function toEvalArg(spec) {
  if (spec.kind === "css") return { selector: spec.value };
  if (spec.kind === "href") return { selector: `a[href="${String(spec.value).replace(/"/g, '\\"')}"]` };
  return { role: spec.value };
}

async function boxOf(page, locator) {
  return page.evaluate(BOX_FN, toEvalArg(parseLocator(locator)));
}

const HEALTH_FN = () => {
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

const CHALLENGE_FN = () => {
  const signals = [];
  if (window._cf_chl_opt) signals.push("cf_chl");
  if (document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')) signals.push("cf_script");
  if (document.querySelector("#captcha,.geetest_panel,#challenge-form,.nc-container")) signals.push("captcha_widget");
  if (/验证|人机|Just a moment|Attention Required|Access Denied/i.test(document.title || "")) signals.push("title");
  if (/(captcha|intercept|blankpage|verify)/i.test(location.pathname)) signals.push("url");
  return signals;
};

async function loadConfig() {
  const base = await loadJson(join(SKILL_DIR, "profiles", "base.json"), { profiles: {} });
  const sites = await loadJson(join(SKILL_DIR, "profiles", "sites.json"), {});
  const local = await loadJson(join(STATE_DIR, "overrides.json"), {});
  return {
    profiles: base.profiles,
    defaultProfile: base.defaultProfile,
    unknown: base.unknown,
    sites,
    local: local.sites || {},
  };
}

function hourOf(ts) {
  return Math.floor(ts / 3600000);
}

function budgetOf(profile, action) {
  const b = profile.budget && profile.budget[action];
  if (!b) return null;
  return { perHour: b.perHour || 0, gap: b.gap || null };
}

export async function create(page, options = {}) {
  const cfg = await loadConfig();
  const url0 = String(await page.url());
  const baseHost = parseUrl(url0).host;

  const site = resolveProfile(url0, options.profile ? { ...cfg, sites: Object.fromEntries(Object.keys(cfg.sites).map((k) => [k, { ...cfg.sites[k], profile: options.profile }])) } : cfg);
  const profile = site.effective;
  const platformKey = site.siteKey || baseHost;

  const store = options.store || openStore(options.dbPath);
  const runId = store.startRun({ host: baseHost, profile: site.profile, ver: SKILL_VER });
  const machine = createMachine({ store, host: baseHost });

  const healthRaw = await page.evaluate(HEALTH_FN);
  const warnings = [];
  if (healthRaw.webdriver) warnings.push("navigator.webdriver=true，连接方式不像真实浏览器会话");
  if (/Headless/i.test(healthRaw.ua || "")) warnings.push("UA 含 Headless 标记");
  const health = { ...healthRaw, warnings };
  const timeline = [];
  let seq = 0;
  let sentinelLast = { untrusted: 0, silentWrite: 0, orphanRequest: 0 };
  let actionSinceTriage = 0;
  let budget = createBucket(profile.rate || {}, Date.now());
  const state = {
    frozen: false,
    cursor: { x: Math.round(health.vw * 0.4), y: Math.round(health.vh * 0.4) },
    viewport: { w: health.vw, h: health.vh },
    lastUrl: url0,
    lastActionAt: 0,
  };

  try {
    await page.evaluate(PROBE_FN);
  } catch {
    timeline.push({ t: new Date().toISOString(), kind: "probe", detail: { degraded: "no-probe" } });
  }

  const nowIso = () => new Date().toISOString();
  const record = (kind, detail) => timeline.push({ t: nowIso(), kind, detail });

  function logAction(action, info = {}) {
    seq += 1;
    const path = parseUrl(String(info.url || state.lastUrl)).path;
    const { url, ...rest } = info;
    store.addEvent({
      runId,
      seq,
      host: baseHost,
      path,
      action,
      targetKind: rest.targetKind || "",
      targetHash: rest.targetHash || "",
      ok: rest.ok !== false,
      ms: rest.ms || 0,
      flags: rest.flags || [],
      kwHash: rest.kwHash || "",
      resultFp: rest.resultFp || "",
      resultN: rest.resultN || 0,
      landingPx: rest.landingPx || 0,
      movePoints: rest.movePoints || 0,
      travelPx: rest.travelPx || 0,
    });
    // 时间线只写 pathname：导航 URL 的 query 可能带关键词，落盘即泄露。
    record(action, { path, ...rest });
  }

  async function readSentinel() {
    try {
      const value = await page.evaluate(SENTINEL_FN);
      return value || sentinelLast;
    } catch {
      return sentinelLast;
    }
  }

  async function detectChallenge() {
    try {
      return (await page.evaluate(CHALLENGE_FN)) || [];
    } catch {
      return [];
    }
  }

  async function checkAfterAction(action) {
    const current = String(await page.url());
    const verdict = classifyUrl(current, baseHost);
    if (!verdict.ok && verdict.reason === "host-drift") {
      machine.soft("host_drift", { evidence: { url: current, action } });
      state.frozen = true;
      throw new HumanWarn({ trigger: "host_drift", url: current, action });
    }
    if (!verdict.ok) {
      machine.escalate(verdict.reason, { evidence: { url: current, action } });
      state.frozen = true;
      throw new HumanBlocked({ trigger: verdict.reason, url: current, action });
    }
    const signals = await detectChallenge();
    if (signals.length) {
      machine.escalate("challenge", { evidence: { url: current, signals } });
      state.frozen = true;
      throw new HumanBlocked({ trigger: "challenge", url: current, signals });
    }
    try {
      const toast = await page.evaluate(SOFT_TOAST_FN);
      if (toast) {
        machine.soft("soft_toast", { evidence: { url: current, text: String(toast).slice(0, 120) } });
        state.frozen = true;
        throw new HumanWarn({ trigger: "soft_toast", text: String(toast).slice(0, 120) });
      }
    } catch (error) {
      if (error instanceof HumanWarn) throw error;
    }
    const sentinel = await readSentinel();
    if (sentinel.untrusted > sentinelLast.untrusted) {
      logAction("sentinel", {
        ok: false,
        flags: ["untrusted"],
        url: current,
      });
      machine.escalate("untrusted_input", { evidence: { url: current, count: sentinel.untrusted } });
      state.frozen = true;
      throw new HumanBlocked({ trigger: "untrusted_input", count: sentinel.untrusted });
    }
    sentinelLast = sentinel;
    state.lastUrl = current;
  }

  async function triageIfDue() {
    actionSinceTriage += 1;
    if (actionSinceTriage < 5) return;
    actionSinceTriage = 0;
    const sentinel = await readSentinel();
    machine.triage({
      sentinel: {
        orphanRequests: sentinel.orphanRequest - sentinelLast.orphanRequest,
        silentWrites: sentinel.silentWrite - sentinelLast.silentWrite,
      },
      evidence: { url: state.lastUrl },
    });
  }

  async function gate(action = "write") {
    if (state.frozen) throw new HumanBlocked({ trigger: "frozen" });
    const wait = machine.gate();
    if (wait > 0) await sleep(wait);
    const conf = budgetOf(profile, action);
    if (conf?.perHour) {
      const hour = hourOf(Date.now());
      const used = store.budgetRead(baseHost, action, hour);
      if (used.used >= conf.perHour && used.limit === conf.perHour) {
        machine.soft("budget", { evidence: { action, used: used.used, perHour: conf.perHour } });
        throw new HumanWarn({ trigger: "budget", action, used: used.used, perHour: conf.perHour });
      }
    }
    const gap = conf?.gap || profile.rate?.minGapMs;
    if (gap && state.lastActionAt) {
      const delta = state.lastActionAt + range(gap) - Date.now();
      if (delta > 0) await sleep(delta);
    }
    const slot = take(budget, Date.now());
    if (slot.waitMs > 0) await sleep(slot.waitMs);
    state.lastActionAt = Date.now();
    if (conf?.perHour) store.budgetTake(baseHost, action, hourOf(Date.now()), conf.perHour);
  }

  async function move(x, y) {
    if (state.frozen) throw new HumanBlocked({ trigger: "frozen" });
    const mouse = profile.mouse || {};
    const points = planPoints(state.cursor, { x, y }, {
      family: pickFamily(mouse.trajectory, Math.random),
      samples: Math.round(range(mouse.samples || [12, 26])),
      rand: Math.random,
    });
    let travel = 0;
    let prev = state.cursor;
    for (const point of points) {
      await page.mouse.move(point.x, point.y);
      await sleep(range(mouse.stepMs || [6, 16]));
      travel += Math.hypot(point.x - prev.x, point.y - prev.y);
      prev = point;
    }
    state.cursor = { x, y };
    return { points: points.length, travel: Math.round(travel) };
  }

  // 视口外用滚轮逐步逼近，不用 scrollIntoView。
  async function bringIntoView(locator) {
    const motion = { points: 0, travel: 0 };
    const hint = await move(state.viewport.w * 0.5, state.viewport.h * 0.5);
    motion.points += hint.points;
    motion.travel += hint.travel;
    let box = await boxOf(page, locator);
    for (let step = 0; step < 6 && box; step += 1) {
      const outside = box.y < 8 || box.y > box.vh - 8;
      if (!outside) break;
      const dir = box.y < 8 ? -1 : 1;
      await page.mouse.wheel(0, dir * 220);
      await sleep(100);
      box = await boxOf(page, locator);
    }
    return { box, motion };
  }

  async function goto(url) {
    const target = String(url);
    if (isApiEndpoint(target)) {
      state.frozen = true;
      throw new HumanWarn({ trigger: "b4-api-endpoint", url: target });
    }
    const verdict = classifyUrl(target);
    if (!verdict.ok) {
      machine.escalate(verdict.reason, { evidence: { url: target, action: "goto" } });
      state.frozen = true;
      throw new HumanBlocked({ trigger: verdict.reason, url: target });
    }
    await gate("nav");
    const started = Date.now();
    await page.goto(target);
    logAction("nav", { ok: true, ms: Date.now() - started, url: target });
    const signals = await detectChallenge();
    if (signals.length) {
      machine.escalate("challenge", { evidence: { url: target, signals } });
      state.frozen = true;
      throw new HumanBlocked({ trigger: "challenge", url: target, signals });
    }
    state.lastUrl = String(await page.url());
    await triageIfDue();
    return { ok: true };
  }

  async function click(target, opts = {}) {
    const action = opts.as || "write";
    await gate(action);
    const started = Date.now();
    const direct = typeof target === "object" && target && Number.isFinite(target.x);
    if (direct && (target.x <= 0 || target.y <= 0)) {
      logAction(action, { ok: false, ms: Date.now() - started, flags: ["s1-zero"], url: state.lastUrl });
      throw new HumanWarn({ trigger: "s1-zero", target: "coordinates", x: target.x, y: target.y });
    }
    const located = direct ? { box: target, motion: { points: 0, travel: 0 } } : await bringIntoView(target);
    const box = located.box;
    const motion = { ...located.motion };
    if (!box) {
      logAction(action, { ok: false, ms: Date.now() - started, flags: ["s1-missing"], url: state.lastUrl });
      throw new HumanWarn({ trigger: "s1-missing", target: String(target) });
    }
    if (box.w < 1 || box.h < 1) {
      logAction(action, { ok: false, ms: Date.now() - started, flags: ["s1-zero"], url: state.lastUrl });
      throw new HumanWarn({ trigger: "s1-zero", target: String(target) });
    }
    if (box.occluded) {
      logAction(action, { ok: false, ms: Date.now() - started, flags: ["s2-occluded"], url: state.lastUrl });
      throw new HumanWarn({ trigger: "s2-occluded", target: String(target) });
    }
    if (box.disabled) {
      logAction(action, { ok: false, ms: Date.now() - started, flags: ["s3-disabled"], url: state.lastUrl });
      throw new HumanWarn({ trigger: "s3-disabled", target: String(target) });
    }
    const landing = landingPoint(
      { x: box.x, y: box.y, w: box.w, h: box.h },
      { rand: Math.random, minOffsetPx: profile.mouse?.minLandingOffsetPx ?? 3 },
    );
    const jitter = profile.mouse?.landingJitterPx || 0;
    const approach = await move(
      landing.x + (Math.random() * 2 - 1) * jitter,
      landing.y + (Math.random() * 2 - 1) * jitter,
    );
    motion.points += approach.points;
    motion.travel += approach.travel;
    await sleep(range(profile.mouse?.hoverMs || [60, 160]));
    const settle = await move(landing.x, landing.y);
    motion.points += settle.points;
    motion.travel += settle.travel;
    await page.mouse.click(landing.x, landing.y, { delay: Math.round(range(profile.mouse?.clickDelayMs || [40, 90])) });
    await checkAfterAction(action);
    const targetHash = shortHash(String(target));
    const urlBefore = String(await page.url());
    const mutBefore = (await readSentinel()).mutations || 0;
    await sleep(300);
    const mutAfter = (await readSentinel()).mutations || 0;
    const urlAfter = String(await page.url());
    if (action !== "nav" && urlBefore === urlAfter && mutAfter === mutBefore) {
      const prior = store.countNoop(baseHost, targetHash, Date.now() - 30 * 60000);
      const count = prior + 1;
      logAction(action, {
        ok: false,
        ms: Date.now() - started,
        flags: ["s4-noop"],
        targetHash,
        url: urlAfter,
        landingPx: landing.offsetPx,
        movePoints: motion.points,
        travelPx: motion.travel,
      });
      if (count >= 2) {
        machine.escalate("s4-noop-repeat", { evidence: { targetHash, count } });
        state.frozen = true;
        throw new HumanBlocked({ trigger: "s4-noop-repeat", targetHash, count });
      }
      return { ok: false, noop: true, x: Math.round(landing.x), y: Math.round(landing.y) };
    }
    logAction(action, {
      ok: true,
      ms: Date.now() - started,
      targetKind: opts.kind || "",
      targetHash,
      url: state.lastUrl,
      landingPx: Math.round(landing.offsetPx * 100) / 100,
      movePoints: motion.points,
      travelPx: motion.travel,
    });
    await triageIfDue();
    return { ok: true, x: Math.round(landing.x), y: Math.round(landing.y), landingPx: landing.offsetPx };
  }

  async function type(text, opts = {}) {
    const actionType = opts.as || "write";
    await gate(actionType);
    const started = Date.now();
    const ops = planKeys(String(text ?? ""), profile.keyboard || {}, { rand: Math.random });
    for (const op of ops) {
      if (op.op === "type") await page.keyboard.type(op.ch);
      else if (op.op === "insert") await page.keyboard.insertText(op.text);
      else await page.keyboard.press(op.key);
      if (op.afterMs) await sleep(op.afterMs);
    }
    logAction(actionType, { ok: true, ms: Date.now() - started, flags: ["type"], url: state.lastUrl });
    await checkAfterAction("type");
    await triageIfDue();
    return { ops: ops.length };
  }

  async function scrollOnce() {
    const conf = profile.scroll || {};
    const center = { x: state.viewport.w * (0.35 + Math.random() * 0.3), y: state.viewport.h * 0.5 };
    const motion = await move(center.x, center.y);
    const segments = Math.round(range(conf.segments || [2, 5]));
    for (let i = 0; i < segments; i += 1) {
      await page.mouse.wheel(0, Math.round(range(conf.deltaPx || [120, 400])));
      await sleep(range(conf.segmentMs || [80, 300]));
    }
    logAction("read", {
      ok: true,
      flags: ["scroll"],
      url: state.lastUrl,
      movePoints: motion.points,
      travelPx: motion.travel,
    });
    return { segments };
  }

  async function read(seconds) {
    const conf = profile.pause || {};
    const total = seconds ? seconds * 1000 : Math.round(range(conf.readMs || [5000, 8000]));
    const started = Date.now();
    await sleep(Math.min(Math.round(range(conf.leadInMs || [500, 1500])), Math.round(total * 0.3)));
    const times = Math.round(range(conf.scrollTimes || [1, 2]));
    for (let i = 0; i < times; i += 1) await scrollOnce();
    const rest = total - (Date.now() - started);
    if (rest > 0) await sleep(rest);
    logAction("read", { ok: true, ms: Date.now() - started, flags: ["pause"], url: state.lastUrl });
    return { total, times };
  }

  async function focus(locator) {
    const css = parseLocator(locator).value;
    const isFocused = () =>
      page.evaluate((sel) => !!(document.activeElement && document.activeElement.matches?.(sel)), css);
    await click(locator, { as: "nav", kind: "textbox" });
    let ok = await isFocused();
    if (!ok) {
      await click(locator, { as: "nav", kind: "textbox" });
      ok = await isFocused();
    }
    return { focused: ok };
  }

  async function press(key) {
    await gate("nav");
    await page.keyboard.press(key);
    record("press", { key });
    return { key };
  }

  async function clearField() {
    await press("ControlOrMeta+A");
    await press("Backspace");
    return { cleared: true };
  }

  async function waitFor(locator, opts = {}) {
    const spec = parseLocator(locator);
    const selector = spec.kind === "css"
      ? spec.value
      : spec.kind === "href"
        ? `a[href="${String(spec.value).replace(/"/g, '\\"')}"]`
        : null;
    if (!selector) throw new HumanWarn({ trigger: "wait-needs-css", locator: String(locator) });
    try {
      await page.waitForSelector(selector, { state: opts.state || "visible", timeout: opts.timeout || 15000 });
      return { ok: true };
    } catch {
      logAction("read", { ok: false, flags: ["s9-timeout"], url: state.lastUrl });
      return { ok: false };
    }
  }

  async function note(entry = {}) {
    const id = store.addNote({
      platform: platformKey,
      host: baseHost,
      intent: entry.intent || "*",
      kind: entry.kind || "hint",
      area: entry.area,
      text: entry.text,
      selector: entry.selector,
    });
    return { id, platform: platformKey, intent: entry.intent || "*" };
  }

  async function notes(intent) {
    return store.listNotes(platformKey, { intent });
  }

  async function execStep(step) {
    switch (step.op) {
      case "click":
        return click(step.target, { as: step.as || "nav", kind: step.kind });
      case "focus":
        return focus(step.target);
      case "clearField":
        return clearField();
      case "type":
        return type(step.text, { as: step.as || "nav" });
      case "press":
        return press(step.key);
      case "waitFor": {
        const result = await waitFor(step.target, { timeout: step.timeout, state: step.state });
        if (!result.ok) throw new HumanWarn({ trigger: "wait-timeout", target: step.target });
        return result;
      }
      case "read":
        return read(step.seconds);
      case "expectText": {
        const text = await page.evaluate(TEXT_FN, { ...toEvalArg(parseLocator(step.target)), max: 200 });
        if (!String(text || "").includes(step.value)) {
          throw new HumanWarn({ trigger: "expect-text", target: step.target, want: step.value });
        }
        return { ok: true };
      }
      case "expectUrl": {
        const url = String(await page.url());
        if (!url.includes(step.value)) throw new HumanWarn({ trigger: "expect-url", want: step.value, url });
        return { ok: true };
      }
      default:
        throw new HumanWarn({ trigger: "unknown-op", op: step.op });
    }
  }

  async function run(intent, params = {}) {
    const recipe = store.getRecipe(platformKey, intent);
    if (!recipe) throw new HumanWarn({ trigger: "no-recipe", intent, hints: store.listNotes(platformKey, { intent }) });
    const steps = JSON.parse(recipe.steps);
    const started = Date.now();
    for (let index = 0; index < steps.length; index += 1) {
      const step = interpolate(steps[index], params);
      try {
        await execStep(step);
      } catch (error) {
        store.bumpRecipe(recipe.id, false);
        const cause = error?.payload?.trigger || String(error?.message || error);
        const url = String(await page.url());
        try {
          await note({
            intent,
            kind: "pitfall",
            area: `${intent} 第${index + 1}步`,
            text: `${step.op} 失败：${cause}；url=${parseUrl(url).path}`,
          });
        } catch {
          /* note 失败不影响主流程 */
        }
        throw new HumanWarn({
          trigger: "recipe-failed",
          intent,
          step: index,
          op: step.op,
          cause,
          url,
        });
      }
    }
    store.bumpRecipe(recipe.id, true);
    logAction("recipe", { ok: true, ms: Date.now() - started, flags: [intent], url: state.lastUrl });
    return { intent, steps: steps.length, ms: Date.now() - started };
  }

  async function saveRecipe(intent, steps) {
    const errors = validateSteps(steps);
    if (errors.length) throw new HumanWarn({ trigger: "bad-recipe", errors });
    const saved = store.saveRecipe({ host: platformKey, intent, steps });
    return { ...saved, platform: platformKey, intent };
  }

  function recipes() {
    return store.listRecipes(platformKey);
  }

  const inspect = {
    async rect(locator) {
      return boxOf(page, locator);
    },
    async text(locator, max = 120) {
      return page.evaluate(TEXT_FN, { ...toEvalArg(parseLocator(locator)), max });
    },
    async pageState() {
      return page.evaluate(() => ({
        url: location.href,
        title: String(document.title || "").slice(0, 80),
        ready: document.readyState,
        path: location.pathname,
      }));
    },
    async sentinel() {
      return readSentinel();
    },
    async requests(limit = 20) {
      const events = await page.events().catch(() => []);
      return events.filter((e) => e.method === "Network.requestWillBeSent").slice(-limit).map((e) => e.params?.request?.url || "");
    },
    query(sql, params = []) {
      const text = String(sql).trim();
      if (!/^select\b/i.test(text)) throw new Error("inspect.query: only SELECT is allowed");
      return store.db.prepare(text).all(...params);
    },
  };

  async function flush(outcome = "done") {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const file = join(STATE_DIR, `timeline-${day}.jsonl`);
    await mkdir(STATE_DIR, { recursive: true });
    if (timeline.length) {
      const lines = timeline.map((item) => JSON.stringify(item)).join("\n");
      await writeFile(file, `${lines}\n`, { flag: "a" });
    }
    store.endRun(runId, outcome);
    if (!options.store) store.close();
    return { written: timeline.length, runId };
  }

  return {
    health,
    timeline,
    runId,
    site: () => ({ host: site.host, siteKey: site.siteKey, profile: site.profile }),
    params: () => profile,
    inspect,
    move,
    goto,
    focus,
    click,
    type,
    press,
    clearField,
    waitFor,
    read,
    scroll: scrollOnce,
    note,
    notes,
    run,
    saveRecipe,
    recipes,
    gate,
    triage: () => machine.triage({ evidence: { url: state.lastUrl } }),
    state: () => machine.state(),
    decide: (payload) => machine.decide(payload),
    alerts: () => store.pendingAlerts(baseHost),
    flush,
  };
}

export const human = { create };
