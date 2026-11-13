import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../lib/store.mjs";

const rest = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};

const outDir = arg("out", `./human-export-${new Date().toISOString().slice(0, 10)}`);
const only = arg("tables", "").split(",").map((s) => s.trim()).filter(Boolean);
const tables = only.length
  ? only
  : ["runs", "events", "rounds", "budget_use", "alerts", "host_state", "site_notes"];

mkdirSync(outDir, { recursive: true });
const store = openStore();
const summary = { exportedAt: new Date().toISOString(), tables: {} };

for (const table of tables) {
  let rows = [];
  try {
    rows = store.db.prepare(`SELECT * FROM ${table}`).all();
  } catch (error) {
    summary.tables[table] = { error: String(error.message || error) };
    continue;
  }
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(join(outDir, `${table}.jsonl`), rows.length ? `${jsonl}\n` : "", "utf8");
  const csvHeader = rows.length ? Object.keys(rows[0]).join(",") : "";
  const csvBody = rows.map((row) => Object.values(row).map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  writeFileSync(join(outDir, `${table}.csv`), rows.length ? `${csvHeader}\n${csvBody}\n` : "", "utf8");
  summary.tables[table] = { rows: rows.length };
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(`exported to ${outDir}`);
for (const [table, info] of Object.entries(summary.tables)) {
  console.log(`  ${table}: ${info.rows ?? info.error}`);
}
store.close();
