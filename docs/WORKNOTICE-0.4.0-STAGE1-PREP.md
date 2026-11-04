# Work Notice 0.4.0：正式部署第一階段操作內容（尚未執行）

> 後續狀態更新：使用者已於2026-11-03 19:10執行第一階段，舊比對在還原檢查時停止。本機離線診斷確認原SQL備份完整、還原PASS，原因是匯出前nonce 5筆與匯出快照6筆的時間差。第一階段仍未完成；詳見 [備份診斷報告](WORKNOTICE-0.4.0-BACKUP-DIAGNOSIS.md)。下文「尚未執行」描述最初準備階段，不代表這次最新執行結果。

> 目前只允許補辦收尾，禁止重匯出：請使用 [獨立收尾指令](WORKNOTICE-0.4.0-STAGE1-CLOSEOUT.md)，不要再執行本文舊版Backup-ProductionD1.ps1 -Execute。收尾指令同樣須先取得使用者確認。

本文件是核准前的操作交付。這輪只完成本機設定／雜湊檢查、合成回應測試及PowerShell 5.1預覽；沒有重新查詢正式環境、沒有正式SQL匯出，沒有讀入正式備份。實際備份路徑、正式最新版本／筆數、bookmark及恢復結果均須取得使用者確認後才產生。

本機驗證：12項合成回應／命令白名單測試全部通過；Windows PowerShell 5.1預覽成功；私人目錄ACL與拒絕覆用既有目錄也已在空白本機測試目錄實際驗證通過。這些測試沒有呼叫Wrangler或正式API，沒有建立正式備份。

## 待執行目標及基準

| 項目 | 必須吻合的先前審查基準 |
|---|---|
| Cloudflare Account | 2b8372ca98f3e47edbffb37a04fa5a5f |
| Worker／環境 | work-notice-api；預設環境，沒有 --env production |
| 100%正式流量版本 | 25a61ebf-935e-4b69-9b71-e7c108d11dc9 |
| D1名稱／binding | work-notice-db／DB |
| 正式D1 UUID | 27e8ee1c-bcb7-4ee5-94d7-40c589480395 |
| 已套用 | 0001_init.sql、0002_android_fcm.sql（含已記錄的id／applied_at） |
| 唯一待套用 | 0003_scheduled_activation.sql |
| 0003 SHA-256 | 65FAA1A1817E051E2E58D814065A5DD0B5A95A707BDB63B0F3412618F9FDD303 |
| 已記錄筆數 | agents 1、alert_events 68、alert_settings 1、android_devices 1、mobile_pairings 1、mobile_acks 90、push_jobs 61 |

以上是歷史基準，**不是這輪重新取得的正式結果**。完整可讀基準置於cloudflare/work-notice-api/scripts/production-backup-baseline.json。0001、0002雜湊亦固定檢查，不重新接受變更。

## 每個正式動作的目標與範圍

程序會在每個動作之前輸出目標及影響範圍；以下任一步失敗或不符基準，立即停止，不匯出或繼續下一步，也不自動更新基準。

| 順序 | 目標／動作 | 影響與成功條件 |
|---|---|---|
| 0 | 本機Wrangler設定／SQL雜湊 | 僅讀檔，Worker、DB、vars、Cron、檔案集合與雜湊均一致；沒有環境覆寫 |
| 1 | Cloudflare帳號：whoami --json | 只讀身分中繼資料，仍是先前唯一帳號；不輸出原始回應或email |
| 2 | work-notice-api：deployments list | 只讀，最新deployment只有指定版本且100%流量 |
| 3 | 指定Worker Version：versions view | 只讀，版本、compatibility_date、DB UUID、非敏感vars與Secret名稱一致；不讀Secret內容 |
| 4 | work-notice-db：d1 info | 只讀，實際名稱與UUID吻合 |
| 5 | 指定正式D1：固定SELECT | 讀Migration ledger、Schema及十張表的COUNT；已記錄的七張表筆數必須吻合。SQL回應必須rows_written=0、changed_db=false |
| 6 | 同一正式D1：SQL export | 匯出完整Schema及資料至私人本機檔案，**執行期間會阻擋其他D1請求**；不改表、不寫業務資料。匯出成功且檔案非空才繼續 |
| 7 | 本機備份：SHA-256 | 只讀匯出檔，保存雜湊，不輸出內容 |
| 8 | 隨機本機DB：讀入同一份SQL | 只寫新的隔離本機D1，沒有Worker服務、FCM或對外API；不執行migrations apply |
| 9 | 隔離本機DB：驗證 | 以**同一SQL匯出快照**比對Schema、ledger、所有資料欄位、PK／索引／約束、自增序號及筆數；quick_check=ok、foreign_key_check零筆、SQL雜湊未變。另行分類匯出前正式查詢與快照的時間窗差異，有差異仍STOP待審查 |
| 10 | 正式D1／Worker：再次SELECT與版本檢查 | 只讀；備份期間有Schema、筆數、ledger或deployment變化就停止 |
| 11 | 正式D1：time-travel info | 只讀，取得結束前最新bookmark與UTC擷取時間，保存後停止 |

