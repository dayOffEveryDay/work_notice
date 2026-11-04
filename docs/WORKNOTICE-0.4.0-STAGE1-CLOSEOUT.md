# Work Notice 0.4.0：第一階段收尾指令與影響範圍

## 本次交付狀態

**這輪僅準備及本機驗證，未執行正式環境收尾。等待使用者確認後才執行。**

本機驗證46項全部通過（既有31項加收尾15項）；Windows PowerShell 5.1已成功執行預覽模式。沒有正式Cloudflare請求、SQL重匯出或原備份改寫。

原request_nonces 5→6差異已依本次使用者指示，記為「已審查並接受的原備份時間窗漂移」。僅適用這一項確定差異，不接受其他舊快照Schema、ledger或筆數差異。

## 指定原備份與不可修改項目

原目錄：

    C:\Users\HowardLu\工作鬧鐘\artifacts\production-backups\20261103-191044-940e277453194c0abc1a4337be656530\

保留work-notice-db.sql、manifest.json、work-notice-db.sql.sha256、worker-before.json、restore-check.json及原路徑。收尾前後逐檔驗證SHA-256，原manifest仍保留STOPPED，以獨立的新收尾報告補記後續驗收結果。

原SQL SHA-256：

    d33403aed9bcc6fc2b3efafe55c6f8522943a583e456e80f73bdded4984d9091

收尾不執行舊Backup-ProductionD1.ps1 -Execute，不重新匯出或重新還原。先在本機唯讀重驗原備份及既有還原庫，再只讀正式身分、版本、Schema、ledger和筆數，最後取得最新bookmark。

## PowerShell 5.1指令

可現在執行的預覽，不連線正式環境：

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Complete-ProductionBackup.ps1
    if ($LASTEXITCODE -ne 0) { throw '本機收尾預覽失敗，請停止。' }

**以下正式唯讀收尾指令僅供審查，等待使用者明確確認後才執行：**

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Complete-ProductionBackup.ps1 -Execute
    if ($LASTEXITCODE -ne 0) { throw '第一階段收尾停止；不得開始第二階段。' }

-Execute只開啟這個獨立收尾程序的正式唯讀查詢，不會呼叫舊備份流程。沒有匯出、Migration、deploy、Secrets修改、PUT、APK或ADB命令；沒有本機SQL重匯入。每個正式動作之前顯示目標與READ/SELECT ONLY範圍，任何未審查差異或錯誤即停。

## 待核對的正式目標

| 項目 | 基準 |
|---|---|
| Account ID | 2b8372ca98f3e47edbffb37a04fa5a5f |
| Worker／環境 | work-notice-api／預設環境，不使用 --env production |
| Version ID | 25a61ebf-935e-4b69-9b71-e7c108d11dc9，100%流量 |
| D1名稱／UUID | work-notice-db／27e8ee1c-bcb7-4ee5-94d7-40c589480395 |
| binding | DB，必須指向上述UUID |
| Migration ledger | 只有0001_init.sql與0002_android_fcm.sql，含原id／applied_at |
| 尚未套用 | 0003_scheduled_activation.sql |

表格是審查基準，**不是這輪重新查得的正式結果**。

## 每個正式動作及影響

| 順序 | 動作 | 目標與影響 |
|---|---|---|
| 0 | 本機原備份驗證 | 只讀原SQL、sidecar、manifest、既有隔離SQLite及歷史metadata；驗證原檔與唯一已審查漂移 |
| 1 | whoami --json | Cloudflare登入及Account唯讀檢查；不輸出原始回應／email／授權資料 |
| 2 | deployments list | work-notice-api最新版本及100%流量，必須吻合基準 |
| 3 | versions view | 核對指定Version與DB binding／UUID／非敏感vars／Secret名稱；不讀取Secret內容 |
| 4 | d1 info | 核對work-notice-db實際UUID；只讀中繼資料與使用統計 |
| 5 | 固定SELECT ledger／Schema／COUNT | 僅上述正式D1，rows_written必須0且changed_db=false。Schema與原匯出快照逐物件比較，ledger必須仍為0001／0002 |
| 6 | 再讀deployments list | 確認本次收尾期間沒有deployment更換 |
| 7 | d1 time-travel info | 取得最新bookmark，記錄請求與接收完成時間（UTC）；不呼叫restore |
| 8 | 本機收尾報告 | 新增私人子目錄及報告；再驗證原檔SHA-256未變，完成後停止 |

不匯出，所以不會觸發SQL export的資料庫阻擋；唯讀查詢仍有一般讀取用量及短暫查詢負載。既有Windows、Cron及真實工作流量繼續運作；本程序不主動觸發警報。

## 差異判定與停止條件

- 原備份還原：仍須完整逐值、結構、PK／索引／約束、自增序號與檔案雜湊PASS。
- 原匯出前→匯出快照：只接受request_nonces 5→6；其餘未知差異停止，不重設基準。
- 目前正式環境：帳號、版本、UUID、binding、Schema、ledger任一差異停止。0003已套用也停止。
- 較晚的正式事件／ACK／nonce／具有保留期限資料筆數：逐表記錄SQL快照值、目前值、delta與查詢時間，列為WARNING，不假稱知道是哪個請求造成，不視為備份還原失敗。
- 裝置／設定成員數（agents、android_devices、alert_settings）改變，或沒有自動清理的agent_status_transitions筆數減少：屬未知差異，停止並要求審查；不把它們一律解釋為正常流量。
- 其他Schema／ledger差異會列安全物件名稱、Migration ID及差異欄位類別，不輸出DDL、實際資料列、Token或密文。

## 時間點與輸出

原SQL匯出完成於2026-11-03T11:10:58.263Z（台灣19:10:58.263）。**這是匯出完成時間，不是精確快照時刻**；精確SQL快照時間未另存。

收尾時的新Time Travel bookmark是另一次正式查詢取得的較晚恢復點。將分開記錄requestedAt／retrievedAt（UTC），不能宣稱與舊SQL是同時或同一個原子快照。

原目錄內新增以下私人子目錄，不覆寫原檔：

    closeout-<UTC時間>-<GUID>\
        stage-one-closeout.json
        FINAL-STAGE1.md
        time-travel-closeout.json
        private-cli-logs\

目錄繼承原私人ACL。執行前先確認原ACL仍受保護、只有執行者及SYSTEM。CLI原始輸出不回傳終端；報告只包含目標識別、Migration、物件差異摘要、筆數、時間、bookmark與檢查結果。

## 最終報告驗收格式（待實際執行填入）

| 項目 | 準備階段狀態 |
|---|---|
| 原備份與既有還原 | PASS（本機重驗） |
| 原nonce 5→6漂移 | REVIEWED_AND_ACCEPTED，僅限原備份時間窗 |
| 帳號／正式Worker版本／D1 UUID／binding | PENDING，這輪沒有正式查詢 |
| 正式ledger只有0001／0002、Schema不變 | PENDING |
| 最新bookmark及取得時間 | PENDING，尚未取得 |
| 其他已知技術BLOCKER | 無；實際查核若不符即記BLOCKER並停止 |
| 第一階段完成 | 尚未完成，需確認後執行 |
| 第二階段 | 未授權，不自動開始 |

全部核對通過後，獨立收尾報告以PASS_WITH_WARNINGS記錄第一階段完成，原manifest保留STOPPED歷史。時間點差異及所有較晚筆數觀察均列WARNING；有未審查差異則報STOPPED／BLOCKER，不放行第二階段。即使成功，第二階段也必須另外取得使用者確認。
