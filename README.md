# Work Notice — Windows、Cloudflare 與 Android

2026-11-04 三來源雲端接線已完成本機修改與驗證，Windows 待安裝套件為 1.0.1.0；正式環境尚未部署。包含 Worker 三來源精確白名單、來源去重命名空間、Lark-only 心跳與新增 0004 migration。先閱讀 [三來源雲端交付與驗證](docs/LARK-CLOUD-INTEGRATION.md)，依順序更新後端再更新 Windows；Android 0.4.1.1 不變。以下舊階段內容是歷史紀錄。

Windows 三來源 UI 更新：Debug／x64 Build 成功，66／66 項 Windows 測試通過。Telegram 保持原雲端流程；Lark A（Chrome）／Lark B（Brave）目前僅支援明確信任 AUMID 的本機事件。操作與變更清單見 [Windows 通知來源管理](docs/WINDOWS-NOTIFICATION-SOURCE-MANAGEMENT.md)。

第三階段 Java/XML Android 專案位於 [android/WorkNoticeAndroid](android/WorkNoticeAndroid/README.md)。安全配對、FCM HTTP v1、D1 `0002` migration 與正式操作步驟見 [第三階段部署指南](docs/PHASE3-DEPLOYMENT.md)，本機測試與實機驗收矩陣見 [第三階段驗證](docs/PHASE3-VERIFICATION.md)。本次未部署正式 Worker、變更遠端 D1 或正式 Secrets；前兩階段 Windows 原始碼保留。

圖示使用提供的透明機器人原圖：睡眠圖代表待命／未就緒，警戒圖代表監控且 Listener Ready；系統匣 tooltip 仍明確區分未就緒。視窗與系統匣依狀態切換，EXE／開始選單的固定圖示使用警戒圖。原圖在 `src/WorkNoticeAgent.App/Assets/Source`，執行 `./scripts/Update-AppIcons.ps1` 可重建多尺寸 ICO 與 MSIX PNG。輸出時自動去除透明留白與近透明雜點，將完整機器人（含月亮／天線）置中放大，保留透明背景與比例，原始 PNG 不改動；系統匣使用清晰的 32px frame。

C# / .NET 10 / WPF 的 Telegram Windows 通知監聽工具。正式程式直接使用 `UserNotificationListener.Current`，沒有模擬通知；第二階段已加入可選的 HMAC HTTPS 背景傳送與 Heartbeat。既有 F5 / RID 修復保留。最新部署與實機驗收見 [第二階段整合](docs/PHASE2-INTEGRATION.md)，本機結果見 [第二階段驗證](docs/PHASE2-API-VERIFICATION.md)。

## 本次驗證結果

最新第二階段：Worker 28 項、Windows Core 49 項與實際 DPAPI 2 項測試通過；C# → 本機 Worker/D1 重試去重、Heartbeat、stop 與真實 scheduled() 已驗證；Debug／x64 Build 與 MSIX 成功。正式部署、新雲端 UI 與真正 Telegram → 正式 D1 仍需使用者驗收，詳見 `docs/PHASE2-API-VERIFICATION.md`。

以下為 2026-11-01 初始環境歷史紀錄；當時缺少的 Visual Studio／SDK 工具目前已補齊：

- 日期：2026-11-01（Asia/Taipei）。執行環境 Windows x64，OS 回報 10.0.26300。
- 起始環境沒有可用的 .NET、Windows SDK、Visual Studio DesktopBridge／MakeAppx／SignTool。
- 已下載 Microsoft 官方 .NET SDK **10.0.403** 至 `.tools/dotnet`；未降級 .NET。
- `dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config --disable-parallel`：成功。
- `dotnet build WorkNoticeAgent.sln -c Release --no-restore -m:1 -p:UseSharedCompilation=false`：成功，0 警告、0 錯誤。
- 核心測試結果與可重現命令見下方及 `docs/VERIFICATION.md`。
- 當時 `dotnet msbuild packaging/WorkNoticeAgent.Package/WorkNoticeAgent.Package.wapproj -p:Configuration=Release -p:Platform=x64` 失敗，`MSB4019`，缺少 `Microsoft.DesktopBridge.props`。2026-11-02 已使用完整 VS MSBuild 驗證 Debug／x64 封裝；目前仍未驗證獨立簽章套件的側載安裝。

## 結構與責任

