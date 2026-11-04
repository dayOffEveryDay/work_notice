# 第二階段 Worker / D1 基礎驗收

此檔是底座階段歷史紀錄。後續完整 API / Windows 整合已加入，最新結果見 [PHASE2-API-VERIFICATION.md](PHASE2-API-VERIFICATION.md)。

日期：2026-11-02（Asia/Taipei）。本次範圍為 Worker 專案、既有 D1 binding、原始 SQL migration、本機驗收及遠端操作文件；未修改 Windows C# 監聽或 MSIX。

## 環境

- 專案：`cloudflare/work-notice-api`。
- Node 24.22.2（專案內官方可攜版，官方 ZIP SHA256 已核對）、Wrangler 4.156.1、TypeScript 7.0.2。
- 原 Node 22.12.0 執行安裝與 Wrangler 腳本時發生 0xC0000005；改用工作區 Node 24 解決，未更動系統 Node。最初不完整 lockfile 已修復，乾淨 npm ci 已驗證。
- 使用提供的 `docs/WorkNotice_Phase2_Codex_SPEC_v1.md` 與同行 SQL；SQL 複製後位元組完全一致，SHA256 為 `F2CEE7B6A0D6AF65E76D3C13F3E0B91B52DCD2C2B1221D03A90E2A87B023E3C9`。

## 已完成

設定 Worker `work-notice-api`，D1 binding `DB`，名稱 `work-notice-db`，ID `27e8ee1c-bcb7-4ee5-94d7-40c589480395`，開發 remote=false。

五張業務表：

| 表 | 驗證重點 |
|---|---|
| agents | device_id 主鍵、預設待命／ERROR／UNKNOWN／來源未確認、UTC epoch ms |
| alert_events | device_id + event_id 複合主鍵、同裝置拒絕重複、不同裝置可用同 event_id、required 欄位、預設不通知 |
| alert_settings | 預設關閉、mode 預設、TIMED expiry 儲存、enabled 僅允許 0/1 |
| request_nonces | device_id + nonce 複合主鍵、到期時間與清理索引 |
| agent_status_transitions | 自增唯一 ID、狀態與觀察時間儲存 |

保留 SQL 的兩個索引，沒有新增 FOREIGN KEY，允許事件／nonce 先於 agents 記錄存在。列舉值驗證、裝置 allowlist、Cron 冪等狀態轉換與到期清理是後續 API 層工作；本次不以 DB 建表宣稱這些行為已完成。

## 已執行的命令與結果

於 Worker 目錄：

```powershell
. ./scripts/Use-LocalNode.ps1
npm ci --no-audit --no-fund
npx wrangler d1 migrations apply DB --local
npm test
npm run test:local
npm run deploy:dry-run
npx wrangler d1 migrations apply DB --local
```

- npm ci 成功，package-lock 可重現。
- 本機初次 migration：0001_init.sql 成功。D1 系統／紀錄表另計，不與五張業務表混淆。
- npm test：**14 通過、0 失敗、0 略過**，約 52.6 秒。10 項使用真實 Wrangler 本機 D1 的 migration/schema 測試，4 項設定與 Worker 路由測試。沒有以 SQLite mock 冒充 D1 migration 成功。
- migration 二次套用：`No migrations to apply`；既有資料保持不變，d1_migrations 中該檔僅一筆。
- 測試資料使用 `.wrangler/schema-tests/<run-id>` 隔離。開發狀態 `.wrangler/state` 五張業務表各 0 筆，未混入測試資料。
- 真實 Wrangler 本機 `/api/health` 回 `{status: ok}`，本機 D1 SELECT 1 成功；其餘 API 尚未實作，保持 404。
- Wrangler deploy --dry-run 成功，輸出顯示 `env.DB (work-notice-db)`；未 upload／deploy。

## 遠端與剩餘工作

未登入使用者 Cloudflare，未建立／刪除資料庫，未執行任何遠端 D1 指令或部署。正式 DB 是否目前沒有表仍來自使用者描述，未把本機查詢誤當成遠端查詢。

請由使用者先確認本地驗收結果，再依 Worker README 執行：登入／核對帳號與 DB ID → 唯讀查正式 schema 與待套用 migration → 遠端 apply → 查表與 migration 紀錄 → 部署基礎 Worker → 實際 URL 的 /api/health。

完整第二階段仍需後續實作 HMAC / nonce 請求驗證、alert / heartbeat / status / settings API、Cron、Windows HTTPS Dispatcher / Heartbeat / Secrets 與端到端實機測試。現在尚未啟用 cron，避免未完成的 scheduled handler 被正式排程；沒有 Android/FCM。
