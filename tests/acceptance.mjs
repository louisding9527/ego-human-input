const { human } = await import(new URL("../lib/human.mjs", import.meta.url).href);

const task = await taskSpace("acceptance check");
const page = task.page("p1");
await page.goto("https://example.com");

await page.evaluate(() => {
  window.__moves = 0;
  addEventListener("mousemove", () => { window.__moves += 1; }, true);
});

const on = await human.create(page);
console.log("A1 site:", JSON.stringify(on.site()));
console.log("A1 params.rate:", JSON.stringify(on.params().rate));

await on.move(500, 320);
const bowed = await page.evaluate(() => window.__moves);
console.log("A2 moves for one path:", bowed);

await page.evaluate(() => { window.__moves = 0; });
const off = await human.create(page, { off: ["mouse", "keyboard", "scroll", "pause", "rate"] });
await off.move(600, 240);
const flat = await page.evaluate(() => window.__moves);
console.log("A8 moves with mouse off:", flat);

const offType = await off.type("hello");
console.log("A8 type degraded:", JSON.stringify(offType));

await task.finish({ keep: [] });
