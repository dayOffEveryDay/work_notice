# Work Notice — 第三階段規格 v1.0

**目標：** Cloudflare Worker 收到 Windows Telegram 工作事件後，透過 Firebase Cloud Messaging (FCM HTTP v1) 通知 Android Java App。當手機警報接收功能啟用且訊息有效時，手機發出重複警報聲，直到使用者明確按下「停止目前警報」。同時可查詢 Windows Agent 的監控／待命／離線狀態。

**日期：** 2026-11-02  
**開發位置：** Windows 現有 `C:\Users\HowardLu\工作鬧鐘` 工作區  
**Codex 操作規則：** 保留前兩階段已驗收的 Windows Agent、既有 Cloudflare Worker 與正式 D1；所有改動先在本機 build/test。未經使用者授權，不執行正式 Worker 部署、遠端 D1 Migration、Secrets 修改、Firebase 憑證建立或任何會更改正式環境的操作。

---

## 1. 已完成的系統基礎

1. Windows C# .NET 10 WPF `WorkNoticeAgent`：使用 Windows 官方通知 API 擷取 Telegram Windows 通知，確認 AUMID `Telegram.TelegramDesktop`、監控中／待命中、去重與不補發舊通知、系統匣正常退出。第二階段增加 HMAC HTTPS `/api/alert`、每 60 秒 `/api/heartbeat`、退出回報 `STOPPED_BY_USER`、DPAPI 儲存 Windows Secret。
2. Cloudflare Worker：`work-notice-api`，正式網址 `https://work-notice-api.hui760419.workers.dev`，D1 binding `DB`，資料庫 `work-notice-db`；已有 HMAC 防重放、Alert 去重、管理設定 API、健康狀態 API 及每分鐘 Cron。
3. D1 已套用 `0001_init.sql`，包含 `agents`、`alert_events`、`alert_settings`、`request_nonces`、`agent_status_transitions` 五張業務表。
4. 第二階段實機已證明：Heartbeat 在 D1 正常、TG 事件 `ACCEPTED`、正常退出 `STOPPED_BY_USER`、強制停止後 `OFFLINE`、重新啟動恢復 `STANDBY`。
5. 已建立 Firebase 專案並註冊 Android App，使用者已下載 `google-services.json`，但還沒有把它放進 Android Studio 專案。實際 Firebase Project ID / Android package name 必須從使用者提供的 `google-services.json` 或 Firebase Console 核對，**不要自行假設**。曾建議 `com.worknotice.alarm`，若 Firebase 註冊的 package name 不同，以實際 JSON 為準。
6. 使用者已安裝 Android Studio（Rabbit2 Windows），偏好 **Java 開發 Android**。`build.gradle.kts` 可使用 Kotlin DSL 設定 Gradle，**App 程式碼仍用 Java**。

> 這是第三階段，不需要重新寫 Telegram 監聽，不需要新 D1 資料庫，不需要新的 Firebase 帳號。仍不納入 Lark。

## 2. 使用者體驗與不可變規則

### 2.1 手機警報接收開關：僅兩種「啟用」模式

- **持續啟用**：使用者手動啟用後，持續接收 *新* 工作通知的警報，直到主動關閉。
- **倒數啟用**：使用者設定小時與分鐘，例如 `2 小時 30 分鐘`（150 分鐘），從伺服器收到設定的時間起倒數，到期後停止對*新工作事件*產生警報。倒數有效時間以 Worker/D1 伺服器時間判斷，不信任手機時間。
- 使用者可隨時手動關閉未來警報。**不增加**「暫停 10 分鐘」、「稍後恢復」等預設暫停模式。
- **停止目前響鈴**與**關閉未來新工作事件警報**完全分離：按「停止目前警報」不會自動把接收開關關閉。倒數到期也不應自動停止一個已經開始、尚未被手動停止的響鈴，除非使用者明確操作。
- 第三階段以「已配對且已啟用」為必要條件；新裝置配對完成但沒有開啟警報，預設不響鈴。

### 2.2 響鈴行為

