# Work Notice 0.4.0 本機交付審查

本版為「預約開始接收工作警報」，不是倒數到期關閉。未部署 Worker、未套用正式 D1、未修改 Secrets、未操作手機、未移除 App 或清除配對。本文件先供程式與測試審查；正式部署與實機驗收另行安排。

實際 APK、雜湊、114 項 Worker／145 項 Android 測試及 Lint 結果見 [驗證紀錄](WORKNOTICE-0.4.0-VERIFICATION.md)。帶既有資料的 0002 → 0003 升級測試已補齊，B1 已解除；完整證據及回滾限制見 [B1 驗證報告](WORKNOTICE-0.4.0-B1-VERIFICATION.md)。

## 已實作的狀態與時間規則

| 模式 | 後端依 serverNow 計算的狀態 | 工作事件 |
|---|---|---|
| OFF | OFF | 不建立新工作推播 |
| IMMEDIATE | ACTIVE | 只接收本次開始時間以後的新事件，直到手動結束 |
| SCHEDULED，未到 starts_at_ms | SCHEDULED | 不建立工作推播，不排隊等待啟用 |
| SCHEDULED，已到 starts_at_ms | ACTIVE | 新事件才可推播；到點本身不產生通知或 FSI |

「預約等待中」與「工作警報啟用中」是同一份設定依時間推導，開始時不修改 revision 或 session，不執行啟用 Cron，不喚醒 Activity、不主動送推播。原有 Cron 保留 Heartbeat／離線狀態維護、既有工作重試與清理；不負責預約狀態切換。

Windows 需已處於監控中，維持既有 UTC 事件上傳，不由手機遠端開啟 Windows 監聽。Windows Agent 與手機監控狀態分區展示；沒有 agent／Heartbeat 時顯示 UNKNOWN，不以手機 ACTIVE 假造 Windows 在線。

## 0003 Migration

檔案：cloudflare/work-notice-api/migrations/0003_scheduled_activation.sql。

- monitoring_settings：device_id PK、owner_mobile_id、mode、starts_at_ms、session_id、revision、urgent_consent、last_command_id、updated_at_ms。
- monitoring_commands：以 device_id/command_id 唯一，保存 mobile_id、request_hash、expected_revision、模式、原開始時間、原 session、用途確認、建立時間、applied_revision。
- push_jobs：加 monitoring_session_id、monitoring_revision、occurred_at_ms；舊工作欄位為 NULL，舊端行為保留。
- apply_monitoring_command trigger：在命令 INSERT 的同一交易做條件式 CAS、記錄成功版本、關閉 legacy projection、永久作廢舊工作。
- **CAS 零筆更新不等於交易失敗**：失敗命令的 applied_revision 為 NULL；所有副作用均以該命令有 applied_revision 且真正勝出為條件，API 回 409。失敗命令不更動設定、不取消勝出者的工作。
- 重建 enqueue_mobile_alert 以綁定原事件時間與監控期間；舊版條件仍可運作。
- protect_monitoring_legacy 防止採用新模型後舊端重新開啟 legacy projection；新路由也有條件式寫入與零筆回 409 防護。
- revoke_monitoring 在手機憑證撤銷時關閉該手機的期間、遞增版本並作廢待送工作。

既有檔案未修改，SHA-256：

- 0001_init.sql：F2CEE7B6A0D6AF65E76D3C13F3E0B91B52DCD2C2B1221D03A90E2A87B023E3C9
- 0002_android_fcm.sql：CB3D2F152275FA336AD7C9B5A78CB87546D6A7D4D61E700FEDAFFC9824B6D067
- 新 0003：65FAA1A1817E051E2E58D814065A5DD0B5A95A707BDB63B0F3412618F9FDD303

本機驗證使用隔離的 Miniflare D1 及 Wrangler --local --persist-to 測試資料夾，套用全部 Migration，檢查表、索引、約束、重複套用與資料保留。沒有使用 --remote。

## API 範例

沿用手機既有 Bearer 認證，APK 不加入 ADMIN_API_KEY 或 Windows HMAC Secret。所有 SQL 使用 prepared statements。

GET /api/mobile/monitoring：回傳 serverNow、pairedAt、monitoring。尚未採用時為 OFF/revision0，GET 不會改資料庫。

八小時後開始，PUT /api/mobile/monitoring 的 JSON：

    {"commandId":"11111111-2222-4333-8444-555555555555","expectedRevision":0,"mode":"SCHEDULED","delayMinutes":480,"urgentConsent":true}

示例回應（數字用於說明，session 應為實際隨機 64 碼）：

    {"serverNow":1793640000000,"pairedAt":1793630000000,"monitoring":{"mode":"SCHEDULED","starts_at_ms":1793668800000,"session_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":1,"urgent_consent":1,"last_command_id":"11111111-2222-4333-8444-555555555555","updated_at_ms":1793640000000,"state":"SCHEDULED"}}

立即啟用：相同欄位，mode=IMMEDIATE、delayMinutes=0、urgentConsent=true。starts_at_ms 由 Worker 接受命令的可信時間產生。

