$ErrorActionPreference = 'Stop'
# Dot-source only default PLAN mode; never pass -Execute.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'Backup-ProductionD1.ps1')
$probe = Join-Path $workerDirectory ('.wrangler\backup-acl-tests\' + [Guid]::NewGuid().ToString('N'))
New-WnaPrivateDirectory -Directory $probe
$acl = Get-Acl -LiteralPath $probe
if (-not $acl.AreAccessRulesProtected) { throw 'ACL inheritance test failed.' }
if ($acl.Access.Count -ne 2) { throw 'Expected exactly owner and SYSTEM ACL rules.' }
$refused = $false
try { New-WnaPrivateDirectory -Directory $probe } catch { $refused = $true }
if (-not $refused) { throw 'Existing backup directory must be refused.' }
Write-Host 'PASS: Windows PowerShell 5.1 private ACL and no-overwrite checks; no production operations.'
