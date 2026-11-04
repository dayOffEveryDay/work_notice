# Work Notice Android 0.3.4 鎖屏 Full-screen Intent 實驗版

本機 Build、98 項測試、Lint 與 APK 簽章結果見 [交付驗證紀錄](PHASE3-ANDROID-0.3.4-VERIFICATION.md)。

## 範圍與實作

版本 code 5、name 0.3.4；minSdk 26、target/compileSdk 37 保持不變。FSI 實驗只在 Android 14/API34 以上提供。尚未自行操作實體手機，不能宣稱 ASUS Android15 的鎖屏自動響鈴已成功。

保留 0.3.3 的 HIGH FCM → 備援先顯示 → 原有 FGS → Audio Focus 成功才循環播放流程。**只有原流程失敗且一般備援成功發出後**，符合以下條件才加發獨立緊急頻道 FSI：

- 使用者已配對、原有未來警報仍啟用／未到期。
- 使用者明確宣告「目前啟用期間所有有效工作事件都需立即處理」，另行啟用預設關閉的全螢幕實驗。App 不讀取 Telegram 本文，也不推論訊息的緊急程度；無法作此宣告時應維持關閉。
- 宣告綁定配對世代及伺服器 alert_settings.updated_at_ms。新一次啟用／重新設定期間、關閉、到期或重新配對均不能自動沿用舊宣告。倒數到期即失效。
- 該事件收到當下已符合宣告，且實際 FCM 優先級為 HIGH；舊事件不因稍後開啟實驗而被升級。
- Android `canUseFullScreenIntent()` 為 true，通知權限、一般備援／播放通道正常，獨立緊急頻道 importance >= HIGH。
- 事件尚有效，同一事件尚未發送過 FSI，且沒有被其他路徑認領／停止／響鈴。

FSI 不會取代一般備援，只有額外的緊急通知；使用者關閉緊急頻道不影響原本備援。新頻道 `urgent-work-fsi-v1` 預設 HIGH、ALARM attributes 的系統警報提示音與震動；只在頻道不存在時建立，不覆寫既有使用者設定、不改音量或手機模式、不設定繞過勿擾。此頻道的一次通知提示音不是持續響鈴的成功證據。

FSI 由 `Notification.Builder.setFullScreenIntent()` 加 immutable、explicit PendingIntent 交給 Android 通知系統；Service 不直接 startActivity，不自行 send PendingIntent。`FsiAlarmActivity` 非 exported，使用公開 setShowWhenLocked/setTurnScreenOn，只顯示一般事件資訊，不解鎖、不索取解鎖憑證。普通 contentIntent 與 system FSI 分開，記錄 USER_CLICK／SYSTEM_FSI。

Activity 必須 RESUMED 且 hasWindowFocus，才可認領事件；服務再驗證 Activity 仍可見、權限、緊急宣告、原警報設定、配對、重啟世代、事件期限與停止狀態。以原有服務取得 Audio Focus，成功才開始播放器。播放器準備完畢亦檢查啟動期限；已開始的循環不因通知 TTL 到期而自動停止。

事件狀態認領共用同一把鎖；FSI/手動補救互斥，一次事件最多一次 FSI。失敗會保留一般通知，可繼續使用「開啟並響鈴」；停止先使事件失效，防止延遲回呼重響。停止當前警報不改未來接收／實驗宣告。關閉實驗不停止已在播放的警報。

## 授權方式

1. 安裝更新後保留既有配對，打開 App，確認原有「持續啟用」或倒數設定。**先設定啟用期間，再開 FSI**；重新儲存啟用期間會使舊宣告失效。
2. 按「宣告緊急用途並啟用全螢幕實驗」，閱讀確認對話框；不符合用途則取消。
3. 按確認後進入 Android 官方「全螢幕通知／全螢幕意圖」特殊存取頁，由使用者手動允許。App 只開設定頁，不自行授權。從設定頁返回會重新顯示 canUseFullScreenIntent 狀態。
4. 確認 UI 同時顯示緊急用途已宣告、系統 FSI 允許；可從「緊急工作警報頻道設定」檢查重要性。若拒絕／撤銷，仍保留原有備援；不自動重開設定頁。
5. 日常不需要全螢幕警報時，關閉實驗；不必撤銷配對或更動雲端。

