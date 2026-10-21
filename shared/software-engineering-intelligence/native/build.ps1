[CmdletBinding()]
param(
  [string]$NodeVersion = (& node -p "process.versions.node"),
  [string]$Architecture = (& node -p "process.arch")
)

$ErrorActionPreference = "Stop"
if ($NodeVersion -ne "25.2.0") { throw "The deterministic package artifact is locked to Node 25.2.0 headers; found $NodeVersion." }
if ($Architecture -ne "x64") { throw "Only the packageable Windows x64 artifact is supported by this build script." }

$NativeRoot = $PSScriptRoot
$OutputRoot = Join-Path $NativeRoot "bin\win32-x64"
$HelperOutputPath = Join-Path $OutputRoot "predictive_native_fs.node"
$BootstrapOutputPath = Join-Path $OutputRoot "predictive_native_bootstrap.node"
$BuildRoot = Join-Path $NativeRoot ".build"
$NodeRoot = Join-Path $env:LOCALAPPDATA "node-gyp\Cache\$NodeVersion"
$NodeInclude = Join-Path $NodeRoot "include\node"
$NodeLibrary = Join-Path $NodeRoot "x64\node.lib"
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"

if (-not (Test-Path -LiteralPath (Join-Path $NodeInclude "node_api.h"))) { throw "Node-API headers are missing at $NodeInclude" }
if (-not (Test-Path -LiteralPath $NodeLibrary)) { throw "Node import library is missing at $NodeLibrary" }
if (-not (Test-Path -LiteralPath $VsWhere)) { throw "vswhere.exe is unavailable" }

$VisualStudio = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $VisualStudio) { throw "MSVC x64 Build Tools are unavailable" }
$VcVars = Join-Path $VisualStudio "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $VcVars)) { throw "vcvars64.bat is unavailable at $VcVars" }

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$Source = Join-Path $NativeRoot "predictive_native_fs.cc"
$CanonicalSource = [IO.File]::ReadAllText($Source).Replace("`r`n", "`n").Replace("`r", "`n")
$SourceDigest = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($CanonicalSource))
).ToLowerInvariant()
$ResolvedNativeRoot = [IO.Path]::GetFullPath($NativeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$ResolvedBuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (-not $ResolvedBuildRoot.StartsWith($ResolvedNativeRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a build root outside the native helper directory: $ResolvedBuildRoot"
}
if (Test-Path -LiteralPath $BuildRoot) { Remove-Item -LiteralPath $BuildRoot -Recurse -Force }

function Invoke-NativeBuild([string]$BuildDirectory) {
  New-Item -ItemType Directory -Force -Path $BuildDirectory | Out-Null
  $RelativeBuildDirectory = [IO.Path]::GetRelativePath($NativeRoot, $BuildDirectory)
  $HelperObject = Join-Path $RelativeBuildDirectory "predictive_native_fs.obj"
  $HelperImportLibrary = Join-Path $RelativeBuildDirectory "predictive_native_fs.lib"
  $HelperCandidateRelative = Join-Path $RelativeBuildDirectory "predictive_native_fs.node"
  $BootstrapObject = Join-Path $RelativeBuildDirectory "predictive_native_bootstrap.obj"
  $BootstrapImportLibrary = Join-Path $RelativeBuildDirectory "predictive_native_bootstrap.lib"
  $BootstrapCandidateRelative = Join-Path $RelativeBuildDirectory "predictive_native_bootstrap.node"
  $HelperCommand = 'call "{0}" >nul && cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /WX /experimental:deterministic /DNAPI_VERSION=8 /DPREDICTIVE_SOURCE_SHA256_HEX={1} /pathmap:"{2}"=C:\sei-native /I"{3}" /Fo"{4}" /LD "predictive_native_fs.cc" /link /NOLOGO /INCREMENTAL:NO /OPT:REF /OPT:ICF /Brepro "{5}" /IMPLIB:"{6}" /OUT:"{7}"' -f $VcVars, $SourceDigest, $NativeRoot, $NodeInclude, $HelperObject, $NodeLibrary, $HelperImportLibrary, $HelperCandidateRelative
  $BootstrapCommand = 'call "{0}" >nul && cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /WX /experimental:deterministic /DNAPI_VERSION=8 /pathmap:"{1}"=C:\sei-native /I"{2}" /Fo"{3}" /LD "predictive_native_bootstrap.cc" /link /NOLOGO /INCREMENTAL:NO /OPT:REF /OPT:ICF /Brepro "{4}" /IMPLIB:"{5}" /OUT:"{6}"' -f $VcVars, $NativeRoot, $NodeInclude, $BootstrapObject, $NodeLibrary, $BootstrapImportLibrary, $BootstrapCandidateRelative
  Push-Location -LiteralPath $NativeRoot
  try {
    $HelperCompileOutput = & "$env:ComSpec" /d /s /c $HelperCommand
    $HelperCompileExitCode = $LASTEXITCODE
    if ($HelperCompileExitCode -eq 0) {
      $BootstrapCompileOutput = & "$env:ComSpec" /d /s /c $BootstrapCommand
      $BootstrapCompileExitCode = $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
  if ($HelperCompileExitCode -ne 0) {
    throw "Native helper compilation failed with exit code $HelperCompileExitCode`n$($HelperCompileOutput -join [Environment]::NewLine)"
  }
  if ($BootstrapCompileExitCode -ne 0) {
    throw "Native bootstrap compilation failed with exit code $BootstrapCompileExitCode`n$($BootstrapCompileOutput -join [Environment]::NewLine)"
  }
  $HelperCompileOutput | ForEach-Object { Write-Verbose $_ }
  $BootstrapCompileOutput | ForEach-Object { Write-Verbose $_ }
  return [pscustomobject]@{
    Helper = Join-Path $BuildDirectory "predictive_native_fs.node"
    Bootstrap = Join-Path $BuildDirectory "predictive_native_bootstrap.node"
  }
}

try {
  $First = Invoke-NativeBuild (Join-Path $BuildRoot "first")
  $Second = Invoke-NativeBuild (Join-Path $BuildRoot "second")
  $FirstHelperDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $First.Helper).Hash.ToLowerInvariant()
  $SecondHelperDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Second.Helper).Hash.ToLowerInvariant()
  $FirstBootstrapDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $First.Bootstrap).Hash.ToLowerInvariant()
  $SecondBootstrapDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Second.Bootstrap).Hash.ToLowerInvariant()
  if ($FirstHelperDigest -ne $SecondHelperDigest) {
    throw "Deterministic helper build check failed: $FirstHelperDigest != $SecondHelperDigest"
  }
  if ($FirstBootstrapDigest -ne $SecondBootstrapDigest) {
    throw "Deterministic bootstrap build check failed: $FirstBootstrapDigest != $SecondBootstrapDigest"
  }
  Copy-Item -LiteralPath $First.Helper -Destination $HelperOutputPath -Force
  Copy-Item -LiteralPath $First.Bootstrap -Destination $BootstrapOutputPath -Force
  Write-Output "helper=$HelperOutputPath"
  Write-Output "helper_sha256=$FirstHelperDigest"
  Write-Output "bootstrap=$BootstrapOutputPath"
  Write-Output "bootstrap_sha256=$FirstBootstrapDigest"
  Write-Output "source_sha256=$SourceDigest"
  Write-Output "deterministic_builds=2"
} finally {
  if (Test-Path -LiteralPath $BuildRoot) { Remove-Item -LiteralPath $BuildRoot -Recurse -Force }
}
