package com.worknotice.alarm;
import android.app.*;
import android.content.*;
import android.os.*;
import android.provider.Settings;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class RecoveryTests {
    private Context c;private NotificationManager manager;private PendingAlarmStore store;
    private final String event="c".repeat(64);
    public static class TestRingActivity extends RingActionActivity {
        public static boolean allow=true,refresh=true,defer=false;
        public static Runnable completion;
        @Override protected boolean paired(){return true;}
        @Override protected boolean enabled(){return allow;}
        @Override protected long pairing(){return 1000;}
        @Override protected void refreshSettings(Runnable success,Runnable failure){if(defer)completion=success;else if(refresh)success.run();else failure.run();}
    }
    @Before public void setup(){c=RuntimeEnvironment.getApplication();manager=c.getSystemService(NotificationManager.class);store=new PendingAlarmStore(c);
        Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,1);
        shadowOf((Application)c).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        shadowOf(c.getSystemService(PowerManager.class)).setIsInteractive(true);
        shadowOf(c.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        TestRingActivity.allow=true;TestRingActivity.refresh=true;TestRingActivity.defer=false;TestRingActivity.completion=null;
    }
    private String seed(){Notices.channels(c);assertTrue(store.register(event,SystemClock.elapsedRealtime()+100000,1000));String token=store.offer(event);assertNotNull(token);return token;}
    private Intent action(String token){return new Intent(c,TestRingActivity.class).setAction(RingActionActivity.ACTION).putExtra("event",event).putExtra("actionNonce",token);}
    @Test public void newWorkChannelHasSoundAndVibrationDefaults(){Notices.channels(c);var channel=manager.getNotificationChannel(Notices.WORK);assertNotNull(channel.getSound());assertTrue(channel.shouldVibrate());assertEquals(NotificationManager.IMPORTANCE_HIGH,channel.getImportance());}
    @Test public void existingChannelUserSettingsAreNotOverwritten(){var user=new NotificationChannel(Notices.WORK,"custom",NotificationManager.IMPORTANCE_LOW);user.setSound(null,null);user.enableVibration(false);manager.createNotificationChannel(user);Notices.channels(c);var after=manager.getNotificationChannel(Notices.WORK);assertNull(after.getSound());assertFalse(after.shouldVibrate());assertEquals(NotificationManager.IMPORTANCE_LOW,after.getImportance());}
    @Test public void notificationUsesImmutableActivityActionAndIsNotAutoCanceled(){seed();assertTrue(Notices.fallback(c,event,AlarmDiagnostics.Reason.AUDIO_FOCUS_DENIED));var n=manager.getActiveNotifications()[0].getNotification();assertEquals(0,n.flags&Notification.FLAG_AUTO_CANCEL);assertTrue((n.flags&Notification.FLAG_ONLY_ALERT_ONCE)!=0);assertEquals(1,n.actions.length);assertEquals("開啟並響鈴",n.actions[0].title.toString());assertTrue(n.actions[0].actionIntent.isImmutable());var intent=shadowOf(n.actions[0].actionIntent).getSavedIntent();assertEquals(RingActionActivity.class.getName(),intent.getComponent().getClassName());assertEquals(RingActionActivity.ACTION,intent.getAction());}
    @Test public void durableActionCanOnlyBeClaimedOnceAcrossStoreInstances(){String token=seed();assertEquals(FallbackAlarm.Decision.ALLOWED,store.claim(event,token,1000,true,true));assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,new PendingAlarmStore(c).claim(event,token,1000,true,true));}
    @Test public void rebootAndStoppedEventCannotBeRetried(){String token=seed();Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,2);assertEquals(FallbackAlarm.Decision.REBOOTED,store.claim(event,token,1000,true,true));store.stopped(event);assertNull(store.offer(event));}
    @Test public void storeDoesNotResetAnExistingEvent(){seed();assertFalse(store.register(event,SystemClock.elapsedRealtime()+100000,1000));}
    @Test public void visibleActivityRequestsServiceOnceAfterValidation(){String token=seed();var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);var request=shadowOf((Application)c).getNextStartedService();assertNotNull(request);assertEquals(event,request.getStringExtra("event"));assertNotNull(request.getStringExtra("recoveryAttempt"));controller.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{controller.pause().stop().destroy();}}
    @Test public void lockedActivityNeverStartsService(){String token=seed();shadowOf(c.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{controller.pause().stop().destroy();}}
    @Test public void latestDisabledSettingsPreventForegroundRetry(){String token=seed();TestRingActivity.allow=false;var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{controller.pause().stop().destroy();}}
    @Test public void networkValidationFailureDoesNotConsumeOrStartAction(){String token=seed();TestRingActivity.refresh=false;var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());assertEquals(FallbackAlarm.Decision.ALLOWED,store.claim(event,token,1000,true,true));}finally{controller.pause().stop().destroy();}}
    @Test public void quickStopBeforeServiceDeliveryInvalidatesThePendingAttempt(){String token=seed();var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);assertNotNull(shadowOf((Application)c).getNextStartedService());controller.get().findViewById(R.id.recovery_stop).performClick();assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.start(event,token,1000,true,true));assertTrue(AlarmPolicy.enabled(true,true,false,0,1000));}finally{controller.pause().stop().destroy();}}
    @Test public void focusFailureAfterUserAttemptPreservesNotificationWithoutRenewedAction(){String token=seed();store.claim(event,token,1000,true,true);store.start(event,token,1000,true,true);assertTrue(Notices.fallback(c,event,AlarmDiagnostics.Reason.AUDIO_FOCUS_DENIED));var n=manager.getActiveNotifications()[0].getNotification();assertTrue(n.actions==null||n.actions.length==0);assertEquals(0,n.flags&Notification.FLAG_AUTO_CANCEL);assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claim(event,token,1000,true,true));}
    @Test public void expiredActionDoesNotStartService(){String token=seed();shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(101));var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{controller.pause().stop().destroy();}}
    @Test public void aSecondActivityCannotReplayTheSameNotificationAction(){String token=seed();var one=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();one.windowFocusChanged(true);assertNotNull(shadowOf((Application)c).getNextStartedService());one.pause().stop().destroy();var two=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{two.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{two.pause().stop().destroy();}}
    @Test public void callbackAfterPauseCannotStartAService(){String token=seed();TestRingActivity.defer=true;var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();controller.windowFocusChanged(true);Runnable stale=TestRingActivity.completion;assertNotNull(stale);controller.pause();stale.run();assertNull(shadowOf((Application)c).getNextStartedService());controller.stop().destroy();}
    @Test public void stopDuringValidationPreventsCallbackFromStartingAlarm(){String token=seed();TestRingActivity.defer=true;var controller=Robolectric.buildActivity(TestRingActivity.class,action(token)).create().start().resume().visible();try{controller.windowFocusChanged(true);Runnable pending=TestRingActivity.completion;controller.get().findViewById(R.id.recovery_stop).performClick();pending.run();assertNull(shadowOf((Application)c).getNextStartedService());assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claim(event,token,1000,true,true));}finally{controller.pause().stop().destroy();}}
}
