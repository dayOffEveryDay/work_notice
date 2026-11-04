$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'WorkNoticeLiveDiagnostics.psm1') -Force
$script:checks=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAIL: '+$Name)};$script:checks++}
foreach($file in @('WorkNoticeLiveDiagnostics.psm1','Watch-WorkNoticeAudio.ps1','Test-WorkNoticeLiveDiagnostics.ps1')){
    $tokens=$null;$issues=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$issues)
    Check ($issues.Count -eq 0) ('Syntax '+$file)
}
$log=@(
'1793672600.010 123 123 I WNotice: stage=FCM_RECEIVED event=0b20a65837a9 originalPriority=1 actualPriority=1 foreground=false locked=true',
'1793672600.040 123 123 I WNotice: stage=FGS_PROMOTED event=0b20a65837a9 reason=NONE',
'1793672600.041 123 123 I WNotice: stage=AUDIO_FOCUS_SNAPSHOT event=0b20a65837a9 phase=AFTER_REQUEST systemForeground=1 appOpRaw=4 result=0 usage=4',
'1793672600.041 123 123 I WNotice: stage=AUDIO_FOCUS event=0b20a65837a9 value=0',
'1793672600.042 111 111 I AS.HardeningEnforcer: Focus request DENIED for uid:10193 req:2 procState:4',
'1793672600.045 123 123 I WNotice: stage=SERVICE_DESTROYED event=0b20a65837a9 reason=NONE',
'1793672601.010 123 123 I WNotice: stage=FCM_RECEIVED event=abcdef123456 originalPriority=1 actualPriority=1',
'1793672601.011 123 123 I WNotice: stage=AUDIO_FOCUS event=abcdef123456 value=1',
'1793672601.012 123 123 I WNotice: stage=PLAYER_STARTED event=abcdef123456 reason=NONE')
$ev=Get-WorkNoticeLogEvent $log[0]
Check ($ev.eventId -eq '0b20a65837a9' -and $ev.stage -eq 'FCM_RECEIVED') 'Automatic event association'
Check ($null -eq (Get-WorkNoticeLogEvent 'OtherTag: stage=FCM_RECEIVED event=0b20a65837a9')) 'Other tags excluded'
$services=@(Select-WorkNoticeSystemFields 'services' @('isForeground=true types=0x00000002 foregroundNoti=PRIVATE','getFgsAllowWiu_forCapabilities=DENIED','mAllowWiu_noBinding=DENIED','intent={SECRET}') '10193')
Check (($services -join ' ') -notmatch 'PRIVATE|SECRET') 'No Intent/notification objects'
Check ($services -contains 'getFgsAllowWiu_forCapabilities=DENIED') 'New WIU fields retained'
$process=@(Select-WorkNoticeSystemFields 'process' @('*APP* 123:com.worknotice.alarm/u0a193',' curCapability=------- setCapability=-------','*APP* 567:other.app/u0a111',' curCapability=LCMNFUA') '10193')
Check ($process.Count -eq 1 -and $process[0] -notmatch 'LCMNFUA') 'Process fields isolated'
$ops=@(Select-WorkNoticeSystemFields 'appops' @('11-03 02:24:33.041 EVAL_FOREGROUND_MODE uid=10193 uidState=fgs capability=---NFU- code=TAKE_AUDIO_FOCUS result=ignore','EVAL_FOREGROUND_MODE uid=101930 code=TAKE_AUDIO_FOCUS result=allow','EVAL_FOREGROUND_MODE uid=10193 code=CAMERA result=allow') '10193')
Check ($ops.Count -eq 1) 'Only own UID and focus op history'
$sample=[pscustomobject]@{kind='appops';trigger='0b20a65837a9:FCM_RECEIVED';fields=$ops;status='OK';durationMs=250;startedAtUtc='2026-11-02T18:24:33Z';finishedAtUtc='2026-11-02T18:24:33.250Z'}
$report=New-WorkNoticeLiveReport $log @($sample) '10193' 'FIXTURE' @() $true
Check ($report.events.Count -eq 2) 'Concurrent events separated'
Check ($report.events[0].focusRequests[0].result -eq 0 -and -not $report.events[0].playerStartedObserved) 'Denied never inferred playing'
Check ($report.events[1].focusRequests[0].result -eq 1 -and $report.events[1].playerStartedObserved) 'Granted playback isolated'
Check ($report.events[0].requestTimeForegroundAudioControl -eq 'UNKNOWN') 'History candidates not automatically request-time proof'
Check ($report.hardeningLogCandidates.Count -eq 1) 'Hardening UID record retained'
$empty=New-WorkNoticeLiveReport @() @() 'UNKNOWN' 'WAIT_TIMEOUT' @('LOGCAT_ERROR') $true
Check ($empty.events.Count -eq 0 -and $empty.missingReasons.Count -ge 3) 'Empty/OEM missing has reasons'
$late=[pscustomobject]@{kind='process';fields=@('curCapability=-------');status='OK'}
$r=New-WorkNoticeLiveReport $log @($late) '10193' 'FIXTURE' @() $true
Check ($r.events[0].requestTimeForegroundAudioControl -eq 'UNKNOWN') 'Post-destruction zero capability stays UNKNOWN'
$r=New-WorkNoticeLiveReport $log @() '10193' 'FIXTURE' @() $true 1793672601
Check ($r.events.Count -eq 1) 'Old backlog excluded by device time'
# Full entry-point replay: no SDK/ADB lookup and no device commands.
$folder=Join-Path (Split-Path $PSScriptRoot) ('artifacts/phase3/diagnostic-fixtures/'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Force -Path $folder
$logPath=Join-Path $folder 'synthetic.txt';$log | Set-Content -LiteralPath $logPath -Encoding UTF8
$samplePath=Join-Path $folder 'samples.json'
@{uid='10193';samples=@($sample)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $samplePath -Encoding UTF8
$null=& (Join-Path $PSScriptRoot 'Watch-WorkNoticeAudio.ps1') -ReplayLog $logPath -ReplaySamples $samplePath -OutputDirectory $folder
$reportFile=Get-ChildItem -LiteralPath $folder -Recurse -Filter report.json | Select-Object -First 1
$saved=Get-Content -LiteralPath $reportFile.FullName -Raw | ConvertFrom-Json
Check ($saved.synthetic -and $saved.events.Count -eq 2) 'End-to-end replay JSON'
$raw=Get-Content -LiteralPath (Join-Path $reportFile.DirectoryName 'logcat-raw.txt')
Check (($raw -join "`n") -eq ($log -join "`n")) 'Raw lines preserved exactly'
Check ($saved.triggeredObservations.Count -eq 5) 'Automatic FCM/FGS/focus triggers deduplicated'
Check (Test-Path -LiteralPath (Join-Path $reportFile.DirectoryName 'summary.txt')) 'Summary generated'
Write-Output "$script:checks checks passed (offline synthetic data; no device or cloud operations)."
