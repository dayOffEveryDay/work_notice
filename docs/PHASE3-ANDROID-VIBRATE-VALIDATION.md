# Android 0.3.3：震動模式自動持續警報驗證

前景響鈴／震動驗證現已由使用者確認通過，毋須重測。背景短暫 FGS 的後續取證改用 [自動串流診斷](PHASE3-ANDROID-LIVE-CAPTURE.md)，不再要求事後手動填事件短碼執行 After。

本輪日期：2026-11-03。只新增電腦端診斷與測試方案，沒有修改 Java、Manifest、targetSdk、播放器或 APK；沒有操作手機或正式雲端。目標仍是有效 Telegram 工作事件自動持續播放警報，直到使用者手動停止；一般通知僅為失敗備援。

## 先分開兩個問題

1. **播放資格**：HIGH FCM → 提升 mediaPlayback FGS → requestAudioFocus → 取得焦點後啟動播放器。`FGS_PROMOTED` 成功不等於本次 Audio Focus 必定允許。`AUDIO_FOCUS value=0` 時不能跳過結果強播。
2. **可聽見程度**：即使取得焦點且 `PLAYER_STARTED`，仍受警報音量、靜音、勿擾策略、輸出裝置影響。震動模式的 ringerMode 與 STREAM_ALARM 是不同觀察值，不以其中一項推導另一項。

目前程式確認：`AlarmPlaybackService.java` 先 startForeground，再 requestAudioFocus；focus 與 MediaPlayer 均使用 USAGE_ALARM=4；只有取得焦點後才 start()，setLooping(true)。目前沒有找到需要重構播放器的明確缺陷。官方規範仍以 top App 或正在執行的 FGS 作為 Android 15+ 焦點條件，但這不是所有裝置情境下必定成功的保證。

## 四組同 APK 實驗

| 組別 | App 狀態 | 手機模式 | 與誰比較／目的 |
|---|---|---|---|
| A | Work Notice Activity 前景、螢幕開啟 | 響鈴 NORMAL=2 | 基準，確認 FCM 而非本機測試聲音 |
| B | Work Notice Activity 前景、螢幕開啟 | 震動 VIBRATE=1 | A/B 隔離模式影響 |
| C | Home 後背景、未鎖屏、螢幕開啟 | 響鈴 NORMAL=2 | A/C 隔離背景影響 |
| D | Home 後背景、鎖屏且螢幕關閉 | 震動 VIBRATE=1 | 核心使用情境，含模式與鎖屏兩個變因 |

四組各做三次，使用相同 APK 0.3.3、同裝置、相同警報音量與輸出裝置，勿擾先手動關閉作為基準。不要用 A/D 的差異直接判定震動造成問題。若 C/D 不同，補做 **E：背景未鎖屏＋震動**、**F：背景鎖屏＋響鈴**，分離鎖屏與模式交互影響。

使用者自行在系統 UI 調整模式與警報音量；腳本不會調整。保持 STREAM_ALARM 大於零且相同，無通話、無其他 App 正在播放，記錄藍牙／耳機狀態、電量節省與電池最佳化設定。USB 連線可能讓手機充電、不進入自然 Doze，故這輪主要驗證模式與焦點，不代表長時間待機可靠性；不要用 ADB 強制 Doze。

每次確認警報啟用、Windows 監控中，上一個警報已由使用者停止。背景是按 Home，不是強制停止 App 或從設定頁停止服務。D 手動鎖屏後確認 FCM 日誌 locked=true、interactive=false。使用全新的 Telegram 訊息／eventId；不清除配對、不重送舊事件。每次只測一個事件，避免合併警報影響結果。

## 可直接執行的唯讀指令

在工作區開啟 PowerShell。以下命令只讀取裝置；腳本只把經篩選的報告寫到電腦 `artifacts/phase3/audio-comparison/`。完整 dumpsys 只在記憶體處理，不保存其他 App 的通知、Intent 或資料。既有 WNotice 診斷只包含枚舉、數值、布林及事件短碼。

```powershell
Set-Location 'C:\Users\HowardLu\工作鬧鐘'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
& $adb devices -l
$phoneSerial = '填入上一步的手機序號'
```

第一個 PowerShell 視窗持續收 WNotice，**不清空 Logcat**。Ctrl+C 停止；不影響 App。

