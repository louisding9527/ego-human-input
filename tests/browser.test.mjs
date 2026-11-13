// 适配层测试：假 Page 记录调用，确认参数形状与真 ego-lite API 一致。
// 这是唯一贴着浏览器的那层，出错时最难在真站上定位，所以单独锁住。
import test from "node:test";
import assert from "node:assert/strict";
import { createBrowser } from "../lib/browser.mjs";

function fakePage() {
  const calls = { evaluate: [], mouse: [], keyboard: [], goto: [], wait: [] };
  const page = {
    url: async () => "https://h.liepin.com/a?x=1",
    goto: async (url, options) => calls.goto.push({ url, options }),
    reload: async () => calls.goto.push({ reload: true }),
    waitForSelector: async (selector, options) => calls.wait.push({ selector, options }),
    async evaluate(fn, arg) {
      calls.evaluate.push({ name: fn.name, arg, argc: arguments.length });
      if (fn.name === "BOX_FN") return { x: 1, y: 2, w: 3, h: 4, vw: 100, vh: 100 };
      if (fn.name === "CHALLENGE_FN") return ["captcha_widget"];
      return { ok: true };
    },
    events: async () => [
      { method: "Network.requestWillBeSent", params: { request: { url: "https://h.liepin.com/a" } } },
      { method: "Network.responseReceived", params: {} },
      { method: "Network.requestWillBeSent", params: { request: { url: "https://h.liepin.com/b" } } },
    ],
    mouse: {
      move: async (x, y) => calls.mouse.push({ op: "move", x, y }),
      click: async (x, y, options) => calls.mouse.push({ op: "click", x, y, options }),
      wheel: async (dx, dy) => calls.mouse.push({ op: "wheel", dx, dy }),
    },
    keyboard: {
      type: async (ch) => calls.keyboard.push({ op: "type", ch }),
      insertText: async (text) => calls.keyboard.push({ op: "insertText", text }),
      press: async (key) => calls.keyboard.push({ op: "press", key }),
    },
  };
  return { page, calls };
}

test("box 把 locator 解析成页面函数参数", async () => {
  const { page, calls } = fakePage();
  const browser = createBrowser(page);
  await browser.box("css=#a");
  await browser.box("href=/resume/1");
  await browser.box("role:button[name='搜 索']");
  assert.deepEqual(calls.evaluate.map((call) => call.arg), [
    { selector: "#a" },
    { selector: 'a[href="/resume/1"]' },
    { role: { role: "button", name: "搜 索" } },
  ]);
  assert.ok(calls.evaluate.every((call) => call.name === "BOX_FN"));
});

test("url / goto / waitSelector 原样转发", async () => {
  const { page, calls } = fakePage();
  const browser = createBrowser(page);
  assert.equal(await browser.url(), "https://h.liepin.com/a?x=1");
  await browser.goto("https://h.liepin.com/b", { timeout: 5000 });
  await browser.waitSelector("#x", { state: "visible", timeout: 100 });
  assert.deepEqual(calls.goto, [{ url: "https://h.liepin.com/b", options: { timeout: 5000 } }]);
  assert.deepEqual(calls.wait, [{ selector: "#x", options: { state: "visible", timeout: 100 } }]);
});

test("鼠标与键盘一次动作一次调用，不合并", async () => {
  const { page, calls } = fakePage();
  const browser = createBrowser(page);
  await browser.mouse.move(10, 20);
  await browser.mouse.click(10, 20, { delay: 40 });
  await browser.mouse.wheel(0, 300);
  await browser.keyboard.type("a");
  await browser.keyboard.insertText("中文");
  await browser.keyboard.press("Enter");
  assert.deepEqual(calls.mouse, [
    { op: "move", x: 10, y: 20 },
    { op: "click", x: 10, y: 20, options: { delay: 40 } },
    { op: "wheel", dx: 0, dy: 300 },
  ]);
  assert.deepEqual(calls.keyboard, [
    { op: "type", ch: "a" },
    { op: "insertText", text: "中文" },
    { op: "press", key: "Enter" },
  ]);
});

test("challenge 缺省为数组，requests 只取请求事件", async () => {
  const { page } = fakePage();
  const browser = createBrowser(page);
  assert.deepEqual(await browser.challenge(), ["captcha_widget"]);
  assert.deepEqual(await browser.requests(), ["https://h.liepin.com/a", "https://h.liepin.com/b"]);
});

test("无参数的 evaluate 只传一个实参（ego-lite 拒绝 undefined）", async () => {
  const { page, calls } = fakePage();
  const browser = createBrowser(page);
  await browser.health();
  await browser.pageState();
  for (const call of calls.evaluate) assert.equal(call.argc, 1, `${call.name} 传了 undefined`);

  await browser.box("css=#a");
  assert.equal(calls.evaluate.at(-1).argc, 2);
});
