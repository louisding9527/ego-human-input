// 时序采样：分布形状与相邻相关性都要能被测试抓住。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTiming, createRandom, range } from "../lib/timing.mjs";

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

function sample(n, span, options = {}) {
  const timing = createTiming({ rand: createRandom(options.seed || 7), ...options });
  return Array.from({ length: n }, () => timing.ms(span, options.key || "k"));
}

function lagOneCorrelation(values) {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    den += (values[i] - mean) ** 2;
    if (i > 0) num += (values[i] - mean) * (values[i - 1] - mean);
  }
  return den ? num / den : 0;
}

test("createRandom 同种子可复现，不同种子不同", () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const c = createRandom(43);
  const left = Array.from({ length: 5 }, () => a());
  const right = Array.from({ length: 5 }, () => b());
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, Array.from({ length: 5 }, () => c()));
});

test("对数正态样本落在区间内，中位数贴着几何中点", () => {
  const span = [50, 2000];
  const values = sample(4000, span).sort((a, b) => a - b);
  assert.ok(values[0] >= span[0] && values.at(-1) <= span[1]);
  const middle = quantile(values, 0.5);
  const geometric = Math.sqrt(span[0] * span[1]);
  assert.ok(Math.abs(middle / geometric - 1) < 0.15, `median ${middle} vs ${geometric}`);
  assert.ok(quantile(values, 0.1) < middle && middle < quantile(values, 0.9));
  assert.ok(quantile(values, 0.9) / quantile(values, 0.1) > 1.3, "尾部不够厚");
});

test("分布不是均匀的：中间区间占比明显偏低", () => {
  const span = [50, 2000];
  const values = sample(4000, span);
  const mid = values.filter((v) => v >= 537 && v <= 1512).length / values.length;
  assert.ok(mid < 0.4, `区间中段占比 ${mid}，看起来仍像均匀分布`);
});

test("相邻样本正相关，换 key 就互不相干", () => {
  const timing = createTiming({ rand: createRandom(11) });
  const sameKey = Array.from({ length: 2000 }, () => timing.ms([50, 2000], "char")).sort();
  const series = Array.from({ length: 2000 }, () => timing.ms([50, 2000], "char"));
  const correlated = lagOneCorrelation(series);
  assert.ok(correlated > 0.2, `相邻相关 ${correlated} 太低，节奏不成簇`);

  const mixed = createTiming({ rand: createRandom(12) });
  const alternating = Array.from({ length: 2000 }, (_, i) => mixed.ms([50, 2000], i % 2 ? "a" : "b"));
  assert.ok(Math.abs(lagOneCorrelation(alternating)) < 0.2, "不同 key 之间不该继承节奏");

  assert.ok(sameKey.length === 2000);
});

test("窄区间不会越界，uniform 模式仍可切回", () => {
  const tight = sample(500, [100, 110]);
  assert.ok(tight.every((v) => v >= 100 && v <= 110));

  const uniform = createTiming({ rand: createRandom(3), dist: "uniform" });
  const values = Array.from({ length: 2000 }, () => uniform.ms([100, 200], "u"));
  const middle = values.filter((v) => v >= 125 && v <= 175).length / values.length;
  assert.ok(middle > 0.4 && middle < 0.6, `均匀模式中段占比 ${middle}`);
  assert.ok(values.every((v) => v >= 100 && v <= 200));
});

test("pick 从列表里取值，空列表不抛", () => {
  const timing = createTiming({ rand: createRandom(5) });
  const picked = new Set(Array.from({ length: 200 }, () => timing.pick(["a", "b", "c"])));
  assert.deepEqual([...picked].sort(), ["a", "b", "c"]);
  assert.equal(timing.pick([]), 0);
});

test("契约层与动作层不再直接摇 Math.random", () => {
  for (const file of ["lib/human.mjs", "lib/actions.mjs", "lib/session.mjs"]) {
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
    const source = readFileSync(path, "utf8");
    assert.equal(/Math\.random\s*\(/.test(source), false, `${file} 里还有裸的 Math.random()`);
  }
  assert.equal(range([1, 2], () => 0.5), 1.5);
});
