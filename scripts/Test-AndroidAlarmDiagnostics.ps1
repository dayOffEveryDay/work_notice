$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'AndroidAlarmDiagnostics.psm1') -Force
$script:checks=0
function Check([bool]$Condition,[string]$Name){if(-not $Condition){throw "FAIL: $Name"};$script:checks++}
foreach($file in @('AndroidAlarmDiagnostics.psm1','Get-AndroidAudioComparison.ps1','Test-AndroidAlarmDiagnostics.ps1')){
    $tokens=$null;$parseErrors=$null
    $null=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$parseErrors)
    Check ($parseErrors.Count -eq 0) ("PowerShell syntax: "+$file)
}
# Synthetic fixtures only. This script never executes ADB or accesses a phone.
$fixture=@'
- STREAM_RING:
   Max: 99
   streamVolume:99
- STREAM_ALARM:
   Muted: false
   Muted Internally: false
   Min: 0
   Max: 15
   streamVolume:7
   Current: 2 (speaker): 7, 40000000 (default): 11
   Devices: speaker
- STREAM_NOTIFICATION:
   Max: 99
   streamVolume:0
Ringer mode:
- mode (internal) = VIBRATE
- mode (external) = VIBRATE
- ringer mode affected streams = 0x1a6 (STREAM_SYSTEM,STREAM_RING)
'@ -split "`n"
$a=ConvertFrom-AlarmAudioDump $fixture
Check ($a.ringerModeExternal -eq 1) 'VIBRATE external maps to getRingerMode value 1'
Check ($a.alarmCurrent -eq 7) 'ALARM current isolated from other streams'
Check ($a.alarmMaximum -eq 15) 'ALARM maximum isolated'
Check ($a.alarmRouteIndices.Count -eq 2) 'Stored routes retained without choosing default'
Check ($a.alarmDevices -eq 'speaker') 'Route device'
Check ($a.alarmMuted -eq $false) 'Muted false retained'
$b=ConvertFrom-AlarmAudioDump ($fixture -replace 'streamVolume:7','streamVolume:0' -replace 'external\) = VIBRATE','external) = NORMAL')
Check ($b.alarmCurrent -eq 0 -and $b.ringerModeExternal -eq 2) 'Zero volume distinct from normal ringer'
$c=ConvertFrom-AlarmAudioDump ($fixture | Where-Object {$_ -notmatch 'streamVolume:7'})
Check ($null -eq $c.alarmCurrent) 'No guessing current from route'
$c=ConvertFrom-AlarmAudioDump @('OEM unknown layout')
Check ($null -eq $c.ringerModeExternal -and $null -eq $c.alarmMaximum) 'OEM unknown never zero'
$logs=@(
'WNotice: stage=FCM_RECEIVED event=abcdef123456 actualPriority=1 foreground=false locked=true',
'WNotice: stage=FGS_PROMOTED event=abcdef123456 reason=NONE',
'WNotice: stage=AUDIO_FOCUS_SNAPSHOT event=abcdef123456 phase=AFTER_REQUEST result=0 usage=4 appOpRaw=4',
'WNotice: stage=AUDIO_FOCUS event=abcdef123456 value=0',
'WNotice: stage=PLAYER_STARTED event=111111111111 reason=NONE',
'WNotice: stage=MANUAL_STOP event=111111111111 reason=USER_STOP')
$e=ConvertFrom-AlarmEventLogs $logs 'abcdef12'
Check ($e.found -and $e.fgsPromotedObserved) 'Selected event found and promoted'
Check ($e.focusRequestResults.Count -eq 1 -and $e.focusRequestResults[0] -eq 0) 'Focus denied not confused with AppOp 4'
Check (-not $e.playerStartedObserved -and -not $e.manualStopObserved) 'Other event playback and stop excluded'
$e=ConvertFrom-AlarmEventLogs ($logs+@('WNotice: stage=AUDIO_FOCUS event=abcdef123456 value=2','WNotice: stage=PLAYER_STARTED event=abcdef123456 reason=NONE')) 'abcdef12'
Check ($e.playerStartedObserved -and $e.focusRequestResults[1] -eq 2) 'Delayed result and later player recorded separately'
$e=ConvertFrom-AlarmEventLogs $logs '99999999'
Check (-not $e.found -and $e.focusRequestResults.Count -eq 0) 'Missing log window unknown, no invented focus result'
Write-Output "$script:checks assertions passed (3 syntax checks + 14 synthetic parser checks; no device operations)."
