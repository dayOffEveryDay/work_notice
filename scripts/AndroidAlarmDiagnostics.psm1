# Pure parsers: no ADB, device operations, or changes to Android settings.
Set-StrictMode -Version Latest
function ConvertFrom-AlarmAudioDump {
    param([string[]]$Lines)
    $text=$Lines -join "`n"
    $external=[regex]::Match($text,'(?m)^\s*- mode \(external\) = (SILENT|VIBRATE|NORMAL)\s*$')
    $mode=$null
    if($external.Success){$mode=@{SILENT=0;VIBRATE=1;NORMAL=2}[$external.Groups[1].Value]}
    $block=[regex]::Match($text,'(?ms)^\s*- STREAM_ALARM:\s*\r?\n(?<fields>.*?)(?=^\s*- STREAM_[A-Z_]+:|\z)')
    $current=$null; $maximum=$null; $muted=$null; $internal=$null
    $routes=@(); $devices='UNKNOWN'
    if($block.Success){
        $fields=$block.Groups['fields'].Value
        $m=[regex]::Match($fields,'(?m)^\s*streamVolume:\s*(\d+)\s*$')
        if($m.Success){$current=[int]$m.Groups[1].Value}
        $m=[regex]::Match($fields,'(?m)^\s*Max:\s*(\d+)\s*$')
        if($m.Success){$maximum=[int]$m.Groups[1].Value}
        $m=[regex]::Match($fields,'(?m)^\s*Muted:\s*(true|false)\s*$')
        if($m.Success){$muted=$m.Groups[1].Value -eq 'true'}
        $m=[regex]::Match($fields,'(?m)^\s*Muted Internally:\s*(true|false)\s*$')
        if($m.Success){$internal=$m.Groups[1].Value -eq 'true'}
        $m=[regex]::Match($fields,'(?m)^\s*Current:\s*([^\r\n]*)')
        if($m.Success){
            $routes=@([regex]::Matches($m.Groups[1].Value,'([a-fA-F0-9]+)\s*\(([a-zA-Z0-9_ -]+)\):\s*(\d+)') | ForEach-Object {
                [pscustomobject]@{deviceHex=$_.Groups[1].Value; device=$_.Groups[2].Value; index=[int]$_.Groups[3].Value}
            })
        }
        $m=[regex]::Match($fields,'(?m)^\s*Devices:\s*([a-zA-Z0-9_, |()x-]+)\s*$')
        if($m.Success){$devices=$m.Groups[1].Value.Trim()}
    }
    [pscustomobject]@{
        ringerModeExternal=$mode
        ringerModeName=$(if($external.Success){$external.Groups[1].Value}else{'UNKNOWN'})
        alarmCurrent=$current;alarmMaximum=$maximum;alarmMuted=$muted;alarmMutedInternally=$internal
        alarmDevices=$devices;alarmRouteIndices=$routes
        ringerAndZenMasks=@($Lines | Where-Object {$_ -match '^\s*- ringer mode (affected|muted) streams = 0x[0-9a-fA-F]+(?:\s|$)'} | ForEach-Object {$_.Trim()})
        note='streamVolume is the AudioService getStreamVolume(STREAM_ALARM) result. Current lists per-route stored indices, NOT necessarily the active volume. Missing scalar values are null/UNKNOWN, never inferred from a route.'
    }
}
function ConvertFrom-AlarmEventLogs {
    param([string[]]$Lines,[string]$EventPrefix)
    $selected=@($Lines | Where-Object {$_ -match ('\bevent='+[regex]::Escape($EventPrefix)+'[a-f0-9]*(?:\s|$)')})
    $stages=@($selected | ForEach-Object {
        $m=[regex]::Match($_,'\bstage=([A-Z_]+)');if($m.Success){$m.Groups[1].Value}
    })
    $snapshots=@($selected | Where-Object {$_ -match 'stage=AUDIO_FOCUS_SNAPSHOT\b'})
    $results=@($selected | Where-Object {$_ -match 'stage=AUDIO_FOCUS\b'} | ForEach-Object {
        $m=[regex]::Match($_,'\bvalue=([012])\b');if($m.Success){[int]$m.Groups[1].Value}
    })
    [pscustomobject]@{
        eventPrefix=$EventPrefix;found=($selected.Count -gt 0);stages=$stages;focusRequestResults=$results
        focusSnapshots=$snapshots
        fgsPromotedObserved=($stages -contains 'FGS_PROMOTED')
        playerStartedObserved=($stages -contains 'PLAYER_STARTED')
        manualStopObserved=($stages -contains 'MANUAL_STOP')
        logs=$selected
        note='Observed flags mean present in this bounded log window only. Absent does not prove never executed. PLAYER_STARTED proves start() returned, not audible output. Focus callback grants can follow result=2. Align event timestamps with capability history.'
    }
}
Export-ModuleMember -Function ConvertFrom-AlarmAudioDump,ConvertFrom-AlarmEventLogs
