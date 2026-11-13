# Requires: Windows (junction 不需要管理员权限)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$skills = Join-Path $env:USERPROFILE ".agents\skills"
$dst = Join-Path $skills "ego-human-input"

New-Item -ItemType Directory -Force -Path $skills | Out-Null
if (Test-Path $dst) {
  $item = Get-Item $dst -Force
  if ($item.LinkType) { $item.Delete() } else { Remove-Item $dst -Recurse -Force }
}
New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
Write-Host "linked: $dst -> $src"
Write-Host "verify: node --test `"$src\tests\*.test.mjs`""

# 把 ego-browser 条目指到本仓库的兼容壳（不碰 ego lite 安装目录）
node "$src\tools\link-skill.mjs"
