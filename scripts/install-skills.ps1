# Install every skill under skills/ that has a root SKILL.md into an agent skills directory.
# Shared contracts stay in-repo unless -WithShared. True externals stay in DEPENDENCIES.md.
param(
  [string]$Dest = (Join-Path $HOME ".agents\skills"),
  [switch]$WithShared,
  [switch]$Copy
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$SkillsDir = Join-Path $RepoRoot "skills"

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

$skills = @(Get-ChildItem -Path $SkillsDir -Directory | Where-Object {
  Test-Path (Join-Path $_.FullName "SKILL.md")
})

if ($skills.Count -eq 0) {
  throw "no skills found under $SkillsDir/*/SKILL.md"
}

foreach ($skill in $skills) {
  Install-One -Src $skill.FullName -Dst (Join-Path $Dest $skill.Name)
}

Get-ChildItem -Path $SkillsDir -Directory | Where-Object {
  -not (Test-Path (Join-Path $_.FullName "SKILL.md"))
} | ForEach-Object {
  Write-Host "skip (no SKILL.md): $($_.FullName)"
}

if ($WithShared) {
  $sharedDest = Join-Path (Split-Path $Dest -Parent) "markdev-skills-shared"
  Install-One -Src (Join-Path $RepoRoot "shared") -Dst $sharedDest
  Write-Host "Note: skills reference shared/ via relative paths from the repo tree."
}

Write-Host "Done. Inventory: $(Join-Path $RepoRoot 'CAPABILITY-MAP.md')"