結束監控：新 commandId、expectedRevision 為目前版本、mode=OFF、delayMinutes=0、urgentConsent=false。回應新 revision、OFF、starts_at_ms=null。

命令重試需完全保留原 commandId／內容／expectedRevision；回傳原 session、原開始時間與原成功 revision，不因重試延後八小時。重用 ID 但內容不同回 409 command_reused；版本衝突回 409 revision_conflict。改預約或建立新期間必須用新 ID 與目前版本。Android 不以較舊回應覆蓋較高版本。

App 輸入為 1 分鐘～24 小時；後端支援 1～10080 分鐘。未接受前若網路中斷，不宣稱已建立預約。首次真正被後端接受時才決定開始時間；一旦接受，之後重試不再改變。

## 事件／FCM 防護

1. alert_events 入庫時，以 Worker 收到時間及 Windows occurredAt 同時比較 starts_at_ms，搭配既有 120 秒新鮮度限制。不符合只保存事件，不建推播、不在開始後回補。
2. 入庫與 push_jobs 期間綁定在同一 SQLite 交易。新設定勝出時將舊 PENDING/RETRY 工作永久 EXPIRED。
3. dispatchPush 查目前 owner/session/revision/start；OAuth 完成、實際 FCM HTTP 前再查一次，避免取得 token 期間的設定變更漏網。
4. 推播 TTL 仍以原通知與 Worker 收到時間的較早期限限制為最多 120 秒，不把等待預約的時間加到 TTL。
5. FCM 新資料包含 monitoringSessionId、monitoringRevision、monitoringStartsAtMs、monitoringMode、monitoringCommandId、occurredAt、serverNowMs，保留既有 eventId/issuedAt/expiresAt/type。
6. Android 收到後驗證確認期間、版本、來源時間、到期、時鐘範圍及本機停止；不因收到舊推播恢復監控。事件 ledger 與排隊服務啟動、FSI／手動補救亦重查期間資格。

外部 FCM HTTP 與 D1 無法組成同一交易；取消若恰好在最後檢查後才發生，已送出的 FCM 不能撤回。本機結束 tombstone 仍立即阻擋晚到工作。同手機的取消不依賴接收「取消推播」才生效；遠端撤銷與已傳輸推播的極短競態不能承諾零風險。

本階段「事件時間」是既有 Windows UserNotificationListener 通知 CreatedAtUtc，不是 Telegram 服務端訊息原始時間。Windows UTC 必須正常；簽章不保證來源時鐘準確。未讀取／保存 Telegram 本文，也不以內容猜測緊急程度。

## Android、FSI 與恢復

首頁三態、台灣開始時間、剩餘時間，操作為立即／預約／結束。停止當前鈴聲是另一個按鈕；結束監控不停止已在播放的警報。

設定 ON 模式前先顯示明確緊急用途確認；未授權 FSI 時開官方設定頁，**不提交預約**，需使用者完成權限後重新送出。用途確認先隨 pending command 持久化，後端確認設定時，Root/session/revision 與 FSI 宣告綁定在同一次 SharedPreferences commit，避免中途被殺程序遺失宣告。FSI 既有通知機制、Activity 可見性、Audio Focus 與循環播放流程沿用，不改成背景直接 startActivity。

預約等待時 FSI 顯示「已準備」，到點不清除宣告。不把舊 effectiveEnabled=false 當成要刪除預約用途；新的主動改期／配對／版本才使舊宣告不適用。若程序在 HTTP 成功回覆前被終止，重開可讀回確認；第一筆 FCM 亦僅可根據**完全相符、已事前確認的 pending command**恢復該期間，不採信無對應意圖的新設定。

OFF 在本機先持久化 tombstone。未確認時 UI 明確標示「本機已結束；後端取消尚待確認」；WorkManager 在網路可用時以同命令重試，另可手動重試。409 不盲目改寫版本：讀回最新資料、保留停止，需使用者再次明確結束／設定，才用最新版本建立另一命令。重按同版本 OFF 仍重用原命令。

### 可保證的邏輯與系統限制

- 已確認設定／期間／宣告／停止在檔案中保存，不依賴 Java 靜態記憶體。一般程序被系統回收或 App 重開，能重新讀取，不重算八小時。
- 同次開機用後端校時加 elapsedRealtime；手機重啟後用先前已確認的後端與系統時鐘差估算時間，不因 bootCount 改變就永久停用已確認期間。新通知 ledger 使用當次開機世代。
- 重啟後要能自動工作，需裝置時鐘合理、使用者至少解鎖過一次以取得 credential-encrypted 設定與 Keystore、Google Play Services／FCM 可用。未加入 Direct Boot 警報功能，不能保證首次解鎖前響鈴。
- 手機重啟後若時鐘偏差超出事件時間容許範圍，採 fail-closed；開 App 成功同步可重新校時，設定不會因此被刪除。無法在無網路且時鐘不可信時同時保證正確新鮮度與必定響鈴。
- 強制停止 App、未授權或被撤銷 FSI、重要通知頻道關閉、Doze／OEM 管制、FCM 延遲／降權仍可能失敗。普通背景回收與使用者 force-stop 不同。已通過的是本機邏輯，不等於 ASUS 真實重啟／八小時實測通過。
- 未鎖屏沿用 Android heads-up 行為；既有 FSI 的 Google Play 用途／特殊授權風險仍適用。

