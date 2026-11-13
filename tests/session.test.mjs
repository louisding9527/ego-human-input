// 会话层：确定性优先，边界必须能算出来、能抛出来。
import test from "node:test";
import assert from "node:assert/strict";
import { createSession, dayStart, inActiveHours, SESSION_DEFAULTS } from "../lib/session.mjs";

const PROFILE = {
  session: {
    dwellMs: [400, 400],
    maxMinutes: 1,
    dailyActionsMax: 5,
    restEveryActions: 3,
    restMs: [900, 900],
    activeHours: [8, 23],
    offHoursGapFactor: 2,
    ratioWindow: 2,
    readWriteRatioMin: 0.5,
    autoReadMs: [1200, 1200],
  },
};

function rig({ profile = PROFILE, used = 0, start = 0 } = {}) {
  const clock = { t: start };
  const slept = [];
  const reads = [];
  const dayUsed = { value: used };
  const session = createSession({
    profile,
    store: { dailyActions: () => dayUsed.value },
    host: "h.liepin.com",
    now: () => clock.t,
    rand: () => 0.5,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
    read: async (seconds) => {
      reads.push(seconds);
      session.count("read");
    },
  });
  return { session, clock, slept, reads, dayUsed };
}

test("dayStart 与 inActiveHours 的边界可算", () => {
  const noon = new Date(2026, 10, 13, 12, 0, 0).getTime();
  assert.equal(new Date(dayStart(noon)).getHours(), 0);
  assert.ok(dayStart(noon) <= noon);
  assert.equal(inActiveHours(noon, [8, 23]), true);
  assert.equal(inActiveHours(new Date(2026, 10, 13, 7, 59, 0).getTime(), [8, 23]), false);
  assert.equal(inActiveHours(new Date(2026, 10, 13, 23, 0, 0).getTime(), [8, 23]), false);
  assert.equal(inActiveHours(new Date(2026, 10, 13, 2, 0, 0).getTime(), [23, 4]), true);
});

test("默认值齐全，profile 覆盖按字段合并", () => {
  const { session } = rig();
  assert.equal(session.conf.maxMinutes, 1);
  assert.equal(session.conf.ratioWindow, 2);
  assert.deepEqual(session.conf.activeHours, [8, 23]);
  assert.ok(SESSION_DEFAULTS.maxMinutes > 0);
});

test("dwell 睡够并记下来", async () => {
  const { session, slept } = rig();
  const result = await session.dwell();
  assert.equal(result.dwellMs, 400);
  assert.deepEqual(slept, [400]);
  assert.equal(session.shape().dwellMs, 400);
});

test("会话超时抛 session-long", async () => {
  const { session, clock } = rig();
  clock.t += 61 * 1000;
  await assert.rejects(() => session.before("nav"), (error) => error.payload?.trigger === "session-long");
});

test("日配额用完抛 daily-quota", async () => {
  const { session, dayUsed } = rig();
  dayUsed.value = 5;
  await assert.rejects(() => session.before("nav"), (error) => error.payload?.trigger === "daily-quota");
  dayUsed.value = 4;
  await session.before("nav");
});

test("到点休息，休息只发生一次", async () => {
  const { session, slept } = rig();
  // 真实顺序：先过闸门，动作完成后才计数。
  for (let i = 0; i < 3; i += 1) {
    await session.before("nav");
    session.count("nav");
  }
  assert.equal(slept.filter((ms) => ms === 900).length, 0, "第 3 个动作前还不该休息");
  await session.before("nav");
  assert.equal(slept.filter((ms) => ms === 900).length, 1, "第 4 个动作前必须休息");
  assert.equal(session.shape().rests, 1);
  await session.before("nav");
  assert.equal(slept.filter((ms) => ms === 900).length, 1, "同一轮不重复休息");
});

test("读写比不达标时，写动作前自动补一次短阅读", async () => {
  const { session, reads } = rig();
  for (let i = 0; i < 4; i += 1) session.count("nav");
  await session.before("write");
  assert.deepEqual(reads, [1.2]);
  assert.equal(session.shape().autoReads, 1);
  assert.equal(session.shape().reads, 1);
});

test("工作时段外把间隔拉长", async () => {
  const { session } = rig({ start: new Date(2026, 10, 13, 3, 0, 0).getTime() });
  assert.equal((await session.before("nav")).pace, 2);
});

test("count 把读、写、记账类动作分开", async () => {
  const { session } = rig();
  for (const action of ["read", "detail", "click", "type", "press", "nav", "focus", "search", "sentinel", "recipe"]) {
    session.count(action);
  }
  const shape = session.shape();
  assert.equal(shape.actions, 10);
  assert.equal(shape.reads, 2);
  assert.equal(shape.writes, 6, "sentinel 与 recipe 不算写入动作");
});
