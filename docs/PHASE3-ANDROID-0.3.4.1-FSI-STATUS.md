# 0.3.4.1：FSI 狀態與 UI 修正

本機 `assembleDebug testDebugUnitTest lintDebug` 成功，109 項測試全部通過（原 98 項＋新增 11 項），包含 576 種原判斷式等價組合及實際 MainActivity View 狀態檢查。Lint：0 errors、48 warnings。APK 為 artifacts/phase3/WorkNoticeAndroid-0.3.4.1-debug.apk，SHA-256：99F6A0A515CA44CA24A18CB76E58E6E6F1967E94D290330F92CEEDC26B793773。apksigner 驗證成功，與 0.3.4 使用相同 debug 憑證，可用 install -r 更新；未自行安裝或實機檢查。

## 確認結果

原 0.3.4 的 UI「已宣告緊急用途」其實已呼叫 FsiSettings.enabled()，和 FCM 所用的 App 端判斷相同。沒有發現 UI 與 FCM 分別使用兩套條件；問題在於綜合狀態名稱含糊、按鈕不隨狀態改變、日誌只記錄 enabled/granted，無法解釋失效原因。

03:18 本機日誌 `fsi-0.3.4-20261103-031848.txt` 的事件 `754f166804f7` 確實為 enabled=false、granted=true。03:22～03:23 畫面顯示已宣告，依當時 UI 原始碼，代表該時刻 enabled=true。兩個時點不同，不能證明畫面與事件即時矛盾，也沒有足夠歷史資料斷言是設定儲存失敗。

## 四個概念

| 名稱 | 實際來源 |
|---|---|
| 緊急用途宣告 | 本機 fsi-v1 的 urgent 布林值。這也是實驗意願旗標，沒有另一個獨立的 enabled 開關。 |
| App 端 FSI 實驗 enabled | urgent=true、目前期間版本大於零、宣告期間等於目前期間、宣告配對世代等於目前配對、原工作警報 enabled=true 的合取結果。 |
| 系統 FSI granted | canUseFullScreenIntent() 的獨立結果。不會自動寫入緊急用途宣告，也不包含在原 enabled 的定義。 |
| 工作警報啟用期間 | AlarmPreferencesRepository.enabled()，包含配對憑證可讀、重啟世代一致、警報 enabled、倒數尚未到期。FSI 宣告另綁定 alertSetting.updated_at_ms。 |

因此系統允許但 App 未啟用是合法狀態。App 已啟用但系統未授權也可能存在：新畫面會顯示「已啟用」，同時明確說明「目前不能發送 FSI」，與既有 enabled/granted 日誌語意一致。通知頻道、事件有效性及 HIGH 優先級仍是後續獨立條件，未併入此設定狀態。

## 失效原因

- 重新按持續啟用、重新設定倒數，或其他 alert-settings PUT 更新 updated_at_ms：舊宣告失效，需重新確認。
- 一般 GET 重新整理若回傳相同 updated_at_ms，不會單憑重新整理失效。
- 倒數到期、關閉未來警報、配對世代改變、憑證不可讀或重啟後設定無效：enabled=false。
- 同步到 effectiveEnabled=false 時，既有程式會清除宣告；這項行為未更改。
- 原 consent() 沒有處理 commit() 失敗，屬可改善的防護缺口，但沒有證據證明這次實機曾發生。現在失敗會清除宣告、顯示儲存失敗，且不繼續開啟授權頁。

## 最小修正

新增 FsiStatus，集中原判斷式、未啟用原因及文字。FsiSettings.enabled()、FSI_PERMISSION 日誌與 MainActivity 都透過同一份狀態模型。保留原 enabled 真值條件，沒有把系統授權併入，也沒有放寬期間或配對限制。

主畫面會顯示：FSI 實驗已啟用／未啟用、具體原因、宣告是否儲存及適用目前期間、原警報狀態、系統授權。按鈕依狀態變成啟用、重新確認、檢查／前往授權、關閉或清除失效宣告。完全未宣告時關閉按鈕停用；已啟用時不重複寫入宣告，而是開啟系統授權頁。

日誌增加 declared、periodValid、pairingValid、alarmEnabled、alarmProblem、reasons，只輸出布林與枚舉，不輸出配對 ID、時間版本值或任何憑證。ALARM_INACTIVE 會再區分工作警報已關閉、倒數到期、設定同步／重啟失效、憑證不可讀。歷史日誌無法回填新欄位。

修改檔案：FsiSettings.java、MainActivity.java、新增 FsiStatus.java、新增 FsiStatusTests.java、補充 FsiTests.java、app/build.gradle.kts（versionCode6/versionName0.3.4.1）及本說明。Java 檔案位於 android/WorkNoticeAndroid/app/src/main/java/com/worknotice/alarm/，測試位於 app/src/test/java/com/worknotice/alarm/。

未修改 FCM、播放器、通知發送、事件 ledger、Windows、Worker、D1 或 Secrets。未操作手機。

## 更新驗證

使用交付 APK 以 install -r 更新，不解除安裝、不清資料、不重新配對。先檢查「未來工作警報」；若重新儲存啟用期間，最後才重新確認 FSI 緊急用途。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    & $adb devices -l
    $phoneSerial = Read-Host '輸入手機序號'
    & $adb -s $phoneSerial install -r '.\artifacts\phase3\WorkNoticeAndroid-0.3.4.1-debug.apk'

觀察設定狀態變化即可，不必為這次 UI 修正重測震動模式。若要比對新事件，先開始既有 Logcat，再傳送新訊息；核對相同時刻 UI 與 enabled/reasons，不拿幾分鐘前的日誌直接對照現在畫面。
