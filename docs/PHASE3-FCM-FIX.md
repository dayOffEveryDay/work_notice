# FCM 推播修復：本機診斷與正式驗證

使用者回報正式 D1 的 push_jobs 為 FCM_OR_OAUTH_FAILED／RETRY／TTL_EXPIRED，沒有 sent_at_ms。本次沒有讀取正式資料／Secrets、修改遠端 D1、呼叫真正 Google OAuth／FCM 或部署 Worker。下列根因是在與專案相同 compatibility_date 的 **實際本機 workerd** 重現，並非僅以 Node mock 推測。

## 已確認的兩個程式錯誤

1. `FcmSender` 把原生 `fetch` 存入 `this.transport`，再以 `this.transport(...)` 呼叫。Workers 原生函式收到錯誤 receiver，拋出 `TypeError: Illegal invocation`，Google 請求次數為零。改成箭頭函式內呼叫 `globalThis.fetch(input, init)`，維持正確 receiver。
2. OAuth 與 FCM 都使用 `redirect: 'error'`。Workers 不實作這個選項，會在建構請求時拋出 TypeError，同樣尚未連到 Google。改成 `manual`，將 3xx 視為失敗，**不跟隨 Location、不把認證轉送其他主機**。

先前測試注入 Node 函式，掩蓋了這兩個 runtime 差異。現在除了原測試，增加 workerd 原生 fetch → 本機 outboundService 攔截測試：真正產生 RS256 JWT、驗證簽章／scope／aud／exp、交換 mock OAuth、發送 mock FCM、寫入真實本機 D1，並驗證同 isolate 的 access token 快取。

根因不需要更改 Google Cloud 設定即可修正。但本次沒有讀正式 Secret 或發送真正推播，因此正式憑證／專案／token 是否另有問題仍需部署後依新錯誤碼判斷。不要因舊的 FCM_OR_OAUTH_FAILED 就先換 Google 金鑰或重新配對。

