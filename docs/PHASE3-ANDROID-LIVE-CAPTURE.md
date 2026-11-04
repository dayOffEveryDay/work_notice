# Android 0.3.3 即時音訊資格診斷

本輪僅修改電腦端工具，沒有修改 Android App、播放器、APK、正式雲端或手機設定。使用 Windows PowerShell 5.1。

## 複製執行

在 PowerShell 5.1 整段貼上下面內容（不要貼 Markdown 的圍欄）。手機序號只在開始時輸入，不再要求事件短碼：

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    & $adb devices -l
    $phoneSerial = Read-Host '輸入上述手機序號'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Watch-WorkNoticeAudio.ps1 -Serial $phoneSerial -WaitSeconds 120 -CaptureSeconds 15

看到 READY 後，再讓手機維持背景／鎖屏並傳送一則新的 Telegram。不要先點通知開啟 App。腳本最多等候 120 秒；第一個可辨識新事件到達後再收集 15 秒，自動結束並產生報告。捕捉多個事件時按短碼分組，但一次一個新事件最容易判讀。不需重測震動模式、修改音量、重新安裝或配對。

如果裝置顯示 unauthorized/offline，腳本不會替使用者授權、重新連線或變更裝置；先由使用者確認 ADB 連線再執行。ExecutionPolicy Bypass 只套用這次 PowerShell 子程序，不變更永久設定。

## 產物

每次建立獨立目錄 `artifacts/phase3/audio-live/<UTC時間>-<隨機碼>/`：

- `logcat-raw.txt`：保留收到的原始文字行，限定 WNotice 與 AS.HardeningEnforcer 兩個 tag；不是全手機 logcat。StreamWriter AutoFlush 每行立即寫入主機檔案，不等事件結束或報告產生。不會清除手機 Logcat。跨 ADB／logd／OS 的傳輸緩衝或斷線仍可能丟資料。
- `logcat-stderr.txt`：Logcat 結束後的 ADB 錯誤輸出。啟動前就失敗時可能尚未產生此檔，原因改見 captureErrors。
- `report.json`：事件裝置 epoch/UTC 時間、FCM、focus 回傳值及 snapshot、FGS_PROMOTED、PLAYER_STARTED、同 UID 的 Hardening 日誌候選、AppOps 歷史候選、每次取樣耗時／狀態／缺失原因。
- `summary.txt`：結束原因與判讀限制，詳細證據以 JSON 及原始行為準。

既有 APK 只輸出 eventId 前 12 碼。因此工具能自動關聯「觀察到的事件短碼」，不能還原完整 64 碼 ID；極低機率的短碼碰撞亦不能完全排除。

## 擷取流程

1. 以有逾時的唯讀命令取得 App UID、手機 epoch 秒。
2. 以 `logcat -b main -b system -b crash -v epoch -T 1 WNotice:V AS.HardeningEnforcer:V *:S` 開啟持續串流，不以 PID 過濾，避免程序退出或重啟後丟失日誌。
3. 每行先保存，再處理。FCM_RECEIVED、FGS_PROMOTED、AUDIO_FOCUS 自動以事件短碼＋階段去重觸發取樣；沒有看到 FCM_RECEIVED 但看到其後階段時仍可開始收集。
4. 同一批非同步讀取程序 dumpsys、FGS dumpsys、AppOps dumpsys；同時最多一批三個子程序，後續階段排隊，避免無限制啟動 dumpsys。等待取樣時主迴圈仍讀取 Logcat。
5. 系統輸出在記憶體篩選，僅保存本 App 程序 scalar、FGS/WIU reason scalar、同 UID 的狀態／音訊焦點評估歷史。完整 dumpsys 不落地，避免 Intent 或通知物件內容。原始雙 tag Logcat 本身不做修改；分享前仍應自行檢查，其 Hardening tag 可能含其他 App 的 UID/clientId。
6. 取樣有 8 秒逾時。結束時未完成／未啟動的工作會明確列出，不把缺資料填成 capability=0。

`-T 1` 可能帶入一行 backlog；手機 epoch 秒用於排除較舊觸發。邊界只有秒精度，同秒內舊訊息仍可能無法區分，所以必須等 READY 才傳送新事件。手機時間跳變、未能讀取手機時間、logcat 非預期格式會影響自動觸發；讀不到手機時間時不以 backlog 觸發，最終報告說明原因。原始串流仍保存。

## FOREGROUND_AUDIO_CONTROL 證據的能力與界線

工具**可保存系統實際有輸出的證據**，不能要求系統產生不存在的資料，也不能以 ADB 原子地讀取 requestAudioFocus 當下的 capability。

- `samples` 的 process/services 是非原子快照：有 host `startedAtUtc`、`finishedAtUtc`、`durationMs`。實際裝置取樣點在此區間內，另受 ADB 傳輸及主機／手機時鐘差影響。服務幾十毫秒結束，dumpsys 卻可能花數百毫秒至數秒，故極可能只有事後值。
- AOSP Android 15 的 `FOREGROUND_AUDIO_CONTROL` 是 0x40，文字摘要中的 A。`LCMNFUA` 包含 A；`-------` 的事後快照不證明焦點申請時沒有 A。
- 最有用的是 `appOpsUidHistoryCandidates` 中同 UID、相同裝置時間附近的 `EVAL_FOREGROUND_MODE code=TAKE_AUDIO_FOCUS capability=... result=...`，配合原始焦點日誌與 Hardening 拒絕紀錄。它沒有 eventId，因此只標示候選歷史，不自動宣稱精準屬於某一事件。
- 空的 AppOps 候選可能代表 OEM/版本沒有輸出、歷史已覆寫、不同 dump 格式、UID 未取得或命令失敗；**不代表 capability 不存在**。Logcat 有明確 tag/priority/buffer 選擇，但 ASUS 未輸出的內部狀態、被系統抑制的日誌仍無法取得。
- `requestTimeForegroundAudioControl` 預設維持 UNKNOWN。只有人工確認歷史評估與請求時間、UID、前後因果一致，才可以提出「此次請求疑因缺少 A 被拒」的結論。AppOps raw=4 仍只是 MODE_FOREGROUND，不能當作最終拒絕結果。
- 若 Logcat 持續有資料而 AppOps 歷史仍空、FGS 也已退出，可能已達一般 ADB 可見性上限；單靠此工具不能證明實機是否授予當下資格。不能把提高輪詢頻率或延長服務當成真實證據，也不以固定延遲修改播放器。

## 本機合成測試

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-WorkNoticeLiveDiagnostics.ps1
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-WorkNoticeLiveTransport.ps1

第一份測試使用離線原始行／系統欄位 fixture，包含空日誌、不同事件隔離、缺歷史、舊 backlog、事後 capability 不誤判，以及完整 Replay 產檔。

第二份以本機 .NET Framework csc 編譯 mock transport，僅在隔離子程序把 SDK 路徑指向 workspace 裡的 mock adb.exe，不執行真實 ADB。模擬 FGS 35ms 內退出、dumpsys 耗時至少 1200ms，確認日誌仍保存、焦點結果未丟失、樣本有耗時、UNKNOWN 不變、測試自動完成。此 mock 與其報告完全不代表手機驗收。

截至本輪：Windows PowerShell 5.1 的 21 項 parser/replay/syntax 檢查及 6 項 mock transport 檢查通過。未自行執行實體手機診斷；不產生新版 APK。

官方參考：[Logcat buffer、格式及權限](https://developer.android.com/tools/logcat)、[AOSP AppOps UID 狀態評估與歷史](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/android15-release/services/core/java/com/android/server/appop/AppOpsUidStateTrackerImpl.java)。
