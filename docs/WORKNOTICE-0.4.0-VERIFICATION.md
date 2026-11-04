# Work Notice 0.4.0 本機驗證結果

## 產物

- APK：C:/Users/HowardLu/工作鬧鐘/artifacts/phase3/WorkNoticeAndroid-0.4.0-debug.apk
- 大小：4,782,531 bytes。
- SHA-256：70AC81D66C5BC050377939FF23112CCE2B05EB07F264A3EFD4E8D7D2E00E54BF。
- package com.worknotice.alarm，versionName0.4.0、versionCode8、target/compileSdk37；FIREBASE_CONFIGURED=true。
- apksigner verify 通過；debug certificate SHA-256 f3b7cf2584830e61494aa0da14ed7ce28c9458e1d7f06c66f3be0dbd33674766，與前版相同。未安裝手機。

## Worker / D1

- npm run build：TypeScript 通過。
- npm test：114 項全部通過，0 fail；原有86項維持通過，另加B1的27個子測試及1個父測試。
- npm test 改用純本機 esbuild 測試打包，不執行 wrangler deploy 或 deploy --dry-run；TypeScript --noEmit 亦通過。
- 帶既有資料的0002 → 0003升級、舊Worker／新Schema、Mock FCM、逐表內容與密文完整性：兩個不同UUID隔離庫重跑通過，B1解除；見 [B1完整報告](WORKNOTICE-0.4.0-B1-VERIFICATION.md)。
- Schema 測試用真實 Wrangler local D1，獨立 persist-to，套用0001～0003，驗證資料表、原索引／約束、保留資料及重複 migration。
- npm run test:local：真實 Wrangler 本機 HTTP health、env.DB SELECT 1、scheduled() 呼叫兩次只建一筆 OFFLINE transition，通過；沒有正式呼叫。
- 0001、0002 雜湊與前版一致，未修改歷史 Migration。

新增測試：開始前不建工作、到點不建通知、開始後新事件建立、開始前一秒延遲不建、命令重試開始時間不變、不同內容重用ID、並發CAS只有一個勝者、零筆CAS不取消勝者工作、改期／取消作廢舊工作、舊API保護、legacy projection安全OFF、發送前 session 檢查、實際payload欄位及撤銷版本失效。

## Android

- assembleDebug、testDebugUnitTest、lintDebug：BUILD SUCCESSFUL。
- 145 項單元／Robolectric 測試，0 failures、0 errors。
- Lint：0 errors、59 warnings；未關閉檢查或用 baseline 隱藏錯誤。警告主要是繁體中文硬編碼／拼接、SharedPreferences同步 commit、UI label／layout 及依賴版本建議。
- 保留原有播放、Audio Focus、通知、FSI Activity、手動補救回歸測試；原0.3.5實際按鈕測試更新成0.4.0預約與用途對話框。新增 MonitoringTests 20 項，涵蓋時間資格、舊FCM、到點無通知、取消tombstone、版本、重啟時間恢復、FSI等待有效、原子宣告、process-death未確認命令恢復與手動停止／結束區分。
- 模擬 reboot 是變更 BOOT_COUNT 後重新建立 store，不是實體手機重啟。Robolectric 可驗證設定和時鐘邏輯，不能證明真實 ASUS 的 FCM、系統啟動或聲學輸出。

本機報告：android/WorkNoticeAndroid/app/build/reports/tests/testDebugUnitTest/index.html、android/WorkNoticeAndroid/app/build/reports/lint-results-debug.html。

## 尚待正式階段確認

1. 審查新的0003 trigger/CAS、版本與舊端隔離，再安排備份、正式migration、Worker部署；不可先更新正式手機到0.4.0。
2. 驗證正式既有配對與Secrets不變，舊客戶端在尚未採用新模型時仍正常；採用後舊設定寫入409。
3. 使用同簽章更新APK、不刪資料、不重新配對，再做2分鐘與8小時預約、鎖屏、到點無聲、下一筆事件才響、取消晚到推播、普通程序回收、重啟首次解鎖後未重開App等實測。
4. 首次解鎖前、強制停止、FCM/OEM限制、系統時鐘不可信、遠端撤銷與在途推播競態仍無法承諾必達或零延遲；詳見審查文件。

完整 API 範例、Migration 內容、檔案清單與部署順序：[本機交付審查](WORKNOTICE-0.4.0-REVIEW.md)。
