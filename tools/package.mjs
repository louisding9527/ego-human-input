// 打包：按 HEAD 里已提交的内容生成发布包（zip + tar.gz），带版本号与校验和。
// 只打技能本体，不打 .trellis / .agents / .dsh / .codegraph 这些仓库脚手架。
//   node tools/package.mjs            # 版本从 SKILL.md 的 metadata.version 读
//   node tools/package.mjs --version 0.9.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = [
  "SKILL.md",
  "README.md",
  "LICENSE",
  "install.ps1",
  "install.sh",
  "validation.md",
  "lib",
  "profiles",
  "references",
  "tools",
  "examples",
  "tests",
  "docs",
];

async function version() {
  const flag = process.argv.indexOf("--version");
  if (flag > 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  const text = await readFile(join(ROOT, "SKILL.md"), "utf8");
  const match = text.match(/^\s*version:\s*"([^"]+)"/m);
  if (!match) throw new Error("SKILL.md 里没有 metadata.version");
  return match[1];
}

const ver = await version();
const name = `ego-human-input-${ver}`;
const outDir = join(ROOT, "dist");
await mkdir(outDir, { recursive: true });

const git = (args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

// 先确认工作区干净：发布包必须对应一个已提交的状态，否则打出来的是混装。
const dirty = git(["status", "--porcelain"]).toString().trim();
if (dirty) {
  console.error("工作区不干净，先提交再打包：\n" + dirty);
  process.exit(1);
}

const artifacts = [
  { file: `${name}.zip`, format: "zip" },
  { file: `${name}.tar.gz`, format: "tar.gz" },
];

for (const { file, format } of artifacts) {
  git(["archive", `--format=${format}`, `--prefix=${name}/`, "-o", join(outDir, file), "HEAD", "--", ...INCLUDE]);
  const bytes = (await stat(join(outDir, file))).size;
  const hash = createHash("sha256").update(await readFile(join(outDir, file))).digest("hex");
  console.log(`${file}  ${bytes} bytes  sha256=${hash.slice(0, 16)}…`);
}

console.log(`\noutput: ${outDir}`);