- 新鮮有效的 `WORK_ALERT` 到達且允許響鈴：播放**原創或系統可用**的警報音效、重複播放，直到使用者按「停止目前警報」。可搭配震動、顯著的持續通知、通知上的 STOP action 和 App 畫面上的大按鈕。
- 使用 Android AudioAttributes `USAGE_ALARM`、AudioFocus 與必要的 foreground service（使用合法 FGS 類型；例如可論證的 `mediaPlayback`，必須符合當前 Android 政策），不要依賴 Activity 留在前景才能持續播放。
- 若多則事件在警報已經播放時到達，不能重複開啟多個音效播放器；更新未讀警報數、合併顯示即可。重複 `eventId` 不可再觸發音效。
- 手機通知應只顯示「工作通知」等最小資訊；**不可包含 TG 訊息內容、發件者或群組名稱**。
- 自動化測試須驗證停止當前響鈴時音效停止、通知狀態同步，**未來接收開關仍然開啟**。
- 不應繞過使用者的通知權限、靜音/勿擾、或 Android 系統限制；若權限不足需引導使用者設定，並揭露可能無法即時響鈴。Android 背景啟動、手機省電與 FCM 高優先級並非 100% 即時保證。

### 2.3 Windows 健康狀態

Android 首頁顯示：
- Windows 最後回報模式 `MONITORING / STANDBY / STOPPED_BY_USER / OFFLINE / DEGRADED / UNKNOWN`。
- `listenerStatus`、`notificationPermission`、`lastSeenAt`（手機顯示台灣 UTC+8，服務端用 UTC）。
- 待命中仍有 heartbeat，**不能把 STANDBY 誤判成 OFFLINE**。
- 對非預期離線 `OFFLINE` 提供**一般警示通知**（非預設無限循環警報），與 TG 工作事件響鈴分開，可配置是否啟用離線提醒；主動退出不當異常。
- App 可主動重新整理 Windows 狀態；顯示資料更新時間、網路錯誤與舊資料提示。

## 3. Android Java 專案結構（建議）

```text
工作鬧鐘/
  android/
    WorkNoticeAndroid/
      settings.gradle.kts
      build.gradle.kts
      gradle/wrapper/*
      app/
        build.gradle.kts
        google-services.json        # 使用者自行放置，不要提交秘密資料
        src/main/AndroidManifest.xml
        src/main/java/<實際package路徑>/
          MainActivity.java
          WorkNoticeFirebaseMessagingService.java
          AlarmPlaybackService.java
          AlarmStopReceiver.java
          ApiClient.java
          PairingRepository.java
          DeviceTokenStore.java
          AlarmPreferencesRepository.java
          ...
        src/main/res/{layout,drawable,mipmap,raw,values}/
      README.md
```

- Java + 原生 XML View UI 可減少技術混淆；不強制 Jetpack Compose / Kotlin。
- Gradle 版本／Android Gradle Plugin／JDK／compileSdk/targetSdk 使用 Android Studio 已安裝版本支援且符合目前 Android 官方政策的相容組合；先確認本機工具可建置。`minSdk` 可考慮 26+，以實際手機的 Android 版本為準。
- Gradle project plugins 加入 `com.google.gms.google-services`（依相容版本）；app plugins 套用同名插件；使用 Firebase BoM 與 `com.google.firebase:firebase-messaging`。
- 不需為 FCM 基本收送引入 `firebase-analytics`、Firestore、Firebase Authentication、Firebase Functions；如需其中功能應另說明理由。
- `google-services.json` 要放在 `app/`。Android `applicationId` **必須與 JSON 裡 `client_info.android_client_info.package_name` 完全相符**；不需要再註冊第二個 Android App。
- 別把服務帳戶私密 JSON、Cloudflare ADMIN_API_KEY、Windows AGENT_HMAC_SECRET 放進 Android 工程或 APK。

## 4. 後端 API 與安全配對

已有 Worker 的 Windows HMAC / 管理 API 必須相容保留；Android **不得**拿 Windows HMAC Secret 或 ADMIN_API_KEY 作為 App 認證。

