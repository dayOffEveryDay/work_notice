# Work Notice 三來源雲端整合交付

日期：2026-11-04（Asia/Taipei）。原始碼：C:/Users/HowardLu/工作鬧鐘。

## 結果與版本

Windows Agent、Worker 與必要測試已修改；Telegram、Lark A（Chrome）、Lark B（Brave）共用原 HMAC HTTPS 佇列、重試、D1 outbox 與 FCM WORK_ALERT 流程。Lark 保留真正來源代碼，不偽裝 Telegram。

- Windows 現有安裝：1.0.0.0（唯讀 Get-AppxPackage 查詢），未更新安裝、未啟動正式 Agent。
- 待安裝產物：1.0.1.0，Release／x64、self-contained、未簽署 MSIX。AssemblyVersion／FileVersion 同為 1.0.1.0。
- Android 0.4.1.1：原始碼、APK、手機設定均未修改或操作。
- 正式 Worker、遠端 D1、Secrets：未查詢、未寫入、未部署；沒有發送正式 FCM／Telegram 測試警報。
- 正式接通尚待操作者完成後端部署、Windows 安裝與實機驗收。本機 Mock FCM 成功不能作為手機已響鈴的證據。

## 事件格式與完整路徑稽核

Windows POST /api/alert 仍只送六個欄位：eventId（64 位小寫 hex）、deviceId、source、aumid、notificationId（UInt32）、occurredAt（UTC ISO 8601，C# 七位小數）。不送通知正文、標題、對話或發送者。

source 僅允許 TELEGRAM、LARK_A_CHROME、LARK_B_BRAVE。來源開關仍存於原 settings.json，各自獨立；真正變更設定會回到 STANDBY 並重建基線。三來源不可共用 AUMID。

已唯讀確認本機現有來源設定：TelegramAppId=Telegram.TelegramDesktop，LarkChrome.AppId=Chrome，LarkBrave.AppId=Brave，三者 Enabled=true。未修改此設定檔。待部署 wrangler.jsonc 對應：

| 來源 | Worker 白名單變數 | 本機已確認 AUMID |
|---|---|---|
| TELEGRAM | ALLOWED_TELEGRAM_AUMIDS | Telegram.TelegramDesktop |
| LARK_A_CHROME | ALLOWED_LARK_A_CHROME_AUMIDS | Chrome |
| LARK_B_BRAVE | ALLOWED_LARK_B_BRAVE_AUMIDS | Brave |

Worker 使用完整 AUMID、區分大小寫精確匹配；Lark 白名單未設定時預設拒絕。來源未知、交叉錯配、同一 AUMID 出現在多來源白名單，一律 400 invalid_source。保留原設備白名單。

### HMAC、安全與去重

原 X-Device-Id／X-Timestamp／X-Nonce／X-Signature 標頭不變。簽章為 v1=HMAC-SHA256(secret, canonical)，canonical 以換行連接大寫 method、pathname、deviceId、timestamp、nonce、原始 UTF-8 body 的 SHA-256。Worker 保留常數時間／WebCrypto 驗證、時間窗 ±300 秒、nonce 原子防重播、HTTPS、8 KiB body、未知欄位拒絕與管理金鑰隔離。

Windows 原 Telegram EventId 演算法完全保留，避免升級後舊事件重新觸發。Lark EventId 的長度前綴 canonical 額外加入來源代碼；保留設備、AUMID、通知 ID、UTC 建立時間。Worker 再將 Lark 的 wire eventId 映射為 SHA-256(source + ':' + wireEventId)，Telegram 保持原值。即使不同來源收到相同 wire ID，也會存成不同 64-hex cloud ID；同來源重試仍只有一筆。D1 主鍵與 Android eventId 格式均不變；Lark API 回傳的 eventId 是 cloud ID，供後續 outbox／FCM／ACK 使用。

### Windows 監控邊界

保留新通知基線、時間與 generation 排除。只有已確認且啟用的 AUMID、MONITORING／READY／ALLOWED 才排入雲端。STANDBY 仍可送心跳，不送工作警報。每次 HTTP 嘗試前再檢查模式、權限、健康、啟用來源、cloud generation、monitoring generation、事件期限。切回待命、停用來源、重掃、重建基線或睡眠恢復後，舊佇列不會在重新監控時補送。

