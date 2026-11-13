import { openStore } from "../lib/store.mjs";
import { scoreMetrics, classifyScore } from "../lib/score.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const store = openStore();

const arg = (name, fallback = "") => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};

function fmt(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function describe(row) {
  const metrics = store.metrics(row.host, { windowMs: 30 * 60 * 1000 });
  const scored = scoreMetrics(metrics);
  const by = metrics.byAction;
  const lines = [
    `[ALERT ${row.id}] host=${row.host} at=${fmt(row.ts)} trigger=${row.trigger} level=${row.level}`,
    `page  = ${JSON.parse(row.evidence || "{}").url || "-"}`,
    `score = ${scored.score}  score_rule=${classifyScore(scored.score)}  trigger_rule=${row.rule_decision || "-"}  suspects=${scored.suspects.join(",") || "-"}`,
    `30m   : actions=${Object.values(by).reduce((a, b) => a + b, 0)} ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `search: 10m=${metrics.searchIn10m} streak=${metrics.consecutiveSearch} sameFp=${metrics.sameFingerprint}`,
    `shape : chainRepeat=${metrics.chainRepeat.toFixed(2)} failRate=${metrics.failRate.toFixed(2)} alerts7d=${metrics.alerts7d}`,
    `state : rule=${row.rule_decision || "-"} final=${row.final_decision || "pending"} by=${row.decided_by || "-"}`,
  ];
  const recent = store.recentEvents(row.host, 8);
  lines.push("recent:");
  for (const e of recent) lines.push(`  ${fmt(e.ts)} ${e.action} ${e.path} ok=${e.ok} ${e.flags || ""}`);
  return lines.join("\n");
}

if (cmd === "list") {
  const rows = store.pendingAlerts(arg("host") || undefined);
  if (!rows.length) console.log("no pending alerts");
  for (const row of rows) console.log(`#${row.id} ${fmt(row.ts)} ${row.host} ${row.level} ${row.trigger} rule=${row.rule_decision || "-"}`);
} else if (cmd === "show") {
  const id = Number(arg("id", "0"));
  const rows = id ? [store.getAlert(id)].filter(Boolean) : store.pendingAlerts();
  if (!rows.length) console.log("alert not found");
  for (const row of rows) console.log(`${describe(row)}\n`);
} else if (cmd === "decide") {
  const id = Number(arg("id", "0"));
  const decision = arg("decision", "backoff");
  const reason = arg("reason", "");
  if (!id) {
    console.error("usage: node tools/alert.mjs decide --id 12 --decision abort --reason \"...\"");
    process.exit(2);
  }
  const row = store.getAlert(id);
  if (!row) {
    console.error(`alert ${id} not found`);
    process.exit(1);
  }
  store.decideAlert(id, { decision, by: "agent", reason });
  const now = Date.now();
  const cooldown = decision === "abort" ? 2 * 3600 * 1000 : decision === "backoff" ? 15 * 60 * 1000 : 90 * 1000;
  store.setHostState(row.host, {
    mode: decision === "continue" ? "normal" : decision,
    until: decision === "continue" ? 0 : now + cooldown,
    reason,
  });
  console.log(`#${id} -> ${decision} by agent; host ${row.host} ${decision === "continue" ? "can continue after backoff" : `cooling until ${fmt(now + cooldown)}`}`);
} else {
  console.error("usage: node tools/alert.mjs <list|show|decide> [--id N] [--decision continue|backoff|abort] [--reason TEXT]");
  process.exit(2);
}

store.close();
