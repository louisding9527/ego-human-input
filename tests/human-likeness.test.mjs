import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { landingPoint } from "../lib/trace.mjs";
import { observe, median } from "../lib/observe.mjs";
import { evaluate, compare } from "../lib/verify.mjs";
import { normalizeNoteText, promotionCandidates } from "../lib/notes.mjs";
import { parseLocator } from "../lib/human.mjs";
import { openStore } from "../lib/store.mjs";

const tmpDb = () => {
  const file = join(tmpdir(), `ehi-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  return file;
};

const seeded = (seed = 1) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

const THRESHOLDS = {
  assertions: {
    untrustedMax: 0,
    degradedMax: 0,
    landingZeroRateMax: 0.1,
    landingMedianPxMin: 3,
    movePointsMin: 10,
    readWriteRatioMin: 0.25,
  },
  regression: { subMetricDropMax: 0.05 },
};

test("locator parsing accepts css, href, role and bare selectors", () => {
  assert.deepEqual(parseLocator("css=#a .b"), { kind: "css", value: "#a .b" });
  assert.deepEqual(parseLocator("loc=css=#a"), { kind: "css", value: "#a" });
  assert.deepEqual(parseLocator("href=/resume/1"), { kind: "href", value: "/resume/1" });
  assert.deepEqual(parseLocator("role:button[name='搜 索']"), {
    kind: "role",
    value: { role: "button", name: "搜 索" },
  });
  assert.deepEqual(parseLocator(".card"), { kind: "css", value: ".card" });
});

test("landing point offsets from the element centre and stays inside", () => {
  const box = { x: 100, y: 100, w: 200, h: 80 };
  const point = landingPoint(box, { rand: seeded(7) });
  assert.equal(point.inside, true);
  assert.ok(point.offsetPx >= 3, `offset too small: ${point.offsetPx}`);
  assert.ok(Math.abs(point.x - box.x) <= box.w / 2);
  assert.ok(Math.abs(point.y - box.y) <= box.h / 2);

  const offsets = Array.from({ length: 50 }, (_, i) => landingPoint(box, { rand: seeded(i + 1) }).offsetPx);
  assert.ok(median(offsets) > 5, "median offset should not hug the centre");
  assert.equal(new Set(offsets.map((value) => Math.round(value))).size > 5, true, "offsets must vary");
});

test("tiny elements fall back to the centre and say so", () => {
  const point = landingPoint({ x: 10, y: 10, w: 6, h: 6 }, { rand: seeded(3) });
  assert.equal(point.inside, false);
  assert.equal(point.offsetPx, 0);
  assert.equal(point.x, 10);
  assert.equal(point.y, 10);
});

test("observe folds events into assertable statistics", () => {
  const events = [
    { action: "click", ok: 1, landing_px: 8, move_points: 24, travel_px: 300 },
    { action: "click", ok: 1, landing_px: 0, move_points: 20, travel_px: 200 },
    { action: "read", ok: 1, move_points: 14, travel_px: 120 },
    { action: "type", ok: 0, flags: "type" },
    { action: "sentinel", ok: 0, flags: "untrusted" },
  ];
  const o = observe(events);
  assert.equal(o.n, 5);
  assert.equal(o.reads, 1);
  assert.equal(o.writes, 3, "click x2 + type; read and sentinel are not writes");
  assert.equal(Math.round(o.readWriteRatio * 100) / 100, 0.33);
  assert.equal(o.clicks, 2);
  assert.equal(o.landing.zeroCount, 1);
  assert.equal(o.landing.zeroRate, 0.5);
  assert.equal(o.landing.medianPx, 4);
  assert.equal(o.move.minPoints, 14);
  assert.equal(o.untrusted, 1);
  assert.ok(o.failRate > 0);
});

test("evaluate fails when the run is centred, degraded or read-free", () => {
  const clean = observe([
    { action: "click", ok: 1, landing_px: 9, move_points: 26, travel_px: 400 },
    { action: "read", ok: 1, move_points: 14, travel_px: 100 },
    { action: "read", ok: 1, move_points: 12, travel_px: 90 },
    { action: "type", ok: 1 },
  ]);
  const good = evaluate(clean, THRESHOLDS);
  assert.equal(good.ok, true);

  const centred = observe([
    { action: "click", ok: 1, landing_px: 0, move_points: 26, travel_px: 400 },
    { action: "click", ok: 1, landing_px: 0, move_points: 22, travel_px: 380 },
  ]);
  const bad = evaluate(centred, THRESHOLDS);
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.find((check) => check.id === "landing").ok === false);
  assert.ok(bad.checks.find((check) => check.id === "read-write").ok === false);
});

test("compare flags per-metric regression, not just the total", () => {
  const baseline = { readWriteRatio: 0.6, landing: { medianPx: 8 }, move: { medianPoints: 24 }, failRate: 0, untrusted: 0 };
  const same = compare(baseline, baseline);
  assert.equal(same.ok, true);

  const drifted = {
    readWriteRatio: 0.5,
    landing: { medianPx: 8 },
    move: { medianPoints: 24 },
    failRate: 0,
    untrusted: 0,
  };
  const result = compare(baseline, drifted);
  assert.equal(result.ok, false);
  assert.equal(result.rows.find((row) => row.id === "readWriteRatio").ok, false);

  const quieter = { ...baseline, untrusted: 1 };
  assert.equal(compare(baseline, quieter).ok, false, "more untrusted events must count as regression");
});

test("note normalisation ignores domains and selectors so notes can promote", () => {
  const a = normalizeNoteText("在 h.liepin.com 上，css=#rc_select_1 输入后必须按 Enter；再点搜索");
  const b = normalizeNoteText("在 www.zhipin.com 上，css=#kw 输入后必须按 Enter，再点搜索");
  assert.equal(a, b);

  const rows = [
    { platform: "liepin.com", kind: "hint", hits: 2, text: "输入后必须按 Enter 再点搜索", scope: "site" },
    { platform: "zhipin.com", kind: "hint", hits: 3, text: "输入后必须按 Enter，再点搜索", scope: "site" },
    { platform: "51job.com", kind: "hint", hits: 1, text: "输入后必须按 Enter 再点搜索", scope: "site" },
  ];
  const promoted = promotionCandidates(rows);
  assert.equal(promoted.length, 1, "two sites with >=2 hits each should qualify");
  assert.deepEqual(promoted[0].sites.sort(), ["liepin.com", "zhipin.com"]);
});

test("notes with a selector or a pitfall kind never promote", () => {
  const rows = [
    { platform: "a.com", kind: "hint", hits: 5, text: "同一条经验", selector: "css=#x", scope: "site" },
    { platform: "b.com", kind: "hint", hits: 5, text: "同一条经验", selector: "css=#y", scope: "site" },
  ];
  assert.equal(promotionCandidates(rows).length, 0);

  const pitfalls = [
    { platform: "a.com", kind: "pitfall", hits: 5, text: "同一条经验", scope: "site" },
    { platform: "b.com", kind: "pitfall", hits: 5, text: "同一条经验", scope: "site" },
  ];
  assert.equal(promotionCandidates(pitfalls).length, 0);
});

test("old databases gain the new columns and lose the unused rounds table", () => {
  const file = tmpDb();
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, seq INTEGER,
      host TEXT, path TEXT, action TEXT, target_kind TEXT, target_hash TEXT,
      ok INTEGER, ms INTEGER, flags TEXT, kw_hash TEXT, result_fp TEXT, result_n INTEGER
    );
    CREATE TABLE site_notes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, host TEXT,
      intent TEXT DEFAULT '*', kind TEXT DEFAULT 'hint', area TEXT, text TEXT,
      selector TEXT, hits INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE rounds(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, host TEXT, kind TEXT);
  `);
  legacy.close();

  const store = openStore(file);
  const eventColumns = store.db.prepare("PRAGMA table_info(events)").all().map((row) => row.name);
  assert.ok(eventColumns.includes("landing_px"));
  assert.ok(eventColumns.includes("move_points"));
  assert.ok(eventColumns.includes("travel_px"));
  const noteColumns = store.db.prepare("PRAGMA table_info(site_notes)").all().map((row) => row.name);
  assert.ok(noteColumns.includes("scope"));
  assert.ok(noteColumns.includes("norm"));
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='rounds'").get(), undefined);

  const runId = store.startRun({ host: "h.liepin.com", profile: "balanced", ver: "0.6.0" });
  store.addEvent({ runId, host: "h.liepin.com", action: "click", ok: 1, landingPx: 7.5, movePoints: 30, travelPx: 420 });
  const back = store.eventsOfRun(runId)[0];
  assert.equal(back.landing_px, 7.5);
  assert.equal(back.move_points, 30);
  assert.equal(store.latestRun().id, runId);

  store.close();
  rmSync(file, { force: true });
});

