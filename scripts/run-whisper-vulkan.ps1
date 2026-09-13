param(
  [string]$WhisperRepo = "$PSScriptRoot\..\whisper.cpp",
  [string]$ModelPath = "$PSScriptRoot\..\whisper.cpp\models\ggml-large-v3-turbo.bin",
  [int]$Port = 1235
)

$ErrorActionPreference = 'Stop'

$serverCandidates = @(
  (Join-Path $WhisperRepo 'build\bin\whisper-server.exe'),
  (Join-Path $WhisperRepo 'build\bin\Release\whisper-server.exe')
)
$server = $serverCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $server) {
  throw "whisper-server.exe was not found. Build whisper.cpp with -DGGML_VULKAN=ON first."
}
if (-not (Test-Path $ModelPath)) {
  throw "Model not found: $ModelPath"
}

Write-Host "Starting whisper.cpp Vulkan server"
Write-Host "Server: $server"
Write-Host "Model:  $ModelPath"
Write-Host "Port:   $Port"

# Keep one request in flight initially. StreamRecap also enforces local
# single-flight until GPU memory and throughput have been benchmarked.
& $server `
  -m $ModelPath `
  --host 0.0.0.0 `
  --port $Port `
  --language en `
  --threads 8 `
  --processors 1
if ($LASTEXITCODE -ne 0) {
  throw "whisper-server exited with code $LASTEXITCODE"
}
