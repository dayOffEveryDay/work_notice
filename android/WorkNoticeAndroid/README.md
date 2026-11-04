# Work Notice Android（第三階段）

0.4.0 改為後端可信時間的「預約開始監控」，支援 OFF／IMMEDIATE／SCHEDULED、期間版本、命令冪等、預先完成 FSI 宣告、取消同步及重啟恢復。需先審查並完成新版 Migration／Worker，勿先安裝正式手機。見 [0.4.0 審查文件](../../docs/WORKNOTICE-0.4.0-REVIEW.md) 與 [本機驗證](../../docs/WORKNOTICE-0.4.0-VERIFICATION.md)。

0.3.5 修正倒數空欄解析與操作回饋、加上儲存防連點及頂部真實模式／剩餘時間卡片。沿用已驗證的 FCM、FSI 與播放器流程，見 [倒數修正、驗證與安裝指南](../../docs/PHASE3-ANDROID-0.3.5-COUNTDOWN.md)。

0.3.4.1 只修正 FSI 設定狀態、原因診斷及按鈕文字，保留原 enabled 判斷條件與警報流程；見 [FSI 狀態修正說明](../../docs/PHASE3-ANDROID-0.3.4.1-FSI-STATUS.md)。

0.3.4 為「鎖屏 Full-screen Intent 實驗版」，預設關閉，需明確宣告目前工作事件為緊急用途並取得系統特殊存取授權。保留 0.3.3 全部主路徑；沒有保證鎖屏或未鎖屏自動響鈴。修改清單、保留配對安裝、FSI 授權、四種實機驗收與 Google Play 風險見 [0.3.4 FSI 指南](../../docs/PHASE3-ANDROID-0.3.4-FSI.md)。

0.3.3 的震動模式／前景／背景／鎖屏四組唯讀診斷、PowerShell 指令與依結果決定的最小修改方向，見 [震動模式驗證方案](../../docs/PHASE3-ANDROID-VIBRATE-VALIDATION.md)。這輪沒有修改 APK 或播放器。

0.3.3 保留自動持續響鈴主路徑，改善通知聲音／震動預設與「開啟並響鈴」一次性前景補救。比較矩陣、唯讀 ADB capability 指令、風險與保留配對安裝見 [備援改善指南](../../docs/PHASE3-ANDROID-RECOVERY.md)。尚未宣稱解決 Android 15 背景音訊資格拒絕。

0.3.2 的 FGS 提升／Android 15 Audio Focus 調查、明確診斷欄位、合法 delayed-focus 與保留配對安裝見 [音訊焦點指南](../../docs/PHASE3-ANDROID-AUDIO-FOCUS.md)。targetSdk 仍是 37；不宣稱已突破手機系統的背景音訊限制。

0.3.1 修正背景／鎖屏 fallback 被清除及 STOPPED 語意，新增安全 WNotice Logcat。保留配對的更新安裝、實機指令與本機測試範圍見 [鎖屏修復指南](../../docs/PHASE3-ANDROID-LOCKSCREEN-FIX.md)。本輪不需 Cloudflare／D1／Secrets 變更。

Java + 原生 XML App，來源為 `app/src/main/java/com/worknotice/alarm`。Firebase 專案 **work-notice-7a5e8**、applicationId **com.worknotice.alarm**，已從 Downloads 的實際 `google-services.json` 核對並複製到 `app/google-services.json`；檔案列入忽略清單。沒有將管理金鑰、Windows HMAC 金鑰或服務帳戶放進 APK。

## 在 Android Studio 開啟

1. File → Open → 選擇 `C:\Users\HowardLu\工作鬧鐘\android\WorkNoticeAndroid`，不要選 Windows solution 或 `app` 子目錄。
2. Gradle JDK 選 Android Studio 的 Embedded JDK（本機 JBR 25.0.4）。使用專案 Gradle Wrapper **9.4.1**、AGP **9.2.1**，SDK Manager 安裝 Android SDK **37.0** 與 Build Tools **36.0.0**。minSdk 26、target/compileSdk 37，Java source/target 17。
3. 等待 Gradle Sync。若其他電腦沒有 JSON，把 Firebase Console 同一 Android App 的檔案放到 `app/google-services.json`。package 必須完全相同；不要另外註冊或假造 JSON。缺檔時 Debug 可組建，但 UI 明確顯示 Firebase 未設定，不能收真正 FCM。
4. USB 連接有 Google Play Services 的 Android 8+ 手機，啟用開發人員選項與 USB 偵錯，選 `app` → Run。第一次安裝允許通知，再確認 Work Alerts 及警報播放中通道沒有被關閉。
5. 先按「只測本機聲音」確認聲音與停止按鈕；這個按鈕完全不驗證 Telegram、Worker、D1 或 FCM。

