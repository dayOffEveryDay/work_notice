Set-StrictMode -Version Latest
function Get-WorkNoticeLogEvent {
    param([string]$Line)
    if($Line -notmatch '\bWNotice\s*:\s*.*\bstage=([A-Z_]+)\s+event=([a-f0-9]{8,64})(?:\s|$)'){return $null}
    $stage=$Matches[1];$eventId=$Matches[2]
    $epoch=$null
    if($Line -match '^\s*(\d{10}\.\d+)\s'){$epoch=[double]::Parse($Matches[1],[Globalization.CultureInfo]::InvariantCulture)}
    [pscustomobject]@{stage=$stage;eventId=$eventId;deviceEpochSeconds=$epoch;line=$Line}
}
function Select-WorkNoticeSystemFields {
    param([string]$Kind,[string[]]$Lines,[string]$OwnUid)
    switch($Kind){
        'process' {
            $inside=$false
            foreach($line in $Lines){
                if($line -match '^\s*\*(?:APP|PERS)\*'){$inside=$line -match 'com\.worknotice\.alarm(?:[:/}\s]|$)'}
                if($inside -and $line -match '^\s*(?:curProcState=|curCapability=|setCapability=)'){$line.Trim()}
            }
        }
        'appops' {
            if($OwnUid -match '^\d+$'){
                foreach($line in $Lines){
                    if($line -match ('\buid=\s*'+[regex]::Escape($OwnUid)+'\b') -and
                        ($line -match 'UPDATE_UID_PROC_STATE|COMMIT_UID_STATE' -or ($line -match 'EVAL_FOREGROUND_MODE' -and $line -match 'TAKE_AUDIO_FOCUS'))){$line.Trim()}
                }
            }
        }
        'services' {
            foreach($line in $Lines){
                # Scalars only. Never persist notification objects, Intent extras or debugInfo.
                foreach($m in [regex]::Matches($line,'\b(?:isForeground|foregroundServiceType|types|mAllowWhileInUsePermissionInFgs|allowWhileInUsePermissionInFgs|mAllowStartForeground|useNewWiuLogic_forCapabilities\(\)|mAllowWiu_(?:noBinding|inBindService|byBindings)|getFgsAllowWiu_(?:legacy|new|forCapabilities|forStart)|getFgsAllowStart(?:_legacy|_new)?|mAllowStart_(?:noBinding|inBindService|byBindings))=([A-Za-z0-9_-]+)')){$m.Value}
            }
        }
    }
}
function New-WorkNoticeLiveReport {
    param([string[]]$Lines,[object[]]$Samples,[string]$OwnUid,[string]$EndReason,[string[]]$Errors,[bool]$Synthetic=$false,[double]$MinimumDeviceEpoch=0)
    $parsed=@($Lines | ForEach-Object {Get-WorkNoticeLogEvent $_} | Where-Object {$null -ne $_ -and ($MinimumDeviceEpoch -eq 0 -or ($null -ne $_.deviceEpochSeconds -and $_.deviceEpochSeconds -ge $MinimumDeviceEpoch))})
    $events=@(foreach($group in @($parsed | Group-Object eventId)){
        $entries=@($group.Group)
        $focus=@($entries | Where-Object {$_.stage -eq 'AUDIO_FOCUS'} | ForEach-Object {
            if($_.line -match '\bvalue=([012])\b'){[pscustomobject]@{result=[int]$Matches[1];deviceEpochSeconds=$_.deviceEpochSeconds}}
        })
        [pscustomobject]@{
            eventIdObserved=$group.Name;eventIdScope='APK logs only an event prefix, not the full eventId'
            firstDeviceEpochSeconds=$entries[0].deviceEpochSeconds
            firstDeviceTimeUtc=$(if($null -ne $entries[0].deviceEpochSeconds){[DateTimeOffset]::FromUnixTimeMilliseconds([long]($entries[0].deviceEpochSeconds*1000)).ToString('o')}else{'UNKNOWN'})
            fcmReceived=@($entries | Where-Object {$_.stage -eq 'FCM_RECEIVED'} | ForEach-Object {$_.line})
            focusRequests=$focus
            focusSnapshots=@($entries | Where-Object {$_.stage -eq 'AUDIO_FOCUS_SNAPSHOT'} | ForEach-Object {$_.line})
            fgsPromotedObserved=(@($entries | Where-Object {$_.stage -eq 'FGS_PROMOTED'}).Count -gt 0)
            playerStartedObserved=(@($entries | Where-Object {$_.stage -eq 'PLAYER_STARTED'}).Count -gt 0)
            stages=@($entries | ForEach-Object {$_.stage});logs=@($entries | ForEach-Object {$_.line})
            requestTimeForegroundAudioControl='UNKNOWN'
            capabilityReason='ADB snapshots are not atomic with requestAudioFocus. UID history has no eventId; candidate history must be aligned by device time and UID before concluding request-time capability.'
        }
    })
    $history=@($Samples | Where-Object {$_.kind -eq 'appops'} | ForEach-Object {$_.fields} | Sort-Object -Unique)
    [pscustomobject]@{
        schemaVersion=1;synthetic=$Synthetic;generatedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');uid=$OwnUid
        endReason=$EndReason;events=$events;samples=@($Samples);appOpsUidHistoryCandidates=$history
        hardeningLogCandidates=@($Lines | Where-Object {$_ -match '\bAS\.HardeningEnforcer\b' -and $OwnUid -match '^\d+$' -and $_ -match ('\buid\s*[:=]\s*'+[regex]::Escape($OwnUid)+'\b')})
        logcatStartBoundary='-T 1 can include one backlog line. Device epoch startup cutoff is second-resolution; an old line in that same second cannot be ruled out. Send a NEW event only after READY.'
        captureErrors=@($Errors)
        missingReasons=@(
            if($events.Count -eq 0){'NO_WORK_NOTICE_EVENT: timeout, disconnected logcat, missing tag/priority/buffer, OEM suppression, or no event during capture; inspect raw logcat and stderr.'}
            if($history.Count -eq 0){'NO_UID_HISTORY_EXPOSED_OR_CAPTURED: empty history is not proof of absent capability. OEM/version may omit history, ring buffer may overwrite, UID may be unknown, or command may fail.'}
            'FGS/process snapshots can be post-destruction. Start/finish UTC and duration are host acquisition bounds, NOT the device state transition time.'
            'No public ADB interface guarantees atomic request-time FOREGROUND_AUDIO_CONTROL. Missing data stays UNKNOWN.'
        )
    }
}
Export-ModuleMember -Function Get-WorkNoticeLogEvent,Select-WorkNoticeSystemFields,New-WorkNoticeLiveReport
