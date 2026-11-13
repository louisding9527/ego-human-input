import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, matchSite, deepMerge, downgrade, resolve } from "../lib/profile.mjs";
import { planPoints } from "../lib/trace.mjs";
import { splitSegments, planKeys } from "../lib/keyboard.mjs";
import { createBucket, take } from "../lib/bucket.mjs";

const rnd = (seed) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

test("normalizeHost strips scheme, path and www", () => {
  assert.equal(normalizeHost("https://www.liepin.com/a?x=1"), "liepin.com");
  assert.equal(normalizeHost("WWW.Liepin.com"), "liepin.com");
  assert.equal(normalizeHost("m.zhipin.com/job"), "m.zhipin.com");
});

test("matchSite matches suffix only on label boundary", () => {
  const keys = ["liepin.com", "zhipin.com"];
  assert.equal(matchSite("liepin.com", keys), "liepin.com");
  assert.equal(matchSite("m.liepin.com", keys), "liepin.com");
  assert.equal(matchSite("evil-liepin.com", keys), null);
  assert.equal(matchSite("liepin.com.evil.com", keys), null);
});

test("downgrade walks one step toward strict and stops", () => {
  assert.equal(downgrade("fast"), "balanced");
  assert.equal(downgrade("balanced"), "strict");
  assert.equal(downgrade("strict"), "strict");
  assert.equal(downgrade(undefined), "strict");
});

test("deepMerge overrides nested fields without dropping siblings", () => {
  const merged = deepMerge(
    { rate: { perMinute: 18, burst: 2 }, pause: { readMs: [5000, 8000] } },
    { rate: { perMinute: 9 } },
  );
  assert.equal(merged.rate.perMinute, 9);
  assert.equal(merged.rate.burst, 2);
  assert.deepEqual(merged.pause.readMs, [5000, 8000]);
});

test("resolve falls back to strict for unknown host", () => {
  const cfg = {
    profiles: { strict: { rate: { perMinute: 9 } }, balanced: { rate: { perMinute: 18 } } },
    sites: { "liepin.com": { profile: "balanced", overrides: { pause: { readMs: [6000, 9000] } } } },
  };
  const known = resolve("https://www.liepin.com/x", cfg);
  assert.equal(known.siteKey, "liepin.com");
  assert.equal(known.profile, "balanced");
  assert.deepEqual(known.effective.pause.readMs, [6000, 9000]);

  const unknown = resolve("https://example.org/x", cfg);
  assert.equal(unknown.siteKey, null);
  assert.equal(unknown.profile, "strict");
  assert.equal(unknown.effective.rate.perMinute, 9);
});

test("planPoints keeps count inside bounds and hits both ends", () => {
  const a = { x: 10, y: 20 };
  const b = { x: 300, y: 260 };
  for (const family of ["bezier", "jitter", "overshoot"]) {
    const pts = planPoints(a, b, { family, samples: 16, rand: rnd(7) });
    assert.ok(pts.length >= 10 && pts.length <= 28, `${family} count ${pts.length}`);
    const last = pts.at(-1);
    assert.ok(Math.abs(last.x - b.x) < 6 && Math.abs(last.y - b.y) < 6, `${family} endpoint`);
  }
});

test("planPoints clamps low sample counts and bows away from the straight line", () => {
  const pts = planPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { family: "bezier", samples: 2, rand: rnd(3) });
  assert.ok(pts.length >= 10);
  const bow = Math.max(...pts.map((p) => Math.abs(p.y)));
  assert.ok(bow > 1, `expected curve, got bow ${bow}`);
});

test("splitSegments separates latin from cjk, keeping trailing spaces", () => {
  const segs = splitSegments("hi 中文 ok");
  assert.deepEqual(segs.map((s) => s.kind), ["latin", "cjk", "latin"]);
  assert.equal(segs[0].text, "hi ");
  assert.equal(segs[1].text, "中文 ");
});

test("planKeys rebuilds latin text when typo is off", () => {
  const params = { charMs: [50, 60], spaceMs: [90, 100], cjkGroupMs: [300, 400], typoEveryGroups: 2, typoRate: 0 };
  const ops = planKeys("hello world", params, { rand: rnd(11) });
  const rebuilt = ops.filter((o) => o.op !== "press").map((o) => (o.op === "type" ? o.ch : o.text)).join("");
  assert.equal(rebuilt, "hello world");
});

test("planKeys 把中文按 <=2 字一组上屏，一次 insert 等于一个 input 事件", () => {
  const params = { charMs: [50, 60], spaceMs: [90, 100], cjkGroupMs: [300, 400], typoEveryGroups: 4, typoRate: 0 };
  const ops = planKeys("供应链总监", params, { rand: rnd(5) });
  assert.ok(ops.length >= 3, `ops=${ops.length}，太少就凑不出间隔序列`);
  assert.ok(ops.every((o) => o.op === "insert" && [...o.text].length <= 2));
  assert.equal(ops.map((o) => o.text).join(""), "供应链总监");
});

test("planKeys inserts whole cjk groups and never types them char by char", () => {
  const params = { charMs: [50, 60], spaceMs: [90, 100], cjkGroupMs: [300, 400], typoEveryGroups: 4, typoRate: 0 };
  const ops = planKeys("中文测试", params, { rand: rnd(5) });
  assert.ok(ops.length > 0);
  assert.ok(ops.every((o) => o.op === "insert"));
  assert.equal(ops.map((o) => o.text).join(""), "中文测试");
  for (const op of ops.slice(1)) assert.ok(op.afterMs >= 300 && op.afterMs <= 400);
});

test("planKeys injects a backspace correction for latin after two groups", () => {
  const params = { charMs: [50, 60], spaceMs: [90, 100], cjkGroupMs: [300, 400], typoEveryGroups: 2, typoRate: 1 };
  const ops = planKeys("one two three four", params, { rand: rnd(9) });
  const presses = ops.filter((o) => o.op === "press");
  assert.ok(presses.length >= 1);
  assert.ok(presses.every((o) => o.key === "Backspace"));
  const firstPress = ops.indexOf(presses[0]);
  assert.ok(ops.slice(0, firstPress).filter((o) => o.op === "type").length >= 1);
});

test("bucket allows burst then forces a wait", () => {
  let state = createBucket({ perMinute: 6, burst: 2 }, 0);
  const first = take(state, 0);
  assert.equal(first.waitMs, 0);
  state = first.state;
  const second = take(state, 0);
  assert.equal(second.waitMs, 0);
  state = second.state;
  const third = take(state, 0);
  assert.ok(third.waitMs > 0, `expected wait, got ${third.waitMs}`);
});