### 4.1 首次配對（最小可用安全設計）

新增一套由管理者在**自己電腦**透過已有 ADMIN_API_KEY 認證建立的配對流程。例如：

- `POST /api/admin/pairing/start`（需既有管理身分驗證）：建立一次性**高熵配對碼**（至少 128-bit 隨機，短效例如 5 分鐘），可限制僅一部 Android 裝置與指定 Windows deviceId。只有產生時回傳配對碼一次；D1 僅存其 hash 和有效期限。
- `POST /api/mobile/pairing/claim`：App 將配對碼、安全隨機產生的 app device ID 送給 Worker（HTTPS），Worker 以單次原子更新完成兌換並核發**獨立手機裝置權杖**（至少 256-bit 安全隨機）；資料庫只存權杖 hash、版本及撤銷狀態。不可重新使用過期或已領取配對碼。
- 配對碼防暴力猜測：高熵、期限短、全域與來源速率限制（可用 Cloudflare 原生 rate limiting/WAF 或 D1 原子計數；不可只用 isolate 記憶體做唯一防護）。錯誤回應不可洩漏碼是否存在。配對碼與 bearer token 不寫入日誌。
- Android 將手機權杖用 Android Keystore 保護的加密儲存機制保存；若 AndroidX 安全套件版本不適用可使用原生 Keystore + AES-GCM。不要存於未加密 SharedPreferences，不要把私密資料放入 Auto Backup。
- 登出／取消配對可撤銷裝置權杖和 FCM token。
- Android API 僅允許存取**已配對的 deviceId**，不可任意指定其他使用者或裝置；伺服器從認證關係決定作用範圍。
- 第一版可只支援一台 Windows + 一台 Android，保留延伸多手機設計。

### 4.2 手機 API（名稱可依既有程式調整，需文件化）

- `POST /api/mobile/fcm-token`：手機 bearer 認證，註冊/更新 FCM registration token；不允許未配對或匿名寫入。`FirebaseMessagingService.onNewToken()` 收到 token 更新時補登記。啟動 App 也可以使用 `FirebaseMessaging.getInstance().getToken()` 補齊首次註冊。失敗時安全重試。
- `GET /api/mobile/status`：回傳與該手機配對的 Windows 健康狀態、最後在線時間及警報設定（可重用既有 `GET /api/device/status` 的核心 service，但不能在 App 內嵌 ADMIN_API_KEY）。
- `PUT /api/mobile/alert-settings`：手機 bearer 認證後僅修改自己的警報接收設定。轉換成既有 `alert_settings` 狀態與欄位；支援 `UNTIL_MANUALLY_DISABLED` 與 `TIMED + durationMinutes`。最短／最長可支援範圍文件化，例如 1～1440 分鐘；零或負值回 400。`expires_at_ms` 一律由 Worker 接收時間計算。`enabled=false` 不停止已在播放的本機警報。
- `POST /api/mobile/ack`：可選但強烈建議，記錄事件 `RECEIVED / RINGING / STOPPED / NOTIFICATION_FALLBACK` 狀態；Ack 是可觀測性，不代表音量或使用者真的聽見。冪等，禁止捏造其他裝置的事件。
- `POST /api/mobile/unpair`：撤銷手機身分與註冊 token。已撤銷裝置不可繼續讀取資料／接收新推播。
- 所有 Android API 使用 HTTPS，明確 JSON 欄位驗證與上限，不開放任意 device_id 的公開列舉。

### 4.3 D1 Migration：`0002_android_fcm.sql`

**不可修改已上線的 `0001_init.sql`**。新增有版本的第二份 migration；Codex 可依現有 schema 做等價設計，至少需要：

