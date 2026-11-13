// 桥接层回归：收尾只发生一次、交权顺序、车道划分、iframe 定位。
// 这四条是 ego-browser 与 ego-human-input 之间最容易再次跑偏的地方。
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create } from "../lib/human.mjs";
import { openStore } from "../lib/store.mjs";
import { createRandom } from "../lib/timing.mjs";
import { lintSource } from "../tools/lint-script.mjs";
import { BOX_FN } from "../lib/page-fns.mjs";
import { parseUrl, classifyUrl } from "../lib/guard.mjs";

const BOX = { x: 120, y: 240, w: 220, h: 64, vw: 1280, vh: 900, occluded: false, disabled: false };

function fakeBrowser(url = "https://h.liepin.com/") {
  const sentinel = { untrusted: 0, silentWrite: 0, mutations: 0 };
  return {
    url: async () => url,
    goto: async (target) => {
      url = target;
    },
    waitSelector: async () => {},
    screenshot: async () => "/tmp/shot.png",
    health: async () => ({ webdriver: false, ua: "Mozilla/5.0 Chrome/140", tz: "Asia/Shanghai", gpu: "GPU", vw: 1280, vh: 900 }),
    challenge: async () => [],
    toast: async () => null,
    pageState: async () => ({ url, title: "", ready: "complete", path: "/" }),
    box: async () => ({ ...BOX }),
    text: async () => "",
    focused: async () => true,
    installProbe: async () => {},
    readSentinel: async () => ({ ...sentinel }),
    requests: async () => [],
    mouse: { move: async () => {}, click: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, insertText: async () => {}, press: async () => {} },
  };
}

