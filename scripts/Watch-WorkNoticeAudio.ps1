[CmdletBinding(DefaultParameterSetName='Live')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Live')][ValidatePattern('^[A-Za-z0-9_.:-]+$')][string]$Serial,
    [Parameter(Mandatory=$true,ParameterSetName='Replay')][string]$ReplayLog,
    [Parameter(ParameterSetName='Replay')][string]$ReplaySamples,
    [ValidateRange(10,600)][int]$WaitSeconds=120,
    [ValidateRange(5,60)][int]$CaptureSeconds=15,
    [ValidateRange(1,30)][int]$CommandTimeoutSeconds=8,
    [string]$OutputDirectory=(Join-Path (Split-Path $PSScriptRoot) 'artifacts/phase3/audio-live')
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'WorkNoticeLiveDiagnostics.psm1') -Force
$folder=Join-Path $OutputDirectory ([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))
$null=New-Item -ItemType Directory -Force -Path $folder
$rawPath=Join-Path $folder 'logcat-raw.txt'
$writer=[IO.StreamWriter]::new($rawPath,$false,[Text.UTF8Encoding]::new($false));$writer.AutoFlush=$true
$lines=[Collections.Generic.List[string]]::new();$samples=[Collections.Generic.List[object]]::new();$errors=[Collections.Generic.List[string]]::new()
$tasks=[Collections.Generic.List[object]]::new();$pending=[Collections.Generic.Queue[string]]::new();$triggers=@{}
$ownUid='UNKNOWN';$endReason='NOT_STARTED';$logProcess=$null;$synthetic=$PSCmdlet.ParameterSetName -eq 'Replay'
$deviceEpoch=$null