1. `android_devices`：手機 ID、綁定的 Windows deviceId、手機 bearer token hash、FCM token 加密值、狀態、建立/更新時間與 last_seen（如需要）。
2. `mobile_pairings`：配對碼 hash、到期時間、兌換時間、建立者/綁定裝置、失敗次數與清除策略。
3. `push_jobs`：`device_id + event_id + push_type` 唯一約束、狀態 `PENDING / SENT_TO_FCM / RETRY / PERMANENT_FAILURE / EXPIRED`、attempt 次數、時間戳；支持去重、排程重試。
4. `push_delivery_logs` 或 `mobile_acks`：必要的投遞與手機 ACK 記錄（保留最短所需期間）。
5. 可增加索引、狀態版本欄位，但不得破壞 `agents`、`alert_events`、`alert_settings` 及第二階段 API。

- FCM token 不應當成無關緊要資料：D1 應加密保存（例如 Cloudflare Secret `FCM_TOKEN_ENCRYPTION_KEY` + Web Crypto AES-GCM、隨機 IV；不要在 D1 另存明文加密密鑰）。
- 原始手機 bearer token 只在第一次配對時回傳，D1 僅存安全 hash；JWT / API key 不得使用靜態公開 key 假冒身分。
- 所有資料庫查詢用 D1 prepared statements，需明確處理原子兌換與唯一鍵競爭。
- 只保留短期可觀測性資料，Cron 清理過期配對碼、過期 push job、舊 delivery logs。

## 5. Cloudflare Worker → Firebase FCM

### 5.1 授權

- Firebase Console 確認 **Cloud Messaging API (HTTP v1)** 已啟用。
- Worker 使用 Firebase 服務帳戶的必要金鑰（例如儲存在 Secret `FCM_SERVICE_ACCOUNT_JSON`），透過 Google OAuth2 service-account JWT 換取**短效 access token**，scope `https://www.googleapis.com/auth/firebase.messaging`。
- 發送到 `https://fcm.googleapis.com/v1/projects/<實際-FIREBASE-PROJECT-ID>/messages:send`。
- Project ID 可放非私密 `FCM_PROJECT_ID` vars；服務帳戶私鑰只能放 Workers Secrets，不在 `wrangler.jsonc`、`.env` 版控、Android `google-services.json`、日誌或其他用戶端。
- 支援 access token 快取與過期刷新（多個 isolate 不保證共享 cache），遇 401 重新取得一次，不無限重試；FCM 錯誤如 `UNREGISTERED` 要停用失效 token。
- 提供**安全的互動式** Secrets 設定步驟，**不要假定使用者已建立 Google Service Account JSON**。正式密鑰和 Google OAuth 需由使用者在確認 scope / IAM 後操作。

### 5.2 Alert 推播流程

1. 既有 `/api/alert` HMAC 驗證、新 `eventId` 去重、D1 接受；原本只有「新鮮且接收設定啟用」的事件會建立 FCM 推播工作，不能對舊事件、待命忽略事件、已過期啟用時間或重複 `eventId` 發送新的響鈴。
2. 以目前的 `alert_settings` 為伺服器權威。完成配對前沒有有效 Android 裝置時，不排送給未知對象。多部已配對手機若未來加入須遵守每手機開關／到期規則（本階段單手機即可）。
3. 使用 `data` 訊息傳最小化內容：`type=WORK_ALERT`, `eventId`, `deviceId`（可選）、`issuedAt`, `expiresAt`。**不傳 TG 文字、發件者**。Android config 使用 `priority=HIGH`，TTL 約 120 秒（依現有事件新鮮度契約）；手機也以有效期限與 `eventId` 去重，不因 FCM 重試而重複響鈴。
4. 新事件儲存成功後建立唯一的 `push_jobs`；嘗試即時送 FCM（`ctx.waitUntil` / 合法生命週期機制），後端有可恢復的紀錄，Cron 重試暫時性錯誤，並對過期事件停止重試。**不要只在記憶體中保留待送事件，也不要讓一分鐘 Cron 成為每條訊息的唯一即時發送方式。**
5. HTTP v1 `200` 僅表示 **FCM 接受推送**，不是手機成功展示／播放。只有裝置 Ack 可證明 App 收到／開始播放，也不能證明使用者聽到。
6. `WORK_ALERT` 不使用 collapse key 將不同 eventId 靜默覆蓋；手機端併入單一警報會話。緊急通知應顯示使用者可見的通知，避免高優先級長期降權。
7. 離線狀態 `OFFLINE` 產生 `WINDOWS_OFFLINE` 一般警示推送一次（依 transition 去重）；`STANDBY` 與 `STOPPED_BY_USER` 不觸發異常離線推播。`WINDOWS_RECOVERED` 可選擇一般通知或僅更新介面（需文件化），不啟動循環響鈴。

