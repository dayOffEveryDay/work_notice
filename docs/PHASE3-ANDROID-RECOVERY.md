# Android 0.3.3：保留自動響鈴，改善失敗備援

2026-11-03。本次只做本機開發／JVM 測試，沒有操作手機、Cloudflare、D1、Secrets、部署 Worker 或改配對。targetSdk 仍為 37，applicationId／Keystore／Firebase 設定不變。新 APK versionCode=4、versionName=0.3.3。

## 實作方向與風險

主要路徑仍是：有效的新 HIGH FCM → 先顯示一般通知 → mediaPlayback FGS 提升 → Audio Focus 成功 → 持續播放，直到使用者停止。本版沒有把自動響鈴改成一律手動，也沒有固定延遲、FAILED 焦點重試、降低 targetSdk、修改 AppOps、特殊 FGS 類型、隱藏 API 或無聲音軌守候。

仍有可驗證的合規方向：同裝置比較 FCM 自動背景啟動與可見 Activity 啟動 FGS 的資格差異，並驗證「由 Activity 合法開始播放後，切到背景／鎖屏是否能持續」。能啟動 FGS 不保證有 FOREGROUND_AUDIO_CONTROL capability；目前資料支持系統資格路徑拒絕，不能僅由此認定 ASUS 韌體 Bug。Issue 375228130 的現行修補狀態／ASUS 是否納入，仍未核實。

本版的安全補強是使用者明確按「開啟並響鈴」，開啟可見 Activity 後再取得資格。這是額外補救，不保證解決原本從背景自動開始播放的限制。

風險與邊界：

- 通知聲音／震動取決於通道、通知音量、勿擾、硬體及使用者選擇，App 不能保證一定可聽見。
- 人工補救需先以 HTTPS 讀取最新手機 status 確認伺服器警報設定；網路失敗會保留通知，不以舊資料冒稱允許。此網路只在使用者操作後發生，不阻擋原 HIGH FCM 自動路徑。
- 工作事件維持約 120 秒有效期，人工操作不延長期限。過期後仍可看到通知，但不能啟動舊工作警報。
- 每事件只有一次有效的前景補救嘗試；已響過、已停止或補救後焦點再次失敗都不能反覆點擊重響。網路確認失敗尚未消耗嘗試，可在期限內重新點通知。
- 已有通道不會自動改聲音、震動、重要性或建立替代通道繞過使用者選擇。

## 聲音與震動

原 Work Alerts 為 HIGH，但未明確啟用震動。本版只在**首次建立**通道時設定系統預設通知提示音、USAGE_NOTIFICATION_EVENT、震動模式（0/250/150/250ms）與 HIGH；新增一般 VIBRATE 權限。沒有使用 alarm usage 強行繞過使用者的通知靜音。

既有通道只讀實際 getSound／shouldVibrate／importance，不覆寫。主畫面新增「工作通知的聲音與震動設定」，並顯示提示音是否設定、震動開關、通知音量及警報音量。Logcat CHANNEL_SETTINGS 只記布林／數字，不記使用者音效 URI。

一般通知先顯示，備援在相同 tag 上更新，使用 OnlyAlertOnce 避免同一事件在幾毫秒內連續提示。不同事件保有不同 tag，不互相合併掉；備援沒有 AUTO_CANCEL，不會因開啟 Activity 就自行消失。

## 「開啟並響鈴」安全流程

