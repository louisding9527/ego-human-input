// 观测：把事件流水折算成可用于判定的行为统计。
// 纯函数，输入 events 行，输出可断言的结构。不做任何 I/O。

const WRITE_ACTIONS = new Set(["click", "type", "press", "nav", "focus"]);

export function median(values) {
  const list = (values || []).map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = list.length / 2;
  return list.length % 2 ? list[mid - 0.5] : (list[mid - 1] + list[mid]) / 2;
}

const flagOf = (row) => String(row?.flags || "");

export function observe(events) {
  const rows = (events || []).filter((row) => !String(row?.action || "").startsWith("alert_"));
  const byAction = {};
  for (const row of rows) byAction[row.action] = (byAction[row.action] || 0) + 1;

  const reads = rows.filter((row) => row.action === "read").length;
  const writes = rows.filter((row) => WRITE_ACTIONS.has(row.action)).length;

  // landing_px 只对点击有意义；老库的行该列为 0，用 has_landing 区分「没记」和「正好居中」。
  const clicks = rows.filter((row) => row.action === "click" || row.action === "search");
  const landings = clicks.map((row) => Number(row.landing_px ?? 0));
  const measured = clicks.filter((row) => Number(row.move_points ?? 0) > 0);
  const zeroLanding = measured.filter((row) => Number(row.landing_px ?? 0) <= 0).length;

  const moves = rows.filter((row) => Number(row.move_points ?? 0) > 0).map((row) => Number(row.move_points));
  const travels = rows.filter((row) => Number(row.travel_px ?? 0) > 0).map((row) => Number(row.travel_px));

  return {
    n: rows.length,
    byAction,
    reads,
    writes,
    readWriteRatio: writes ? reads / writes : 0,
    failures: rows.filter((row) => row.ok === 0 || row.ok === false).length,
    failRate: rows.length ? rows.filter((row) => row.ok === 0 || row.ok === false).length / rows.length : 0,
    details: rows.filter((row) => row.action === "detail").length,
    clicks: clicks.length,
    measuredClicks: measured.length,
    landing: {
      n: measured.length,
      zeroCount: zeroLanding,
      zeroRate: measured.length ? zeroLanding / measured.length : 0,
      medianPx: median(landings),
      minPx: landings.length ? Math.min(...landings) : null,
      maxPx: landings.length ? Math.max(...landings) : null,
    },
    move: {
      n: moves.length,
      minPoints: moves.length ? Math.min(...moves) : null,
      medianPoints: median(moves),
      minTravelPx: travels.length ? Math.min(...travels) : null,
    },
    untrusted: rows.filter((row) => flagOf(row).includes("untrusted")).length,
    degraded: rows.filter((row) => flagOf(row).includes("degraded")).length,
  };
}