test("iterations record generations and can be kept or reverted", () => {
  const file = tmpDb();
  const store = openStore(file);
  const first = store.addIteration({ site: "liepin.com", intent: "search", objectKind: "param", before: { gap: [45, 120] }, after: { gap: [60, 150] }, rationale: "降低短间隔搜索" });
  const second = store.addIteration({ site: "liepin.com", intent: "search", objectKind: "recipe", after: { steps: 6 } });
  assert.equal(store.getIteration(first).generation, 1);
  assert.equal(store.getIteration(second).generation, 2);

  store.decideIteration(first, { outcome: "reverted", reason: "落点中位偏移退化", by: "agent" });
  const row = store.getIteration(first);
  assert.equal(row.outcome, "reverted");
  assert.equal(row.revert_reason, "落点中位偏移退化");
  assert.equal(store.listIterations({ site: "liepin.com", intent: "search" }).length, 2);

  assert.throws(() => store.decideIteration(first, { outcome: "nope" }), /unknown outcome/);

  store.close();
  rmSync(file, { force: true });
});

test("promoteNotes lifts qualifying notes to global and strips site names", () => {
  const file = tmpDb();
  const store = openStore(file);
  for (const platform of ["liepin.com", "zhipin.com"]) {
    for (let i = 0; i < 2; i += 1) {
      store.addNote({ platform, intent: "search", kind: "hint", text: `在 ${platform} 上，输入关键词后必须按 Enter 再点搜索` });
    }
  }
  const promoted = store.promoteNotes();
  assert.equal(promoted.length, 1);

  const globals = store.listNotes("liepin.com", { intent: "search" }).filter((row) => row.platform === "*");
  assert.equal(globals.length, 1);
  assert.equal(globals[0].scope, "global");
  assert.equal(globals[0].text.includes("liepin.com"), false, "promoted text must not carry a site name");
  assert.match(globals[0].text, /本站/);

  store.close();
  rmSync(file, { force: true });
});