## 6. Android 收訊與響鈴可靠性

### 6.1 FCM 接收

- 註冊 `FirebaseMessagingService`，覆寫 `onMessageReceived`（處理 data payload）和 `onNewToken`。
- 在回呼中快速解析、檢查 `eventId` 是否已處理、有效時間與本機啟用快取；不可做長時間同步網路請求。必要的持續工作使用 Android 合法的 WorkManager expedited job；訊息有效時立即顯示使用者可見通知。
- FCM 高優先級消息 **可能被降級**。嘗試背景啟動 Foreground Service 前，檢查實際優先級與支援的例外條件，正確處理 `ForegroundServiceStartNotAllowedException`、安全例外及 API 版本差異；若無法啟動循環播放，要提供**高重要性通知 fallback**、引導使用者開啟 App。不要承諾 100% 鎖屏／背景即時響鈴。
- Android 13+ 透過執行階段請求 `POST_NOTIFICATIONS`；建立獨立通知通道（`Work Alerts` 高重要性、`Health Warnings` 一般重要性、前景服務進行中通知），尊重每個 Channel 的使用者設定。
- `AlarmPlaybackService` 若符合 mediaPlayback foreground service type，應在 Manifest 宣告 `FOREGROUND_SERVICE` 及對應的 `FOREGROUND_SERVICE_MEDIA_PLAYBACK`，按目標 API 要求呼叫 `startForeground()`。Android 14+ 對 full-screen intent 有更嚴格適用範圍，不以強制開啟鎖屏 Activity 為唯一可用路徑；若不符合通話／鬧鐘資格，不能隱藏或繞過限制。
- 不申請不必要權限（精確鬧鐘 `SCHEDULE_EXACT_ALARM` 不是伺服器倒數模式的必要前提；同理不要求無理由的無障礙、電池優化白名單或 DND bypass）。
- 強制停止 App、未提供 Play Services、關閉通知授權或省電節流時可能失效，App 需清楚顯示狀態與操作提示。

### 6.2 停止響鈴

- 以高優先級通知上的「停止警報」Action 以及 App 主畫面的大按鈕，呼叫**同一個**停止邏輯。識別本次警報 session / id，避免舊 Intent 停掉新警報。
- 停止 MediaPlayer 與震動、釋放 AudioFocus、關閉或更新 Foreground Service 及持續通知、記錄 Ack。
- 新 `WORK_ALERT` 若發生於已停止的事件後、且接收開關仍有效，仍可重新觸發響鈴；相同 `eventId` 重播則不得再次響鈴。
- App 被使用者從最近使用中滑掉或系統回收時，行為須以實機驗收為準，不能靠口頭假設會永久播放。

## 7. Android UI：第一版最低需求

以 Java + XML 實作清晰易用的單頁或少量頁面：

1. **連線／配對**：顯示「未配對／已配對」、輸入一次性高熵配對碼、完成後顯示手機 FCM token 登記狀態（不把完整 token 顯示在 UI）。
2. **Windows 狀態**：`MONITORING / STANDBY / STOPPED_BY_USER / OFFLINE / DEGRADED / UNKNOWN`、最後 Heartbeat、通知授權及監聽器健康、手動重新整理。
3. **警報接收**：關閉、持續啟用、倒數啟用（小時 + 分鐘），顯示到期時間與剩餘時間。這兩個是僅有的啟用模式，不增加其他暫停模式。
4. **目前警報**：響鈴時明顯顯示「停止目前警報」按鈕，且與未來警報接收開關獨立。
5. **權限提示**：Android 通知權限、警報通知 Channel、電池背景限制與裝置連線狀況；實際不可用時顯示具體理由，不只是綠色成功標籤。
6. **測試警報**：本機手動測試按鈕，**明確標示「只測本機聲音」**，不經過 TG / Worker / FCM。另提供端到端測試說明。

