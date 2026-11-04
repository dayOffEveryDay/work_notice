0004_agent_sources.sql 新增 agents.enabled_sources（nullable TEXT），保留既有欄位與資料。NULL 沿用舊 Telegram 心跳語意；新版以明確啟用來源清單判斷健康，不偽造 telegram_source_confirmed。只在隔離本機 D1 測試，未套用正式 D1。正式更新時先由操作者檢查 ledger 與備份，再套用缺少的 migration，最後更新 Worker。既有 production-backup/closeout 腳本的舊基準只涵蓋到 0003，會因新增 0004 而拒絕舊前提；不可跳過其安全檢查或直接執行舊流程。

# Phase-two initial schema

`0001_init.sql` is byte-for-byte identical to `docs/WorkNotice_Phase2_0001_init.sql`.
It creates the five application tables without foreign keys, as specified.
Wrangler separately maintains its own migration ledger; do not count it as an application table.

Do not edit an applied migration. Add a new numbered migration for later changes.
Only local migration commands have been authorized for execution in this development step.

`0003_scheduled_activation.sql` adds versioned OFF/IMMEDIATE/SCHEDULED monitoring,
idempotent command records and session-bound outbox jobs. Its command trigger
conditions every side effect on a successful CAS; a zero-row update is not a
transaction failure. See `docs/WORKNOTICE-0.4.0-REVIEW.md` from the workspace root.
0001 and 0002 remain unchanged. Remote migration and deployment require a later
explicitly authorized deployment phase; they were not run during development.