## Windows PowerShell 5.1 安裝與 Logcat

下列可直接貼入 PowerShell 5.1。請勿使用解除安裝、清除資料或 `adb install -d`。`install -r` 在簽章相符時保留資料；若顯示簽章不符或版本降級，停止並保留現場，不要刪 App 迴避。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    & $adb devices -l
    $phoneSerial = Read-Host '輸入實體手機序號'
    & $adb -s $phoneSerial install -r '.\artifacts\phase3\WorkNoticeAndroid-0.3.4-debug.apk'

安裝成功後由使用者手動開啟 App、檢查配對與授權；不重新配對。先開始即時 Logcat 再傳新 Telegram，Ctrl+C 只停止電腦讀取：

    $logFile = '.\artifacts\phase3\fsi-0.3.4-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
    & $adb -s $phoneSerial logcat -b main -b system -b crash -v epoch -T 1 -s 'WNotice:V' 'AS.HardeningEnforcer:V' '*:S' | Tee-Object -FilePath $logFile

也可沿用自動收集工具；安裝以外仍為唯讀，不需輸入事件短碼：

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Watch-WorkNoticeAudio.ps1 -Serial $phoneSerial -WaitSeconds 120 -CaptureSeconds 30

日誌應出現 FSI_PERMISSION、FSI_POSTED、FSI_ACTIVITY_CREATED、FSI_ACTIVITY_RESUMED、AUDIO_FOCUS、PLAYER_STARTED。FSI_POSTED 只代表 notify 成功返回，不代表 Activity 已顯示；SYSTEM_FSI 是不可變 PendingIntent 的來源標記，不是推測使用者操作。原自動 FGS 的 focus=0 可以仍存在，需看後續 Activity 可見後同事件的第二次合法請求。不能把原拒絕與後續嘗試混成同一次。

## 四種實機驗收

每種情境用新的 Telegram 工作事件。原有警報已啟用，維持使用者平常的震動模式；不需再次測量 A/B 音量。不要先點一般備援；那會變成手動補救，不能算 FSI 自動成功。

| 情境 | 步驟／預期 |
|---|---|
| 鎖屏、螢幕亮著 | 允許 FSI，鎖定安全鎖屏後送新事件；觀察系統是否自動顯示警報 Activity。期待 SYSTEM_FSI → RESUMED → focus=1 → PLAYER_STARTED，持續循環至手動停止。安全鎖仍存在。 |
| 熄屏 | 手動鎖屏並關閉螢幕後送新事件；觀察能否亮屏、Activity 真正可見並持續響鈴。失敗記錄 FSI_PERMISSION/POSTED 與實際 Activity、focus 階段；不能只看通知提示音。 |
| 未鎖屏、其他 App 前景 | 期待 Android 正常 heads-up，不強制開 Activity。若仍只有備援，符合平台限制但**沒有達成全情境自動響鈴**。點緊急通知可進 Activity，日誌應為 USER_CLICK。 |
| 拒絕／撤銷 FSI | 在系統設定關閉權限，原啟用及宣告可保留；送新事件，應無新的 FSI_POSTED/Activity，自動 FGS 原路徑及一般備援／震動仍存在；「開啟並響鈴」可用。 |

補驗競態：短時間多次點擊、重開同通知、事件過期後點擊、Activity 出現前停止、Activity 可見後立即 Home、重新設定啟用期間、關閉實驗、配對世代改變。不得重複播放器、停止後重響或將失敗記成 STOPPED。正常停止後再次送新事件仍可接收。FSI 播放失敗時一般備援不應被取消，且不再對該事件自動加發 FSI。

