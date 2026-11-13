const { human } = await import(new URL("../lib/human.mjs", import.meta.url).href);

const task = await taskSpace("human input demo");
const page = task.page("p1");
await page.goto("https://example.com");

await page.evaluate(() => { /* lint-allow: 只装事件记录器，不改页面状态 */
  window.__rec = { move: [], key: [], wheel: [], untrusted: 0 };
  addEventListener("mousemove", (e) => window.__rec.move.push(e.timeStamp), true);
  addEventListener("wheel", (e) => window.__rec.wheel.push({ t: e.timeStamp, d: e.deltaY, trusted: e.isTrusted }), true);
  addEventListener("keydown", (e) => {
    window.__rec.key.push(e.timeStamp);
    if (!e.isTrusted) window.__rec.untrusted += 1;
  }, true);
});

const h = await human.create(page);
console.log("site:", h.site());
console.log("health:", { webdriver: h.health.webdriver, tz: h.health.tz, warnings: h.health.warnings });

const click = await h.click({ x: 300, y: 220 });
await h.type("hello");
const read = await h.read();

const stats = await page.evaluate(() => { /* lint-allow: 只读统计 */
  const rec = window.__rec;
  const gaps = rec.move.slice(1).map((t, i) => Math.round(t - rec.move[i]));
  return {
    moves: rec.move.length,
    minGap: gaps.length ? Math.min(...gaps) : null,
    distinctGaps: new Set(gaps).size,
    wheel: rec.wheel.length,
    wheelTrusted: rec.wheel.every((w) => w.trusted),
    keys: rec.key.length,
    untrusted: rec.untrusted,
  };
});

console.log("click:", click);
console.log("read:", read);
console.log("stats:", stats);
console.log("state:", h.state());
console.log("sentinel:", await h.inspect.sentinel());
console.log("pageState:", await h.inspect.pageState());
console.log("events:", h.inspect.query("select action, ok, flags from events order by id desc limit 5"));
console.log("flush:", await h.flush());

await task.finish({ keep: [] });
