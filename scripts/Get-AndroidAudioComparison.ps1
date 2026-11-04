# One-shot snapshots may miss short FGS lifetimes. For automatic event capture use
# Watch-WorkNoticeAudio.ps1; see docs/PHASE3-ANDROID-LIVE-CAPTURE.md.
param(
    [Parameter(Mandatory=$true)][string]$Serial,
    [Parameter(Mandatory=$true)][ValidateSet('A','B','C','D','E','F','Foreground','Background','Locked','UserRecovery')][string]$Case,
    [ValidateSet('Before','After','Recovery')][string]$Sample='After',
    [ValidateRange(1,100)][int]$Trial=1,
    [ValidatePattern('^[a-f0-9]{8,12}$')][string]$EventPrefix,
    [string]$OutputDirectory=(Join-Path (Split-Path $PSScriptRoot) 'artifacts/phase3/audio-comparison')
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'AndroidAlarmDiagnostics.psm1') -Force
$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
if(-not(Test-Path -LiteralPath $adb)){throw 'Android SDK adb.exe not found'}
function Read-Adb([string[]]$Arguments){
    $result=& $adb -s $Serial @Arguments
    if($LASTEXITCODE -ne 0){throw 'Read-only ADB diagnostic failed'}
    return $result
}
$package='com.worknotice.alarm'
$uidText=Read-Adb @('shell','cmd','package','list','packages','-U',$package)
$match=[regex]::Match(($uidText -join ' '),'package:com\.worknotice\.alarm\s+uid:(\d+)')
if(-not $match.Success){throw 'Work Notice package UID not found'}
$ownUid=$match.Groups[1].Value
$uidPattern='\buid=\s*'+[regex]::Escape($ownUid)+'\b'
$packageInfo=Read-Adb @('shell','dumpsys','package',$package)
$version=@($packageInfo | Select-String 'versionCode=|versionName=' | ForEach-Object {$_.Line.Trim()})
$rawProcesses=Read-Adb @('shell','dumpsys','activity','processes')
$processFields=[System.Collections.Generic.List[string]]::new()
$inTarget=$false
foreach($line in $rawProcesses){
    if($line -match '^\s*\*(?:APP|PERS)\*'){$inTarget=$line -match 'com\.worknotice\.alarm(?:[:/}\s]|$)'}
    if($inTarget -and $line -match '^\s*(?:curProcState=|curCapability=|setCapability=)'){$processFields.Add($line.Trim())}
}
# Keep raw dumps only in memory; never write/share unrelated apps' data or Intents.
$rawOps=Read-Adb @('shell','dumpsys','appops')
$uidEvents=@($rawOps | Where-Object {
    $_ -match $uidPattern -and ($_ -match 'UPDATE_UID_PROC_STATE|COMMIT_UID_STATE' -or ($_ -match 'EVAL_FOREGROUND_MODE' -and $_ -match 'TAKE_AUDIO_FOCUS'))
} | Select-Object -Last 50 | ForEach-Object {$_.Trim()})
$opText=Read-Adb @('shell','cmd','appops','get',$package,'TAKE_AUDIO_FOCUS')
$opMode=[regex]::Match(($opText -join ' '),'TAKE_AUDIO_FOCUS:\s*([A-Za-z_]+)').Groups[1].Value
$rawServices=Read-Adb @('shell','dumpsys','activity','services',$package)
$serviceFields=[System.Collections.Generic.List[string]]::new()
foreach($line in $rawServices){
    foreach($item in [regex]::Matches($line,'\b(isForeground|foregroundServiceType|mAllowWhileInUsePermissionInFgs|allowWhileInUsePermissionInFgs|mAllowStartForeground)=([A-Za-z0-9_-]+)')){$serviceFields.Add($item.Value)}
}
$logs=Read-Adb @('logcat','-d','-t','2000','-v','threadtime','-s','WNotice:I','*:S')
$safeLogs=@($logs | Where-Object {$_ -match '\bWNotice\b'} | Select-Object -Last 100)
$audioDump=Read-Adb @('shell','dumpsys','audio')
$audioState=ConvertFrom-AlarmAudioDump -Lines $audioDump
$zenText=(Read-Adb @('shell','settings','get','global','zen_mode')) -join ''
$zenMode=$null
if($zenText.Trim() -match '^[0-3]$'){$zenMode=[int]$zenText.Trim()}
$eventState=$null
if($EventPrefix){$eventState=ConvertFrom-AlarmEventLogs -Lines $safeLogs -EventPrefix $EventPrefix}
$timestamp=[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8))
$report=[ordered]@{
    case=$Case;sample=$Sample;trial=$Trial;capturedAtTaipei=$timestamp.ToString('o');uid=$ownUid
    androidApi=((Read-Adb @('shell','getprop','ro.build.version.sdk')) -join '').Trim()
    buildId=((Read-Adb @('shell','getprop','ro.build.id')) -join '').Trim()
    securityPatch=((Read-Adb @('shell','getprop','ro.build.version.security_patch')) -join '').Trim()
    appVersion=$version;audioFocusRawMode=$opMode;processFields=@($processFields.ToArray())
    serviceFields=@($serviceFields.ToArray());appOpsUidEvents=$uidEvents;workNoticeLogs=$safeLogs
    audioState=$audioState;zenMode=$zenMode;eventState=$eventState
    note='Snapshot may be after the service exited. Empty/OEM-missing capability fields mean UNKNOWN, never zero. Use matching EVAL_FOREGROUND_MODE time for request-time capability.'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$path=Join-Path $OutputDirectory ($timestamp.ToString('yyyyMMdd-HHmmss-fff')+'-'+$Case+'-'+$Trial+'-'+$Sample+'.json')
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding utf8
Write-Output ('Read-only filtered report: '+[IO.Path]::GetFullPath($path))
