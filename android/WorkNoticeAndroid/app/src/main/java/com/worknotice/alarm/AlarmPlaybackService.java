package com.worknotice.alarm;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.IBinder;
import static com.worknotice.alarm.AlarmDiagnostics.Stage;
import static com.worknotice.alarm.AlarmDiagnostics.Reason;

public final class AlarmPlaybackService extends Service {
    private static volatile AlarmPlaybackService active;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private final AudioAttributes attributes = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    private AudioFocusStartup startup = new AudioFocusStartup();
    private boolean prepared, hasFocus, foregroundPromoted;
    private long foregroundAt, eventDeadline;
    private Runnable focusTimeout;
    private String currentEvent;
    private Reason failureReason = Reason.NONE;
    private final AlarmLifecycle lifecycle = new AlarmLifecycle(new AlarmLifecycle.Effects() {
        public void releasePlayback() { release(); }
        public void removePlaybackService() { foregroundPromoted = false; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
        public void cancelWorkNotification(String event) { Notices.cancelWork(AlarmPlaybackService.this, event); }
        public void fallback(String event) { Notices.fallback(AlarmPlaybackService.this, event, failureReason); }
        public void ack(String event, String status) {
            PendingAlarmStore store=new PendingAlarmStore(AlarmPlaybackService.this);
            if("RINGING".equals(status)){store.ringing(event);if(!event.startsWith("local-"))Notices.ringing(AlarmPlaybackService.this,event);}
            if("STOPPED".equals(status))store.stopped(event);
            CloudSyncWorker.ack(AlarmPlaybackService.this, event, status);
        }
    });
    public static String currentSession() { return active == null ? null : active.lifecycle.id(); }
    public static int currentCount() { return active == null ? 0 : active.lifecycle.count(); }
    public static void stopCurrent(Context c, String expected) {
        AlarmPlaybackService service = active;
        if (service == null) return;
        if (service.lifecycle.userStop(expected)) AlarmDiagnostics.record(Stage.MANUAL_STOP, service.currentEvent, Reason.USER_STOP);
        else AlarmDiagnostics.record(Stage.STALE_STOP, service.currentEvent, Reason.NONE);
    }
    public static void cancelForUnpair() {
        if (active != null) { AlarmDiagnostics.record(Stage.FCM_DECISION,active.currentEvent,Reason.UNPAIRED_CANCEL); active.lifecycle.cancelForUnpair(); }
    }
    @Override public void onCreate() { super.onCreate(); active = this; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String event = intent == null ? null : intent.getStringExtra("event");
        if (event == null) { failed(Reason.INVALID_PAYLOAD); return START_NOT_STICKY; }
        String attempt=intent.getStringExtra("recoveryAttempt");
        if(attempt==null&&!event.startsWith("local-")&&new MonitoringStore(this).has()&&!new PendingAlarmStore(this).autoEligible(event)){
            AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.DISABLED);if(lifecycle.id()==null)stopSelfResult(startId);return START_NOT_STICKY;
        }
        if(attempt!=null){
            AlarmPreferencesRepository prefs=new AlarmPreferencesRepository(this);
            boolean fsi=intent.getBooleanExtra("fsiAttempt",false);
            if(fsi&&(android.os.Build.VERSION.SDK_INT<34||!FsiAlarmActivity.visibleFor(event,attempt)||!FsiSettings.enabled(this)||!FsiSettings.permission(this))){
                Notices.fallback(this,event,Reason.FGS_START_DENIED);if(lifecycle.id()==null)stopSelfResult(startId);return START_NOT_STICKY;
            }
            boolean paired=!new DeviceTokenStore(this).get("bearer").isEmpty();
            var decision=fsi?new PendingAlarmStore(this).startFsi(event,attempt,prefs.pairedAt(),paired,prefs.enabled()&&FsiSettings.enabled(this)&&FsiSettings.permission(this)):new PendingAlarmStore(this).start(event,attempt,prefs.pairedAt(),paired,prefs.enabled());
            AlarmDiagnostics.recovery(event,decision);
            if(decision!=FallbackAlarm.Decision.ALLOWED){if(lifecycle.id()==null)stopSelfResult(startId);return START_NOT_STICKY;}
        }
        boolean newSession = lifecycle.id() == null;
        currentEvent = event; lifecycle.add(event);
        long deadline = intent.getLongExtra("expiresElapsed",SystemClock.elapsedRealtime()+120000);
        if (newSession) { startup = new AudioFocusStartup(); eventDeadline = deadline; }
        else eventDeadline = Math.min(eventDeadline,deadline);
        failureReason = Reason.FGS_REJECTED;
        AlarmDiagnostics.record(Stage.FGS_PROMOTE_REQUEST,event,Reason.NONE);
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) startForeground(Notices.PLAYBACK_ID, Notices.playback(this,lifecycle.id(),lifecycle.count()),ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(Notices.PLAYBACK_ID,Notices.playback(this,lifecycle.id(),lifecycle.count()));
        } catch (RuntimeException error) {
            AlarmDiagnostics.failure(Stage.FGS_PROMOTE_FAILED,event,error); failed(Reason.FGS_REJECTED); return START_NOT_STICKY;
        }
        foregroundPromoted = true;
        if (newSession) foregroundAt = SystemClock.elapsedRealtime();
        startup.foreground();
        AlarmDiagnostics.record(Stage.FGS_PROMOTED,event,Reason.NONE);
        snapshot(AlarmDiagnostics.FocusPhase.PROMOTED,-1);
        try {
            // No fixed sleep, speculative retry or target-SDK workaround. Exactly one request after promotion.
            if (startup.request()) {
                audio = getSystemService(AudioManager.class);
                final String expectedSession = lifecycle.id();
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(change -> focusChanged(expectedSession,change),handler).build();
                failureReason = Reason.AUDIO_FOCUS_DENIED;
                snapshot(AlarmDiagnostics.FocusPhase.BEFORE_REQUEST,-1);
                int result = audio.requestAudioFocus(focus);
                startup.result(result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED,result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED);
                AlarmDiagnostics.number(Stage.AUDIO_FOCUS,event,result);
                snapshot(AlarmDiagnostics.FocusPhase.AFTER_REQUEST,result);
                if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    hasFocus = true; preparePlayer(expectedSession);
                } else if (result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED) {
                    AlarmDiagnostics.record(Stage.AUDIO_FOCUS,event,Reason.AUDIO_FOCUS_DELAYED);
                    // Only honor an actual platform DELAYED result, never retry a rejected (0) request.
                    focusTimeout = () -> {
                        if (lifecycle.current(expectedSession) && startup.timeout()) {
                            snapshot(AlarmDiagnostics.FocusPhase.TIMEOUT,AudioManager.AUDIOFOCUS_REQUEST_DELAYED);
                            failed(Reason.AUDIO_FOCUS_TIMEOUT);
                        }
                    };
                    handler.postDelayed(focusTimeout,Math.min(5000,Math.max(0,eventDeadline-SystemClock.elapsedRealtime())));
                } else failed(Reason.AUDIO_FOCUS_DENIED);
            } else if (prepared && hasFocus && player != null && player.isPlaying()) lifecycle.playing();
        } catch (Exception error) {
            AlarmDiagnostics.failure(Stage.PLAYBACK_FAILED,event,error); failed(failureReason);
        }
        return START_NOT_STICKY;
    }
    private void preparePlayer(String expectedSession) {
        if (!foregroundPromoted || !lifecycle.current(expectedSession) || startup.state() != AudioFocusStartup.State.GRANTED || player != null) return;
        if (SystemClock.elapsedRealtime() >= eventDeadline) { failed(Reason.AUDIO_FOCUS_TIMEOUT); return; }
        failureReason = Reason.PLAYER_ERROR;
        try {
            android.net.Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (sound == null) { failed(Reason.NO_ALARM_SOUND); return; }
            player = new MediaPlayer(); player.setAudioAttributes(attributes);
            player.setWakeMode(this,android.os.PowerManager.PARTIAL_WAKE_LOCK); player.setDataSource(this,sound); player.setLooping(true);
            player.setOnPreparedListener(p -> {
                if (p != player || !lifecycle.current(expectedSession)) return;
                if(SystemClock.elapsedRealtime()>=eventDeadline){failed(Reason.AUDIO_FOCUS_TIMEOUT);return;}
                prepared = true; AlarmDiagnostics.record(Stage.PLAYER_PREPARED,currentEvent,Reason.NONE);
                try { if (hasFocus) { p.start(); lifecycle.playing(); AlarmDiagnostics.record(Stage.PLAYER_STARTED,currentEvent,Reason.NONE); } }
                catch (RuntimeException error) { AlarmDiagnostics.failure(Stage.PLAYBACK_FAILED,currentEvent,error); failed(Reason.PLAYER_ERROR); }
            });
            player.setOnErrorListener((p,what,extra) -> { if (p == player && lifecycle.current(expectedSession)) failed(Reason.PLAYER_ERROR); return true; });
            player.prepareAsync();
        } catch (Exception error) { AlarmDiagnostics.failure(Stage.PLAYBACK_FAILED,currentEvent,error); failed(Reason.PLAYER_ERROR); }
    }
    private void focusChanged(String expected,int change) {
        if (!lifecycle.current(expected)) return;
        AlarmDiagnostics.number(Stage.AUDIO_FOCUS,currentEvent,change);
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            if (!startup.gained()) return;
            hasFocus = true;
            if (focusTimeout != null) { handler.removeCallbacks(focusTimeout); focusTimeout = null; }
            snapshot(AlarmDiagnostics.FocusPhase.CALLBACK,change);
            if (player == null) { preparePlayer(expected); return; }
        } else {
            hasFocus = false; AlarmDiagnostics.record(Stage.AUDIO_FOCUS,currentEvent,Reason.FOCUS_LOST);
        }
        try {
            if (player != null && prepared) {
                if (!hasFocus) player.pause(); else { player.start(); lifecycle.playing(); }
            }
        } catch (RuntimeException error) { AlarmDiagnostics.failure(Stage.PLAYBACK_FAILED,currentEvent,error); failed(Reason.PLAYER_ERROR); }
    }
    private void snapshot(AlarmDiagnostics.FocusPhase phase,int result) {
        AlarmDiagnostics.audioSnapshot(this,currentEvent,phase,foregroundPromoted,foregroundAt,startup.state(),result,attributes);
    }
    private void failed(Reason reason) { failureReason = reason; AlarmDiagnostics.record(Stage.PLAYBACK_FAILED,currentEvent,reason); lifecycle.failed(); }
    private void release() {
        startup.close(); prepared = false; hasFocus = false;
        if (focusTimeout != null) { handler.removeCallbacks(focusTimeout); focusTimeout = null; }
        if (player != null) { MediaPlayer old = player; player = null; old.setOnPreparedListener(null); old.setOnErrorListener(null); old.release(); }
        if (audio != null && focus != null) { AudioFocusRequest old = focus; focus = null; audio.abandonAudioFocusRequest(old); }
    }
    @Override public void onDestroy() { release(); foregroundPromoted = false; AlarmDiagnostics.record(Stage.SERVICE_DESTROYED,currentEvent,Reason.NONE); if (active == this) active = null; super.onDestroy(); }
    @Override public IBinder onBind(Intent i) { return null; }
}
