package com.worknotice.alarm;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;

/** One process-wide settings write at a time, including Activity recreation. */
public final class AlarmSettingsSave {
    public interface Gateway { JSONObject call(String method,String path,JSONObject body) throws Exception; }
    public interface Store { void update(JSONObject status,long roundTripMs) throws Exception; }
    public interface Clock { long now(); }
    public static final class Unconfirmed extends Exception { Unconfirmed(Exception cause){super(cause);} }
    private static final AtomicBoolean BUSY=new AtomicBoolean();
    private boolean owned;
    public static boolean busy(){return BUSY.get();}
    public boolean begin(){if(owned)return false;owned=BUSY.compareAndSet(false,true);return owned;}
    public void cancel(){if(owned){owned=false;BUSY.set(false);}}
    public void perform(Gateway gateway,Store store,Clock clock,boolean enabled,String mode,int minutes,boolean offline) throws Exception {
        if(!owned)throw new IllegalStateException("Settings save not reserved");
        boolean written=false;
        try {
            gateway.call("PUT","/api/mobile/alert-settings",new JSONObject().put("enabled",enabled).put("mode",mode).put("durationMinutes",minutes).put("offlineAlerts",offline));
            written=true;long started=clock.now();
            JSONObject status=gateway.call("GET","/api/mobile/status",null);
            JSONObject setting=status.getJSONObject("alertSetting");
            long server=status.getLong("serverNow");
            String actualMode=setting.getString("mode");
            // D1's stored enabled is INTEGER 0/1; effectiveEnabled is the API boolean.
            setting.getBoolean("effectiveEnabled");
            if(server<=0||setting.getLong("updated_at_ms")<=0||!("TIMED".equals(actualMode)||"UNTIL_MANUALLY_DISABLED".equals(actualMode)))throw new org.json.JSONException("Invalid settings snapshot");
            if("TIMED".equals(actualMode)&&setting.getBoolean("effectiveEnabled")&&setting.getLong("expires_at_ms")<=server)throw new org.json.JSONException("Expired active snapshot");
            store.update(status,Math.max(0,clock.now()-started));
        }catch(Exception e){if(written)throw new Unconfirmed(e);throw e;}
        finally{cancel();}
    }
}