## 相容性與部署順序（尚未執行）

Migration 先增加新結構，沒有新模型資料的裝置仍走舊 TIMED/UNTIL_MANUALLY_DISABLED API。第一次成功寫入新監控命令即採用新模型、把 legacy projection 設為 disabled；之後舊 Android／admin 設定寫入回 409，不能繞過新期間。舊 mode 不被重新解釋成預約。

0.4.0 Android 需要新版 Worker／Migration；**審查後須先完成後端再更新 APK**。若先裝 APK，監控 API 會 404，會顯示錯誤／未確認，不能假裝支援預約。新 App 拒絕沒有期間資訊的 WORK_ALERT，不把舊推播放入新期間。配對、token 與認證介面保留，不需要重新配對。

正式階段另行授權後建議順序：

1. 備份與檢查正式 migration 清單／舊檔雜湊、D1 現有結構。
2. 套用 0003；先不建立新監控期間，驗證舊路徑仍正常。
3. 部署此版 Worker，驗證健康、舊端、認證、新 GET 與 CAS／取消。
4. 更新手機 APK（install -r，簽章相同，不刪資料），確認既有配對後讀回新監控狀態。
5. 由使用者首次建立預約、完成用途／權限確認，再做短時間及八小時實測。

已採用新模型後回滾到舊 Worker／APK 不能假定新監控繼續運作；legacy projection 故意維持 OFF 以免誤響。不要刪表、回寫舊 Migration 或清配對當作回滾方式，需另訂受控回滾計畫。

## 本機重現指令

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    . .\scripts\Use-LocalNode.ps1
    npm test
    npm run test:local

npm test 含 tsc、純本機 esbuild 測試打包、Miniflare 與隔離 Wrangler local D1 測試，不會呼叫 wrangler deploy（也不呼叫 deploy --dry-run）。test:local 使用全新 persist-to、啟動本機 Worker，驗證 health、env.DB 與原 Cron 重複呼叫去重。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
    .\android\WorkNoticeAndroid\gradlew.bat -p android\WorkNoticeAndroid assembleDebug testDebugUnitTest lintDebug --no-daemon

## 測試與審查範圍

Worker 全部 114 項通過（原有86項，加上B1的27個子測試及1個父測試），含舊版 HMAC、事件去重、Heartbeat、配對、OAuth／FCM、離線提醒、預約／交易／發送檢查。B1 在只有0001、0002的隔離本機D1填入合成資料，再由Wrangler --local套用0003，逐表比對內容、PK、索引、約束及解密結果；也以凍結的本機舊Worker bundle驗證相容性及回滾限制。沒有對正式環境做測試。

Android 最終項數、Lint 與 APK checksum 見隨附交付驗證紀錄。測試包括預約前／後與過期事件、到點無通知、取消／改期、命令恢復與版本衝突、舊 FCM、程序重建／bootCount 變更、原子宣告、FSI 等待有效性、手動停止與結束區分，以及原有 FSI／焦點／通知／補救回歸。

實機仍待授權後驗收：2 分鐘預約到點無聲、下一筆新訊息才響、開始前一秒延遲事件不響、結束後晚到推播不響、普通程序回收、重啟並解鎖但不重開 App、網路失敗／取消衝突、八小時鎖屏、手動停止後新事件，以及未鎖屏與 FSI 拒絕的備援。

## 修改檔案清單

Worker：
- migrations/0003_scheduled_activation.sql（新增）
- src/monitoring.ts（新增）
- src/mobile.ts、src/index.ts、src/fcm.ts
- scripts/migrations.mjs、tests/schema.test.mjs、tests/monitoring.test.mjs（新增）

Android（app/src/main/java/com/worknotice/alarm）：
- MonitoringStore.java、MonitoringClient.java、MonitoringStopWorker.java（新增）
- MainActivity.java、AlarmPreferencesRepository.java、PairingRepository.java、FsiSettings.java
- WorkNoticeFirebaseMessagingService.java（新增期間入口驗證）
- PendingAlarmStore.java、AlarmPlaybackService.java（僅新增排隊入口資格，不改播放／焦點演算法）
- RingActionActivity.java（補救改查新監控資格，保留原開啟方式）
- AlarmModeUi.java、app/src/main/res/layout/activity_main.xml、app/build.gradle.kts
- app/src/test/java/com/worknotice/alarm/MonitoringTests.java（新增）、AlarmSettingsTests.java（更新新 UI／API fixture）

文件／交付：本文件、驗證紀錄、Android README、APK/checksum。Windows C#、已驗證的 FsiAlarmActivity、Notices、AudioFocusStartup、既有 Migration 與 Secrets 未修改。