function seedRun(file, { centred = false } = {}) {
  const store = openStore(file);
  const runId = store.startRun({ host: "h.liepin.com", profile: "balanced", ver: "0.6.0" });
  const t = Date.now();
  let seq = 0;
  const push = (action, extra = {}) =>
    store.addEvent({ runId, seq: ++seq, ts: t + seq * 4000, host: "h.liepin.com", path: "/zhaopin", action, ok: 1, ...extra });
  push("nav");
  push("click", { landingPx: centred ? 0 : 9, movePoints: 34, travelPx: 420 });
  push("read", { movePoints: 18, travelPx: 160 });
  push("read", { movePoints: 14, travelPx: 120 });
  push("click", { landingPx: centred ? 0 : 12, movePoints: 30, travelPx: 380 });
  push("type");
  store.endRun(runId, "done");
  store.close();
  return runId;
}

const VERIFY_TOOL = fileURLToPath(new URL("../tools/verify-human.mjs", import.meta.url));

test("verify-human passes a clean run and fails a centred one", () => {
  const good = tmpDb();
  const bad = tmpDb();
  seedRun(good);
  seedRun(bad, { centred: true });

  const passed = execFileSync(process.execPath, [VERIFY_TOOL, "--db", good], { encoding: "utf8" });
  assert.match(passed, /gate ok: 6\/6/);

  assert.throws(
    () => execFileSync(process.execPath, [VERIFY_TOOL, "--db", bad], { encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 1 && /gate failed/.test(String(error.stdout)),
  );

  rmSync(good, { force: true });
  rmSync(bad, { force: true });
});
