import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { classifyUrl, isApiEndpoint, shortHash } from "../lib/guard.mjs";
import { intervalCv, sequenceRepeatRate, editDistance, scoreMetrics, classifyScore } from "../lib/score.mjs";
import { openStore } from "../lib/store.mjs";
import { createMachine, STATES } from "../lib/alert.mjs";
import { lintSource } from "../tools/lint-script.mjs";
import { interpolate, validateSteps, missingParams, MissingParamError } from "../lib/recipe.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmpDb = () => join(tmpdir(), `hi-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);

test("classifyUrl flags challenge hosts, paths, drift and login", () => {
  assert.equal(classifyUrl("https://safe.liepin.com/x", "h.liepin.com").reason, "challenge-host");
  assert.equal(classifyUrl("https://h.liepin.com/page/liepin/captchaPage_PC", "h.liepin.com").reason, "challenge-path");
  assert.equal(classifyUrl("https://h.liepin.com/v/intercept/blankpage", "h.liepin.com").reason, "challenge-path");
  assert.equal(classifyUrl("https://evil.com/x", "h.liepin.com").reason, "host-drift");
  assert.equal(classifyUrl("https://h.liepin.com/login", "h.liepin.com").reason, "login-required");
  const ok = classifyUrl("https://h.liepin.com/resume/showresumedetail", "h.liepin.com");
  assert.equal(ok.ok, true);
  assert.equal(ok.host, "h.liepin.com");
});

test("isApiEndpoint catches form endpoints used as data APIs", () => {
  assert.equal(isApiEndpoint("https://h.liepin.com/search/getConditionItem"), true);
  assert.equal(isApiEndpoint("https://h.liepin.com/api/v1/list"), true);
  assert.equal(isApiEndpoint("https://h.liepin.com/resumemanage/showmytalentlist"), false);
});

test("shortHash is stable and short", () => {
  assert.equal(shortHash("制造总监"), shortHash("制造总监"));
  assert.equal(shortHash("制造总监").length, 8);
  assert.notEqual(shortHash("制造总监"), shortHash("供应链总监"));
});

test("intervalCv and repeat rate behave at boundaries", () => {
  assert.equal(intervalCv([10, 10, 10]), 0);
  assert.ok(intervalCv([10, 30]) > 0.4);
  assert.equal(intervalCv([5]), null);
  assert.equal(sequenceRepeatRate(["a", "b", "c"], 3), 0);
  assert.ok(sequenceRepeatRate(["a", "b", "c", "a", "b", "c"], 3) >= 0.25);
});

test("editDistance detects near duplicate keywords", () => {
  assert.equal(editDistance("制造总监", "制造总监"), 0);
  assert.equal(editDistance("制造总监", "制造主管"), 2);
  assert.ok(editDistance("制造总监", "供应链总监") > 2);
});

test("search burst alone crosses the warn band", () => {
  const scored = scoreMetrics({ searchIn10m: 3, searchIntervals: [15, 15, 15] });
  assert.ok(scored.score >= 30);
  assert.ok(scored.suspects.includes("search_burst"));
  assert.equal(classifyScore(scored.score), "backoff");
});

test("score is capped and abort band reached by stacking features", () => {
  const scored = scoreMetrics({
    searchIn10m: 5,
    consecutiveSearch: 6,
    detailSinceSearch: 0,
    sameFingerprint: 2,
    searchIntervals: [15, 15, 16],
    chainRepeat: 0.9,
    failRate: 0.5,
    alerts7d: 5,
  });
  assert.equal(scored.score, 100);
  assert.equal(classifyScore(scored.score), "abort");
});

