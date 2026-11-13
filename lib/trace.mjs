const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const lerp = (a, b, t) => a + (b - a) * t;

function unit(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { dist, ux: (b.x - a.x) / dist, uy: (b.y - a.y) / dist };
}

function bezierAt(a, c1, c2, b, t) {
  const m = 1 - t;
  return {
    x: m ** 3 * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t ** 3 * b.x,
    y: m ** 3 * a.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t ** 3 * b.y,
  };
}

function bezier(a, b, n, rand, dist) {
  const off = dist * 0.15;
  const c1 = {
    x: lerp(a.x, b.x, 0.3) + (rand() * 2 - 1) * off,
    y: lerp(a.y, b.y, 0.3) + (rand() * 2 - 1) * off,
  };
  const c2 = {
    x: lerp(a.x, b.x, 0.7) + (rand() * 2 - 1) * off,
    y: lerp(a.y, b.y, 0.7) + (rand() * 2 - 1) * off,
  };
  return Array.from({ length: n }, (_, i) => bezierAt(a, c1, c2, b, (i + 1) / n));
}

function jitter(a, b, n, rand, dist) {
  const { ux, uy } = unit(a, b);
  const amp = clamp(dist * 0.03, 1, 6);
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    const drift = Math.sin(Math.PI * t) * amp * (rand() * 2 - 1);
    return {
      x: lerp(a.x, b.x, t) - uy * drift,
      y: lerp(a.y, b.y, t) + ux * drift,
    };
  });
}

function overshoot(a, b, n, rand, dist) {
  const { ux, uy } = unit(a, b);
  const over = 8 + rand() * 12;
  const target = { x: b.x + ux * over, y: b.y + uy * over };
  const first = Math.max(2, Math.round(n * 0.75));
  const head = Array.from({ length: first }, (_, i) => ({
    x: lerp(a.x, target.x, (i + 1) / first),
    y: lerp(a.y, target.y, (i + 1) / first),
  }));
  const tailLen = Math.max(2, n - first);
  const tail = Array.from({ length: tailLen }, (_, i) => ({
    x: lerp(target.x, b.x, (i + 1) / tailLen),
    y: lerp(target.y, b.y, (i + 1) / tailLen),
  }));
  return head.concat(tail);
}

export function planPoints(a, b, { family = "bezier", samples = 16, rand = Math.random } = {}) {
  const n = clamp(Math.round(samples), 10, 28);
  const { dist } = unit(a, b);
  if (family === "jitter") return jitter(a, b, n, rand, dist);
  if (family === "overshoot") return overshoot(a, b, n, rand, dist);
  return bezier(a, b, n, rand, dist);
}

export function pickFamily(families, rand = Math.random) {
  const list = Array.isArray(families) && families.length ? families : ["bezier"];
  return list[Math.floor(rand() * list.length)];
}
