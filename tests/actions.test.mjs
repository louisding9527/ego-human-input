// 契约层行为测试：用假浏览器跑真实的 click / type / read / goto。
// 覆盖闸门顺序、失败路径与落库字段——这些以前只能在真站上验证。
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { create } from "../lib/human.mjs";
import { openStore } from "../lib/store.mjs";
import { HumanBlocked, HumanWarn } from "../lib/errors.mjs";

const seeded = (seed = 1) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

const tmpDb = () => {
  const file = join(tmpdir(), `ehi-act-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  return file;
};

const BOX = { x: 100, y: 200, w: 200, h: 60, vw: 1280, vh: 900, occluded: false, disabled: false };

function harness(options = {}) {
  const clock = { t: 1760000000000 };
  const calls = { moves: [], clicks: [], wheels: [], types: [], inserts: [], presses: [], gotos: [] };
  const boxes = options.boxes || { "css=#go": { ...BOX } };
  const sentinelValue = { untrusted: 0, silentWrite: 0, mutations: 0 };
  let pendingMutations = 0;
  let url = "https://h.liepin.com/";
  const reacts = options.reacts !== false;

  const browser = {
    url: async () => url,
    goto: async (target) => {
      calls.gotos.push(target);
      url = target;
    },
    waitSelector: async () => {},
    health: async () => ({ webdriver: false, ua: "Mozilla/5.0 Chrome/140", tz: "Asia/Shanghai", gpu: "GPU", vw: 1280, vh: 900 }),
    challenge: async () => [],
    toast: async () => null,
    pageState: async () => ({ url, title: "", ready: "complete", path: "/" }),
    box: async (locator) => boxes[String(locator)] || null,
    text: async () => "",
    focused: async () => true,
    installProbe: async () => {},
    readSentinel: async () => ({ ...sentinelValue }),
    requests: async () => [],
    mouse: {
      move: async (x, y) => calls.moves.push([x, y]),
      click: async (x, y, opts) => {
        calls.clicks.push({ x, y, ...opts });
        if (reacts) pendingMutations += 1;
      },
      wheel: async (dx, dy) => calls.wheels.push([dx, dy]),
    },
    keyboard: {
      type: async (ch) => {
        if (options.failType) throw new Error("keyboard gone");
        calls.types.push(ch);
      },
      insertText: async (t) => {
        if (options.failType) throw new Error("keyboard gone");
        calls.inserts.push(t);
      },
      press: async (k) => {
        if (options.failType) throw new Error("keyboard gone");
        calls.presses.push(k);
      },
    },
  };

  // 页面反应发生在动作返回之后：下一次 sleep 才把 DOM 变更记上。
  const sleep = async () => {
    if (!pendingMutations) return;
    sentinelValue.mutations += pendingMutations;
    pendingMutations = 0;
  };

  return { browser, sleep, calls, sentinelValue, clock, boxes, url: () => url };
}

async function session(h, options = {}) {
  const file = tmpDb();
  const store = openStore(file);
  const handle = await create(null, {
    browser: h.browser,
    sleep: h.sleep,
    rand: seeded(options.seed || 3),
    now: () => (h.clock.t += 1),
    store,
  });
  return {
    handle,
    store,
    file,
    events: () => store.eventsOfRun(handle.runId),
    close() {
      store.close();
      rmSync(file, { force: true });
    },
  };
}

test("click 找不到元素时抛 s1-missing，并把配额还回去", async () => {
  const h = harness({ boxes: {} });
  const s = await session(h);
  try {
    await assert.rejects(() => s.handle.click("css=#nope"), (error) => error instanceof HumanWarn && error.payload.trigger === "s1-missing");
    assert.equal(h.calls.clicks.length, 0, "没定位到就不该发指针点击");
    const rows = s.store.db.prepare("SELECT used FROM budget_use").all();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].used), 0, "预留必须被释放");
    const events = s.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, 0);
    assert.match(events[0].flags, /s1-missing/);
  } finally {
    s.close();
  }
});

test("click 成功时落点偏离中心，并记下移动点数与路径长度", async () => {
  const h = harness();
  const s = await session(h);
  try {
    const result = await s.handle.click("css=#go");
    assert.equal(result.ok, true);
    assert.equal(h.calls.clicks.length, 1);
    const [{ x, y }] = h.calls.clicks;
    assert.notEqual(x, BOX.x, "落点不该正好是几何中心");
    assert.ok(Math.abs(x - BOX.x) <= BOX.w / 2);

    const [event] = s.events();
    assert.equal(event.action, "write");
    assert.equal(event.ok, 1);
    assert.ok(Number(event.landing_px) > 0, `landing_px=${event.landing_px}`);
    assert.ok(Number(event.move_points) >= 10, `move_points=${event.move_points}`);
    assert.ok(Number(event.travel_px) > 0, `travel_px=${event.travel_px}`);
    assert.equal(String(event.target_hash).length, 8);
    assert.deepEqual(JSON.parse(JSON.stringify(s.store.db.prepare("SELECT used FROM budget_use").get())), { used: 1 });
  } finally {
    s.close();
  }
});

test("零尺寸、遮挡、disabled 分别抛对应异常且都不点", async () => {
  const cases = [
    [{ "css=#a": { ...BOX, w: 0 } }, "s1-zero"],
    [{ "css=#a": { ...BOX, occluded: true } }, "s2-occluded"],
    [{ "css=#a": { ...BOX, disabled: true } }, "s3-disabled"],
  ];
  for (const [boxes, trigger] of cases) {
    const h = harness({ boxes });
    const s = await session(h);
    try {
      await assert.rejects(() => s.handle.click("css=#a"), (error) => error.payload?.trigger === trigger, `${trigger} 未被抛出`);
      assert.equal(h.calls.clicks.length, 0);
      assert.match(s.events()[0].flags, new RegExp(trigger));
    } finally {
      s.close();
    }
  }
});

test("冻结之后闸门先拦，指针一动不动", async () => {
  const h = harness();
  const s = await session(h);
  try {
    h.sentinelValue.untrusted = 1;
    await assert.rejects(() => s.handle.click("css=#go"), (error) => error instanceof HumanBlocked && error.payload.trigger === "untrusted_input");
    const clicked = h.calls.clicks.length;
    const moved = h.calls.moves.length;

    await assert.rejects(() => s.handle.click("css=#go"), (error) => error instanceof HumanBlocked && error.payload.trigger === "frozen");
    assert.equal(h.calls.clicks.length, clicked);
    assert.equal(h.calls.moves.length, moved);
    assert.ok(s.events().some((event) => event.action === "sentinel" && /untrusted/.test(event.flags)));
  } finally {
    s.close();
  }
});

test("type 逐键发出，并记一条 type 事件", async () => {
  const h = harness();
  const s = await session(h);
  try {
    const result = await s.handle.type("ab");
    assert.ok(result.ops >= 2);
    assert.equal(h.calls.types.join(""), "ab");
    const [event] = s.events();
    assert.equal(event.action, "write");
    assert.match(event.flags, /type/);
  } finally {
    s.close();
  }
});

test("type 第一个键就失败时归还配额", async () => {
  const h = harness({ failType: true });
  const s = await session(h);
  try {
    await assert.rejects(() => s.handle.type("ab"), /keyboard gone/);
    const rows = s.store.db.prepare("SELECT used FROM budget_use").all();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].used), 0);
    assert.equal(s.events().length, 0, "一个键都没发出去就不该有动作记录");
  } finally {
    s.close();
  }
});

test("goto 拒绝接口端点并冻结，不会发起导航", async () => {
  const h = harness();
  const s = await session(h);
  try {
    await assert.rejects(
      () => s.handle.goto("https://h.liepin.com/search/getConditionItem"),
      (error) => error.payload?.trigger === "b4-api-endpoint",
    );
    assert.equal(h.calls.gotos.length, 0);
    await assert.rejects(() => s.handle.goto("https://h.liepin.com/list"), (error) => error.payload?.trigger === "frozen");
    assert.equal(h.calls.gotos.length, 0);
  } finally {
    s.close();
  }
});

test("goto 正常导航记一条 nav 事件", async () => {
  const h = harness();
  const s = await session(h);
  try {
    await s.handle.goto("https://h.liepin.com/list");
    assert.deepEqual(h.calls.gotos, ["https://h.liepin.com/list"]);
    const event = s.events().at(-1);
    assert.equal(event.action, "nav");
    assert.equal(event.ok, 1);
  } finally {
    s.close();
  }
});

test("read 记一条 read 事件，并真的滚了轮子", async () => {
  const h = harness();
  const s = await session(h);
  try {
    const result = await s.handle.read(1);
    assert.equal(result.total, 1000);
    assert.ok(h.calls.wheels.length >= 1);
    const event = s.events().at(-1);
    assert.equal(event.action, "read");
    assert.match(event.flags, /pause/);
  } finally {
    s.close();
  }
});

test("inspect 只读且哨兵可查", async () => {
  const h = harness();
  const s = await session(h);
  try {
    const snapshot = await s.handle.inspect.sentinel();
    assert.deepEqual(snapshot, { untrusted: 0, silentWrite: 0, mutations: 0 });
    assert.equal(await s.handle.inspect.rect("css=#missing"), null);
    assert.equal(s.handle.inspect.query("select count(*) as c from events")[0].c, 0);
    assert.throws(() => s.handle.inspect.query("delete from events"), /only SELECT/);
  } finally {
    s.close();
  }
});