所有顯示給使用者的時間以 `Asia/Taipei` 呈現，網路 API 與 DB UTC，不重複加 8 小時。

## 8. 既有系統的相容性與限制

- 不破壞 Stage 1/2：Windows WPF/F5/MSIX、TG source baseline、HMAC、Alert 去重、Heartbeat、正常退出、Cron 離線恢復、D1 `0001`、既有 API。
- `GET /api/health` 必須繼續正常。
- `POST /api/alert` 若 FCM 服務設定未完成，仍應保持受理與寫 D1 的功能；把 FCM 狀態記錄成 `NOT_CONFIGURED/PENDING` 而不是讓舊 Windows 功能失效。
- 未完成 Firebase 配對與沒有有效 token 時，不可對不存在的 token 發送。
- Worker `ADMIN_API_KEY` 永遠不進 APK；`AGENT_HMAC_SECRET` 仍僅供 Windows Agent。
- 如有變更 `alert_events.should_notify` 的語意，需寫 migration/文件並保持 Stage 2 驗證查詢相容。
- 系統不讀取、不存儲任何 TG 聊天內容。

## 9. 本機及實機驗收測試

### 9.1 後端自動化

- 既有 Worker 28 個測試與 Windows 51 個測試維持成功（或等價更新後相容，需列完整結果）。
- 管理建立一次性配對碼：未授權拒絕；超時拒絕；已領用拒絕；併發僅可領取一次；猜測/頻率限制。
- Android bearer authentication：有效／失效／撤銷／跨裝置存取拒絕。
- FCM token 註冊/更新、失效 token 清理、密文儲存不洩漏。
- 模擬 OAuth service-account access token 取得、到期刷新、401/403/429/5xx 的錯誤處理；測試不要打真的 FCM。
- 有效新鮮 TG 事件且 enabled=true → 推播；disabled、expired、duplicate、stale → 不推播。
- FCM 失敗重試、併發去重、跨 isolate/D1 防重覆建立 push job、TTL 到期停止。
- OFFLINE transition → 一次一般警示；STANDBY、STOPPED_BY_USER → 不發錯誤離線通知。
- Cron 清理過期配對碼及推播工作，不重複警示。

### 9.2 Android 自動化／整合

- Java Android 專案在 Android Studio 可同步 Gradle、組建 Debug APK、安裝到有 Google Play Services 的 Android 手機。
- Firebase token 初次取得、`onNewToken` 更新、失敗重試，需可透過 fake transport/測試架構驗證。
- 雙模式：持續直到手動關閉；設定 150 分鐘倒數、到期後未來訊息不響；App/Worker 重啟不會遺失伺服器權威時間。
- 事件去重及過期檢查。正在響時新事件合併，不啟動多個音效。
- 按「停止目前警報」結束聲音但設定仍啟用；之後另一個新事件可再次響。
- `POST_NOTIFICATIONS` 被拒、FCM normal priority、FGS start 被拒，仍有合理 fallback 並正確顯示問題。
- `WINDOWS_OFFLINE` 只通知一次，恢復後狀態更新。

### 9.3 使用者正式端到端驗收（分步）

