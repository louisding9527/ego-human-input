// 迭代台账：记录一次改动是什么、基于什么证据、门禁前后如何、最后是否留下。
// 本工具不自动改参数；改动由调用方执行，这里只负责记账与裁决。
import { openStore } from "../lib/store.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const parse = (value) => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const store = openStore(arg("db") || undefined);

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function describe(row) {
  return [
    `[ITER ${row.id}] ${row.site} / ${row.intent}  gen=${row.generation}  ${fmt(row.ts)}`,
    `object = ${row.object_kind || "-"}   trigger=${row.trigger || "-"}`,
    `before = ${row.before || "-"}`,
    `after  = ${row.after || "-"}`,
    `why    = ${row.rationale || "-"}`,
    `evidence = ${row.evidence || "-"}`,
    `gate   = ${row.gate_before || "-"} -> ${row.gate_after || "-"}`,
    `outcome= ${row.outcome}  by=${row.decided_by || "-"}  reason=${row.revert_reason || "-"}`,
  ].join("\n");
}

if (cmd === "list") {
  const rows = store.listIterations({ site: arg("site"), intent: arg("intent"), limit: Number(arg("limit", "50")) });
  if (!rows.length) console.log("no iterations");
  for (const row of rows) console.log(describe(row) + "\n");
} else if (cmd === "show") {
  const id = Number(arg("id", "0"));
  const row = id ? store.getIteration(id) : null;
  console.log(row ? describe(row) : `iteration ${id} not found`);
  if (!row) process.exitCode = 1;
} else if (cmd === "record") {
  const site = arg("site");
  const after = arg("after");
  if (!site || !after) {
    console.error('usage: node tools/iterate.mjs record --site liepin.com --intent search --kind param --before \'{"gap":[45,120]}\' --after \'{"gap":[60,150]}\' --rationale "..." [--trigger budget] [--evidence \'{"eventIds":[1,2]}\']');
    process.exit(2);
  }
  const id = store.addIteration({
    site,
    intent: arg("intent", "*"),
    trigger: arg("trigger", ""),
    objectKind: arg("kind", "param"),
    before: parse(arg("before")),
    after: parse(after),
    rationale: arg("rationale"),
    evidence: parse(arg("evidence")),
  });
  console.log(`iteration ${id} recorded for ${site} / ${arg("intent", "*")} (outcome=pending)`);
} else if (cmd === "decide") {
  const id = Number(arg("id", "0"));
  const outcome = arg("outcome", "pending");
  if (!id) {
    console.error("usage: node tools/iterate.mjs decide --id 3 --outcome kept|reverted|pending [--reason TEXT]");
    process.exit(2);
  }
  const row = store.decideIteration(id, { outcome, reason: arg("reason"), by: arg("by", "agent") });
  console.log(`${describe(row)}`);
} else {
  console.error("usage: node tools/iterate.mjs <list|show|record|decide> [options]");
  process.exit(2);
}

store.close();
