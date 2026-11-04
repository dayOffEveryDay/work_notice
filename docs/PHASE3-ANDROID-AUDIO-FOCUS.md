# Android 0.3.2：前景服務提升與 Audio Focus

2026-11-03。沿用原 applicationId、Keystore、配對與 Firebase；不修改 Worker、Firebase、D1、Secrets、AppOps 模式或 targetSdk。本版 targetSdk 仍為 37，versionCode 3、versionName 0.3.2。

## 已經證實的失敗階段

實機為 ASUS_AI2302、Android 15 / API 35，安裝的 0.3.1 targetSdk=37。使用者最新紀錄顯示 HIGH FCM（original=1、actual=1）已送達，普通通知已 active，之後 FGS_STARTED → requestAudioFocus 返回 0。ACK HTTP 200，沒有自動 STOPPED。

**原 Java 的 FGS_STARTED 是在 startForeground 成功返回之後，並非剛進入 onStartCommand。** Manifest 已有 foregroundServiceType=mediaPlayback、FOREGROUND_SERVICE、FOREGROUND_SERVICE_MEDIA_PLAYBACK；焦點及播放器均使用 USAGE_ALARM / CONTENT_TYPE_SONIFICATION。0.3.1 並沒有把 requestAudioFocus 放在 startForeground 前面。

在使用者後續禁止操作手機之前，唯讀查到的本 App 系統紀錄也有：

```text
AS.HardeningEnforcer: Focus request DENIED ... req:2 procState:4
TAKE_AUDIO_FOCUS: foreground; ... rejectTime=...
```

`procState:4` 是前景服務程序狀態；`req:2` 是 AUDIOFOCUS_GAIN_TRANSIENT。因此已能確認是 **Android 的音訊 hardening / foreground audio 資格拒絕**，不是 FCM 降權、沒送達、通知未建立或單純漏做服務提升。服務已升前景不等於焦點一定會成功。

官方 Android 15 原始碼的 HardeningEnforcer 會用 TAKE_AUDIO_FOCUS AppOp 判斷；AppOpsUidStateTracker 會檢查 FOREGROUND_AUDIO_CONTROL capability；OomAdjuster 在 FGS 的 while-in-use capability 條件下才賦予該能力。這解釋了為什麼「允許從 FCM 啟動 FGS」與「允許取得前景音訊能力」不能畫上等號。**ASUS 當次是否確實缺該 capability、或有額外 OEM 政策，仍不能只憑公開 App API 或 raw mode 判定。** 本版補上當下觀測值與系統拒絕紀錄的對照；不聲稱已用應用程式改掉系統資格限制。

沒有將原問題猜成「等 100ms 就好」，也不降低 targetSdk、播放靜音音軌、忽略 Audio Focus、修改 AppOps 或套用特殊 FGS 類型。若實機仍回傳 FAILED=0，本版仍保留備援通知，**不承諾背景自動響鈴已解決**。

官方依據：