## ACK 診斷

CloudSyncWorker 保留 WorkManager 網路條件、唯一 ACK 工作與退避重試；不修改 Worker。原泛用 NETWORK_ERROR 改為固定分類 DNS、TLS、TIMEOUT、NETWORK_IO、RESPONSE_JSON、LOCAL_SECURITY、LOCAL_UNEXPECTED，包含 ACK enum、attempt 與是否預計重試。不記錄例外原文、token、headers、request/response body 或 URL。TIMEOUT 尚未細分連線／讀取階段，不冒稱已知道根因；分類只能說明此次本機失敗類型，不能證明遠端未寫入，沿用遠端既有 ACK 去重。

## 政策與相容性風險

- Work Notice 是遠端工作事件警報，不因名稱或宣告就自動符合 Google Play 的「鬧鐘核心功能」預設授權資格。若將來上架，需如實填寫 FSI/FGS 用途、提供必要示範並接受審核，不能承諾核准。
- 官方允許其他 App 在使用者授權後使用 FSI，但仍須限於真正緊急、時間敏感用途；使用者同意不等於一般訊息可無限制接管螢幕。此實驗採明確期間宣告，若實際事件混有一般訊息，應關閉實驗或將未來產品改成更精確的使用者選擇條件。
- FSI 是通知系統管理的公開介面，不會保證 Activity 啟動、焦點成功、FCM 即時必達，也不解除勿擾、音量零、OEM 省電或通知設定限制。
- 未鎖屏通常 heads-up；所以本版本即使鎖屏成功，也不能宣稱完整核心需求在所有背景情境達標。
- API35 手機與 target37 並不等於 Android17 系統。未使用降低 targetSdk、AppOps 改寫、隱藏 API、無聲常駐音軌、背景 Activity trampoline 或固定延遲。

參考：[Google Play FSI/FGS 要求](https://support.google.com/googleplay/android-developer/answer/13392821)、[FSI 官方行為矩陣](https://source.android.com/docs/core/permissions/fsi-limits)、[canUseFullScreenIntent](https://developer.android.com/reference/android/app/NotificationManager#canUseFullScreenIntent())、[音訊焦點規範](https://developer.android.com/media/optimize/audio-focus)。

## 修改檔案清單

- app/build.gradle.kts、app/src/main/AndroidManifest.xml：0.3.4、FSI 權限、非 exported Activity。
- app/src/main/res/layout/activity_main.xml、MainActivity.java：預設關閉的明確用途確認、系統授權入口、狀態與頻道設定。
- FsiSettings.java（新增）：宣告與配對／啟用期間綁定、權限與固定診斷。
- FsiAlarmActivity.java（新增）：鎖屏可見 UI、來源區分、可見性與事件檢查、手動停止。
- Notices.java：獨立緊急頻道、不可變 PendingIntent、FSI 發送與通知清理。
- PendingAlarmStore.java、FallbackAlarm.java：FSI 與手動認領互斥、一次 FSI、持久停止與期限檢查。
- AlarmPlaybackService.java：FSI 交接重驗、準備完成前的期限檢查；焦點與播放器主流程沿用。
- WorkNoticeFirebaseMessagingService.java：只在 HIGH 工作事件接收時保存當時 FSI 資格。
- AlarmPreferencesRepository.java：關閉／失效時清除緊急宣告。
- AckFailure.java（新增）、AlarmDiagnostics.java、CloudSyncWorker.java：非敏感 ACK 分類。
- app/src/test/java/com/worknotice/alarm/FsiTests.java（新增）：FSI、競態、通知與 ACK 分類測試。
- Android README、本文件及交付驗證紀錄。

上列 Java 檔案均位於 android/WorkNoticeAndroid/app/src/main/java/com/worknotice/alarm/。本輪沒有修改 Windows 專案、Worker、Migration、正式 Secrets 或配對資料。
