$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:HELM_BRIDGE_PATH = Join-Path $PSScriptRoot 'target\debug\bridge.exe'
$config = Get-Content -Raw -Path 'config.jsonl'
cargo run -p helm -- --adopt 0ef04796-d536-44be-b9d9-6c6780151c35 -c $config
