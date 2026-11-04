[CmdletBinding()]
param([switch]$Execute, [string]$DiagnoseExisting)

$ErrorActionPreference = 'Stop'
$workerDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = Split-Path -Parent (Split-Path -Parent $workerDirectory)
$nodeExecutable = Join-Path $workspaceDirectory '.tools\node-v24.22.2-win-x64\node.exe'
$backupProgram = Join-Path $PSScriptRoot 'production-backup.mjs'
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Project-local Node is missing.' }

function New-WnaPrivateDirectory {
    param([Parameter(Mandatory=$true)][string]$Directory)
    if (Test-Path -LiteralPath $Directory) { throw 'Refusing to reuse an existing backup directory.' }
    New-Item -ItemType Directory -Path $Directory | Out-Null
    # Restrict BEFORE creating SQL, logs, or the restored local DB.
    $taskAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskAcl.SetOwner($taskOwner)
    foreach ($taskSid in @($taskOwner, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $taskRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $taskAcl.AddAccessRule($taskRule)
    }
    Set-Acl -LiteralPath $Directory -AclObject $taskAcl
    $actualAcl = Get-Acl -LiteralPath $Directory
    if (-not $actualAcl.AreAccessRulesProtected) { throw 'Private backup ACL not protected. Stop.' }
    $allowedSids = @($taskOwner.Value, 'S-1-5-18')
    foreach ($entry in $actualAcl.Access) {
        if ($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowedSids) {
            throw 'Unexpected principal in private backup ACL. Stop.'
        }
    }
}

Push-Location $workerDirectory
try {
    if ($Execute -and $DiagnoseExisting) { throw 'Execute and DiagnoseExisting are mutually exclusive.' }
    if ($DiagnoseExisting) {
        & $nodeExecutable $backupProgram --diagnose-existing $DiagnoseExisting
        if ($LASTEXITCODE -ne 0) { throw 'Offline diagnosis failed or evidence incomplete. No production operation was performed.' }
        return
    }
    # Default is a local plan. It does not invoke Wrangler or contact Cloudflare.
    & $nodeExecutable $backupProgram
    if ($LASTEXITCODE -ne 0) { throw 'Local plan checks failed. Stop.' }
    if (-not $Execute) { return }

    $backupRoot = Join-Path $workspaceDirectory 'artifacts\production-backups'
    $backupDirectory = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-WnaPrivateDirectory -Directory $backupDirectory

    & $nodeExecutable $backupProgram --execute $backupDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Stage one stopped. Do not proceed to migration or deployment.' }
}
finally { Pop-Location }
