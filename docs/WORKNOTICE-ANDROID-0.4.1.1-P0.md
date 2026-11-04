# Android 0.4.1.1 P0 FSI 回歸修正

## 已確認的程式缺陷與實機判斷界線

0.4.1的FsiPreference.enabled()沒有一次性遷移，而是每次以MonitoringStore.fsiDeclared或legacy urgent作預設值。結束監控的MonitoringStore.command(OFF)會呼叫FsiSettings.clear清掉期間宣告。若此前未儲存獨立偏好，下一次enabled讀值就從true變false；MainActivity.requestMonitoring的確認回呼又把這個衍生false持久寫入。

新命令仍送urgentConsent=true，MonitoringStore.update仍正確綁定新session/revision，但0.4.1新增的FsiPreference.permits會在FsiSettings.status再次把declared閘掉。因此FCM事件可以被接受、首頁的前景播放器仍可響，背景focus失敗後卻無法送出FSI。這是確定的程式回歸路徑，不是Worker或播放器重寫問題。

未取得這台手機0.4.1失敗事件的當時Logcat／偏好內容，不能斷言它是實機唯一原因。新的鎖屏一次測試可以確認實機是否走這條路，或是否另有系統授權／頻道／Activity問題。尚未宣稱ASUS鎖屏已實機恢復。

## 兩版實際差異證據

沒有完整封存的0.4.0 Java Git快照，因此本次不是虛構git diff。使用保留的兩版原APK，以SDK dexdump反組譯，移除編譯檔內方法位址／索引註解後比較指令。

| 類別 | 0.4.0與0.4.1指令 |
|---|---|
| MonitoringStore | 一致，包括urgentConsent、session/revision綁定及accept |
| Notices | 一致，包括頻道ID／importance與immutable FSI PendingIntent |
| PendingAlarmStore | 一致，包括一次性offer、事件／版本／停止資格 |
| WorkNoticeFirebaseMessagingService | 一致，沒有新增foreground early return |
| FsiAlarmActivity | 一致，包括resume／可見視窗後重試 |
| AudioFocusStartup | 一致 |
| AlarmPlaybackService | 一致 |
| FsiSettings | 不一致；0.4.1新增FsiPreference閘門 |

比較摘要：artifacts/phase3/p0-apk-compare/comparison.json。DEX來源是實際0.4.0／0.4.1交付APK，不以目前Java檔假充歷史原始碼。

## 最小修正

- FsiPreference.migrate：發現舊緊急用途宣告時，一次性保存true與LEGACY_CONSENT來源。讀取／首次開啟UI及清除舊宣告前都會執行，不依賴首頁一直在前景。
- FsiSettings.clear：先遷移意圖再清期間；新期間仍依舊有命令確認綁定，不沿用舊session。
- 顯式關閉保留false，來源USER，不能因稍後確認回應或舊宣告重新開啟。
- 已被0.4.1寫入但無來源標記的false，無法判斷是程式初始化或使用者關閉；標記LEGACY_CHOICE_REVIEW，不擅自開啟。這類使用者需在設定明確同意一次，之後新期間自動綁定，不需反覆宣告。
- 沒有任何舊同意證據則UNCONFIRMED，不捏造已準備。遷移寫入失敗也不聲稱成功。
- FsiSettings.ready用相同資格／系統授權／一般通知／緊急頻道HIGH條件提供首頁摘要；不以單純偏好true當成就緒。
- WNotice新增MONITORING_GATE accepted/localRevision，以及FSI_PERMISSION的preference、preferenceOrigin、urgentImportance、notificationsAllowed、ready。沒有輸出session ID、Token、本文或私人例外。

修改檔：FsiPreference.java、FsiSettings.java、MainActivity.java、WorkNoticeFirebaseMessagingService.java（只加驗證結果日誌）、app/build.gradle.kts、FsiMigrationTests.java（新增）。Alarm Activity、播放服務、Audio Focus、Notices、PendingAlarmStore與MonitoringStore均未修改。

## 測試及產物

assembleDebug／testDebugUnitTest／lintDebug通過。158項測試，0失敗；原152項加6項遷移測試。Lint 0 errors／79 warnings，沒有隱藏baseline。apksigner verify通過，與0.4.0／0.4.1同簽章。

新測試涵蓋舊版宣告→結束→新IMMEDIATE、SCHEDULED到點不失效、明確關閉不被延遲宣告復活、模糊false需確認、無同意證據拒絕、未知新revision拒絕。既有測試持續涵蓋權限撤銷、緊急頻道停用不覆寫、鎖屏Activity須真正可見且有焦點、過期／舊版本／停止事件拒絕、手動停止與未來警報分離。這些是本機邏輯／Robolectric證據，不是實體OEM授權驗證。

