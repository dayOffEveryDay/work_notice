# Android 背景／鎖屏警報修復（0.3.1）

本次只修改 Android Java 專案與測試／文件，沒有操作 Cloudflare、D1、Secrets、重新配對或安裝到使用者手機。現有 applicationId `com.worknotice.alarm`、Keystore alias、bearer 儲存與 Firebase 設定保留；APK versionCode 2、versionName 0.3.1。

## 已確認的程式錯誤與尚待實機確認的原因

原 `AlarmPlaybackService.failed()` 先 `Notices.fallback()`，再呼叫 `finish()`。fallback 以 event.hashCode 作通知 ID，而 finish 立即 cancel 同一個 ID、送 STOPPED，並停止服務。這條路徑在從未開始播放時同樣會執行，與使用者回報 `070affa9`、`83c00614`「NOTIFICATION_FALLBACK → 不到一秒 STOPPED、沒有 RINGING」一致。

因此可以確認 **fallback 被程式自行刪除，且 STOPPED 語意錯誤**。但這些舊 ACK 不能判斷最早是 startForeground 被拒、SecurityException、AudioFocus 未授予或 MediaPlayer 初始化失敗：原碼吞掉了例外。新版本用安全 Logcat 分開診斷，不把其中任何一個當成已在手機上證實的原因。

另一個原碼問題是一般工作通知在取得音訊焦點及初始化播放器之後才建立；前置階段失敗就只能走上述會自動刪掉的 fallback。舊版 `NOTIFICATION_FALLBACK` 在 notify 被拒時仍會送出，不能證明通知曾成功建立。

## 新流程與 ACK 定義

1. `onMessageReceived` 立即記錄 eventId 的短前綴、FCM originalPriority／actualPriority、SDK、前背景、鎖屏、interactive、Doze 與省電狀態。不記完整 payload、messageId、Intent、例外 message／stack、Header 或任何 token。
2. 檢查配對、有效期限、事件 ledger、接收設定；未通過時以固定 reason 記錄原因。仍維持不補發、不重響與倒數到期規則。
3. 有效且啟用的 WORK_ALERT **先建立獨立一般通知**，然後在 FCM callback 內直接請求 mediaPlayback FGS。沒有先等 HTTP ACK，也不把 FGS 啟動交給會延遲的 WorkManager。
4. 只有實際 priority=HIGH 或 App 確實處於可見、螢幕開啟且未鎖定的狀態才嘗試 FGS。背景降權、權限不足及系統拒絕時走 fallback。前景服務成功後才要求音訊焦點，再非同步準備系統警報音。
5. 播放通知使用獨立 ID 100；工作／fallback 使用 `work:<eventId>` tag + ID 101，離線提醒另用 tag／ID 102。取消播放通知不影響一般通知，不再有 hash 與播放 ID 碰撞的風險。API 31+ 播放通知要求 FOREGROUND_SERVICE_IMMEDIATE。
6. 失敗清理先使 session／非同步 callback 失效、釋放音效及焦點、移除 FGS，再保留／更新 fallback。**不 cancel fallback、不送 STOPPED**。快速手動停止後，舊 prepared／error／focus callback 不會復活播放器或停止下一個 session。
7. ACK 的 WorkManager 初始化／排程移至專用背景 executor；HTTP 仍由有網路條件及退避的 Worker 執行。callback 的 FGS／通知處理先完成才提交 RECEIVED ACK。ACK 到伺服器的順序可能因併發與網路重試不同，不能只用 D1 收到時間認定本機操作順序。程序在 WorkManager 持久化前被殺仍可能遺失 best-effort ACK，ACK 不作為啟動響鈴的前置條件。

| ACK | 新版本的意義 |
|---|---|
| RECEIVED | 已通過格式／配對／新鮮度／去重的 callback 收到事件，不代表開始響鈴 |
| RINGING | MediaPlayer.start 已成功返回；每個 session 的每個 event 只排一次。不代表音量非零或使用者聽見 |
| NOTIFICATION_FALLBACK | 權限與工作通道可用，NotificationManager.notify 成功返回。不是鎖屏顯示或使用者看到的保證 |
| STOPPED | 使用者按目前有效 session 的停止按鈕／通知 Action，包括準備完成前快速按停。啟動失敗、系統 onDestroy、取消配對不送此 ACK |

通知與三個通道維持原 ID，工作通道預設 HIGH。一般通知設 VISIBILITY_PUBLIC，僅有「工作通知」及通用錯誤提示，不含 Telegram 內容。**既有使用者／OEM 通道及鎖屏設定優先，不會藉新通道繞過使用者選擇**。若 App 通知授權／通道被關閉，notify 可能被系統無聲阻擋；新版本檢查並記錄 PERMISSION_DENIED／APP_BLOCKED／CHANNEL_BLOCKED，不假裝 fallback 已送出。

