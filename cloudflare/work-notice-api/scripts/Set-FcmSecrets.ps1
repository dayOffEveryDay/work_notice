param([Parameter(Mandatory=$true)][string]$ServiceAccountPath, [switch]$InitializeTokenKey)
$ErrorActionPreference='Stop'
# Explicitly manual: uploads service account and optionally initializes the token key.
# It neither generates a Google key nor touches existing Windows/admin secrets.
. "$PSScriptRoot/Use-LocalNode.ps1"
$workerRoot=Split-Path $PSScriptRoot
$account=Get-Content -LiteralPath $ServiceAccountPath -Raw | ConvertFrom-Json
if($account.project_id -ne 'work-notice-7a5e8' -or $account.type -ne 'service_account' -or -not $account.private_key){throw 'Unexpected Firebase service account'}
$json=$account | ConvertTo-Json -Depth 10 -Compress
$bytes=New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
}
finally {
    $rng.Dispose()
}
$tokenKey=[BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
Push-Location $workerRoot
try {
    if($InitializeTokenKey){
        $existing=node node_modules/wrangler/bin/wrangler.js secret list | ConvertFrom-Json
        if($LASTEXITCODE -ne 0){throw 'Unable to check existing secret names'}
        if($existing.name -contains 'FCM_TOKEN_ENCRYPTION_KEY'){throw 'Token key already exists. Refusing rotation; omit -InitializeTokenKey to update only service account.'}
    }
    $json | node node_modules/wrangler/bin/wrangler.js secret put FCM_SERVICE_ACCOUNT_JSON
    if($LASTEXITCODE -ne 0){throw 'Service account secret upload failed'}
    if($InitializeTokenKey){
        $tokenKey | node node_modules/wrangler/bin/wrangler.js secret put FCM_TOKEN_ENCRYPTION_KEY
        if($LASTEXITCODE -ne 0){throw 'Token encryption secret upload failed'}
    }
    Write-Host 'FCM Secret 設定完成；沒有更動 AGENT_HMAC_SECRET 或 ADMIN_API_KEY。'
} finally { Pop-Location; $json=$null; $account=$null; $tokenKey=$null; [Array]::Clear($bytes,0,$bytes.Length) }
