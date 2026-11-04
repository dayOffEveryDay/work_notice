# Work Notice Android 0.3.5：倒數啟用與模式 UI

## 根因與證據界線

已讀取 XML、MainActivity、AlarmPolicy、PairingRepository、ApiClient、AlarmPreferencesRepository 以及現有 Worker 的 mobile alert-settings route（僅讀本機原始碼，未操作雲端）。

1. XML 的 timed ID 與 Java listener 正確綁定；API 的 PUT 路徑、TIMED mode、durationMinutes、enabled 及 offlineAlerts 欄位符合既有 Worker。沒有證據支持「按鈕沒有綁定」或「Worker API 不存在」。
2. **可重現的輸入缺陷**：原 listener 直接對兩個欄位各自 Integer.parseInt。只填分鐘、清空小時（或反過來）便在 API 呼叫前拋出 NumberFormatException；空白／空字串沒有被當成 0。新的測試同時重現原解析失敗、確認修正後可送出 5 分鐘。
3. **可重現的回饋缺陷**：原輸入錯誤、處理中、成功及網路錯誤都寫入頁面最下方 result，與倒數操作區相隔許多控制項。使用者可能完全看不到，呈現「點擊無明顯反應」。本輪沒有實機 HTTP trace，故不能斷言每次回報都是空欄，也沒有假稱確認正式 API 成功。
4. 原模式儲存沒有防連點，請求會排進 executor；重複 TIMED PUT 會由伺服器重新計算到期時間及版本，使倒數不必要地延長、FSI 宣告失效。現在同程序一次只允許一個設定寫入，包含 Activity 換實例時的互斥。
5. 原程式已使用「PUT → GET status」確認設定，並非完全沒有同步。本次保留這個正確流程，新增格式驗證、儲存中狀態，以及 PUT 成功但 GET 失敗的「結果未確認」分類，不冒稱已啟用。確認 D1 回應的 stored enabled 為整數 0/1；讀回以布林 effectiveEnabled 為準，測試 fixture 亦使用真實 JSON 型別，未把整數誤當布林驗證。

## 使用方式與 UI

最上方「目前工作警報狀態」卡片清楚顯示：警報已關閉／持續啟用中／倒數啟用中。倒數使用 HH:mm:ss，並顯示台灣時區預計到期時間、最近確認時間與快取狀態說明。

- 小時 0～24、分鐘 0～59，總時間 1～1440 分鐘；任一空白欄視為 0，兩欄皆空或皆 0 會在欄位及卡片顯示錯誤。24 小時只能搭配 0 分鐘；空白兩側先 trim，過大整數會被拒絕。
- 操作為「啟用倒數警報」、「持續啟用」、「關閉未來新警報」。儲存中禁止重複操作時間、模式、重新整理、配對及離線設定，服務播放／停止操作不受阻擋。
- 卡片內就近顯示儲存中、伺服器確認成功、具體 HTTP／網路／安全儲存／格式錯誤。沒有原始例外內容或任何憑證輸出。
- PUT 成功但 GET 失敗：保留最近確認狀態，提示「伺服器可能已儲存，請先重新整理，勿重複延長倒數」。一般網路傳輸失敗亦不推論遠端一定未儲存。
- 「停止目前正在播放的警報」獨立放在卡片下方；關閉未來警報不呼叫播放器停止。
- FSI 仍獨立顯示狀態與原因。新的啟用期間通常更新 alertSetting.updated_at_ms，必須在設定成功後重新確認緊急用途；不自動替使用者續簽宣告。

## 真實倒數與重開行為

倒數不在點擊時本機起算。只有伺服器 PUT 成功、GET 讀回可驗證的真實狀態後，才更新既有 repository。由 serverNow、expires_at_ms 及往返耗時轉成既有 elapsedRealtime deadline；UI 與事件入口 enabled() 使用相同期限。

同一次手機開機內，deadline 經 SharedPreferences 保存，重新開啟 Activity／repository 不會延長倒數。手機重啟後 elapsedRealtime 失去同一基準，既有設計維持 fail-closed，需重新同步；未放寬此限制。

到期後 repository.enabled() 為 false，既有 FCM 入口因此不為未來新工作事件啟動警報；不需要靠 UI 每秒 tick 寫入一個假關閉狀態。已經響鈴的播放器不因這個期限自動停止。伺服器也使用其原有 effectiveEnabled／expires 條件，本輪未修改正式 Worker。

保留既有安全行為：按關閉未來警報時本機先關閉，再同步伺服器；若網路失敗，明確提示本機已關閉、雲端同步未確認，而不是假稱兩邊都成功。其他啟用操作不先樂觀顯示成功。

