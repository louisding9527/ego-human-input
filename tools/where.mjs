// 把「本技能在哪」和「ego lite 的技能目录在哪」打印出来，供 agent 与安装脚本使用。
// 不猜平台路径：ego-browser 的真实目录从宿主注册的技能链接解析，
// 宿主没注册就报 null，并提示先确认 ego lite 装好了。
//   node tools/where.mjs
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function egoSkillDir() {
  // 1) 宿主注册的 ego-browser 技能链接（标准安装一定存在）
  // 2) 显式环境变量，给非标准安装兜底
  const candidates = [join(homedir(), ".agents", "skills", "ego-browser"), process.env.EGOLITE_SKILL_DIR].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate);
      await stat(join(real, "references", "install.md"));
      return real;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const ego = await egoSkillDir();

console.log(
  JSON.stringify(
    {
      skillDir: SKILL_DIR,
      importUrl: pathToFileURL(join(SKILL_DIR, "lib", "human.mjs")).href,
      egoSkillsDir: ego,
      egoReferences: ego ? join(ego, "references") : null,
      node: process.version,
      platform: process.platform,
    },
    null,
    2,
  ),
);

if (!ego) {
  console.error(
    "未找到 ego lite 的技能目录：先确认 `ego-browser skill` 能打印指南；" +
      "如果 ego lite 装在非标准位置，用 EGOLITE_SKILL_DIR 指向它的 ego-skills/ego-browser 目录。",
  );
}