## 修改檔案

`app/src/main/java/com/worknotice/alarm/`：

- AlarmPlaybackService.java：分開失敗與使用者停止，分階段處理 FGS／焦點／播放器及過時 callback。
- 新 AlarmLifecycle.java：共用生命週期邏輯，確保失敗不取消通知／不偽造 STOPPED。
- Notices.java：通知先送出、獨立 tag／ID、公開通用鎖屏內容、檢查 notify 結果。
- WorkNoticeFirebaseMessagingService.java、AlarmDelivery.java：前景／鎖屏與實際 FCM priority 決策，直接啟動、分類 fallback。
- 新 AlarmDiagnostics.java：固定欄位與 reason enum 的 WNotice Logcat。
- CloudSyncWorker.java：ACK 的初始化／HTTP 離開收訊關鍵路徑，僅記安全 HTTP 狀態與 ACK enum。
- WorkNoticeApplication.java：鎖屏／熄屏不再誤認為前景。
- AlarmStopReceiver.java、MainActivity.java：只有停止 Action 走 manual stop，取消配對走不同清理。
- app/build.gradle.kts：0.3.1、Robolectric 4.17 測試依賴（不進 APK）。
- 新 AlarmLifecycleTests.java、NotificationTests.java，保留原 AlarmTests.java。

## 本機驗證範圍

執行 `assembleDebug testDebugUnitTest lintDebug`。Java 原 19 項測試、8 項生命週期測試，以及 9 項 Robolectric SDK 35 測試。Robolectric 測試沒有 Firebase Provider 或真實網路，驗證 Android NotificationManager、通道／權限、鎖屏決策、真正 FGS 拒絕例外、實際 Service 音訊焦點拒絕時 fallback 存活、舊 Stop Intent 及 onDestroy 不刪 fallback、Logcat canary 不外洩。模型測試驗證合併／失敗／快速停止／過時 callback／STOPPED 的單一合法來源。

本機測試不取代 OEM 實機的 FCM 授權時窗、Doze、音訊焦點及鎖屏政策驗收；不宣稱新版本已在實體手機鎖屏響鈴。最終日誌 `artifacts/phase3/android-lockscreen-build.log`，JUnit XML 在 `app/build/test-results/testDebugUnitTest/`，Lint 在 `app/build/reports/lint-results-debug.html`。

最終結果：**assembleDebug 成功，36 項測試通過、0 失敗、0 略過，lintDebug 成功（0 errors、35 warnings）**。未停用 Lint 或以手機已響鈴替代測試；本次沒有安裝／操作連接中的實體裝置。既有歷史 D1 記錄不會被更改；舊版已排程的 ACK 也可能較晚抵達，請以更新後的新 eventId 驗證。

## Windows 編譯及保留配對安裝

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/android/WorkNoticeAndroid'
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
./gradlew.bat assembleDebug testDebugUnitTest lintDebug --no-daemon

