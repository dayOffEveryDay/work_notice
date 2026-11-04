# 第二階段 API / Windows 最終本機驗證

2026-11-02，Windows x64。這份紀錄取代先前「僅 Worker/D1 底座」的當前狀態；舊驗證檔保留為歷史紀錄。

## 交付範圍

既有 Worker 新增 HMAC / timestamp / nonce、alert、heartbeat、admin status / settings、每分鐘 Cron。Windows 使用原通知監聽器、來源比對、去重、基線與 IAlertDispatcher，加入背景 HTTPS 佇列、Heartbeat、DPAPI Secret 儲存與雲端 UI。

沒有建立或刪除 Worker / D1，沒有更動 migrations/0001_init.sql，沒有遠端 migration、登入、Secrets 上傳或正式部署。正式網址／D1 狀態為使用者先前提供，本次未將本機結果宣稱為正式端到端測試。

## 真實結果

| 檢查 | 結果 |
|---|---|
| Node / Wrangler 依賴 | Node 24.22.2、Wrangler 4.156.1、TypeScript 7.0.2；最終 npm ci 成功 |
| TypeScript + dry-run bundle | 成功；env.DB 沿用 work-notice-db，name 沿用 work-notice-api |
| Worker 測試 | **28 通過、0 失敗、0 略過**，包含原有 14 項 |
| C# Debug／x64 build | 成功，0 警告、0 錯誤 |
| Core 測試 | **49 通過、0 失敗**，包含原有第一階段／時區／來源切換的 29 項 |
| Windows DPAPI 測試 | **2 通過、0 失敗**；真實 CurrentUser encrypt/decrypt 與損壞密文拒絕 |
| C# → 本機 Worker / D1 | 成功；生產 signer / pipeline，lost ACK 重試後僅一筆事件，heartbeat 與 STOPPED_BY_USER 寫入 |
| Wrangler 本機 HTTP / Cron | 成功；實際 scheduled() 入口兩次只新增一筆 OFFLINE transition |
| 完整 WAP / MSIX | Debug／x64 建置成功；舊 RID / F5 相依輸出檢查保留 |
| MSIX 相依檢查 | 232 個 managed runtime assemblies；App / Core / Windows 與建置輸出 hash 一致；通知及 internetClient capability 保留 |

Worker 測試涵蓋有效、錯誤 key、raw-body tampering、timestamp、nonce 並行防重放、future timestamp 的完整 nonce 保留期、allowlist、格式／8KB、兩把 key 分離、匿名管理拒絕、並行 eventId 唯一性、STALE、settings 持續／TIMED／關閉、Heartbeat STANDBY／DEGRADED／停止／恢復、180 秒邊界、即時計算 OFFLINE、Cron 冪等與清理。資料庫測試使用真正 workerd D1，不以 mock 假裝 SQL 成功。

C# 測試涵蓋 HMAC canonical、UTF-8、穩定 eventId / UTC、4 次有限嘗試、2/5/15 delay、每次 nonce / signature 更新、4xx 不重試、取消／逾期、佇列容量、待命 Heartbeat、periodic timer、正常 stop、2 秒退出界限、錯誤連線不假裝成功、舊設定 ack 不污染新設定、暫停取消到恢復的順序。

## 重現命令與產物

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘/cloudflare/work-notice-api'
. ./scripts/Use-LocalNode.ps1
npm ci --no-audit --no-fund
npm test
npm run test:local
npm run test:agent
```

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘'
. ./scripts/Use-LocalDotnet.ps1
dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-restore -m:1 -p:UseSharedCompilation=false
dotnet test tests/WorkNoticeAgent.Core.Tests/WorkNoticeAgent.Core.Tests.csproj -c Debug --no-build --no-restore --logger 'trx;LogFileName=phase2-core.trx' --results-directory artifacts/TestResults
dotnet test tests/WorkNoticeAgent.Windows.Tests/WorkNoticeAgent.Windows.Tests.csproj -c Debug --no-build --no-restore --logger 'trx;LogFileName=phase2-dpapi.trx' --results-directory artifacts/TestResults
```

完整封裝以 Visual Studio MSBuild.exe 執行 WorkNoticeAgent.Packaging.sln、Configuration=Debug / Platform=x64，紀錄在 artifacts/phase2-msix.binlog。測試方案的 x64 設定將 managed test projects 映射為 Any CPU，直接測 csproj 時勿搭配 --no-build 指向未建置的 bin/x64。

MSIX 位於 `packaging/WorkNoticeAgent.Package/AppPackages/WorkNoticeAgent.Package_1.0.0.0_x64_Debug_Test/WorkNoticeAgent.Package_1.0.0.0_x64_Debug.msix`；目前是未簽署開發產物，不宣稱已完成獨立側載安裝。

## 尚需使用者驗收

先依 [Worker README](../cloudflare/work-notice-api/README.md) 設定兩把獨立 Secrets 並更新既有 Worker，再依 [Windows 人工驗收](PHASE2-INTEGRATION.md) 驗證真正 Telegram、正式 D1、網路中斷、睡眠恢復、正常退出與強制終止。

這一版新的 WPF 雲端設定／實際正式 HTTPS 流程未替使用者部署及操作；未讀取或產生使用者正式 Secrets。本機測試的 keys 是隨機、記憶體限定且僅供隔離 loopback runtime。沒有 FCM 或 Android。
