import { openStore } from "../lib/store.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const store = openStore();

if (cmd === "list") {
  const host = arg("host");
  const rows = host
    ? store.listRecipes(host)
    : store.db.prepare("SELECT id,host,intent,version,ok_count,fail_count,updated_at FROM recipes ORDER BY host, intent").all();
  if (!rows.length) console.log("no recipes");
  let last = "";
  for (const row of rows) {
    if (row.host !== last) {
      console.log(`\n## ${row.host}`);
      last = row.host;
    }
    console.log(`  ${row.intent}  v${row.version}  ok=${row.ok_count} fail=${row.fail_count}`);
  }
} else if (cmd === "show") {
  const host = arg("host");
  const intent = arg("intent");
  const row = store.getRecipe(host, intent);
  if (!row) {
    console.error(`no recipe ${host} / ${intent}`);
    process.exit(1);
  }
  console.log(`# ${host} / ${intent}  v${row.version}  ok=${row.ok_count} fail=${row.fail_count}`);
  for (const [i, step] of JSON.parse(row.steps).entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${JSON.stringify(step)}`);
  }
} else {
  console.error("usage: node tools/recipe.mjs <list|show> [--host H] [--intent I]");
  process.exit(2);
}

store.close();
