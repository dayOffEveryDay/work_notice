# Work Notice 工作通知警報

**將 Windows 電腦上的工作通知，轉成 Android 手機上的警報提醒。**

Work Notice 適合需要留意工作訊息、又不方便一直盯著電腦的人。當電腦收到已設定來源的新通知時，Windows 程式會將事件傳送到雲端，再由雲端推送到已配對的 Android 手機，依手機的監控設定觸發警報。

例如：在電腦開啟 Telegram 與 Work Notice，並在手機啟用監控。收到新的 Telegram 系統通知後，手機會嘗試播放警報，直到你手動停止；實際響鈴仍取決於網路、通知權限與手機背景執行限制。

## 主要功能

- **三種通知來源**：Telegram Desktop、Lark A（Chrome）、Lark B（Brave），可以分別設定與開關。
- **手機警報**：接收工作事件、播放警報，並提供停止目前警報的操作。
- **立即或預約開始監控**：由雲端管理監控狀態與開始時間；預約到點本身不會產生警報，之後收到符合條件的新事件才會觸發。
- **電腦狀態追蹤**：透過心跳回報監控狀態，手機可查看狀態並設定離線提醒。
- **避免重複提醒**：對事件去重，並檢查事件期限與監控期間，避免重試或舊通知造成重複響鈴。
- **保護訊息內容**：Windows 傳送通知來源、識別碼與時間等中繼資料，不傳送通知標題、本文、對話或發送者。

## 運作方式

```text
Telegram／Lark 產生 Windows 系統通知
                    ↓
Windows Agent 辨識已確認且啟用的來源
                    ↓ HTTPS 簽章驗證
Cloudflare Worker ＋ D1 資料庫
                    ↓ Firebase Cloud Messaging（FCM）
已配對的 Android 手機 → 檢查監控條件 → 警報提醒
```

| 元件 | 負責的工作 | 使用技術 |
| --- | --- | --- |
| Windows 電腦程式 | 監聽系統通知、管理來源、傳送事件與心跳 | C#、.NET 10、WPF、MSIX |
| 雲端後端 | 驗證請求、儲存事件、管理配對與監控、發送推播 | TypeScript、Cloudflare Workers／D1、FCM |
| Android 手機程式 | 配對、設定監控、接收推播與播放警報 | Java、原生 XML、Firebase、WorkManager |

完整的電腦到手機提醒需要三個元件一起設定。只啟動 Windows 程式而未設定雲端與手機配對時，可先驗證本機通知偵測。

## 開始使用

1. **準備雲端後端**：設定自己的 Cloudflare Worker、D1、Firebase 與必要金鑰，依部署文件套用資料庫遷移。已有環境升級時，先閱讀最新整合文件。
2. **安裝 Windows 程式**：建置並簽署 MSIX 套件後安裝，從開始選單啟動 Work Notice Agent，按「申請通知權限」。
3. **確認通知來源**：讓 Telegram 或 Lark 產生真正的 Windows 系統通知，在程式中選取並確認來源。Lark 的瀏覽器來源映射與個別開關位於「進階設定／通知來源管理」。
4. **設定雲端連線**：在 Windows 程式填入 Worker HTTPS 網址、設備識別碼及 Agent 金鑰，安全儲存後測試連線。
5. **安裝並配對手機**：設定 Android 專案的 Firebase 設定檔與後端網址，建置安裝後，輸入由管理工具產生的一次性配對碼，確認 FCM 權杖已登記。
6. **啟用監控並驗收**：將 Windows 切到「監控中」，在手機選擇立即或預約監控。監控生效後，傳送一則新的真實通知，確認手機收到並實際響鈴。

Windows 每次啟動預設待命。關閉視窗後仍會在系統匣執行；要完全退出，請使用系統匣的「結束程式」。手機的「停止目前警報」與「關閉未來警報」用途不同：停止目前響鈴不會關閉未來監控，關閉未來警報也不會停止已開始的響鈴。

## 使用前需要了解的限制

- **以 Windows 系統通知為觸發依據**：聊天軟體必須真的產生可被 Windows 通知中心觀察到的通知。通知合併、軟體設定或系統限制，都可能影響偵測；每則聊天訊息不一定各自觸發一次警報。
- **Lark 使用瀏覽器來源映射**：目前透過使用者確認的 Windows 應用程式識別碼（AUMID）辨識 Chrome／Brave。這些資料無法可靠分辨網站或 Lark 帳號，共用相同識別碼的其他網站通知也可能觸發提醒。
- **電腦需持續執行**：電腦關機、睡眠、程式退出或斷網時，無法正常完成即時傳送。重新掃描與睡眠恢復會重建通知基線，期間通知可能被忽略，舊通知不保證補送。
- **手機響鈴需實機確認**：FCM、省電模式、勿擾、通知權限、音訊焦點與廠牌的背景管理，都可能延遲或阻止提醒。全螢幕提醒需符合程式條件並取得系統授權，不能保證所有手機在鎖屏時都自動響鈴。

