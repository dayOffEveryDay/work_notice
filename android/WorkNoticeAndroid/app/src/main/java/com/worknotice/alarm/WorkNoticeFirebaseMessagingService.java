package com.worknotice.alarm;
import android.content.Intent;
import android.os.SystemClock;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.time.Instant;
import java.util.Map;
import static com.worknotice.alarm.AlarmDiagnostics.Stage;
import static com.worknotice.alarm.AlarmDiagnostics.Reason;

public final class WorkNoticeFirebaseMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        getSharedPreferences("connection", MODE_PRIVATE).edit().putBoolean("tokenRegistered", false).apply();
        CloudSyncWorker.enqueueToken(this);
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        long started = SystemClock.elapsedRealtime();
        Map<String, String> data = message.getData();
        String event = data.get("eventId"); boolean received = false;
        AlarmDiagnostics.received(this,event,message.getOriginalPriority(),message.getPriority());
        try {
            AlarmPreferencesRepository prefs = new AlarmPreferencesRepository(this);
            if (new DeviceTokenStore(this).get("bearer").isEmpty()) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.UNPAIRED); return; }
            String type = data.get("type");
            if (event == null || !(event.matches("[a-f0-9]{64}") || event.matches("offline-[0-9]+"))) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.INVALID_PAYLOAD); return; }
            if("WORK_ALERT".equals(data.get("type"))){
                FsiRecovery.restore(this,event);
                boolean accepted=new MonitoringStore(this).accept(data);
                android.util.Log.i(AlarmDiagnostics.TAG,"stage=MONITORING_GATE event="+FsiSettings.ref(event)+" accepted="+accepted+" localRevision="+new MonitoringStore(this).revision());
                if(!accepted){
                    MonitoringStore m=new MonitoringStore(this);
                    android.util.Log.i(AlarmDiagnostics.TAG,"stage=FSI_GATE_REJECTED event="+FsiSettings.ref(event)
                        +" reason=MONITORING_EVENT_REJECTED active="+m.active()+" localEnded="+m.ended()
                        +" revisionMatches="+String.valueOf(m.revision()).equals(data.get("monitoringRevision"))
                        +" sessionMatches="+m.session().equals(data.get("monitoringSessionId"))
                        +" startMatches="+String.valueOf(m.starts()).equals(data.get("monitoringStartsAtMs")));
                    AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.DISABLED);return;
                }
            }
            long issued = Instant.parse(data.get("issuedAt")).toEpochMilli(), expires = Instant.parse(data.get("expiresAt")).toEpochMilli();
            long now = prefs.serverNow();
            long sampledAt = SystemClock.elapsedRealtime();
            if (!AlarmPolicy.freshForPairing(issued, expires, now, prefs.pairedAt())) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.STALE_OR_OLD_PAIRING); return; }
            if (!("WORK_ALERT".equals(type) || "WINDOWS_OFFLINE".equals(type))) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.INVALID_PAYLOAD); return; }
            if (!new EventStore(this).claim(event, expires, now)) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.DUPLICATE); return; }
            received = true;
            if ("WINDOWS_OFFLINE".equals(type)) {
                if (prefs.offlineAlerts()) Notices.health(this, event);
                AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.HEALTH_ONLY); return;
            }
            if (!prefs.enabled()) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.DISABLED); return; }
            FsiRecovery.restore(this,event);
            long eventDeadline=AlarmPolicy.deliveryDeadline(expires,now,sampledAt);
            boolean registered=new PendingAlarmStore(this).register(event,eventDeadline,prefs.pairedAt(),FsiSettings.enabled(this)&&message.getPriority()==RemoteMessage.PRIORITY_HIGH);
            // Render first, independent of whether the service can start. Never wait for a network ACK.
            Notices.workReceived(this,event);
            if(!registered){FsiRecovery.log("FSI_GATE_REJECTED",event,FsiRecovery.Reason.EVENT_REGISTRATION_FAILED);return;}
            final String acceptedEvent = event;
            AlarmDelivery.attempt(Notices.allowed(this), WorkNoticeApplication.foreground(), message.getPriority() == RemoteMessage.PRIORITY_HIGH,
                () -> {
                    AlarmDiagnostics.record(Stage.FGS_REQUEST,acceptedEvent,Reason.NONE);
                    try { startForegroundService(new Intent(this, AlarmPlaybackService.class).putExtra("event", acceptedEvent)
                        .putExtra("expiresElapsed",eventDeadline)); }
                    catch (IllegalStateException | SecurityException e) { AlarmDiagnostics.failure(Stage.FGS_REQUEST,acceptedEvent,e); throw e; }
                },
                failure -> {
                    Reason reason = failure == AlarmDelivery.Failure.NOTIFICATIONS_BLOCKED ? Reason.NOTIFICATIONS_BLOCKED
                        : failure == AlarmDelivery.Failure.PRIORITY_DOWNGRADED ? Reason.PRIORITY_DOWNGRADED
                        : failure == AlarmDelivery.Failure.SECURITY_DENIED ? Reason.SECURITY_DENIED : Reason.FGS_START_DENIED;
                    AlarmDiagnostics.record(Stage.FCM_DECISION,acceptedEvent,reason);
                    Notices.fallback(this,acceptedEvent,reason);
                });
        } catch (Exception ignored) { AlarmDiagnostics.record(Stage.FCM_DECISION,event,Reason.INVALID_PAYLOAD); }
        finally {
            // The critical FGS start path has completed; WorkManager initialization and HTTP run off-thread.
            if (received) CloudSyncWorker.ack(this,event,"RECEIVED");
            AlarmDiagnostics.elapsed(event,started);
        }
    }
}