D1 export會暫時阻擋請求，可能造成Agent短暫重試，應在可接受短暫影響的時段執行。官方依據：[D1匯入與匯出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

目前正式仍可能有Heartbeat／Cron運作。舊筆數可能因正常新事件或清理而變動；依使用者要求，遇到差異依然STOP，不能擅自判為正常並重設基準。未列入歷史基準的request_nonces、agent_status_transitions、mobile_rate_limits會在執行時記錄，其備份前後筆數亦必須相同；若Heartbeat剛好跨越備份時段造成變動，也會停止，需回報後另行決定。

## PowerShell 5.1指令

現在可執行的預覽（只檢查本機，不呼叫Wrangler）：

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Backup-ProductionD1.ps1

輸出必須為PLAN ONLY／local config and migration hashes PASS。ExecutionPolicy Bypass只作用於該子程序，不修改系統執行原則。

**以下指令僅供審查；取得使用者明確確認後才能執行：**

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Backup-ProductionD1.ps1 -Execute
    if ($LASTEXITCODE -ne 0) { throw '第一階段停止；不得進行Migration或部署。' }

腳本未帶-Execute時不建立正式備份目錄、不呼叫Wrangler、不連線Cloudflare。腳本沒有Migration／deploy／Secrets寫入／監控PUT／手機命令；Node層另有固定命令allowlist，拒絕remote --file與Time Travel restore等操作。

## 備份產物與隱私

預計根目錄（尚未建立本次備份）：

    C:\Users\HowardLu\工作鬧鐘\artifacts\production-backups\<時間戳>-<隨機GUID>\

目錄新建且不可覆寫既有備份。寫SQL或其他敏感檔案前，Windows ACL停用繼承，只授予執行者及SYSTEM完整權限；ACL設定失敗就停止。artifacts也列於.gitignore，但Git忽略規則不是加密或安全備份的替代。

產物包含：

- work-notice-db.sql：正式SQL，僅本機私人保管，不貼聊天、不提交Git。
- work-notice-db.sql.sha256：對應SQL的SHA-256。
- worker-before.json：部署前Version ID、deployment ID及目標UUID。
- time-travel-before.json：最新bookmark及擷取時間。
- manifest.json：PASS或STOPPED、已完成步驟、核對筆數、恢復驗證結果。
- metadata-pre-export.json／metadata-restored.json：新版驗證保留各自時間點的結構及筆數，供私下分類比對；不含業務資料列。
- snapshot-comparison.json：新版驗證記錄快照還原與時間窗差異，兩種結果分開。
- restore-check.json及state：隨機隔離本機DB，含正式資料副本，同樣受私人ACL保護。
- private-cli-logs：不對外回傳的診斷目錄，可能含暫時匯出網址等資訊，不得分享。

原始CLI stdout/stderr不輸出到終端、不放入公開報告。尤其Wrangler export可能輸出暫時簽章下載網址，會被擷取後丟棄；失敗只回報步驟名稱及安全錯誤。不要使用Get-Content、type、Start-Transcript或Tee-Object列印SQL或原始CLI日誌。

還原檢查不取得正式加密Secret、不解密FCM Token、不啟動Worker／Cron。成功只代表備份能讀入且Schema、ledger、筆數及SQLite一致性通過，不能宣稱已測試正式Token解密或手機推播。

針對既有私人備份的新版離線診斷，不查詢或匯出正式D1、不重新讀入本機庫，使用原隔離SQLite的readOnly連線。只新增安全診斷JSON，不修改原SQL或manifest；指令見備份診斷報告。

## Time Travel與第二階段閘門

Time Travel本來就自動保存歷史；info是讀取恢復點，這次不呼叫restore。Free／Paid的保留時間不同，需在有效期限內使用。[官方Time Travel文件](https://developers.cloudflare.com/d1/reference/time-travel/)。

最新bookmark與SQL匯出是不同時間點擷取，不能宣稱它們是同一個原子快照。bookmark會記錄擷取時間；恢復到該點會失去後續資料，必須另行規劃及授權。

第一階段成功需manifest.status=PASS、SQL非空且雜湊完整、本機還原驗證PASS、所有基準吻合。完成後另行回報並等待第二階段確認，不自動進行0003或Worker部署。

**目前狀態：本機準備PASS；正式重新核對、SQL備份與正式備份讀入驗證均待執行。尚不可宣稱第一階段完成或直接進入第二階段。**
