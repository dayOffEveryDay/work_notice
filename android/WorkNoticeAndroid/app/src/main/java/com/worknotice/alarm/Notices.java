package com.worknotice.alarm;
import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import java.util.Objects;

public final class Notices {
    public static final String WORK = "work-alerts", HEALTH = "health-warnings", PLAYBACK = "alarm-playback", URGENT="urgent-work-fsi-v1";
    public static final int PLAYBACK_ID = 100, WORK_ID = 101, HEALTH_ID = 102;
    private Notices() { }
    public static void channels(Context c) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        if(manager.getNotificationChannel(URGENT)==null){
            NotificationChannel urgent=new NotificationChannel(URGENT,"緊急工作警報（全螢幕實驗）",NotificationManager.IMPORTANCE_HIGH);
            urgent.setDescription("僅在明確宣告緊急工作期間使用；不保證背景或鎖屏響鈴");
            urgent.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            urgent.setSound(android.provider.Settings.System.DEFAULT_ALARM_ALERT_URI,new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ALARM).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            urgent.enableVibration(true);manager.createNotificationChannel(urgent);
        }
        if(manager.getNotificationChannel(WORK)==null){
            NotificationChannel work = new NotificationChannel(WORK, "Work Alerts", NotificationManager.IMPORTANCE_HIGH);
            work.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            work.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_EVENT).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            work.enableVibration(true);work.setVibrationPattern(new long[]{0,250,150,250});
            manager.createNotificationChannel(work);
        }
        NotificationChannel health = new NotificationChannel(HEALTH, "Health Warnings", NotificationManager.IMPORTANCE_DEFAULT);
        health.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC); manager.createNotificationChannel(health);
        NotificationChannel playback = new NotificationChannel(PLAYBACK, "警報播放中", NotificationManager.IMPORTANCE_LOW);
        playback.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC); playback.setSound(null, null); manager.createNotificationChannel(playback);
    }
    private static boolean permission(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
    private static boolean channelAllowed(Context c, String id) {
        NotificationChannel channel = c.getSystemService(NotificationManager.class).getNotificationChannel(id);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    public static boolean allowed(Context c) {
        return permission(c) && c.getSystemService(NotificationManager.class).areNotificationsEnabled() && channelAllowed(c, WORK) && channelAllowed(c, PLAYBACK);
    }
    public static Notification.Builder base(Context c, String channel, String title, String detail) {
        Intent intent = new Intent(c, MainActivity.class);
        return new Notification.Builder(c, channel).setSmallIcon(R.drawable.ic_notice).setContentTitle(title).setContentText(detail)
            // All content is generic. User/OEM lock-screen policy may still hide it.
            .setVisibility(Notification.VISIBILITY_PUBLIC).setContentIntent(PendingIntent.getActivity(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }
    public static Notification playback(Context c, String session, int count) {
        Intent stop = new Intent(c, AlarmStopReceiver.class).setAction("STOP").setData(android.net.Uri.parse("worknotice://stop/" + session)).putExtra("session", session);
        PendingIntent pending = PendingIntent.getBroadcast(c, 0, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = base(c, PLAYBACK, "工作警報播放中 · " + count + " 則", "停止響鈴不會關閉未來警報")
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_ALARM)
            .addAction(new Notification.Action.Builder(null, "停止目前警報", pending).build());
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }
    public static String workTag(String event) { return "work:" + event; }
    public static boolean workReceived(Context c, String event) {
        return post(c, event, WORK, workTag(event), WORK_ID,
            base(c, WORK, "工作通知", "已收到新的工作事件；請開啟 App 查看警報狀態").setCategory(Notification.CATEGORY_ALARM).setOnlyAlertOnce(true).build());
    }
    private static boolean post(Context c, String event, String channel, String tag, int id, Notification notice) {
        NotificationManager manager = c.getSystemService(NotificationManager.class);
        AlarmDiagnostics.Reason blocked = !permission(c) ? AlarmDiagnostics.Reason.PERMISSION_DENIED
            : !manager.areNotificationsEnabled() ? AlarmDiagnostics.Reason.APP_BLOCKED
            : !channelAllowed(c, channel) ? AlarmDiagnostics.Reason.CHANNEL_BLOCKED : null;
        if (blocked != null) {
            problem(c, "一般通知無法顯示：" + blocked + "；請檢查通知權限與通道設定");
            AlarmDiagnostics.notification(c, event, channel, blocked, false); return false;
        }
        try { manager.notify(tag, id, notice); }
        catch (SecurityException e) { problem(c, "一般通知被系統拒絕"); AlarmDiagnostics.notification(c,event,channel,AlarmDiagnostics.Reason.SECURITY_DENIED,false); return false; }
        catch (RuntimeException e) { problem(c, "一般通知送出失敗"); AlarmDiagnostics.notification(c,event,channel,AlarmDiagnostics.Reason.NOTIFY_ERROR,false); return false; }
        boolean active = false;
        try { for (android.service.notification.StatusBarNotification n : manager.getActiveNotifications()) if (n.getId() == id && Objects.equals(n.getTag(),tag)) active = true; }
        catch (RuntimeException ignored) { /* Snapshot is diagnostic, not proof of lock-screen visibility. */ }
        AlarmDiagnostics.notification(c,event,channel,AlarmDiagnostics.Reason.POSTED,active); return true;
    }
    private static void problem(Context c, String text) { c.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().putString("lastProblem", text).apply(); }
    private static String description(AlarmDiagnostics.Reason reason) {
        return switch (reason) {
            case AUDIO_FOCUS_DENIED -> "系統未允許警報取得音訊焦點";
            case AUDIO_FOCUS_TIMEOUT -> "等待系統允許音訊播放逾時，請開啟 App 檢查";
            case FGS_START_DENIED, FGS_REJECTED -> "系統禁止從背景啟動持續播放";
            case PRIORITY_DOWNGRADED -> "訊息以一般優先級送達，背景無法啟動播放";
            case NOTIFICATIONS_BLOCKED -> "通知權限或警報通道未開啟";
            case SECURITY_DENIED -> "系統拒絕播放所需權限";
            case NO_ALARM_SOUND -> "系統沒有可用的警報音";
            default -> "警報播放發生錯誤，請檢查音量及背景限制";
        };
    }
    public static boolean fallback(Context c, String event, AlarmDiagnostics.Reason reason) {
        problem(c, "無法持續響鈴：" + description(reason));
        Notification.Builder builder=base(c, WORK, "工作通知：請開啟 App 檢查", description(reason)).setCategory(Notification.CATEGORY_ALARM).setOnlyAlertOnce(true);
        String nonce=new PendingAlarmStore(c).offer(event);
        if(nonce!=null){
            Intent open=new Intent(c,RingActionActivity.class).setAction(RingActionActivity.ACTION)
                .setData(android.net.Uri.parse("worknotice://ring/"+event)).putExtra("event",event).putExtra("actionNonce",nonce);
            PendingIntent action=PendingIntent.getActivity(c,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(new Notification.Action.Builder(null,"開啟並響鈴",action).build());
        }
        boolean posted = post(c, event, WORK, workTag(event), WORK_ID,builder.build());
        // notify returned successfully, not proof that a user saw or heard it.
        if (posted) CloudSyncWorker.ack(c, event, "NOTIFICATION_FALLBACK");
        if(posted)postFsi(c,event);
        return posted;
    }
    public static boolean postFsi(Context c,String event){
        FsiSettings.log(c,event);
        FsiRecovery.Reason reason=FsiRecovery.restore(c,event);
        if(reason!=FsiRecovery.Reason.READY){FsiRecovery.log("FSI_GATE_REJECTED",event,reason);return false;}
        PendingAlarmStore store=new PendingAlarmStore(c);String nonce=store.offerFsi(event);
        if(nonce==null){android.util.Log.i(AlarmDiagnostics.TAG,"stage=FSI_GATE_REJECTED event="+FsiSettings.ref(event)+" reason="+store.fsiBlockReason(event));return false;}
        FsiRecovery.log("FSI_GATE_ACCEPTED",event,FsiRecovery.Reason.READY);
        Notification n=buildFsi(c,event,nonce,store.deadline(event));
        boolean posted=post(c,event,URGENT,"fsi:"+event,103,n);
        if(posted)FsiSettings.stage("FSI_POSTED",event,true);
        else FsiRecovery.log("FSI_GATE_REJECTED",event,FsiRecovery.Reason.NOTIFICATION_POST_FAILED);
        return posted;
    }
    static Notification buildFsi(Context c,String event,String nonce,long deadline){
        return base(c,URGENT,"緊急工作警報","請處理已明確啟用的緊急工作警報")
            .setCategory(Notification.CATEGORY_ALARM).setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(c,0,fsiIntent(c,event,nonce,false),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE))
            .setFullScreenIntent(PendingIntent.getActivity(c,0,fsiIntent(c,event,nonce,true),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE),true)
            .setTimeoutAfter(Math.max(1,deadline-android.os.SystemClock.elapsedRealtime())).build();
    }
    private static Intent fsiIntent(Context c,String event,String nonce,boolean automatic){return new Intent(c,FsiAlarmActivity.class)
        .setAction(automatic?FsiAlarmActivity.AUTO:FsiAlarmActivity.CLICK)
        .setData(android.net.Uri.parse("worknotice://fsi/"+event+"/"+(automatic?"auto":"click")))
        .putExtra("event",event).putExtra("actionNonce",nonce);}
    public static void ringing(Context c,String event){
        c.getSystemService(NotificationManager.class).cancel("fsi:"+event,103);
        post(c,event,WORK,workTag(event),WORK_ID,base(c,WORK,"工作警報播放中","停止目前響鈴不會關閉未來警報").setOnlyAlertOnce(true).build());
    }
    public static void cancelWork(Context c, String event) { c.getSystemService(NotificationManager.class).cancel(workTag(event), WORK_ID);c.getSystemService(NotificationManager.class).cancel("fsi:"+event,103); }
    public static void health(Context c, String event) {
        post(c, event, HEALTH, "health:" + event, HEALTH_ID,
            base(c, HEALTH, "Windows 可能失聯", "超過 180 秒未收到 Heartbeat；請重新整理狀態").setAutoCancel(true).build());
    }
}
