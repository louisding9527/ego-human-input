// 契约层入口：把配置、状态、纯函数和动作层拼成一个句柄。
// 这里只做装配与编排，不含指针轨迹、时序采样与事后校验（在 actions.mjs）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolveProfile } from "./profile.mjs";
import { createBucket, take } from "./bucket.mjs";
import { openStore } from "./store.mjs";
import { createMachine } from "./alert.mjs";
import { HumanBlocked, HumanWarn } from "./errors.mjs";
import { parseUrl } from "./guard.mjs";
import { createBrowser } from "./browser.mjs";
import { createActions } from "./actions.mjs";
import { createRecipes } from "./recipes.mjs";
import { createSession } from "./session.mjs";
import { createTiming } from "./timing.mjs";

export { parseLocator } from "./locator.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(homedir(), ".ego-human-input");
const SKILL_VER = "0.7.0";
const NOOP_WINDOW_MS = 30 * 60000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadConfig() {
  const base = await loadJson(join(SKILL_DIR, "profiles", "base.json"), { profiles: {} });
  const sites = await loadJson(join(SKILL_DIR, "profiles", "sites.json"), {});
  const local = await loadJson(join(STATE_DIR, "overrides.json"), {});
  return {
    profiles: base.profiles,
    defaultProfile: base.defaultProfile,
    unknown: base.unknown,
    sites,
    local: local.sites || {},
  };
}

const hourOf = (ts) => Math.floor(ts / 3600000);

function budgetOf(profile, action) {
  const b = profile.budget && profile.budget[action];
  if (!b) return null;
  return { perHour: b.perHour || 0, gap: b.gap || null };
}

