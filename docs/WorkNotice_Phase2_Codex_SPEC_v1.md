# Work Notice — 第二階段開發規格 v1.0（供 Codex 使用）

## 1. 專案現況與目標

現有 Windows Agent 是 C# / .NET 10 / WPF，Telegram Windows 系統通知監聽、來源確認 `Telegram.TelegramDesktop`、監控中／待命中、通知去重、系統匣與 MSIX F5 開發部署已完成第一階段實機測試。應優先重用既有 `IAlertDispatcher` 與 `IAgentStatusProvider`，不可重做監聽邏輯或破壞 RID/MSIX 封裝修復。

第二階段新建 Cloudflare Workers（TypeScript）+ D1，並在 Windows Agent 加入 HTTPS 事件傳送、Heartbeat 與連線狀態 UI。此階段不開發 Android、FCM、Lark、Google OAuth 或 Google VM，也不傳 Telegram 訊息文字、發送者、聊天室名稱。

Cloudflare 已有真實 D1，**不要重建或刪除**：
- database_name: `work-notice-db`
- database_id: `27e8ee1c-bcb7-4ee5-94d7-40c589480395`
- binding: `DB`
- Worker 名稱：`work-notice-api`

## 2. 資料表與關聯規則

第二階段需要**一個 D1 資料庫內五張表**，SQL 原樣見同行檔案 `WorkNotice_Phase2_0001_init.sql`（請放進 Worker 專案 `migrations/0001_init.sql`）。

1. `agents`：裝置狀態，每個 `device_id` 一列。PK: `device_id`；`reported_mode` 為 `MONITORING | STANDBY | STOPPED_BY_USER`，`listener_status` 為 `READY | DEGRADED | ERROR`，心跳時間為 UTC epoch milliseconds。
2. `alert_events`：通知事件。複合 PK `(device_id, event_id)`，**同一裝置相同 eventId 只記一次**。保存來源、AUMID、通知 ID、發生／接收時間和是否應通知；不得保存聊天內容。
3. `alert_settings`：每裝置一列。PK: `device_id`；`enabled` 預設 0。`mode` 為 `UNTIL_MANUALLY_DISABLED` 或 `TIMED`；限時模式以 `expires_at_ms` 判定是否過期。停止正在播放的手機鬧鐘是未來 Android 另一個控制，與這個設定不同。
4. `request_nonces`：HMAC 防重放。複合 PK `(device_id, nonce)`；保存 `expires_at_ms` 供清理，同一 nonce 禁止再次使用。
5. `agent_status_transitions`：健康狀態轉換紀錄，PK `id` 自增，保存 `device_id`、`status`、`observed_at_ms`；定時檢查不得重複寫入同一持續狀態。

關聯：五表透過 `device_id` 邏輯關聯到 `agents.device_id`，第一版 SQL **未強制 FOREIGN KEY**，因為事件／nonce 可能先於首次心跳抵達；須由 Worker 驗證 allowlist / 裝置 ID，並在處理事件時確保裝置記錄已建立或正確處理不存在的裝置。不要盲目加外鍵導致首筆事件請求失敗；日後可在確認寫入順序後評估外鍵。資料存取使用 D1 prepared statements 的 `bind`，禁止字串拼接 SQL。

資料保留：`alert_events` 約 7 天後清理；nonce 到期後清理；`agents` 更新最後狀態，不要每 60 秒新增歷史列。

## 3. API 契約

所有請求使用 JSON、UTC ISO 8601 (`Z`)；UI 顯示台灣時間 UTC+8。

- `GET /api/health`：僅回傳 Worker 可用，例如 `{ "status": "ok" }`，不洩漏裝置資料。
- `POST /api/alert`（Agent HMAC）：Windows 監控中首次處理的 Telegram 通知，發送 `eventId`（穩定且重試不變）、`deviceId`、`source="TELEGRAM"`、`aumid`、`notificationId`、`occurredAt`。新事件回 `202 ACCEPTED`；重複回 `200 DUPLICATE`；過期事件回 `200 STALE`。僅寫 D1，不真正送 FCM。收到事件不代表手機接收開關已開啟。
- `POST /api/heartbeat`（Agent HMAC）：發送 `deviceId`、`sessionId`、`agentMode`、`listenerStatus`、`notificationPermission`、`telegramSourceConfirmed`、`agentVersion`。Windows 啟動即送，之後每約 60 秒；監控／待命都要送。服務端時間為 `last_seen_at_ms` 權威。使用者明確退出時 best-effort 短超時送 `STOPPED_BY_USER`。
- `GET /api/device/status`（獨立 ADMIN_API_KEY，第二階段測試用）：回傳最近心跳時間、模式、授權與監聽器狀態、計算後 effectiveStatus、alertSetting。有效狀態 `MONITORING / STANDBY / STOPPED_BY_USER / OFFLINE / DEGRADED / UNKNOWN`。不允許公開列舉設備。
- `PUT /api/device/settings`（獨立 ADMIN_API_KEY，第二階段測試用）：`{ "deviceId": "home-windows", "enabled": true, "mode": "TIMED", "durationMinutes": 150 }` 或模式 `UNTIL_MANUALLY_DISABLED`。限時以**Worker 伺服器時間**計算到期，`enabled=false` 立即關閉未來新警報。不可將 ADMIN_API_KEY 放進未來的 Android APK。

