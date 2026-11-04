package com.worknotice.alarm;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.TextView;

/** Real alarm UI opened by notification PendingIntent, never by a background startActivity. */
public class FsiAlarmActivity extends Activity {
    private static java.lang.ref.WeakReference<FsiAlarmActivity> visible=new java.lang.ref.WeakReference<>(null);
    public static final String AUTO="com.worknotice.alarm.FSI_AUTO",CLICK="com.worknotice.alarm.FSI_CLICK";
    private boolean resumed,handled;
    private String event,nonce;
    private TextView status;
    protected boolean eligible(){return FsiSettings.enabled(this)&&FsiSettings.permission(this);}
    protected boolean paired(){return !new DeviceTokenStore(this).get("bearer").isEmpty();}
    protected boolean enabled(){return new AlarmPreferencesRepository(this).enabled();}
    protected long pairing(){return new AlarmPreferencesRepository(this).pairedAt();}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        if(android.os.Build.VERSION.SDK_INT>=27){setShowWhenLocked(true);setTurnScreenOn(true);}
        setContentView(R.layout.activity_ring_action);status=findViewById(R.id.recovery_status);
        event=getIntent().getStringExtra("event");nonce=getIntent().getStringExtra("actionNonce");handled=saved!=null&&saved.getBoolean("handled");
        FsiSettings.stage("FSI_ACTIVITY_CREATED",event,automatic());
        status.setText("緊急工作警報實驗：等待此畫面真正可見。未取得焦點時仍保留備援通知。");
        findViewById(R.id.recovery_stop).setOnClickListener(v->{
            handled=true;boolean stopped=event!=null&&new PendingAlarmStore(this).cancelPending(event,nonce);
            String session=AlarmPlaybackService.currentSession();if(session!=null)AlarmPlaybackService.stopCurrent(this,session);
            else if(stopped){Notices.cancelWork(this,event);CloudSyncWorker.ack(this,event,"STOPPED");}
            status.setText("已停止目前警報；未來接收設定不變。");
        });
        findViewById(R.id.recovery_main).setOnClickListener(v->startActivity(new Intent(this,MainActivity.class)));
    }
    private boolean automatic(){return AUTO.equals(getIntent().getAction());}
    public static boolean visibleFor(String event,String nonce){FsiAlarmActivity a=visible.get();return a!=null&&a.resumed&&a.hasWindowFocus()&&java.util.Objects.equals(a.event,event)&&java.util.Objects.equals(a.nonce,nonce);}
    @Override protected void onResume(){super.onResume();resumed=true;visible=new java.lang.ref.WeakReference<>(this);FsiSettings.stage("FSI_ACTIVITY_RESUMED",event,automatic());tryRing();}
    @Override protected void onPause(){resumed=false;if(visible.get()==this)visible.clear();super.onPause();}
    @Override protected void onDestroy(){if(visible.get()==this)visible.clear();super.onDestroy();}
    @Override public void onWindowFocusChanged(boolean focus){super.onWindowFocusChanged(focus);if(focus)tryRing();}
    @Override protected void onSaveInstanceState(Bundle out){out.putBoolean("handled",handled);super.onSaveInstanceState(out);}
    private void tryRing(){
        if(handled||!resumed||!hasWindowFocus())return;
        handled=true;
        FsiSettings.stage("FSI_RECOVERY_ATTEMPT",event,automatic());
        if((!automatic()&&!CLICK.equals(getIntent().getAction()))||event==null||!event.matches("[a-f0-9]{64}")||nonce==null||!eligible()||!Notices.allowed(this)){
            android.util.Log.i(AlarmDiagnostics.TAG,"stage=FSI_GATE_REJECTED event="+FsiSettings.ref(event)+" reason=ACTIVITY_INTENT_OR_AUTHORIZATION_INVALID gate="+FsiRecovery.reason(this));
            status.setText("授權或緊急警報設定無效；備援通知保留。");return;
        }
        var store=new PendingAlarmStore(this);
        var decision=store.claimFsi(event,nonce,pairing(),paired(),enabled());
        AlarmDiagnostics.recovery(event,decision);
        if(decision!=FallbackAlarm.Decision.ALLOWED)android.util.Log.i(AlarmDiagnostics.TAG,"stage=FSI_GATE_REJECTED event="+FsiSettings.ref(event)+" reason="+decision);
        if(decision!=FallbackAlarm.Decision.ALLOWED){status.setText("事件已過期、停止、處理或配對已變更；未啟動。");return;}
        try {
            startForegroundService(new Intent(this,AlarmPlaybackService.class).putExtra("event",event)
                .putExtra("expiresElapsed",store.deadline(event)).putExtra("recoveryAttempt",nonce).putExtra("fsiAttempt",true));
            status.setText("已從可見警報畫面要求播放。只有系統允許音訊焦點才會持續響鈴。");
        }catch(IllegalStateException|SecurityException error){AlarmDiagnostics.failure(AlarmDiagnostics.Stage.FGS_REQUEST,event,error);Notices.fallback(this,event,AlarmDiagnostics.Reason.FGS_START_DENIED);}
    }
}
