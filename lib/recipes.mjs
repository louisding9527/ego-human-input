// 配方与经验：把「一次意图 = 一次调用」的编排、以及交互经验的落库收在一起。
// 每一步仍然走动作层的原子动作，配额、哨兵、预警一道不少。
import { HumanWarn } from "./errors.mjs";
import { parseUrl } from "./guard.mjs";
import { interpolate, missingParams, validateSteps, MissingParamError } from "./recipe.mjs";

export function createRecipes(ctx) {
  const { store, platformKey, baseHost, actions, browser, log, now, lastUrl } = ctx;

  async function note(entry = {}) {
    const id = store.addNote({
      platform: platformKey,
      host: baseHost,
      intent: entry.intent || "*",
      kind: entry.kind || "hint",
      area: entry.area,
      text: entry.text,
      selector: entry.selector,
    });
    return { id, platform: platformKey, intent: entry.intent || "*" };
  }

  function notes(intent) {
    return store.listNotes(platformKey, { intent });
  }

  async function execStep(step) {
    switch (step.op) {
      case "click":
        return actions.click(step.target, { as: step.as || "nav", kind: step.kind });
      case "focus":
        return actions.focus(step.target);
      case "clearField":
        return actions.clearField();
      case "type":
        return actions.type(step.text, { as: step.as || "nav" });
      case "press":
        return actions.press(step.key);
      case "waitFor": {
        const result = await actions.waitFor(step.target, { timeout: step.timeout, state: step.state });
        if (!result.ok) throw new HumanWarn({ trigger: "wait-timeout", target: step.target });
        return result;
      }
      case "read":
        return actions.read(step.seconds);
      case "expectText": {
        const text = await browser.text(step.target, 200);
        if (!String(text || "").includes(step.value)) {
          throw new HumanWarn({ trigger: "expect-text", target: step.target, want: step.value });
        }
        return { ok: true };
      }
      case "expectUrl": {
        const url = await browser.url();
        if (!url.includes(step.value)) throw new HumanWarn({ trigger: "expect-url", want: step.value, url });
        return { ok: true };
      }
      default:
        throw new HumanWarn({ trigger: "unknown-op", op: step.op });
    }
  }

  async function run(intent, params = {}) {
    const recipe = store.getRecipe(platformKey, intent);
    if (!recipe) throw new HumanWarn({ trigger: "no-recipe", intent, hints: store.listNotes(platformKey, { intent }) });
    const steps = JSON.parse(recipe.steps);
    const missing = missingParams(steps, params);
    if (missing.length) {
      throw new HumanWarn({ trigger: "missing-param", intent, params: missing, hints: store.listNotes(platformKey, { intent }) });
    }
    const started = now();
    for (let index = 0; index < steps.length; index += 1) {
      let step;
      try {
        step = interpolate(steps[index], params, { strict: true });
      } catch (error) {
        if (error instanceof MissingParamError) {
          throw new HumanWarn({ trigger: "missing-param", intent, step: index, params: [error.key] });
        }
        throw error;
      }
      try {
        await execStep(step);
      } catch (error) {
        store.bumpRecipe(recipe.id, false);
        const cause = error?.payload?.trigger || String(error?.message || error);
        const url = await browser.url();
        try {
          await note({
            intent,
            kind: "pitfall",
            area: `${intent} 第${index + 1}步`,
            text: `${step.op} 失败：${cause}；url=${parseUrl(url).path}`,
          });
        } catch {
          /* note 失败不影响主流程 */
        }
        throw new HumanWarn({ trigger: "recipe-failed", intent, step: index, op: step.op, cause, url });
      }
    }
    store.bumpRecipe(recipe.id, true);
    log("recipe", { ok: true, ms: now() - started, flags: [intent], url: lastUrl() });
    return { intent, steps: steps.length, ms: now() - started };
  }

  async function saveRecipe(intent, steps) {
    const errors = validateSteps(steps);
    if (errors.length) throw new HumanWarn({ trigger: "bad-recipe", errors });
    const saved = store.saveRecipe({ host: platformKey, intent, steps });
    return { ...saved, platform: platformKey, intent };
  }

  function recipes() {
    return store.listRecipes(platformKey);
  }

  return { note, notes, execStep, run, saveRecipe, recipes };
}
