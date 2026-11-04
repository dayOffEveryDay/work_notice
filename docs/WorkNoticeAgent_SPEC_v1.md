# Work Notice Agent — Windows 第一階段開發規格 v1.0

> **用途：** 本文件可直接交給 Codex 實作。請先閱讀全部需求，再建立可編譯、可安裝、可實際監聽 Telegram Windows 系統通知的專案。禁止以模擬資料或假監聽器取代核心功能。

## 1. 專案目標

開發一個安裝在使用者 Windows 筆電上的桌面應用程式 `Work Notice Agent`。程式執行於目前登入使用者的桌面工作階段，使用 **Windows 官方 `UserNotificationListener` API** 偵測 **Telegram Desktop 的 Windows 系統通知**。使用者能切換「監控中／待命中」，可縮到系統匣，以及明確「結束程式」。

此階段只處理 **Windows 端**。當監聽到符合條件的新 Telegram 通知時，先轉成標準化的內部事件並顯示於本機 UI／安全日誌；**不要**呼叫真實雲端 API。架構需預留日後串接 Cloudflare Workers 的 Dispatcher，以及 Windows Heartbeat 的狀態提供介面。

**已知前提：** 使用者已確認 Telegram Desktop 能產生 Windows 官方 API 可讀取的通知。第一版 **不支援 Lark**；不必實作其他替代監聽方式。

## 2. 技術與交付形式

- 語言：C#。
- 執行平台：Windows 11 x64，.NET 10 LTS（若目前開發環境不支援，請說明缺少的 SDK 與可重現步驟，勿默默降級）。
- UI：WPF，採 MVVM；優先使用 .NET / Windows 內建能力，不需要 Electron。
- 系統匣：NotifyIcon 或相容的成熟 WPF 系統匣實作；避免不必要的第三方套件。
- Windows 通知：`Windows.UI.Notifications.Management.UserNotificationListener` 與 `Windows.UI.Notifications`。
- 安裝：使用 **MSIX（Windows Application Packaging Project）**，確保 App 具有 Package Identity，支援正常安裝與解除安裝；不要求單檔 `.exe`。若打包環境限制導致無法產出可簽章安裝包，仍須提交可用的封裝專案及完整打包／安裝步驟，不能假裝已驗證安裝。
- App manifest 必須宣告 `uap3:Capability Name="userNotificationListener"`（用正確的 `uap3` 命名空間）。
- 程式應作為登入使用者的桌面程式執行，**不要做成 Windows Service**，也不要以系統管理員身分執行來繞過通知權限。
- 目標是單機個人使用，不需會員系統、多使用者支援或自動更新。

## 3. 第一階段範圍

### 3.1 必須完成（P0）

1. **通知權限管理**：初次啟動清楚解釋用途，按鈕要求使用者授權；支援 `Allowed / Denied / Unspecified` 狀態；使用者拒絕或撤銷時顯示可理解的錯誤，絕不假裝已監控。
2. **Telegram 通知監聽**：使用官方 `UserNotificationListener` 事件；偵測 `Added`，忽略 `Removed`。讀取來源 App、通知 ID、建立時間，不需要讀取聊天文字或發訊者。
3. **來源過濾**：僅 Telegram 的 Windows 通知可進入 Dispatcher；其餘 App 不得當成工作警報。不同安裝方式下來源名稱／AUMID 可能不同，因此應提供「來源辨識／選取」機制，並保存使用者確認的 Telegram 來源識別，不可只依賴單一寫死的顯示名稱。
4. **去重**：同一個 Windows 通知多次出現／多次同步時，只產生一次工作事件；不同新通知可以分別產生事件。去重鍵至少考慮來源識別、Windows 通知 ID、通知建立時間；快取須有容量或過期管理。
5. **監控／待命切換**：
   - `監控中`：處理新的 Telegram 通知，產生事件並送往本機 Dispatcher。
   - `待命中`：程式保持執行、UI 正常，但不產生工作警報事件；仍保留本機健康資訊供未來 Heartbeat 使用。
   - 從待命切回監控時，不可把待命期間已存在的通知當成新訊息補發。
