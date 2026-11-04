package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;
import org.json.JSONObject;

public final class AlarmPreferencesRepository {
    private final Context context;
    private final SharedPreferences prefs;
    private final java.util.function.BooleanSupplier paired;
    public AlarmPreferencesRepository(Context c) { this(c,()->!new DeviceTokenStore(c).get("bearer").isEmpty()); }
    AlarmPreferencesRepository(Context c,java.util.function.BooleanSupplier paired) { context = c;this.paired=paired;prefs=c.getSharedPreferences("settings",Context.MODE_PRIVATE); }
    private int boot() { return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1); }
    public void update(JSONObject status, long roundTripMs) {
        JSONObject setting = status.optJSONObject("alertSetting");
        if (setting == null) return;
        if(!new MonitoringStore(context).has()&&!setting.optBoolean("effectiveEnabled",false))FsiSettings.clear(context);
        if(new MonitoringStore(context).has()){prefs.edit().putString("status",status.toString()).putLong("updated",System.currentTimeMillis()).apply();return;}
        // Advancing by the entire round trip is conservative: never extend server expiry by latency.
        long server = status.optLong("serverNow", 0) + Math.max(0, roundTripMs), now = SystemClock.elapsedRealtime();
        long expiry = setting.optLong("expires_at_ms", 0);
        prefs.edit().putBoolean("enabled", setting.optBoolean("effectiveEnabled", false)).putBoolean("timed", "TIMED".equals(setting.optString("mode")))
            .putLong("deadline", now + Math.max(0, expiry - server)).putInt("boot", boot()).putLong("server", server).putLong("elapsed", now)
            .putString("status", status.toString()).putLong("updated", System.currentTimeMillis()).apply();
    }
    public boolean enabled() {
        MonitoringStore monitor=new MonitoringStore(context);if(monitor.has())return paired.getAsBoolean()&&monitor.active();
        return boot() == prefs.getInt("boot", -2) && AlarmPolicy.enabled(paired.getAsBoolean(), prefs.getBoolean("enabled", false), prefs.getBoolean("timed", false), prefs.getLong("deadline", 0), SystemClock.elapsedRealtime());
    }
    public long serverNow() { if(new MonitoringStore(context).has())return new MonitoringStore(context).serverNow();return boot() == prefs.getInt("boot", -2) ? prefs.getLong("server", System.currentTimeMillis()) + SystemClock.elapsedRealtime() - prefs.getLong("elapsed", SystemClock.elapsedRealtime()) : System.currentTimeMillis(); }
    public void disableLocal() { FsiSettings.clear(context);prefs.edit().putBoolean("enabled", false).apply(); }
    public String status() { return prefs.getString("status", "{}"); }
    public long updated() { return prefs.getLong("updated", 0); }
    public boolean timed(){return prefs.getBoolean("timed",false);}
    public long remainingMillis(){return boot()==prefs.getInt("boot",-2)&&timed()?Math.max(0,prefs.getLong("deadline",0)-SystemClock.elapsedRealtime()):0;}
    public long pairedAt() { if(new MonitoringStore(context).has())return new MonitoringStore(context).pairedAt();try { return new JSONObject(status()).optLong("pairedAt", Long.MAX_VALUE); } catch (Exception e) { return Long.MAX_VALUE; } }
    public boolean offlineAlerts() { try { return new JSONObject(status()).optBoolean("offlineAlerts", true); } catch (Exception e) { return true; } }
    public void clear() { new MonitoringStore(context).clear();FsiSettings.clear(context);prefs.edit().clear().commit(); }
}
