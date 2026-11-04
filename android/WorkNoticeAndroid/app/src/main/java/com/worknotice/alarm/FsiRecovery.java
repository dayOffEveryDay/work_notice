package com.worknotice.alarm;

import android.app.NotificationManager;
import android.content.Context;
import android.util.Log;

/** Synchronous, repeatable disk-backed recovery. No network, new consent, or session commands. */
public final class FsiRecovery {
    public enum Reason { READY, WAITING_FOR_START, PREFERENCE_OFF, CONSENT_MISSING,
        REVISION_MISMATCH, PAIRING_MISMATCH, SESSION_MISMATCH, MONITORING_OFF,
        CREDENTIAL_UNAVAILABLE, SYSTEM_PERMISSION_DENIED, NOTIFICATIONS_BLOCKED, URGENT_CHANNEL_BLOCKED,
        EVENT_REGISTRATION_FAILED, NOTIFICATION_POST_FAILED }
    private FsiRecovery() { }
    public static Reason reason(Context c) {
        FsiStatus s=FsiSettings.status(c); MonitoringStore m=new MonitoringStore(c);
        if(!FsiPreference.enabled(c))return Reason.PREFERENCE_OFF;
        if(!s.declared)return Reason.CONSENT_MISSING;
        if(!s.periodValid)return Reason.REVISION_MISMATCH;
        if(!s.pairingValid)return Reason.PAIRING_MISMATCH;
        if(m.has()&&!m.fsiSessionMatches())return Reason.SESSION_MISMATCH;
        if(!s.alarmEnabled)return Reason.MONITORING_OFF;
        if(new DeviceTokenStore(c).get("bearer").isEmpty())return Reason.CREDENTIAL_UNAVAILABLE;
        if(!s.granted)return Reason.SYSTEM_PERMISSION_DENIED;
        if(!Notices.allowed(c))return Reason.NOTIFICATIONS_BLOCKED;
        var channel=c.getSystemService(NotificationManager.class).getNotificationChannel(Notices.URGENT);
        if(channel==null||channel.getImportance()<NotificationManager.IMPORTANCE_HIGH)return Reason.URGENT_CHANNEL_BLOCKED;
        if(m.has()&&!m.active())return Reason.WAITING_FOR_START;
        return Reason.READY;
    }
    public static Reason restore(Context c,String event) {
        log("FSI_RESTORE_START",event,null);
        // SharedPreferences construction/getters are synchronous. Never rely on MainActivity,
        // an in-memory 'restored' flag, or rebind old consent to a new revision.
        FsiPreference.migrate(c);
        MonitoringStore m=new MonitoringStore(c); FsiStatus s=FsiSettings.status(c);
        Log.i(AlarmDiagnostics.TAG,"stage=MONITORING_SESSION event="+FsiSettings.ref(event)
            +" revision="+m.revision()+" mode="+m.mode()+" state="+m.state()+" startsAtMs="+m.starts()+" localEnded="+m.ended());
        Log.i(AlarmDiagnostics.TAG,"stage=SESSION_REVISION_CHECK event="+FsiSettings.ref(event)
            +" revisionValid="+s.periodValid+" sessionValid="+m.fsiSessionMatches()+" pairingValid="+s.pairingValid);
        Log.i(AlarmDiagnostics.TAG,"stage=FSI_CONSENT_CHECK event="+FsiSettings.ref(event)
            +" declared="+s.declared+" preference="+FsiPreference.enabled(c)+" origin="+FsiPreference.origin(c));
        Reason result=reason(c); log("FSI_RESTORE_RESULT",event,result); return result;
    }
    public static void log(String stage,String event,Reason reason) {
        Log.i(AlarmDiagnostics.TAG,"stage="+stage+" event="+FsiSettings.ref(event)+(reason==null?"":" reason="+reason));
    }
    public static String display(Context c) {
        return "FSI 實際就緒檢查："+description(reason(c))+"\n同意僅適用已儲存的配對、session 與 revision；未變更原監控期間。";
    }
    public static String description(Reason reason) {
        return switch(reason) {
            case READY -> "已準備（仍須通過單筆事件檢查）";
            case WAITING_FOR_START -> "已準備，等待原預約時間";
            case PREFERENCE_OFF -> "偏好已關閉";
            case CONSENT_MISSING -> "缺少可恢復的本機緊急用途同意";
            case REVISION_MISMATCH -> "同意綁定的 revision 不符合目前監控期間";
            case PAIRING_MISMATCH -> "同意綁定的配對世代不符";
            case SESSION_MISMATCH -> "同意綁定的 session 不符合目前監控期間";
            case MONITORING_OFF -> "監控已關閉、取消或設定不可用";
            case CREDENTIAL_UNAVAILABLE -> "配對憑證尚不可讀，無法確認背景 FCM 資格";
            case SYSTEM_PERMISSION_DENIED -> "系統 FSI 授權未允許";
            case NOTIFICATIONS_BLOCKED -> "通知權限或必要通知頻道已關閉";
            case URGENT_CHANNEL_BLOCKED -> "緊急警報頻道缺少或重要性不足";
            default -> reason.name();
        };
    }
}
