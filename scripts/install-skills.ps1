# Install every skill under skills/ that has a root SKILL.md into an agent skills directory.
# Shared contracts are installed only with -WithShared. True externals stay in DEPENDENCIES.md.
param(
  [string]$Dest = (Join-Path $HOME ".agents\skills"),
  [switch]$WithShared,
  [switch]$Copy
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$SkillsDir = Join-Path $RepoRoot "skills"
$script:Linked = $false

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
    $script:Linked = $true
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
  $_.Name -ne "shared" -and (Test-Path (Join-Path $_.FullName "SKILL.md"))
})

if ($skills.Count -eq 0) {
  throw "no skills found under $SkillsDir/*/SKILL.md"
}

foreach ($skill in $skills) {
  Install-One -Src $skill.FullName -Dst (Join-Path $Dest $skill.Name)
}

Get-ChildItem -Path $SkillsDir -Directory | Where-Object {
  $_.Name -ne "shared" -and -not (Test-Path (Join-Path $_.FullName "SKILL.md"))
} | ForEach-Object {
  Write-Host "skip (no SKILL.md): $($_.FullName)"
}

if ($WithShared) {
  # Bundled scripts resolve shared/ as <skills-dir>/shared (require("../shared/...")).
  $skillsLinked = $script:Linked
  Install-One -Src (Join-Path $RepoRoot "shared") -Dst (Join-Path $Dest "shared")
  if ($skillsLinked) {
    # Node resolves a symlinked skill from its real path, so the repo needs skills/shared too (gitignored).
    $repoLink = Join-Path $SkillsDir "shared"
    if (Test-Path $repoLink) {
      Write-Host "skip (exists): $repoLink"
    } else {
      $linkType = if ($IsWindows -or $env:OS -eq "Windows_NT") { "Junction" } else { "SymbolicLink" }
      New-Item -ItemType $linkType -Path $repoLink -Target (Join-Path $RepoRoot "shared") | Out-Null
      Write-Host "linked: $repoLink -> $(Join-Path $RepoRoot 'shared') (lets symlinked skills resolve shared/)"
    }
  }
}

Write-Host "Done. Inventory: $(Join-Path $RepoRoot 'CAPABILITY-MAP.md')"