1. 確認 Firebase 專案 ID、Android `applicationId` 與 `app/google-services.json` 相符，Build APK 成功。
2. 先由使用者審查本機 migration `0002_android_fcm.sql`；`--local` 套用並測試成功，**再由使用者明確執行遠端 D1 migration**。
3. 設定 Google 服務帳戶及 Worker FCM Secret（私鑰不貼聊天、不寫 Git），Worker 正式部署由使用者操作。驗證 `/api/health` 與前階段 heartbeat/alert 仍成功。
4. 管理端建立一次性配對碼，在 Android App 輸入配對；Android 顯示配對成功與 FCM token 已註冊。安全檢查：沒有把 `ADMIN_API_KEY` 和 Service Account JSON 放進 APK。
5. Android App 開啟「持續啟用」，Windows Agent 設為 `MONITORING`，送一則新的 Telegram Windows 通知：D1 event `ACCEPTED`，FCM send accepted，Android 收到事件、開始播放警報，按「停止目前警報」停止。
6. 不關閉未來警報，送第二則不同 `eventId`，再次響鈴；重送相同事件不可再次響鈴。
7. Android App 改成「倒數啟用」，設定例 2 小時 30 分鐘，確認 Worker 回傳到期時間；測試縮短的期間模擬到期，不必等真的 150 分鐘。到期後的新事件不觸發響鈴。
8. 切 Windows Agent 為 STANDBY → Heartbeat 正常，不應產生新 Telegram Work Alert；正常退出 `STOPPED_BY_USER` 不誤報；強制終止後超過 180 秒 → Android 收到一次 Windows 離線警示（手機有網路且通知權限允許），重啟恢復正常。
9. Android 實機：App 前景、背景、鎖屏、螢幕關閉、Doze/省電、未授權通知、手機重啟、FCM token 換新，記錄成功／延遲／失敗與 fallback。**不得承諾即時或 100% 必達。**

## 10. Codex 開發順序與交付物

1. 先讀現有 Windows/Worker 程式與 `docs/WorkNotice_Phase2_Codex_SPEC_v1.md`、`docs/PHASE2-INTEGRATION.md` 及現有 `migrations/0001_init.sql`，確認現有 API schema、實際類別簽章。
2. 先建立 Android Java Gradle 專案和可安裝的基本 UI（如使用者尚未放 `google-services.json`，用 placeholder/Mock 邏輯允許本機測試但不得宣稱 Firebase 已可用）；提供使用者放檔路徑。
3. 再建立 `0002_android_fcm.sql`、手機配對與受保護 API、FCM token 安全登記、Worker 推送與 outbox 去重重試、離線警示。
4. 完成 Android FCM MessagingService、聲音服務、停止控制與兩種啟用模式。
5. 分層測試通過、製作可供 Android Studio `Open` 的專案及 `README`。
6. 提供使用者需在 Firebase Console / Google Cloud / Cloudflare 手動操作的流程，**不要取得或輸出私密憑證**。
7. **不要自行部署正式 Worker／遠端 Migration／修改正式 Secrets。** 等使用者依驗收文件明確操作後，再做正式手機端到端驗收。

Codex 必須回報：新增與修改檔案、Gradle 與 Java SDK 版本、Build/test 真實輸出、仍缺的 Firebase Project ID / `google-services.json`、權限與 Android OS 限制、使用者需執行的命令、未通過測試及其原因。

## 11. Firebase 與 Android 官方文件

- Android 設定 FCM SDK： https://firebase.google.com/docs/cloud-messaging/android/get-started
- FCM HTTP v1 認證與發送： https://firebase.google.com/docs/cloud-messaging/send/v1-api
- Android FCM 優先級與處理限制： https://firebase.google.com/docs/cloud-messaging/android-message-priority
- Android 背景啟動 foreground service 限制： https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- Android 13 通知權限： https://developer.android.com/develop/ui/views/notifications/notification-permission
- Android 14 full-screen intent 限制： https://developer.android.com/about/versions/14/behavior-changes-14

---

### 重要技術提醒

- 不是「Worker 回應 FCM 成功」就等於「手機真的響鈴」；這些是不同層次的驗收。
- FCM high priority **並不保證即時、背景啟動 foreground service、繞過勿擾、長時間不被系統中止**。必須做 Android 鎖屏與省電實機測試。
- Android 13+ 使用者必須授予通知權限，並確認 Work Notice 的通知 Channel 可顯示。
- Google 服務帳戶**私鑰**與 Android `google-services.json` 是不同用途：前者只能留在 Worker Secrets，後者為 App 側 Firebase 設定。
