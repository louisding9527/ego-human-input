// 最小闭环：一个不联网、不跳站的页面，用来验证拟人输入真的发生了。
// 页面上按钮改标题、输入框收文字，因此不需要真站也能看门禁是否通过。
const { human } = await import(new URL("../lib/human.mjs", import.meta.url).href);

const task = await taskSpace("human input demo");
const page = task.page("p1");
await page.goto(
  "data:text/html," +
    encodeURIComponent(
      "<body style='font:16px sans-serif;padding:200px'>" +
        "<button id=go style='padding:24px 40px'>go</button>" +
        "<input id=q placeholder='type here' style='font-size:18px;padding:10px'>" +
        "<script>go.onclick=()=>{document.title='clicked'}</script>" +
        "</body>",
    ),
);

// 只读记录器：证明事件是真实指针与按键发的。
await page.evaluate(() => { /* lint-allow: 只装事件记录器，不改页面状态 */
  window.__rec = { move: [], key: [], wheel: [], untrusted: 0 };
  addEventListener("mousemove", (e) => window.__rec.move.push(e.timeStamp), true);
  addEventListener("wheel", (e) => window.__rec.wheel.push({ t: e.timeStamp, d: e.deltaY, trusted: e.isTrusted }), true);
  addEventListener("keydown", (e) => {
    window.__rec.key.push(e.timeStamp);
    if (!e.isTrusted) window.__rec.untrusted += 1;
  }, true);
});

const h = await human.create(page, { space: task });
console.log("site:", h.site());
console.log("health:", { webdriver: h.health.webdriver, tz: h.health.tz, warnings: h.health.warnings });

let done = false;
try {
  console.log("click:", await h.click("css=#go"));
  await h.click("css=#q");
  console.log("type:", await h.type("hello world"));
  console.log("read:", await h.read());

  const stats = await page.evaluate(() => { /* lint-allow: 只读统计 */
    const rec = window.__rec;
    const gaps = rec.move.slice(1).map((t, i) => Math.round(t - rec.move[i]));
    return {
      title: document.title,
      typed: document.querySelector("#q").value,
      moves: rec.move.length,
      minGap: gaps.length ? Math.min(...gaps) : null,
      distinctGaps: new Set(gaps).size,
      wheel: rec.wheel.length,
      wheelTrusted: rec.wheel.every((w) => w.trusted),
      keys: rec.key.length,
      untrusted: rec.untrusted,
    };
  });
  console.log("stats:", stats);
  console.log("state:", h.state());
  console.log("session:", h.session());
  console.log("events:", h.inspect.query("select action, ok, flags from events order by id desc limit 5"));
  done = true;
} finally {
  // 正常收尾 = 先落盘再关空间；异常路径只落盘，把空间留给下一轮。
  console.log(done ? "finish:" : "flush(blocked):", done ? await h.finish() : await h.flush("blocked"));
}