1. FCM 通過既有配對／新鮮度／去重／啟用檢查後，保留本機事件 ID、配對建立時間、boot count、原始 monotonic 到期時間；不保存 Telegram 文字或認證資料。
2. 自動響鈴失敗才提供操作。通知以 immutable PendingIntent 開啟**不可匯出的 RingActionActivity**，每事件有獨立隨機一次性操作驗證值，只放 private preferences／Intent extras，不記日誌、不放 URI。備援操作不直接從 BroadcastReceiver 偷啟動播放器。
3. Activity 必須 resumed、實際取得 window focus、螢幕 interactive 且未鎖定。先在背景讀取目前伺服器 status；畫面若離開，舊回應不會啟動服務。這條路徑不寫回本機設定，避免覆蓋使用者剛剛關閉的未來警報。
4. 原子認領操作，檢查配對未變、同一次開機、事件未過期、目前本機與伺服器設定都允許；Service 收到時再次核對。重複 Activity／重複 Service Intent 只有一個能通過。
5. 使用與原自動路徑相同的 Service／Audio Focus／單一播放器，不另生 eventId，也不呼叫 /api/alert。焦點被拒仍保留一般通知，不回報 STOPPED，不再產生新的人工操作。
6. 真正開始播放後將事件標為 RANG，工作通知更新為播放狀態，不再提供重響動作；有效手動停止才標 STOPPED。點擊過期或舊操作只顯示原因，不取消備援、不播放。
7. 快速按停止會先使尚未送達 Service 的人工操作失效；即使稍後收到 HTTP 回應或 Service Intent，也不會突然響。原「停止目前響鈴」與「關閉未來新警報」仍獨立。

只讀 status 與 ACK 仍使用原手機 bearer，沒有新增管理金鑰、Windows Secret 或 Worker API。配對／手機 bearer 的安全儲存不變，備援 metadata 一樣排除備份，並限制筆數及清理期限。

## 同 APK、同裝置比較測試

一次安裝 0.3.3 後，整組不要更換 APK／targetSdk／通道／音量／勿擾設定。持續啟用，每種情境至少三個新的 Telegram 事件；每輪先手動停止前一輪，避免已持有焦點干擾下一輪。

| 情境 | 操作 | 比較資料 |
|---|---|---|
| A 前景 | MainActivity 可見，送新 Telegram | FCM priority、importance、capability、result=1 與否 |
| B 背景 | 按 Home，未鎖屏，送新 Telegram | FGS_PROMOTED／systemForeground／type=2、UID capability、result |
| C 鎖屏 | 按電源鍵鎖屏／熄屏，送新 Telegram | 與 B 比較，分辨是背景共通資格還是鎖屏差異 |
| D 使用者補救 | B/C 失敗後，在有效期內按「開啟並響鈴」，依系統要求解鎖 | USER_RECOVERY、Activity 可見、FGS／focus／RINGING |
| E 已播放後背景 | D 或 A 確認已開始響，再按 Home／鎖屏 | 焦點是否保留、音效是否繼續；不是從閒置背景開始播放的替代證明 |

如果 B/C 的 FGS 已提升，但 UID 缺 A 且 TAKE_AUDIO_FOCUS eval=ignored，而 A/D 得到允許，支持「啟動來源／capability 差異」；如果相同時間的 UID cap 有 A 仍被拒，需進一步核對該 build 的有效規則／OEM 差異，不能用程序 importance 或 appOpRaw 單一數值下結論。

## 唯讀 ADB capability 診斷

App 端保持使用公開 API，沒有為了讀 capability 加入 privileged／usage access 權限或反射。capability 透過使用者手動執行的 ADB dumpsys 取得。

`FOREGROUND_AUDIO_CONTROL = 1 << 6 = 0x40`。AOSP 的 capability 摘要字串為 L/C/M/N/F/U/A，最後的 **A** 表示該 bit。不能把 appOpRaw=4、fgsType=2 或 importance=125 當成這個 bit；也不能把 dumpsys 沒輸出欄位當作 capability=0。AppOps 評估的是 UID 聚合資格，優先對照同 UID 的系統評估紀錄。

提供 [Get-AndroidAudioComparison.ps1](../scripts/Get-AndroidAudioComparison.ps1)，本輪只做語法檢查，**未對手機執行**。它只讀取：

- `dumpsys activity processes` 中本 App 程序的 curProcState／curCapability／setCapability。
- `dumpsys appops` 中本 App UID 的 UPDATE_UID_PROC_STATE／COMMIT_UID_STATE／TAKE_AUDIO_FOCUS 的 EVAL_FOREGROUND_MODE。
- 本 App 的服務前景欄位、原始 TAKE_AUDIO_FOCUS mode、WNotice 安全日誌、版本／API／build／安全修補日期。

