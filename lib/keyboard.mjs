const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

const range = ([lo, hi], rand) => lo + rand() * (hi - lo);

export function splitSegments(text) {
  const segments = [];
  for (const ch of String(text ?? "")) {
    const last = segments.at(-1);
    if (/\s/.test(ch) && last) {
      last.text += ch;
      continue;
    }
    const kind = CJK.test(ch) ? "cjk" : "latin";
    if (last && last.kind === kind) last.text += ch;
    else segments.push({ kind, text: ch });
  }
  return segments;
}

const PKT = /[^，。、！？；：,.!?;:]+[，。、！？；：,.!?;:]*/g;

function cjkGroups(text) {
  const groups = String(text).match(PKT) || [];
  return groups.filter((group) => group.trim() !== "");
}

function wrongChar(rand) {
  return String.fromCharCode(97 + Math.floor(rand() * 26));
}

export function planKeys(text, params = {}, { rand = Math.random } = {}) {
  const charMs = params.charMs || [55, 150];
  const spaceMs = params.spaceMs || [90, 220];
  const cjkGroupMs = params.cjkGroupMs || [300, 1200];
  const every = params.typoEveryGroups ?? 0;
  const rate = params.typoRate ?? 0;
  const ops = [];
  let groups = 0;

  const typoDue = () => {
    if (!every || every <= 0) return false;
    groups += 1;
    return groups % every === 0 && rand() < rate;
  };

  for (const segment of splitSegments(text)) {
    if (segment.kind === "latin") {
      let inWord = false;
      for (const ch of segment.text) {
        if (ch === " " || ch === "\n" || ch === "\t") {
          inWord = false;
          ops.push({ op: "type", ch, afterMs: range(spaceMs, rand) });
          continue;
        }
        if (!inWord) {
          inWord = true;
          if (typoDue()) {
            ops.push({ op: "type", ch: wrongChar(rand), afterMs: range([80, 180], rand) });
            ops.push({ op: "press", key: "Backspace", afterMs: range([70, 150], rand) });
          }
        }
        ops.push({ op: "type", ch, afterMs: range(charMs, rand) });
      }
      continue;
    }

    for (const group of cjkGroups(segment.text)) {
      if (typoDue()) {
        const wrong = `${group.slice(0, 1)}错`;
        ops.push({ op: "insert", text: wrong, afterMs: range([120, 260], rand) });
        for (let i = 0; i < wrong.length; i += 1) {
          ops.push({ op: "press", key: "Backspace", afterMs: range([60, 120], rand) });
        }
      }
      ops.push({ op: "insert", text: group, afterMs: range(cjkGroupMs, rand) });
    }
  }

  return ops;
}
