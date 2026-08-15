$ErrorActionPreference = 'Stop'

$target = Join-Path $PSScriptRoot '..\src-tauri\resources\whisper'
$cli = Join-Path $target 'whisper-cli.exe'
if (Test-Path -LiteralPath $cli) {
  Write-Host 'whisper.cpp runtime already present.'
  exit 0
}

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) 'soflo-whisper-bin-x64.zip'
New-Item -ItemType Directory -Force -Path $target | Out-Null
try {
  Invoke-WebRequest -Uri 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' -OutFile $temporary
  Expand-Archive -LiteralPath $temporary -DestinationPath $target -Force
  $nested = Get-ChildItem -LiteralPath $target -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
  if (-not $nested) { throw 'The whisper.cpp download did not include whisper-cli.exe.' }
  if ($nested.DirectoryName -ne $target) {
    Get-ChildItem -LiteralPath $nested.DirectoryName -File | Copy-Item -Destination $target -Force
  }
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
