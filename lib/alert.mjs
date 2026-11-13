import { scoreMetrics, classifyScore } from "./score.mjs";
import { HumanWarn, HumanBlocked } from "./errors.mjs";

export const STATES = { normal: "normal", warn: "warn", escalated: "escalated", halted: "halted" };

const DEDUPE_MS = 5 * 60 * 1000;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const COOLDOWN = {
  continue: [60, 120],
  backoff: [600, 1200],
  abort: [7200, 7200],
};

export function createMachine({ store, host, now = () => Date.now(), rand = Math.random } = {}) {
  let state = STATES.normal;
  let until = 0;
  let activeAlert = null;
  let lastTriggerAt = 0;
  let lastTrigger = "";

  const seconds = ([lo, hi]) => (lo + rand() * (hi - lo)) * 1000;

  function openAlert({ trigger, level, rule, evidence }) {
    if (activeAlert) {
      const row = store.getAlert(activeAlert);
      if (row && now() - row.ts < DEDUPE_MS) return activeAlert;
    }
    activeAlert = store.addAlert({
      runId: evidence?.runId || "",
      host,
      level: level || "high",
      trigger,
      evidence,
      ruleDecision: rule || "",
    });
    return activeAlert;
  }

  function stateView() {
    return { state, until, alertId: activeAlert, retryAfterMs: Math.max(0, until - now()) };
  }

  function fails() {
    return state === STATES.warn || state === STATES.escalated;
  }

  function escalate(trigger, { level = "high", evidence = {} } = {}) {
    lastTrigger = trigger;
    lastTriggerAt = now();
    openAlert({ trigger, level, rule: "abort", evidence });
    state = STATES.escalated;
    return stateView();
  }

  function soft(trigger, { evidence = {} } = {}) {
    lastTrigger = trigger;
    lastTriggerAt = now();
    if (!fails()) {
      openAlert({ trigger, level: "medium", rule: "backoff", evidence });
      state = STATES.warn;
    }
    return stateView();
  }

  function triage({ sentinel = {}, windowMs = 30 * 60 * 1000, evidence = {} } = {}) {
    const base = store.metrics(host, { windowMs, now: now() });
    const metrics = { ...base, ...sentinel };
    const scored = scoreMetrics(metrics);
    const rule = classifyScore(scored.score);
    if (state === STATES.normal && scored.score >= 30) {
      lastTrigger = "score";
      lastTriggerAt = now();
      openAlert({
        trigger: "score",
        level: scored.score >= 70 ? "high" : "medium",
        rule,
        evidence: { ...evidence, score: scored.score, suspects: scored.suspects },
      });
      state = STATES.warn;
    }
    return { ...scored, rule, metrics };
  }

  function decide({ decision, by = "agent", reason = "" } = {}) {
    const allowed = ["continue", "backoff", "abort"];
    if (!allowed.includes(decision)) throw new Error(`unknown decision: ${decision}`);
    if (activeAlert) {
      store.decideAlert(activeAlert, { decision, by, reason });
      activeAlert = null;
    }
    if (decision === "continue") {
      state = STATES.normal;
      until = now() + seconds(COOLDOWN.continue);
    } else if (decision === "backoff") {
      state = STATES.halted;
      until = now() + seconds(COOLDOWN.backoff);
      store.setHostState(host, { mode: "backoff", until, reason });
    } else {
      state = STATES.halted;
      until = now() + seconds(COOLDOWN.abort);
      store.setHostState(host, { mode: "abort", until, reason });
    }
    return stateView();
  }

  function autoResolve() {
    if (!activeAlert) return null;
    const row = store.getAlert(activeAlert);
    if (!row) return null;
    const rule = row.rule_decision || "backoff";
    if (now() - row.ts < AGENT_TIMEOUT_MS) return null;
    return decide({ decision: rule, by: "timeout", reason: `no agent decision in ${AGENT_TIMEOUT_MS / 60000}min` });
  }

  function resolve() {
    if (state === STATES.halted && now() >= until) {
      state = STATES.normal;
      until = 0;
      store.setHostState(host, { mode: "normal", until: 0, reason: "" });
    }
    autoResolve();
  }

  function gate() {
    resolve();
    if (state === STATES.halted) {
      if (now() < until) {
        throw new HumanWarn({
          trigger: "cooldown",
          retryAfterMs: until - now(),
          alertId: activeAlert,
          message: `cooldown until ${new Date(until).toISOString()}`,
        });
      }
      state = STATES.normal;
    }
    if (fails()) {
      throw new HumanWarn({
        trigger: lastTrigger || "warn",
        alertId: activeAlert,
        message: "paused for review; run tools/alert.mjs show",
      });
    }
    if (until && now() < until) return until - now();
    return 0;
  }

  const saved = store.hostState ? store.hostState(host) : null;
  if (saved && saved.mode && saved.mode !== "normal" && Number(saved.until) > now()) {
    state = STATES.halted;
    until = Number(saved.until);
  }

  return {
    host,
    state: stateView,
    escalate,
    soft,
    triage,
    decide,
    gate,
    resolve,
    lastTrigger: () => ({ trigger: lastTrigger, at: lastTriggerAt }),
  };
}
