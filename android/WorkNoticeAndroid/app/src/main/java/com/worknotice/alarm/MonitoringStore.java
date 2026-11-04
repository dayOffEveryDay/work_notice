package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;
import org.json.JSONObject;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/** Confirmed backend state, a durable command, and a local stop tombstone. No wake-up alarm. */
public final class MonitoringStore {
    private static final Object LOCK=new Object();
    private final Context context;private final SharedPreferences prefs;
    public MonitoringStore(Context c){context=c;prefs=c.getSharedPreferences("monitoring-v1",Context.MODE_PRIVATE);}
    private int boot(){return Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT,-1);}
    public boolean has(){return prefs.contains("root");}
    public JSONObject root(){try{return new JSONObject(prefs.getString("root","{}"));}catch(Exception e){return new JSONObject();}}
    public JSONObject setting(){return root().optJSONObject("monitoring")==null?new JSONObject():root().optJSONObject("monitoring");}
    public long revision(){return setting().optLong("revision",0);}
    public String session(){return setting().optString("session_id","");}
    public String mode(){return setting().optString("mode","OFF");}
    public long starts(){return setting().optLong("starts_at_ms",Long.MAX_VALUE);}
    public long pairedAt(){return root().optLong("pairedAt",Long.MAX_VALUE);}
    public boolean ended(){return prefs.getBoolean("localEnded",false);}
    public long serverNow(){return boot()==prefs.getInt("boot",-2)?prefs.getLong("server",System.currentTimeMillis())+SystemClock.elapsedRealtime()-prefs.getLong("elapsed",SystemClock.elapsedRealtime()):System.currentTimeMillis()+prefs.getLong("offset",0);}
    public boolean configured(){return has()&&!ended()&&!"OFF".equals(mode());}
    public boolean active(){return configured()&&serverNow()>=starts();}
    public long remaining(){return configured()?Math.max(0,starts()-serverNow()):0;}
    public String state(){return !configured()?"OFF":active()?"ACTIVE":"SCHEDULED";}
    public boolean fsiDeclared(){return prefs.getBoolean("fsiDeclared",false);}
    public long fsiRevision(){return prefs.getLong("fsiRevision",-1);}
    public long fsiPairing(){return prefs.getLong("fsiPairing",-1);}
    public boolean approveFsi(){synchronized(LOCK){return configured()&&prefs.edit().putBoolean("fsiDeclared",true).putLong("fsiRevision",revision()).putLong("fsiPairing",pairedAt()).putString("fsiSession",session()).commit();}}
    public void clearFsi(){synchronized(LOCK){prefs.edit().remove("fsiDeclared").remove("fsiRevision").remove("fsiPairing").remove("fsiSession").commit();}}
    FsiStatus fsiStatus(boolean preference,boolean permission){synchronized(LOCK){
        return new FsiStatus(fsiDeclared()&&preference,fsiRevision(),revision(),fsiPairing(),pairedAt(),configured()&&fsiSessionMatches(),permission);
    }}
    public boolean fsiSessionMatches(){return session().equals(prefs.getString("fsiSession",""));}
    public boolean matchesActive(JSONObject monitor){return monitor!=null&&!ended()&&"ACTIVE".equals(monitor.optString("state"))&&monitor.optLong("revision",-1)==revision()&&session().equals(monitor.optString("session_id"));}
    public String error(){return prefs.getString("error","");}
    public void error(String value){prefs.edit().putString("error",value).commit();}
    public JSONObject pending(){try{return new JSONObject(prefs.getString("pending",""));}catch(Exception e){return null;}}
    public JSONObject command(String mode,int minutes,boolean urgent,long pairing) throws Exception {synchronized(LOCK){
        if("OFF".equals(mode)&&pending()!=null&&"OFF".equals(pending().optString("mode"))&&pending().optLong("expectedRevision")==revision())return pending();
        if(!"OFF".equals(mode)&&pending()!=null&&pending().optLong("expectedRevision")>=revision())throw new IllegalStateException("pending_command");
        JSONObject command=new JSONObject().put("commandId",UUID.randomUUID().toString()).put("expectedRevision",revision()).put("mode",mode).put("delayMinutes",mode.equals("SCHEDULED")?minutes:0).put("urgentConsent",urgent);
        if(!prefs.edit().putString("pending",command.toString()).putLong("pendingPairing",pairing).putBoolean("localEnded","OFF".equals(mode)||ended()).putString("error","").commit())throw new IllegalStateException("storage_failed");
        if("OFF".equals(mode))FsiSettings.clear(context);
        return command;
    }}
    public boolean update(JSONObject root,long roundTrip) throws Exception {synchronized(LOCK){
        JSONObject s=root.getJSONObject("monitoring");String mode=s.getString("mode");long revision=s.getLong("revision"),now=root.getLong("serverNow");
        if(!java.util.List.of("OFF","IMMEDIATE","SCHEDULED").contains(mode)||revision<0||now<=0||root.getLong("pairedAt")<=0)throw new org.json.JSONException("invalid_monitoring");
        if(!"OFF".equals(mode)&&(!s.getString("session_id").matches("[a-f0-9]{64}")||s.getLong("starts_at_ms")<=0||revision==0))throw new org.json.JSONException("invalid_session");
        if(has()&&(revision<revision()||(revision==revision()&&now<prefs.getLong("server",0))))return false;
        if(has()&&revision==revision()&&!session().equals(s.optString("session_id","")))return false;
        JSONObject pending=pending();boolean confirms=pending!=null&&pending.optString("commandId").equals(s.optString("last_command_id"));
        boolean consent=confirms&&pending.optBoolean("urgentConsent")&&!"OFF".equals(mode);
        long corrected=now+Math.max(0,roundTrip);
        var edit=prefs.edit().putString("root",root.toString()).putLong("server",corrected).putLong("elapsed",SystemClock.elapsedRealtime()).putInt("boot",boot()).putLong("offset",corrected-System.currentTimeMillis());
        if(pending==null)edit.putString("error","");
        if(confirms)edit.remove("pending").putBoolean("localEnded","OFF".equals(mode)).putString("error","");
        if(consent)edit.putBoolean("fsiDeclared",true).putLong("fsiRevision",revision).putLong("fsiPairing",root.getLong("pairedAt")).putString("fsiSession",s.getString("session_id"));
        if(!edit.commit())throw new IllegalStateException("storage_failed");
        return true;
    }}
    public boolean accept(Map<String,String> data){synchronized(LOCK){try{
        JSONObject pending=pending();
        if(ended()&&(pending==null||!pending.optBoolean("urgentConsent")||"OFF".equals(pending.optString("mode"))))return false;
        long revision=Long.parseLong(data.get("monitoringRevision"));String session=data.get("monitoringSessionId");
        // If the process died after the server committed, the first trusted FCM can
        // reconcile only the exact command the user already confirmed before sending.
        if((revision!=revision()||!java.util.Objects.equals(session,session()))&&pending!=null&&pending.optBoolean("urgentConsent")&&pending.optString("commandId").equals(data.get("monitoringCommandId"))&&revision==pending.optLong("expectedRevision")+1&&pending.optString("mode").equals(data.get("monitoringMode"))){
            JSONObject s=new JSONObject().put("mode",data.get("monitoringMode")).put("session_id",session).put("revision",revision).put("starts_at_ms",Long.parseLong(data.get("monitoringStartsAtMs"))).put("last_command_id",data.get("monitoringCommandId")).put("urgent_consent",1);
            long sent=Long.parseLong(data.get("serverNowMs")),estimated=serverNow();
            if(sent>estimated+30000||estimated-sent>120000)return false;
            update(new JSONObject().put("serverNow",Math.max(sent,estimated)).put("pairedAt",prefs.getLong("pendingPairing",Long.MAX_VALUE)).put("monitoring",s),0);
        }
        if(!active()||revision!=revision()||!java.util.Objects.equals(session,session())||!mode().equals(data.get("monitoringMode"))||Long.parseLong(data.get("monitoringStartsAtMs"))!=starts())return false;
        long now=serverNow(),sent=Long.parseLong(data.get("serverNowMs")),issued=Instant.parse(data.get("issuedAt")).toEpochMilli(),occurred=Instant.parse(data.get("occurredAt")).toEpochMilli(),expires=Instant.parse(data.get("expiresAt")).toEpochMilli();
        return sent<=now+30000&&now-sent<=120000&&issued>=starts()&&occurred>=starts()&&occurred<=now+30000&&AlarmPolicy.freshForPairing(issued,expires,now,pairedAt())&&now-occurred<=120000;
    }catch(Exception e){return false;}}}
    public void clear(){prefs.edit().clear().commit();}
}
