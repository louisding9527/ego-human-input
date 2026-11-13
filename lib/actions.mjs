// 动作层：闸门之后的全部人味操作与事后校验。
// 只看得到 ctx（浏览器适配层、状态、纯函数），不碰 sqlite 的建表细节，也不依赖 Node 文件系统。
import { planPoints, landingPoint } from "./trace.mjs";
import { planKeys } from "./keyboard.mjs";
import { classifyUrl, isApiEndpoint, shortHash } from "./guard.mjs";
import { HumanWarn, HumanBlocked } from "./errors.mjs";
import { createTiming } from "./timing.mjs";
import { selectorOf } from "./locator.mjs";

export function createActions(ctx) {
  const timing = ctx.timing || createTiming({ rand });

  const {
    browser,
    machine,
    profile,
    state,
    channel,
    log,
    record,
    gate,
    sleep,
    rand = Math.random,
    now = Date.now,
    sentinel,
  } = ctx;

  let actionSinceTriage = 0;
  let silentAtTriage = 0;

  async function readSentinel() {
    if (sentinel.lost) return sentinel.last;
    try {
      const value = await browser.readSentinel(channel);
      if (!value) {
        sentinel.lost = true;
        record("sentinel", { degraded: "no-channel" });
        return sentinel.last;
      }
      return value;
    } catch {
      return sentinel.last;
    }
  }

  async function detectChallenge() {
    try {
      return (await browser.challenge()) || [];
    } catch {
      return [];
    }
  }

  function freeze(payload, kind = "blocked") {
    state.frozen = true;
    // 先留证、再通知，最后抛：进程可能马上结束，通知必须已经开始发。
    ctx.reportBlock?.(payload);
    throw kind === "warn" ? new HumanWarn(payload) : new HumanBlocked(payload);
  }

  // 事后校验：URL 是否跑偏、是否落到挑战页、是否弹软提示、是否出现旁路输入。
  async function checkAfterAction(action) {
    const current = await browser.url();
    const verdict = classifyUrl(current, ctx.host);
    if (!verdict.ok && verdict.reason === "host-drift") {
      machine.soft("host_drift", { evidence: { url: current, action } });
      freeze({ trigger: "host_drift", url: current, action }, "warn");
    }
    if (!verdict.ok) {
      machine.escalate(verdict.reason, { evidence: { url: current, action } });
      freeze({ trigger: verdict.reason, url: current, action });
    }
    const signals = await detectChallenge();
    if (signals.length) {
      machine.escalate("challenge", { evidence: { url: current, signals } });
      freeze({ trigger: "challenge", url: current, signals });
    }
    try {
      const toast = await browser.toast();
      if (toast) {
        machine.soft("soft_toast", { evidence: { url: current, text: String(toast).slice(0, 120) } });
        freeze({ trigger: "soft_toast", text: String(toast).slice(0, 120) }, "warn");
      }
    } catch (error) {
      if (error instanceof HumanWarn) throw error;
    }
    const snapshot = await readSentinel();
    if (snapshot.untrusted > sentinel.last.untrusted) {
      log("sentinel", { ok: false, flags: ["untrusted"], url: current });
      machine.escalate("untrusted_input", { evidence: { url: current, count: snapshot.untrusted } });
      freeze({ trigger: "untrusted_input", count: snapshot.untrusted });
    }
    sentinel.last = snapshot;
    state.lastUrl = current;
  }

  async function triageIfDue() {
    actionSinceTriage += 1;
    if (actionSinceTriage < 5) return;
    actionSinceTriage = 0;
    const snapshot = await readSentinel();
    machine.triage({
      sentinel: { silentWrites: snapshot.silentWrite - silentAtTriage },
      evidence: { url: state.lastUrl },
    });
    silentAtTriage = snapshot.silentWrite;
  }

  async function move(x, y) {
    if (state.frozen) throw new HumanBlocked({ trigger: "frozen" });
    const mouse = profile.mouse || {};
    const points = planPoints(state.cursor, { x, y }, {
      family: timing.pick(mouse.trajectory),
      samples: Math.round(timing.ms(mouse.samples || [12, 26], "samples")),
      rand,
    });
    let travel = 0;
    let prev = state.cursor;
    const steps = [];
    for (const point of points) {
      await browser.mouse.move(point.x, point.y);
      const gap = timing.ms(mouse.stepMs || [6, 16], "step");
      steps.push(Math.round(gap));
      await sleep(gap);
      travel += Math.hypot(point.x - prev.x, point.y - prev.y);
      prev = point;
    }
    state.cursor = { x, y };
    return { points: points.length, travel: Math.round(travel), steps };
  }

  // 视口外用滚轮逐步逼近，不用 scrollIntoView。
  async function bringIntoView(locator) {
    const motion = { points: 0, travel: 0, steps: [] };
    const hint = await move(state.viewport.w * 0.5, state.viewport.h * 0.5);
    motion.points += hint.points;
    motion.travel += hint.travel;
    motion.steps.push(...hint.steps);
    let box = await browser.box(locator);
    for (let step = 0; step < 6 && box; step += 1) {
      const outside = box.y < 8 || box.y > box.vh - 8;
      if (!outside) break;
      const dir = box.y < 8 ? -1 : 1;
      await browser.mouse.wheel(0, dir * 220);
      await sleep(100);
      box = await browser.box(locator);
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
      freeze({ trigger: verdict.reason, url: target });
    }
    const slot = await gate("nav");
    const started = now();
    try {
      await browser.goto(target);
    } catch (error) {
      slot.release();
      throw error;
    }
    log("nav", { ok: true, ms: now() - started, url: target });
    const signals = await detectChallenge();
    if (signals.length) {
      machine.escalate("challenge", { evidence: { url: target, signals } });
      freeze({ trigger: "challenge", url: target, signals });
    }
    state.lastUrl = await browser.url();
    await triageIfDue();
    return { ok: true };
  }

  async function click(target, opts = {}) {
    const action = opts.as || "write";
    const slot = await gate(action);
    const started = now();
    const fail = (trigger, detail) => {
      // 没发生指针交互就不该吃配额：先释放预留，再记账抛错。
      slot.release();
      log(action, { ok: false, ms: now() - started, flags: [trigger, "click"], url: state.lastUrl });
      throw new HumanWarn({ trigger, ...detail });
    };
    const direct = typeof target === "object" && target && Number.isFinite(target.x);
    if (direct && (target.x <= 0 || target.y <= 0)) {
      fail("s1-zero", { target: "coordinates", x: target.x, y: target.y });
    }
    let located;
    try {
      located = direct ? { box: target, motion: { points: 0, travel: 0, steps: [] } } : await bringIntoView(target);
    } catch (error) {
      slot.release();
      throw error;
    }
    const box = located.box;
    const motion = { ...located.motion, steps: [...(located.motion.steps || [])] };
    if (!box) fail("s1-missing", { target: String(target) });
    if (box.w < 1 || box.h < 1) fail("s1-zero", { target: String(target) });
    if (box.occluded) fail("s2-occluded", { target: String(target) });
    if (box.disabled) fail("s3-disabled", { target: String(target) });

    const landing = landingPoint(
      { x: box.x, y: box.y, w: box.w, h: box.h },
      { rand, minOffsetPx: profile.mouse?.minLandingOffsetPx ?? 3 },
    );
    const jitter = profile.mouse?.landingJitterPx || 0;
    const approach = await move(
      landing.x + (rand() * 2 - 1) * jitter,
      landing.y + (rand() * 2 - 1) * jitter,
    );
    motion.points += approach.points;
    motion.travel += approach.travel;
    motion.steps.push(...approach.steps);
    const hoverMs = Math.round(timing.ms(profile.mouse?.hoverMs || [60, 160], "hover"));
    await sleep(hoverMs);
    const settle = await move(landing.x, landing.y);
    motion.points += settle.points;
    motion.travel += settle.travel;
    motion.steps.push(...settle.steps);
    const clickDelayMs = Math.round(timing.ms(profile.mouse?.clickDelayMs || [40, 90], "clickDelay"));
    await browser.mouse.click(landing.x, landing.y, { delay: clickDelayMs });
    const meta = { steps: motion.steps.slice(0, 32), hover: hoverMs, clickDelay: clickDelayMs };
    await checkAfterAction(action);

    const targetHash = shortHash(String(target));
    const urlBefore = await browser.url();
    const mutBefore = (await readSentinel()).mutations || 0;
    await sleep(300);
    const mutAfter = (await readSentinel()).mutations || 0;
    const urlAfter = await browser.url();
    if (action !== "nav" && urlBefore === urlAfter && mutAfter === mutBefore) {
      const prior = ctx.countNoop(targetHash);
      const count = prior + 1;
      log(action, {
        ok: false,
        ms: now() - started,
        flags: ["s4-noop", "click"],
        targetHash,
        url: urlAfter,
        landingPx: landing.offsetPx,
        movePoints: motion.points,
        travelPx: motion.travel,
        meta,
      });
      if (count >= 2) {
        machine.escalate("s4-noop-repeat", { evidence: { targetHash, count } });
        freeze({ trigger: "s4-noop-repeat", targetHash, count });
      }
      return { ok: false, noop: true, x: Math.round(landing.x), y: Math.round(landing.y) };
    }
    log(action, {
      ok: true,
      ms: now() - started,
      flags: ["click"],
      targetKind: opts.kind || "",
      targetHash,
      url: state.lastUrl,
      landingPx: Math.round(landing.offsetPx * 100) / 100,
      movePoints: motion.points,
      travelPx: motion.travel,
      meta,
    });
    await triageIfDue();
    return { ok: true, x: Math.round(landing.x), y: Math.round(landing.y), landingPx: landing.offsetPx };
  }

  async function type(text, opts = {}) {
    const actionType = opts.as || "write";
    const slot = await gate(actionType);
    const started = now();
    const ops = planKeys(String(text ?? ""), profile.keyboard || {}, { rand, timing });
    let sent = 0;
    try {
      for (const op of ops) {
        if (op.op === "type") await browser.keyboard.type(op.ch);
        else if (op.op === "insert") await browser.keyboard.insertText(op.text);
        else await browser.keyboard.press(op.key);
        sent += 1;
        if (op.afterMs) await sleep(op.afterMs);
      }
    } catch (error) {
      if (sent === 0) slot.release();
      throw error;
    }
    const gaps = ops.map((op) => Math.round(op.afterMs || 0)).filter((value) => value > 0).slice(0, 40);
    log(actionType, { ok: true, ms: now() - started, flags: ["type"], url: state.lastUrl, meta: { gaps, ops: ops.length } });
    await checkAfterAction("type");
    await triageIfDue();
    return { ops: ops.length };
  }

  async function scrollOnce() {
    const conf = profile.scroll || {};
    const center = { x: state.viewport.w * (0.35 + rand() * 0.3), y: state.viewport.h * 0.5 };
    const motion = await move(center.x, center.y);
    const segments = Math.round(timing.ms(conf.segments || [2, 5], "segments"));
    const deltas = [];
    const gaps = [];
    for (let i = 0; i < segments; i += 1) {
      const delta = Math.round(timing.ms(conf.deltaPx || [120, 400], "scrollDelta"));
      deltas.push(delta);
      await browser.mouse.wheel(0, delta);
      const gap = Math.round(timing.ms(conf.segmentMs || [80, 300], "scrollSegment"));
      gaps.push(gap);
      await sleep(gap);
    }
    log("read", {
      ok: true,
      flags: ["scroll"],
      url: state.lastUrl,
      movePoints: motion.points,
      travelPx: motion.travel,
      meta: { deltas, gaps },
    });
    return { segments };
  }

  async function read(seconds) {
    const conf = profile.pause || {};
    const total = seconds ? seconds * 1000 : Math.round(timing.ms(conf.readMs || [5000, 8000], "read"));
    const started = now();
    await sleep(Math.min(Math.round(timing.ms(conf.leadInMs || [500, 1500], "leadIn")), Math.round(total * 0.3)));
    const times = Math.round(timing.ms(conf.scrollTimes || [1, 2], "scrollTimes"));
    for (let i = 0; i < times; i += 1) await scrollOnce();
    const rest = total - (now() - started);
    if (rest > 0) await sleep(rest);
    log("read", { ok: true, ms: now() - started, flags: ["pause"], url: state.lastUrl });
    return { total, times };
  }

  async function focus(locator) {
    const selector = selectorOf(locator);
    const check = () => browser.focused(selector ? { selector } : { editable: true });
    await click(locator, { as: "nav", kind: "textbox" });
    let ok = await check();
    if (!ok) {
      await click(locator, { as: "nav", kind: "textbox" });
      ok = await check();
    }
    return { focused: ok };
  }

  async function press(key) {
    const slot = await gate("nav");
    try {
      await browser.keyboard.press(key);
    } catch (error) {
      slot.release();
      throw error;
    }
    record("press", { key });
    return { key };
  }

  async function clearField() {
    await press("ControlOrMeta+A");
    await press("Backspace");
    return { cleared: true };
  }

  async function waitFor(locator, opts = {}) {
    const selector = selectorOf(locator);
    const timeout = Number(opts.timeout) || 15000;
    // role: 定位符没有对应 CSS，只能自己轮询可见性；轮询次数有上限，不依赖时钟。
    if (!selector) {
      const attempts = Math.max(1, Math.ceil(timeout / 200));
      for (let i = 0; i < attempts; i += 1) {
        if (await browser.box(locator)) return { ok: true };
        await sleep(200);
      }
      log("read", { ok: false, flags: ["s9-timeout"], url: state.lastUrl });
      return { ok: false };
    }
    try {
      await browser.waitSelector(selector, { state: opts.state || "visible", timeout });
      return { ok: true };
    } catch {
      log("read", { ok: false, flags: ["s9-timeout"], url: state.lastUrl });
      return { ok: false };
    }
  }

  return {
    readSentinel,
    checkAfterAction,
    triageIfDue,
    move,
    bringIntoView,
    goto,
    click,
    type,
    scrollOnce,
    read,
    focus,
    press,
    clearField,
    waitFor,
    sentinelState: sentinel,
  };
}
