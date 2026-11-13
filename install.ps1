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
