# 第三階段本機交付與實機驗收

2026-11-02，Windows x64。沿用現有 Windows 專案、Worker / D1 及 Firebase App 註冊。沒有正式 Worker deploy、遠端 D1 操作、正式 Secret 設定、Google service account 建立或真正 FCM send。`google-services.json` 已由 Downloads 複製到 Android app，僅核對專案及 package，不列出內容。

## 本機結果

Android 0.3.3 自動響鈴保留與安全備援改善另見 [PHASE3-ANDROID-RECOVERY.md](PHASE3-ANDROID-RECOVERY.md)，最新建置紀錄 `artifacts/phase3/android-recovery-build.log`。此輪未操作手機／正式雲端。

Android 0.3.2 音訊焦點後續調查與驗證另見 [PHASE3-ANDROID-AUDIO-FOCUS.md](PHASE3-ANDROID-AUDIO-FOCUS.md)，本機 build log 為 `artifacts/phase3/android-audio-focus-build.log`。不代表已在實機鎖屏取得音訊焦點。

Android 0.3.1 背景／鎖屏與 fallback 後續修復另見 [PHASE3-ANDROID-LOCKSCREEN-FIX.md](PHASE3-ANDROID-LOCKSCREEN-FIX.md) 及 `artifacts/phase3/android-lockscreen-build.log`；下方原交付結果不代表此修復已完成實機鎖屏驗收。

FCM 後續修復與最新回歸結果另見 [PHASE3-FCM-FIX.md](PHASE3-FCM-FIX.md) 及 `artifacts/phase3/fcm-fix-tests.log`；下表原始交付結果保留。該修復未更動兩份已正式套用的 migration。

| 項目 | 實際結果 |
|---|---|
| Android Studio 專案 | Java/XML；com.worknotice.alarm；Firebase work-notice-7a5e8 |
| Android 工具鏈 | JBR 25.0.4、Gradle Wrapper 9.4.1、AGP 9.2.1、SDK 37.0 / Build Tools 36.0.0 |
| assembleDebug | 成功；app/build/outputs/apk/debug/app-debug.apk |
| testDebugUnitTest | **19 通過、0 失敗、0 略過** |
| lintDebug | **成功，0 errors、35 warnings**；主要是固定繁中 UI 字串、相依套件可更新及同步安全寫入提示，未隱藏／停用 Lint |
| Worker TypeScript / Wrangler dry-run | 成功，沿用 DB binding 與 Worker 名稱 |
| Worker 測試 | **54 通過、0 失敗、0 略過**，保留原有 28 項並新增 26 項（包含離線 Trigger 調整） |
| Wrangler 本機 D1 | 0001 + 0002 真正套用到隔離本機 D1；重套無資料覆蓋，非 mock SQL |
| Wrangler 真實 scheduled() | HTTP health、SELECT 1、兩次 scheduled 僅一個 OFFLINE transition，成功 |
| C# → 本機 Worker/D1 | 原 signer/pipeline、lost ACK 重試僅一筆 alert、Heartbeat / STOPPED_BY_USER 成功 |
| Windows Restore / Debug x64 Build | 成功，0 警告、0 錯誤 |
| Windows 原有測試 | **Core 49 + Windows DPAPI 2 = 51 通過** |
| Windows MSIX | Debug/x64 封裝成功（未簽章、未部署）；ZIP 內包含 WorkNoticeAgent.Core.dll 與 WorkNoticeAgent.Windows.dll |
| 0001 完整性 | SHA256 與原提供規格 SQL 一致，完全未修改 |
| Android 實機 | ADB 裝置列表空白，**未安裝／未播放／未驗證真正 FCM** |

測試涵蓋：管理配對、雜湊存放、到期與重放、相同 mobileId 並行只能一筆兌換、D1 全域及來源限流、手機 scope／撤銷／失聯手機管理恢復、token AES-GCM／更新與版本競爭、150 分鐘 server deadline、outbox disabled／expired／duplicate／stale gating、關閉再開啟不復活舊工作、lease／跨 dispatcher 去重、crash lease recovery／五次上限、TTL、NOT_CONFIGURED、UNREGISTERED、ACK 冪等、offline 普通警示與 Cron 清理。OAuth Mock 驗證真實 RSA JWT 簽章、scope、快取、到期、401 單次刷新及 403／429／5xx；沒有打 Google 真正端點。

Java 測試涵蓋兩模式、150 分鐘、倒數邊界、去重 ledger 重新載入／上限／清除、過期 payload、重新配對不接受之前配對的在途推播、單 session 合併、停止不關閉未來警報、新 session 不受舊停止 Intent 影響、倒數到期不停止既有 session、權限／降權決策、Mock FGS 拒絕 fallback、token 旋轉與重新取得最新值重試。這些不是實際 Android MediaPlayer／OEM 背景行為的替代驗證。

## 重現與產物

Android 命令見 [Android README](../android/WorkNoticeAndroid/README.md)，Worker 命令與正式步驟見 [部署指南](PHASE3-DEPLOYMENT.md)。Windows：

```powershell
cd 'C:/Users/HowardLu/工作鬧鐘'
. ./scripts/Use-LocalDotnet.ps1
dotnet restore WorkNoticeAgent.sln -p:Platform=x64
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-restore -m:1 -p:UseSharedCompilation=false
dotnet test tests/WorkNoticeAgent.Core.Tests/WorkNoticeAgent.Core.Tests.csproj -c Debug --no-build --no-restore
dotnet test tests/WorkNoticeAgent.Windows.Tests/WorkNoticeAgent.Windows.Tests.csproj -c Debug --no-build --no-restore
```

