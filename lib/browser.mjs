// 浏览器适配层：唯一直接接触 ego-lite Page 对象的地方。
// 上层的动作层只用这里的方法名，因此测试可以换成一个假的 browser。
import {
  BOX_FN,
  TEXT_FN,
  FOCUS_FN,
  PAGE_STATE_FN,
  HEALTH_FN,
  CHALLENGE_FN,
  SOFT_TOAST_FN,
} from "./page-fns.mjs";
import { parseLocator, toEvalArg } from "./locator.mjs";
import { PROBE_FN, SENTINEL_FN } from "./guard.mjs";

export function createBrowser(page) {
  if (!page) throw new Error("createBrowser: page is required");
  const ev = (fn, arg) => page.evaluate(fn, arg);

  return {
    url: async () => String(await page.url()),
    goto: (url, options) => page.goto(url, options),
    reload: () => page.reload(),
    waitSelector: (selector, options) => page.waitForSelector(selector, options),
    health: () => ev(HEALTH_FN),
    challenge: async () => (await ev(CHALLENGE_FN)) || [],
    toast: () => ev(SOFT_TOAST_FN),
    pageState: () => ev(PAGE_STATE_FN),
    box: (locator) => ev(BOX_FN, toEvalArg(parseLocator(locator))),
    text: (locator, max = 120) => ev(TEXT_FN, { ...toEvalArg(parseLocator(locator)), max }),
    focused: (arg) => ev(FOCUS_FN, arg),
    installProbe: (channel) => ev(PROBE_FN, { channel }),
    readSentinel: (channel) => ev(SENTINEL_FN, { channel }),
    async requests(limit = 20) {
      const events = await page.events().catch(() => []);
      return events
        .filter((event) => event.method === "Network.requestWillBeSent")
        .slice(-limit)
        .map((event) => event.params?.request?.url || "");
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      click: (x, y, options) => page.mouse.click(x, y, options),
      wheel: (dx, dy) => page.mouse.wheel(dx, dy),
    },
    keyboard: {
      type: (ch) => page.keyboard.type(ch),
      insertText: (text) => page.keyboard.insertText(text),
      press: (key) => page.keyboard.press(key),
    },
  };
}