function tmpDb(tag) {
  const file = join(tmpdir(), `ehi-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  return file;
}

function fakeSpace(calls) {
  return {
    ownership: "agent",
    finish: async (opts) => calls.push(["finish", opts]),
    handOff: async () => calls.push(["handOff"]),
  };
}

test("flush 只落一次：连调两次不重复 endRun、不二次 close", async () => {
  const file = tmpDb("flush");
  const h = await create(null, { browser: fakeBrowser(), rand: createRandom(3), sleep: async () => {}, dbPath: file });
  const first = await h.flush();
  const second = await h.flush();
  assert.equal(second.runId, first.runId);
  assert.equal(second.written, first.written);
  const store = openStore(file);
  const runs = store.db.prepare("select count(*) as n, sum(ended_at is null) as open from runs").get();
  assert.equal(runs.n, 1);
  assert.equal(runs.open, 0);
  store.close();
  rmSync(file, { force: true });
});

test("finish 先落盘再关空间，重复调用只关一次", async () => {
  const file = tmpDb("finish");
  const calls = [];
  const store = openStore(file);
  const h = await create(null, {
    browser: fakeBrowser(),
    rand: createRandom(4),
    sleep: async () => {},
    store,
    space: fakeSpace(calls),
  });
  const done = await h.finish({ keep: ["p2"] });
  const again = await h.finish();
  assert.deepEqual(done.kept, ["p2"]);
  assert.equal(again.finished, true);
  assert.deepEqual(calls, [["finish", { keep: ["p2"] }]]);
  store.close();
  rmSync(file, { force: true });
});

test("handOff 先落盘再交权，run 结局记为 handoff", async () => {
  const file = tmpDb("handoff");
  const calls = [];
  const store = openStore(file);
  const h = await create(null, {
    browser: fakeBrowser(),
    rand: createRandom(5),
    sleep: async () => {},
    store,
    space: fakeSpace(calls),
  });
  const result = await h.handOff({ reason: "challenge" });
  assert.equal(result.handedOff, true);
  assert.equal(result.reason, "challenge");
  assert.deepEqual(calls, [["handOff"]]);
  const row = store.db.prepare("select outcome from runs where id = ?").get(h.runId);
  assert.equal(row.outcome, "handoff");
  store.close();
  rmSync(file, { force: true });
});

test("没注入 space 时 finish/handOff 报可执行的错，而不是静默不关空间", async () => {
  const h = await create(null, { browser: fakeBrowser(), rand: createRandom(6), sleep: async () => {}, store: openStore(tmpDb("nospace")) });
  await assert.rejects(() => h.finish(), /space/);
  await assert.rejects(() => h.handOff(), /space/);
  h.flush();
});

test("lint 只禁输入类 page 调用，观察与系统级调用放行", () => {
  const bad = [
    'await page.click("@21");',
    'await page.fill("#q", "x");',
    'await page.mouse.move(10, 20);',
    'await page.keyboard.type("abc");',
    'await page.hover("css=.x");',
  ];
  for (const line of bad) assert.ok(lintSource(line).length > 0, `expected violation: ${line}`);

  const good = [
    "const snap = await page.snapshot();",
    'await page.acceptDialog("ok");',
    'await page.setInputFiles("input[type=file]", ["/tmp/a.pdf"]);',
    'await page.selectOption("select[name=month]", { label: "October" });',
    'const popup = page.waitForEvent("popup");',
    "console.log(await page.url(), await page.title(), await page.info());",
    'await page.keyboard.paste({ text: "a", html: "<b>a</b>" });',
    "const tabs = await task.tabs();",
  ];
  for (const line of good) assert.equal(lintSource(line).length, 0, `unexpected violation: ${line}`);
});

test("create() 之前的引导导航放行，之后一律 h.goto", () => {
  const boot = 'await page.goto("https://example.com");\nconst h = await human.create(page);';
  assert.deepEqual(lintSource(boot), []);
  const later = 'const h = await human.create(page);\nawait page.goto("https://example.com/x");';
  assert.equal(lintSource(later).length, 1);
  const diagnosed = 'await page.cdp("Runtime.enable"); // lint-allow cdp: 诊断轮';
  assert.deepEqual(lintSource(diagnosed), []);
});

test("本地页面归并为 local，不被 host-drift 与 unparsable-url 误杀", () => {
  assert.equal(parseUrl("data:text/html,<b>x</b>").host, "local");
  assert.equal(parseUrl("about:blank").host, "local");
  assert.equal(classifyUrl("data:text/html,<b>x</b>", "local").ok, true);
  assert.equal(classifyUrl("file:///D:/demo/page.html", "local").ok, true);
  assert.equal(classifyUrl("https://h.liepin.com/", "local").reason, "host-drift");
});

test("同步改 DOM 的点击不算 noop：基线在点击前取", async () => {
  const file = tmpDb("sync-mutate");
  const store = openStore(file);
  const sentinel = { untrusted: 0, silentWrite: 0, mutations: 0 };
  const b = fakeBrowser();
  b.readSentinel = async () => ({ ...sentinel });
  b.mouse = {
    move: async () => {},
    wheel: async () => {},
    // 同步生效：点击返回时页面已经变了（改标题、切 class 都属于这一类）
    click: async () => {
      sentinel.mutations += 2;
    },
  };
  const h = await create(null, { browser: b, rand: createRandom(7), sleep: async () => {}, store });
  const result = await h.click("css=#go");
  assert.equal(result.ok, true);
  assert.equal(result.noop, undefined);
  store.close();
  rmSync(file, { force: true });
});

test("点进输入框只移动焦点不算 noop", async () => {
  const file = tmpDb("focus-only");
  const store = openStore(file);
  let active = "";
  const b = fakeBrowser();
  b.readSentinel = async () => ({ untrusted: 0, silentWrite: 0, mutations: 0 });
  b.active = async () => active;
  b.mouse = {
    move: async () => {},
    wheel: async () => {},
    click: async () => {
      active = "input#q|editable";
    },
  };
  const h = await create(null, { browser: b, rand: createRandom(8), sleep: async () => {}, store });
  const result = await h.click("css=#q");
  assert.equal(result.ok, true);
  store.close();
  rmSync(file, { force: true });
});

test("where.mjs 打印可用的 importUrl，且不写死平台路径", () => {
  const script = fileURLToPath(new URL("../tools/where.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  const info = JSON.parse(out);
  assert.ok(info.skillDir.endsWith("ego-human-input"), info.skillDir);
  assert.match(info.importUrl, /^file:\/\/\/.*lib\/human\.mjs$/);
  assert.equal(info.platform, process.platform);
  // ego lite 没装时是 null，装了就是绝对路径——两种都合法，不能是猜出来的相对路径
  assert.ok(info.egoSkillsDir === null || info.egoSkillsDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(info.egoSkillsDir));
});

test("系统车道：h.select / h.upload 先声明静默窗口再动", async () => {
  const file = tmpDb("system-lane");
  const store = openStore(file);
  const calls = [];
  const b = fakeBrowser();
  b.muteProbe = async (channel, ms) => calls.push(["mute", ms]);
  b.selectOption = async (selector, choice) => calls.push(["select", selector, choice]);
  b.setInputFiles = async (selector, files) => calls.push(["upload", selector, files]);
  const h = await create(null, { browser: b, rand: createRandom(9), sleep: async () => {}, store });
  await h.select("css=#s", { label: "two" });
  await h.upload("css=#f", ["/tmp/a.pdf"]);
  assert.deepEqual(calls[0], ["mute", 2000]);
  assert.deepEqual(calls[1], ["select", "#s", { label: "two" }]);
  assert.deepEqual(calls[2], ["mute", 2000]);
  assert.deepEqual(calls[3], ["upload", "#f", ["/tmp/a.pdf"]]);
  await assert.rejects(() => h.select("role:combobox", { label: "x" }), /css=/);
  store.close();
  rmSync(file, { force: true });
});

test("同源 iframe 的点击按真实变化判定，不靠 frame 标记放行", async () => {
  const run = async (mutate) => {
    const file = tmpDb("frame-click");
    const store = openStore(file);
    const sentinel = { untrusted: 0, silentWrite: 0, mutations: 0 };
    const b = fakeBrowser();
    b.box = async () => ({ ...BOX, inFrame: true });
    b.readSentinel = async () => ({ ...sentinel });
    b.mouse = {
      move: async () => {},
      wheel: async () => {},
      click: async () => {
        if (mutate) sentinel.mutations += 1; // 观察器挂在 frame 上，frame 内变更可见
      },
    };
    const h = await create(null, { browser: b, rand: createRandom(10), sleep: async () => {}, store });
    const result = await h.click("css=#in");
    store.close();
    rmSync(file, { force: true });
    return result;
  };
  assert.equal((await run(true)).ok, true);
  const noop = await run(false);
  assert.equal(noop.ok, false);
  assert.equal(noop.noop, true);
});

test("点击后弹出原生对话框：按 onDialog 处理并补做校验", async () => {
  const file = tmpDb("dialog");
  const store = openStore(file);
  const b = fakeBrowser();
  let opened = false;
  const handled = [];
  const url = b.url;
  b.url = async () => {
    if (opened) {
      opened = false;
      const error = new Error("Runtime.evaluate cannot run while a JavaScript confirm dialog is open");
      error.name = "PageDialogOpenedError";
      throw error;
    }
    return url();
  };
  b.mouse = {
    move: async () => {},
    wheel: async () => {},
    click: async () => {
      opened = true;
    },
  };
  b.dismissDialog = async () => handled.push("dismiss");
  const h = await create(null, { browser: b, rand: createRandom(11), sleep: async () => {}, store });
  const result = await h.click("css=#ask", { onDialog: "dismiss" });
  assert.equal(result.ok, true);
  assert.deepEqual(handled, ["dismiss"]);
  store.close();
  rmSync(file, { force: true });
});

test("开标签/下载的点击不会被误判 noop：{expect} 或标签数变化都算证据", async () => {
  const file = tmpDb("popup-evidence");
  const store = openStore(file);
  let pages = 1;
  const b = fakeBrowser();
  b.readSentinel = async () => ({ untrusted: 0, silentWrite: 0, mutations: 0 });
  const h = await create(null, {
    browser: b,
    rand: createRandom(12),
    sleep: async () => {},
    store,
    space: { ownership: "agent", pages: async () => new Array(pages).fill({}), finish: async () => {}, handOff: async () => {} },
  });
  // 标签数变化 = 证据，不需要 expect
  b.mouse = { move: async () => {}, wheel: async () => {}, click: async () => { pages = 2; } };
  assert.equal((await h.click("css=#pop")).ok, true);
  // 全都没有变化时，仍按 noop 处理
  pages = 2;
  b.mouse = { move: async () => {}, wheel: async () => {}, click: async () => {} };
  assert.equal((await h.click("css=#dl", { expect: "download" })).ok, true);
  assert.equal((await h.click("css=#dl")).ok, false);
  store.close();
  rmSync(file, { force: true });
});

test("BOX_FN 下钻同源 frame，跨源 frame 明确标记而不是假装找不到", () => {
  const makeEl = (rect, extra = {}) => ({
    getClientRects: () => [{}],
    getBoundingClientRect: () => rect,
    contains: () => false,
    getAttribute: () => null,
    ...extra,
  });
  const target = makeEl({ x: 30, y: 40, width: 80, height: 30 });
  const innerDoc = {
    querySelectorAll: (selector) => (selector === "#target" ? [target] : []),
    elementFromPoint: () => target,
  };
  const frame = makeEl({ x: 100, y: 50, width: 600, height: 400 }, { contentDocument: innerDoc });
  const emptyDoc = { querySelectorAll: () => [], elementFromPoint: () => null };
  const origin = globalThis.document;
  const win = globalThis.window;
  try {
    globalThis.window = { innerWidth: 1280, innerHeight: 900 };
    globalThis.document = {
      querySelectorAll: (selector) => (selector === "iframe,frame" ? [frame] : []),
      elementFromPoint: () => null,
    };
    const box = BOX_FN({ selector: "#target" });
    assert.equal(box.inFrame, true);
    assert.equal(box.x, 100 + 30 + 40);
    assert.equal(box.y, 50 + 40 + 15);
    assert.equal(box.w, 80);

    const blocked = makeEl({ x: 0, y: 0, width: 10, height: 10 });
    Object.defineProperty(blocked, "contentDocument", {
      get() {
        throw new Error("cross-origin");
      },
    });
    globalThis.document = {
      querySelectorAll: (selector) => (selector === "iframe,frame" ? [blocked] : []),
      elementFromPoint: () => null,
    };
    const cross = BOX_FN({ selector: "#target" });
    assert.equal(cross.crossOrigin, 1);
    assert.equal(cross.x, null);

    globalThis.document = emptyDoc;
    assert.equal(BOX_FN({ selector: "#target" }), null);
  } finally {
    globalThis.document = origin;
    globalThis.window = win;
  }
});