function Start-AdbRead([string[]]$Parts){
    # Arguments are fixed commands plus a validated serial; no shell interpolation.
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$script:adb;$info.Arguments=('-s '+$Serial+' '+($Parts -join ' '))
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $p=[Diagnostics.Process]::new();$p.StartInfo=$info
    $null=$p.Start()
    [pscustomobject]@{process=$p;output=$p.StandardOutput.ReadToEndAsync();error=$p.StandardError.ReadToEndAsync();start=[DateTimeOffset]::UtcNow}
}
function Read-Bounded([string[]]$Parts){
    $r=Start-AdbRead $Parts
    try {
        if(-not $r.process.WaitForExit($CommandTimeoutSeconds*1000)){$r.process.Kill();throw 'ADB setup read timed out'}
        if($r.process.ExitCode -ne 0){throw 'ADB setup read failed (device unavailable/unauthorized or unsupported command)'}
        $r.output.GetAwaiter().GetResult()
    } finally {$r.process.Dispose()}
}
function Queue-Observation([object]$Event){
    if($Event.stage -in @('FCM_RECEIVED','FGS_PROMOTED','AUDIO_FOCUS')){
        $key=$Event.eventId+':'+$Event.stage
        if(-not $triggers.ContainsKey($key)){$triggers[$key]=$true;$pending.Enqueue($key)}
    }
}
try {
    if($synthetic){
        # Replay is entirely offline: no SDK lookup, ADB process, or device access.
        foreach($line in [IO.File]::ReadLines((Resolve-Path -LiteralPath $ReplayLog).Path)){
            $writer.WriteLine($line);$lines.Add($line)
            $ev=Get-WorkNoticeLogEvent $line;if($null -ne $ev){Queue-Observation $ev}
        }
        if($ReplaySamples){
            $fixture=Get-Content -LiteralPath $ReplaySamples -Raw | ConvertFrom-Json
            $ownUid=[string]$fixture.uid
            foreach($sample in $fixture.samples){$samples.Add($sample)}
        }
        $endReason='OFFLINE_REPLAY'
    } else {
        $script:adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
        if(-not(Test-Path -LiteralPath $adb)){throw 'SDK adb.exe not found'}
        $uidText=Read-Bounded @('shell','cmd','package','list','packages','-U','com.worknotice.alarm')
        if($uidText -match 'package:com\.worknotice\.alarm\s+uid:(\d+)'){$ownUid=$Matches[1]}else{$errors.Add('UID_NOT_FOUND: history filtering unavailable')}
        $deviceEpoch=$null
        try {$deviceEpoch=[double](Read-Bounded @('shell','date','+%s')).Trim()}catch{$errors.Add('DEVICE_CLOCK_UNAVAILABLE: old backlog is not used as an event trigger')}
        # Explicit buffers and priorities. Never use -c, -G, setprop, or a PID filter.
        $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$adb
        $info.Arguments='-s '+$Serial+' logcat -b main -b system -b crash -v epoch -T 1 WNotice:V AS.HardeningEnforcer:V *:S'
        $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        $logProcess=[Diagnostics.Process]::new();$logProcess.StartInfo=$info;$null=$logProcess.Start()
        $stderr=$logProcess.StandardError.ReadToEndAsync();$next=$logProcess.StandardOutput.ReadLineAsync()
        $watch=[Diagnostics.Stopwatch]::StartNew();$firstEventMs=$null;$endReason='WAIT_TIMEOUT'
        Write-Host ('READY - send ONE new Telegram event. Auto capture; no event ID entry needed. Folder: '+$folder)
        while($true){
            # Always drain/save logcat BEFORE collecting completed dumpsys tasks.
            while($next.IsCompleted){
                $line=$next.GetAwaiter().GetResult()
                if($null -eq $line){$endReason='LOGCAT_ENDED';break}
                $writer.WriteLine($line);$lines.Add($line)
                $ev=Get-WorkNoticeLogEvent $line
                if($null -ne $ev -and $null -ne $deviceEpoch -and $null -ne $ev.deviceEpochSeconds -and $ev.deviceEpochSeconds -ge $deviceEpoch){
                    Queue-Observation $ev
                    if($null -eq $firstEventMs){$firstEventMs=$watch.ElapsedMilliseconds;Write-Host ('Event detected: '+$ev.eventId)}
                }
                $next=$logProcess.StandardOutput.ReadLineAsync()
            }
            if($endReason -eq 'LOGCAT_ENDED'){break}
            if($tasks.Count -eq 0 -and $pending.Count -gt 0){
                $trigger=$pending.Dequeue()
                foreach($kind in @('process','services','appops')){
                    $parts=switch($kind){'process'{@('shell','dumpsys','activity','processes')};'services'{@('shell','dumpsys','activity','services','com.worknotice.alarm')};'appops'{@('shell','dumpsys','appops')}}
                    try {$r=Start-AdbRead $parts;$tasks.Add([pscustomobject]@{kind=$kind;trigger=$trigger;read=$r})}catch{$errors.Add('SAMPLER_START_FAILED: '+$kind)}
                }
            }
            for($i=$tasks.Count-1;$i -ge 0;$i--){
                $t=$tasks[$i];$r=$t.read;$timedOut=([DateTimeOffset]::UtcNow-$r.start).TotalSeconds -gt $CommandTimeoutSeconds
                if($r.process.HasExited -or $timedOut){
                    $status='OK';$fields=@()
                    try {
                        if($timedOut -and -not $r.process.HasExited){$r.process.Kill();$status='TIMEOUT'}
                        if($status -eq 'OK' -and $r.process.ExitCode -ne 0){$status='COMMAND_FAILED'}
                        if($status -eq 'OK'){$fields=@(Select-WorkNoticeSystemFields $t.kind ($r.output.GetAwaiter().GetResult() -split '\r?\n') $ownUid)}
                    } catch {$status='READ_FAILED'}
                    $finish=[DateTimeOffset]::UtcNow
                    $missingReason=if($status -ne 'OK'){$status}else{if($fields.Count -eq 0){'NO_MATCHING_FIELDS: service may have exited, UID may be unknown, history may be omitted/overwritten, or OEM dump format differs'}else{''}}
                    $samples.Add([pscustomobject]@{kind=$t.kind;trigger=$t.trigger;startedAtUtc=$r.start.ToString('o');finishedAtUtc=$finish.ToString('o');durationMs=[math]::Round(($finish-$r.start).TotalMilliseconds);status=$status;missingReason=$missingReason;fields=$fields;temporalMeaning='ASYNCHRONOUS_SNAPSHOT_OR_HISTORY_CANDIDATE_NOT_REQUEST_TIME_PROOF'})
                    $r.process.Dispose();$tasks.RemoveAt($i)
                }
            }
            if($null -ne $firstEventMs -and $watch.ElapsedMilliseconds-$firstEventMs -ge $CaptureSeconds*1000){$endReason='CAPTURE_WINDOW_COMPLETE';break}
            if($null -eq $firstEventMs -and $watch.Elapsed.TotalSeconds -ge $WaitSeconds){break}
            Start-Sleep -Milliseconds 10
        }
    }
} catch {$endReason='CAPTURE_ERROR';$errors.Add($_.Exception.Message)}
finally {
    foreach($t in $tasks){
        try {if(-not $t.read.process.HasExited){$t.read.process.Kill()}}catch{}
        $samples.Add([pscustomobject]@{kind=$t.kind;trigger=$t.trigger;startedAtUtc=$t.read.start.ToString('o');finishedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');durationMs=$null;status='CAPTURE_ENDED_BEFORE_SAMPLE_COMPLETED';fields=@();temporalMeaning='UNKNOWN'})
        $t.read.process.Dispose()
    }
    if($null -ne $logProcess){
        try {if(-not $logProcess.HasExited){$logProcess.Kill()};$null=$logProcess.WaitForExit(2000)
            if($stderr.IsCompleted){[IO.File]::WriteAllText((Join-Path $folder 'logcat-stderr.txt'),$stderr.GetAwaiter().GetResult())}
        }catch{$errors.Add('LOGCAT_CLEANUP_FAILED')}
        $logProcess.Dispose()
    }
    $writer.Dispose()
    $cutoff=0;if($null -ne $deviceEpoch){$cutoff=$deviceEpoch}
    $report=New-WorkNoticeLiveReport -Lines $lines.ToArray() -Samples $samples.ToArray() -OwnUid $ownUid -EndReason $endReason -Errors $errors.ToArray() -Synthetic $synthetic -MinimumDeviceEpoch $cutoff
    $report | Add-Member -NotePropertyName triggeredObservations -NotePropertyValue @($triggers.Keys)
    $report | Add-Member -NotePropertyName observationsNotStartedBeforeCaptureEnded -NotePropertyValue @($pending.ToArray())
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $folder 'report.json') -Encoding UTF8
    @('Work Notice audio diagnostic report',('End: '+$endReason),('Synthetic: '+$synthetic),('Events: '+$report.events.Count),('UID: '+$ownUid),'Request-time FOREGROUND_AUDIO_CONTROL: UNKNOWN (inspect timestamped history candidates)',($report.missingReasons -join "`r`n"),'Details: report.json; raw stream: logcat-raw.txt; logcat errors: logcat-stderr.txt') | Set-Content -LiteralPath (Join-Path $folder 'summary.txt') -Encoding UTF8
    Write-Output ('Report: '+[IO.Path]::GetFullPath((Join-Path $folder 'report.json')))
}
