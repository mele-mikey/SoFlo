param(
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriConfig = Get-Content (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $tauriConfig.version }
$appExe = Join-Path $projectRoot 'src-tauri\target\release\soflo.exe'
$script = Join-Path $projectRoot 'installer\SoFloInstaller.nsi'
$outputDirectory = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis-custom'
$output = Join-Path $outputDirectory "SoFlo-Setup-$Version.exe"
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'

if (-not (Test-Path -LiteralPath $appExe)) { throw "Release application not found: $appExe. Run npm run tauri build first." }
if (-not (Test-Path -LiteralPath $nsis)) { throw "NSIS compiler not found: $nsis" }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
& $nsis "/DAPP_EXE=$appExe" "/DAPP_VERSION=$Version" "/DOUTFILE=$output" $script
if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed with exit code $LASTEXITCODE." }
Write-Output "Created $output"