$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb devices
$serial=Read-Host '輸入要測試手機的序號（多裝置時必須明確選擇）'
& $adb -s $serial install -r 'C:/Users/HowardLu/工作鬧鐘/android/WorkNoticeAndroid/app/build/outputs/apk/debug/app-debug.apk'
& $adb -s $serial shell dumpsys package com.worknotice.alarm | Select-String 'versionCode=|versionName='
```

預期版本 `versionName=0.3.1`、`versionCode=2`。也可使用交付檔 `artifacts/phase3/WorkNoticeAndroid-lockscreen-debug.apk`，或 Android Studio Open 原專案後直接 Run 更新。

使用 **install -r** 及原本的 Debug 簽章保留 App 資料與 Keystore。不要 uninstall、pm clear、清除資料或更換 applicationId；不需重新配對。若發生簽章不一致或版本降級錯誤，先確認使用原機器／原簽章及較高 versionCode，不能靠解除安裝解決而宣稱仍保留配對。

## 可直接執行的安全 Logcat

沿用上方 `$adb` 與 `$serial`，在新終端則先重新設定這兩個變數。開始後維持終端開啟，按 Ctrl+C 結束：

```powershell
$adb=Join-Path $env:LOCALAPPDATA 'Android/Sdk/platform-tools/adb.exe'
& $adb devices
$serial=Read-Host '要測試手機的序號'
$logPath=Join-Path $env:USERPROFILE 'Downloads/work-notice-lockscreen.log'
& $adb -s $serial logcat -T 1 -v threadtime -s 'WNotice:I' '*:S' | Tee-Object -FilePath $logPath
```

只收集本程式 WNotice tag，勿改成無過濾完整 Logcat、dumpsys notification --noredact 或貼 Firebase SDK 的完整 debug 資料。此版本 WNotice 不含完整 eventId、token、私鑰或 bearer。

| 看到的紀錄 | 判讀 |
|---|---|
| FCM_RECEIVED | callback 已確實執行；originalPriority／actualPriority：1=HIGH、2=NORMAL、0=UNKNOWN |
| 沒有該 event 前綴的 FCM_RECEIVED | 不能先假設是 FGS 問題；需查 FCM 延遲／未交付、Force stop、網路及 OEM 政策 |
| locked=true、interactive=false | 確實在鎖屏／熄屏狀態；foreground 應為 false |
| FCM_DECISION reason=PRIORITY_DOWNGRADED | 原始 HIGH 但 actual=NORMAL 時，背景不符合 HIGH 例外，改為一般通知 |
| FGS_REQUEST → FGS_STARTED | startForeground 已返回，接著查看音訊焦點／播放器 |
| FGS_START_DENIED／SECURITY_DENIED | 分辨系統拒絕背景啟動及安全權限問題，沒有輸出例外本文 |
| AUDIO_FOCUS value=0 | 系統未授予音訊焦點；應留下 fallback，沒有自動 STOPPED |
| AUDIO_FOCUS value=1 | 初次請求已授予；後續負值表示音訊被其他 App 打斷 |
| PLAYER_PREPARED → PLAYER_STARTED | 系統音效已準備並成功呼叫 start；RINGING ACK 隨後在背景排程 |
| NOTIFICATION reason=POSTED | notify 返回，activeSnapshot 是當下 active notifications 快照，不保證使用者鎖屏看得到 |
| NOTIFICATION PERMISSION_DENIED／APP_BLOCKED／CHANNEL_BLOCKED | 修正 App／通道設定；不會偽造 NOTIFICATION_FALLBACK ACK |
| FCM_DONE elapsedMs | callback 的通知／FGS 路徑耗時；不包含 HTTP ACK 等待時間 |
| MANUAL_STOP、ACK_QUEUED ack=STOPPED | 使用者有效手動停止；失敗／onDestroy 不應有這兩個紀錄 |

## 鎖屏實機步驟

1. 更新 APK 後開啟 App，確認仍已配對、token 已登記、接收警報持續啟用，先測本機音效並手動停止。確認通知總開關、Work Alerts、警報播放中都允許；Work Alerts 應為高重要性。不要為了測試清除 App 資料。
2. 啟動上方 Logcat。分別在 App 前景、按 Home 回背景、按電源鍵鎖屏／熄屏後，各讓 Telegram 產生一則**全新的 Windows 通知**。每次用不同 eventId，不重送舊事件。記錄 event 前綴、時間與手機 SDK。
3. 正常 HIGH 背景事件應在 Logcat 看到 FCM_RECEIVED → 一般通知 POSTED → FGS_REQUEST → FGS_STARTED → AUDIO_FOCUS=1 → PLAYER_STARTED；手機持續響鈴。由通知 Action／App 停止後才有 MANUAL_STOP／STOPPED，未來接收開關仍啟用。
4. 若服務／音訊啟動失敗，應留下普通 Work Alerts 通知，沒有自動 STOPPED。等待數秒、保持鎖屏，確認通知不自行消失；解鎖後再下拉通知列查看。若 POSTED／activeSnapshot=true 但鎖屏不可見，檢查手機系統「鎖定螢幕通知」及每個通道的可見性／隱藏設定。
5. 快速按停止、停止後再收新事件、響鈴中合併多事件、權限拒絕／通道關閉、FCM 降權、其他音樂／通話搶焦點，分別記錄。偵錯請提供 WNotice 過濾檔及新 event 前綴即可，不需任何 token 或重新配對。

## 系統限制與合規方式

現行做法是有效 HIGH FCM callback 內立即啟動 mediaPlayback 前景服務；服務先 startForeground 再要求 USAGE_ALARM 音訊焦點，持續顯示可停止的通知。降為 NORMAL 或系統拒絕時只送一般通知，不透過 WorkManager、特殊服務類型、精確鬧鐘、全螢幕 Intent、無障礙／電池白名單或 DND bypass 繞過限制。

通知已呼叫 notify 不代表系統必在鎖屏展示，也不會強制亮屏。使用者停用通知／通道／鎖屏顯示時無法保證可見；Force stop、沒有 Play Services、Doze、OEM 省電／背景限制、無網路、FCM 降權可能延遲或阻止 callback。已過期的事件仍不補響。音量與勿擾由使用者決定；音訊焦點被搶時尊重系統暫停，不宣稱 100% 背景必達。

官方依據：[背景啟動與 HIGH FCM 例外](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[音訊焦點](https://developer.android.com/media/optimize/audio-focus)、[通知權限](https://developer.android.com/develop/ui/views/notifications/notification-permission)、[建立通知及鎖屏可見性](https://developer.android.com/develop/ui/views/notifications/build-notification)。