## 目前交付狀態

儲存庫包含 Windows、雲端與 Android 原始碼，以及分階段的建置、測試和部署紀錄。上傳 GitHub 不會自動部署後端或安裝應用程式；本儲存庫未附建置產物、私人金鑰或本機 Firebase 設定檔。

三來源雲端整合已有本機驗證紀錄；該次交付仍將正式後端部署、Windows 更新安裝與真實手機驗收列為待完成事項。請以 [三來源雲端整合交付](docs/LARK-CLOUD-INTEGRATION.md) 作為該次交付的依據，並依實際環境確認部署狀態。舊階段文件中的版本、測試數字與限制代表當時的結果。

## 建置與開發

### Windows

使用 Windows 11 x64 與 .NET 10 SDK。MSIX 封裝另需 Visual Studio 的 .NET 桌面開發、MSIX Packaging Tools 與 Windows SDK 10.0.26100.0。

```powershell
dotnet restore WorkNoticeAgent.sln --configfile NuGet.Config
dotnet build WorkNoticeAgent.sln -c Release -p:Platform=x64 --no-restore -m:1
dotnet test WorkNoticeAgent.sln -c Release -p:Platform=x64 --no-build --no-restore
```

封裝可在 Visual Studio 開啟 `WorkNoticeAgent.Packaging.sln`，選擇 `Release | x64`，以封裝專案作為啟動專案；或使用完整 Visual Studio MSBuild 執行：

```powershell
./scripts/Build-Package.ps1
```

套件產出至 `artifacts/AppPackages`，須使用與 manifest Publisher 相符的憑證簽署並完成信任設定後安裝。直接執行建置目錄內的 EXE 會因缺少套件身分而退出。封裝問題可參考 [建置與驗證紀錄](docs/VERIFICATION.md) 及 [F5 相依性修復](docs/F5-DEPENDENCY-FIX.md)。

### 雲端與 Android

- **雲端後端**：請依 [Worker 說明](cloudflare/work-notice-api/README.md) 設定開發環境，並依 [部署指南](docs/PHASE3-DEPLOYMENT.md) 與 [三來源整合文件](docs/LARK-CLOUD-INTEGRATION.md) 確認升級順序。既有資料庫不可直接重建。
- **Android**：用 Android Studio 開啟 `android/WorkNoticeAndroid`，依 [Android 說明](android/WorkNoticeAndroid/README.md) 設定 SDK、Firebase 與建置環境。使用自己的後端時，也需調整 `app/build.gradle.kts` 中的 `API_BASE`。
- **本機設定**：`.dev.vars`、`.env`、`google-services.json`、服務帳戶金鑰、簽章私鑰及建置產物均列入 Git 排除規則，需在自己的環境另外準備。

## 專案目錄

```text
src/                              Windows 程式與共用核心
packaging/                        Windows MSIX 封裝與圖示
android/WorkNoticeAndroid/        Android 手機程式
cloudflare/work-notice-api/       Worker、D1 遷移、管理工具與測試
tests/                            Windows 核心與整合測試
scripts/                          建置、圖示更新與診斷工具
docs/                             部署指南、設計說明與驗證紀錄
```

## 延伸文件

| 想了解的內容 | 文件 |
| --- | --- |
| 三來源接通方式、升級順序及驗證範圍 | [三來源雲端整合](docs/LARK-CLOUD-INTEGRATION.md) |
| Windows 通知來源設定與辨識限制 | [通知來源管理](docs/WINDOWS-NOTIFICATION-SOURCE-MANAGEMENT.md) |
| 雲端、配對及 FCM 部署 | [第三階段部署指南](docs/PHASE3-DEPLOYMENT.md) |
| Android 配對、建置及背景限制 | [Android 專案說明](android/WorkNoticeAndroid/README.md) |
| Android 監控介面調整 | [Android 0.4.1 說明](docs/WORKNOTICE-ANDROID-0.4.1.md) |
| 手機全螢幕提醒修正與驗證範圍 | [Android 0.4.1.1 修正紀錄](docs/WORKNOTICE-ANDROID-0.4.1.1-P0.md) |
| 真實通知驗收步驟 | [手動驗收清單](docs/MANUAL-ACCEPTANCE.md) |
