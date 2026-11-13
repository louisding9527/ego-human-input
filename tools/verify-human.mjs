// 行为门禁：对一个已记录的 run 做可复现的判定。
// 输入是 SQLite 里的历史事件，不是实时流量；同一份事件永远得到同一个结论。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../lib/store.mjs";
import { observe } from "../lib/observe.mjs";
import { evaluate, compare } from "../lib/verify.mjs";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const THRESHOLDS = join(SKILL_DIR, "profiles", "thresholds.json");

const args = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const wantsJson = args.includes("--json");
const store = openStore(arg("db") || undefined);

const runId = arg("run");
const run = runId ? store.getRun(runId) : store.latestRun();
if (!run) {
  console.error(runId ? `run ${runId} not found` : "no run recorded yet; run a script with human.create() first");
  store.close();
  process.exit(2);
}

const events = store.eventsOfRun(run.id);
if (!events.length) {
  console.error(`run ${run.id} has no events`);
  store.close();
  process.exit(2);
}

const thresholds = JSON.parse(await readFile(THRESHOLDS, "utf8"));
const observed = observe(events);
const verdict = evaluate(observed, thresholds);

let regression = null;
const baselineId = arg("baseline");
if (baselineId) {
  const baselineRun = store.getRun(baselineId);
  if (!baselineRun) {
    console.error(`baseline run ${baselineId} not found`);
    store.close();
    process.exit(2);
  }
  regression = compare(observe(store.eventsOfRun(baselineId)), observed, thresholds.regression || {});
}

const ok = verdict.ok && (regression ? regression.ok : true);

if (wantsJson) {
  console.log(JSON.stringify({ run: run.id, host: run.host, ok, verdict, regression }, null, 2));
} else {
  console.log(`run   = ${run.id}  host=${run.host}  profile=${run.profile || "-"}  ver=${run.skill_ver || "-"}`);
  console.log(`events= ${observed.n}  reads=${observed.reads}  writes=${observed.writes}  clicks=${observed.clicks}  details=${observed.details}`);
  console.log(`thresholds v${thresholds.version}  calibrated=${thresholds.calibrated ? "yes" : "no（工程值）"}`);
  console.log("");
  for (const check of verdict.checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${check.label}  actual=${check.actual}  limit=${check.limit}`);
  }
  if (regression) {
    console.log("");
    console.log(`回归对照（baseline=${baselineId}，允许退化 ${Math.round(regression.maxDrop * 100) }%）`);
    for (const row of regression.rows) {
      const mark = row.ok ? "PASS" : "FAIL";
      console.log(`  [${mark}] ${row.label}  before=${row.before}  after=${row.after}  drop=${Math.round(row.drop * 1000) / 10}%`);
    }
  }
  console.log("");
  console.log(ok ? `gate ok: ${verdict.passed}/${verdict.total} assertions` : `gate failed: ${verdict.passed}/${verdict.total} assertions`);
}

store.close();
process.exit(ok ? 0 : 1);
