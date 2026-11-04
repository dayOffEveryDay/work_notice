# 驗證紀錄

最新第二階段：Worker 28 項、Core 49 項、Windows DPAPI 2 項通過；本機 C#→Worker/D1、Cron 與 MSIX 檢查完成，未更新正式服務。詳見 [PHASE2-API-VERIFICATION.md](PHASE2-API-VERIFICATION.md)。以下保留先前階段紀錄。

最新時間／來源行為修正（2026-11-02）：Debug／x64 Build 成功（0 警告／0 錯誤）；原有 16 項測試保留，共 29 項通過。MSIX 成功建置並解包，232 個 managed runtime assemblies 檢查通過，通知 capability 保留。此版本未重新執行真實通知驗收；詳見 [UI-TIME-SOURCE-STATE.md](UI-TIME-SOURCE-STATE.md)。

最新結果（2026-11-02）：已修復 DesktopBridge F5 輸出群組的 RID 相依路徑問題。Debug／x64 Restore、Build、16 項單元測試與 MSIX 建置成功；MakeAppx 解包檢查通過，Visual Studio F5 已成功顯示 WPF 主視窗。詳細證據與命令見 [F5-DEPENDENCY-FIX.md](F5-DEPENDENCY-FIX.md)。Telegram 真實通知與獨立簽章側載安裝尚待驗證。

以下保留 2026-11-01 的初始環境歷史紀錄，當時的工具缺少限制已由後續安裝解決。

2026-11-01，Windows x64，.NET SDK 10.0.403（專案 `.tools/dotnet`）。

## 已執行

```powershell
. ./scripts/Use-LocalDotnet.ps1
dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config --disable-parallel
dotnet build WorkNoticeAgent.sln -c Release --no-restore -m:1 -p:UseSharedCompilation=false
dotnet test tests/WorkNoticeAgent.Core.Tests/WorkNoticeAgent.Core.Tests.csproj -c Release --no-build --no-restore --logger 'trx;LogFileName=core.trx' --results-directory artifacts/TestResults --blame-hang-timeout 30s
```

Restore 成功；Build 成功（0 警告／0 錯誤）。測試 **16 通過，0 失敗，0 略過**；TRX 在 `artifacts/TestResults/core.trx`。最初沙箱 testhost 無輸出，已中止，實際通過結果來自一般 Windows 執行環境重跑。

涵蓋 Telegram 新通知一次處理、不同通知、其他來源過濾、待命不轉發、切回不補發、重新啟動安全基線、撤銷權限、訂閱失敗、個別解析錯誤診斷後繼續處理、基線事件競態、睡眠恢復基線、缺少來源阻止監控、快取容量／鍵組成、快取淘汰後舊通知不重播、來源變更重新待命、初始 Denied／Unspecified 狀態。

解析錯誤測試驗證 adapter 回報單筆錯誤後核心可繼續處理；並未用單元測試證明實際 WinRT 解析。單元測試中 fake 僅放在 tests，正式 App 接入 WindowsNotificationSource。

## 已嘗試但受環境限制

```powershell
dotnet msbuild packaging/WorkNoticeAgent.Package/WorkNoticeAgent.Package.wapproj -p:Configuration=Release -p:Platform=x64 -m:1 -v:minimal
```

回傳 MSB4019：找不到 `Microsoft/DesktopBridge/Microsoft.DesktopBridge.props`。沒有安裝完整 Visual Studio DesktopBridge 與 Windows SDK 封裝工具；提供的 WAP 專案尚需在完整工具鏈驗證。安裝與操作方式見 README。

## 尚未執行

- 完整 VS MSBuild WAP 建置、MakeAppx schema 驗證、簽章、安裝、解除安裝。
- Windows Package Identity 啟動、RequestAccessAsync 授權視窗。
- 真實 Telegram 來源欄位、NotificationChanged 事件送達、睡眠／撤銷權限、WPF 系統匣互動。

無任何真實通知被宣稱已成功收到；沒有產出已驗證 MSIX。實機驗收請逐項填寫 MANUAL-ACCEPTANCE.md。