已開始且已由 Worker 接受的網路請求無法由 Windows 撤回；本次保證的是待命後不啟動新的警報傳送／重試。手機側即時 OFF／排程取消仍走既有 session/revision 與推播前 gate。

### 手機監控、配對與 FCM

Worker 仍以 occurredAt 判斷 120 秒事件期限（允許的未來偏差仍為 30 秒），過期事件存 STALE 且不推播。OFF、SCHEDULED 未到 starts_at_ms 不建立可推播 job；到點本身不產生事件。收到時間與通知建立時間都必須不早於開始時間，因此遲到的排程前通知與 OFF 期間事件重試不會在到點後補響。

沿用既有 monitoring session_id／revision、owner_mobile_id、command CAS、配對撤銷、加密 FCM token、job TTL、lease、重試與 OAuth／FCM 安全檢查。FCM 前再次讀取最新監控狀態，取消／改排程／換 session 或 revision 後拒絕舊 job。FCM data payload 仍為 WORK_ALERT 與既有 64-hex eventId／issuedAt／expiresAt／monitoringSessionId／monitoringRevision／monitoringStartsAtMs／monitoringMode／monitoringCommandId／occurredAt／serverNowMs；不要求 Android 新增來源欄位或改版。

## 新增 migration 與心跳相容性

0004_agent_sources.sql 僅 ADD COLUMN agents.enabled_sources TEXT，nullable、無預設回填。原 Telegram 確認欄位保持真實，不把 Lark 確認寫成 Telegram。

新版心跳增加可選 enabledSources 清單（最多三種合法、不可重複來源）；新 AgentController 一律提供目前已確認且啟用的來源。Lark-only 可判為正常監控；空清單判為 DEGRADED。缺少或 null 時沿用舊 Telegram 確認語意，因此舊 Agent 可繼續使用更新後的 Worker。舊心跳正常退出 stale_session 檢查保留。

## 本機測試證據

| 驗證 | 結果 |
|---|---|
| Windows Debug/x64 建置 | 成功，0 warning、0 error |
| Windows Core xUnit | 70/70 通過 |
| Windows／設定／ViewModel／DPAPI xUnit | 8/8 通過 |
| Worker TypeScript 建置與本機 esbuild bundle | 成功 |
| Worker 全部測試（含來源與 0002→0004 持久化升級） | 124/124 通過 |
| native workerd 三來源→合成配對→加密 token→Mock OAuth／FCM | 通過，3 來源／3 推播 |
| 真正 C#→HMAC HTTP→本機 workerd／D1→Mock native OAuth／FCM | 通過，6 HTTP 嘗試／3 事件／3 推播 |
| Release/x64 MSIX | 成功，0 warning、0 error |
| 封裝依賴驗證 | 232 個 managed runtime assemblies 存在且版本符合 |
| MSIX 靜態檢查 | 1.0.1.0，未簽署，含 App／Core／Windows DLL |

測試涵蓋：三來源精確與錯誤白名單、預設拒絕與重疊拒絕、各來源個別開關、standby／舊 generation／重試時待命、相同 wire ID 的跨來源獨立去重、重試保持 eventId、HMAC 竄改與 nonce 重播、事件過期、OFF／排程邊界／到點不補響、遲到舊通知、錯誤 session／revision、最後送出前取消、配對撤銷、FCM 錯誤處理、舊 Agent／舊 Worker schema 升級回歸。

所有新安全測試使用合成金鑰、隔離本機 D1。native OAuth／FCM 外送由測試服務攔截，沒有觸及 Google 或正式資源。系統 Node 22.12.0 在 TypeScript 程式中崩潰；最終測試使用專案既有 .tools/node-v24.22.2-win-x64，未更動全域 Node 或依賴版本。VSTest／workerd 使用允許本機子程序連線的執行環境。

重現命令（專案根目錄）：

```powershell
. ./scripts/Use-LocalDotnet.ps1
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 -p:UseSharedCompilation=false -m:1 --no-restore
dotnet test WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-build --no-restore -m:1
$env:PATH = "$PWD/.tools/node-v24.22.2-win-x64;$env:PATH"
Set-Location cloudflare/work-notice-api
npm test
node scripts/test-agent-integration.mjs
```

## 待部署變更與操作者順序（本次未執行）

