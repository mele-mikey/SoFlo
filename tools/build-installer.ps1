param(
  [string]$Version = "",
  [string]$LlamaDirectory = "",
  [switch]$SkipTauriBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriConfig = Get-Content (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $tauriConfig.version }

# A plain `cargo build` compiles Rust but can retain Tauri's Vite development
# URL. Always produce the executable through the Tauri CLI before NSIS packages
# it, so the branded setup window uses embedded production assets instead of
# trying to open localhost.
if (-not $SkipTauriBuild) {
  Push-Location $projectRoot
  try {
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri production build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}
$appExe = Join-Path $projectRoot 'src-tauri\target\release\soflo.exe'
if (-not $LlamaDirectory) {
  $llamaExe = (Get-Command llama-server -ErrorAction Stop).Source
  $LlamaDirectory = Split-Path -Parent $llamaExe
}
$script = Join-Path $projectRoot 'installer\SoFloInstaller.nsi'
$outputDirectory = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis-custom'
$output = Join-Path $outputDirectory "SoFlo-Setup-$Version.exe"
$bundledNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$systemNsis = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
$nsis = if (Test-Path -LiteralPath $bundledNsis) { $bundledNsis } elseif (Test-Path -LiteralPath $systemNsis) { $systemNsis } else { (Get-Command makensis -ErrorAction SilentlyContinue).Source }

if (-not (Test-Path -LiteralPath $appExe)) { throw "Release application not found: $appExe. The Tauri production build did not create it." }
if (-not (Test-Path -LiteralPath (Join-Path $LlamaDirectory 'llama-server.exe'))) { throw "llama.cpp runtime not found: $LlamaDirectory" }
if (-not $nsis -or -not (Test-Path -LiteralPath $nsis)) { throw "NSIS compiler not found. Install NSIS or run a bundled Tauri build first." }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
& $nsis "/DAPP_EXE=$appExe" "/DLLAMA_DIR=$LlamaDirectory" "/DAPP_VERSION=$Version" "/DOUTFILE=$output" $script
if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed with exit code $LASTEXITCODE." }
Write-Output "Created $output"