原始全域 dumpsys 只暫存在記憶體，不寫入報告；輸出只保留本 App 的指定欄位，不包含其他 App 的 Intent／通知／認證資料。OEM 不提供紀錄時明確當作未知。

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘'
$serial=Read-Host '測試手機序號'
./scripts/Get-AndroidAudioComparison.ps1 -Serial $serial -Case Foreground
# 下一輪切 Home 並送新事件後：
./scripts/Get-AndroidAudioComparison.ps1 -Serial $serial -Case Background
# 下一輪鎖屏並送新事件後：
./scripts/Get-AndroidAudioComparison.ps1 -Serial $serial -Case Locked
# 再於有效期內按「開啟並響鈴」後：
./scripts/Get-AndroidAudioComparison.ps1 -Serial $serial -Case UserRecovery
```

焦點失敗後服務很快退出，之後的 process snapshot **不是請求當下狀態**。請優先用相同時間的 AppOps EVAL_FOREGROUND_MODE（若韌體有保留）與 WNotice／HardeningEnforcer。AOSP 此類事件紀錄為有限環形緩衝，請測試後立即擷取；讀不到就是未知，不補造結論。TOP／暫時允許等系統分支也可能在未見 A 時允許，不能只看字母而忽略 eval result／uidState。

持續安全日誌沿用：

```powershell
$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb -s $serial logcat -T 1 -v threadtime -s 'WNotice:I' '*:S'
```

## 修改及測試

新增：FallbackAlarm.java、PendingAlarmStore.java、RingActionActivity.java、activity_ring_action.xml、FallbackAlarmTests.java、RecoveryTests.java、唯讀比較腳本。

修改：AlarmPlaybackService.java、Notices.java、WorkNoticeFirebaseMessagingService.java、AlarmDiagnostics.java、MainActivity.java、activity_main.xml、AndroidManifest.xml、app/build.gradle.kts 及說明文件。

測試涵蓋原自動流程、前景服務／focus／單播放器、通道聲音震動預設、保留既有靜音設定、immutable Activity 操作、事件期限、配對改變、重開機、一次性認領、跨 store／Activity 重複點擊、設定關閉、Service 再檢查、網路驗證失敗、離開畫面的過時 callback、快速停止、再次焦點拒絕時通知保留，以及 STOPPED 來源。Robolectric 測試用 fake status 驗證，**沒有呼叫正式 Worker**。

本機 Gradle 日誌：`artifacts/phase3/android-recovery-build.log`；JUnit／Lint 報告在 app/build。新版實體手機尚未驗收，不能把 JVM 測試當作 ASUS 系統音訊已允許。

最終結果：**76 項測試通過、0 失敗、0 略過**；assembleDebug 成功，lintDebug 成功（**0 errors、42 warnings**，未停用檢查）。APK 內容已確認 versionName=0.3.3、versionCode=4、targetSdk=37，RingActionActivity 的 exported=false，FGS／mediaPlayback／VIBRATE 權限宣告保留或加入正確。唯讀比較腳本通過 PowerShell 語法檢查，但沒有對手機執行。

## 編譯與保留配對安裝

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/android/WorkNoticeAndroid'
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
./gradlew.bat assembleDebug testDebugUnitTest lintDebug --no-daemon

$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb devices
$serial=Read-Host '要更新的手機序號'
& $adb -s $serial install -r 'C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.3.3-debug.apk'
& $adb -s $serial shell dumpsys package com.worknotice.alarm | Select-String 'versionCode=|versionName=|targetSdk='
```

預期 0.3.3／versionCode=4／targetSdk=37，沿用同簽章與 install -r，不解除安裝、不清除資料、不重新配對。若簽章或版本不符先確認原簽章，不刪除資料解決。

更新後先查看 Work Alerts 的實際音效與震動設定；既有通道若為靜音／不震動，需由使用者按 App 的設定入口選擇。接著跑比較矩陣，再驗收備援：有效事件可手動響、重複點擊不疊播放器、已停止／過期／關閉接收不響、關閉未來警報不停止已開始聲音、手動停止不改接收設定。

官方依據：[通知通道與使用者設定](https://developer.android.com/develop/ui/compose/notifications/channels)、[可見 Activity／通知操作的 FGS 規則](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[AOSP UID AppOps capability](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/core/java/com/android/server/appop/AppOpsUidStateTrackerImpl.java)、[capability 字串與 0x40](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/core/java/android/app/ActivityManager.java)。
