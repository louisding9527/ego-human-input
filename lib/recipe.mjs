export const OPS = ["click", "focus", "clearField", "type", "press", "waitFor", "read", "expectText", "expectUrl"];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export class MissingParamError extends Error {
  constructor(key) {
    super(`missing recipe param: ${key}`);
    this.name = "MissingParamError";
    this.key = key;
  }
}

// strict 模式缺参数直接抛：绝不能把空串当关键词打进输入框。
export function interpolate(value, params = {}, { strict = false } = {}) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, key) => {
      if (params[key] === undefined || params[key] === null) {
        if (strict) throw new MissingParamError(key);
        return "";
      }
      return String(params[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, params, { strict }));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, params, { strict });
    return out;
  }
  return value;
}

export function missingParams(steps, params = {}) {
  const raw = JSON.stringify(steps);
  const found = new Set();
  for (const match of raw.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (params[key] === undefined || params[key] === null) found.add(key);
  }
  return [...found];
}

export function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return ["steps must be a non-empty array"];
  const errors = [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== "object") {
      errors.push(`step ${index}: not an object`);
      return;
    }
    if (!OPS.includes(step.op)) errors.push(`step ${index}: unknown op "${step.op}"`);
    if ((step.op === "click" || step.op === "focus" || step.op === "waitFor" || step.op === "expectText") && !step.target) {
      errors.push(`step ${index}: ${step.op} needs target`);
    }
    if (step.op === "type" && typeof step.text !== "string") errors.push(`step ${index}: type needs text`);
    if (step.op === "press" && !step.key) errors.push(`step ${index}: press needs key`);
  });
  return errors;
}
