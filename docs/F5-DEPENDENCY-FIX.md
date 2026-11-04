# F5 啟動遺漏類別庫：根因、修正與驗證

2026-11-02，Windows x64、Visual Studio 2026 18.11、完整 MSBuild 18.11.1、.NET SDK 10.0.403、Windows SDK 10.0.26100.0。

## 結果

已在使用者目前開啟的 Visual Studio 載入修正，確認 Debug／x64、啟動專案 WorkNoticeAgent.Package，實際按 F5。開發套件成功部署，WPF 主視窗顯示「待命中」，原本的 WorkNoticeAgent.Windows FileNotFoundException 未再阻止啟動。畫面顯示既有權限「已允許」、監聽器「就緒」；本次沒有操作授權提示，也沒有宣稱已收到 Telegram 真實通知。保留 App 在待命供後續驗收。

## 根本原因

最初檢查結果：

| 位置 | Core.dll / Windows.dll | deps.json |
|---|---|---|
| App bin/x64/Debug/.../win-x64 | 兩者存在 | 兩者皆有 runtime 紀錄 |
| WAP bin/x64/Debug/WorkNoticeAgent.App | 兩者遺漏 | 仍列出兩者 |
| 已註冊的 WAP bin/x64/Debug/AppX/WorkNoticeAgent.App | 兩者遺漏 | 仍列出兩者 |

App 的 ProjectReference 正確，App 建置的 CopyLocal 也正常。問題發生在 DesktopBridge 收集 F5 輸出群組的另一個 MSBuild evaluation：封裝將執行檔的 RuntimeIdentifier=win-x64 / SelfContained=true 傳入為全域屬性，並傳至相依類別庫。方案卻將 Core / Windows 建為 RID-neutral 的 Any CPU 類別庫。結果輸出群組指向 `Core/bin/Debug/net10.0/win-x64/…dll` 及 `Windows/bin/Debug/net10.0-windows10.0.19041.0/win-x64/…dll`，這兩個檔案並不存在。實際類別庫位於同層不含 win-x64 的路徑，App bin 的 DLL 也不能修正這個收集路徑差異。

完整命令列 Publish 會建出 RID 類別庫，因此可能暫時掩蓋 F5 問題。調查時先執行 Publish 觀察這個差異，再以 dotnet clean 清除新產生的 RID 類別庫檔，重跑 `BuildingInsideVisualStudio=true / GenerateAppxPackageOnBuild=false`：原設定重新指向不存在的 RID 檔案；修正後，同一非 Publish 路徑直接指向存在的 RID-neutral 類別庫。沒有手動複製 DLL，也沒有使用 AssemblyResolve 或改變工作目錄。

WindowsBase.dll 是 WPF 啟動流程中呈現例外的位置，不是這次遺漏的相依組件。

## 修改

- App → Core / Windows、Windows → Core 的 ProjectReference 使用 `GlobalPropertiesToRemove` 移除 `RuntimeIdentifier;SelfContained;PublishSingleFile;PublishTrimmed`，讓類別庫在一般方案建置、F5 輸出群組與 Publish 的路徑一致。
- 保留類別庫的複數 `RuntimeIdentifiers=win-x64`（使用者先前補上的設定）供 Restore / DesktopBridge Windows API 資產查詢；複數屬性不選擇 RID 建置輸出，不是這次根因。App 仍使用單數 RuntimeIdentifier、win-x64 self-contained。
- WAP 仍只參考 App，透過 App 的相依閉包收集類別庫；不把類別庫加入為獨立可啟動應用程式，不改成硬編碼 Content 複製。
- WAP 加入輸出群組檢查：兩個必要 DLL 未列入或來源檔案不存在時直接讓建置失敗，避免舊 bin / AppX 殘留掩蓋錯誤。
- 包裝方案 Debug／x64、Release／x64 加入 Deploy.0，預設勾選封裝專案部署。
- 新增 Test-AppDependencies.ps1，依 deps.json 驗證 managed runtime 組件檔案與宣告版本；Build-Package.ps1 支援 Configuration 並執行此檢查。

## 已執行的驗證

```powershell
. ./scripts/Use-LocalDotnet.ps1
$msbuild = 'C:/Program Files/Microsoft Visual Studio/18/Community/MSBuild/Current/Bin/MSBuild.exe'
& $msbuild WorkNoticeAgent.Packaging.sln /t:Restore /p:Configuration=Debug /p:Platform=x64 "/p:RestoreConfigFile=$PWD/NuGet.Config" /m:1 /v:minimal
dotnet build WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-restore -m:1 -p:UseSharedCompilation=false
& $msbuild WorkNoticeAgent.Packaging.sln /p:Configuration=Debug /p:Platform=x64 /m:1 /v:minimal
dotnet test WorkNoticeAgent.sln -c Debug -p:Platform=x64 --no-build --no-restore --logger 'trx;LogFileName=debug-x64.trx' --results-directory artifacts/TestResults --blame-hang-timeout 30s
```

- Restore 成功；dotnet Build 成功，0 警告、0 錯誤；完整 WAP Build 成功並產出未簽署 MSIX。
- 測試 16 通過、0 失敗、0 略過。測試專案在方案 Debug／x64 映射為 Any CPU，故從方案執行測試；直接對測試 csproj 指定 Platform=x64 再搭配 --no-build 會錯找不存在的 bin/x64 測試來源，不是測試失敗。
- MSIX 產物：`packaging/WorkNoticeAgent.Package/AppPackages/WorkNoticeAgent.Package_1.0.0.0_x64_Debug_Test/WorkNoticeAgent.Package_1.0.0.0_x64_Debug.msix`。
- 以 SDK MakeAppx 解包至 `artifacts/Debug-x64-msix-inspect`，232 個 managed runtime assemblies 存在且版本相符。Core、Windows、WinRT.Runtime、Microsoft.Windows.SDK.NET 的 SHA256 與 App 建置輸出相符。
- F5 部署後的 AppX 再檢查相依閉包；已透過視窗擷取確認真正的 WPF 主畫面顯示，不以程序存在或建置成功代替畫面驗收。
- 診斷產物：`artifacts/wap-vs-missing.json`（原錯誤路徑）、`artifacts/wap-vs-fixed.json`、`artifacts/wap-vs-fixed.binlog`、`artifacts/debug-x64-fixed.binlog`、`artifacts/TestResults/debug-x64.trx`。

## 後續操作

Visual Studio 已重新部署並啟動在待命。之後若 IDE 提示外部檔案修改，重新載入方案／專案，確認 Debug／x64 及封裝專案啟動，再 F5。不要只重建 App、不要把 DLL 手動複製進 AppX。

可隨時重驗部署目錄：

```powershell
./scripts/Test-AppDependencies.ps1 -AppDirectory ./packaging/WorkNoticeAgent.Package/bin/x64/Debug/AppX/WorkNoticeAgent.App
```

尚需使用者驗證 Telegram 真實新通知、首次授權與撤銷、睡眠恢復、系統匣與正常退出。獨立簽章套件的側載安裝／解除安裝亦未因本次 F5 開發部署而視為通過。
