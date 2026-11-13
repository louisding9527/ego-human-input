import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sequenceRepeatRate, failRate } from "./score.mjs";

export const STORE_DIR = join(homedir(), ".ego-human-input");
export const STORE_FILE = join(STORE_DIR, "human.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
  host TEXT, profile TEXT, skill_ver TEXT, outcome TEXT
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, seq INTEGER,
  host TEXT, path TEXT, action TEXT, target_kind TEXT, target_hash TEXT,
  ok INTEGER, ms INTEGER, flags TEXT, kw_hash TEXT, result_fp TEXT, result_n INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events(host, ts);
CREATE TABLE IF NOT EXISTS rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, host TEXT, kind TEXT,
  started_at INTEGER, ended_at INTEGER, actions INTEGER, outcome TEXT
);
CREATE TABLE IF NOT EXISTS budget_use(
  hour INTEGER, host TEXT, action TEXT, used INTEGER, limit_n INTEGER,
  PRIMARY KEY(hour, host, action)
);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, host TEXT,
  level TEXT, trigger TEXT, evidence TEXT, rule_decision TEXT,
  final_decision TEXT, decided_by TEXT, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
CREATE TABLE IF NOT EXISTS host_state(
  host TEXT PRIMARY KEY, mode TEXT, until INTEGER, reason TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS site_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT, host TEXT, intent TEXT DEFAULT '*', kind TEXT DEFAULT 'hint',
  area TEXT, text TEXT, selector TEXT, hits INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, intent TEXT, steps TEXT, version INTEGER DEFAULT 1,
  ok_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_key ON recipes(host, intent);
`;

export function openStore(file = STORE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);

  const columns = db.prepare("PRAGMA table_info(site_notes)").all().map((row) => row.name);
  for (const [name, ddl] of [
    ["platform", "TEXT"],
    ["intent", "TEXT DEFAULT '*'"],
    ["kind", "TEXT DEFAULT 'hint'"],
  ]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE site_notes ADD COLUMN ${name} ${ddl}`);
  }
  db.exec("UPDATE site_notes SET platform=host WHERE platform IS NULL OR platform=''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notes_platform ON site_notes(platform, intent, kind)");

  const q = (sql) => db.prepare(sql);

  return {
    db,
    close: () => db.close(),

    startRun({ host, profile, ver }) {
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      q("INSERT INTO runs(id,started_at,host,profile,skill_ver) VALUES(?,?,?,?,?)")
        .run(id, Date.now(), host || "", profile || "", ver || "");
      return id;
    },

    endRun(id, outcome) {
      q("UPDATE runs SET ended_at=?, outcome=? WHERE id=?").run(Date.now(), outcome || "", id);
    },

    addEvent(evt) {
      q(`INSERT INTO events(ts,run_id,seq,host,path,action,target_kind,target_hash,ok,ms,flags,kw_hash,result_fp,result_n)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        evt.ts ?? Date.now(),
        evt.runId ?? "",
        evt.seq ?? 0,
        evt.host ?? "",
        String(evt.path ?? "").slice(0, 80),
        evt.action ?? "",
        evt.targetKind ?? "",
        evt.targetHash ?? "",
        evt.ok ? 1 : 0,
        Math.round(evt.ms ?? 0),
        (evt.flags || []).join(",").slice(0, 60),
        evt.kwHash ?? "",
        evt.resultFp ?? "",
        evt.resultN ?? 0,
      );
    },

    addAlert({ runId, host, level, trigger, evidence, ruleDecision }) {
      const info = q(`INSERT INTO alerts(ts,run_id,host,level,trigger,evidence,rule_decision)
                      VALUES(?,?,?,?,?,?,?)`).run(
        Date.now(), runId || "", host || "", level || "medium", trigger || "",
        JSON.stringify(evidence || {}).slice(0, 2000), ruleDecision || "",
      );
      return Number(info.lastInsertRowid);
    },

    decideAlert(id, { decision, by, reason }) {
      q("UPDATE alerts SET final_decision=?, decided_by=?, resolved_at=? WHERE id=?")
        .run(decision, by || "rule", Date.now(), id);
      if (reason) {
        const row = q("SELECT evidence FROM alerts WHERE id=?").get(id);
        let evidence = {};
        try {
          evidence = JSON.parse(row?.evidence || "{}");
        } catch {
          evidence = {};
        }
        evidence.reason = String(reason).slice(0, 300);
        q("UPDATE alerts SET evidence=? WHERE id=?").run(JSON.stringify(evidence), id);
      }
    },

    getAlert(id) {
      return q("SELECT * FROM alerts WHERE id=?").get(id) || null;
    },

    pendingAlerts(host) {
      return host
        ? q("SELECT * FROM alerts WHERE final_decision IS NULL AND host=? ORDER BY id DESC").all(host)
        : q("SELECT * FROM alerts WHERE final_decision IS NULL ORDER BY id DESC").all();
    },

    alertCount(host, days = 7) {
      const since = Date.now() - days * 86400000;
      const row = q("SELECT COUNT(*) AS n FROM alerts WHERE host=? AND ts>=?").get(host, since);
      return Number(row?.n || 0);
    },

    budgetTake(host, action, hour, limit) {
      q(`INSERT INTO budget_use(hour,host,action,used,limit_n) VALUES(?,?,?,1,?)
         ON CONFLICT(hour,host,action) DO UPDATE SET used=used+1`)
        .run(hour, host, action, limit);
      const row = q("SELECT used, limit_n FROM budget_use WHERE hour=? AND host=? AND action=?").get(hour, host, action);
      return { used: Number(row?.used || 0), limit: Number(row?.limit_n ?? limit) };
    },

    budgetRead(host, action, hour) {
      const row = q("SELECT used, limit_n FROM budget_use WHERE hour=? AND host=? AND action=?").get(hour, host, action);
      return { used: Number(row?.used || 0), limit: Number(row?.limit_n ?? 0) };
    },

    hostState(host) {
      return q("SELECT * FROM host_state WHERE host=?").get(host) || null;
    },

    setHostState(host, { mode, until, reason }) {
      q(`INSERT INTO host_state(host,mode,until,reason,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(host) DO UPDATE SET mode=?, until=?, reason=?, updated_at=?`)
        .run(host, mode, until ?? 0, reason || "", Date.now(), mode, until ?? 0, reason || "", Date.now());
    },

    recentEvents(host, limit = 50) {
      return q("SELECT * FROM events WHERE host=? ORDER BY id DESC LIMIT ?").all(host, limit);
    },

    addNote({ platform, host, intent, kind, area, text, selector }) {
      const key = platform || host || "";
      const scope = intent || "*";
      const type = kind || "hint";
      const now = Date.now();
      const existing = q("SELECT id FROM site_notes WHERE platform=? AND intent=? AND kind=? AND text=?")
        .get(key, scope, type, text);
      if (existing) {
        q("UPDATE site_notes SET hits=hits+1, updated_at=?, selector=COALESCE(?, selector), area=COALESCE(?, area), host=COALESCE(host, ?) WHERE id=?")
          .run(now, selector || null, area || null, host || null, existing.id);
        return existing.id;
      }
      const info = q(`INSERT INTO site_notes(platform,host,intent,kind,area,text,selector,hits,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,1,?,?)`).run(
        key, host || key, scope, type, area || "", String(text).slice(0, 500), selector || "", now, now,
      );
      return Number(info.lastInsertRowid);
    },

    listNotes(platform, { intent, kind } = {}) {
      const rows = q("SELECT * FROM site_notes WHERE platform=?").all(platform);
      return rows
        .filter((row) => (kind ? row.kind === kind : true))
        .filter((row) => (intent ? row.intent === intent || row.intent === "*" : true))
        .sort((a, b) => {
          if (intent && a.intent !== b.intent) return a.intent === intent ? -1 : 1;
          return b.hits - a.hits || b.id - a.id;
        });
    },

    saveRecipe({ host, intent, steps }) {
      const body = typeof steps === "string" ? steps : JSON.stringify(steps);
      const existing = q("SELECT id, version FROM recipes WHERE host=? AND intent=?").get(host, intent);
      const now = Date.now();
      if (existing) {
        q("UPDATE recipes SET steps=?, version=version+1, updated_at=? WHERE id=?")
          .run(body, now, existing.id);
        return { id: existing.id, version: existing.version + 1 };
      }
      const info = q("INSERT INTO recipes(host,intent,steps,version,created_at,updated_at) VALUES(?,?,?,1,?,?)")
        .run(host, intent, body, now, now);
      return { id: Number(info.lastInsertRowid), version: 1 };
    },

    getRecipe(host, intent) {
      return q("SELECT * FROM recipes WHERE host=? AND intent=?").get(host, intent) || null;
    },

    listRecipes(host) {
      return q("SELECT id,host,intent,version,ok_count,fail_count,updated_at FROM recipes WHERE host=? ORDER BY intent").all(host);
    },

    bumpRecipe(id, ok) {
      q(ok ? "UPDATE recipes SET ok_count=ok_count+1 WHERE id=?" : "UPDATE recipes SET fail_count=fail_count+1 WHERE id=?").run(id);
    },

    windowEvents(host, sinceMs, now = Date.now()) {
      return q("SELECT * FROM events WHERE host=? AND ts>=? ORDER BY id ASC").all(host, now - sinceMs);
    },

    metrics(host, { windowMs = 1800000, now = Date.now() } = {}) {
      const events = this.windowEvents(host, windowMs, now);
      const actions = events.filter((e) => !String(e.action || "").startsWith("alert_"));
      const byAction = {};
      for (const e of actions) byAction[e.action] = (byAction[e.action] || 0) + 1;

      const searches = actions.filter((e) => e.action === "search");
      const tenMin = searches.filter((e) => e.ts >= now - 600000);
      const intervals = searches.slice(1).map((e, i) => (e.ts - searches[i].ts) / 1000);
      let sameFingerprint = 0;
      for (let i = 1; i < searches.length; i += 1) {
        if (searches[i].result_fp && searches[i].result_fp === searches[i - 1].result_fp) sameFingerprint += 1;
      }
      let consecutiveSearch = 0;
      for (let i = actions.length - 1; i >= 0; i -= 1) {
        if (actions[i].action === "search") consecutiveSearch += 1;
        else break;
      }
      const lastSearchIdx = actions.map((e) => e.action).lastIndexOf("search");
      const detailSinceSearch = actions.slice(lastSearchIdx + 1).filter((e) => e.action === "detail").length;
      const distinctPaths = new Set(actions.map((e) => e.path)).size;
      const chainRepeat = distinctPaths >= 3
        ? sequenceRepeatRate(actions.map((e) => `${e.action}:${e.path}`).slice(-30))
        : 0;

      return {
        byAction,
        searchIn10m: tenMin.length,
        consecutiveSearch,
        detailSinceSearch,
        searchIntervals: intervals,
        sameFingerprint,
        chainRepeat,
        failRate: failRate(actions),
        alerts7d: this.alertCount(host, 7),
        orphanRequests: 0,
        silentWrites: 0,
      };
    },
  };
}
