package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;

/** Durable intent. Never infer OFF merely because a monitoring period ended. */
public final class FsiPreference {
    private FsiPreference() { }
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences("fsi-preference",Context.MODE_PRIVATE);}
    public static boolean migrate(Context c){
        synchronized(FsiPreference.class){
            if(prefs(c).contains("enabled"))return true;
            boolean prior=new MonitoringStore(c).fsiDeclared()||c.getSharedPreferences("fsi-v1",Context.MODE_PRIVATE).getBoolean("urgent",false);
            return !prior||prefs(c).edit().putBoolean("enabled",true).putString("origin","LEGACY_CONSENT").commit();
        }
    }
    public static boolean enabled(Context c){return migrate(c)&&prefs(c).getBoolean("enabled",false);}
    public static boolean permits(Context c){return enabled(c);}
    public static String origin(Context c){migrate(c);return prefs(c).getString("origin",prefs(c).contains("enabled")?"LEGACY_CHOICE_REVIEW":"UNCONFIRMED");}
    public static boolean set(Context c,boolean enabled){synchronized(FsiPreference.class){return prefs(c).edit().putBoolean("enabled",enabled).putString("origin","USER").commit();}}
}