6. **安全啟動行為**：首次安裝及每次重新啟動預設 `待命中`；不自動補發通知中心既有的舊通知。已保存的 Telegram 來源設定可以恢復。
7. **桌面 UI**：顯示目前模式、通知 API 授權狀態、Telegram 來源狀態、最近偵測事件（僅必要中繼資料）、最近一次事件時間、內部錯誤；提供監控／待命按鈕。
8. **系統匣**：關閉主視窗（X）預設縮至系統匣，不結束程式；右鍵選單至少包含「顯示主畫面／監控中／待命中／結束程式」；雙擊圖示開主畫面；狀態和 tooltip 不誤導。
9. **結束程式**：必須真正解除事件訂閱、取消計時器／工作、釋放系統匣資源、保存必要設定並退出 Process。和單純關閉視窗不同。
10. **Log 與例外處理**：本機安全日誌可協助除錯；不得寫入訊息本文、發送者、憑證；發生個別通知解析錯誤不能讓整個監聽器崩潰。
11. **可測試架構**：監聽 Windows API 的類別與業務邏輯解耦，利用介面與測試替身測試狀態切換、過濾及去重。

### 3.2 預留介面，不做完整實作（P1，僅骨架）

- `IAlertDispatcher`：輸入標準化 `WorkAlertEvent`，本階段提供 `LocalDebugAlertDispatcher`，只更新 UI／安全 Log；不實際呼叫 Cloudflare。
- `IAgentStatusProvider`：提供目前模式、監聽權限、最後一次通知處理時間、監聽器錯誤狀態、時間戳；供未來 Heartbeat 使用。本階段不對外發送 Heartbeat。
- `IClock` 或等效時間抽象（若測試所需）。

### 3.3 不在第一階段範圍（不要擅自加）

- Lark、Discord、Teams 等其他監控來源。
- Cloudflare Workers / D1 / HMAC / 真正網路傳送。
- Firebase FCM、Android App、手機警報。
- 指定日期時間延後啟動（仍是待討論功能）。
- Windows 開機自動啟動、排程器喚醒筆電、遠端控制 Windows。
- OCR、螢幕截圖、UI Automation、解析 TG 聊天內容、Telegram Bot API。
- 雲端同步、帳號登入、資料庫、更新器。

## 4. 通知監聽的實作要求

1. 使用 `UserNotificationListener.Current`。`RequestAccessAsync()` 必須在 UI Thread 呼叫；在讀取前以 `GetAccessStatus()` 確認權限。若拒絕授權，顯示引導至 Windows 設定重新授權的說明。
2. 訂閱 `NotificationChanged` 事件；只處理新增（`UserNotificationChangedKind.Added`）。事件觸發時依通知 ID 讀取通知或同步 `GetNotificationsAsync(NotificationKinds.Toast)`，注意可能發生事件先到、資料已消失的競態情況。
3. 啟動或切換至監控模式時先以 `GetNotificationsAsync(NotificationKinds.Toast)` 建立「既有通知基線」，**不能**把已有通知輸出為新工作事件；建立基線與訂閱事件時需避免同步競態與重複。
4. 以通知來源 `AppInfo.AppUserModelId`（如可用）等穩定識別作主要辨識依據，`DisplayInfo.DisplayName` 作展示或輔助。若實際 Telegram 安裝版本提供的欄位不同，記錄所觀察到的中繼資料，讓使用者明確選取／確認來源。
5. 一般監控中以事件驅動為主；如 `NotificationChanged` 訂閱失敗，顯示「監聽器異常」，不可假裝監控成功。可提供有明確 UI 標示的低頻 polling 備援，但必須同樣先確認授權，且不得造成既有通知重放。
6. 不需取得通知本文；也不需要呼叫 `RemoveNotification` 或 `ClearNotifications`，**絕對不可改動或清除使用者原始 Windows 通知**。
7. UI 更新應回到 WPF Dispatcher 執行；非同步流程應處理例外、取消與重入。通知處理不可阻塞 UI Thread。
8. Windows 睡眠恢復後應重新確認授權／監聽器健康；恢復時先建立基線，避免把睡眠期間累積的舊通知當成即時警報。第一階段不要求在睡眠中仍能監控。
9. 注意：Windows 通知不一定與 Telegram 每一則聊天訊息一對一；本專案的觸發單位是「新 Telegram Windows 通知」，不是保證監控全部私訊。

