param(
    [ValidateSet('Pair','Revoke')][string]$Action='Pair',
    [string]$DeviceId='home-windows',
    [string]$Endpoint='https://work-notice-api.hui760419.workers.dev'
)
$ErrorActionPreference='Stop'
$origin=[uri]$Endpoint
if($origin.Scheme -ne 'https' -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo){throw 'HTTPS origin required'}
if($DeviceId -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$'){throw 'Invalid device ID'}
$secure=Read-Host 'ADMIN_API_KEY（僅送往指定 HTTPS Worker；不會寫入檔案）' -AsSecureString
$credential=[System.Net.NetworkCredential]::new('', $secure)
try {
    $path=if($Action -eq 'Pair'){'/api/admin/pairing/start'}else{'/api/admin/mobile/revoke'}
    $result=Invoke-RestMethod -Uri ($origin.GetLeftPart([UriPartial]::Authority)+$path) -Method Post -ContentType 'application/json' -Headers @{Authorization=('Bearer '+$credential.Password)} -Body (@{deviceId=$DeviceId}|ConvertTo-Json -Compress)
    if($Action -eq 'Pair'){
        Write-Host ('一次性配對碼（請直接輸入手機，不要貼聊天或保留終端錄影）：'+$result.pairingCode)
        Write-Host ('到期 UTC：'+$result.expiresAt)
    }else{Write-Host '已撤銷手機；現有碼無法取回舊 bearer，請重新建立配對碼。'}
} finally { $credential=$null; $secure.Dispose() }