```text
WorkNoticeAgent.sln                  # dotnet build / test，不含 WAP
WorkNoticeAgent.Packaging.sln        # Visual Studio 完整封裝方案；選 Release | x64
src/
  WorkNoticeAgent.Core/             # 模式、狀態、來源比對、去重、Dispatcher/Heartbeat 契約
  WorkNoticeAgent.Windows/          # 真實通知 API、JSON 設定、安全輪替日誌、本機 Dispatcher
  WorkNoticeAgent.App/              # WPF MVVM、授權操作、系統匣、單例與生命週期
packaging/WorkNoticeAgent.Package/  # Windows Application Packaging Project、manifest、PNG 圖示
tests/WorkNoticeAgent.Core.Tests/   # xUnit；僅此處使用 fake
scripts/                           # 專案內 SDK 環境、完整 MSBuild 打包
docs/                              # 驗證紀錄、實機驗收表
```

依賴方向：App → Windows / Core；Windows → Core。Core 不依賴 Windows API 或 WPF。`IAlertDispatcher` 接受 immutable `WorkAlertEvent`，CloudAgentService 保留 LocalDebugAlertDispatcher 並加入限容量背景 HTTPS 佇列。`IAgentStatusProvider` 提供模式、權限、健康、最近處理時間與來源確認狀態，供每約 60 秒的 Heartbeat 讀取；未設定雲端時仍使用本機功能。

## 開發工具與建置

