export const OPS = ["click", "focus", "clearField", "type", "press", "waitFor", "read", "expectText", "expectUrl"];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function interpolate(value, params = {}) {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, key) => (params[key] === undefined ? "" : String(params[key])));
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, params));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, params);
    return out;
  }
  return value;
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