PowerShell 建置（只有本機建置／測試，不呼叫正式 API）：

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/android/WorkNoticeAndroid'
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
./gradlew.bat assembleDebug testDebugUnitTest lintDebug --no-daemon
```

APK：`app/build/outputs/apk/debug/app-debug.apk`。測試：`app/build/test-results/testDebugUnitTest/`；Lint：`app/build/reports/lint-results-debug.html`。Debug 簽章僅供開發，不是 Play Store 正式簽章。

中文工作區設定保留 `android.overridePathCheck=true`。Gradle daemon 使用 `file.encoding=COMPAT`，讓 Windows @classpath 引數檔與原生 MS950 相符；JavaCompile 明確使用 UTF-8，避免先前測試執行器找不到中文路徑下 class 的問題。不必移動 Windows 專案或更改系統地區設定。

## 配對及操作

正式 migration、FCM Secrets 與 Worker 更新由使用者依 [部署指南](../../docs/PHASE3-DEPLOYMENT.md) 操作後，管理電腦執行 `New-MobilePairing.ps1`，將有效五分鐘的一次性配對碼輸入 App。App 不要求 ADMIN_API_KEY。

- 新配對預設關閉未來警報。啟用前確認「FCM token 已登記」，再選持續啟用或倒數啟用。倒數範圍 1～1440 分鐘，`2 小時 30 分鐘`是 150 分鐘。
- Worker 決定 UTC 到期時間；手機把伺服器時間差換成 monotonic elapsedRealtime deadline。手機重開機後先停用接收快取，直到成功重新同步，避免錯誤延長倒數。畫面每秒更新剩餘秒數；沒有精確鬧鐘權限。
- **停止目前警報**只處理目前 session，釋放 MediaPlayer 與音訊焦點、移除播放通知並送 STOPPED Ack，完全不改未來接收設定。通知上的停止按鈕使用同一邏輯；舊 session Intent 不能停止新 session。
- **關閉未來警報**與倒數到期不會停止已經開始的響鈴。關閉操作立即停用本機快取；API 失敗時必須重試，才能確認伺服器也已關閉。伺服器關閉後，尚待送出的工作永久到期，重新啟用不復活舊工作。已送到 FCM／正在傳送的要求無法收回。
- 收到新事件先檢查配對、時間、持久化 eventId ledger 與快取開關；同一事件不重響，多事件共用單一播放器並合併計數。停止後新的 eventId 可再響。
- 離線提醒是一般通知，可獨立開關；儲存離線提醒不重設倒數。恢復不另送推播，按重新整理查看新狀態。狀態超過 90 秒會標示舊資料，手機所有事件／心跳／到期時間使用 Asia/Taipei。
- token 更新與 ACK 用 WorkManager 的持久化工作、網路條件與指數退避（15 秒起，最多 9 次嘗試）；token 每次重新向 Firebase SDK 取得最新值。4xx（408/429 除外）停止重試。手機 bearer 由 Keystore AES-GCM 保護，備份及裝置搬移排除私有資料。
- 取消配對需伺服器確認撤銷後才清除本機身分。遺失手機、解除安裝或配對成功回應遺失，管理者先執行 Revoke 再重新配對；原 bearer 不可取回。

## 背景及鎖屏限制

Android 13+ 需使用者授予 POST_NOTIFICATIONS；通道、警報音量與勿擾均由使用者控制。App 不申請精確鬧鐘、全螢幕 Intent、無障礙或電池白名單權限。API 35+ 先進入 mediaPlayback 前景服務再要求音訊焦點，系統搶走焦點時暫停聲音。

FCM 的 HIGH 是要求而非即時保證。Doze、省電、OEM 背景管理、缺少 Play Services、沒有網路、通知未授權、強制停止 App 或系統回收，都可能延遲／阻止 callback 或聲音；延遲超過 120 秒的事件會丟棄。FCM 可能把長期沒有使用者可見通知的高優先級訊息降級，App 會檢查實際 priority。背景啟動被拒或降為一般 priority 時，顯示高重要性一般通知 fallback；若通知權限本身被拒，系統連 fallback 也可能不顯示，原因仍保存在 App 提示。fallback 不會偷偷繞過限制啟動播放器，請開啟 App 檢查並使用本機聲音測試。

滑掉最近使用列表、螢幕關閉、鎖定、手機重啟及系統回收的表現需要逐機驗收。Foreground Service 與 WakeLock 不能提供永久播放或 100% 必達保證。收到／開始播放 Ack 也不能證明使用者實際聽見。

官方依據：[FCM 優先級](https://firebase.google.com/docs/cloud-messaging/android-message-priority)、[背景 FGS 限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[通知權限](https://developer.android.com/develop/ui/views/notifications/notification-permission)、[音訊焦點](https://developer.android.com/media/optimize/audio-focus)。完整端到端矩陣見 [驗收紀錄](../../docs/PHASE3-VERIFICATION.md)。
