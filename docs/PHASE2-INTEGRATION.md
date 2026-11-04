# 第二階段：Windows 整合與實機驗收

本次沿用既有 Worker / D1 與通知監聽架構；沒有重新建立 Worker / D1，沒有改動 0001 migration，沒有登入或部署正式環境。Worker API、Secrets 及部署命令見 [Worker README](../cloudflare/work-notice-api/README.md)。

## Windows 行為

既有 UserNotificationListener → 模式／來源／去重／基線 → IAlertDispatcher → CloudAgentService。本機安全日誌保留，雲端使用最多 100 筆的記憶體佇列、單一背景 reader、共享 HttpClient。未設定雲端時保留原本本機功能。

- 雲端 eventId 是 deviceId、AUMID、Windows notification ID、UTC 建立時間的 UTF-8 byte-length prefix 編碼 SHA-256，不用原本 DTO 的 Guid；重試 body 與 eventId 不變、nonce 每次更新。
- 每次請求 timeout 5 秒；網路暫斷、408、429、5xx 最多重試 3 次（最多 4 次嘗試），延遲 2 / 5 / 15 秒加 0..250ms jitter。400 / 401 / 403 / 409 與 redirect 不無限重試，正式 client 禁止自動 redirect。
- 每次 alert 嘗試前確認仍監控、Listener Ready、設定 generation 相同、未暫停／退出且未超過 120 秒。佇列滿會丟棄並顯示，不等待網路；不持久化佇列、不重播重啟前事件。
- Heartbeat 啟動立即送，之後約每 60 秒，監控與待命都送；semaphore 防併發，收到預期成功回應才更新成功時間。
- 睡眠會取消進行中的傳送／重試並使舊佇列失效；恢復先重建本機通知基線，再重新送 Heartbeat。已在網路上或伺服器完成的要求無法收回。
- 明確退出時停止佇列／timer，最長 2 秒 best-effort STOPPED_BY_USER，不重試 stop。未確認時不宣稱已回報，之後 Worker 可能顯示 OFFLINE。
- 改設定會使舊要求失效，舊連線遲到的成功不會覆蓋新設定連線狀態。單純關閉主視窗仍縮到系統匣，不送 STOPPED_BY_USER。
- Windows 只保存 AGENT_HMAC_SECRET，以 DPAPI CurrentUser 加密於 cloud-settings.json；Secret 不放進原來源設定、repo、MSIX 或 log。PasswordBox 不綁定可序列化的 ViewModel，儲存後清空。損壞／跨使用者解密失敗沒有明文 fallback。
- UI 的最近心跳、雲端事件與本機事件時間共用台灣 UTC+8 formatter；內部與網路仍是 UTC。

Worker 以伺服器時間計算：無心跳為 UNKNOWN；確認停止為 STOPPED_BY_USER；超過 180 秒為 OFFLINE；未 Ready／權限非 Allowed／來源未確認為 DEGRADED；其餘按模式為 MONITORING 或 STANDBY。status API 即時計算，不等 Cron；Cron 僅記真正狀態轉換，並清除到期 nonce 與 7 天事件。

## 本機重現

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1
npm ci
npm test
npm run test:local
npm run test:agent
```

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘'
. ./scripts/Use-LocalDotnet.ps1
dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-restore -m:1
dotnet test WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-build --no-restore
```

Worker 測試使用隔離本機 D1、Miniflare、記憶體隨機金鑰。C# 使用 fake HttpMessageHandler 加實際 DPAPI 測試。test:agent 是真正 C# sender → 本機 Worker / D1，刻意丟棄成功回應以測重試；只有測試用 proxy 將 HTTPS 邏輯 origin 轉接至 loopback HTTP。這不是宣稱讀到真正 Telegram，真正通知仍需以下人工驗收。

## 部署與 Windows 設定順序

1. 先按 Worker README 確認兩把獨立 Secrets、device / AUMID allowlist，手動更新 Secrets 與既有 Worker。沒有新 migration，不重建／清除 D1。
2. 正式 `/api/health` 只表示 Worker 可用；再用 `node scripts/admin.mjs status` 驗證 admin key。管理工具僅支援產生器格式 .dev.vars，其他既有格式請用互動 secret put 與自己的受保護 Bearer client。
3. 系統匣結束舊 Agent，VS 重新載入後 Debug／x64 F5，或依既有流程簽署、安裝新版 MSIX。新增測試專案不會被封裝成 App。
4. 展開雲端設定，填 `https://work-notice-api.hui760419.workers.dev`、與 allowlist 相同的 deviceId，從本機編輯器將 **AGENT_HMAC_SECRET 的值**貼入 PasswordBox → 安全儲存。不要填 ADMIN_API_KEY、不要將值貼到聊天／日誌。
5. 等 UI 顯示心跳已確認；首次／重新啟動仍待命。來源已確認、權限允許、Listener Ready 時管理 status 應顯示 STANDBY。

## 人工驗收（本次未替使用者操作）

| 情境 | 預期 |
|---|---|
| 啟動／待命 | 立即心跳，60 秒後仍更新 last_seen；agents 只有一列 |
| 監控 Telegram 新通知 | 本機一筆、雲端成功時間更新、相同 deviceId/eventId 在 D1 一筆、無本文 |
| 未啟用手機警報設定 | 事件可 ACCEPTED，但 should_notify=0 |
| TIMED 150 分鐘 | server-based expiry；有效期內新事件可 should_notify=1；過期 status 立刻 effectiveEnabled=false |
| 關閉設定 | 未來新事件 should_notify=0；不補發歷史、不控制播放中的手機鬧鐘 |
| 待命／重新監控 | 待命只送心跳，不送 alert；切回不補發待命通知 |
| 相同 AUMID／重掃 | 保留原模式規則，不因雲端整合重播 |
| 網路中斷／恢復 | UI 和監聽器正常、失敗可見、有限重試、過期不補發、佇列有上限 |
| 錯 Secret／deviceId | 401／403、不無限重試、不偽裝成功 |
| 正常系統匣退出 | 約 2 秒內結束；若 server ack 成功，STOPPED_BY_USER 不會超時變 OFFLINE |
| 離線時正常退出 | stop 未確認，不能推定雲端已知道主動停止 |
| 強制終止／當機 | 無 stop，超過 180 秒即時顯示 OFFLINE，Cron 只記一次 |
| 再啟動 | 新 session 恢復 STANDBY；舊 session 的 stop 不能覆蓋新 session |
| 通知權限拒絕 | 心跳繼續，顯示 DEGRADED，不偽裝正常監控 |
| 睡眠恢復 | 先建立通知基線再回報，不補發睡眠通知 |
| Secret 保存 | 重啟不用重輸入，JSON 不含明文；不用傳回密文檔作驗收 |

正式 Secrets、正式 Cron 排程、新 WPF 雲端 UI、真正 Telegram → 正式 D1 端到端仍需使用者驗收。本階段沒有 FCM 或 Android。