```powershell
$logPath = Join-Path $PWD ('artifacts\phase3\audio-comparison\live-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.txt')
New-Item -ItemType Directory -Force (Split-Path $logPath) | Out-Null
& $adb -s $phoneSerial logcat -v threadtime -s 'WNotice:I' '*:S' |
    Tee-Object -FilePath $logPath
```

第二個 PowerShell 視窗同樣設定工作目錄與 `$phoneSerial`，以 A 第一輪示例：

```powershell
# 先手動調好 A 組狀態，尚未傳送新 Telegram。
.\scripts\Get-AndroidAudioComparison.ps1 -Serial $phoneSerial -Case A -Trial 1 -Sample Before
# 傳送一則新 Telegram；從第一視窗找到本次 FCM_RECEIVED 的 event 短碼。
# 在仍響鈴時立即收集；若失敗則在備援出現後立即收集。不要先開啟 App。
.\scripts\Get-AndroidAudioComparison.ps1 -Serial $phoneSerial -Case A -Trial 1 -Sample After -EventPrefix '填入8至12碼小寫十六進位事件短碼'
```

`EventPrefix` 範例格式為 `abcdef123456`；必須換成本次事件。參數驗證會拒絕中文佔位文字。B/C/D 只改 `-Case`；三次重複改 `-Trial 1/2/3`。After 報告包含該事件的選取日誌、焦點結果與 PLAYER_STARTED 觀察值。Before 沒有 EventPrefix，避免把歷史事件當成這次測試。

收集完第一輪結果，先記錄是否真的聽到**持續循環警報**或只有短促通知聲、震動、備援可見性。成功時使用者手動「停止目前警報」，確認不影響未來警報啟用。失敗時先保留原始資料，再測備援的「開啟並響鈴」；此操作會改變前景狀態，必須另存 Recovery，不能混算自動成功：

```powershell
.\scripts\Get-AndroidAudioComparison.ps1 -Serial $phoneSerial -Case D -Trial 1 -Sample Recovery -EventPrefix '填入本次事件短碼'
```

人工記錄一份表格：`Case / Trial / event / Before音量 / After音量 / 焦點結果 / PLAYER_STARTED / 聽到循環聲 / 備援可見 / 震動 / 手動停止成功 / 未來警報仍啟用`。未聽見不能填成未啟動播放器；兩者分開記錄。

## 報告欄位與判讀

| 項目 | 來源與應觀察結果 |
|---|---|
| getRingerMode | WNotice `CHANNEL_SETTINGS ringerMode=0/1/2` 是既有 APK 實際 API 呼叫；沒有 event 欄位，須靠緊鄰時間確認。報告 `audioState.ringerModeExternal` 由 AudioService external mode 映射同一組值；不能冒稱腳本在 App 內新增了 API 呼叫。internal/external 不混用。 |
| STREAM_ALARM 音量 | `audioState.alarmCurrent` 讀 `STREAM_ALARM` 區塊的 `streamVolume`（AudioService getStreamVolume 結果）；`alarmMaximum` 讀 Max，已是音量刻度，不再除以 10。`alarmRouteIndices` 是各輸出裝置存量，不能拿 default/speaker 值冒充現在音量。OEM 缺少 streamVolume 時 current=null，手動從 App 現有警報音量 UI 補記，最大值仍可獨立讀取。 |
| 靜音與輸出 | alarmMuted、alarmMutedInternally、alarmDevices、ringerAndZenMasks；路由改變時不能與其他試次直接比較。STREAM_ALARM bit 為 1<<4=0x10，但 mask 與實際靜音需一起看。 |
| AudioAttributes | 同事件 `AUDIO_FOCUS_SNAPSHOT usage=4 contentType=4`；目前程式播放器與 focus 共用 ALARM 屬性。usage=4 不代表音量必定非零或無條件繞過 DND。 |
| 焦點 | `stage=AUDIO_FOCUS value=0` 拒絕，1 允許，2 延後；snapshot 的 `result=-1` 是尚無返回值。2 必須等 CALLBACK/GRANTED，不能立即播放。 |
| FGS | 同事件 FGS_PROMOTE_REQUEST → FGS_PROMOTED，snapshot foregroundReturned=true、systemForeground=1、fgsType=2。不要把 FGS_STARTED（僅進入服務流程）視為提升成功。 |
| 程序與 capability | processFields、appOpsUidEvents；對齊同事件時間、UID、pid。AOSP Android 15 FOREGROUND_AUDIO_CONTROL bit 為 0x40，人類可讀 capability 摘要末位 A。缺欄位或 OEM 不輸出就是 UNKNOWN，不能視為沒有；importance=125 也不是 capability 本身。 |
| AppOps | audioFocusRawMode=foreground、appOpRaw=4 是 MODE_FOREGROUND，僅表示條件模式。匹配時間的 EVAL_FOREGROUND_MODE code=TAKE_AUDIO_FOCUS result=... 才是更直接的系統判斷；其他 op 結果不混用。即使沒有 A，TOP/暫時 allowlist 等也可能影響系統判斷，不能只憑 bit 結論。 |
| DND | `zenMode` 是 shell settings global：0=關、1=priority、2=none、3=alarms。WNotice NOTIFICATION 的 `dnd` 是 NotificationManager interruptionFilter：1=ALL、2=PRIORITY、3=NONE、4=ALARMS、0=UNKNOWN；**兩種數值不是同一組枚舉**。priority 模式還要看使用者是否允許警報，不能只看啟用位元就斷言靜音。 |
| 播放 | 同事件 PLAYER_PREPARED → PLAYER_STARTED；後者只表示 MediaPlayer.start() 正常返回，不保證揚聲器有聲，需人工聽音與記錄。RINGING ACK 不是聲學測量。 |

