[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$workerDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = Split-Path -Parent (Split-Path -Parent $workerDirectory)
$nodeExecutable = Join-Path $workspaceDirectory '.tools\node-v24.22.2-win-x64\node.exe'
$closeoutProgram = Join-Path $PSScriptRoot 'production-closeout.mjs'
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Project-local Node is missing.' }
$review = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'production-closeout-review.json') -Raw | ConvertFrom-Json
$backupDirectory = Join-Path (Join-Path $workspaceDirectory 'artifacts\production-backups') $review.backupDirectory

Push-Location $workerDirectory
try {
    if (-not $Execute) {
        & $nodeExecutable $closeoutProgram
        if ($LASTEXITCODE -ne 0) { throw 'Local closeout plan failed; stop.' }
        return
    }
    # New reports inherit this existing private ACL; do not change the original ACL.
    $taskAcl = Get-Acl -LiteralPath $backupDirectory
    if (-not $taskAcl.AreAccessRulesProtected) { throw 'Original backup ACL is not protected; stop.' }
    $taskOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($entry in $taskAcl.Access) {
        if ($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin @($taskOwner,'S-1-5-18')) {
            throw 'Unexpected backup ACL principal; stop.'
        }
    }
    & $nodeExecutable $closeoutProgram --execute
    if ($LASTEXITCODE -ne 0) { throw 'Closeout stopped. Do not start stage two.' }
}
finally { Pop-Location }