## 5. 狀態模型與 UI

### 5.1 狀態（不要混淆「操作模式」和「健康狀態」）

- `AgentMode`: `Standby`, `Monitoring`。
- `ListenerHealth`: `Ready`, `AccessRequired`, `AccessDenied`, `Error`。
- 若使用者要求進入 `Monitoring` 但授權不足或監聽器失敗，不得顯示「正常監控中」；應顯示錯誤／未就緒，並阻止事件轉發。
- 程式完全退出不是可運作模式，不需要當成持續的 `AgentMode`。

### 5.2 WPF 主視窗

- 標題：`Work Notice Agent`。
- 狀態區：大字顯示「監控中」或「待命中」；另顯示通知授權、監聽器健康。
- 控制區：切換到監控中、切換到待命中；不可執行的操作需停用或顯示原因。
- Telegram 設定：查看已辨識來源名稱與識別值；可選擇／確認來源。
- 最近事件：時間、來源、Windows Notification ID、結果（已處理／重複忽略／待命忽略／來源忽略／錯誤），不顯示通知本文。
- 訊息區：顯示權限不足、Telegram 未產生 Windows 系統通知、訂閱失敗等診斷提示。
- 預設繁體中文 UI，程式碼可用英文命名。

### 5.3 系統匣

- 綠色／正常圖示代表真正處於 `Monitoring` 且 Listener Ready；待命／錯誤應有不同文字或圖示，不應只靠顏色。
- 關閉視窗（X）時只隱藏，第一次需清楚告知仍在背景執行。
- 使用「結束程式」才退出；避免重複啟動多個 Agent（單一執行個體）。

## 6. 標準化事件模型（給未來 Cloudflare 使用）

建議定義一個 immutable DTO（實際命名可調整）：

```csharp
public sealed record WorkAlertEvent(
    Guid EventId,
    string Source,             // "TELEGRAM"
    string SourceAppId,        // AUMID / 經確認來源識別
    uint WindowsNotificationId,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset DetectedAtUtc,
    string DeduplicationKey
);
```

`EventId` 在同一通知首次成功形成事件時生成一次。不要傳送 Telegram 文字內容、對話名稱或帳號資訊。此階段只能送到本機 `LocalDebugAlertDispatcher`。

## 7. 建議專案分層

以下是建議結構，Codex 可以合理微調但不得把全部邏輯塞進 MainWindow：

```text
WorkNoticeAgent/
├─ src/
│  ├─ WorkNoticeAgent.App/            # WPF Views, ViewModels, tray, app lifecycle
│  ├─ WorkNoticeAgent.Core/           # 狀態機、事件 DTO、過濾、去重、interfaces
│  └─ WorkNoticeAgent.Windows/        # UserNotificationListener adapter, settings, logging
├─ packaging/
│  └─ WorkNoticeAgent.Package/        # MSIX project + manifest/capability
├─ tests/
│  └─ WorkNoticeAgent.Core.Tests/     # xUnit（或相似測試框架）
├─ README.md
└─ WorkNoticeAgent.sln
```

建議介面：`INotificationSource`, `ITelegramSourceMatcher`, `INotificationDeduplicator`, `IAlertDispatcher`, `IAgentStatusProvider`, `ISettingsStore`。

