2026-11-04：三來源待部署變更與本機驗證見 [交付報告](../../docs/LARK-CLOUD-INTEGRATION.md)。新增 0004 migration 與 Chrome／Brave 白名單，尚未部署正式環境。舊 Windows 心跳仍相容；新版 Windows 1.0.1.0 需先更新 Worker 後再安裝。下方舊修復階段「不需要 migration」說明不適用本輪。

# work-notice-api — 第二、三階段 API

FCM 推播修復（Workers native fetch receiver、redirect 相容性與安全診斷）見 [修復與部署驗證](../../docs/PHASE3-FCM-FIX.md)。本次更新不需要 migration 或 Secret 變更。

沿用既有 Worker `work-notice-api`、D1 `work-notice-db`、binding `DB`、Database ID `27e8ee1c-bcb7-4ee5-94d7-40c589480395`。第三階段新增 `0002_android_fcm.sql`，原 `0001` 不變；沒有替使用者部署正式服務或變更遠端 D1／Secrets。先讀 [第三階段部署指南](../../docs/PHASE3-DEPLOYMENT.md)，再由使用者執行新的遠端 migration。下列既有第二階段 API 保持相容。

## 已實作

| 路由 | 認證 | 行為 |
|---|---|---|
| GET /api/health | 無 | 僅 `{status:ok}`，不查詢或洩漏裝置 |
| POST /api/alert | Agent HMAC | 202 ACCEPTED；同裝置同 eventId 200 DUPLICATE；超過 120 秒 200 STALE |
| POST /api/heartbeat | Agent HMAC | 伺服器時間更新 agents，支援 MONITORING / STANDBY / STOPPED_BY_USER |
| GET /api/device/status?deviceId=home-windows | Bearer ADMIN_API_KEY | 即時計算 UNKNOWN / MONITORING / STANDBY / DEGRADED / OFFLINE / STOPPED_BY_USER |
| PUT /api/device/settings | Bearer ADMIN_API_KEY | 持續、限時（1..10080 分鐘）、停用未來新警報 |

`scheduled()` 每分鐘記錄狀態轉換、清理過期 nonce 與接收超過 7 天的事件；持續相同狀態不重複新增。超過 180 秒沒有心跳判 OFFLINE；已確認 STOPPED_BY_USER 不誤判離線。心跳恢復時新增一次恢復轉換。舊 session 的退出不能覆蓋新 session。

所有 SQL 都是固定的 prepared statements，值使用 bind。nonce 唯一插入、eventId 複合主鍵與 D1 batch 維持並行唯一性與原子寫入；不保存本文、發送者或聊天室。允許事件在首次心跳前抵達，這時建立 agents 基礎紀錄，但沒有心跳的有效狀態仍是 UNKNOWN。

警報開關預設關閉，TIMED 期限由伺服器時間計算。`should_notify` 只代表當下是否符合未來通知條件，**本階段沒有 FCM、Android 或真正手機鬧鐘**。STALE 事件可保存在 D1 供診斷，但 should_notify 固定 0。

## 安全契約

- AGENT_HMAC_SECRET 與獨立 ADMIN_API_KEY 至少 32 字元且不可相同；未配置或共用時受保護 API 回 503。
- `ALLOWED_DEVICE_IDS` 是逗號分隔裝置 allowlist，預設 home-windows。`ALLOWED_TELEGRAM_AUMIDS` 預設 Telegram.TelegramDesktop，應與 Windows 確認的來源一致。
- Agent 請求 headers：X-Device-Id、X-Timestamp（Unix seconds）、X-Nonce（16..128 字元）、X-Signature（v1=小寫 SHA256 HMAC hex）。timestamp 時間窗 ±300 秒；signed URL 不接受 query string。
- canonical：`UPPERCASE_METHOD + "\n" + PATHNAME_ONLY + "\n" + deviceId + "\n" + timestamp + "\n" + nonce + "\n" + lowercaseHex(SHA256(rawBodyBytes))`。
- 以 WebCrypto HMAC verify 與 timingSafeEqual 驗證，讀取 body 最多 8192 bytes，拒絕未知 JSON 欄位與錯誤格式。驗章成功即消耗 nonce，無效簽章不能消耗 nonce；每次重試需要新 nonce。future timestamp 的 nonce 保留到其完整有效時間窗結束，避免 Cron 提早清除造成可重放。
- admin 使用 `Authorization: Bearer ...`，不可使用 Agent Secret；必須指定 allowlisted deviceId，不提供設備列舉。
- 生產 Agent 僅允許 HTTPS origin，禁止 query、帳密與路徑。Worker 對非 loopback 的 signed HTTP 請求拒絕，local dev 僅允許 localhost / 127.0.0.1。
- 錯誤只回固定碼，不記錄 headers、body、秘密或原始 D1 例外。不得把真實金鑰貼進聊天、程式碼、Git 或命令列參數。

## 本機建置與測試

