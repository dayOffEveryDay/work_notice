# 第三階段：由使用者執行正式設定與部署

本次開發沒有部署 Worker、變更遠端 D1、建立 Google 憑證或上傳正式 Secrets。沿用 `work-notice-api`、`work-notice-db` / `DB`，Firebase 已核對為 `work-notice-7a5e8`。下列正式命令由你審查後手動執行，不是已完成的正式驗證。

## 1. 審查本機與資料庫變更

PowerShell 7，切換到現有 Worker：

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1
npm ci --no-audit --no-fund
npm test
npm run test:local
npm run test:agent
npx wrangler d1 migrations list DB --local
npx wrangler d1 migrations apply DB --local
```

新增 `migrations/0002_android_fcm.sql`：android_devices、mobile_pairings、push_jobs、mobile_acks、mobile_rate_limits，另有索引與交易內 outbox triggers。`0001_init.sql` 未修改，SHA256 仍為 `F2CEE7B6A0D6AF65E76D3C13F3E0B91B52DCD2C2B1221D03A90E2A87B023E3C9`。

一台 Windows 目前只允許一台有效手機。每台 Windows 的 alert_settings 共用既有設定：配對會預設關閉；管理端與手機都能改設定，最後成功的操作生效。`alert_events.should_notify` 第二階段語意不變；是否有手機／已送達要看 push_jobs 與 ACK，不能僅看 should_notify。

確認備份／復原點、審查 SQL 後，**你手動執行正式 migration**：

```powershell
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations list DB --remote
```

預期只新增套用 `0002_android_fcm.sql`；不要重新建立資料庫、不要改寫 `0001`，不要使用刪表／覆蓋資料指令。先 migration 再更新 Worker。現有 Worker 在 additive schema 下仍可正常處理第一、二階段。

## 2. Google Service Account（需要你在 Console 操作）

1. 在 Google Cloud Console 選正確專案 `work-notice-7a5e8`，確認 **Firebase Cloud Messaging API / HTTP v1** 已啟用。
2. IAM & Admin → Service Accounts，為 Worker 建立專用帳戶。只給發送 FCM 所需權限；可使用 Firebase Cloud Messaging API Admin（`roles/firebasecloudmessaging.admin`），或由管理者審查只含 `cloudmessaging.messages.create` 的自訂角色。不給 Owner／Editor，不與 Windows 或 Android 共用。
3. 若組織允許服務帳戶金鑰，在該專用帳戶建立 JSON private key；若政策禁止，不繞過，需先採可用的 Workload Identity／授權方案。本實作使用服務帳戶 JSON，尚未實作其他授權流。
4. 把私鑰放到專案外受 Windows 存取權限保護的位置，例如你自己的私密憑證資料夾；不要放 Android、不要提交 Git、不要貼聊天／終端日誌。`google-services.json` 是 Android 設定，不能拿來取代服務帳戶私鑰。

Worker 以 RS256 簽 service-account JWT，scope 限 `https://www.googleapis.com/auth/firebase.messaging`，向 Google OAuth 換短效 access token；token 只在 isolate 記憶體快取，到期刷新，FCM 401 最多刷新一次。沒有呼叫 legacy FCM server key API。[官方 HTTP v1 說明](https://firebase.google.com/docs/cloud-messaging/send/v1-api)。

## 3. Cloudflare Secrets（手動操作）

非私密 Project ID 已在 `wrangler.jsonc` 的 `FCM_PROJECT_ID`；以下是新秘密：

| Secret | 用途 |
|---|---|
| FCM_SERVICE_ACCOUNT_JSON | 專用 Google service-account private JSON |
| FCM_TOKEN_ENCRYPTION_KEY | 獨立隨機 32 bytes、小寫 64 字元 hex，AES-GCM 加密 D1 的 FCM registration token |

既有 `AGENT_HMAC_SECRET` 與 `ADMIN_API_KEY` **保留原值**、互不共用，這兩個都不放進手機。D1 也不保存 bearer 明文或 token encryption key。

先登入你已授權的 Cloudflare 帳號，再手動執行 helper；路徑請換成你的真實私鑰檔位置：

```powershell
npx wrangler whoami
# 尚未登入才執行 npx wrangler login
./scripts/Set-FcmSecrets.ps1 -ServiceAccountPath 'C:/你的私密資料夾/work-notice-service-account.json' -InitializeTokenKey
```

此腳本會**變更正式 Secrets**：檢查專案／帳戶型別，以標準輸入傳送 JSON 及密碼學隨機產生的獨立 encryption key，不列印金鑰，不寫入 wrangler 設定或檔案。若 encryption key 已存在則拒絕重新初始化，避免舊密文失效。未帶 `-InitializeTokenKey` 只更新服務帳戶，不更動 encryption key。第一次執行若部分失敗，先用 `npx wrangler secret list` 檢查名字後再處理；不要反覆亂換 key。需保護終端／剪貼簿／轉錄紀錄。

