// 端到端：用假浏览器跑一次完整会话，flush 落库，再用真门禁判它。
// 这条测试的意义是：库自己产出的 run 必须能通过库自己的门禁。
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create } from "../lib/human.mjs";
import { createRandom } from "../lib/timing.mjs";
import { openStore } from "../lib/store.mjs";

const VERIFY_TOOL = fileURLToPath(new URL("../tools/verify-human.mjs", import.meta.url));

const BOX = { x: 120, y: 240, w: 220, h: 64, vw: 1280, vh: 900, occluded: false, disabled: false };

function fakeBrowser(clock) {
  let url = "https://h.liepin.com/";
  const sentinel = { untrusted: 0, silentWrite: 0, mutations: 0 };
  let pending = 0;
  return {
    sentinel,
    browser: {
      url: async () => url,
      goto: async (target) => {
        url = target;
      },
      waitSelector: async () => {},
      health: async () => ({ webdriver: false, ua: "Mozilla/5.0 Chrome/140", tz: "Asia/Shanghai", gpu: "GPU", vw: 1280, vh: 900 }),
      challenge: async () => [],
      toast: async () => null,
      pageState: async () => ({ url, title: "", ready: "complete", path: "/" }),
      box: async (locator) => (String(locator) === "css=#go" ? { ...BOX } : null),
      text: async () => "",
      focused: async () => true,
      installProbe: async () => {},
      readSentinel: async () => ({ ...sentinel }),
      requests: async () => [],
      mouse: {
        move: async () => {},
        click: async () => {
          pending += 1;
        },
        wheel: async () => {},
      },
      keyboard: {
        type: async () => {},
        insertText: async () => {},
        press: async () => {},
      },
    },
    flush: () => {
      if (pending) {
        sentinel.mutations += pending;
        pending = 0;
      }
    },
  };
}

test("库里产生的 run 能过自己的 11 条门禁", async () => {
  const file = join(tmpdir(), `ehi-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  const clock = { t: Date.now() };
  const fake = fakeBrowser(clock);
  const store = openStore(file);
  try {
    const h = await create(null, {
      browser: fake.browser,
      rand: createRandom(9),
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += Math.max(0, Math.round(ms || 0));
        fake.flush();
      },
      store,
    });

    await h.goto("https://h.liepin.com/list");
    await h.click("css=#go", { as: "nav" });
    await h.read(2);
    await h.click("css=#go", { as: "detail" });
    await h.type("hello world");
    await h.read(2);
    await h.flush("done");

    let report = "";
    let status = 0;
    try {
      report = execFileSync(process.execPath, [VERIFY_TOOL, "--db", file], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      report = String(error.stdout || "");
      status = error.status;
    }
    assert.equal(status, 0, report);
    assert.match(report, /gate ok: 11\/11/, report);
  } finally {
    try {
      store.close();
    } catch {
      /* flush 里已经按 run 结束，这里只关句柄 */
    }
    rmSync(file, { force: true });
  }
});