官方依據：[Illegal invocation 與 receiver](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors)、[Workers Request 的 redirect 支援與敏感 Header 轉址風險](https://developers.cloudflare.com/workers/runtime-apis/request/)。

## 診斷與安全

- 新增 `src/push-errors.ts`。只輸出固定欄位 `event,jobId,attempt,state,stage,httpStatus,code,retryable`。不輸出完整 error、stack、上游 message／error_description、回應本文、請求本文、Header、JWT、私鑰、任何 token 或 bearer。
- Google error code 必須通過固定 allowlist；未知字串改為 HTTP_ERROR，避免把上游任意內容當錯誤碼寫入 D1／日誌。網路／timeout／receiver／redirect 錯誤也只映射成本機固定代碼。
- `last_error` 格式為 `階段:HTTP狀態:代碼`，例如 `OAUTH_HTTP:400:INVALID_GRANT`、`FCM_HTTP:403:SENDER_ID_MISMATCH`。沒有 HTTP 回應時用 `0`，如 `OAUTH_NETWORK:0:TIMEOUT`。
- JSON／project／PKCS8／JWT 簽章、token 解密、OAuth 網路／HTTP／回應及 FCM 網路／HTTP／回應分開分類。Service-account JSON 支援外圍空白／BOM、PEM 正常或跳脫換行；驗證 type、必要欄位與 Project ID。OAuth 明確送 application/x-www-form-urlencoded。
- 400／403 等明確組態或授權錯誤不盲目重試；timeout／408／429／5xx 保持有上限的重試。FCM 401 仍只刷新一次，UNREGISTERED 仍只停用該版本 registration token。
- TTL 到期改為 `state='EXPIRED', last_error=COALESCE(last_error,'TTL_EXPIRED')`。有原始失敗原因就保留；從未失敗的工作才使用 TTL_EXPIRED。達嘗試上限也保留最後原因，不再覆蓋成 ATTEMPTS_EXHAUSTED。舊程式已覆蓋的歷史原因無法從 D1 回復。
- 即時派送外層不再默默吞掉錯誤；只記 `push_dispatch_failed / DISPATCH / UNEXPECTED_FAILURE`，不列出 D1 例外或參數。

例如 `wrangler tail --format pretty` 會看到以下非敏感 JSON：

```json
{"event":"push_failure","jobId":123,"attempt":1,"state":"PERMANENT_FAILURE","stage":"OAUTH_HTTP","httpStatus":400,"code":"INVALID_GRANT","retryable":false}
```

`/api/alert - Ok` 只表示 HTTP handler 成功，推播在 waitUntil 中執行，不能據此判定 Google 已接受或手機已收到。以 SENT_TO_FCM、sent_at_ms 與手機 Ack 分層判斷。

## 檔案與本機結果

功能：`src/fcm.ts`、`src/push-errors.ts`、`src/index.ts`。

測試：`tests/mobile.test.mjs`、`tests/push-diagnostics.test.mjs`、`tests/runtime-fcm.test.mjs`。文件：本檔、PHASE3-VERIFICATION.md 與 Worker README。

`npm test` 執行 TypeScript、Wrangler **dry-run** 與全部測試。新增 workerd 兩個故障重現、正確 receiver／manual 成功流程、Google HTTP 診斷、JSON／PEM、3xx 不轉送、敏感 canary 不外洩、TTL／重試上限保留原因。原 Heartbeat、HMAC、Telegram 去重、手機配對／撤銷、離線 Trigger 均保留回歸。

本機 logs：`artifacts/phase3/fcm-fix-tests.log`、`fcm-fix-agent.log`、`fcm-fix-local.log`。Google 一律由本機攔截／mock 回應，未將本機成功宣稱為正式 FCM 或 Android 播放成功。Windows／Android 原始碼、Wrangler 正式設定及 **0001／0002 migration 完全未更動**，不需新增 migration。

本輪最終結果：TypeScript 與 Wrangler dry-run 成功；**75 項 Worker 測試通過、0 失敗、0 略過**（包含原 54 項及新 21 項）。其中四項實際 workerd 測試通過；C# signer／lost-ACK 事件去重／Heartbeat／STOPPED_BY_USER 本機整合通過，Wrangler 本機 health／D1／scheduled() smoke 通過。未重新宣稱 Android 實機播放已成功。

## 你手動部署與驗證

只需更新 Worker 程式；**不用重套 migration、重設 Secrets 或重新配對**：

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1
npm test
npm run deploy:dry-run
# 下行會更新正式 Worker，由你手動執行。
npx wrangler deploy
Invoke-RestMethod 'https://work-notice-api.hui760419.workers.dev/api/health'
```

另一個終端監看（使用 pretty，避免匯出可能含 request metadata 的完整原始 trace）：

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1
npx wrangler tail work-notice-api --format pretty
```

Android 保持已配對、token 已登記、通知權限允許，開啟未來工作警報；Windows 設為 MONITORING，讓 Telegram 產生一則**全新的 Windows 通知**。不要重送舊 eventId、復活 EXPIRED 工作或延長舊事件 TTL。

由你執行正式只讀查詢（本次助手未執行）：

```powershell
npx wrangler d1 execute DB --remote --command "SELECT id,push_type,state,attempts,last_error,sent_at_ms,expires_at_ms FROM push_jobs ORDER BY id DESC LIMIT 10"
npx wrangler d1 execute DB --remote --command "SELECT event_id,status,received_at_ms FROM mobile_acks ORDER BY received_at_ms DESC LIMIT 10"
```

預期新工作為 SENT_TO_FCM 且 sent_at_ms 非 NULL。手機收到後才會有 RECEIVED／RINGING；按停止應有 STOPPED。FCM 接受仍不等於手機開始播放或使用者聽到。

若仍失敗，先分享**新的 stage／HTTP status／固定 code**，不要貼金鑰、完整 Google 回應、Header、JWT 或 token。`SERVICE_ACCOUNT:*:INVALID_JSON/INVALID_FIELDS/PROJECT_MISMATCH` 是 Secret 格式／專案核對；`JWT_IMPORT` 是 PKCS8 格式；`OAUTH_HTTP:400:INVALID_GRANT` 才進一步檢查服務帳戶金鑰與時間；`FCM_HTTP:403:*` 再依代碼核對發送專案／IAM；`UNREGISTERED` 由手機重新登記 token。若 SENT_TO_FCM 已成功但沒有 Ack，再查手機的網路、FCM 註冊、背景限制、降權及權限，與本次 Google 前置失敗分開判斷。