可以使用 .NET DI + ILogger，依賴注入要簡單；設定可存 JSON 到合適的使用者資料目錄，日誌具輪替／大小限制。不要把敏感訊息內容寫入檔案。

## 8. 測試情境與驗收標準

### 8.1 自動化單元測試（必要）

- 監控中 + Telegram 新通知 → 產生 **1** 筆事件。
- 監控中 + 非 Telegram 通知 → **0** 筆事件。
- 待命中 + Telegram 新通知 → **0** 筆事件。
- 同一來源、ID、建立時間重複出現 → **1** 筆事件。
- 兩筆不同的新通知 → **2** 筆事件。
- 待命 → 監控，既有通知不應回補。
- 程式重新啟動後，通知中心既有通知不應回補。
- 已撤銷 Windows 通知權限 → 顯示無法監控，不呼叫 Dispatcher。
- 單筆通知解析失敗 → 其餘通知仍能處理；UI 不崩潰。

### 8.2 實機驗收（需使用者 Windows 筆電手動執行）

1. 安裝 MSIX，能從開始選單啟動、也能正常解除安裝。
2. 首次啟動能要求通知權限；允許後顯示授權成功。
3. 設定 Telegram Desktop 使用 Windows 系統通知，讓其他帳號傳送一則訊息；監控中 UI 出現一次新事件。
4. 重複同步、最小化與顯示視窗不會造成同一通知重複事件。
5. 切換待命後，Telegram 通知不產生工作事件；切回監控也不補發舊通知。
6. 主視窗 X 後，程式仍留在系統匣且繼續依模式運作。
7. 系統匣選「結束程式」後，程序確實結束。
8. 拒絕或撤銷權限時，UI 明確顯示異常而非假裝正常。
9. 其他 App（例如瀏覽器、ChatGPT）的通知不會產生工作事件。

**成功定義：** 能在使用者實際 Windows 電腦上，透過官方 API 可靠觀察到新的 Telegram Windows 通知，且模式切換、去重及系統匣生命週期均正確。不要求第一階段真的觸發手機鬧鐘。

## 9. Codex 執行與交付要求

1. **先做最小可運作 Proof of Concept**：建立具 Package Identity 的程式、宣告 capability、取得使用者授權、實際監聽 Telegram。先證明這條技術鏈可用，再擴充完整 UI、系統匣與分層架構。
2. 完成原始碼、專案檔、MSIX 封裝專案、單元測試、README，以及必要的使用者操作說明。
3. README 包含：所需 SDK / Visual Studio 工作負載、建置、啟動、MSIX 簽署及安裝、通知授權、Telegram 設定、排錯方式。
4. 提供 `dotnet build` / `dotnet test`（以及封裝步驟）的真實結果。若執行環境不是 Windows 或未安裝所需工作負載，須明確標註「未實機驗證」，不能虛構測試通過。
5. 不要留下「模擬通知」充當實際監控。可以提供單元測試用 fake，但正式版必須接入 Windows 官方 API。
6. 最後列出已完成、尚未完成，以及必須在實體 Windows 測試的項目，並解釋可能的 Windows API／封裝限制。
7. 不要自行加入 Cloudflare、FCM、Android、Lark、排程啟動等下一階段功能。

## 10. 後續整合契約（僅供設計，不要實作）

第二階段將由 `IAlertDispatcher` 改為向 Cloudflare Worker 的 `/api/alert` 發送標準化通知事件；`IAgentStatusProvider` 則由未來的 Heartbeat 服務每約 60 秒讀取並回報。**待命中也必須能回報健康狀態**，以區分刻意待命與異常離線。未來的 Android App 將控制是否接收手機警報；該開關與 Windows 的 `Monitoring/Standby` 完全獨立。

## 11. 官方技術參考

- Windows Notification Listener: https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener
- `uap3:userNotificationListener` capability: https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap3-capability-manual
- Package a .NET app with MSIX: https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/dotnet/package-app
- `AppInfo` source identification: https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.appinfo
