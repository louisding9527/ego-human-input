import { readFile } from "node:fs/promises";

const RULES = [
  { id: "B1-dom-click", re: /\.dispatchEvent\s*\(/, why: "程序化派发事件，无 pointer 序列" },
  { id: "B1-page-click", re: /\bpage\.click\s*\(/, why: "绕过 h.click，改用 h.click 走指针轨迹" },
  { id: "B1-submit", re: /\.(submit|requestSubmit)\s*\(\s*\)/, why: "程序化提交表单" },
  { id: "B2-value", re: /\.value\s*=(?!=)/, why: "直接写值，无按键事件" },
  { id: "B2-innerhtml", re: /\.(innerHTML|textContent|checked)\s*=(?!=)/, why: "直接改 DOM 状态" },
  { id: "B3-fetch", re: /\bpage\.fetch\s*\(/, why: "页面内新发请求" },
  { id: "B3-evaluate", re: /\bpage\.evaluate\s*\(/, why: "页面内执行任意代码，改用 h.inspect" },
  { id: "B3-cdp", re: /\bpage\.cdp\s*\(/, why: "绕过 API 直接调协议" },
  { id: "B5-inserttext", re: /\.insertText\s*\(/, why: "整段注入文本，等效直接写值" },
  { id: "B6-storage", re: /\b(localStorage|sessionStorage|document\.cookie)\s*\./, why: "改持久状态" },
  { id: "B8-scroll", re: /scrollIntoView\s*\(|\bwindow\.scrollTo\s*\(/, why: "瞬移滚动，改用 h.scroll 滚轮逼近" },
];

const ALLOW = /lint-allow\b/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function lintSource(source) {
  const raw = String(source ?? "");
  const cleanedLines = stripComments(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const violations = [];
  cleanedLines.forEach((line, index) => {
    const original = rawLines[index] || "";
    if (ALLOW.test(original)) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({ line: index + 1, id: rule.id, why: rule.why, text: original.trim().slice(0, 90) });
      }
    }
  });
  return violations;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/lint-script.mjs");
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node tools/lint-script.mjs <script.mjs>");
    process.exit(2);
  }
  const source = await readFile(file, "utf8");
  const violations = lintSource(source);
  if (!violations.length) {
    console.log(`lint ok: ${file}`);
    process.exit(0);
  }
  for (const v of violations) console.error(`${file}:${v.line}  [${v.id}] ${v.why}  →  ${v.text}`);
  console.error(`lint failed: ${violations.length} violation(s)`);
  process.exit(1);
}
