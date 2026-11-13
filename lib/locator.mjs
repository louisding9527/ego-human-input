// 定位符解析：把业务脚本写的 locator 变成页面函数能吃的参数。
// 纯函数，不碰页面。

export function parseLocator(locator) {
  const raw = String(locator ?? "").replace(/^loc=/, "");
  if (raw.startsWith("css=")) return { kind: "css", value: raw.slice(4) };
  if (raw.startsWith("href=")) return { kind: "href", value: raw.slice(5) };
  const role = raw.match(/^role:([a-z]+)(?:\[name=(['"])(.*?)\2\])?$/);
  if (role) return { kind: "role", value: { role: role[1], name: role[3] || "" } };
  return { kind: "css", value: raw };
}

export function toEvalArg(spec) {
  if (spec.kind === "css") return { selector: spec.value };
  if (spec.kind === "href") return { selector: `a[href="${String(spec.value).replace(/"/g, '\\"')}"]` };
  return { role: spec.value };
}

// css / href 能直接交给 waitForSelector；role 只能自己轮询。
export function selectorOf(locator) {
  const spec = parseLocator(locator);
  if (spec.kind === "css") return spec.value;
  if (spec.kind === "href") return `a[href="${String(spec.value).replace(/"/g, '\\"')}"]`;
  return null;
}
