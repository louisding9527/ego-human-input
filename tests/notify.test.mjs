// 停手通知：通道只有一条，但必须真的发出去、且失败不影响主流程。
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { buildMessage, createNotifier, BLOCK_HINTS } from "../lib/notify.mjs";
import { create } from "../lib/human.mjs";
import { openStore } from "../lib/store.mjs";
import { HumanBlocked } from "../lib/errors.mjs";

const BOX = { x: 100, y: 200, w: 200, h: 60, vw: 1280, vh: 900, occluded: false, disabled: false };

function fakeBrowser(options = {}) {
  const sent = [];
  const sentinel = { untrusted: 0, silentWrite: 0, mutations: 0 };
  let pending = 0;
  return {
    sent,
    sentinel,
    browser: {
      url: async () => options.url || "https://h.liepin.com/search?kw=secret",
      goto: async () => {},
      waitSelector: async () => {},
      health: async () => ({ webdriver: false, ua: "Mozilla/5.0 Chrome/140", tz: "Asia/Shanghai", gpu: "GPU", vw: 1280, vh: 900 }),
      challenge: async () => options.challenge || [],
      toast: async () => null,
      pageState: async () => ({ url: "https://h.liepin.com/", title: "", ready: "complete", path: "/" }),
      box: async () => ({ ...BOX }),
      text: async () => "",
      focused: async () => true,
      installProbe: async () => {},
      readSentinel: async () => ({ ...sentinel }),
      requests: async () => [],
      notifyPermission: async () => options.permission || "granted",
      notify: async (message) => {
        sent.push(message);
        return "sent";
      },
      mouse: {
        move: async () => {},
        click: async () => {
          pending += 1;
        },
        wheel: async () => {},
      },
      keyboard: { type: async () => {}, insertText: async () => {}, press: async () => {} },
    },
    flush() {
      if (pending) sentinel.mutations += pending;
      pending = 0;
    },
  };
}

const seeded = (seed = 1) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

test("通知文案说清在哪、为什么停、该做什么，且不带 query", () => {
  const message = buildMessage({ site: "h.liepin.com", path: "/search", trigger: "challenge", runId: "run-1" });
  assert.match(message.title, /challenge/);
  assert.match(message.body, /h\.liepin\.com\/search/);
  assert.match(message.body, /人机验证/);
  assert.match(message.body, /run-1/);
  assert.equal(message.body.includes("secret"), false, "通知里不能出现关键词");
  assert.equal(message.tag, "ego-human-input-run-1");
  assert.ok(BLOCK_HINTS.challenge);
});

test("权限没给时不假装发出去", async () => {
  const fake = fakeBrowser({ permission: "default" });
  const notifier = createNotifier({ browser: fake.browser, config: {} });
  const result = await notifier.send(buildMessage({ trigger: "challenge" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "permission:default");
  assert.equal(fake.sent.length, 0);
  assert.equal(notifier.status().failed, 1);
});

test("通道关掉、没有浏览器都能安全返回", async () => {
  const off = createNotifier({ browser: fakeBrowser().browser, config: { channel: "none" } });
  assert.deepEqual(await off.send(buildMessage({ trigger: "challenge" })), { ok: false, reason: "disabled" });

  const bare = createNotifier({ browser: null, config: {} });
  assert.deepEqual(await bare.send(buildMessage({ trigger: "challenge" })), { ok: false, reason: "no-browser" });
});

async function session(fake, options = {}) {
  const file = join(tmpdir(), `ehi-notify-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  const store = openStore(file);
  const clock = { t: Date.now() };
  let onBlockArgs = null;
  const h = await create(null, {
    browser: fake.browser,
    sleep: async (ms) => {
      clock.t += Math.max(0, Math.round(ms || 0));
      fake.flush();
    },
    rand: seeded(5),
    now: () => clock.t,
    store,
    onBlock: options.onBlock === false
      ? undefined
      : (payload, context) => {
        onBlockArgs = { payload, message: context.message };
      },
  });
  return { h, store, file, sent: fake.sent, onBlock: () => onBlockArgs, close: () => { store.close(); rmSync(file, { force: true }); } };
}

test("遇到挑战页时发一条通知，并把 onBlock 交回业务脚本", async () => {
  const fake = fakeBrowser({ challenge: ["captcha_widget"] });
  const s = await session(fake);
  try {
    await assert.rejects(() => s.h.click("css=#go"), (error) => error instanceof HumanBlocked && error.payload.trigger === "challenge");
    await s.h.flush("blocked");

    assert.equal(s.sent.length, 1, "应该只发一条");
    assert.match(s.sent[0].title, /challenge/);
    const args = s.onBlock();
    assert.equal(args.payload.trigger, "challenge");
    assert.match(args.message.body, /人机验证/);

    const kinds = s.h.timeline.map((item) => item.kind);
    assert.ok(kinds.includes("block"));
  } finally {
    s.close();
  }
});

test("授权缺失时记一笔降级，但不影响抛错", async () => {
  const fake = fakeBrowser({ challenge: ["captcha_widget"], permission: "denied" });
  const s = await session(fake);
  try {
    await assert.rejects(() => s.h.click("css=#go"), (error) => error.payload.trigger === "challenge");
    await s.h.flush("blocked");
    assert.equal(s.sent.length, 0);
    const notify = s.h.timeline.find((item) => item.kind === "notify");
    assert.equal(notify.detail.ok, false);
    assert.equal(notify.detail.reason, "permission:denied");
  } finally {
    s.close();
  }
});

test("onBlock 是可选依赖，不给也能正常停手", async () => {
  const fake = fakeBrowser({ challenge: ["captcha_widget"] });
  const s = await session(fake, { onBlock: false });
  try {
    await assert.rejects(() => s.h.click("css=#go"), (error) => error.payload.trigger === "challenge");
    await s.h.flush("blocked");
    assert.equal(s.sent.length, 1);
    assert.equal(await s.h.notifyPermission(), "granted");
  } finally {
    s.close();
  }
});