資料採樣不是原子快照；腳本依次執行 dumpsys。背景拒絕後服務很快退出，因此 After 的程序狀態可能已是 cached。優先用 **同時刻 AppOps UID 歷史 EVAL_FOREGROUND_MODE** 與 App 的 AFTER_REQUEST log 對齊。歷史環形緩衝被覆寫、服務已退出或 OEM 不提供資料時，不能補造申請當下的 capability。

若需要即時系統拒絕理由，可在額外視窗只讀取 HardeningEnforcer，僅保留本 App UID 的行：

```powershell
$uidLine = & $adb -s $phoneSerial shell cmd package list packages -U com.worknotice.alarm
$uidMatch = [regex]::Match(($uidLine -join ' '), 'package:com\.worknotice\.alarm\s+uid:(\d+)')
if (-not $uidMatch.Success) { throw 'Work Notice UID not found' }
$ownUid = $uidMatch.Groups[1].Value
$uidFilter = '\buid\s*[:=]\s*' + [regex]::Escape($ownUid) + '\b'
& $adb -s $phoneSerial logcat -v threadtime -s 'AS.HardeningEnforcer:I' '*:S' |
    Select-String -Pattern $uidFilter
```

不要分享完整 dumpsys、完整 logcat 或 token。腳本不執行 logcat -c、appops set、settings put、am start/force-stop、音量調整、安裝或清除資料。

## 依結果決定最小修正

| 結果 | 結論範圍與下一步 |
|---|---|
| A/B 都 focus=1、PLAYER_STARTED 且循環可聽 | 證明這台裝置在這些設定下可於震動模式播放警報，不能直接外推背景。 |
| A 成功；B focus=1、PLAYER_STARTED 卻無聲 | 先比較 alarm volume/mute、DND、路由；只有這些一致仍有差異，才進一步驗證模式／系統音訊策略。不能宣稱 Audio Focus 拒絕。 |
| A/B 成功；C/D focus=0、未見 PLAYER_STARTED | 背景播放資格／焦點問題，並非單純震動靜音；保留備援通知與震動，繼續對齊 capability 與 EVAL_FOREGROUND_MODE。 |
| 任一組 alarmCurrent=0 | 下一階段最小 UI 改動：啟用警報與 Activity 回到前景時顯示「警報音量為零，持續警報可能無聲」，顯示 current/max，提供使用者開啟音效設定的入口；不自動調整音量，不把零音量當成 focus 拒絕，也不阻止備援。 |
| focus=1 卻沒有 PLAYER_STARTED | 排查 PLAYER_PREPARED、PLAYER_ERROR、焦點丟失、過期／取消及生命週期；這才可能形成可修正程式缺陷。 |
| focus=2 | 現有流程已接受合法延後焦點，等真正 grant callback 才播放；事件過期或逾時轉備援，不加固定延遲或無限重試。 |

