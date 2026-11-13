import { openStore } from "../lib/store.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const store = openStore();

if (cmd === "list") {
  const platform = arg("platform");
  const intent = arg("intent");
  const kind = arg("kind");
  const rows = platform
    ? store.listNotes(platform, { intent: intent || undefined, kind: kind || undefined })
    : store.db.prepare("SELECT * FROM site_notes ORDER BY platform, intent, hits DESC").all();
  if (!rows.length) console.log("no notes");
  let last = "";
  for (const row of rows) {
    const key = `${row.platform} / ${row.intent} / ${row.kind}`;
    if (key !== last) {
      console.log(`\n## ${key}`);
      last = key;
    }
    console.log(`  - [${row.hits}x] ${row.text}${row.selector ? `  (${row.selector})` : ""}`);
  }
} else if (cmd === "add") {
  const platform = arg("platform") || arg("host");
  const text = arg("text");
  if (!platform || !text) {
    console.error('usage: node tools/site.mjs add --platform liepin.com --intent search --kind pitfall --text "..." [--selector "css=#x"]');
    process.exit(2);
  }
  const id = store.addNote({
    platform,
    host: arg("host", platform),
    intent: arg("intent", "*"),
    kind: arg("kind", "hint"),
    area: arg("area"),
    text,
    selector: arg("selector"),
  });
  console.log(`note ${id} saved for ${platform}`);
} else {
  console.error("usage: node tools/site.mjs <list|add> [--platform P] [--intent I] [--kind K] [--text T] [--selector S]");
  process.exit(2);
}

store.close();
