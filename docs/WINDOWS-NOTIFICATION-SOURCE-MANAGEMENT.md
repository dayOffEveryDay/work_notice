# Windows 通知來源管理與 UI 整理

2026-11-04，本輪僅修改 Windows Agent 與本機測試，未修改 Android、Worker、D1、Secrets，未啟動實際 Agent 或送出正式測試通知。

## 畫面與操作

- 監控總覽：MONITORING／STANDBY、Telegram、Lark A（Chrome）、Lark B（Brave）各自的儲存啟用狀態與實際觀察狀態，以及雲端連線與心跳。
- 進階設定／通知來源管理：原 Telegram 來源下拉選單與確認按鈕、三來源開關、獨立 Chrome／Brave 信任映射、通知授權與雲端設定。
- 診斷與最近通知：原有最多 200 筆的通知中繼資料紀錄，顯示台灣時間，不讀取聊天本文。

Telegram 保留 `settings.json` 內原有 `TelegramAppId`，不自動改成其他值。舊檔僅有 TelegramAppId 時，TelegramEnabled 預設 true，兩個瀏覽器來源預設停用。不存在來源、尚未觀察到通知、通知授權失敗不會被當作辨識成功。來源匹配仍使用完整 AUMID 的 Ordinal 比對，不依顯示名稱猜測 Telegram。

先讓各瀏覽器實際發出 Lark Windows 通知，再到進階頁選擇對應 AUMID、勾選開關，按「儲存開關並信任所選瀏覽器映射」。編輯中的開關不會提前改變總覽狀態。儲存失敗顯示錯誤並保留實際生效狀態；設定讀取失敗則停用來源寫入，以免覆寫舊資料。

瀏覽器信任是使用者的映射宣告：現有 Windows API 中繼資料無法可靠驗證網站 origin、Lark 帳號或訊息重要性。若其他網站共用該 AUMID，其通知也可能產生本機工作事件。本版拒絕三個來源共用相同 AUMID，不能保證 Chrome／Brave 或不同瀏覽器設定檔必然具有可區分的 AUMID；須由實機觀察確認。

## 基線與相容性

- 重複確認同一 Telegram AUMID 或保存完全相同設定：保持目前模式、不重建基線。
- 真正更換來源或開關：切回待命，沿用原基線、generation 與去重機制，需手動重新開始監控。
- 停用保留 AUMID；修改 Telegram 使用 record with，保留瀏覽器與其他欄位。
- 額外未知設定欄位使用 JsonExtensionData 原樣保留。
- 雲端金鑰仍由原 ProtectedCloudSettingsStore／DPAPI 獨立儲存；來源儲存不操作雲端金鑰檔。
- WindowsNotificationSource、系統匣、MSIX 設定、心跳與正常退出流程均未重寫。

## 雲端限制

現有 Worker `POST /api/alert` 僅接受 `source=TELEGRAM`，並檢查 Telegram AUMID 白名單。因此本輪 Lark A／B **僅建立本機工作事件**，不會觸發 Android 警報，也不會排入雲端 HTTP 重試佇列。Telegram 仍沿用原有 HTTPS 傳送、去重及心跳。

來源代碼為 TELEGRAM、LARK_A_CHROME、LARK_B_BRAVE。CloudTransport 不再將任意來源硬編碼成 Telegram；CloudAgentService 在本機派送後阻止非 Telegram 事件送往現有 Worker。未修改或部署後端。若要 Lark 雲端／手機警報，需另行協調後端白名單、來源契約及手機顯示。

## 建置與自動測試

PowerShell，在專案根目錄執行：

```powershell
. .\scripts\Use-LocalDotnet.ps1
dotnet restore WorkNoticeAgent.sln -p:Platform=x64 -p:NuGetAudit=false -m:1 --disable-parallel --source .tools/nuget
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 -p:UseSharedCompilation=false -m:1 --no-restore
dotnet test WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-build --no-restore -m:1 --logger 'trx;LogFilePrefix=windows-sources-complete' --results-directory artifacts/windows-sources/tests
```

Restore 使用現有本機 NuGet 快取；全新環境沒有快取時請依 README 正常還原 NuGet。此次 Restore 成功；Debug／x64 Build 為 0 warning、0 error；Core 58／58、Windows 8／8，共 **66／66** 通過。比原有 51 項增加 15 項。

涵蓋三來源精確匹配、顯示名稱偽裝、來源開關、重複 AUMID 拒絕、基線與舊通知隔離、相同來源不重設、設定遷移與未知欄位保留、雲端設定檔不變、瀏覽器事件不送 HTTP、不假裝儲存成功、讀取失敗防覆寫、設定重開恢復，以及既有心跳／重試／簽章／DPAPI 測試。

沙箱內第一次 VSTest 在 testhost 連線階段逾時，未執行測試；改在允許本機 testhost 連線的環境執行後全數通過。最終 TRX：`artifacts/windows-sources/tests/windows-sources-complete_*.trx`。

## 修改檔案

- src/WorkNoticeAgent.App/MainWindow.xaml
- src/WorkNoticeAgent.App/MainViewModel.cs
- src/WorkNoticeAgent.Core/Contracts.cs
- src/WorkNoticeAgent.Core/AgentController.cs
- src/WorkNoticeAgent.Core/Cloud/CloudAgentService.cs
- src/WorkNoticeAgent.Core/Cloud/CloudTransport.cs
- tests/WorkNoticeAgent.Core.Tests/AgentTests.cs
- tests/WorkNoticeAgent.Core.Tests/CloudTests.cs
- tests/WorkNoticeAgent.Windows.Tests/WorkNoticeAgent.Windows.Tests.csproj
- tests/WorkNoticeAgent.Windows.Tests/SourceSettingsTests.cs
- tests/WorkNoticeAgent.Windows.Tests/SourceViewModelTests.cs
- docs/WINDOWS-NOTIFICATION-SOURCE-MANAGEMENT.md
- README.md（加入本文件入口）

## 實機仍需驗證

1. 以原 MSIX／Visual Studio Packaging 專案啟動，確認主畫面版面、分頁、縮放與既有 Telegram AUMID 自動保留。不能直接執行未封裝 exe 驗證通知存取。
2. 確認原 Telegram 新通知仍只產生一次工作事件及原雲端警報；監控中重複確認相同來源保持監控。
3. Chrome 與 Brave 分別產生真正 Lark 通知，確認 AUMID 確實可區分後建立映射。測試新通知本機事件、個別停用、未知來源忽略；Lark 不應觸發雲端警報。
4. 變更來源後應待命；重新監控不得補發原通知；重新掃描、睡眠恢復及系統匣退出維持原行為。

本輪沒有執行 MSIX 部署、真正通知或長時間 Telegram 警報驗收。自動測試均使用合成資料與 Mock HTTP，不能代替這些實機驗證。
