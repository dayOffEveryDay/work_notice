package com.worknotice.alarm;
import android.content.Context;
import org.json.JSONObject;
import java.util.UUID;

public final class PairingRepository {
    private final Context context;
    public PairingRepository(Context c) { context = c; }
    public void pair(String code) throws Exception {
        String id = UUID.randomUUID().toString();
        JSONObject result = new ApiClient(context).call("POST", "/api/mobile/pairing/claim", new JSONObject().put("pairingCode", code.trim()).put("mobileId", id), false);
        new DeviceTokenStore(context).put("bearer", result.getString("bearerToken"));
        context.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().putBoolean("tokenRegistered", false).apply();
        new AlarmPreferencesRepository(context).clear();
        CloudSyncWorker.enqueueToken(context);
    }
    public void unpair() throws Exception {
        new ApiClient(context).call("POST", "/api/mobile/unpair", new JSONObject(), true);
        new DeviceTokenStore(context).clear(); new AlarmPreferencesRepository(context).clear();
        context.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().clear().apply();
    }
    public JSONObject refresh() throws Exception {
        new MonitoringClient(context).refresh();
        long started = android.os.SystemClock.elapsedRealtime();
        JSONObject status = new ApiClient(context).call("GET", "/api/mobile/status", null, true);
        new AlarmPreferencesRepository(context).update(status, android.os.SystemClock.elapsedRealtime() - started); return status;
    }
}