1. Windows 11 x64、.NET 10 SDK。`global.json` 要求至少 10.0.100，允許較新 .NET 10 feature band。
2. 封裝另需支援所選 .NET 10 SDK 的 Visual Studio 2026；在 Installer 安裝 **.NET desktop development**、**MSIX Packaging Tools** 與 **Windows SDK 10.0.26100.0**。若找不到 Windows Application Packaging Project 範本，先確認 MSIX 工具元件。只安裝 .NET SDK 不會提供 DesktopBridge。官方說明：[.NET 與 VS 版本](https://learn.microsoft.com/dotnet/core/porting/versioning-sdk-msbuild-vs)、[WAP 工具要求](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-packaging-dot-net)。
3. 不需要 Windows Service、系統管理員執行 Agent，也不需安裝 Windows App SDK。

已安裝全域 .NET SDK 時，在專案根目錄執行：

```powershell
dotnet --info
dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config
dotnet build WorkNoticeAgent.sln -c Release --no-restore -m:1
dotnet test tests/WorkNoticeAgent.Core.Tests/WorkNoticeAgent.Core.Tests.csproj -c Release --no-build --no-restore
```

本次工作區的本機 SDK 已在 `.tools`；使用它時先執行：

```powershell
. ./scripts/Use-LocalDotnet.ps1
```

乾淨機器可先安裝官方 .NET 10 SDK；若需可攜 SDK，可下載官方安裝腳本，再執行下列命令（`.tools` 不屬於原始碼交付）：

```powershell
New-Item -ItemType Directory -Force .tools
Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile .tools/dotnet-install.ps1
& ./.tools/dotnet-install.ps1 -Channel 10.0 -InstallDir "$PWD/.tools/dotnet" -NoPath
. ./scripts/Use-LocalDotnet.ps1
```

本次沙箱中的 testhost 未回報結果，停止後於一般 Windows 環境重跑才取得測試結果。限制環境如不能建立 testhost 通訊，請於一般 PowerShell 執行，不要把停滯的執行當作通過。

## MSIX 建置、簽署與安裝

先完成這一節，才能做真實通知 PoC。直接執行 `bin` 裡的 exe 會提示缺少 Package Identity 並退出。

### Visual Studio

開啟 `WorkNoticeAgent.Packaging.sln`，選 **Release | x64**，以 `WorkNoticeAgent.Package` 為啟動專案。確認 Dependencies / Applications 的入口為 WPF App。選封裝專案 → Publish / Create App Packages → Sideloading，使用與 manifest Publisher 相符的簽章憑證建立套件。若 VS 缺少相應 SDK，安裝 10.0.26100.0；不要移除通知 capability 來消除錯誤。

### 命令列

使用 Visual Studio Developer PowerShell（**完整 MSBuild.exe，不能以 dotnet msbuild 取代 WAP 工具**）：

```powershell
./scripts/Build-Package.ps1
# Debug／x64：
# ./scripts/Build-Package.ps1 -Configuration Debug
# 或明確指定完整 MSBuild.exe：
# ./scripts/Build-Package.ps1 -MSBuildPath 'C:/Program Files/Microsoft Visual Studio/18/Community/MSBuild/Current/Bin/MSBuild.exe'
```

腳本產出未簽署套件至 `artifacts/AppPackages`。App 是 win-x64 self-contained；不要啟用 trimming 或 single-file。manifest 保留 `uap3:userNotificationListener`、`runFullTrust`，第二階段加入 `internetClient` 供 HTTPS；沒有管理員執行權限或自動啟動宣告。簽章側載安裝仍依下方步驟操作。

個人開發測試可使用自簽憑證（以下只提供操作，未替使用者產生或信任憑證）：

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=WorkNoticeAgent.Dev' `
  -KeyUsage DigitalSignature -FriendlyName 'WorkNoticeAgent Development' `
  -CertStoreLocation 'Cert:/CurrentUser/My' `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
Export-Certificate -Cert $cert -FilePath ./artifacts/WorkNoticeAgent.Dev.cer
# 在 Windows SDK x64 工具的 Developer PowerShell 中，將下方路徑改為實際 MSIX：
$package = 'C:/完整路徑/WorkNoticeAgent_1.0.0.0_x64.msix'
signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $package
signtool verify /pa /v $package
```

`Publisher="CN=WorkNoticeAgent.Dev"` 必須與憑證 Subject 完全相符。若改用自己的憑證，先同步修改 manifest Publisher。保留私鑰在憑證存放區，勿提交 PFX 或密碼。

測試機需信任此開發憑證。只在信任自己所產生憑證的機器上，另外以提升權限的 PowerShell 匯入 **公開 CER** 至測試機的 Trusted People：

```powershell
Import-Certificate -FilePath ./artifacts/WorkNoticeAgent.Dev.cer -CertStoreLocation 'Cert:/LocalMachine/TrustedPeople'
```

回到一般登入使用者的 PowerShell 安裝，不要提升 Agent 本身的權限：

```powershell
Add-AppxPackage -Path $package
Get-AppxPackage -Name WorkNoticeAgent | Select-Object Name, PackageFullName, InstallLocation
```

從開始選單啟動 **Work Notice Agent**。也可由 VS 封裝專案 F5 部署測試。解除安裝使用 Windows 設定 → 應用程式 → 已安裝的應用程式，或 `Get-AppxPackage -Name WorkNoticeAgent | Remove-AppxPackage`。如有企業側載政策限制，請依該筆電政策處理。開發憑證信任與套件安裝是不同步驟，解除安裝不等於移除開發憑證。

## 最小真實通知 PoC 驗證順序

1. 安裝 MSIX，從開始選單啟動；確認初始為「待命中」。按「申請通知權限」。`RequestAccessAsync()` 由 WPF UI thread 直接呼叫。
2. 允許後應顯示「已允許／就緒」。若拒絕／撤銷，至 Windows 設定 → 隱私權與安全性 → 通知，允許 App 存取通知，再按「重新掃描／重試監聽」。系統設定名稱可能因 Windows 版本而異。
3. 在 Telegram Desktop 設定 → 通知與音效，啟用通知及 Windows 原生／系統通知（實際選項名稱依 Telegram 版本）；確認通知有進入 Windows 通知中心。讓另一帳號傳送訊息，必要時先將該對話移到背景。
4. 在來源清單找實際觀察到的 Telegram 名稱與 AUMID。若通知早已存在，可按重新掃描。選取來源後按「確認為 Telegram」。這是明確的使用者信任選擇；不能把其他 App 誤認為 Telegram。程式不會只依顯示名稱自動信任來源。
5. 切換「監控中」，**再**發送一則新 Telegram Windows 通知。UI 最近紀錄應顯示來源、ID、時間與「已處理」，最近工作事件時間更新；安全日誌應有 `LocalAlert`。這一步成功才算證明官方 API → Telegram → 本機 Dispatcher 技術鏈。
6. 若沒有事件，記下權限、監聽器健康、AUMID、HRESULT、Telegram 版本與安裝方式；不要以 fake 或自行產生的測試通知替代 Telegram 驗收。完整清單見 `docs/MANUAL-ACCEPTANCE.md`。

## 行為、安全與排錯

- 每次啟動固定待命，僅恢復確認的來源。首次確認來源維持待命；再次確認相同 AUMID 不切換模式、不重建基線。真正更換 AUMID 時才回到待命並重建基線，UI 會說明原因，需手動重新進入監控。
- 使用者可見的通知時間統一為台灣時間，格式 `yyyy-MM-dd HH:mm:ss +08:00`，由 UI 的 DateTimeOffset / TimeZoneInfo 轉換。內部事件、去重鍵、日誌及未來 Dispatcher 傳輸仍使用原本 UTC，不依賴電腦本機時區。
- 「重新掃描／重試監聽」成功時維持原操作模式（同步中亦不短暫顯示待命）；權限不足或同步失敗時仍安全回到待命並顯示異常。
- 訂閱事件後先讀取 Toast 快照；基線期間的事件以 generation 排除。每次切換／重掃／睡眠恢復均重建基線，且只接收建立時間晚於基線完成時間的新通知，避免遲到事件與被去重快取淘汰的舊通知重播。**基線同步視窗內的通知會被保守忽略**，本階段沒有可靠訊息佇列或補發保證。
- 去重鍵含長度限定的 AUMID、Windows ID、UTC 建立時間 ticks；最多保留 4096 筆。不同建立時間的同 ID 可分別產生事件。
- 監聽以 `NotificationChanged.Added` 為主，忽略 Removed；沒有通知 polling 備援。每 5 秒只檢查授權狀態，不掃描通知；每次讀取／處理亦確認授權。撤銷後最遲下一次檢查顯示異常，重新允許需手動重試。
- 睡眠開始立即抑制事件，恢復先重建基線；不保證睡眠中監聽。手動調整系統時間可能影響建立時間邊界，調整後請重新掃描。
- X 隱藏至系統匣，第一次會提示；雙擊圖示顯示。tooltip 區分監控／待命／未就緒，圖示也區分狀態。以系統匣「結束程式」取消健康工作、解除通知與電源事件訂閱、釋放 NotifyIcon 並退出。每個登入工作階段只允許一個執行個體。
- UI 最多保留 200 筆中繼資料。設定／日誌存於目前使用者 `%LOCALAPPDATA%/WorkNoticeAgent`；MSIX 可能將此位置重新導向至 `%LOCALAPPDATA%/Packages/<PackageFamilyName>/LocalCache/Local/WorkNoticeAgent`。設定只含 Telegram AUMID；每份日誌約 1 MiB，保留當前及上一份。
- 日誌只輸出固定診斷碼、HRESULT、AUMID、通知 ID、建立／處理時間；不記錄例外訊息／stack、本文、對話或發送者。日誌無法寫入時僅寫 Debug 固定碼，不會讓通知處理崩潰。程式不呼叫刪除／清空通知 API。
- 個別解析失敗只記 `NotificationParse`，其餘通知繼續處理；訂閱／讀取層錯誤會停用監控並標示異常。事件送達時原通知可能已消失，直接忽略這種競態。缺 AUMID 的來源不接受，避免以可變顯示名稱誤判。
- 沒有看到 Telegram 來源通常表示它未進入 Windows 通知中心、通知已消失、未授權或 Telegram 使用自訂通知。只有真正觀察到的來源才能選取。不同 Telegram 安裝方式如改變 AUMID，需重新確認來源。
- Windows 通知不等於每一則聊天訊息；通知可能合併、更新或受專注／通知設定影響。本程式不能保證所有私訊都觸發。

## 官方參考

- [Notification listener](https://learn.microsoft.com/windows/apps/develop/notifications/app-notifications/notification-listener)
- [uap3 capability 與命名空間](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-capability)
- [WPF / .NET MSIX 封裝](https://learn.microsoft.com/windows/apps/desktop/modernize/dotnet/package-app)
- [MSIX 簽署](https://learn.microsoft.com/windows/msix/package/signing-package-overview)

第二階段已實作 Cloudflare HTTPS / Heartbeat，未實作 Lark、FCM、Android、開機自動啟動或延後排程。真正 Telegram → 正式 D1 流程仍需使用者部署、設定 Secrets 與實機驗收。

Worker 專案位於 [cloudflare/work-notice-api](cloudflare/work-notice-api/README.md)，沿用正式五表與既有 migration。本次只測本機，沒有變更正式 Worker / D1；使用者依該 README 設定兩把 Secrets 並更新既有 Worker，不需要重建或重新初始化資料庫。
## Windows 三來源 UI 更新

Telegram、Lark A（Chrome）、Lark B（Brave）的來源管理、相容性、測試結果與雲端限制，請見 [Windows 通知來源管理](docs/WINDOWS-NOTIFICATION-SOURCE-MANAGEMENT.md)。