export async function create(page, options = {}) {
  const browser = options.browser || createBrowser(page);
  const rand = options.rand || Math.random;
  const sleep = options.sleep || realSleep;
  const now = options.now || Date.now;

  const cfg = await loadConfig();
  const url0 = await browser.url();
  const baseHost = parseUrl(url0).host;
  const site = resolveProfile(
    url0,
    options.profile
      ? { ...cfg, sites: Object.fromEntries(Object.keys(cfg.sites).map((k) => [k, { ...cfg.sites[k], profile: options.profile }])) }
      : cfg,
  );
  const profile = site.effective;
  const platformKey = site.siteKey || baseHost;
  const timing = createTiming({ rand, ...(profile.timing || {}) });

  const store = options.store || openStore(options.dbPath);
  const runId = store.startRun({ host: baseHost, profile: site.profile, ver: SKILL_VER });
  const machine = createMachine({ store, host: baseHost, now });

  const healthRaw = await browser.health();
  const warnings = [];
  if (healthRaw.webdriver) warnings.push("navigator.webdriver=true，连接方式不像真实浏览器会话");
  if (/Headless/i.test(healthRaw.ua || "")) warnings.push("UA 含 Headless 标记");
  const health = { ...healthRaw, warnings };

  const timeline = [];
  const channel = `hi:${randomBytes(6).toString("hex")}`;
  const sentinel = { last: { untrusted: 0, silentWrite: 0, mutations: 0 }, lost: false };
  let seq = 0;
  let session = null;
  let budget = createBucket(profile.rate || {}, now());
  const state = {
    frozen: false,
    cursor: { x: Math.round(health.vw * 0.4), y: Math.round(health.vh * 0.4) },
    viewport: { w: health.vw, h: health.vh },
    lastUrl: url0,
    lastActionAt: 0,
  };

  const record = (kind, detail) => timeline.push({ t: new Date(now()).toISOString(), kind, detail });

  try {
    await browser.installProbe(channel);
  } catch {
    record("probe", { degraded: "no-probe" });
  }

  function logAction(action, info = {}) {
    seq += 1;
    session?.count(action);
    const path = parseUrl(String(info.url || state.lastUrl)).path;
    const { url, ...rest } = info;
    store.addEvent({
      runId,
      seq,
      host: baseHost,
      path,
      action,
      targetKind: rest.targetKind || "",
      targetHash: rest.targetHash || "",
      ok: rest.ok !== false,
      ms: rest.ms || 0,
      flags: rest.flags || [],
      kwHash: rest.kwHash || "",
      resultFp: rest.resultFp || "",
      resultN: rest.resultN || 0,
      landingPx: rest.landingPx || 0,
      movePoints: rest.movePoints || 0,
      travelPx: rest.travelPx || 0,
      meta: rest.meta,
    });
    // 时间线只写 pathname：导航 URL 的 query 可能带关键词，落盘即泄露。
    record(action, { path, ...rest });
  }

  // 闸门：会话形状 / 冷却 / 小时配额 / 间隔 / 令牌桶。
  // 配额在这里预留，动作没真正发生时要释放。
  async function gate(action = "write") {
    if (state.frozen) throw new HumanBlocked({ trigger: "frozen" });
    const { pace } = await session.before(action);
    const wait = machine.gate();
    if (wait > 0) await sleep(wait);
    // 只搜不开是最好认的机器人形状：连续搜索到配额后必须有详情页，否则停手。
    if (action === "search") {
      const requireAfter = Number(profile.search?.requireDetailAfter || 0);
      if (requireAfter > 0) {
        const recent = store.metrics(baseHost, { windowMs: NOOP_WINDOW_MS, now: now() });
        if (recent.consecutiveSearch >= requireAfter && recent.detailSinceSearch === 0) {
          machine.soft("search_no_detail", { evidence: { consecutive: recent.consecutiveSearch } });
          throw new HumanWarn({
            trigger: "search-no-detail",
            consecutive: recent.consecutiveSearch,
            requireDetailAfter: requireAfter,
          });
        }
      }
    }
    const conf = budgetOf(profile, action);
    let reserved = null;
    if (conf?.perHour) {
      const hour = hourOf(now());
      const used = store.budgetRead(baseHost, action, hour);
      if (used.used >= conf.perHour && used.limit === conf.perHour) {
        machine.soft("budget", { evidence: { action, used: used.used, perHour: conf.perHour } });
        throw new HumanWarn({ trigger: "budget", action, used: used.used, perHour: conf.perHour });
      }
      reserved = { action, hour };
    }
    const gap = conf?.gap || profile.rate?.minGapMs;
    if (gap && state.lastActionAt) {
      const delta = state.lastActionAt + timing.ms(gap, "gap") * pace - now();
      if (delta > 0) await sleep(delta);
    }
    const slot = take(budget, now());
    budget = slot.state;
    if (slot.waitMs > 0) await sleep(slot.waitMs);
    state.lastActionAt = now();
    if (!reserved) return { used: 0, release: () => {} };
    const after = store.budgetTake(baseHost, reserved.action, reserved.hour, conf.perHour);
    return {
      used: after.used,
      release: () => {
        if (!reserved) return;
        store.budgetRelease(baseHost, reserved.action, reserved.hour);
        reserved = null;
      },
    };
  }

  const actions = createActions({
    browser,
    machine,
    profile,
    state,
    host: baseHost,
    channel,
    sentinel,
    log: logAction,
    record,
    gate,
    sleep,
    rand,
    now,
    timing,
    countNoop: (targetHash) => store.countNoop(baseHost, targetHash, now() - NOOP_WINDOW_MS),
  });

  session = createSession({
    profile,
    store,
    host: baseHost,
    now,
    rand,
    sleep,
    timing,
    read: (seconds) => actions.read(seconds),
  });

  const handles = createRecipes({
    store,
    platformKey,
    baseHost,
    actions,
    browser,
    log: logAction,
    now,
    lastUrl: () => state.lastUrl,
  });

  const inspect = {
    rect: (locator) => browser.box(locator),
    text: (locator, max = 120) => browser.text(locator, max),
    pageState: () => browser.pageState(),
    sentinel: () => actions.readSentinel(),
    requests: (limit = 20) => browser.requests(limit),
    query(sql, params = []) {
      const text = String(sql).trim();
      if (!/^select\b/i.test(text)) throw new Error("inspect.query: only SELECT is allowed");
      return store.db.prepare(text).all(...params);
    },
  };

  async function flush(outcome = "done") {
    const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, "");
    const file = join(STATE_DIR, `timeline-${day}.jsonl`);
    await mkdir(STATE_DIR, { recursive: true });
    if (timeline.length) {
      const lines = timeline.map((item) => JSON.stringify(item)).join("\n");
      await writeFile(file, `${lines}\n`, { flag: "a" });
    }
    store.endRun(runId, outcome);
    if (!options.store) store.close();
    return { written: timeline.length, runId };
  }

  // 落地先看：第一个动作之前先坐一会儿。
  await session.dwell();

  return {
    health,
    timeline,
    runId,
    site: () => ({ host: site.host, siteKey: site.siteKey, profile: site.profile }),
    params: () => profile,
    inspect,
    move: actions.move,
    goto: actions.goto,
    focus: actions.focus,
    click: actions.click,
    type: actions.type,
    press: actions.press,
    clearField: actions.clearField,
    waitFor: actions.waitFor,
    read: actions.read,
    scroll: actions.scrollOnce,
    note: handles.note,
    notes: handles.notes,
    run: handles.run,
    saveRecipe: handles.saveRecipe,
    recipes: handles.recipes,
    gate,
    session: () => session.shape(),
    triage: () => machine.triage({ evidence: { url: state.lastUrl } }),
    state: () => machine.state(),
    decide: (payload) => machine.decide(payload),
    alerts: () => store.pendingAlerts(baseHost),
    flush,
  };
}

export const human = { create };
