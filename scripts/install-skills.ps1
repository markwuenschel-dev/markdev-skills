# Install the five top-level skills into an agent skills directory.
# Does NOT vendor external skills.
param(
  [string]$Dest = (Join-Path $HOME ".agents\skills"),
  [switch]$WithShared,
  [switch]$Copy
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Skills = @(
  "loop-router",
  "expanded-grill-with-docs",
  "codebase-integrity-audit-loop",
  "human-directed-swarm-planner",
  "production-flywheel"
)

function Install-One {
  param([string]$Src, [string]$Dst)
  if (Test-Path $Dst) {
    Write-Host "skip (exists): $Dst"
    return
  }
  if ($Copy) {
    Copy-Item -Recurse $Src $Dst
    Write-Host "copied: $Dst"
    return
  }
  try {
    New-Item -ItemType SymbolicLink -Path $Dst -Target $Src | Out-Null
    Write-Host "linked: $Dst -> $Src"
  } catch {
    Copy-Item -Recurse $Src $Dst
    Write-Host "copied (symlink failed): $Dst"
  }
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "Repo: $RepoRoot"
Write-Host "Dest: $Dest"

foreach ($name in $Skills) {
  $src = Join-Path $RepoRoot "skills\$name"
  $skillMd = Join-Path $src "SKILL.md"
  if (-not (Test-Path $skillMd)) {
    throw "missing skill: $skillMd"
  }
  Install-One -Src $src -Dst (Join-Path $Dest $name)
}

if ($WithShared) {
  $sharedDest = Join-Path (Split-Path $Dest -Parent) "markdev-skills-shared"
  Install-One -Src (Join-Path $RepoRoot "shared") -Dst $sharedDest
  Write-Host "Note: skills reference shared/ via relative paths from the repo tree."
}

Write-Host "Done. Inventory: $(Join-Path $RepoRoot 'CAPABILITY-MAP.md')"
