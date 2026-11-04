# Work Notice 0.4.0：B1 帶資料升級驗證

2026-11-03，本輪僅變更本機測試、測試打包及文件。未查詢或修改正式 D1、未部署 Worker、未修改 Secrets、未操作手機、未清除配對。Worker src、Wrangler 正式設定、0001～0003 Migration、Android 及 Windows 程式未修改。

## 結論

**PASS：B1 已解除，沒有剩餘 BLOCKER。建議進入另行授權的正式部署階段。**

這是本機升級及相容性證據，不代表已套用正式 Migration，也不代表 Android 0.4.0 實機驗收完成。正式變更前仍需重新核對目標、完成備份／Time Travel bookmark，採 Migration → Worker → 後端唯讀驗證 → APK → 明確採用新期間的順序。

## 執行結果

| 命令 | 結果 |
|---|---|
| npm run test:b1 | 27個子測試通過，Node合計28項，0失敗 |
| npm test | 114項通過，0失敗、0略過；原有86項及新增28項全部通過 |
| node node_modules/typescript/bin/tsc --noEmit | 通過，exit code 0 |

B1 已在不同UUID的隔離庫執行兩次；第一次獨立執行，第二次隨完整測試執行。每次均建立新庫、用真實 Wrangler --local 先只套用0001/0002、插入合成資料、關閉workerd、在**同一持久化資料庫**套用0003，再由新舊Worker共用該D1進行驗證。最後再次執行migrations apply --local，所有既有／新增表及Migration ledger均完全不變。

首次成功：56869534-2405-4de0-9fbb-d5a4521c6809。

完整測試成功：68a7c8c9-3b0c-43f7-85f7-ad741728fc33。

完整測試耗時約55.5秒；獨立B1約22.5秒。初次受限沙箱無法完成本機workerd/localhost通訊，允許本機子程序及loopback後完成；最終沒有未解決的測試失敗。

## 升級瞬間的資料完整性

以下是在行為測試開始前立即比對的0002與0003快照。每張表除了筆數，還以主鍵排序，將所有原有欄位逐值深度比對，並計算完整列JSON的SHA-256。十張表的升級前後雜湊全部相同。新增的push_jobs欄位另行檢查。

| 表 | 升級前 | 升級後 | 原有欄位內容 |
|---|---:|---:|---|
| agents | 4 | 4 | 完全相同 |
| alert_events | 8 | 8 | 完全相同 |
| alert_settings | 4 | 4 | 完全相同 |
| request_nonces | 4 | 4 | 完全相同 |
| agent_status_transitions | 4 | 4 | 完全相同 |
| android_devices | 8 | 8 | 完全相同 |
| mobile_pairings | 5 | 5 | 完全相同 |
| push_jobs | 6 | 6 | 完全相同 |
| mobile_acks | 7 | 7 | 完全相同 |
| mobile_rate_limits | 2 | 2 | 完全相同 |

裝置資料含4個有效裝置及4筆舊撤銷資料，配對包含已使用及未使用的合成資料。設定含OFF、UNTIL_MANUALLY_DISABLED、未到期TIMED、已到期TIMED。推播工作包含PENDING 2筆、RETRY 2筆、SENT_TO_FCM 1筆、EXPIRED 1筆；ACK包含全部四種狀態。舊工作的狀態、attempts、期限、錯誤原因及sent_at_ms均原樣保留。

FCM使用測試執行時隨機產生的AES-GCM金鑰加密合成Token。所有有效裝置的ciphertext、bearer hash、token_version、fcm_version逐值相同，升級後可還原原合成Token；錯誤金鑰解密會失敗。沒有正式Secret依賴，報告不保存測試金鑰或私鑰。

舊表的原有欄位定義、PK、完整index_list/index_xinfo（含partial unique index）、foreign_key_list均相同。既有NOT NULL、PK、UNIQUE與CHECK限制以失敗寫入實際驗證，失敗後再比對快照確保沒有副作用。

## 新結構及行為

