package com.worknotice.alarm;
import android.content.Context;
import androidx.work.*;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class CloudSyncWorker extends Worker {
    private static final java.util.concurrent.ExecutorService acknowledgements = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "work-notice-acks"); thread.setDaemon(true); return thread;
    });
    public CloudSyncWorker(Context c, WorkerParameters p) { super(c, p); }
    private static OneTimeWorkRequest.Builder request() {
        return new OneTimeWorkRequest.Builder(CloudSyncWorker.class).setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS);
    }
    public static void enqueueToken(Context c) {
        WorkManager.getInstance(c).enqueueUniqueWork("register-latest-token", ExistingWorkPolicy.APPEND_OR_REPLACE, request().setInputData(new Data.Builder().putString("kind", "token").build()).build());
    }
    public static void ack(Context c, String event, String state) {
        if (event.startsWith("local-")) return;
        Context application = c.getApplicationContext();
        acknowledgements.execute(() -> {
            try {
                WorkManager.getInstance(application).enqueueUniqueWork("ack-" + event + "-" + state, ExistingWorkPolicy.KEEP,
                    request().setInputData(new Data.Builder().putString("kind", "ack").putString("event", event).putString("state", state).build()).build());
                AlarmDiagnostics.ack(AlarmDiagnostics.Stage.ACK_QUEUED,event,state,0);
            } catch (RuntimeException ignored) { AlarmDiagnostics.record(AlarmDiagnostics.Stage.ACK_QUEUED,event,AlarmDiagnostics.Reason.STATE_ERROR); }
        });
    }
    @Override public Result doWork() {
        Context c = getApplicationContext(); DeviceTokenStore store = new DeviceTokenStore(c);
        if (store.get("bearer").isEmpty()) return Result.success();
        try {
            ApiClient api = new ApiClient(c);
            if ("token".equals(getInputData().getString("kind"))) {
                if (!BuildConfig.FIREBASE_CONFIGURED) return Result.failure();
                // Always fetch the latest SDK token. No stale queued token can overwrite a rotation.
                new TokenRegistration(() -> com.google.android.gms.tasks.Tasks.await(FirebaseMessaging.getInstance().getToken(), 15, TimeUnit.SECONDS),
                    token -> api.call("POST", "/api/mobile/fcm-token", new JSONObject().put("token", token), true)).attempt();
                c.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().putBoolean("tokenRegistered", true).apply();
                new PairingRepository(c).refresh();
            } else {
                api.call("POST", "/api/mobile/ack", new JSONObject().put("eventId", getInputData().getString("event")).put("status", getInputData().getString("state")), true);
                AlarmDiagnostics.ack(AlarmDiagnostics.Stage.ACK_RESULT,getInputData().getString("event"),getInputData().getString("state"),200);
            }
            return Result.success();
        } catch (ApiClient.ApiException e) { AlarmDiagnostics.ack(AlarmDiagnostics.Stage.ACK_RESULT,getInputData().getString("event"),getInputData().getString("state"),e.status); return AlarmPolicy.retryHttp(e.status) && getRunAttemptCount() < 8 ? Result.retry() : Result.failure(); }
        catch (Exception e) { AlarmDiagnostics.ackFailure(getInputData().getString("event"),getInputData().getString("state"),e,getRunAttemptCount()); return getRunAttemptCount() < 8 ? Result.retry() : Result.failure(); }
    }
}