事件去重：`eventId` 必須由穩定識別（例如 deviceId、AUMID、Windows notificationId、建立時的 UTC 時間）做無歧義編碼後 SHA-256，不可每次重試重新產生 UUID。事件逾期（建議 120 秒）不在未來觸發新鬧鐘，應在儲存／回應中可見為 STALE。

## 4. API 安全

Windows `POST /api/alert` 和 `POST /api/heartbeat` 用 HTTPS + HMAC-SHA256：

```
X-Device-Id: home-windows
X-Timestamp: UnixSeconds
X-Nonce: unique-per-attempt
X-Signature: v1=<lowercase-hex-hmac>
Content-Type: application/json
```

Canonical message 為：

```
UPPERCASE_METHOD + "\n" +
PATHNAME_ONLY + "\n" +
X-Device-Id + "\n" +
X-Timestamp + "\n" +
X-Nonce + "\n" +
LOWERCASE_HEX_SHA256(RAW_BODY_BYTES)
```

Worker 使用原始 body bytes 驗章、constant-time 比對、限制 body 8 KB、檢查時間窗 ±300 秒、防 nonce 重放、裝置 ID allowlist、格式驗證；此階段不允許簽章端點帶 query string。Server 將 `AGENT_HMAC_SECRET` 與獨立 `ADMIN_API_KEY` 存 Wrangler/Workers Secrets；本機測試用 `.dev.vars` 且不可提交。Windows 秘密使用 DPAPI CurrentUser 或 Windows Credential Manager 保存，不能硬編碼、寫入 repo、MSIX 或 log。

## 5. Windows C# 整合要求

- 重用 `IAlertDispatcher`，以背景 HTTP pipeline 非阻塞方式送事件；保留 Telegram AUMID 過濾和已完成的去重、基線處理。待命不得傳送工作事件。
- HttpClient 單例/Factory + timeout，背景佇列限容量（建議 100），短暫失敗 2s / 5s / 15s 最多 3 次與 jitter；重試 eventId 不變、HMAC nonce 每次變；401/403/格式錯誤不無限重試，過期不補發舊警報。
- `HeartbeatService` 使用 `PeriodicTimer` 或等價方式，啟動立即送、約每 60 秒再送，待命時照送、失聯可重試但不累積併發請求。睡眠恢復應先重建通知基線與監聽健康再回報。
- UI 增加 Worker HTTPS endpoint、deviceId、Secret 安全設定、測試連線、雲端狀態、最近成功心跳、最近成功工作事件發送時間；雲端失敗不得卡住 UI／監聽器。
- 點系統匣「結束程式」best-effort 2 秒發 STOPPED_BY_USER，不能因網路失敗卡住退出；正常關閉且 stop 發送失敗時不能假裝 Worker 知道是主動停止。
- 所有網路/DB 時間統一 UTC；Windows UI 顯示 UTC+8。

## 6. 健康判斷與 Cron

- 每分鐘 `scheduled()` 檢查：超過 180 秒無 heartbeat，且不是 `STOPPED_BY_USER` → `OFFLINE`；恢復時記錄一次 recovery transition。
- 最新 heartbeat 的 `listenerStatus` 非 `READY` 或通知權限被拒 → `DEGRADED`；`STANDBY` 是刻意待命，不等於異常離線；首次未知回 `UNKNOWN`。
- `GET /api/device/status` 必須即時根據當下時間計算有效狀態，不能只依賴 Cron；Cron 主要記錄轉換與清理到期 nonce、事件。
- 正常停止狀態若 stop 已確認，後續沒有心跳不應誤報異常；意外關機／當機時無 stop，超時才顯示離線。
- 本階段只在 D1 記錄狀態，不發送 FCM。

## 7. 實作與測試要求

優先 Worker + D1 migration 本機通過，再整合 Windows。測試需包括：有效／錯誤 HMAC、timestamp、nonce 重放、無權限 API、首次與重複通知（含並行唯一性）、過期通知、心跳與待命、正常退出及恢復、180 秒失聯、設定持續／限時／關閉、Cron 冪等；C# 需以 fake HttpMessageHandler 測 HTTP 失敗重試、簽章及 Heartbeat。原有至少 16 個單元測試不得回退。不可宣稱未經驗證的遠端 D1 或 Windows 實測已通過。

## 8. Cloudflare 設定與部署順序

在 Workers 專案建立 `wrangler.jsonc`，設定 name `work-notice-api`、`src/index.ts`、D1 binding `DB`、上述既有 database_name 和 database_id、cron `* * * * *`。不要把 secrets 放在 `wrangler.jsonc` 或 Git。

本機測試：

```powershell
npm install
npx wrangler d1 migrations apply work-notice-db --local
npx wrangler dev
```

Codex 須提供本機驗收結果，使用者確認後才執行遠端（**不能重建同名 D1**）：

```powershell
npx wrangler d1 migrations apply work-notice-db --remote
npx wrangler secret put AGENT_HMAC_SECRET
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

未經使用者同意不得登入其 Cloudflare 或直接部署；提供可重現 README、測試輸出、錯誤排查與人工驗收流程。

## 9. 第二階段完成標準

Windows 監控中收到真正 Telegram 系統通知 → C# 發送 HMAC HTTPS → Worker 接受 → D1 `alert_events` 只存一次；待命不發 alert 但持續 Heartbeat；Worker 可區分監控中、待命、正常退出、失聯與降級；管理測試可讀寫未來手機警報開關／限時設定。**Android/FCM 尚未實作**。
