param(
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverConfig = Get-Content (Join-Path $projectRoot 'server\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $serverConfig.version }
$appExe = Join-Path $projectRoot 'server\src-tauri\target\release\soflo-server.exe'
$llamaExe = (Get-Command llama-server -ErrorAction Stop).Source
$llamaDirectory = Split-Path -Parent $llamaExe
$script = Join-Path $projectRoot 'installer\SoFloServerInstaller.nsi'
$outputDirectory = Join-Path $projectRoot 'server\src-tauri\target\release\bundle\nsis-custom'
$output = Join-Path $outputDirectory "SoFlo-Server-Setup-$Version.exe"
$bundledNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$systemNsis = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
$nsis = if (Test-Path -LiteralPath $bundledNsis) { $bundledNsis } elseif (Test-Path -LiteralPath $systemNsis) { $systemNsis } else { (Get-Command makensis -ErrorAction SilentlyContinue).Source }

if (-not (Test-Path -LiteralPath $appExe)) { throw "Release server application not found: $appExe. Build the server first." }
if (-not (Test-Path -LiteralPath (Join-Path $llamaDirectory 'llama-server.exe'))) { throw "llama.cpp runtime not found: $llamaDirectory" }
if (-not $nsis -or -not (Test-Path -LiteralPath $nsis)) { throw "NSIS compiler not found. Install NSIS or run a bundled Tauri build first." }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
& $nsis "/DAPP_EXE=$appExe" "/DLLAMA_DIR=$llamaDirectory" "/DAPP_VERSION=$Version" "/DOUTFILE=$output" $script
if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed with exit code $LASTEXITCODE." }
Write-Output "Created $output"