已驗證 Node 24.22.2、Wrangler 4.156.1、TypeScript 7.0.2、.NET SDK 10.0.403。此機原 Node 22.12.0 執行 Wrangler 曾發生 0xC0000005，所以本工作區使用已核對官方 ZIP SHA256 的可攜 Node 24，不修改系統 Node。

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1  # 已用系統 Node 24 可省略
npm ci
npm test
npm run test:local
npm run test:agent
```

- npm test：原有 14 項保留，合計 28 項。使用隔離 Wrangler D1 / Miniflare，隨機測試金鑰只在記憶體。
- test:local：實際 Wrangler HTTP、D1 與 scheduled() 入口；呼叫兩次 Cron，持續離線只寫一次。
- test:agent：生產用 C# signer / 背景 pipeline → 本機 Worker / D1；刻意丟棄第一次成功回應，重試後 D1 仍只有一筆，並驗證心跳及正常退出。只有測試專用 handler 轉接 HTTPS 邏輯 origin 至 loopback HTTP，正式 App 不允許 HTTP。
- 這些測試不需要正式 Secret、不登入 Cloudflare、不連正式 D1。migration/schema 測試資料在 `.wrangler/schema-tests`，smoke test 在 `.wrangler/smoke-tests`，不污染本機開發資料。

本機手動 API 測試才需要 .dev.vars：

```powershell
./scripts/New-LocalSecrets.ps1
npm run db:migrate:local
npm run dev
```

腳本用 CSPRNG 產生兩把獨立 256-bit 金鑰，寫入已被 .gitignore 排除的 .dev.vars，不印出值；檔案存在即拒絕覆蓋，避免意外換掉已使用的金鑰。本機檔案是開發秘密，請只保留在你的受保護使用者目錄。自動測試不執行此產生腳本，也不使用你的真實 .dev.vars。

## 由使用者執行的正式更新步驟

既有正式網址：`https://work-notice-api.hui760419.workers.dev`。以下命令本次未代為執行。

1. 確認本機測試結果與 wrangler.jsonc 的 allowlist。若實際 deviceId 或 Telegram AUMID 不同，先修改 vars；不要變更 D1 ID 或建立同名資料庫。
2. 若已有部署／Windows 使用中的秘密，重用現有值；不要任意重新生成，否則舊 Agent 會 401。尚未有秘密時才執行 New-LocalSecrets.ps1。Windows 只使用 AGENT_HMAC_SECRET。
3. 核對 Cloudflare 帳號，再上傳 Secrets 並更新既有 Worker：

```powershell
npx wrangler whoami
# 只有尚未登入才由你執行：npx wrangler login
npx wrangler d1 info work-notice-db
npm run deploy:dry-run
node scripts/upload-secrets.mjs
npx wrangler deploy
Invoke-RestMethod 'https://work-notice-api.hui760419.workers.dev/api/health'
```

upload-secrets 會讀取產生器格式的 .dev.vars，透過 stdin 傳給 `wrangler secret put`，不把值放入 argv 或印出。**它會變更遠端 Secrets，可能建立 Worker 新版本，僅在你確認後手動執行**；它不部署程式、不修改 D1。若既有金鑰不是產生器的 hex 格式，改用互動輸入，不帶值參數：

```powershell
npx wrangler secret put AGENT_HMAC_SECRET
npx wrangler secret put ADMIN_API_KEY
npx wrangler deploy
```

本次沒有新 migration。不要重新建立 D1、清空表、刪除 migration 紀錄或重寫 0001；若要核對可由你唯讀執行 `npx wrangler d1 migrations list work-notice-db --remote`。

部署後驗證管理 API（腳本從本機 .dev.vars 讀取 ADMIN_API_KEY，不會印出金鑰）：

```powershell
node scripts/admin.mjs status
node scripts/admin.mjs settings --enabled true --mode TIMED --minutes 150
node scripts/admin.mjs status
node scripts/admin.mjs settings --enabled false --mode UNTIL_MANUALLY_DISABLED
```

預設使用上述正式 URL 與 home-windows；可用 `--endpoint https://你的Worker根網址 --device 你的ID` 調整。status 預設應為 UNKNOWN，直到 Windows 開始心跳。settings 啟用只影響未來新事件的 should_notify，不會補發舊事件，也不會發送 FCM。

## Windows 設定與驗收

見 [第二階段整合與驗收](../../docs/PHASE2-INTEGRATION.md)。Worker 新版部署及 Secrets 配置完成後，從 Windows 系統匣結束舊版，以 VS Debug／x64 F5 或新 MSIX 啟動。展開「雲端設定」：填 HTTPS 根網址、相同 deviceId，將本機編輯器中 AGENT_HMAC_SECRET 的值貼入 PasswordBox，再「安全儲存」。不要貼入 ADMIN_API_KEY，也不要將值貼到聊天或日誌。

Windows 以 DPAPI CurrentUser 加密保存 Secret，JSON 只留密文；重新啟動不需重貼。UI 顯示心跳確認與最近成功時間，全部是台灣 UTC+8；傳輸與 D1 則維持 UTC。

## 官方參考

- [WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [D1 batch / prepared statements](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Scheduled handler 與本機測試入口](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
# 第三階段補充

沿用既有 Worker／D1，新增安全手機配對、受限 mobile bearer API、加密 token 與 FCM HTTP v1 durable outbox。請先閱讀 [第三階段部署指南](../../docs/PHASE3-DEPLOYMENT.md)；新的 `0002_android_fcm.sql` 需在正式 Worker 更新前由使用者手動套用。下方第二階段命令及 API 仍相容，不要重新建立資源或覆寫 `0001`。

