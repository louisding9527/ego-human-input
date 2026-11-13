// 判定：把观测结果与冻结阈值比对，输出可执行断言。
// 纯函数，无 I/O、无随机、无时间依赖：同一份事件永远得到同一个结论。

const pct = (value) => `${Math.round(Number(value || 0) * 1000) / 10}%`;

export function evaluate(observed, thresholds) {
  const a = thresholds?.assertions || {};
  const o = observed || {};
  const landing = o.landing || {};
  const move = o.move || {};
  const checks = [];

  const push = (id, label, ok, actual, limit) => checks.push({ id, label, ok, actual, limit });

  push(
    "untrusted",
    "非信任输入事件数为 0",
    Number(o.untrusted || 0) <= Number(a.untrustedMax ?? 0),
    Number(o.untrusted || 0),
    `<= ${a.untrustedMax ?? 0}`,
  );
  push(
    "degraded",
    "没有降级动作",
    Number(o.degraded || 0) <= Number(a.degradedMax ?? 0),
    Number(o.degraded || 0),
    `<= ${a.degradedMax ?? 0}`,
  );
  // 落点断言只对「按定位符算出来的坐标」成立：坐标点击没有元素中心可比。
  // 全部是坐标点击时给 n/a 通过，并把数量报出来，方便人工复核 canvas 页面。
  const onlyDirect = Number(landing.n || 0) === 0 && Number(o.directClicks || 0) > 0;
  push(
    "landing",
    "点击落点不扎堆在元素中心",
    onlyDirect || (Number(landing.n || 0) > 0 && Number(landing.zeroRate || 0) <= Number(a.landingZeroRateMax ?? 0.1)),
    onlyDirect
      ? `n/a（${o.directClicks} 个坐标点击）`
      : Number(landing.n || 0) > 0
        ? pct(landing.zeroRate)
        : "n/a（没有带观测的点击）",
    `<= ${pct(a.landingZeroRateMax ?? 0.1)}`,
  );
  push(
    "landing-median",
    "落点中位偏移达到下限",
    onlyDirect || (landing.medianPx !== null && Number(landing.medianPx) >= Number(a.landingMedianPxMin ?? 3)),
    onlyDirect
      ? `n/a（${o.directClicks} 个坐标点击）`
      : landing.medianPx === null
        ? "n/a"
        : `${Math.round(Number(landing.medianPx) * 10) / 10}px`,
    `>= ${a.landingMedianPxMin ?? 3}px`,
  );
  push(
    "move-points",
    "每次移动的采样点达到下限",
    move.minPoints !== null && Number(move.minPoints) >= Number(a.movePointsMin ?? 10),
    move.minPoints === null ? "n/a" : move.minPoints,
    `>= ${a.movePointsMin ?? 10}`,
  );
  push(
    "read-write",
    "读取动作相对写入动作的比例达到下限",
    Number(o.readWriteRatio || 0) >= Number(a.readWriteRatioMin ?? 0.25),
    pct(o.readWriteRatio),
    `>= ${pct(a.readWriteRatioMin ?? 0.25)}`,
  );

  // 分布形状：动作内部的间隔不能等距，否则一眼就是程序在发事件。
  // 样本太小时 CV 本身不可信（5 个间隔的 CV 落在 0.09 也是常事），
  // 所以按键间隔只在最长序列 ≥ 8 个间隔时才断言；不足就记 n/a，不算失败。
  const MIN_CV_SAMPLES = 8;
  const timing = o.timing || {};
  const steps = timing.clickSteps || {};
  const gaps = timing.typeGaps || {};
  push(
    "step-cv",
    "移动步长间隔不是等距",
    Number(steps.n || 0) > 0 && Number(steps.medianCv || 0) >= Number(a.stepIntervalCvMin ?? 0.15),
    Number(steps.n || 0) > 0 ? `CV ${steps.medianCv}` : "n/a（没有带序列的点击）",
    `>= CV ${a.stepIntervalCvMin ?? 0.15}`,
  );
  const enoughGaps = Number(gaps.maxLen || 0) >= MIN_CV_SAMPLES;
  push(
    "type-cv",
    "按键间隔不是等距",
    !enoughGaps || (Number(gaps.n || 0) > 0 && Number(gaps.medianCv || 0) >= Number(a.typeIntervalCvMin ?? 0.15)),
    enoughGaps
      ? Number(gaps.n || 0) > 0
        ? `CV ${gaps.medianCv}`
        : "n/a（没有带序列的输入）"
      : `n/a（最长 ${gaps.maxLen || 0} 个间隔，少于 ${MIN_CV_SAMPLES} 个）`,
    `>= CV ${a.typeIntervalCvMin ?? 0.15}`,
  );

  // 会话形状：只有真的坐着干活才有这些值；缺数据按不通过处理，不给「没观测=合格」。
  const session = o.session || {};
  const dwell = Number(session.dwellMs);
  const duration = Number(session.durationMs);
  const dayActions = Number(session.dayActions);
  const minutesMax = Number(a.sessionMaxMinutes ?? 120);
  push(
    "dwell",
    "首动作前有停留",
    Number.isFinite(session.dwellMs) && session.dwellMs !== null && dwell >= Number(a.firstActionDwellMsMin ?? 300),
    Number.isFinite(session.dwellMs) && session.dwellMs !== null ? `${Math.round(dwell)}ms` : "n/a（没有起止时间）",
    `>= ${a.firstActionDwellMsMin ?? 300}ms`,
  );
  push(
    "session-length",
    "单次会话时长不超过上限",
    Number.isFinite(session.durationMs) && session.durationMs !== null && duration <= minutesMax * 60000,
    Number.isFinite(session.durationMs) && session.durationMs !== null ? `${Math.round(duration / 60000)}min` : "n/a",
    `<= ${minutesMax}min`,
  );
  push(
    "daily-actions",
    "当累计动作数不超过上限",
    Number.isFinite(session.dayActions) && session.dayActions !== null && dayActions <= Number(a.dailyActionsMax ?? 400),
    Number.isFinite(session.dayActions) && session.dayActions !== null ? dayActions : "n/a",
    `<= ${a.dailyActionsMax ?? 400}`,
  );

  return {
    ok: checks.every((check) => check.ok),
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    checks,
    observed: o,
  };
}