1. 審核本報告、patch、實際 ledger／既有備份與本機測試證據。舊 production-backup／closeout 腳本固定到 0003 的預期基準，不能直接作為本輪發佈程序；它們會拒絕新增 0004 的狀態，需另行更新發佈計畫，不能略過保護。
2. 由操作者確認正式 0001～0003 已套用後，再安排 0004；若 ledger 不是此狀態，先處理差異。不得重建 D1。0004 只增 nullable 欄位，既有資料、索引、主鍵、monitoring trigger、pairing、token、Secrets 不需更動。
3. 審核並部署 Worker：src/index.ts、security.ts、database.ts；vars 增加 Lark A=Chrome／Lark B=Brave 的精確白名單。維持現有 DB binding、device 白名單、Telegram 白名單、FCM project、cron、HMAC／FCM Secrets。
4. Worker 通過部署後檢查，才由操作者簽署並安裝 Windows 1.0.1.0。不要先裝新版 Windows 接舊 Worker：舊 Worker 會拒絕 enabledSources 心跳與 Lark 事件。未簽署 MSIX 不能直接一般側載；本次未產生／信任憑證。
5. 手機維持 Android 0.4.1.1。之後由使用者驗收 Telegram 回歸、Lark A／B 各自新通知、個別開關、Windows STANDBY、手機 OFF、排程前／到點／到點後新通知、重掃／睡眠恢復與重試去重。驗收應比對 D1 event→job→FCM／手機 ACK，再確認實際響鈴。

回退：可回到舊 Windows／Worker；0004 nullable 欄位可保留，不應刪欄或還原整個 D1。回退前仍需審核當時 pending jobs／監控狀態，本次未替操作者執行回退。

## 可辨識範圍

Windows 通知 API 現有中繼資料無法證明網站 origin 或 Lark 帳號；目前實機確認的 AUMID 是通用 Chrome／Brave。與其共用 AUMID 的其他網站通知也會被視為對應來源。此限制已保留於 UI；白名單代表操作者明確信任此映射，不能宣稱已完成網站層身分驗證。沒有為此操作瀏覽器或手機。

## 修改檔案清單

- `README.md`
- `cloudflare/work-notice-api/README.md`
- `cloudflare/work-notice-api/migrations/0004_agent_sources.sql`
- `cloudflare/work-notice-api/migrations/README.md`
- `cloudflare/work-notice-api/scripts/migrations.mjs`
- `cloudflare/work-notice-api/scripts/test-agent-integration.mjs`
- `cloudflare/work-notice-api/src/database.ts`
- `cloudflare/work-notice-api/src/index.ts`
- `cloudflare/work-notice-api/src/security.ts`
- `cloudflare/work-notice-api/tests/b1-upgrade.test.mjs`
- `cloudflare/work-notice-api/tests/helpers/b1-fixture.mjs`
- `cloudflare/work-notice-api/tests/runtime-fcm.test.mjs`
- `cloudflare/work-notice-api/tests/sources.test.mjs`
- `cloudflare/work-notice-api/wrangler.jsonc`
- `docs/LARK-CLOUD-INTEGRATION.md`
- `packaging/WorkNoticeAgent.Package/Package.appxmanifest`
- `src/WorkNoticeAgent.App/MainViewModel.cs`
- `src/WorkNoticeAgent.App/MainWindow.xaml`
- `src/WorkNoticeAgent.App/WorkNoticeAgent.App.csproj`
- `src/WorkNoticeAgent.Core/AgentController.cs`
- `src/WorkNoticeAgent.Core/Cloud/CloudAgentService.cs`
- `src/WorkNoticeAgent.Core/Cloud/CloudTransport.cs`
- `src/WorkNoticeAgent.Core/Cloud/RequestSigning.cs`
- `src/WorkNoticeAgent.Core/Contracts.cs`
- `tests/WorkNoticeAgent.Core.Tests/AgentTests.cs`
- `tests/WorkNoticeAgent.Core.Tests/CloudTests.cs`
- `tests/WorkNoticeAgent.IntegrationProbe/Program.cs`
- `tests/WorkNoticeAgent.Windows.Tests/SourceViewModelTests.cs`

MSIX SHA-256：`4bf86b0316513345341394d2fe1ca9ab6ac508f1179cbd51c010e0ab5630cd9d`