APK：C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.4.1.1-debug.apk

SHA-256：56A660AA17B82870F6B51EEB3AAB9CF3C8AE660650FA434E74292822EFE759C2。

versionCode10、versionName0.4.1.1；targetSdk仍37。建置紀錄：artifacts/phase3/android-p0-fsi.log。

## 最小實機驗收：一次鎖屏、一次解鎖背景

以下僅供使用者自行執行，本輪沒有操作手機或送推播。

    Set-Location 'C:\Users\HowardLu\工作鬧鐘'
    $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    $serial = Read-Host '輸入實體手機序號'
    & $adb -s $serial install -r 'C:\Users\HowardLu\工作鬧鐘\artifacts\phase3\WorkNoticeAndroid-0.4.1.1-debug.apk'
    if ($LASTEXITCODE -ne 0) { throw '更新失敗，停止；不要解除安裝或清除資料。' }
    $log = 'C:\Users\HowardLu\工作鬧鐘\artifacts\phase3\p0-fsi-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
    & $adb -s $serial logcat -T 1 -v threadtime 'WNotice:I' 'AS.HardeningEnforcer:I' '*:S' | Tee-Object -FilePath $log

此命令不清空Logcat，持續捕捉新事件，不需手動輸入事件短碼。完成兩次驗收後Ctrl+C。

1. 開設定確認一次持久全螢幕偏好及系統權限。若顯示LEGACY_CHOICE_REVIEW／關閉，請明確啟用一次。原配對應保留，不需重配。
2. 建立IMMEDIATE或短預約並確認設定成功，之後鎖屏熄屏，使用者自行送一則新的測試工作訊息。觀察同事件由MONITORING_GATE accepted=true、FSI_PERMISSION enabled/granted=true、FSI_POSTED、FSI_ACTIVITY_RESUMED、AUDIO_FOCUS value=1至PLAYER_STARTED，手動停止。
3. 不更換期間、不重按宣告，解鎖後切到其他App，再由使用者送一則新訊息。保留日誌，檢查是否只有heads-up；若自動響鈴失敗，可於事件有效期（最多120秒）內點「開啟並響鈴」。不要為測試重跑Worker部署／D1或配對。

同事件可能先出現背景FGS的focus=0，稍後才由FSI Activity取得focus=1；不能只看到第一個0就判失敗。停止／新事件及完整舊事件拒絕由既有自動測試保護，這次不要求再重做30分鐘部署驗收。

| 分類 | 最小判讀 |
|---|---|
| E 事件拒絕 | MONITORING_GATE accepted=false；還沒進FSI，先查期間／停止／過期資格 |
| A 未送FSI | accepted=true，但FSI_PERMISSION enabled=false；或granted=false／urgentImportance<4／notificationsAllowed=false |
| B 系統未啟動 | FSI_POSTED已有，沒有FSI_ACTIVITY_CREATED／RESUMED；解鎖時可能是正常heads-up政策 |
| C 焦點拒絕 | Activity真的可見後仍AUDIO_FOCUS=0／AUDIO_FOCUS_DENIED；僅RESUMED但無請求也可能是視窗焦點或事件資格尚未通過 |
| D 播放器階段 | focus=1後沒有PLAYER_STARTED，再看PLAYER_PREPARED／PLAYBACK_FAILED |

## 解鎖背景是獨立系統限制

Android官方規定target35以上需頂層App或前景服務才能請求音訊焦點，但這不是必定授予的承諾。先前ASUS日誌已顯示FGS成功仍被HardeningEnforcer拒絕；本次不再歸因於startForeground順序，也沒有足夠直接證據將其定為ASUS韌體bug或證明某個capability就是唯一原因。[Audio Focus官方文件](https://developer.android.com/media/optimize/audio-focus)

Android14以上官方FSI測試表列出：已授權時，解鎖狀態通常是heads-up，鎖屏／熄屏才啟動FSI。不能透過背景Service直接啟動Activity強迫取得資格。[FSI官方限制](https://source.android.com/docs/core/permissions/fsi-limits)

因此本版修正本機資格回歸，不承諾解鎖背景會自動持續響鈴。可行備援仍是有聲／震動通知及使用者點「開啟並響鈴」後讓Activity真正可見再申請焦點；通知聲不等於無限循環。不能為等候任意訊息而濫用mediaPlayback服務播放靜音保活，也不能把外部訊息假裝成精準本機鬧鐘來繞過限制。若focus失敗，保留通知，不忽略失敗值播放。

本輪未部署Worker、修改D1／Migration／Secrets、清除資料、操作手機或使用真實工作推播。