- monitoring_settings及monitoring_commands存在且初始為空；舊設定沒有被自動採用或關閉。
- push_jobs新增monitoring_session_id、monitoring_revision、occurred_at_ms，原有六筆工作的三個欄位均為NULL。
- 六個Trigger的SQL逐一與Migration來源比對；cancel_disabled_pushes及enqueue_mobile_offline與0002完全相同。
- Migration ledger由0001/0002增為0001/0002/0003，前兩筆內容未改。
- 舊、新Worker皆能讀取與變更legacy OFF／持續／TIMED；未採用新模型時，其事件判斷、去重、待送工作及推播仍正常。
- 新GET回預設OFF/revision0，不寫入monitoring_settings、不停用舊設定。
- 第一次IMMEDIATE採用會原子關閉legacy、作廢舊PENDING/RETRY，保留已發送歷史及裝置資料；新版legacy mobile/admin寫入均409。
- IMMEDIATE、SCHEDULED、OFF、session替換、revision、命令重試、不同內容重用ID、CAS衝突／並發勝者及撤銷均通過。
- 預約前事件、前一秒延遲送達、舊事件重試不補發；到點GET不產生工作或通知；開始後新事件才推送。
- 舊session/revision、過期來源、最後發送檢查期間取消均不推送；作廢工作不復活。

兩個實際workerd執行入口皆使用原有handle及dispatchPush函式；測試adapter只提供可信的合成時鐘和明確呼叫dispatcher的本機入口。OAuth與FCM原生fetch全部由outboundService攔截，RSA簽章實際驗證。每次成功B1產生9次Mock FCM請求；真實Google／手機推播為0。

## WARNING：舊版回滾邊界

凍結測試檔來自本機2026-11-02T15:33:34.619Z的Wrangler dev bundle，包含真實舊Worker程式及native-fetch修正，沒有monitoring模型。不是重寫的簡化policy stub。SHA-256為0b5676826fef6238d2e1fe4cb370bf26ed96947acdbf9cb87079313d9bcfdd4d。

它不是正式版本25a61ebf-935e-4b69-9b71-e7c108d11dc9的逐位元封存。本輪不下載正式程式，不把本機舊版驗證宣稱為正式版本雜湊認證。

測試已實際重現：

1. 尚未採用新模型：舊Worker在0003 Schema上可維持legacy讀寫、事件及Mock FCM。
2. 已採用新模型：舊Worker不懂新監控，啟用舊設定會因保護Trigger得到HTTP500/internal_error；新版Worker對同類寫入則明確回409。
3. 舊Worker讀到legacy disabled後，不能建立新工作警報，並會將已排隊的新session工作標為EXPIRED；切回新版也不會復活該工作，需要新的有效事件。

因此採用新模型後應優先向前修正；單純回滾舊Worker不能保證恢復工作警報，也不應透過刪除新表、清除配對或回復資料庫來自動處理。

## 可重複執行方式（PowerShell 5.1）

    Set-Location 'C:\Users\HowardLu\工作鬧鐘\cloudflare\work-notice-api'
    . .\scripts\Use-LocalNode.ps1
    npm run test:b1
    if ($LASTEXITCODE -ne 0) { throw 'B1失敗' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw '完整Worker測試失敗' }
    node .\node_modules\typescript\bin\tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript失敗' }

npm test現改為本機esbuild打包，不呼叫wrangler deploy或deploy --dry-run。新的test:b1也使用相同方式。原deploy:dry-run腳本保留供另行授權的工作流程使用，本輪未執行。

本機D1 helper拒絕非D1、缺少--local、--remote與--preview命令；子程序移除Cloudflare帳號／憑證環境變數，使用工作區內的獨立XDG設定與日誌目錄。B1另使用隨機database_id、獨立Wrangler設定與persist-to，測試不依賴正式帳號授權。

## 證據與修改檔案

完整執行證據：

- artifacts/phase3/b1-worker-full.log
- artifacts/phase3/b1-upgrade-first.log
- artifacts/phase3/b1-upgrade/68a7c8c9-3b0c-43f7-85f7-ad741728fc33/before-0002.json
- 同目錄after-0003.json、result.json；result包含27項結果及逐表比對雜湊。
- 首次成功run亦保存相同結構，供交叉確認可重複執行。

新增：tests/b1-upgrade.test.mjs、tests/helpers/b1-fixture.mjs、tests/fixtures/legacy-worker-0002.mjs、tests/fixtures/README.md、scripts/bundle-test.mjs、本報告。

修改：scripts/wrangler-local.mjs、package.json、package-lock.json、WORKNOTICE-0.4.0-REVIEW.md、WORKNOTICE-0.4.0-VERIFICATION.md。

0001～0003雜湊均與部署前審查相同。沒有修改Migration來讓測試通過。
