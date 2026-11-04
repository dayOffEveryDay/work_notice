# 台灣時間顯示與來源確認狀態修正

2026-11-02。

## 原因與修改

- 最近偵測紀錄原本直接以 StringFormat 顯示 UTC，最近工作事件時間則使用 ToLocalTime，受電腦時區影響。兩者現在共用 App/Presentation 的 TaiwanTimeDisplay，透過 DateTimeOffset 與 TimeZoneInfo「Taipei Standard Time」轉成 `yyyy-MM-dd HH:mm:ss zzz`，例如 `2026-11-02 11:56:31 +08:00`。表格使用唯讀 WPF converter，最近工作事件時間使用同一 formatter。
- 只在 UI 顯示時計算字串；DiagnosticEvent、WorkAlertEvent、來源通知、去重鍵與日誌沒有改成台灣時間。再次對已為 +08:00 的 DateTimeOffset 格式化也不會再加八小時，跨日會正確處理。不新增 Cloudflare 網路程式，Dispatcher 契約仍保留 UTC。
- ConfirmSourceAsync 原本無條件重建基線並待命。現在相同 AUMID（Ordinal 精確比對）直接返回，不更動模式、generation、去重或基線；UI 不重寫相同設定，顯示維持目前模式。首次確認維持待命；不同 AUMID 仍重建基線並回待命，UI 清楚說明「為避免誤報」及需手動重新開始監控。
- RefreshAsync 原本會短暫發布待命，再恢復監控。現在同步成功前後保持原模式，仍以既有 semaphore 與 generation 阻止同步期間事件轉發；權限撤銷、訂閱或快照失敗仍會安全回待命並顯示異常。

本次未修改正式 WindowsNotificationSource、封裝 manifest、RID 相依修正或通知解析；沒有加入模擬通知到正式程式。

## 驗證結果

```powershell
. ./scripts/Use-LocalDotnet.ps1
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-restore -m:1 -p:UseSharedCompilation=false
dotnet test WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-build --no-restore --logger 'trx;LogFileName=taiwan-time-source-state.trx' --results-directory artifacts/TestResults --blame-hang-timeout 30s
& 'C:/Program Files/Microsoft Visual Studio/18/Community/MSBuild/Current/Bin/MSBuild.exe' WorkNoticeAgent.Packaging.sln /p:Configuration=Debug /p:Platform=x64 /m:1 /v:minimal
```

- Debug／x64 Build 成功，0 警告、0 錯誤。
- 原有 16 項測試保留，加上 5 項時間測試、8 項狀態測試，共 **29 通過、0 失敗、0 略過**。
- 時間測試編譯連結實際 App UI formatter 原始檔，無需讓 Core 或測試依賴 WPF 執行檔。涵蓋 UTC → +08:00、跨日、已為 +08:00、不同比較來源 offset，以及顯示後 UTC DTO／序列化資料不變。
- 狀態測試驗證監控中相同來源不發布狀態變更、不重新讀快照，確認前已收到的新通知仍處理一次；待命中相同來源、首次確認、更換來源、舊來源不再信任、去重快取淘汰後舊通知仍不補發；重掃保持模式以及真實錯誤必須停止監控。
- 完整 MSIX Build 成功。以 MakeAppx 解包至 `artifacts/taiwan-time-source-msix`，232 個 managed runtime assemblies 檔案與宣告版本檢查通過；App / Core / Windows DLL 的 SHA256 與當次 App 建置相符，userNotificationListener capability 仍存在。
- 測試結果：`artifacts/TestResults/taiwan-time-source-state.trx`；MSBuild 紀錄：`artifacts/taiwan-time-source-state.binlog`。

## 更新後的實機確認

本次完成編譯、單元測試與套件解包檢查，未重新部署並測試真實 Telegram 通知。先從系統匣結束舊版本，Visual Studio 重新載入外部變更後以 Debug／x64 F5 部署新版。再按實機驗收表檢查：

1. 真實新 Telegram 通知的偵測時間與最近工作事件時間均顯示台灣時間及 +08:00。
2. 監控中再次確認相同 AUMID，保持監控；之後全新通知處理一次。
3. 監控中重新掃描，成功後仍監控且不重播。
4. 真正更換來源，看到回待命原因；手動重新監控後不補發舊通知。只有確認為真正 Telegram 的 AUMID 才適合監控，不要將其他 App 當作 Telegram。