test("store records events, aggregates metrics and enforces budget", () => {
  const file = tmpDb();
  const store = openStore(file);
  const t = Date.now();
  const runId = store.startRun({ host: "h.liepin.com", profile: "balanced", ver: "0.2.0" });
  for (let i = 0; i < 3; i += 1) {
    store.addEvent({ ts: t - i * 15000, runId, host: "h.liepin.com", path: "/search", action: "search", ok: 1, resultFp: "aa" });
  }
  store.addEvent({ ts: t, runId, host: "h.liepin.com", path: "/resume/1", action: "detail", ok: 0 });

  const m = store.metrics("h.liepin.com", { windowMs: 3600000, now: t + 1000 });
  assert.equal(m.byAction.search, 3);
  assert.equal(m.searchIn10m, 3);
  assert.ok(m.sameFingerprint >= 1);
  assert.ok(m.failRate > 0);

  const hour = Math.floor(t / 3600000);
  const first = store.budgetTake("h.liepin.com", "search", hour, 2);
  const second = store.budgetTake("h.liepin.com", "search", hour, 2);
  assert.equal(first.used, 1);
  assert.equal(second.used, 2);

  // 预留-确认两段式：失败路径把预留还回去，且归还不会把用量压到负数。
  assert.equal(store.budgetRelease("h.liepin.com", "search", hour).used, 1);
  store.budgetRelease("h.liepin.com", "search", hour);
  assert.equal(store.budgetRelease("h.liepin.com", "search", hour).used, 0);
  assert.equal(store.budgetRead("h.liepin.com", "search", hour).used, 0);

  // 配额上限以最后一次预留为准，不在冲突时保留旧值。
  store.budgetTake("h.liepin.com", "search", hour, 5);
  assert.equal(store.budgetRead("h.liepin.com", "search", hour).limit, 5);

  const alertId = store.addAlert({ runId, host: "h.liepin.com", level: "high", trigger: "challenge", evidence: { url: "x" }, ruleDecision: "abort" });
  assert.equal(store.pendingAlerts("h.liepin.com").length, 1);
  store.decideAlert(alertId, { decision: "abort", by: "agent", reason: "test" });
  assert.equal(store.pendingAlerts("h.liepin.com").length, 0);
  assert.equal(store.getAlert(alertId).final_decision, "abort");

  store.close();
  rmSync(file, { force: true });
});

test("machine escalates, blocks gate, and honours decisions", () => {
  const file = tmpDb();
  const store = openStore(file);
  let t = 1000;
  const machine = createMachine({ store, host: "h.liepin.com", now: () => t, rand: () => 0 });

  assert.equal(machine.state().state, STATES.normal);
  assert.equal(machine.gate(), 0);

  machine.escalate("challenge-path", { evidence: { url: "safe" } });
  assert.equal(machine.state().state, STATES.escalated);
  assert.throws(() => machine.gate(), /paused|cooldown/);

  machine.decide({ decision: "abort", by: "agent", reason: "challenge" });
  assert.equal(machine.state().state, STATES.halted);
  assert.throws(() => machine.gate(), /cooldown/);

  t += 3 * 3600 * 1000;
  assert.equal(machine.gate(), 0);
  assert.equal(machine.state().state, STATES.normal);

  store.close();
  rmSync(file, { force: true });
});

test("machine opens an alert when score crosses the band", () => {
  const file = tmpDb();
  const store = openStore(file);
  const t = Date.now();
  const runId = store.startRun({ host: "h.liepin.com", profile: "balanced", ver: "0.2.0" });
  for (let i = 0; i < 3; i += 1) {
    store.addEvent({ ts: t - i * 15000, runId, host: "h.liepin.com", path: "/search", action: "search", ok: 1 });
  }
  const machine = createMachine({ store, host: "h.liepin.com", now: () => t + 1000, rand: () => 0 });
  const result = machine.triage({ evidence: { url: "h" } });
  assert.ok(result.score >= 30);
  assert.equal(machine.state().state, STATES.warn);
  assert.equal(store.pendingAlerts("h.liepin.com").length, 1);

  store.close();
  rmSync(file, { force: true });
});

