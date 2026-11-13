// 时序采样：所有等待与间隔都从这里出数，统一可注入。
// 默认对数正态 + 相邻正相关：真人的按键与移动间隔不是均匀分布，
// 相邻两次之间还会「带节奏」（快慢成簇），均匀采样在时序统计上一眼可辨。

export function createRandom(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function range(span, rand = Math.random) {
  const lo = Number(span?.[0]);
  const hi = Number(span?.[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  return lo + rand() * (hi - lo);
}

// dist: "lognormal"（默认）或 "uniform"。sigma 是对数标准差，rho 是相邻相关系数。
export function createTiming({ rand = Math.random, dist = "lognormal", sigma = 0.45, rho = 0.45 } = {}) {
  const series = new Map();

  function style(key) {
    const previous = series.get(key) ?? 0;
    const next = rho * previous + Math.sqrt(1 - rho * rho) * gauss(rand);
    series.set(key, next);
    return next;
  }

  // 从 [lo, hi] 里取一个时长；同名 key 的相邻样本正相关，像人一样忽快忽慢成簇。
  function ms(span, key = "ms") {
    const a = Number(span?.[0]);
    const b = Number(span?.[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi <= lo) return lo;
    if (dist === "uniform") return lo + rand() * (hi - lo);
    const median = Math.sqrt(lo * hi);
    return clamp(median * Math.exp(sigma * style(key)), lo, hi);
  }

  function pick(list) {
    const items = Array.isArray(list) && list.length ? list : [0];
    return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
  }

  return { ms, pick, style, dist, sigma, rho };
}
