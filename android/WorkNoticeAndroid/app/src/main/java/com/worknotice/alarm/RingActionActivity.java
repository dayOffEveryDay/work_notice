package com.worknotice.alarm;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.PowerManager;
import android.widget.TextView;

/** Non-exported Activity opened only by an immutable notification PendingIntent. No HTTP or refresh race. */
public class RingActionActivity extends Activity {
    public static final String ACTION="com.worknotice.alarm.OPEN_AND_RING";
    private boolean resumed,handled,validationRequested,validationReady;
    private int validationGeneration;
    private long serverAllowanceDeadline=Long.MAX_VALUE;
    private boolean serverDisabled;
    private final java.util.concurrent.ExecutorService validation=java.util.concurrent.Executors.newSingleThreadExecutor();
    private String event,nonce;
    private TextView status;
    protected boolean paired(){return !new DeviceTokenStore(this).get("bearer").isEmpty();}
    protected boolean enabled(){return new AlarmPreferencesRepository(this).enabled();}
    protected long pairing(){return new AlarmPreferencesRepository(this).pairedAt();}
    protected void refreshSettings(Runnable success,Runnable failure){
        validation.execute(()->{try{
            long started=android.os.SystemClock.elapsedRealtime();
            var current=new ApiClient(this).call("GET","/api/mobile/status",null,true);
            MonitoringStore monitor=new MonitoringStore(this);
            if(monitor.has()){
                serverDisabled=!monitor.matchesActive(current.optJSONObject("monitoring"));
                if(serverDisabled){runOnUiThread(failure);return;}
                serverAllowanceDeadline=Long.MAX_VALUE;runOnUiThread(success);return;
            }
            var setting=current.optJSONObject("alertSetting");
            serverDisabled=setting==null||!setting.optBoolean("effectiveEnabled",false);
            if(serverDisabled){runOnUiThread(failure);return;}
            serverAllowanceDeadline="TIMED".equals(setting.optString("mode"))?started+Math.max(0,setting.optLong("expires_at_ms")-current.optLong("serverNow")):Long.MAX_VALUE;
            // Do not overwrite local settings: a concurrent local disable must continue to win.
            runOnUiThread(success);
        }catch(Exception ignored){runOnUiThread(failure);}});
    }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);setContentView(R.layout.activity_ring_action);status=findViewById(R.id.recovery_status);
        event=getIntent().getStringExtra("event");nonce=getIntent().getStringExtra("actionNonce");
        handled=state!=null&&state.getBoolean("handled",false);
        if(handled)status.setText("此通知操作已處理；可停止目前響鈴或查看主畫面。");
        findViewById(R.id.recovery_stop).setOnClickListener(v->{
            handled=true;
            boolean canceled=event!=null&&new PendingAlarmStore(this).cancelPending(event,nonce);
            String session=AlarmPlaybackService.currentSession();
            if(session!=null)AlarmPlaybackService.stopCurrent(this,session);
            else if(canceled)CloudSyncWorker.ack(this,event,"STOPPED");
            status.setText("已要求停止目前響鈴；未來接收設定不變。");
        });
        findViewById(R.id.recovery_main).setOnClickListener(v->startActivity(new Intent(this,MainActivity.class)));
    }
    @Override protected void onResume(){super.onResume();resumed=true;if(hasWindowFocus())tryRing();}
    @Override protected void onPause(){resumed=false;if(!handled){validationGeneration++;validationRequested=false;validationReady=false;}super.onPause();}
    @Override public void onWindowFocusChanged(boolean focus){super.onWindowFocusChanged(focus);if(focus)tryRing();}
    @Override protected void onSaveInstanceState(Bundle state){state.putBoolean("handled",handled);super.onSaveInstanceState(state);}
    @Override protected void onDestroy(){validation.shutdown();super.onDestroy();}
    private void tryRing(){
        if(handled||!resumed||!getSystemService(PowerManager.class).isInteractive()||getSystemService(KeyguardManager.class).isKeyguardLocked())return;
        if(!ACTION.equals(getIntent().getAction())||event==null||!event.matches("[a-f0-9]{64}")||nonce==null){handled=true;status.setText("這個通知操作無效。");return;}
        if(!validationRequested){
            validationRequested=true;status.setText("正在確認事件與伺服器警報設定…");
            final int generation=validationGeneration;
            refreshSettings(()->{if(isFinishing()||isDestroyed()||generation!=validationGeneration)return;validationReady=true;tryRing();},
                ()->{if(!isFinishing()&&!isDestroyed()&&generation==validationGeneration)status.setText(serverDisabled?"伺服器警報設定已關閉或已到期；未啟動響鈴。":"無法確認最新警報設定；未啟動響鈴，備援通知會保留。");});
            return;
        }
        if(!validationReady||!hasWindowFocus())return;
        if(android.os.SystemClock.elapsedRealtime()>=serverAllowanceDeadline){handled=true;status.setText("伺服器的倒數啟用已到期；未啟動響鈴。");return;}
        handled=true;
        PendingAlarmStore store=new PendingAlarmStore(this);
        var decision=store.claim(event,nonce,pairing(),paired(),enabled());
        AlarmDiagnostics.recovery(event,decision);
        if(decision!=FallbackAlarm.Decision.ALLOWED){status.setText("無法重新響鈴：事件已處理、已過期、未配對或未來警報已關閉。");return;}
        if(!Notices.allowed(this)){Notices.fallback(this,event,AlarmDiagnostics.Reason.NOTIFICATIONS_BLOCKED);status.setText("請先允許通知與警報播放通道。");return;}
        try{
            startForegroundService(new Intent(this,AlarmPlaybackService.class).putExtra("event",event).putExtra("expiresElapsed",store.deadline(event)).putExtra("recoveryAttempt",nonce));
            status.setText("已由此可見畫面要求持續響鈴；若未響，請查看保留的備援通知原因。");
        }catch(IllegalStateException|SecurityException error){AlarmDiagnostics.failure(AlarmDiagnostics.Stage.FGS_REQUEST,event,error);Notices.fallback(this,event,AlarmDiagnostics.Reason.FGS_START_DENIED);status.setText("系統仍拒絕啟動播放，備援通知會保留。");}
    }
}
