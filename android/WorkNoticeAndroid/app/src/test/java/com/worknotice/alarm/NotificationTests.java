package com.worknotice.alarm;
import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

// No Firebase provider or real network: exercise Android notification APIs in a sandbox.
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class NotificationTests {
    private Context context;
    private NotificationManager manager;
    private final String event="a".repeat(64);
    @Before public void setup() {
        context=RuntimeEnvironment.getApplication(); manager=context.getSystemService(NotificationManager.class);
        shadowOf((Application)context).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        Notices.channels(context);
    }
    @After public void cleanup() { manager.cancelAll(); }
    @Test public void fallbackRemainsAfterPlaybackNotificationIsRemovedAndHasPublicHighChannel() {
        assertTrue(Notices.workReceived(context,event));
        manager.notify(Notices.PLAYBACK_ID,Notices.playback(context,"session",1));
        assertTrue(Notices.fallback(context,event,AlarmDiagnostics.Reason.AUDIO_FOCUS_DENIED));
        manager.cancel(Notices.PLAYBACK_ID);
        var active=manager.getActiveNotifications();assertEquals(1,active.length);
        assertEquals(Notices.workTag(event),active[0].getTag());assertEquals(Notices.WORK_ID,active[0].getId());
        assertEquals(Notification.VISIBILITY_PUBLIC,active[0].getNotification().visibility);
        assertEquals(Notices.WORK,active[0].getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_HIGH,manager.getNotificationChannel(Notices.WORK).getImportance());
        assertEquals(Notification.VISIBILITY_PUBLIC,manager.getNotificationChannel(Notices.WORK).getLockscreenVisibility());
    }
    @Test public void disabledPlaybackChannelDoesNotBlockOrdinaryFallback() {
        manager.deleteNotificationChannel(Notices.PLAYBACK);
        manager.createNotificationChannel(new NotificationChannel(Notices.PLAYBACK,"blocked",NotificationManager.IMPORTANCE_NONE));
        assertFalse(Notices.allowed(context));assertTrue(Notices.fallback(context,event,AlarmDiagnostics.Reason.NOTIFICATIONS_BLOCKED));
        assertEquals(1,manager.getActiveNotifications().length);
    }
    @Test public void deniedPermissionDoesNotClaimNotificationWasPosted() {
        shadowOf((Application)context).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        assertFalse(Notices.fallback(context,event,AlarmDiagnostics.Reason.NOTIFICATIONS_BLOCKED));assertEquals(0,manager.getActiveNotifications().length);
    }
    @Test public void disabledWorkChannelDoesNotClaimNotificationWasPosted() {
        manager.deleteNotificationChannel(Notices.WORK);manager.createNotificationChannel(new NotificationChannel(Notices.WORK,"blocked",NotificationManager.IMPORTANCE_NONE));
        assertFalse(Notices.fallback(context,event,AlarmDiagnostics.Reason.NOTIFICATIONS_BLOCKED));assertEquals(0,manager.getActiveNotifications().length);
    }
    @Test public void notificationAndPlaybackIdsCannotCollideAndManualCancelIsScoped() {
        Notices.workReceived(context,event);Notices.workReceived(context,"b".repeat(64));manager.notify(Notices.PLAYBACK_ID,Notices.playback(context,"session",1));
        Notices.cancelWork(context,event);assertEquals(2,manager.getActiveNotifications().length);
        assertNotEquals(Notices.PLAYBACK_ID,Notices.WORK_ID);assertNotEquals(Notices.HEALTH_ID,Notices.WORK_ID);
    }
    @Test public void lockscreenHighPriorityDeliveryUsesFgsWithoutAnActivity() {
        shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        assertTrue(context.getSystemService(KeyguardManager.class).isKeyguardLocked());
        assertTrue(AlarmDelivery.attempt(true,false,true,()->context.startForegroundService(new Intent(context,AlarmPlaybackService.class)),failure->fail()));
        assertNotNull(shadowOf((Application)context).getNextStartedService());
    }
    @Test public void actualServiceAudioFocusFailureLeavesFallbackAlive() {
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            assertNull(AlarmPlaybackService.currentSession());
            assertTrue(java.util.Arrays.stream(manager.getActiveNotifications()).anyMatch(n->Notices.workTag(event).equals(n.getTag())));
            new AlarmStopReceiver().onReceive(context,new Intent("STOP").putExtra("session","old-session"));
        } finally {controller.destroy();}
        assertTrue(java.util.Arrays.stream(manager.getActiveNotifications()).anyMatch(n->Notices.workTag(event).equals(n.getTag())));
        assertFalse(org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().anyMatch(item->item.msg.contains("ack=STOPPED")));
    }
    @Test public void actualForegroundStartDeniedExceptionProducesVisibleFallbackWithSafeReason() {
        assertFalse(AlarmDelivery.attempt(true,false,true,()->{
            var error=new ForegroundServiceStartNotAllowedException("SECRET-PRIVATE-CANARY");
            AlarmDiagnostics.failure(AlarmDiagnostics.Stage.FGS_REQUEST,event,error);throw error;
        },failure->{assertEquals(AlarmDelivery.Failure.START_DENIED,failure);assertTrue(Notices.fallback(context,event,AlarmDiagnostics.Reason.FGS_START_DENIED));}));
        assertEquals(1,manager.getActiveNotifications().length);
        var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG);
        assertTrue(logs.stream().anyMatch(item->item.msg.contains("FGS_START_DENIED")));
        assertFalse(logs.stream().anyMatch(item->item.msg.contains("SECRET-PRIVATE-CANARY")));
    }
    @Test public void diagnosticsNeverIncludeExceptionMessageOrRawIdentifier() {
        String secret="SECRET-PRIVATE-CANARY";AlarmDiagnostics.failure(AlarmDiagnostics.Stage.FGS_REQUEST,secret,new SecurityException(secret));
        var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG);
        assertTrue(logs.stream().anyMatch(item->item.msg.contains("SECURITY_DENIED")));
        assertFalse(logs.stream().anyMatch(item->item.msg.contains(secret)));
    }
    @Test public void promotionAndSnapshotPrecedeActualFocusRequestAndFailureDoesNotStartPlayer() {
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().map(item->item.msg).toList();
            int request=-1,promoted=-1,before=-1,result=-1;
            for(int i=0;i<logs.size();i++) {
                if(logs.get(i).contains("stage=FGS_PROMOTE_REQUEST"))request=i;
                if(logs.get(i).contains("stage=FGS_PROMOTED"))promoted=i;
                if(logs.get(i).contains("phase=BEFORE_REQUEST")){before=i;assertTrue(logs.get(i).contains("foregroundReturned=true"));assertTrue(logs.get(i).contains("usage=4"));assertTrue(logs.get(i).contains("contentType=4"));}
                if(logs.get(i).contains("stage=AUDIO_FOCUS ")&&logs.get(i).contains("value=0"))result=i;
            }
            assertTrue(request>=0 && promoted>request && before>promoted && result>before);
            assertFalse(logs.stream().anyMatch(line->line.contains("PLAYER_PREPARED")||line.contains("PLAYER_STARTED")||line.contains("ack=STOPPED")));
            assertNotNull(shadowOf(context.getSystemService(AudioManager.class)).getLastAudioFocusRequest());
        }finally{controller.destroy();}
    }
    @Test public void delayedFocusWaitsWithoutPlayerAndTimeoutPreservesNotification() {
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_DELAYED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            var intent=new Intent(context,AlarmPlaybackService.class).putExtra("event",event);
            controller.get().onStartCommand(intent,0,1);
            assertNotNull(AlarmPlaybackService.currentSession());
            assertFalse(org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().anyMatch(item->item.msg.contains("PLAYER_STARTED")));
            controller.get().onStartCommand(intent,0,2); // No second focus request while pending.
            long requests=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().filter(item->item.msg.contains("phase=BEFORE_REQUEST")).count();
            assertEquals(1,requests);
            shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(5));
            assertNull(AlarmPlaybackService.currentSession());
            assertTrue(java.util.Arrays.stream(manager.getActiveNotifications()).anyMatch(n->Notices.workTag(event).equals(n.getTag())));
            assertFalse(org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().anyMatch(item->item.msg.contains("ack=STOPPED")));
        }finally{controller.destroy();}
    }
    @Test public void quickStopDuringDelayedFocusCannotEmitLateTimeoutOrFallback() {
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_DELAYED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            String id=AlarmPlaybackService.currentSession();assertNotNull(id);AlarmPlaybackService.stopCurrent(context,id);
            shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
            assertNull(AlarmPlaybackService.currentSession());
            assertFalse(java.util.Arrays.stream(manager.getActiveNotifications()).anyMatch(n->Notices.workTag(event).equals(n.getTag())));
            assertFalse(org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().anyMatch(item->item.msg.contains("reason=AUDIO_FOCUS_TIMEOUT")));
        }finally{controller.destroy();}
    }
    @Test public void failedForegroundPromotionNeverRequestsFocusOrCreatesPlayer() {
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            shadowOf(controller.get()).setThrowInStartForeground(new ForegroundServiceStartNotAllowedException("PRIVATE-CANARY"));
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            assertNull(shadowOf(context.getSystemService(AudioManager.class)).getLastAudioFocusRequest());
            var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG);
            assertTrue(logs.stream().anyMatch(item->item.msg.contains("FGS_PROMOTE_FAILED")));
            assertFalse(logs.stream().anyMatch(item->item.msg.contains("stage=FGS_PROMOTED ")||item.msg.contains("PRIVATE-CANARY")||item.msg.contains("ack=STOPPED")));
            assertTrue(java.util.Arrays.stream(manager.getActiveNotifications()).anyMatch(n->Notices.workTag(event).equals(n.getTag())));
        }finally{controller.destroy();}
    }
    @Test public void grantedFocusPreparesThenStartsLoopingPlaybackInCorrectOrder() {
        org.robolectric.shadows.ShadowMediaPlayer.setMediaInfoProvider(source->new org.robolectric.shadows.ShadowMediaPlayer.MediaInfo(20000,10));
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            var focus=shadowOf(context.getSystemService(AudioManager.class)).getLastAudioFocusRequest().audioFocusRequest;
            assertEquals(android.media.AudioAttributes.USAGE_ALARM,focus.getAudioAttributes().getUsage());
            assertEquals(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION,focus.getAudioAttributes().getContentType());
            shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(30));
            var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().map(item->item.msg).toList();
            int grant=-1,prepared=-1,playing=-1;
            for(int i=0;i<logs.size();i++){if(logs.get(i).contains("phase=AFTER_REQUEST")&&logs.get(i).contains("result=1"))grant=i;if(logs.get(i).contains("stage=PLAYER_PREPARED"))prepared=i;if(logs.get(i).contains("stage=PLAYER_STARTED"))playing=i;}
            assertTrue(grant>=0&&prepared>grant&&playing>prepared);
        }finally{controller.destroy();}
    }
    @Test public void actualDelayedGainStartsOnlyOnCallbackAndCancelsTimeout() {
        org.robolectric.shadows.ShadowMediaPlayer.setMediaInfoProvider(source->new org.robolectric.shadows.ShadowMediaPlayer.MediaInfo(20000,10));
        shadowOf(context.getSystemService(AudioManager.class)).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_DELAYED);
        var controller=Robolectric.buildService(AlarmPlaybackService.class).create();
        try {
            controller.get().onStartCommand(new Intent(context,AlarmPlaybackService.class).putExtra("event",event),0,1);
            var focus=shadowOf(context.getSystemService(AudioManager.class)).getLastAudioFocusRequest().audioFocusRequest;
            assertTrue(focus.acceptsDelayedFocusGain());
            assertFalse(org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG).stream().anyMatch(item->item.msg.contains("PLAYER_STARTED")));
            // Test-only framework listener access in Robolectric; no reflection in the APK.
            AudioManager.OnAudioFocusChangeListener listener=org.robolectric.util.ReflectionHelpers.callInstanceMethod(focus,"getOnAudioFocusChangeListener");
            listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN);
            shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
            assertNotNull(AlarmPlaybackService.currentSession());
            var logs=org.robolectric.shadows.ShadowLog.getLogsForTag(AlarmDiagnostics.TAG);
            assertTrue(logs.stream().anyMatch(item->item.msg.contains("PLAYER_STARTED")));
            assertFalse(logs.stream().anyMatch(item->item.msg.contains("reason=AUDIO_FOCUS_TIMEOUT")));
        }finally{controller.destroy();}
    }
}