- [Audio Focus / Android 15 限制](https://developer.android.com/media/optimize/audio-focus)
- [HardeningEnforcer](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/audio/HardeningEnforcer.java)
- [AppOps UID capability 評估](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/appop/AppOpsUidStateTrackerImpl.java)
- [OomAdjuster 的 FGS capability](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/am/OomAdjuster.java)

## 0.3.2 修改

1. AlarmPlaybackService 明確記錄 **FGS_PROMOTE_REQUEST → 實際 startForeground → FGS_PROMOTED**；若呼叫拋錯則 FGS_PROMOTE_FAILED，直接清理並保留 fallback，不繼續 requestAudioFocus。
2. 在提升後、焦點請求前／後、delayed gain callback／timeout 記 AUDIO_FOCUS_SNAPSHOT。沒有在提升與請求中間加固定延遲。
3. 新 AudioFocusStartup 管理每個 session 的狀態，**只允許提升後請求一次**。FAILED=0 是終止失敗，不循環重試。只有 GRANTED=1 或合法後續 GAIN callback 才準備播放器，prepare 成功且仍持有焦點才呼叫 start。
4. 設定 acceptsDelayedFocusGain=true。只有 Android 真正回傳 DELAYED=2 才等待 callback，最多 5 秒且不超過原事件期限；期間保持 FGS／通知。這是等待系統延後授予焦點，不是延遲後重試 FAILED。逾時、手動停止、取消配對或 onDestroy 都使等待失效，舊 callback 不會重啟聲音。
5. FCM 收訊流程不改 HIGH priority 判斷、配對、去重或 ACK；僅把原事件的 monotonic 到期界線附在本機 Service Intent，防止 delayed gain 過期後補響。沒有更動雲端 payload 或正常 Worker。
6. 延續 0.3.1：失敗不取消 fallback、不送 STOPPED；STOPPED 只由目前有效 session 的使用者停止操作產生。

修改檔案：`AlarmPlaybackService.java`、`AlarmDiagnostics.java`、新 `AudioFocusStartup.java`、`Notices.java`（delayed timeout 提示）、`WorkNoticeFirebaseMessagingService.java`（只增加本機到期 extra）、`app/build.gradle.kts`。測試為新 `AudioFocusStartupTests.java` 及擴充 `NotificationTests.java`。

## 新 Logcat 欄位與判讀

WNotice 仍僅記 enum、布林、整數、event 短前綴，不輸出 payload、Token、Bearer、Header、私鑰、例外本文或 stack。

| 欄位 | 意義 |
|---|---|
| FGS_PROMOTE_REQUEST | 即將呼叫實際 startForeground |
| FGS_PROMOTED | 實際呼叫已成功返回，不表示 Audio Focus 一定允許 |
| FGS_PROMOTE_FAILED | 提升拋出分類後的例外，不再請求焦點 |
| phase | PROMOTED／BEFORE_REQUEST／AFTER_REQUEST／CALLBACK／TIMEOUT |
| foregroundReturned | 本 session 的 startForeground 是否已返回 |
| systemForeground | 自有 RunningServiceInfo 的 foreground：1=是，0=否，-1=無法取得。僅快照，不以 unknown 強行擋服務 |
| fgsType | 系統回報服務類型；mediaPlayback bit=2，-1=無法查詢 |
| importance | 自有程序的重要性，例如前景服務通常為 125；不是系統 Logcat 的 procState 編碼 |
| foregroundAgeMs | 提升返回後經過多久，不是固定等待設定 |
| sdk／targetSdk | 實際 OS API／APK target，例如 35／37 |
| appVisible／locked | App 可見及鎖屏狀態 |
| appOpRaw | TAKE_AUDIO_FOCUS 原始模式：0=allowed、1=ignored、2=errored、3=default、4=foreground、-1=無法取得；**4 不代表目前已通過資格檢查** |
| state | FOREGROUND／REQUESTED／WAITING／GRANTED／CLOSED 等 session 狀態 |
| result | -1=尚未請求，0=FAILED，1=GRANTED，2=DELAYED。callback 的正值代表 GAIN，須連同 phase 判讀 |
| usage／contentType／gain | 應為 4／4／2，分別是 ALARM／SONIFICATION／GAIN_TRANSIENT |
| uid／pid | 本 App 的程序識別，用來和系統 hardening 紀錄比對，不是任何認證 token |

如果 **FGS_PROMOTED + foregroundReturned=true + fgsType=2 + systemForeground=1（若可查）** 之後 result=0，再有該 UID 的 `AS.HardeningEnforcer Focus request DENIED`，就可明確排除提升失敗；不要以不斷等待／重試掩蓋。若是 FGS_PROMOTE_FAILED，則先檢查它的安全 reason 與 HIGH FCM／Android 限制。

## 本機驗證與 APK

執行 assembleDebug、testDebugUnitTest、lintDebug。新增測試涵蓋：提升前禁止請求、升前景拋錯不請求焦點、不建立播放器、FAILED 不重試、GRANTED 後才 prepare／start、DELAYED 不提前播放、GAIN 後取消 timeout、timeout 保留通知、快速停止使等待失效、沒有假 STOPPED、原有配對／去重與通知邏輯測試保留。

測試為 JVM + Robolectric，不模擬成手機真的已獲得系統音訊 capability。測試程式在 JVM 取出 listener 來模擬 callback；APK 沒有反射或隱藏 API 繞過。

最終結果：**48 項測試通過、0 失敗、0 略過**（原邏輯 19、生命週期 8、focus startup 6、Robolectric 15）。assembleDebug、lintDebug 成功，Lint 為 **0 errors、35 warnings**；沒有停用檢查。Robolectric 實際驗證 promotion 拋錯不請求焦點，以及 GRANTED／delayed callback 後才開始播放器；未將這些結果宣稱為實體手機可繞過 hardening。

輸出 APK：`C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.3.2-debug.apk`。建置紀錄：`artifacts/phase3/android-audio-focus-build.log`；JUnit／Lint 報告在 Android app/build。沒有安裝新版到實機，也沒有修改手機設定；你要求停止操作手機後只做本機工作。

## 保留配對安裝與驗證（由使用者執行）

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/android/WorkNoticeAndroid'
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
./gradlew.bat assembleDebug testDebugUnitTest lintDebug --no-daemon

$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb devices
$serial=Read-Host '輸入要更新的手機序號'
& $adb -s $serial install -r 'C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.3.2-debug.apk'
& $adb -s $serial shell dumpsys package com.worknotice.alarm | Select-String 'versionCode=|versionName=|targetSdk='
```

預期 0.3.2 / versionCode=3 / targetSdk=37。使用相同 Debug 簽章及 `install -r` 保留 Keystore／配對；不要解除安裝、pm clear、改 AppOps 或重新配對。若簽章不符先確認原簽章，不以刪除資料解決。

先收集 WNotice，再於前景／背景／鎖屏各送**全新** Telegram 事件：

```powershell
$logPath=Join-Path $env:USERPROFILE 'Downloads/work-notice-audio-focus.log'
& $adb -s $serial logcat -T 1 -v threadtime -s 'WNotice:I' '*:S' |
    Tee-Object -FilePath $logPath
```

如果仍 result=0，需要同一事件的 **FGS_PROMOTE_REQUEST、FGS_PROMOTED／FAILED、三筆 snapshot（PROMOTED／BEFORE_REQUEST／AFTER_REQUEST）、FCM priority／locked、AUDIO_FOCUS 返回值、PLAYBACK_FAILED**。

如需核對系統拒絕，另一終端執行下面只保留本 App UID 的系統欄位（沿用 `$adb`、`$serial`）：

```powershell
$pkgLines=& $adb -s $serial shell cmd package list packages -U com.worknotice.alarm
$uidMatch=[regex]::Match(($pkgLines -join ' '),'package:com\.worknotice\.alarm\s+uid:(\d+)')
if(-not $uidMatch.Success){throw '找不到 Work Notice UID'}
$ownUid=$uidMatch.Groups[1].Value
& $adb -s $serial logcat -T 1 -b system -v threadtime -s 'AS.HardeningEnforcer:I' '*:S' |
    Where-Object {$_ -match ('uid:'+[regex]::Escape($ownUid)+'\b')} |
    Tee-Object -FilePath (Join-Path $env:USERPROFILE 'Downloads/work-notice-audio-system.log')
# 以下也只是讀取，不是設定 AppOps。
& $adb -s $serial shell cmd appops get com.worknotice.alarm TAKE_AUDIO_FOCUS
```

串流按 Ctrl+C 結束後可執行最後一行。不要貼完整系統 Logcat、其他 App 的音訊紀錄或任何 Secret。

驗收：前景成功應有 result=1 → PLAYER_PREPARED → PLAYER_STARTED；鎖屏如果仍被 hardening 拒絕，應保留一般備援通知、沒有 PLAYER_STARTED／RINGING、沒有自動 STOPPED。只有手動停止有效 session 才送 STOPPED。若 DELAYED=2，只有後續 GAIN 才開始播放，逾時則保留普通通知。

這個版本改善呼叫順序的可證明性、合法 delayed-focus 與診斷，**不是保證解決該 ASUS Android 15 的背景音訊資格拒絕**。目前合規降級仍是保留通知，由使用者開啟 App；不自動重播舊事件或強行播放沒有焦點的聲音。
