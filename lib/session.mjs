// 会话层：动作级闸门之外，管「这一次坐下来干活」的形状。
// 落地先看、单次作业时长、日总量、工作时段、休息间隔、读写配比。
import { HumanWarn } from "./errors.mjs";
import { createTiming } from "./timing.mjs";

export const SESSION_DEFAULTS = {
  dwellMs: [800, 2500],
  maxMinutes: 90,
  dailyActionsMax: 400,
  restEveryActions: 60,
  restMs: [20000, 45000],
  activeHours: [8, 23],
  offHoursGapFactor: 1.8,
  ratioWindow: 8,
  readWriteRatioMin: 0.35,
  autoReadMs: [700, 1400],
};

// 会吃注意力的动作：这些之前如果一直没读，就补一次短阅读再动。
const SENSITIVE = new Set(["nav", "write", "search", "detail"]);

export function dayStart(ts) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function inActiveHours(ts, hours) {
  const [from, to] = Array.isArray(hours) ? hours : SESSION_DEFAULTS.activeHours;
  const hour = new Date(ts).getHours();
  if (from <= to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

export function createSession({ profile, store, host, now, rand = Math.random, sleep, read, timing = null }) {
  const conf = { ...SESSION_DEFAULTS, ...(profile?.session || {}) };
  const clockSample = timing || createTiming({ rand });
  const startedAt = now();
  const counters = { actions: 0, reads: 0, writes: 0, autoReads: 0, rests: 0 };
  let dwellMs = null;
  let restedAt = 0;
  const maxMs = Number(conf.maxMinutes) * 60000;

  function paceFactor() {
    return inActiveHours(now(), conf.activeHours) ? 1 : Number(conf.offHoursGapFactor) || 1;
  }

  // 落地先看：第一个动作之前必须有一段停留。
  async function dwell() {
    const target = Math.max(0, Math.round(clockSample.ms(conf.dwellMs, "dwell")));
    await sleep(target);
    dwellMs = target;
    return { dwellMs };
  }

  async function before(action) {
    const elapsed = now() - startedAt;
    if (elapsed > maxMs) {
      throw new HumanWarn({ trigger: "session-long", minutes: Math.round(elapsed / 60000), limit: conf.maxMinutes });
    }
    const used = store.dailyActions(host, dayStart(now()));
    if (used >= conf.dailyActionsMax) {
      throw new HumanWarn({ trigger: "daily-quota", used, limit: conf.dailyActionsMax });
    }
    if (counters.actions > 0 && counters.actions - restedAt >= conf.restEveryActions) {
      restedAt = counters.actions;
      counters.rests += 1;
      await sleep(Math.max(0, Math.round(clockSample.ms(conf.restMs, "rest"))));
    }
    if (SENSITIVE.has(action) && counters.actions >= conf.ratioWindow) {
      const ratio = counters.writes ? counters.reads / counters.writes : 1;
      if (ratio < Number(conf.readWriteRatioMin)) {
        counters.autoReads += 1;
        await read(Math.max(1, Math.round(clockSample.ms(conf.autoReadMs, "autoRead")) / 1000));
      }
    }
    return { pace: paceFactor() };
  }

  function count(action) {
    counters.actions += 1;
    if (action === "read" || action === "detail") counters.reads += 1;
    else if (action !== "sentinel" && action !== "recipe") counters.writes += 1;
  }

  function shape() {
    return {
      startedAt,
      dwellMs,
      durationMs: now() - startedAt,
      actions: counters.actions,
      reads: counters.reads,
      writes: counters.writes,
      autoReads: counters.autoReads,
      rests: counters.rests,
      pace: paceFactor(),
    };
  }

  return { dwell, before, count, shape, conf };
}
