export const WEIGHTS = {
  searchBurst: 30,
  searchNoDetail: 25,
  searchSameFp: 20,
  searchIntervalCv: 15,
  chainRepeat: 15,
  failRate: 15,
  alerts7d: 10,
  orphanRequestEach: 5,
  orphanRequestCap: 15,
  silentWriteEach: 5,
  silentWriteCap: 10,
};

export const BANDS = { continue: 30, backoff: 70 };

export function intervalCv(values) {
  const list = (values || []).filter((v) => Number.isFinite(v));
  if (list.length < 2) return null;
  const mean = list.reduce((sum, v) => sum + v, 0) / list.length;
  if (mean <= 0) return null;
  const variance = list.reduce((sum, v) => sum + (v - mean) ** 2, 0) / list.length;
  return Math.sqrt(variance) / mean;
}

export function sequenceRepeatRate(paths, gram = 3) {
  const list = (paths || []).filter(Boolean);
  if (list.length < gram) return 0;
  const seen = new Set();
  let repeated = 0;
  let total = 0;
  for (let i = 0; i + gram <= list.length; i += 1) {
    const key = list.slice(i, i + gram).join(">");
    total += 1;
    if (seen.has(key)) repeated += 1;
    seen.add(key);
  }
  return total ? repeated / total : 0;
}

export function failRate(events) {
  const list = events || [];
  if (!list.length) return 0;
  const failed = list.filter((e) => e.ok === 0 || e.ok === false).length;
  return failed / list.length;
}

export function editDistance(a, b) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  if (s === t) return 0;
  if (!s.length || !t.length) return Math.max(s.length, t.length);
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

export function scoreMetrics(m = {}) {
  const suspects = [];
  let score = 0;
  const add = (points, tag) => {
    score += points;
    suspects.push(tag);
  };

  if ((m.searchIn10m || 0) >= 3) add(WEIGHTS.searchBurst, "search_burst");
  if ((m.consecutiveSearch || 0) >= 5 && (m.detailSinceSearch || 0) === 0) add(WEIGHTS.searchNoDetail, "search_no_detail");
  if ((m.sameFingerprint || 0) >= 1) add(WEIGHTS.searchSameFp, "search_same_fp");

  const cv = intervalCv(m.searchIntervals);
  if (cv !== null && cv < 0.2) add(WEIGHTS.searchIntervalCv, "search_interval_cv");
  if ((m.chainRepeat || 0) > 0.6) add(WEIGHTS.chainRepeat, "chain_repeat");
  if ((m.failRate || 0) > 0.3) add(WEIGHTS.failRate, "fail_rate");
  if ((m.alerts7d || 0) >= 3) add(WEIGHTS.alerts7d, "alerts_7d");

  const orphan = Math.min(WEIGHTS.orphanRequestCap, (m.orphanRequests || 0) * WEIGHTS.orphanRequestEach);
  if (orphan > 0) {
    score += orphan;
    suspects.push("orphan_request");
  }
  const silent = Math.min(WEIGHTS.silentWriteCap, (m.silentWrites || 0) * WEIGHTS.silentWriteEach);
  if (silent > 0) {
    score += silent;
    suspects.push("silent_write");
  }

  return { score: Math.min(100, score), suspects };
}

export function classifyScore(score) {
  if (score >= BANDS.backoff) return "abort";
  if (score >= BANDS.continue) return "backoff";
  return "continue";
}
