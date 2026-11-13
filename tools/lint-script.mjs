import { readFile } from "node:fs/promises";

// 车道划分见 references/bridge.md：
//   人类车道 = 站内用户级输入，必须走 h.*（指针/按键由库产生）。
//   系统车道 = 观察与浏览器自有操作，必须走 page.*（snapshot / 截图 / 弹窗 /
//              上传 / 下载 / 页签 / selectOption …）。这些不禁，也不该自己重写。
// 因此这里只禁「输入类」page 调用，不再按 page. 前缀一刀切。
const RULES = [
  { id: "B1-dom-click", re: /\bdispatchEvent\s*\(/, why: "程序化派发事件，无 pointer 序列" },
  { id: "B1-page-input", re: /\bpage\.(click|dblclick|hover|dragAndDrop|fill|press|focus)\s*\(/, why: "输入类动作走 h.click/h.type/h.press" },
  { id: "B1-page-mouse", re: /\bpage\.mouse\./, why: "指针动作走 h.click/h.move/h.scroll" },
  { id: "B1-page-keyboard", re: /\bpage\.keyboard\.(type|insertText|press|down|up)\s*\(/, why: "按键走 h.type/h.press；只有原生粘贴 page.keyboard.paste 放行" },
  { id: "B1-submit", re: /\.(submit|requestSubmit)\s*\(\s*\)/, why: "程序化提交表单" },
  { id: "B2-value", re: /\.value\s*=(?!=)/, why: "直接写值，无按键事件" },
  { id: "B2-innerhtml", re: /\.(innerHTML|textContent|checked)\s*=(?!=)/, why: "直接改 DOM 状态" },
  { id: "B3-fetch", re: /\bpage\.fetch\s*\(/, why: "页面内新发请求；只读页面自身流量用 h.inspect.requests" },
  { id: "B3-evaluate", re: /\bpage\.evaluate\s*\(/, why: "页面内执行任意代码；只读取数用 h.inspect.*" },
  { id: "B3-cdp", re: /\bpage\.cdp\s*\(/, why: "直接调协议；仅诊断轮可用，并写 // lint-allow cdp" },
  { id: "B5-inserttext", re: /\.insertText\s*\(/, why: "整段注入文本，等效直接写值" },
  { id: "B6-storage", re: /\b(localStorage|sessionStorage|document\.cookie)\s*\./, why: "改持久状态" },
  { id: "B8-scroll", re: /scrollIntoView\s*\(|\bwindow\.scrollTo\s*\(/, why: "瞬移滚动，改用 h.scroll 滚轮逼近" },
  // 入站就是 h.goto：create() 之前那次 page.goto 是为了让库认站点，属于引导步骤。
  { id: "B1-page-nav", re: /\bpage\.(goto|reload)\s*\(/, why: "create() 之后的导航走 h.goto（判 URL、过闸门）", postCreate: true },
];

const ALLOW = /lint-allow\b/;
const CREATE_RE = /\bhuman\.create\s*\(/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 返回 create() 的行号（1 起）。没有 create 的脚本不适用「create 之后」的规则。
function createLine(cleanedLines) {
  const index = cleanedLines.findIndex((line) => CREATE_RE.test(line));
  return index < 0 ? Infinity : index + 1;
}

export function lintSource(source) {
  const raw = String(source ?? "");
  const cleanedLines = stripComments(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const boundary = createLine(cleanedLines);
  const violations = [];
  cleanedLines.forEach((line, index) => {
    const original = rawLines[index] || "";
    if (ALLOW.test(original)) return;
    for (const rule of RULES) {
      if (rule.postCreate && index + 1 < boundary) continue;
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