// 子指标逐项比较：任一项退化超过阈值即判退化。总分相等可能互相抵消，所以不比总分。
const SUB_METRICS = [
  { id: "readWriteRatio", label: "读写比", of: (o) => Number(o.readWriteRatio || 0) },
  { id: "landingMedian", label: "落点中位偏移", of: (o) => Number(o.landing?.medianPx || 0) },
  { id: "moveMedianPoints", label: "移动采样点中位数", of: (o) => Number(o.move?.medianPoints || 0) },
  { id: "failRate", label: "失败率", of: (o) => 1 - Number(o.failRate || 0), invert: true },
  { id: "untrusted", label: "非信任输入", of: (o) => Number(o.untrusted || 0), invert: true },
  { id: "stepCv", label: "移动步长间隔 CV", of: (o) => Number(o.timing?.clickSteps?.medianCv || 0) },
  { id: "typeCv", label: "按键间隔 CV", of: (o) => Number(o.timing?.typeGaps?.medianCv || 0) },
];

export function compare(baseline, current, { maxDrop = 0.05 } = {}) {
  const rows = SUB_METRICS.map((metric) => {
    const before = metric.of(baseline);
    const after = metric.of(current);
    const worsened = metric.invert ? after > before : after < before;
    const base = Math.abs(before) || 1;
    const drop = worsened ? (metric.invert ? after - before : before - after) / base : 0;
    return {
      id: metric.id,
      label: metric.label,
      before,
      after,
      drop: Math.round(drop * 1000) / 1000,
      ok: drop <= maxDrop,
    };
  });
  return { ok: rows.every((row) => row.ok), maxDrop, rows };
}
