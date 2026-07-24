$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$config = Get-Content -Raw -Path 'config.jsonl'
cargo run -p bridge -- -c $config
