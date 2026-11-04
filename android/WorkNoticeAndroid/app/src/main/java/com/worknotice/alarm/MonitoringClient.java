package com.worknotice.alarm;
import android.content.Context;
import org.json.JSONObject;
public final class MonitoringClient {
    private final Context c;
    public MonitoringClient(Context c){this.c=c.getApplicationContext();}
    public JSONObject refresh() throws Exception {long start=android.os.SystemClock.elapsedRealtime();JSONObject root=new ApiClient(c).call("GET","/api/mobile/monitoring",null,true);new MonitoringStore(c).update(root,android.os.SystemClock.elapsedRealtime()-start);return root;}
    public void retry() throws Exception {
        MonitoringStore store=new MonitoringStore(c);JSONObject pending=store.pending();if(pending==null){refresh();return;}
        long start=android.os.SystemClock.elapsedRealtime();
        try{JSONObject root=new ApiClient(c).call("PUT","/api/mobile/monitoring",pending,true);store.update(root,android.os.SystemClock.elapsedRealtime()-start);refresh();}
        catch(ApiClient.ApiException e){if(e.status==409){refresh();store.error("版本衝突或命令已失效；本機停止狀態保留。請查看最新設定後重新結束監控。");}throw e;}
    }
}
