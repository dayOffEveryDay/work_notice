# Work Notice 0.4.0：第一階段備份 mismatch 診斷

## 結論

**還原驗證：PASS。原備份仍可使用，未發現SQL匯出快照到本機還原之間的資料遺失。第一階段仍為STOPPED，不能繼續部署。**

根因是先前驗證程式將「匯出前正式查詢」當成「SQL匯出當下快照」的預期內容。這兩個時間點之間request_nonces從5筆增加為6筆，導致統一deepEqual報出還原mismatch。SQL檔本身已有6筆，本機也正確還原6筆，並非還原時多建一筆或漏資料。

本輪只讀原私人SQL、manifest、私人CLI中繼資料日誌及既有隔離本機SQLite。沒有重新讀取／匯出正式D1，沒有執行Migration、部署、Secrets操作或手機操作。檢查時未輸出資料列、ciphertext、Bearer hash、Token或SQL備份內容。

## 原因與程式碼位置

原scripts/production-backup.mjs的判斷：

    equal(restored, before, 'Local restored schema/ledger/counts');

before來自正式SELECT完成於19:10:53.247；SQL匯出完成於19:10:58.263；本機還原完成於19:11:00.284（均台灣時間UTC+8）。這不是同一原子快照。備份期間新合法請求會增加nonce；持續Heartbeat符合此現象，但僅靠本次產物無法斷定新增nonce一定對應哪個HTTP請求。

另一個診斷缺陷是原equal將Schema、ledger、筆數合併成單一錯誤，且沒有直接保存完整before metadata。此次幸好從既有private-cli-logs中恢復該次SELECT的完整結構／ledger／筆數，與manifest吻合，無須重新查正式資料庫。

## mismatch安全摘要

| 類別 | 匯出前 → SQL快照 → 既有本機還原 |
|---|---|
| Schema | 完全相同：11張表、5個具名索引、3個Trigger；沒有缺少／多出／改變物件 |
| Migration ledger | 完全相同：ID1 0001_init.sql、ID2 0002_android_fcm.sql，含applied_at |
| request_nonces | **5 → 6 → 6** |
| 其餘九張業務表筆數 | 全部相同 |
| SQL快照與本機全部資料欄位 | 十張業務表加d1_migrations，全數一致 |
| PK／索引／約束 | 全數一致，包含sqlite_autoindex的PK／UNIQUE資訊 |
| sqlite_sequence | 相同；沒有漏檢AUTOINCREMENT後續ID狀態 |
| quick_check／foreign_key_check | ok／零筆違規 |

| 表 | 匯出前 | SQL快照 | 本機還原 |
|---|---:|---:|---:|
| agents | 1 | 1 | 1 |
| alert_events | 68 | 68 | 68 |
| alert_settings | 1 | 1 | 1 |
| request_nonces | 5 | 6 | 6 |
| agent_status_transitions | 18 | 18 | 18 |
| android_devices | 1 | 1 | 1 |
| mobile_pairings | 1 | 1 | 1 |
| push_jobs | 61 | 61 | 61 |
| mobile_acks | 90 | 90 | 90 |
| mobile_rate_limits | 0 | 0 | 0 |
| d1_migrations | 2 | 2 | 2 |

全欄位比對在記憶體中處理，以保留型別的多重集合摘要比較，包含int64及BLOB，不回傳任何欄位值或資料列。這證明匯出檔與本機還原相符；因匯出前沒有完整資料列快照，不宣稱已比對所有匯出前正式資料列，也沒有取得正式加密金鑰測試Token解密。

## 原備份與產物

私人備份目錄：

    C:\Users\HowardLu\工作鬧鐘\artifacts\production-backups\20261103-191044-940e277453194c0abc1a4337be656530\

SQL檔78,426 bytes；目前檔案、manifest及.sha256 sidecar一致：

    d33403aed9bcc6fc2b3efafe55c6f8522943a583e456e80f73bdded4984d9091

SQL與原manifest沒有修改，原manifest仍為STOPPED。新增local-verification-diagnosis.json只保存安全分類、筆數、物件名稱及一致性布林結果。

D1平台_cf_*表與Wrangler cache／metadata.sqlite是平台儲存資訊，不當成應用程式還原資料；應用程式主鍵／UNIQUE自動索引另用PRAGMA檢查，不因名稱sqlite_開頭而略過。sqlite_sequence亦獨立比較，避免把重要自增狀態當成內部雜訊忽略。

## 修正

- 新增scripts/backup-verification.mjs：將原SQL載入禁止ATTACH／外部檔案操作的記憶體SQLite，與既有隔離庫readOnly連線比對。只讀本機檔案，不啟動Worker、不連線Cloudflare。
- 修改scripts/production-backup.mjs：匯出快照還原驗證與時間窗漂移分開；新增安全Schema／ledger／筆數差異摘要，直接保留各時間點metadata；不再以舊正式SELECT直接判斷還原資料損壞。
- 修改scripts/Backup-ProductionD1.ps1：新增-DiagnoseExisting離線模式，與-Execute互斥。
- 新增scripts/tests/backup-verification.test.mjs：19項合成回歸測試。
- 更新第一階段操作文件與本報告。

沒有放寬驗收：錯誤ciphertext／Bearer hash、相同筆數但內容不同、漏Trigger／索引／表、約束變更、ledger不同、錯誤nonce新增、sequence不同、SQL雜湊不同仍FAIL。正式時間窗的nonce漂移也沒有被忽略或自動接受；未經審查仍STOP。

## 測試結果

    node --test scripts/tests/production-backup.test.mjs scripts/tests/backup-verification.test.mjs

31項全部通過，0失敗。包含原12項與新增19項，完全使用合成資料／本機SQLite，不依賴正式Secret。

Windows PowerShell 5.1實際執行既有備份離線診斷通過：EXPORT_SNAPSHOT_TO_RESTORE=PASS，PRE_EXPORT_TO_SNAPSHOT僅request_nonces 5→6；SQL、原manifest及資料庫邏輯內容不變。Worker業務程式、Wrangler設定、Migration及Android／Windows均未修改。

重複離線檢查指令（PowerShell 5.1）：

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Backup-ProductionD1.ps1 -DiagnoseExisting 'C:\Users\HowardLu\工作鬧鐘\artifacts\production-backups\20261103-191044-940e277453194c0abc1a4337be656530'

這是離線診斷，不是第一階段重跑；不加-Execute，不重新匯出或讀取正式D1。

## 是否需要重跑第一階段

**不用為修復此次還原mismatch重新匯出，現有備份已完整讀入且可保留。**

但原流程在錯誤處停止，沒有執行正式後置版本／資料檢查，也尚未取得Time Travel bookmark，且已有明確時間窗漂移。此次原產物足以定位根因及驗證還原，不足以把第一階段改成完成。

需另行確認後，決定補辦未完成的唯讀檢查／恢復點，或若要求重新取得最新且符合既定無筆數漂移條件的部署前備份，再重跑第一階段。這輪不接受新基準、不自動補查或重匯出，也不放行第二階段。
