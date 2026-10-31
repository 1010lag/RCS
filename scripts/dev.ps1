$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $portableRoot = Join-Path $env:USERPROFILE '.codex\.tmp'
    $portableNode = Get-ChildItem -LiteralPath $portableRoot -Directory -Filter 'node-*-win-x64' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $portableNode) { throw 'Install Node.js 24 LTS or newer, then run this script again.' }
    $env:Path = $portableNode.FullName + ';' + $env:Path
}
if (-not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
& npm.cmd run dev
exit $LASTEXITCODE
