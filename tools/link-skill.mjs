// 把 ~/.agents/skills/ego-browser 指向本仓库的兼容壳。
// 不碰 Program Files 里的 ego lite 安装目录，所以 ego-browser upgrade 不会冲掉它。
//   node tools/link-skill.mjs            # 建立或修复链接
//   node tools/link-skill.mjs --check    # 只检查
//   node tools/link-skill.mjs --unlink   # 删掉链接，恢复成没有 ego-browser 条目
import { lstat, readlink, rm, symlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(SKILL_DIR, "skill", "ego-browser");
const LINK = join(homedir(), ".agents", "skills", "ego-browser");
const MODE = process.platform === "win32" ? "junction" : "dir";

async function state() {
  try {
    const info = await lstat(LINK);
    if (!info.isSymbolicLink()) return { kind: "directory" };
    return { kind: "link", target: await readlink(LINK) };
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function same(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

const flags = new Set(process.argv.slice(2));

if (flags.has("--unlink")) {
  const now = await state();
  if (now.kind !== "link") {
    console.log(`没有链接可删（${now.kind}）`);
    process.exit(0);
  }
  await rm(LINK, { force: true });
  console.log(`已删除 ${LINK}`);
  process.exit(0);
}

const current = await state();
if (current.kind === "directory") {
  console.error(`${LINK} 是真实目录，不是链接。先确认里面的内容再手工处理，我不覆盖。`);
  process.exit(1);
}
if (current.kind === "link" && same(current.target, TARGET)) {
  console.log(`已就位：${LINK} -> ${TARGET}`);
  process.exit(0);
}
if (flags.has("--check")) {
  console.error(`需要修复：${LINK} 当前指向 ${current.target || "(空)"}，应为 ${TARGET}`);
  process.exit(1);
}

await mkdir(dirname(LINK), { recursive: true });
if (current.kind === "link") await rm(LINK, { force: true });
await symlink(TARGET, LINK, MODE);
console.log(`已链接：${LINK} -> ${TARGET}`);