本機交付 APK 另複製到 `artifacts/phase3/WorkNoticeAndroid-debug.apk`。同資料夾有最終 Android／Worker／MSIX logs 及 Windows TRX；中途失敗的編碼診斷 logs 也保留，請以 `android-final.log`、`worker-final.log`、`worker-local.log` 及最後 TRX 為準。原始 Gradle testsuite XML 與 Lint 報告保留於 app/build；沒有把成功狀態寫死。

離線 Trigger 後續調整：在尚未正式套用的 `0002` 中，運作模式條件改為 `IN ('MONITORING','STANDBY')`，其餘配對、token、撤銷、offline_alerts 與唯一鍵條件保留。此版最新 Worker 回歸紀錄為 `artifacts/phase3/offline-trigger-tests.log`（54/54 通過），Wrangler 隔離本機 D1 migration／scheduled 紀錄為 `offline-trigger-local.log`（成功），取代較早的 50 項 Worker 結果。`0001` SHA256 再次核對相同。這次沒有遠端 D1 操作或 Worker 部署；正式 migration 仍由使用者手動執行。

## 手機與正式端到端驗收（由使用者執行）

完成部署指南中的 migration、Secrets 與 Worker 更新後依序執行：

1. **基本／配對**：安裝 Debug APK；拒絕通知先確認 UI 顯示限制，再允許通知及兩個警報通道。按「只測本機聲音」並停止。建立一次碼、配對、等待 token 已登記；新配對必須仍關閉警報。重用碼／過期碼失敗。重開 App 不必再次輸入 bearer。
2. **Telegram 全程**：手機持續啟用，Windows MONITORING，讓 Telegram 產生真正的新 Windows 通知。D1 ACCEPTED → push_jobs SENT_TO_FCM → mobile ACK RECEIVED／RINGING。確認循環聲音，通知及 App 的停止都有效，停止後未來仍啟用。送新 eventId 再響；重送相同 eventId 不再響。兩個新事件在響鈴中合併，不疊音效。
3. **倒數／停止分離**：先驗證 2:30 對應 150 分鐘與 UTC+8 到期顯示，再用 1 分鐘縮短測試。到期後新事件不響，已響的仍等手動停止。手動關閉未來接收同樣不停止目前聲音。重新開 App／手機後以伺服器到期時間為準。
4. **網路／token**：斷網後恢復，確認 WorkManager 可重試登記及 ACK，Cloudflare 暫時錯誤有 RETRY，逾 120 秒不補響。重新取得 token 後更新成功；撤銷手機後 bearer 讀取失敗，FCM token 清除。解除安裝後要由管理端先撤銷再配對。
5. **Windows 健康**：STANDBY 持續回報 Heartbeat 時不報離線。正常退出 STOPPED_BY_USER 不報異常。分別在 MONITORING 與 STANDBY 強制停止，超過 180 秒後下一次 Cron，手機應各收到一次普通 WINDOWS_OFFLINE，不啟動循環聲；關閉手機 offline_alerts 時不建立離線推播工作。持續失聯及重複 Cron 不重複建立工作；恢復後再次失聯視為新的離線事件。重啟 Windows 並重新整理手機，顯示 STANDBY／MONITORING 恢復；離線提醒開關不延長倒數。
6. **前景／背景／鎖屏**：每個情境都送不同新 Telegram 事件，記錄收到時間、FCM priority、是否響、fallback 與手動停止結果；不是只檢查 FCM 200。

| 實機情境 | 預期／必須記錄 |
|---|---|
| App 前景、背景、鎖屏、螢幕關閉 | 記錄是否收到、是否進入 FGS／聲音、延遲、停止 Action |
| Doze、省電、OEM 自動啟動限制 | 可能延遲／丟棄；過 TTL 不補響，不承諾必達 |
| FCM 實際降為 normal priority | 背景不強行啟動 FGS；高重要性通知 fallback |
| FGS 被系統拒絕 | fallback + App 問題提示，無假 RINGING 成功 |
| 通知授權／通道關閉 | 問題提示；可能連 fallback 都無法展示 |
| 警報音量 0／勿擾／其他 App 搶焦點 | 尊重設定；可能無聲或暫停，ACK 不代表聽見 |
| 從最近使用列表滑掉／系統回收 | 依 OEM 實測，不能假設永久播放 |
| Force stop／手機重啟／沒有 Play Services | 可能無法收訊；需重新開 App、同步狀態／修復服務 |

本版限制：單 Windows 單有效手機；沒有 release signing／Play 發佈、跨 key 自動輪替、Workload Identity、跨 FCM exactly-once 或 100% 即時保證。沒有加入 Firebase Analytics、Android Firebase Auth、Firestore、Lark 或額外 Windows 網路流程。

## 資料夾

```text
android/WorkNoticeAndroid/        Gradle Wrapper、Java/XML App、JUnit
  app/src/main/java/com/worknotice/alarm/
    MainActivity, ApiClient, PairingRepository, DeviceTokenStore
    AlarmPreferencesRepository, CloudSyncWorker, EventLedger/EventStore
    WorkNoticeFirebaseMessagingService, AlarmDelivery/AlarmPolicy
    AlarmPlaybackService, AlarmSession, AlarmStopReceiver, Notices
cloudflare/work-notice-api/
  src/mobile.ts                  配對、AES-GCM、手機 scope/API
  src/fcm.ts                     OAuth/FCM、lease、重試與清除
  migrations/0002_android_fcm.sql 新 schema 與 durable outbox triggers
  tests/mobile.test.mjs           真正本機 D1 + mock Google transport
  scripts/                       配對與 Secrets 手動 helper
src/、tests/、packaging/           原 Windows 工程保留
docs/PHASE3-*.md                 部署與驗收文件
```
