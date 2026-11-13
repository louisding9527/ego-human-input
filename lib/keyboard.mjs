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

// 一次 insertText 就是一个 input 事件。真人用输入法按词上屏，五六个字
// 通常拆成两三次 commit；整段一次上屏反而是机器相。这里按 ≤2 字切块。
function chunkBy(text, size = 2) {
  const chars = [...String(text)];
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

function wrongChar(rand) {
  return String.fromCharCode(97 + Math.floor(rand() * 26));
}

export function planKeys(text, params = {}, { rand = Math.random, timing = null } = {}) {
  // 有 timing 就走对数正态与相邻相关；没有就退回区间均匀采样（便于单独使用）。
  const gap = (span, key) => (timing ? timing.ms(span, key) : range(span, rand));
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
          ops.push({ op: "type", ch, afterMs: gap(spaceMs, "space") });
          continue;
        }
        if (!inWord) {
          inWord = true;
          if (typoDue()) {
            ops.push({ op: "type", ch: wrongChar(rand), afterMs: gap([80, 180], "typoFix") });
            ops.push({ op: "press", key: "Backspace", afterMs: gap([70, 150], "typoBackspace") });
          }
        }
        ops.push({ op: "type", ch, afterMs: gap(charMs, "char") });
      }
      continue;
    }

    for (const group of cjkGroups(segment.text)) {
      if (typoDue()) {
        const wrong = `${group.slice(0, 1)}错`;
        ops.push({ op: "insert", text: wrong, afterMs: gap([120, 260], "cjkTypoFix") });
        for (let i = 0; i < wrong.length; i += 1) {
          ops.push({ op: "press", key: "Backspace", afterMs: gap([60, 120], "cjkTypoBackspace") });
        }
      }
      for (const chunk of chunkBy(group)) {
        ops.push({ op: "insert", text: chunk, afterMs: gap(cjkGroupMs, "cjkGroup") });
      }
    }
  }

  return ops;
}