## 本機驗證

執行 assembleDebug、testDebugUnitTest、lintDebug：BUILD SUCCESSFUL。

- 125 項測試、0 failures、0 errors；原有 109 項全部保留，新增 AlarmSettingsTests 16 項。
- 覆蓋舊空欄 Bug、輸入邊界、真正 PUT/GET 順序及 payload、HTTP 授權／網路失敗、部分成功、格式失敗、程序共享防連點、到期、新 repository 恢復期限、monotonic deadline、RTT 保守扣除、模式切換、FSI 版本失效及 MainActivity 實際按鈕與文字狀態。
- MainActivity 測試用明確注入的假 Gateway，不連線正式 API。配對依賴注入僅供測試，正式 constructor 沿用安全憑證檢查；不使用假配對或通知模擬宣稱實機成功。
- Lint：0 errors、55 warnings，未關閉 Lint 或用 baseline 隱藏錯誤。警告含文字國際化、UI label／layout 建議、SharedPreferences 同步寫入及依賴版本建議。
- APK：artifacts/phase3/WorkNoticeAndroid-0.3.5-debug.apk，4,760,154 bytes；versionCode7、versionName0.3.5、targetSdk37，FIREBASE_CONFIGURED=true。
- SHA-256：DBD4753A872A6BA7C46AE2758EB8E1DBCBCFB5EA921B2CD1E0C90433CABEF987。
- apksigner verify 通過，debug 憑證與 0.3.4.1 相同（f3b7cf2584830e61494aa0da14ed7ce28c9458e1d7f06c66f3be0dbd33674766）。未自行安裝手機。

測試結果：android/WorkNoticeAndroid/app/build/reports/tests/testDebugUnitTest/index.html；Lint：app/build/reports/lint-results-debug.html。

## 更新與實機驗收

以下可在 Windows PowerShell 5.1 貼上，由使用者執行。只更新、不解除安裝、不清資料、不重新配對。若簽章不符請停止，不要以刪除資料處理。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    & $adb devices -l
    $phoneSerial = Read-Host '輸入手機序號'
    & $adb -s $phoneSerial install -r '.\artifacts\phase3\WorkNoticeAndroid-0.3.5-debug.apk'

1. 留小時空白、分鐘輸入 2，按倒數；應立即看見儲存中，讀回成功後出現「倒數啟用中」、約 00:02:00 與真實到期時間。連點不得多送設定或延長期間。
2. 重新確認該期間的 FSI 緊急用途，送新 Telegram；確認既有鎖屏亮屏、焦點、循環與手動停止。停止後在期間內送新事件仍能觸發。
3. 關閉／重開 App，倒數應繼續剩餘期間，不從 2 分鐘重新開始。
4. 等待到期，畫面顯示警報已關閉；之後新的 Telegram 不應啟動警報。到期前已在播放的警報仍由使用者手動停止。
5. 切成持續啟用，再切回新倒數；觀察三種狀態與 FSI 重新確認提示。系統 FSI 權限不應被改動。
6. 使用者自行斷網測一次啟用：不得顯示啟用成功；原先確認狀態仍可辨識。恢復網路後先重新整理確認遠端結果。斷網按關閉時須提示本機關閉、同步未確認。
7. 空白兩欄、0/0、24/1、分鐘60均應立即顯示具體輸入錯誤；0/1、空白/1、1/空白、24/0應可提交。

## 修改檔案

- MainActivity.java：倒數 listener、模式呈現、儲存互斥／回饋、生命週期回呼防護。
- activity_main.xml：頂部狀態卡片、可見欄位標籤、就近回饋及獨立停止區。
- AlarmModeUi.java（新增）：輸入驗證、剩餘時間格式、安全錯誤文字。
- AlarmSettingsSave.java（新增）：序列化 PUT/GET 確認與程序範圍寫入互斥。
- AlarmPreferencesRepository.java：讀取既有 timed/deadline 給 UI；正式 enabled 判斷維持，新增測試用配對依賴注入。
- AlarmSettingsTests.java（新增）：16 項測試。
- app/build.gradle.kts：0.3.5 / code7。
- README、本文件、APK 與 checksum。

Java 檔案位於 android/WorkNoticeAndroid/app/src/main/java/com/worknotice/alarm/，測試位於 app/src/test/java/com/worknotice/alarm/。未修改 WorkNoticeFirebaseMessagingService、FsiAlarmActivity、AlarmPlaybackService、AudioFocusStartup、Notices、Windows、Worker、Migration 或 Secrets。這些已成功的流程由原有回歸測試保護，但本輪未操作實體手機；最終鍵盤／畫面及鎖屏回歸仍需使用者驗收。
