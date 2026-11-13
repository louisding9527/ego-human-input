import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sequenceRepeatRate, failRate } from "./score.mjs";
import { normalizeNoteText, promotionCandidates, cleanNoteText } from "./notes.mjs";
import { observe } from "./observe.mjs";

export const STORE_DIR = join(homedir(), ".ego-human-input");
export const STORE_FILE = join(STORE_DIR, "human.db");

const stringify = (value) => (value === undefined ? "" : JSON.stringify(value).slice(0, 2000));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
  host TEXT, profile TEXT, skill_ver TEXT, outcome TEXT
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, seq INTEGER,
  host TEXT, path TEXT, action TEXT, target_kind TEXT, target_hash TEXT,
  ok INTEGER, ms INTEGER, flags TEXT, kw_hash TEXT, result_fp TEXT, result_n INTEGER,
  landing_px REAL DEFAULT 0, move_points INTEGER DEFAULT 0, travel_px REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events(host, ts);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
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
  scope TEXT DEFAULT 'site', norm TEXT DEFAULT '',
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, intent TEXT, steps TEXT, version INTEGER DEFAULT 1,
  ok_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_key ON recipes(host, intent);
CREATE TABLE IF NOT EXISTS iterations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, site TEXT, intent TEXT,
  generation INTEGER DEFAULT 0, trigger TEXT, object_kind TEXT,
  before TEXT, after TEXT, rationale TEXT, evidence TEXT,
  gate_before TEXT, gate_after TEXT,
  outcome TEXT DEFAULT 'pending', revert_reason TEXT, decided_by TEXT, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_iterations_site ON iterations(site, intent, generation);
