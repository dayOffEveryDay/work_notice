package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.provider.Settings;
import org.json.JSONObject;
import java.security.SecureRandom;

/** Private, no-backup, bounded metadata ledger. Never contains Telegram text or API credentials. */
public final class PendingAlarmStore {
    private static final Object LOCK=new Object();
    private final SharedPreferences prefs;
    private final Context context;
    public PendingAlarmStore(Context c){context=c;prefs=c.getSharedPreferences("fallback-alarms-v1",Context.MODE_PRIVATE);}
    public int boot(){return Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT,-1);}
    private FallbackAlarm read(String event){
        try{JSONObject j=new JSONObject(prefs.getString(event,""));FallbackAlarm a=new FallbackAlarm(event,j.getLong("deadline"),j.getLong("pairing"),j.getInt("boot"),FallbackAlarm.State.valueOf(j.getString("state")),j.optString("action",null));a.fsiEligible=j.optBoolean("fsiEligible");a.fsiOffered=j.optBoolean("fsiOffered");a.fsiPeriod=j.optLong("fsiPeriod",-1);return a;}
        catch(Exception ignored){return null;}
    }
    private boolean write(FallbackAlarm a){
        try{return prefs.edit().putString(a.event,new JSONObject().put("deadline",a.deadline).put("pairing",a.pairing).put("boot",a.boot).put("state",a.state.name()).put("action",a.action).put("fsiEligible",a.fsiEligible).put("fsiOffered",a.fsiOffered).put("fsiPeriod",a.fsiPeriod).toString()).commit();}
        catch(Exception ignored){return false;}
    }
    public boolean register(String event,long deadline,long pairing){return register(event,deadline,pairing,FsiSettings.enabled(context));}
    public boolean register(String event,long deadline,long pairing,boolean urgentEligible){synchronized(LOCK){
        if(!event.matches("[a-f0-9]{64}"))return false;
        if(prefs.contains(event))return false;
        long now=SystemClock.elapsedRealtime();int currentBoot=boot();
        if(currentBoot<0||pairing<=0||pairing==Long.MAX_VALUE||deadline<=now||deadline>now+120000)return false;
        var edit=prefs.edit();int retained=0;
        for(String id:prefs.getAll().keySet()){FallbackAlarm a=read(id);if(a==null||a.boot!=currentBoot||a.deadline<now-86400000)edit.remove(id);else retained++;}
        edit.commit();if(retained>=256)return false;
        FallbackAlarm a=new FallbackAlarm(event,deadline,pairing,currentBoot,FallbackAlarm.State.AUTO,null);a.fsiEligible=urgentEligible;a.fsiPeriod=FsiSettings.period(context);return write(a);
    }}
    public String offer(String event){synchronized(LOCK){
        FallbackAlarm a=read(event);if(a==null||a.boot!=boot()||a.deadline<=SystemClock.elapsedRealtime())return null;
        if(a.state==FallbackAlarm.State.FSI_CLAIMED||a.state==FallbackAlarm.State.FSI_STARTED){a.state=FallbackAlarm.State.AUTO;a.action=null;}
        if(a.state==FallbackAlarm.State.AUTO){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder nonce=new StringBuilder();for(byte b:bytes)nonce.append(String.format(java.util.Locale.ROOT,"%02x",b&255));a.offer(nonce.toString());}
        else if(a.state==FallbackAlarm.State.USER_CLAIMED||a.state==FallbackAlarm.State.USER_STARTED)a.offer("");
        if(!write(a))return null;
        return a.state==FallbackAlarm.State.AVAILABLE?a.action:null;
    }}
    public FallbackAlarm.Decision claim(String event,String nonce,long pairing,boolean paired,boolean enabled){synchronized(LOCK){
        FallbackAlarm a=read(event);if(a==null)return FallbackAlarm.Decision.INVALID_ACTION;
        if(new MonitoringStore(context).has()&&a.fsiPeriod!=FsiSettings.period(context))return FallbackAlarm.Decision.DISABLED;
        var result=a.claim(nonce,SystemClock.elapsedRealtime(),pairing,boot(),paired,enabled);
        return write(a)?result:FallbackAlarm.Decision.INVALID_ACTION;
    }}
    public FallbackAlarm.Decision start(String event,String nonce,long pairing,boolean paired,boolean enabled){synchronized(LOCK){
        FallbackAlarm a=read(event);if(a==null)return FallbackAlarm.Decision.INVALID_ACTION;
        if(new MonitoringStore(context).has()&&a.fsiPeriod!=FsiSettings.period(context))return FallbackAlarm.Decision.DISABLED;
        var result=a.start(nonce,SystemClock.elapsedRealtime(),pairing,boot(),paired,enabled);
        return write(a)?result:FallbackAlarm.Decision.INVALID_ACTION;
    }}
    public long deadline(String event){synchronized(LOCK){FallbackAlarm a=read(event);return a==null?0:a.deadline;}}
    public boolean autoEligible(String event){synchronized(LOCK){FallbackAlarm a=read(event);MonitoringStore m=new MonitoringStore(context);return a!=null&&m.active()&&a.fsiPeriod==m.revision()&&a.pairing==m.pairedAt()&&a.boot==boot()&&a.deadline>SystemClock.elapsedRealtime()&&a.state==FallbackAlarm.State.AUTO;}}
    public String offerFsi(String event){synchronized(LOCK){FallbackAlarm a=read(event);if(a==null||!a.fsiEligible||a.fsiPeriod!=FsiSettings.period(context)||a.fsiOffered||a.state!=FallbackAlarm.State.AVAILABLE||a.deadline<=SystemClock.elapsedRealtime()||a.boot!=boot())return null;a.fsiOffered=true;return write(a)?a.action:null;}}
    String fsiBlockReason(String event){synchronized(LOCK){
        FallbackAlarm a=read(event);
        if(a==null)return "EVENT_MISSING";
        if(!a.fsiEligible)return "EVENT_NOT_URGENT_OR_PRIORITY_DOWNGRADED";
        if(a.fsiPeriod!=FsiSettings.period(context))return "EVENT_REVISION_MISMATCH";
        if(a.fsiOffered)return "FSI_ALREADY_OFFERED";
        if(a.state!=FallbackAlarm.State.AVAILABLE)return "EVENT_STATE_"+a.state;
        if(a.deadline<=SystemClock.elapsedRealtime())return "EVENT_EXPIRED";
        if(a.boot!=boot())return "EVENT_FROM_PREVIOUS_BOOT";
        return "STORAGE_WRITE_FAILED_OR_CONCURRENT_CHANGE";
    }}
    public FallbackAlarm.Decision claimFsi(String event,String nonce,long pairing,boolean paired,boolean enabled){synchronized(LOCK){FallbackAlarm a=read(event);if(a==null)return FallbackAlarm.Decision.INVALID_ACTION;if(a.fsiPeriod!=FsiSettings.period(context))return FallbackAlarm.Decision.DISABLED;var result=a.claimFsi(nonce,SystemClock.elapsedRealtime(),pairing,boot(),paired,enabled);return write(a)?result:FallbackAlarm.Decision.INVALID_ACTION;}}
    public FallbackAlarm.Decision startFsi(String event,String nonce,long pairing,boolean paired,boolean enabled){synchronized(LOCK){FallbackAlarm a=read(event);if(a==null)return FallbackAlarm.Decision.INVALID_ACTION;if(a.fsiPeriod!=FsiSettings.period(context))return FallbackAlarm.Decision.DISABLED;var result=a.startFsi(nonce,SystemClock.elapsedRealtime(),pairing,boot(),paired,enabled);return write(a)?result:FallbackAlarm.Decision.INVALID_ACTION;}}
    public void ringing(String event){synchronized(LOCK){FallbackAlarm a=read(event);if(a!=null){a.ringing();write(a);}}}
    public void stopped(String event){synchronized(LOCK){FallbackAlarm a=read(event);if(a!=null){a.stopped();write(a);}}}
    public boolean cancelPending(String event,String nonce){synchronized(LOCK){
        FallbackAlarm a=read(event);if(a==null||a.action==null||!a.action.equals(nonce))return false;
        if(a.state!=FallbackAlarm.State.AVAILABLE&&a.state!=FallbackAlarm.State.USER_CLAIMED&&a.state!=FallbackAlarm.State.USER_STARTED&&a.state!=FallbackAlarm.State.FSI_CLAIMED&&a.state!=FallbackAlarm.State.FSI_STARTED)return false;
        a.stopped();return write(a);
    }}
}
