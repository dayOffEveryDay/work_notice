package com.worknotice.alarm;
import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.widget.*;
import android.content.Intent;
import android.provider.Settings;
import android.app.NotificationManager;
import android.os.PowerManager;
import org.json.JSONObject;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final DateTimeFormatter time = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss xxx").withZone(ZoneId.of("Asia/Taipei"));
    private AlarmPreferencesRepository prefs;
    private static final java.util.concurrent.atomic.AtomicBoolean MONITOR_BUSY=new java.util.concurrent.atomic.AtomicBoolean();
    private final Runnable tick = new Runnable() { public void run() { render(); handler.postDelayed(this, 1000); } };
    private interface Operation { void run() throws Exception; }
    private TextView label(int id) { return findViewById(id); }
    private EditText input(int id) { return findViewById(id); }
    protected AlarmPreferencesRepository alarmRepository(){return new AlarmPreferencesRepository(this);}
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); setContentView(R.layout.activity_main); prefs = alarmRepository();
        if(!FsiPreference.migrate(this))label(R.id.operation_feedback).setText("全螢幕偏好遷移失敗，尚未準備，請重新確認設定。");
        configureNavigation();
        ((Switch)findViewById(R.id.offline_alerts)).setChecked(prefs.offlineAlerts());
        if (Build.VERSION.SDK_INT >= 30) findViewById(android.R.id.content).setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        findViewById(R.id.pair).setOnClickListener(v -> {
            String code = input(R.id.pairing_code).getText().toString(); input(R.id.pairing_code).setText("");
            execute(() -> { new PairingRepository(this).pair(code); new PairingRepository(this).refresh(); });
        });
        findViewById(R.id.unpair).setOnClickListener(v -> new android.app.AlertDialog.Builder(this).setTitle("解除配對？").setMessage("撤銷手機憑證並停止警報，之後需新的配對碼。").setNegativeButton("取消",null).setPositiveButton("確認解除",(d,w)->execute(() -> {new PairingRepository(this).unpair();runOnUiThread(AlarmPlaybackService::cancelForUnpair);})).show());
        findViewById(R.id.refresh).setOnClickListener(v -> {
            label(R.id.setting_feedback).setText("正在讀回伺服器設定…");
            execute(() -> new PairingRepository(this).refresh());
        });
        findViewById(R.id.continuous).setOnClickListener(v -> requestMonitoring("IMMEDIATE",0));
        findViewById(R.id.timed).setOnClickListener(v -> {
            input(R.id.hours).setError(null);input(R.id.minutes).setError(null);
            try { requestMonitoring("SCHEDULED",AlarmModeUi.parse(input(R.id.hours).getText().toString(),input(R.id.minutes).getText().toString())); }
            catch(AlarmModeUi.InputError e){input(e.hours?R.id.hours:R.id.minutes).setError(e.getMessage());label(R.id.setting_feedback).setText(e.getMessage());}
        });
        findViewById(R.id.disable).setOnClickListener(v -> requestMonitoring("OFF",0));
        findViewById(R.id.monitor_retry).setOnClickListener(v->sendMonitoring(new MonitoringStore(this).pending()));
        findViewById(R.id.save_offline).setOnClickListener(v -> {
            boolean offline = ((Switch) findViewById(R.id.offline_alerts)).isChecked();
            execute(() -> {
            // Updating only offline preference must not restart or extend a countdown.
            new ApiClient(this).call("PUT", "/api/mobile/offline-settings", new JSONObject().put("offlineAlerts", offline), true);
            new PairingRepository(this).refresh();
            });
        });
        findViewById(R.id.stop).setOnClickListener(v -> { AlarmPlaybackService.stopCurrent(this, AlarmPlaybackService.currentSession()); render(); });
        findViewById(R.id.test_sound).setOnClickListener(v -> {
            if (!Notices.allowed(this)) { label(R.id.result).setText("請先允許通知及兩個警報通道"); return; }
            try { startForegroundService(new Intent(this, AlarmPlaybackService.class).putExtra("event", "local-" + UUID.randomUUID())); }
            catch (IllegalStateException | SecurityException e) { label(R.id.result).setText("系統禁止啟動警報服務"); }
        });
        findViewById(R.id.request_permission).setOnClickListener(v -> {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
            else startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        });
        findViewById(R.id.work_channel_settings).setOnClickListener(v->startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID,Notices.WORK)));
        findViewById(R.id.fsi_enable).setOnClickListener(v->new android.app.AlertDialog.Builder(this).setTitle("全螢幕緊急工作警報")
            .setMessage("我確認目前及之後主動建立的工作監控期間，有效事件均需立即處理，並同意鎖屏亮屏與持續響鈴。偏好不代表系統已授權；新期間仍會確認並綁定正確版本。")
            .setNegativeButton("取消",null).setPositiveButton("同意並儲存",(d,w)->{if(!FsiPreference.set(this,true)){label(R.id.operation_feedback).setText("儲存失敗");return;}if(new MonitoringStore(this).configured()&&!FsiSettings.consent(this)){label(R.id.operation_feedback).setText("偏好已存，但本次期間宣告儲存失敗，尚未準備。");return;}render();if(!fsiGranted())openFsiPermission();}).show());
        findViewById(R.id.fsi_disable).setOnClickListener(v->{if(!FsiPreference.set(this,false)){label(R.id.operation_feedback).setText("儲存失敗");return;}FsiSettings.clear(this);render();});
        findViewById(R.id.fsi_channel).setOnClickListener(v->startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID,Notices.URGENT)));
        if (!new DeviceTokenStore(this).get("bearer").isEmpty()) { CloudSyncWorker.enqueueToken(this); execute(() -> new PairingRepository(this).refresh()); }
    }
    private void openFsiPermission(){
        if(Build.VERSION.SDK_INT<34)return;
        try{startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,android.net.Uri.parse("package:"+getPackageName())));}
        catch(android.content.ActivityNotFoundException e){label(R.id.result).setText("系統未提供授權頁；請到特殊應用程式存取權檢查。");}
    }
    protected boolean monitoringPaired(){return !new DeviceTokenStore(this).get("bearer").isEmpty();}
    protected boolean fsiGranted(){return FsiSettings.permission(this);}
    protected JSONObject monitoringCall(String method,JSONObject body) throws Exception {return new ApiClient(this).call(method,"/api/mobile/monitoring",body,true);}
    private void requestMonitoring(String mode,int minutes){
        if("OFF".equals(mode)){new android.app.AlertDialog.Builder(this).setTitle("結束本次監控？").setMessage("停止後續新警報，不會停止目前鈴聲。").setNegativeButton("取消",null).setPositiveButton("結束監控",(d,w)->createMonitoring(mode,0)).show();return;}
        if(MONITOR_BUSY.get()){label(R.id.setting_feedback).setText("設定傳送中，請稍候。");return;}
        if(!monitoringPaired()||!new MonitoringStore(this).has()){label(R.id.setting_feedback).setText("請先配對並重新整理，取得後端監控版本。");return;}
        new android.app.AlertDialog.Builder(this).setTitle("確認本次緊急工作監控")
            .setMessage("我確認本次有效工作事件均需立即處理。預約前不會響，到點本身不會響，僅新事件會警報。"+(FsiPreference.enabled(this)?"全螢幕偏好已開啟：本次將使用鎖屏亮屏及持續響鈴，仍受系統授權限制。":"全螢幕偏好關閉：維持一般警報及備援通知，背景可能無法持續響鈴。可到設定啟用全螢幕偏好。"))
            .setNegativeButton("取消",null).setPositiveButton("確認用途與 FSI 授權",(d,w)->{
                if(!FsiPreference.set(this,FsiPreference.enabled(this))){label(R.id.setting_feedback).setText("偏好儲存失敗，未建立監控。");return;}
                if(FsiPreference.enabled(this)&&!fsiGranted()){label(R.id.setting_feedback).setText("尚未建立監控：請先允許系統全螢幕權限，再重新送出。");openFsiPermission();return;}
                createMonitoring(mode,minutes);
            }).show();
    }
    private void createMonitoring(String mode,int minutes){
        try{JSONObject command=new MonitoringStore(this).command(mode,minutes,!"OFF".equals(mode),prefs.pairedAt());
            if("OFF".equals(mode)){MonitoringStopWorker.enqueue(this);label(R.id.setting_feedback).setText("本機已結束監控；正在確認後端取消。目前鈴聲不受影響。");}
            sendMonitoring(command);
        }catch(Exception e){label(R.id.setting_feedback).setText("尚有未確認命令或儲存失敗；請先重試／同步，不會另建新的預約。");}
    }
    private void sendMonitoring(JSONObject command){
        if(!MONITOR_BUSY.compareAndSet(false,true)){label(R.id.setting_feedback).setText("本機狀態已保存；等待目前命令完成。");render();return;}
        label(R.id.setting_feedback).setText("儲存／同步中…尚未確認成功。");render();
        network.execute(()->{
            String result;
            try{long started=android.os.SystemClock.elapsedRealtime();JSONObject root=monitoringCall(command==null?"GET":"PUT",command);boolean accepted=new MonitoringStore(this).update(root,android.os.SystemClock.elapsedRealtime()-started);
                result=accepted?"後端已確認監控設定。預約到點不會自行響鈴，只等待新工作事件。":"回應已被較新版本取代，未覆蓋目前設定；請讀回最新狀態。";
            }catch(Exception e){if(e instanceof ApiClient.ApiException&&((ApiClient.ApiException)e).status==409){try{long start=android.os.SystemClock.elapsedRealtime();new MonitoringStore(this).update(monitoringCall("GET",null),android.os.SystemClock.elapsedRealtime()-start);}catch(Exception ignored){}}
                result=e instanceof ApiClient.ApiException&&((ApiClient.ApiException)e).status==409?"版本衝突：已嘗試讀回最新版本；請確認狀態後再次結束／設定監控。本機停止不解除。":AlarmModeUi.failure(e)+" 命令已保留；重試使用同一命令，不重新計算已接受的開始時間。";new MonitoringStore(this).error(result);}
            finally{MONITOR_BUSY.set(false);}
            final String message=result;runOnUiThread(()->{if(isFinishing()||isDestroyed())return;label(R.id.setting_feedback).setText(message);render();});
        });
    }
    private void execute(Operation operation) {
        label(R.id.result).setText("處理中…");
        network.execute(() -> {
            try { operation.run(); runOnUiThread(() -> { if(isFinishing()||isDestroyed())return;label(R.id.result).setText("已更新");if(!MONITOR_BUSY.get())label(R.id.setting_feedback).setText("已同步目前伺服器設定，請查看上方模式及 FSI 狀態。");((Switch) findViewById(R.id.offline_alerts)).setChecked(prefs.offlineAlerts()); render(); }); }
            catch (Exception e) { runOnUiThread(() -> {if(isFinishing()||isDestroyed())return;label(R.id.result).setText("網路或安全儲存失敗；目前顯示的是最近確認的資料。");if(!MONITOR_BUSY.get())label(R.id.setting_feedback).setText(AlarmModeUi.failure(e));}); }
        });
    }
    private String displayTime(long millis) { return millis <= 0 ? "尚無紀錄" : time.format(Instant.ofEpochMilli(millis)); }
    private void render() {
        renderSummary();
        boolean paired = !new DeviceTokenStore(this).get("bearer").isEmpty();
        label(R.id.connection).setText((paired ? "已配對" : "未配對") + " · " + (BuildConfig.FIREBASE_CONFIGURED ? "Firebase 設定已載入（尚需實機驗證）" : "Firebase 未設定：僅本機聲音測試"));
        try {
            JSONObject status = new JSONObject(prefs.status()), agent = status.optJSONObject("agent"), setting = status.optJSONObject("alertSetting");
            label(R.id.windows_status).setText("Windows：" + status.optString("effectiveStatus", "UNKNOWN") + "\n監聽器：" + (agent == null ? "UNKNOWN" : agent.optString("listener_status"))
                + " · 通知權限：" + (agent == null ? "UNKNOWN" : agent.optString("notification_permission")) + "\nHeartbeat：" + displayTime(agent == null ? 0 : agent.optLong("last_seen_at_ms"))
                + "\n更新：" + displayTime(prefs.updated()) + (System.currentTimeMillis() - prefs.updated() > 90000 ? "（舊資料，請重新整理）" : "")
                + "\nFCM token：" + (status.optBoolean("fcmRegistered", false) && getSharedPreferences("connection", MODE_PRIVATE).getBoolean("tokenRegistered", false) ? "已登記" : "未登記／重試中"));
            MonitoringStore monitor=new MonitoringStore(this);String state=monitor.state();
            label(R.id.mode_title).setText("OFF".equals(state)?"工作警報已關閉":"SCHEDULED".equals(state)?"預約等待中":"工作警報啟用中");
            label(R.id.mode_title).setTextColor(label(R.id.page_title).getCurrentTextColor());
            String detail=!monitor.has()?"尚未讀取 0.4.0 後端設定；請重新整理（需新版 Worker）":
                "SCHEDULED".equals(state)?"距離開始 "+AlarmModeUi.remaining(monitor.remaining())+"\n台灣時間開始："+displayTime(monitor.starts()):
                "ACTIVE".equals(state)?"等待開始時間以後的新工作訊息，直到手動結束本次監控":"目前不啟動新的工作警報";
            label(R.id.setting_status).setText(detail+"\n"+(monitor.pending()!=null?("OFF".equals(monitor.pending().optString("mode"))?"本機已結束；後端取消尚待確認":"設定命令尚待確認"):"最近已確認的後端設定")+"\n"+monitor.error()+"\n結束監控不會停止目前鈴聲；到點本身不發通知。");
        } catch (Exception ignored) { label(R.id.setting_status).setText("等待配對與同步設定"); }
        boolean saving=MONITOR_BUSY.get();
        for(int id:new int[]{R.id.timed,R.id.continuous,R.id.hours,R.id.minutes,R.id.save_offline,R.id.refresh,R.id.pair,R.id.unpair,R.id.fsi_enable})findViewById(id).setEnabled(!saving);
        label(R.id.current_alarm).setText(AlarmPlaybackService.currentSession() == null ? "目前未響鈴" : "響鈴中 · " + AlarmPlaybackService.currentCount() + " 則事件");
        findViewById(R.id.monitor_retry).setEnabled(!saving);
        findViewById(R.id.monitor_retry).setVisibility(new MonitoringStore(this).pending()!=null?android.view.View.VISIBLE:android.view.View.GONE);
        FsiStatus fsi=FsiSettings.status(this);
        label(R.id.fsi_status).setText((FsiPreference.enabled(this)?"全螢幕偏好：開啟\n":"全螢幕偏好：關閉／舊版狀態待確認（請明確儲存偏好）\n")+fsi.display()+"\n"+FsiRecovery.display(this));
        ((Button)findViewById(R.id.fsi_enable)).setText(FsiPreference.enabled(this)?"重新確認全螢幕偏好":"啟用全螢幕緊急警報偏好");
        ((Button)findViewById(R.id.fsi_disable)).setText("關閉全螢幕偏好（不停止目前鈴聲）");
        findViewById(R.id.fsi_disable).setEnabled(FsiPreference.enabled(this)||fsi.declared);
        android.app.NotificationChannel work=getSystemService(NotificationManager.class).getNotificationChannel(Notices.WORK);
        label(R.id.permissions).setText("通知及警報通道：" + (Notices.allowed(this) ? "允許" : "未授權或已關閉")
            +"\n工作通知提示音："+(work!=null&&work.getSound()!=null?"已設定（仍受音量與勿擾影響）":"無／靜音")+" · 震動："+(work!=null&&work.shouldVibrate()?"已啟用":"未啟用")
            + "\n背景限制：" + (Build.VERSION.SDK_INT >= 28 && getSystemService(android.app.ActivityManager.class).isBackgroundRestricted() ? "系統已限制" : "未偵測到限制，仍可能受省電影響")
            + "\n勿擾：" + getSystemService(NotificationManager.class).getCurrentInterruptionFilter() + " · 警報音量：" + getSystemService(android.media.AudioManager.class).getStreamVolume(android.media.AudioManager.STREAM_ALARM)
            + " · 通知音量：" + getSystemService(android.media.AudioManager.class).getStreamVolume(android.media.AudioManager.STREAM_NOTIFICATION)
            + "\n" + getSharedPreferences("connection", MODE_PRIVATE).getString("lastProblem", ""));
    }
    private void configureNavigation(){
        boolean settings=this instanceof SettingsActivity;String section=getIntent().getStringExtra("section");if(section==null)section="menu";
        label(R.id.page_title).setText(settings?"設定 · Work Notice":"Work Notice");
        findViewById(R.id.settings_entry).setVisibility(settings?android.view.View.GONE:android.view.View.VISIBLE);
        findViewById(R.id.settings_entry).setOnClickListener(v->openSettings("menu"));
        String[] names={"home","device","alerts","windows","diagnostics"};int[] panels={R.id.panel_home,R.id.panel_device,R.id.panel_alerts,R.id.panel_windows,R.id.panel_diagnostics};
        for(int i=0;i<names.length;i++)findViewById(panels[i]).setVisibility((!settings&&i==0)||(settings&&names[i].equals(section))?android.view.View.VISIBLE:android.view.View.GONE);
        int[] nav={R.id.nav_device,R.id.nav_alerts,R.id.nav_windows,R.id.nav_diagnostics};
        for(int i=0;i<nav.length;i++){final String dest=names[i+1];findViewById(nav[i]).setVisibility(settings?android.view.View.VISIBLE:android.view.View.GONE);findViewById(nav[i]).setOnClickListener(v->openSettings(dest));}
        findViewById(R.id.repair_windows).setOnClickListener(v->openSettings("windows"));findViewById(R.id.repair_fsi).setOnClickListener(v->openSettings("alerts"));
        findViewById(R.id.fsi_system).setOnClickListener(v->openFsiPermission());
    }
    private void openSettings(String section){startActivity(new Intent(this,SettingsActivity.class).putExtra("section",section));}
    private void renderSummary(){
        try{JSONObject status=new JSONObject(prefs.status());JSONObject agent=status.optJSONObject("agent");boolean stale=prefs.updated()==0||System.currentTimeMillis()-prefs.updated()>90000;
            String state=agent==null?"尚無 Heartbeat":status.optString("effectiveStatus","UNKNOWN");
            label(R.id.home_windows).setText("Windows："+switch(state){case "MONITORING"->"監控中";case "STANDBY"->"待命中";case "OFFLINE"->"失聯";case "STOPPED_BY_USER"->"已正常結束";case "DEGRADED"->"需檢查";default->"尚無可靠狀態";}+(stale?"（資料待更新）":""));
            findViewById(R.id.repair_windows).setVisibility(stale||!("MONITORING".equals(state)||"STANDBY".equals(state))?android.view.View.VISIBLE:android.view.View.GONE);
            label(R.id.device_fcm).setText("FCM 登錄："+(status.optBoolean("fcmRegistered")&&getSharedPreferences("connection",MODE_PRIVATE).getBoolean("tokenRegistered",false)?"已確認":"未確認／重試中"));
        }catch(Exception e){label(R.id.home_windows).setText("Windows：狀態未知");}
        boolean ready=monitoringPaired()&&FsiSettings.ready(this);
        label(R.id.home_fsi).setText("鎖屏警報："+(ready?(FsiRecovery.reason(this)==FsiRecovery.Reason.WAITING_FOR_START?"本次監控已準備（等待原預約時間）":"本次監控已準備"):"尚未準備："+FsiRecovery.description(FsiRecovery.reason(this))));findViewById(R.id.repair_fsi).setVisibility(ready?android.view.View.GONE:android.view.View.VISIBLE);
        label(R.id.version_info).setText("Work Notice "+BuildConfig.VERSION_NAME+" · Android API "+Build.VERSION.SDK_INT);
        label(R.id.advanced_info).setText(label(R.id.device_fcm).getText()+"\n通知及警報通道："+(Notices.allowed(this)?"允許":"未允許／已關閉")+"\nFSI 系統授權："+(FsiSettings.permission(this)?"允許":"未允許")+"\n"+new MonitoringStore(this).error()+"\n"+getSharedPreferences("connection",MODE_PRIVATE).getString("lastProblem",""));
        findViewById(R.id.alarm_controls).setVisibility(AlarmPlaybackService.currentSession()==null?android.view.View.GONE:android.view.View.VISIBLE);
    }
    @Override protected void onResume() { super.onResume(); handler.post(tick);var pending=new MonitoringStore(this).pending();if(pending!=null&&"OFF".equals(pending.optString("mode"))&&monitoringPaired())MonitoringStopWorker.enqueue(this); }
    @Override protected void onPause() { handler.removeCallbacks(tick); super.onPause(); }
    @Override protected void onDestroy() { network.shutdown(); super.onDestroy(); }
}
