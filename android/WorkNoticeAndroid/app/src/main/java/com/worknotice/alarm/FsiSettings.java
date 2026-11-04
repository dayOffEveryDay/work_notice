package com.worknotice.alarm;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/** Explicit local urgency declaration, bound to this pairing and enable period. No message inference. */
public final class FsiSettings {
    private FsiSettings() { }
    static long period(Context c){if(new MonitoringStore(c).has())return new MonitoringStore(c).revision();try{return new org.json.JSONObject(new AlarmPreferencesRepository(c).status()).getJSONObject("alertSetting").optLong("updated_at_ms",-1);}catch(org.json.JSONException e){return -1;}}
    public static boolean consent(Context c){if(new MonitoringStore(c).has())return new MonitoringStore(c).approveFsi();boolean saved=c.getSharedPreferences("fsi-v1",Context.MODE_PRIVATE).edit().putBoolean("urgent",true).putLong("pairing",new AlarmPreferencesRepository(c).pairedAt()).putLong("period",period(c)).commit();if(!saved)clear(c);return saved;}
    public static void clear(Context c){if(!FsiPreference.migrate(c))return;new MonitoringStore(c).clearFsi();c.getSharedPreferences("fsi-v1",Context.MODE_PRIVATE).edit().clear().commit();}
    public static FsiStatus status(Context c){
        MonitoringStore monitor=new MonitoringStore(c);
        if(monitor.has())return monitor.fsiStatus(FsiPreference.permits(c),permission(c));
        var p=c.getSharedPreferences("fsi-v1",Context.MODE_PRIVATE);var a=new AlarmPreferencesRepository(c);boolean alarm=new MonitoringStore(c).has()?new MonitoringStore(c).configured():a.enabled();
        var problem=FsiStatus.AlarmProblem.UNKNOWN;
        if(!alarm){
            var settings=c.getSharedPreferences("settings",Context.MODE_PRIVATE);
            if(new DeviceTokenStore(c).get("bearer").isEmpty())problem=FsiStatus.AlarmProblem.CREDENTIAL_UNAVAILABLE;
            else if(android.provider.Settings.Global.getInt(c.getContentResolver(),android.provider.Settings.Global.BOOT_COUNT,-1)!=settings.getInt("boot",-2))problem=FsiStatus.AlarmProblem.SETTINGS_UNAVAILABLE;
            else if(!settings.getBoolean("enabled",false))problem=FsiStatus.AlarmProblem.CLOSED;
            else if(settings.getBoolean("timed",false)&&android.os.SystemClock.elapsedRealtime()>=settings.getLong("deadline",0))problem=FsiStatus.AlarmProblem.EXPIRED;
            else problem=FsiStatus.AlarmProblem.SETTINGS_UNAVAILABLE;
        }
        return new FsiStatus(p.getBoolean("urgent",false)&&FsiPreference.permits(c),p.getLong("period",-1),period(c),p.getLong("pairing",-1),a.pairedAt(),alarm&&(!new MonitoringStore(c).has()||p.getString("session","").equals(new MonitoringStore(c).session())),permission(c),problem);
    }
    public static boolean enabled(Context c){return status(c).enabled;}
    public static boolean ready(Context c){
        var reason=FsiRecovery.reason(c);
        return reason==FsiRecovery.Reason.READY||reason==FsiRecovery.Reason.WAITING_FOR_START;
    }
    public static boolean permission(Context c){return Build.VERSION.SDK_INT>=34&&c.getSystemService(NotificationManager.class).canUseFullScreenIntent();}
    public static void log(Context c,String event){var s=status(c);android.util.Log.i(AlarmDiagnostics.TAG,"stage=FSI_PERMISSION event="+ref(event)+" preference="+FsiPreference.enabled(c)+" preferenceOrigin="+FsiPreference.origin(c)+" enabled="+s.enabled+" granted="+s.granted+" declared="+s.declared+" periodValid="+s.periodValid+" pairingValid="+s.pairingValid+" alarmEnabled="+s.alarmEnabled+" alarmProblem="+s.alarmProblem+" urgentImportance="+urgentImportance(c)+" notificationsAllowed="+Notices.allowed(c)+" ready="+ready(c)+" reasons="+s.reasons);}
    private static int urgentImportance(Context c){var channel=c.getSystemService(NotificationManager.class).getNotificationChannel(Notices.URGENT);return channel==null?-1:channel.getImportance();}
    public static String ref(String event){return event!=null&&event.matches("[a-f0-9]{64}")?event.substring(0,12):"-";}
    public static void stage(String stage,String event,boolean automatic){android.util.Log.i(AlarmDiagnostics.TAG,"stage="+stage+" event="+ref(event)+" launch="+(automatic?"SYSTEM_FSI":"USER_CLICK"));}
}