`;

export function openStore(file = STORE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);

  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  const ensureColumns = (table, specs) => {
    const present = columnsOf(table);
    for (const [name, ddl] of specs) {
      if (!present.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  };

  ensureColumns("site_notes", [
    ["platform", "TEXT"],
    ["intent", "TEXT DEFAULT '*'"],
    ["kind", "TEXT DEFAULT 'hint'"],
    ["scope", "TEXT DEFAULT 'site'"],
    ["norm", "TEXT DEFAULT ''"],
  ]);
  ensureColumns("events", [
    ["landing_px", "REAL DEFAULT 0"],
    ["move_points", "INTEGER DEFAULT 0"],
    ["travel_px", "REAL DEFAULT 0"],
  ]);
  db.exec("UPDATE site_notes SET platform=host WHERE platform IS NULL OR platform=''");
  db.exec("UPDATE site_notes SET scope='site' WHERE scope IS NULL OR scope=''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notes_platform ON site_notes(platform, intent, kind)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notes_scope ON site_notes(scope, norm)");

  // rounds 表从未写入过一行；v0.6 删除。只在确认为空时删，避免误删他人数据。
  try {
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM rounds").get();
    if (Number(rounds?.n || 0) === 0) db.exec("DROP TABLE IF EXISTS rounds");
  } catch {
    /* 老库没有 rounds 表：跳过 */
  }

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

    latestRun() {
      return q("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get() || null;
    },

    getRun(id) {
      return q("SELECT * FROM runs WHERE id=?").get(id) || null;
    },

    eventsOfRun(runId) {
      return q("SELECT * FROM events WHERE run_id=? ORDER BY id ASC").all(String(runId || ""));
    },

    addEvent(evt) {
      q(`INSERT INTO events(ts,run_id,seq,host,path,action,target_kind,target_hash,ok,ms,flags,kw_hash,result_fp,result_n,landing_px,move_points,travel_px)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
        Number(evt.landingPx ?? 0),
        Math.round(Number(evt.movePoints ?? 0)),
        Number(evt.travelPx ?? 0),
      );
    },

    countNoop(host, targetHash, since) {
      return Number(q("SELECT COUNT(*) AS c FROM events WHERE host=? AND target_hash=? AND flags LIKE '%s4-noop%' AND ts>?")
        .get(host, targetHash, since)?.c || 0);
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

    addNote({ platform, host, intent, kind, area, text, selector, scope }) {
      const key = platform || host || "";
      const intentKey = intent || "*";
      const type = kind || "hint";
      const level = scope || "site";
      const now = Date.now();
      const body = String(text).slice(0, 500);
      const norm = normalizeNoteText(body);
      const existing = q("SELECT id FROM site_notes WHERE platform=? AND intent=? AND kind=? AND text=?")
        .get(key, intentKey, type, body);
      if (existing) {
        q("UPDATE site_notes SET hits=hits+1, updated_at=?, selector=COALESCE(?, selector), area=COALESCE(?, area), host=COALESCE(host, ?) WHERE id=?")
          .run(now, selector || null, area || null, host || null, existing.id);
        return existing.id;
      }
      const info = q(`INSERT INTO site_notes(platform,host,intent,kind,area,text,selector,hits,scope,norm,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`).run(
        key, host || key, intentKey, type, area || "", body, selector || "", level, norm, now, now,
      );
      return Number(info.lastInsertRowid);
    },

    listNotes(platform, { intent, kind } = {}) {
      const rows = q("SELECT * FROM site_notes WHERE platform=? OR platform='*'").all(platform);
      return rows
        .filter((row) => (kind ? row.kind === kind : true))
        .filter((row) => (intent ? row.intent === intent || row.intent === "*" : true))
        .sort((a, b) => {
          const aGlobal = a.platform === "*" ? 1 : 0;
          const bGlobal = b.platform === "*" ? 1 : 0;
          if (aGlobal !== bGlobal) return aGlobal - bGlobal;
          if (intent && a.intent !== b.intent) return a.intent === intent ? -1 : 1;
          return b.hits - a.hits || b.id - a.id;
        });
    },

    promoteNotes() {
      const rows = q("SELECT * FROM site_notes WHERE scope='site'").all();
      const candidates = promotionCandidates(rows);
      const promoted = [];
      for (const candidate of candidates) {
        const id = this.addNote({
          platform: "*",
          host: "*",
          intent: candidate.intent,
          kind: candidate.kind,
          area: "promoted",
          text: cleanNoteText(candidate.text),
          scope: "global",
        });
        promoted.push({ id, norm: candidate.norm, kind: candidate.kind, sites: candidate.sites });
      }
      return promoted;
    },

    addIteration(entry = {}) {
      const site = entry.site || "";
      const intent = entry.intent || "*";
      const generation = entry.generation ?? this.nextGeneration(site, intent);
      const info = q(`INSERT INTO iterations(ts,site,intent,generation,trigger,object_kind,before,after,rationale,evidence,gate_before,gate_after,outcome)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        Date.now(), site, intent, generation,
        entry.trigger || "", entry.objectKind || "",
        stringify(entry.before), stringify(entry.after),
        String(entry.rationale || "").slice(0, 500),
        stringify(entry.evidence), stringify(entry.gateBefore), stringify(entry.gateAfter),
        entry.outcome || "pending",
      );
      return Number(info.lastInsertRowid);
    },

    nextGeneration(site, intent = "*") {
      const row = q("SELECT MAX(generation) AS g FROM iterations WHERE site=? AND intent=?").get(site, intent);
      return Number(row?.g || 0) + 1;
    },

    listIterations({ site, intent, limit = 50 } = {}) {
      const sql = site
        ? "SELECT * FROM iterations WHERE site=? AND (intent=? OR ?='*') ORDER BY id DESC LIMIT ?"
        : "SELECT * FROM iterations ORDER BY id DESC LIMIT ?";
      return site ? q(sql).all(site, intent || "*", intent || "*", limit) : q(sql).all(limit);
    },

    getIteration(id) {
      return q("SELECT * FROM iterations WHERE id=?").get(id) || null;
    },

    decideIteration(id, { outcome, reason, by }) {
      const allowed = ["kept", "reverted", "pending"];
      if (!allowed.includes(outcome)) throw new Error(`unknown outcome: ${outcome}`);
      q("UPDATE iterations SET outcome=?, revert_reason=?, decided_by=?, decided_at=? WHERE id=?")
        .run(outcome, reason || "", by || "agent", Date.now(), id);
      return this.getIteration(id);
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
      const observed = observe(actions);
      const byAction = observed.byAction;

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
        observed,
      };
    },
  };
}
