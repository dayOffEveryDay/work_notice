# Work Notice Android 0.4.1

## UI 與設定

首頁保留工作警報三態、台灣時間預約開始時刻／剩餘時間、立即啟用／預約／結束監控，以及精簡Windows與鎖屏警報摘要。異常時顯示設定修復入口；有未確認命令才顯示重試。有鈴聲時，全頁共用「停止目前鈴聲」按鈕，與結束監控分開。

設定以獨立SettingsActivity導航至裝置與配對、通知與警報、Windows監控、測試與診斷四個分類。配對碼、FCM登錄、通知頻道、音量／勿擾／背景限制、離線提醒及測試聲音都移到設定。解除配對與結束監控有確認對話框。

SettingsActivity沿用既有MainActivity命令控制器與同一XML的獨立可見分類，避免複製設定API／重試邏輯；首頁的詳細面板為GONE，不出現在可見或無障礙內容。新增日間／夜間主題，以ScrollView、彈性寬度與系統insets容納較小螢幕。

## FSI 偏好與安全邊界

- 持久全螢幕偏好與系統授權、目前期間宣告分開保存／顯示。升級後可在「通知與警報」明確確認及儲存偏好。
- 偏好開啟時，建立新IMMEDIATE／SCHEDULED會在原設定確認流程中明示全螢幕用途並檢查系統授權，不需另按每期宣告按鈕。後端確認後仍由既有MonitoringStore原子綁定新的session/revision。
- 偏好關閉時，新的監控確認畫面會明示只保留一般警報／備援，不擅自開啟全螢幕偏好。Worker的非OFF命令原本要求urgentConsent=true，因此每次仍明確確認工作事件須立即處理；本機FSI偏好另行決定是否可用FSI，沒有改Worker契約。
- 關閉偏好會阻擋稍後到達的期間宣告重新啟用FSI，不停止當前鈴聲，也不等同結束監控。
- 設定頁明確同意後，可為已確認的目前期間宣告用途；未有期間時只保存偏好。未知或舊版本宣告不會直接套到新期間。
- 預約到點不改revision、不清除宣告、不主動響鈴。
- 首頁就緒需配對憑證可讀、目前期間資格、系統FSI授權及通知條件同時成立；這是目前本機條件，不能保證FCM及OEM一定即時送達。

沒有修改Worker、D1、Secrets、FCM接收服務、FsiAlarmActivity、AudioFocusStartup、AlarmPlaybackService或播放器。沒有安裝手機、重新配對或清除資料。

## 修改檔案

- app/src/main/java/com/worknotice/alarm/MainActivity.java
- app/src/main/java/com/worknotice/alarm/SettingsActivity.java（新增）
- app/src/main/java/com/worknotice/alarm/FsiPreference.java（新增）
- app/src/main/java/com/worknotice/alarm/FsiSettings.java（僅偏好資格閘門）
- app/src/main/res/layout/activity_main.xml
- app/src/main/res/values/styles.xml、values-night/styles.xml（新增）
- app/src/main/AndroidManifest.xml
- app/build.gradle.kts（versionName0.4.1／versionCode9）
- app/src/test/java/com/worknotice/alarm/Ui041Tests.java（新增）

## 本機重現

最終結果：assembleDebug／testDebugUnitTest／lintDebug均BUILD SUCCESSFUL；152項測試，0失敗（原145項及新增7項）；Lint 0 errors／79 warnings。沒有使用baseline隱藏錯誤；警告包含既有及新增的硬編碼文字、版面／可及性與同步偏好寫入等項目，仍待後續整理。

交付APK：C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.4.1-debug.apk。

SHA-256：E279242A026779272CEA3B9F6E9BAF4E2386A8A2CC9DAF73FC4D6061FE00C3C3。

apksigner verify通過，簽章SHA-256 f3b7cf2584830e61494aa0da14ed7ce28c9458e1d7f06c66f3be0dbd33674766，與前版相同。尚未安裝手機。

建置紀錄：artifacts/phase3/android-0.4.1-final.log；測試及Lint報告位於android/WorkNoticeAndroid/app/build/reports/。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
    .\android\WorkNoticeAndroid\gradlew.bat -p android\WorkNoticeAndroid assembleDebug testDebugUnitTest lintDebug --no-daemon

測試新增首頁隱藏詳細面板、設定分類導航、偏好持久化、新期間綁定／未知期間失效、關閉偏好阻擋延遲宣告、偏好不捏造權限、小螢幕night配置載入及解除配對取消確認。原有收訊／FSI／焦點／播放／停止／監控邏輯測試一併執行。

## 手動驗收（尚未操作手機）

1. 同簽章覆蓋更新後確認配對仍在、設定分類可返回首頁；不需要重新配對。
2. 儲存全螢幕偏好後，連續建立兩個新預約，每次只走監控確認，檢查session/revision已重新綁定、到點不響，新訊息才響。
3. 手動停止後新事件仍可響；結束監控不會停止已在播放的鈴聲，後續新事件不響。
4. 關閉偏好、撤銷FSI權限或停用通知頻道，首頁不得顯示就緒，備援維持；重新開啟需正確確認／授權。
5. 網路失敗顯示未確認，離線提醒儲存失敗不得當成功；Windows無Heartbeat／資料陳舊時應顯示未知／警告。
6. 實機小螢幕、橫向、放大字體及深色模式逐頁檢查。Robolectric配置測試不能取代實際像素與ASUS鎖屏驗收。

本版不強制調整音量／勿擾，不繞過背景或全螢幕權限限制；既有Google Play全螢幕用途政策風險仍存在。
