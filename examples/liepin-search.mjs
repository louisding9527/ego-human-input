// 原子动作组合示例：猎聘找人页搜索。
// 库不提供 search()，这里演示怎么用原子动作拼，并把踩到的经验写回 site_notes。
const { human } = await import(new URL("../lib/human.mjs", import.meta.url).href);

const task = await taskSpace("liepin 搜索示例");
const page = task.page("p1");
await page.goto("https://h.liepin.com/", { timeout: 30000 });

const h = await human.create(page, { space: task });

console.log("site:", h.site());
for (const note of h.notes()) console.log(`[${note.area}] ${note.text}`);

await h.click("role:link[name='找人']", { as: "nav" });
await h.read(3);

const focused = await h.focus("css=#rc_select_1");
if (!focused.focused) throw new Error("关键词框没聚焦成功，先看 h.notes('找人页')");
await h.clearField();
await h.type("供应链总监", { as: "nav" });
await h.press("Enter");                       // 生成关键词 chip
await new Promise((r) => setTimeout(r, 600));
await h.click("role:button[name='搜 索']", { as: "search" });  // 计一次搜索配额
await h.waitFor("css=[class*=resume]", { timeout: 15000 });
await h.read();

await h.note({
  area: "找人页",
  text: "输入关键词后必须按 Enter 生成 chip，再点『搜 索』；直接点搜索会因 blur 清空输入。结果卡片是 div 不是 a。",
  selector: "css=#rc_select_1",
});

console.log("state:", h.state());
console.log("finish:", await h.finish());
