// 时序采样：所有等待与间隔都从这里出数，统一可注入。
// 目前是区间均匀采样；对数正态与相邻相关在 P1-1 加进来。

export function range(span, rand = Math.random) {
  const lo = Number(span?.[0]);
  const hi = Number(span?.[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  return lo + rand() * (hi - lo);
}
