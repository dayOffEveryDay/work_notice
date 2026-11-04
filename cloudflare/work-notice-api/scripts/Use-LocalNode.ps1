# Dot-source from any PowerShell: . ./scripts/Use-LocalNode.ps1
$workerDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = Split-Path -Parent (Split-Path -Parent $workerDirectory)
$taskNodeDirectory = Join-Path $workspaceDirectory '.tools/node-v24.22.2-win-x64'
if (-not (Test-Path -LiteralPath (Join-Path $taskNodeDirectory 'node.exe'))) {
    throw 'Project-local Node 24 is not present. Install Node 24 from nodejs.org and use it instead; this helper does not modify your system installation.'
}
$env:PATH = "$taskNodeDirectory;$env:PATH"
$env:npm_config_cache = Join-Path $workspaceDirectory '.tools/npm-cache'
$env:WRANGLER_SEND_METRICS = 'false'