後續任何最小修改都維持：USAGE_ALARM、循環直到手動停止、獨立的未來警報開關、焦點失敗不誤送 STOPPED、不自動取消備援、不更改手機模式與系統音量。

## 合規自動背景響鈴方向與風險

**目前已有可驗證的公開 API 路徑**：有效 HIGH FCM → 使用者可見備援 → mediaPlayback FGS → 成功提升 → 合法 focus grant → ALARM MediaPlayer 循環。A–D 正是在驗證這條路徑；前景服務 type 是描述實際播放用途，不能隨意換成其他 type 取得能力。已提升仍被拒時，沒有一般 App 可用的公開 API 直接授予自身 FOREGROUND_AUDIO_CONTROL 或保證焦點成功。

若匹配時間的 EVAL 記錄顯示背景 capability 不符合條件，下一步是同 APK 在另一台 API 35 裝置／AOSP API35 模擬器比較，以及同手機更新系統前後比較。模擬器可用既有明確本機測試操作比較前景聲音；未配置 FCM 的模擬器結果不能冒充端到端背景推播通過。只有收斂到特定系統版本、條件或程式觸發點後，才評估系統／廠商相容性，現在不直接認定 ASUS 韌體 bug。

「開啟並響鈴」是使用者明確互動、使 Activity 前景後重新檢查事件有效性與設定的合規替代；已成功但**不等於自動背景目標完成**。可另測「前景開始播放→按 Home→鎖屏」是否持續，區分新啟動與延續播放的限制。

不預先播放無聲音軌或常駐空 FGS 保資格；不以 AlarmManager 臨時包裝已收到的 FCM 事件繞過焦點。真正的使用者預約鬧鐘可另評估 exact alarm 權限與用途，但它既不是遠端事件即時性的保證，也沒有免除焦點檢查。全螢幕通知的資格、使用者授權與商店政策另有要求，不能把強制開 Activity 當成通用修復。

DND 另開實驗：在 A/B/C/D 基準完成後，手動啟用「允許警報」及「不允許警報」的策略，各使用新事件記錄焦點、播放器、聲音。不新增通知政策存取權限、不自行更改 DND；使用者主動啟用工作警報不等於授權無條件繞過勿擾。

## 本機工具測試與限制

```powershell
.\scripts\Test-AndroidAlarmDiagnostics.ps1
```

使用合成的 dumpsys／WNotice fixture 驗證 parser：不同 stream 隔離、震動映射、音量零與未知區分、路由不推算目前音量、不同事件隔離、focus=0/2 與播放器觀察分離。這不是實機驗收，也不模擬宣稱已取得真實 FCM 或 Android 音訊狀態。本輪未修改 App，因此不重新產生 APK；繼續使用既有 0.3.3，不需要重新安裝或配對。

## 官方依據

- [Audio focus：Android 15 的 top App/FGS 條件、焦點成功才播放與 delayed focus](https://developer.android.com/media/optimize/audio-focus)
- [AudioManager：getRingerMode、STREAM_ALARM 與音量 API](https://developer.android.com/reference/android/media/AudioManager)
- [AudioAttributes：USAGE_ALARM](https://developer.android.com/reference/android/media/AudioAttributes)
- [HIGH FCM 與使用者互動的 FGS 背景啟動例外](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [mediaPlayback type 與權限](https://developer.android.com/develop/background-work/services/fgs/service-types#media)
- [NotificationManager：Interruption Filter](https://developer.android.com/reference/android/app/NotificationManager)
- [AOSP Android 15 AudioService：dump 音量單位、external ringer mode](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/audio/AudioService.java)
- [AOSP Android 15 AppOpsUidStateTracker：capability 與 foreground op 判斷／歷史](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/appop/AppOpsUidStateTrackerImpl.java)
- [AOSP Android 15 ActivityManager：FOREGROUND_AUDIO_CONTROL 常數](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/core/java/android/app/ActivityManager.java)

AOSP 是比較判讀依據，不代表 ASUS 實機與其逐行相同；裝置未輸出的欄位維持未知。
