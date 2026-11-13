#!/usr/bin/env node
// 一次性引导：把目标站点的通知权限从 default 变成 granted。
//
// 为什么不能一步做完：Chrome 要求 requestPermission() 由真实点击触发，而 ego-lite 一旦
// 检测到浏览器权限气泡，就会主动停下脚本、把空间交给用户（"A browser permission prompt
// ... has appeared"）。所以流程天然是两步：
//
//   node tools/notify-setup.mjs h.liepin.com          # 弹出授权气泡
//   （到 ego-lite 窗口点「允许」）
//   node tools/notify-setup.mjs --check h.liepin.com  # 验证并试发一条
//
// 权限按 origin 存在浏览器 profile 里，换站点要各自授权一次。

import { spawn } from "node:child_process";
import { toOrigin } from "../lib/guard.mjs";

const args = process.argv.slice(2);
const wantsCheck = args.includes("--check");
const wantsHelp = args.includes("--help") || args.includes("-h");
const site = args.find((item) => !item.startsWith("-")) || "";

const USAGE = `用法：
  node tools/notify-setup.mjs <站点>            弹出通知授权气泡（默认 h.liepin.com）
  node tools/notify-setup.mjs --check <站点>    只检查权限，已授权就试发一条
站点的写法：h.liepin.com 或 https://h.liepin.com/`;

if (wantsHelp) {
  console.log(USAGE);
  process.exit(0);
}

const origin = toOrigin(site || "h.liepin.com");
if (!origin) {
  console.error(`看不懂这个站点：${site}\n\n${USAGE}`);
  process.exit(2);
}

const BROWSER_SCRIPT = `
const CHECK_ONLY = ${wantsCheck ? "true" : "false"};
const ORIGIN = ${JSON.stringify(origin)};
const task = await taskSpace("ego-human-input 通知授权");
const page = (await task.pages())[0] ?? (await task.adopt((await task.tabs())[0].page));
await page.goto(ORIGIN + "/", { timeout: 45000 });
await page.waitForLoadState("load").catch(() => {});

const permission = () => page.evaluate(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
const before = await permission();
console.log("PERMISSION_BEFORE " + before);

const testSend = async () => {
  const result = await page.evaluate(() => {
    if (typeof Notification === "undefined") return "unsupported";
    if (Notification.permission !== "granted") return Notification.permission;
    try {
      new Notification("ego-human-input 已就绪", { body: "以后停手会这样提醒你" });
      return "sent";
    } catch (error) {
      return "error:" + String(error.message).slice(0, 60);
    }
  });
  console.log("TEST_SEND " + result);
  return result;
};

if (before === "granted") {
  console.log("ALREADY_GRANTED");
  await testSend();
  await task.finish({ keep: [] });
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log("NOT_GRANTED " + before);
  await task.finish({ keep: [] });
  process.exit(3);
}

// 注入一个明显的按钮，然后用真实鼠标点它：requestPermission 需要用户手势。
await page.evaluate(() => {
  const box = document.createElement("div");
  box.id = "ego-human-input-setup";
  box.style.cssText = [
    "position:fixed", "left:50%", "top:120px", "transform:translateX(-50%)",
    "z-index:2147483647", "background:#ffffff", "border:2px solid #004369",
    "border-radius:10px", "padding:18px 22px", "box-shadow:0 8px 30px rgba(0,0,0,.18)",
    "font:15px/1.5 sans-serif", "color:#111", "text-align:center",
  ].join(";");
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;margin-bottom:10px";
  title.append("正在申请浏览器通知权限");
  const hint = document.createElement("div");
  hint.style.cssText = "color:#555;margin-bottom:12px";
  hint.append("稍后会弹出授权气泡，请选择「允许」");
  const button = document.createElement("button");
  button.id = "ego-human-input-setup-btn";
  button.style.cssText = "padding:12px 26px;font-size:16px;background:#004369;color:#fff;border:0;border-radius:8px;cursor:pointer";
  button.append("申请通知权限");
  button.addEventListener("click", async () => {
    window.__egoSetup = { clicked: true, result: null };
    try {
      window.__egoSetup.result = await Notification.requestPermission();
    } catch (error) {
      window.__egoSetup.result = "error:" + String(error.message);
    }
  });
  box.append(title, hint, button);
  document.body.append(box);
});

const rect = await page.evaluate(() => {
  const el = document.getElementById("ego-human-input-setup-btn");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (!rect) {
  console.log("INJECT_FAILED");
  await task.finish({ keep: [] });
  process.exit(4);
}

await page.mouse.move(rect.x, rect.y);
await page.mouse.click(rect.x, rect.y);
await page.waitForTimeout(2500);

const after = await permission();
console.log("PERMISSION_AFTER " + after);
console.log("PROBE " + JSON.stringify(await page.evaluate(() => window.__egoSetup || null)));
await page.evaluate(() => document.getElementById("ego-human-input-setup")?.remove());
if (after === "granted") {
  await testSend();
  await task.finish({ keep: [] });
  process.exit(0);
}
console.log("NO_PROMPT " + after);
await task.finish({ keep: [] });
process.exit(5);
`;

const run = () =>
  new Promise((resolve) => {
    // 走 stdin 而不是 -e：Windows 的 cmd 会把 -e 里的双引号吃掉，脚本被截断。
    const child = spawn("ego-browser", ["nodejs"], {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      process.stdout.write(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
      process.stderr.write(String(chunk));
    });
    child.on("error", (error) => resolve({ code: 127, out: `${out}
${error.message}` }));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(BROWSER_SCRIPT, "utf8");
    child.stdin.end();
  });

const { code, out } = await run();

const banner = (lines) => {
  console.log("");
  for (const line of lines) console.log(line);
};

if (out.includes("ALREADY_GRANTED")) {
  banner([`${origin} 已经允许通知。`, "停手时你会收到一条浏览器通知。"]);
  process.exit(0);
}

if (out.includes("permission prompt")) {
  banner([
    "授权气泡已经弹出。",
    "现在去 ego-lite 窗口点「允许」（如果点了「阻止」，重跑本命令可以再弹一次）。",
    `点完执行：node tools/notify-setup.mjs --check ${site || "h.liepin.com"}`,
  ]);
  process.exit(0);
}

if (out.includes("PERMISSION_AFTER granted")) {
  banner([`${origin} 已授权，并试发了一条通知。`, "如果没看到，检查系统是否允许 Chrome 通知（macOS：系统设置 → 通知）。"]);
  process.exit(0);
}

if (out.includes("NOT_GRANTED") || out.includes("NO_PROMPT")) {
  banner([
    `没有拿到授权（当前 ${origin.replace(/^https?:\/\//, "")} 仍是未授权状态）。`,
    "两条路，任选：",
    "  1. 在 ego-lite 里打开 chrome://settings/content/notifications ，把该站点加进「允许」；",
    "  2. 检查系统是否允许 Chrome 发通知，然后重跑本命令。",
  ]);
  process.exit(1);
}

banner([`引导脚本没跑通（exit ${code}），上面的输出是原始信息。`]);
process.exit(code || 1);
