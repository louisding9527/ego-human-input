// 页面哨兵的单元测试：用一个极小的假 DOM 跑真实的 PROBE_FN。
// 目的是锁住「不挂全局对象、不碰原型」这条边界，以及信任时间戳 + 值比对的口径。
import test from "node:test";
import assert from "node:assert/strict";
import { PROBE_FN, SENTINEL_FN } from "../lib/guard.mjs";

const KEYS = ["document", "addEventListener", "dispatchEvent", "MutationObserver"];

function installDom({ fields = 2 } = {}) {
  const listeners = new Map();
  const inputs = Array.from({ length: fields }, () => ({ nodeType: 1, value: "", textContent: "" }));
  let clock = 0;
  const saved = {};
  const doc = {
    documentElement: { nodeType: 1 },
    body: { nodeType: 1 },
    querySelectorAll: () => inputs,
  };
  const perfDesc = Object.getOwnPropertyDescriptor(globalThis, "performance");
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true });

  const add = (type, fn) => {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  };
  const dispatch = (event) => {
    const view = { type: event.type, detail: event.detail, isTrusted: event.isTrusted === true, target: event.target ?? null };
    for (const fn of listeners.get(view.type) || []) fn(view);
    return true;
  };

  for (const key of KEYS) saved[key] = globalThis[key];
  globalThis.document = doc;
  globalThis.addEventListener = add;
  globalThis.dispatchEvent = dispatch;
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
  };

  return {
    inputs,
    listeners,
    advance: (ms) => {
      clock += ms;
    },
    fire(type, { trusted = false, target = null } = {}) {
      dispatch({ type, isTrusted: trusted, target, detail: null });
    },
    restore() {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
      }
      if (perfDesc) Object.defineProperty(globalThis, "performance", perfDesc);
    },
  };
}

const channel = "hi:test";

test("probe keeps no global object and no prototype hooks", () => {
  const dom = installDom();
  try {
    const before = Object.getOwnPropertyNames(globalThis).sort().join(",");
    PROBE_FN({ channel });
    const after = Object.getOwnPropertyNames(globalThis).sort().join(",");
    assert.equal(after, before, "哨兵不得往全局命名空间塞任何东西");
    assert.equal(dom.listeners.has("pointerdown"), true);
    assert.equal(dom.listeners.has(channel), true, "读回只走随机名事件通道");
  } finally {
    dom.restore();
  }
});

test("untrusted events are counted and read back through the channel", () => {
  const dom = installDom();
  try {
    PROBE_FN({ channel });
    dom.fire("pointerdown", { trusted: false });
    dom.fire("keydown", { trusted: false });
    assert.equal(SENTINEL_FN({ channel }).untrusted, 2);
    assert.equal(SENTINEL_FN({ channel }).untrusted, 2, "读取本身不能改变计数");
  } finally {
    dom.restore();
  }
});

test("silent writes need a stale trust timestamp and a changed value", () => {
  const dom = installDom();
  try {
    PROBE_FN({ channel });
    const field = dom.inputs[0];
    assert.equal(SENTINEL_FN({ channel }).silentWrite, 0, "第一次扫描只建基线");

    // 信任输入路径：先有事件，再改值。读过之后不应记旁路写入。
    field.value = "张";
    dom.fire("input", { trusted: true, target: field });
    dom.advance(50);
    assert.equal(SENTINEL_FN({ channel }).silentWrite, 0);

    // 旁路写入：没人碰键盘，值自己变了，且已离上次信任输入超过 200ms。
    field.value = "李";
    dom.advance(600);
    assert.equal(SENTINEL_FN({ channel }).silentWrite, 1);
    assert.equal(SENTINEL_FN({ channel }).silentWrite, 1, "同一处改动只记一次");
  } finally {
    dom.restore();
  }
});

test("installing twice does not double count", () => {
  const dom = installDom();
  try {
    PROBE_FN({ channel });
    PROBE_FN({ channel });
    dom.fire("pointerdown", { trusted: false });
    assert.equal(SENTINEL_FN({ channel }).untrusted, 1);
  } finally {
    dom.restore();
  }
});

test("a blocked channel reports null so the caller can mark degradation", () => {
  const dom = installDom();
  try {
    assert.equal(SENTINEL_FN({ channel }), null, "没有哨兵时必须返回 null，不能假装读到 0");
    const blocked = installDom();
    try {
      blocked.listeners.clear();
      PROBE_FN({ channel });
      blocked.listeners.delete(channel);
      assert.equal(SENTINEL_FN({ channel }), null);
    } finally {
      blocked.restore();
    }
  } finally {
    dom.restore();
  }
});
