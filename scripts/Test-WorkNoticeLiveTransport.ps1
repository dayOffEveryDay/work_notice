# Windows-only synthetic transport integration test. No real ADB is invoked.
$ErrorActionPreference='Stop'
$root=Join-Path (Split-Path $PSScriptRoot) ('artifacts/phase3/mock-transport/'+[guid]::NewGuid().ToString('N'))
$sdk=Join-Path $root 'Android/Sdk/platform-tools';$null=New-Item -ItemType Directory -Force -Path $sdk
$code=@'
using System;
using System.Threading;
class MockTransport {
 static void Main(string[] args) {
  string cmd=String.Join(" ",args);
  if(cmd.Contains("package list")){Console.WriteLine("package:com.worknotice.alarm uid:10193");return;}
  if(cmd.Contains("date +%s")){Console.WriteLine("1793672600");return;}
  if(cmd.Contains("logcat")){
   Thread.Sleep(200);
   Console.WriteLine("1793672600.010 123 123 I WNotice: stage=FCM_RECEIVED event=0b20a65837a9 actualPriority=1");Console.Out.Flush();
   Thread.Sleep(30);
   Console.WriteLine("1793672600.040 123 123 I WNotice: stage=FGS_PROMOTED event=0b20a65837a9 reason=NONE");
   Console.WriteLine("1793672600.041 123 123 I WNotice: stage=AUDIO_FOCUS event=0b20a65837a9 value=0");
   Console.WriteLine("1793672600.045 123 123 I WNotice: stage=SERVICE_DESTROYED event=0b20a65837a9 reason=NONE");Console.Out.Flush();
   Thread.Sleep(30000);return;
  }
  Thread.Sleep(1200); // Deliberately slower than the entire simulated FGS lifetime.
  if(cmd.Contains("processes")){Console.WriteLine("*APP* 123:com.worknotice.alarm/u0a193\n curCapability=------- setCapability=-------");return;}
  if(cmd.Contains("services")){Console.WriteLine("no matching services");return;}
  if(cmd.Contains("appops")){Console.WriteLine("11-03 02:24:33.041 EVAL_FOREGROUND_MODE uid=10193 capability=---NFU- code=TAKE_AUDIO_FOCUS result=ignore");return;}
  Environment.Exit(1);
 }
}
'@
$src=Join-Path $root 'MockTransport.cs';$code | Set-Content -LiteralPath $src -Encoding UTF8
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe (('/out:'+ (Join-Path $sdk 'adb.exe'))) $src
if($LASTEXITCODE -ne 0){throw 'Synthetic transport compilation failed'}
$scriptPath=Join-Path $PSScriptRoot 'Watch-WorkNoticeAudio.ps1'
$out=Join-Path $root 'results'
$p=[Diagnostics.Process]::new();$i=[Diagnostics.ProcessStartInfo]::new()
$i.FileName=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$i.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$scriptPath+'" -Serial MOCK_ONLY -WaitSeconds 10 -CaptureSeconds 5 -OutputDirectory "'+$out+'"'
$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true
# Override SDK discovery only inside the isolated test child, never this host or system settings.
$i.EnvironmentVariables['LOCALAPPDATA']=$root
$p.StartInfo=$i;$null=$p.Start();$stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
try {
 if(-not $p.WaitForExit(20000)){$p.Kill();throw 'Mock test timeout'}
 if($p.ExitCode -ne 0){throw ('Mock child failed: '+$stderr.GetAwaiter().GetResult())}
 $file=Get-ChildItem -LiteralPath $out -Recurse -Filter report.json | Select-Object -First 1
 $r=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
 if($r.endReason -ne 'CAPTURE_WINDOW_COMPLETE'){throw ('Wrong end reason: '+$r.endReason+' '+($r.captureErrors -join ' '))}
 if($r.events.Count -ne 1 -or $r.events[0].focusRequests[0].result -ne 0){throw 'Lost live events'}
 if($r.events[0].stages -notcontains 'SERVICE_DESTROYED'){throw 'Log stream blocked by slow dumpsys'}
 if($r.samples.Count -lt 3 -or $r.appOpsUidHistoryCandidates.Count -ne 1){throw 'Missing asynchronous samples'}
 if($r.events[0].requestTimeForegroundAudioControl -ne 'UNKNOWN'){throw 'Late snapshot misclassified'}
 if(@($r.samples | Where-Object {$_.durationMs -ge 1200}).Count -eq 0){throw 'Missing acquisition latency'}
 # Mark fixture output explicitly; never present synthetic transport as a phone result.
 $r.synthetic=$true;$r | Add-Member -NotePropertyName testSource -NotePropertyValue 'LOCAL_COMPILED_MOCK_NO_PHONE'
 $r | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $file.FullName -Encoding UTF8
 '6 transport checks passed: asynchronous log persistence, event association, sampling, latency, UNKNOWN and auto completion. LOCAL MOCK ONLY.'
} finally {$p.Dispose()}
