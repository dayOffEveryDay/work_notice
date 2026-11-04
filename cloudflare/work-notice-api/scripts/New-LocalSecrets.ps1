[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$workerDirectory = Split-Path -Parent $PSScriptRoot
$target = Join-Path $workerDirectory '.dev.vars'
if (Test-Path -LiteralPath $target) { throw '.dev.vars already exists. Reuse its keys; this script will not silently rotate them.' }
function New-RandomKey {
    $bytes = [byte[]]::new(32)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}
$agentKey = New-RandomKey
do { $adminKey = New-RandomKey } while ($adminKey -eq $agentKey)
$stream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    try { $writer.WriteLine("AGENT_HMAC_SECRET=$agentKey"); $writer.WriteLine("ADMIN_API_KEY=$adminKey") }
    finally { $writer.Dispose() }
} finally { $stream.Dispose() }
Write-Output 'Created git-ignored .dev.vars with two independent 256-bit random keys. No key values were printed.'
