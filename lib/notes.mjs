// 站点经验的分层规则：site 专属 / global 通用。
// 判定是机械的：kind 白名单 + 无 selector + 跨站点独立命中次数。
// 不做语义判断，保证同样的输入永远得到同样的结论。

const URL = /https?:\/\/\S+/gi;
const SELECTOR = /\b(css|role|href)=[^\s，。；、]+/gi;
const DOMAIN = /\b([a-z0-9-]+\.)+[a-z]{2,}\b/gi;

// selector 天然站点专属；pitfall 描述的是某个页面的坑，也不该跨站复制。
export const GLOBAL_KINDS = ["hint", "timing"];

export function normalizeNoteText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(URL, " ")
    .replace(SELECTOR, " ")
    .replace(DOMAIN, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 200);
}

export function globallyAllowed(kind, selector) {
  return GLOBAL_KINDS.includes(String(kind || "")) && !String(selector || "").trim();
}

// 晋升时把站点专有名词抹掉，免得通用经验里还带着某个域名。
export function cleanNoteText(text) {
  return String(text ?? "")
    .replace(URL, " ")
    .replace(SELECTOR, "该控件")
    .replace(DOMAIN, " ")
    .replace(/\s+/g, " ")
    .replace(/在\s*上/g, "在本站")
    .trim()
    .slice(0, 500);
}

// rows: site_notes 行。返回可以晋升为 global 的经验。
export function promotionCandidates(rows, { minSites = 2, minHitsPerSite = 2 } = {}) {
  const byNorm = new Map();
  for (const row of rows || []) {
    if (row.scope && row.scope !== "site") continue;
    if (!globallyAllowed(row.kind, row.selector)) continue;
    const norm = row.norm || normalizeNoteText(row.text);
    if (!norm) continue;
    if (!byNorm.has(norm)) {
      byNorm.set(norm, { norm, kind: row.kind, text: String(row.text || ""), hits: new Map() });
    }
    const agg = byNorm.get(norm);
    const key = row.platform || row.host || "";
    agg.hits.set(key, Math.max(Number(row.hits || 0), agg.hits.get(key) || 0));
  }

  const out = [];
  for (const agg of byNorm.values()) {
    const sites = [...agg.hits.entries()].filter(([, hits]) => hits >= minHitsPerSite).map(([site]) => site);
    if (sites.length >= minSites) {
      out.push({ norm: agg.norm, kind: agg.kind, text: agg.text, sites });
    }
  }
  return out;
}