test("site notes are scoped by platform, intent and kind", () => {
  const file = tmpDb();
  const store = openStore(file);
  const a = store.addNote({ platform: "liepin.com", host: "h.liepin.com", intent: "search", kind: "pitfall", text: "先按 Enter 再点搜索", selector: "css=#rc_select_1" });
  const b = store.addNote({ platform: "liepin.com", host: "h.liepin.com", intent: "search", kind: "pitfall", text: "先按 Enter 再点搜索" });
  assert.equal(a, b);
  store.addNote({ platform: "liepin.com", intent: "*", kind: "hint", text: "登录态在 h. 子域" });
  store.addNote({ platform: "zhipin.com", intent: "search", kind: "hint", text: "另一个平台的经验" });

  const scoped = store.listNotes("liepin.com", { intent: "search" });
  assert.equal(scoped.length, 2, "intent 查询应带回该意图与通用经验");
  assert.equal(scoped[0].intent, "search");
  assert.equal(scoped[0].hits, 2);

  const pitfalls = store.listNotes("liepin.com", { intent: "search", kind: "pitfall" });
  assert.equal(pitfalls.length, 1);
  assert.equal(store.listNotes("zhipin.com").length, 1);
  assert.equal(store.listNotes("liepin.com", { intent: "favorite" }).length, 1, "无关意图只带通用经验");

  store.close();
  rmSync(file, { force: true });
});

test("recipes interpolate params, validate ops and version up", () => {
  const file = tmpDb();
  const store = openStore(file);
  const steps = [
    { op: "click", target: "role:link[name='找人']", as: "nav" },
    { op: "type", text: "{{kw}}" },
    { op: "press", key: "Enter" },
  ];
  assert.deepEqual(validateSteps(steps), []);
  const filled = interpolate(steps[1], { kw: "供应链总监" });
  assert.equal(filled.text, "供应链总监");

  // 缺参数：默认仍是宽松替换，strict 才抛，run() 走 strict。
  assert.equal(interpolate(steps[1], {}).text, "");
  assert.throws(() => interpolate(steps[1], {}, { strict: true }), MissingParamError);
  assert.deepEqual(missingParams(steps, {}), ["kw"]);
  assert.deepEqual(missingParams(steps, { kw: "x" }), []);

  assert.ok(validateSteps([{ op: "nope" }]).length > 0);
  assert.ok(validateSteps([{ op: "click" }]).length > 0);

  const first = store.saveRecipe({ host: "h.liepin.com", intent: "search", steps });
  assert.equal(first.version, 1);
  const second = store.saveRecipe({ host: "h.liepin.com", intent: "search", steps });
  assert.equal(second.version, 2);
  const row = store.getRecipe("h.liepin.com", "search");
  assert.equal(JSON.parse(row.steps).length, 3);
  store.bumpRecipe(row.id, true);
  store.bumpRecipe(row.id, false);
  const listed = store.listRecipes("h.liepin.com");
  assert.equal(listed[0].ok_count, 1);
  assert.equal(listed[0].fail_count, 1);

  store.close();
  rmSync(file, { force: true });
});

test("lint blocks non-human writes and allows reads", () => {
  const bad = [
    'await page.evaluate(() => document.querySelector("a").click());',
    'const el = await page.$("a"); el.dispatchEvent(new MouseEvent("click"));',
    'await page.fill("#q", "x"); document.querySelector("#q").value = "y";',
    'await page.fetch("/api/list");',
    'localStorage.setItem("k", "v");',
    'document.querySelector("#a").scrollIntoView();',
  ];
  for (const line of bad) assert.ok(lintSource(line).length > 0, `expected violation: ${line}`);

  const good = [
    'const h = await human.create(page);',
    'await h.click("loc=role:button[name=\'搜索\']");',
    'await h.type("制造总监");',
    'const box = await h.inspect.rect("css=#a");',
    'await h.inspect.query("select count(*) from events");',
    '// page.evaluate is documented here only',
  ];
  for (const line of good) assert.equal(lintSource(line).length, 0, `unexpected violation: ${line}`);
});

test("examples 里的脚本过 lint", () => {
  for (const file of ["examples/liepin-search.mjs", "examples/timeline.mjs"]) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    assert.deepEqual(lintSource(source), [], `${file} 有违规写法`);
  }
});
