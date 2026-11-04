package com.worknotice.alarm;

import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

/** Fixed enums/booleans/integers only. Never pass exception text, payloads, intents or tokens. */
public final class AlarmDiagnostics {
    public static final String TAG = "WNotice";
    public enum Stage { FCM_RECEIVED, FCM_DECISION, FCM_DONE, FGS_REQUEST, FGS_STARTED, FGS_PROMOTE_REQUEST, FGS_PROMOTED, FGS_PROMOTE_FAILED, AUDIO_FOCUS, AUDIO_FOCUS_SNAPSHOT, PLAYER_PREPARED, PLAYER_STARTED, PLAYBACK_FAILED, MANUAL_STOP, STALE_STOP, SERVICE_DESTROYED, NOTIFICATION, ACK_QUEUED, ACK_RESULT }
    public enum FocusPhase { PROMOTED, BEFORE_REQUEST, AFTER_REQUEST, CALLBACK, TIMEOUT }
    public enum Reason { NONE, UNPAIRED, INVALID_PAYLOAD, STALE_OR_OLD_PAIRING, DUPLICATE, DISABLED, HEALTH_ONLY, NOTIFICATIONS_BLOCKED, PRIORITY_DOWNGRADED, FGS_START_DENIED, SECURITY_DENIED, STATE_ERROR, FGS_REJECTED, AUDIO_FOCUS_DENIED, AUDIO_FOCUS_DELAYED, AUDIO_FOCUS_TIMEOUT, FOCUS_LOST, PLAYER_ERROR, NO_ALARM_SOUND, USER_STOP, UNPAIRED_CANCEL, POSTED, APP_BLOCKED, CHANNEL_BLOCKED, PERMISSION_DENIED, NOTIFY_ERROR, NETWORK_ERROR, API_ERROR }
    private AlarmDiagnostics() { }
    private static String eventRef(String value) {
        return value != null && (value.matches("[a-f0-9]{64}") || value.matches("offline-[0-9]+") || value.matches("local-[a-f0-9-]{36}")) ? value.substring(0, Math.min(12, value.length())) : "-";
    }
    public static void record(Stage stage, String event, Reason reason) {
        Log.i(TAG, "stage=" + stage + " event=" + eventRef(event) + " reason=" + reason + " sdk=" + Build.VERSION.SDK_INT);
    }
    public static void number(Stage stage, String event, int value) {
        Log.i(TAG, "stage=" + stage + " event=" + eventRef(event) + " value=" + value);
    }
    public static void ack(Stage stage, String event, String status, int httpStatus) {
        String safe = "RECEIVED".equals(status) || "RINGING".equals(status) || "STOPPED".equals(status) || "NOTIFICATION_FALLBACK".equals(status) ? status : "UNKNOWN";
        Log.i(TAG,"stage=" + stage + " event=" + eventRef(event) + " ack=" + safe + " httpStatus=" + httpStatus);
    }
    public static void recovery(String event,FallbackAlarm.Decision decision) {
        Log.i(TAG,"stage=USER_RECOVERY event="+eventRef(event)+" decision="+decision);
    }
    public static void ackFailure(String event,String status,Exception error,int attempt){
        String safe="RECEIVED".equals(status)||"RINGING".equals(status)||"STOPPED".equals(status)||"NOTIFICATION_FALLBACK".equals(status)?status:"TOKEN_OR_UNKNOWN";
        Log.i(TAG,"stage=ACK_RESULT event="+eventRef(event)+" ack="+safe+" failure="+AckFailure.classify(error)+" attempt="+attempt+" retry="+(attempt<8));
    }
    public static void failure(Stage stage, String event, Exception error) {
        Reason reason = error instanceof SecurityException ? Reason.SECURITY_DENIED
            : Build.VERSION.SDK_INT >= 31 && error instanceof android.app.ForegroundServiceStartNotAllowedException ? Reason.FGS_START_DENIED
            : error instanceof IllegalStateException ? Reason.STATE_ERROR : Reason.PLAYER_ERROR;
        record(stage, event, reason);
    }
    public static void received(Context c, String event, int original, int actual) {
        PowerManager power = c.getSystemService(PowerManager.class); KeyguardManager keyguard = c.getSystemService(KeyguardManager.class);
        Log.i(TAG, "stage=FCM_RECEIVED event=" + eventRef(event) + " originalPriority=" + original + " actualPriority=" + actual
            + " foreground=" + WorkNoticeApplication.foreground() + " locked=" + keyguard.isKeyguardLocked() + " interactive=" + power.isInteractive()
            + " idle=" + power.isDeviceIdleMode() + " powerSave=" + power.isPowerSaveMode() + " sdk=" + Build.VERSION.SDK_INT);
    }
    public static void elapsed(String event, long started) {
        Log.i(TAG, "stage=FCM_DONE event=" + eventRef(event) + " elapsedMs=" + (SystemClock.elapsedRealtime() - started));
    }
    public static void notification(Context c, String event, String channelId, Reason reason, boolean activeSnapshot) {
        NotificationManager manager = c.getSystemService(NotificationManager.class); NotificationChannel channel = manager.getNotificationChannel(channelId);
        Log.i(TAG, "stage=NOTIFICATION event=" + eventRef(event) + " reason=" + reason + " channel=" + channelId
            + " importance=" + (channel == null ? -1 : channel.getImportance()) + " lockVisibility=" + (channel == null ? -1 : channel.getLockscreenVisibility())
            + " activeSnapshot=" + activeSnapshot + " dnd=" + manager.getCurrentInterruptionFilter());
        Log.i(TAG,"stage=CHANNEL_SETTINGS channel="+channelId+" soundConfigured="+(channel!=null&&channel.getSound()!=null)
            +" vibrationEnabled="+(channel!=null&&channel.shouldVibrate())+" notificationVolume="+c.getSystemService(android.media.AudioManager.class).getStreamVolume(android.media.AudioManager.STREAM_NOTIFICATION)
            +" ringerMode="+c.getSystemService(android.media.AudioManager.class).getRingerMode());
    }
    /** Observations only: raw AppOp/importance are NOT proof of an eligible audio capability. */
    @SuppressWarnings("deprecation")
    public static void audioSnapshot(android.app.Service service, String event, FocusPhase phase, boolean foregroundReturned, long foregroundAt, AudioFocusStartup.State state, int result, android.media.AudioAttributes attributes) {
        android.app.ActivityManager.RunningAppProcessInfo process = new android.app.ActivityManager.RunningAppProcessInfo();
        android.app.ActivityManager.getMyMemoryState(process);
        int systemForeground = -1, type = -1, rawOp = -1;
        try {
            var services = service.getSystemService(android.app.ActivityManager.class).getRunningServices(32);
            if (services != null) for (var item : services) if (item.pid == android.os.Process.myPid() && item.service != null && item.service.getClassName().equals(service.getClass().getName())) systemForeground = item.foreground ? 1 : 0;
        } catch (RuntimeException ignored) { }
        if (Build.VERSION.SDK_INT >= 29) {
            try { type = service.getForegroundServiceType(); } catch (RuntimeException ignored) { }
            try { rawOp = service.getSystemService(android.app.AppOpsManager.class).unsafeCheckOpRawNoThrow("android:take_audio_focus",android.os.Process.myUid(),service.getPackageName()); } catch (RuntimeException ignored) { }
        }
        Log.i(TAG,"stage=AUDIO_FOCUS_SNAPSHOT event=" + eventRef(event) + " phase=" + phase + " sdk=" + Build.VERSION.SDK_INT + " targetSdk=" + service.getApplicationInfo().targetSdkVersion
            + " foregroundReturned=" + foregroundReturned + " systemForeground=" + systemForeground + " fgsType=" + type + " importance=" + process.importance
            + " foregroundAgeMs=" + (foregroundAt > 0 ? SystemClock.elapsedRealtime() - foregroundAt : -1) + " appVisible=" + WorkNoticeApplication.foreground()
            + " locked=" + service.getSystemService(KeyguardManager.class).isKeyguardLocked() + " appOpRaw=" + rawOp + " state=" + state + " uid=" + android.os.Process.myUid() + " pid=" + android.os.Process.myPid()
            + " result=" + result + " usage=" + attributes.getUsage() + " contentType=" + attributes.getContentType() + " gain=" + android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
    }
}