也可直接互動 `npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON` 與 `npx wrangler secret put FCM_TOKEN_ENCRYPTION_KEY`，但不要把值寫到 CLI 引數、PowerShell history 或 Git。金鑰輪替應先規劃密文重加密／手機重新登記；本版沒有多 key 自動輪替。

## 4. 更新現有 Worker 與配對

```powershell
npm run deploy:dry-run
npx wrangler deploy
Invoke-RestMethod 'https://work-notice-api.hui760419.workers.dev/api/health'
# 預期 status=ok；接著確認既有 Windows Heartbeat / Telegram 仍正常。
./scripts/New-MobilePairing.ps1 -DeviceId home-windows
```

配對 helper 互動要求既有 ADMIN_API_KEY（隱藏輸入），只在建立時顯示一次性碼；請直接輸入手機，五分鐘失效。一次碼 256-bit、D1 存 SHA256；手機 bearer 是另一個獨立 256-bit 值，只在兌換時回傳一次。來源每分鐘 10 次、全域每分鐘 100 次由 D1 原子 counters 限制，不依賴 isolate 記憶體。

遺失手機／解除安裝／配對回應遺失時，先管理撤銷，再產生新碼：

```powershell
./scripts/New-MobilePairing.ps1 -Action Revoke -DeviceId home-windows
./scripts/New-MobilePairing.ps1 -DeviceId home-windows
```

不要以手動讀 D1 找 bearer；不可逆雜湊無法取回原值。取消配對清除手機 token、撤銷 bearer 並取消待送工作。

## 5. API 與推播的可觀測性

既有 Windows HMAC API／管理 API 保持相容。新增路由皆 HTTPS、no-store、限制 JSON 欄位／大小，手機 scope 由 bearer 關聯決定：

| 路由 | 身分／body |
|---|---|
| POST /api/admin/pairing/start | 管理 bearer；`deviceId` |
| POST /api/admin/mobile/revoke | 管理 bearer；`deviceId` |
| POST /api/mobile/pairing/claim | 一次碼；`pairingCode,mobileId` |
| POST /api/mobile/fcm-token | 手機 bearer；`token` |
| GET /api/mobile/status | 手機 bearer；禁止 query deviceId |
| PUT /api/mobile/alert-settings | 手機 bearer；`enabled,mode,durationMinutes,offlineAlerts`（後兩者按模式可選） |
| PUT /api/mobile/offline-settings | 手機 bearer；`offlineAlerts`，不改倒數到期時間 |
| POST /api/mobile/ack | 手機 bearer；`eventId,status`，只允許自己的真實 push job |
| POST /api/mobile/unpair | 手機 bearer；空 JSON `{}` |

新鮮、已啟用、非重複且有有效配對 token 的事件，在接受事件交易中建立唯一 outbox 工作；`ctx.waitUntil` 即時派送，Cron 每分鐘重試。D1 lease 防平行派送，最多五次、最多 120 秒，沒有 collapse key。暫時錯誤退避；UNREGISTERED 只清除相同版本 token。缺 FCM 設定顯示 PENDING / NOT_CONFIGURED，不讓既有 /api/alert 寫入失敗。

FCM 接受後才是 SENT_TO_FCM，不能解讀為手機收到。手機 Ack RECEIVED／RINGING／STOPPED／NOTIFICATION_FALLBACK 冪等記錄；不可證明音量或使用者聽見。MONITORING 或 STANDBY 超過 180 秒沒有 Heartbeat 時，每次真正 OFFLINE transition 最多一個 WINDOWS_OFFLINE 普通通知，且手機必須已配對、有 token、未撤銷並開啟 offline_alerts。仍持續回報 Heartbeat 的 STANDBY 不報離線；正常退出的 STOPPED_BY_USER 不報異常。恢復只由 App 重新整理狀態顯示，不另推送。

若需要查看正式資料，由你執行只讀查詢，**不要選出 fcm_cipher、bearer_hash 或 code_hash 貼聊天**：

```powershell
npx wrangler d1 execute DB --remote --command "SELECT id,event_id,push_type,state,attempts,last_error,sent_at_ms FROM push_jobs ORDER BY id DESC LIMIT 20"
npx wrangler d1 execute DB --remote --command "SELECT event_id,status,received_at_ms FROM mobile_acks ORDER BY received_at_ms DESC LIMIT 20"
```

配對碼到期一天後刪除、rate counters 保留十分鐘，push jobs／ACK 保留七天。Outbox 無法提供跨 FCM 的 exactly-once：若 Google 接受後 Worker 在寫 SENT 前中止，可能重送同一 eventId；手機 durable ledger 負責不重響。網路、系統限制與實機矩陣見 [Android README](../android/WorkNoticeAndroid/README.md) 與 [驗收紀錄](PHASE3-VERIFICATION.md)。
