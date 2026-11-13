import { parseUrl } from "./guard.mjs";

const LEVELS = ["strict", "balanced", "fast"];
export function normalizeHost(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  // 带任何 scheme 的都交给 parseUrl：它把 data/about/file 归并为 local。
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return parseUrl(withScheme).host.toLowerCase().replace(/^www\./, "");
}

export function matchSite(host, keys) {
  const h = normalizeHost(host);
  if (!h) return null;
  const hits = (keys || []).filter((key) => h === key || h.endsWith(`.${key}`));
  if (!hits.length) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

export function downgrade(level) {
  const index = LEVELS.indexOf(level);
  if (index <= 0) return "strict";
  return LEVELS[index - 1];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
    }
  }
  return out;
}

export function resolve(url, cfg = {}) {
  const host = normalizeHost(url);
  const sites = cfg.sites || {};
  const profiles = cfg.profiles || {};
  const local = cfg.local || {};
  const siteKey = matchSite(host, Object.keys(sites));

  if (!siteKey) {
    const profile = cfg.unknown?.profile || "strict";
    const effective = deepMerge(profiles[profile], cfg.unknown?.overrides, local["*"]);
    return { host, siteKey: null, profile, effective };
  }

  const entry = sites[siteKey] || {};
  const profile = entry.profile || cfg.defaultProfile || "balanced";
  const effective = deepMerge(profiles[profile], entry.overrides, local[siteKey], local["*"]);
  return { host, siteKey, profile, effective };
}
