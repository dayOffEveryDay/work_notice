# 0.3.4 本機交付驗證

- 執行 `gradlew.bat -p android/WorkNoticeAndroid assembleDebug testDebugUnitTest lintDebug --no-daemon`：BUILD SUCCESSFUL。
- 98 項單元測試、0 failures、0 errors；原有 76 項維持通過，新增 FsiTests 22 項。涵蓋預設關閉、期間版本綁定、接收時緊急資格、一次 FSI、不可變 PendingIntent 與來源區分、認領互斥、停止／到期／換配對／關閉後拒絕、可見前不啟動、失敗後只留手動重試、頻道設定保留及 ACK 固定分類。
- Android Lint：0 errors、50 warnings。尚存警告主要是既有及新增原生 UI 的 HardcodedText/SetTextI18n、同步 SharedPreferences commit、Autofill 及依賴版本建議；未關閉 Lint、未加入 baseline 掩蓋錯誤。
- APK：`artifacts/phase3/WorkNoticeAndroid-0.3.4-debug.apk`，4,751,990 bytes。
- APK SHA-256：`C9BEEA5785F267E0561356DB2C7AD380924CF97473BAD5457CAB96A802E0B3A6`。
- aapt 確認 package `com.worknotice.alarm`、versionName 0.3.4、versionCode 5、minSdk26、targetSdk37。
- apksigner verify 通過。0.3.3／0.3.4 debug 憑證 SHA-256 同為 `f3b7cf2584830e61494aa0da14ed7ce28c9458e1d7f06c66f3be0dbd33674766`，符合保留資料更新的簽章條件；未實際執行 adb install。
- 測試環境：Android Studio JBR 25.0.4、Gradle9.4.1、AGP9.2.1、本機 SDK37；未操作手機或正式雲端，未改 Windows 或 Worker 程式。

結果僅證明本機組建、Robolectric／單元測試及靜態檢查通過。Robolectric 不會驗證 ASUS 的通知系統選擇、真正 Audio Focus 或實際揚聲器響鈴；須依 [0.3.4 驗收指南](PHASE3-ANDROID-0.3.4-FSI.md) 測試鎖屏、熄屏、未鎖屏與拒絕 FSI。此版本不是已實機證實的修復。

完整結果：`android/WorkNoticeAndroid/app/build/reports/tests/testDebugUnitTest/index.html`、`android/WorkNoticeAndroid/app/build/reports/lint-results-debug.html`。
