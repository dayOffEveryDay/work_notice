package com.worknotice.alarm;

import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.provider.Settings;
import com.google.firebase.messaging.RemoteMessage;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

/** Calls the real FCM callback. Only encrypted credential access and ACK/network are mocked. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=Application.class,
    instrumentedPackages={"com.worknotice.alarm"},
    shadows={FsiRestartTests.Notifications.class,FsiBackgroundTests.Tokens.class,FsiBackgroundTests.Acks.class})
@LooperMode(LooperMode.Mode.PAUSED)
public class FsiBackgroundTests {
    @Implements(value=DeviceTokenStore.class,isInAndroidSdk=false)
    public static class Tokens {
        @Implementation protected String get(String name){return "test-paired";}
    }
    @Implements(value=CloudSyncWorker.class,isInAndroidSdk=false)
    public static class Acks {
        @Implementation protected static void ack(Context c,String event,String state) { }
    }
    Context c; MonitoringStore m;
    @Before public void setup() throws Exception {
        c=RuntimeEnvironment.getApplication();Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,1);
        Notices.channels(c);shadowOf((Application)c).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        FsiRestartTests.Notifications.fsiAllowed=true;
        m=new MonitoringStore(c);m.update(MonitoringTests.root("IMMEDIATE",1,MonitoringTests.SESSION,100000,"cmd"),0);
        FsiPreference.set(c,true);assertTrue(FsiSettings.consent(c));assertEquals("test-paired",new DeviceTokenStore(c).get("bearer"));
        var fixture=new FsiRestartTests();fixture.c=c;fixture.reloadPreferences();
    }
    RemoteMessage message(String id,long skew) {
        var fixture=new MonitoringTests();fixture.c=c;fixture.store=new MonitoringStore(c);
        long now=m.serverNow();var data=fixture.event(now,now+skew,now+skew+120000);
        data.put("eventId",id);data.put("type","WORK_ALERT");
        Bundle b=new Bundle();for(var e:data.entrySet())b.putString(e.getKey(),e.getValue());
        b.putString("google.delivered_priority","high");b.putString("google.original_priority","high");return new RemoteMessage(b);
    }
    @Test public void fcmBeforeAnyActivityRestoresAndPostsFsiOnExistingFallback() throws Exception {
        assertFalse(WorkNoticeApplication.foreground());
        var service=Robolectric.buildService(WorkNoticeFirebaseMessagingService.class).create();try {
            service.get().onMessageReceived(message("e".repeat(64),0));
            Intent start=shadowOf((Application)c).getNextStartedService();assertNotNull(start);
            assertEquals(AlarmPlaybackService.class.getName(),start.getComponent().getClassName());
            // Audio-focus/OS delivery are not emulated. Drive the existing fallback boundary.
            Notices.fallback(c,"e".repeat(64),AlarmDiagnostics.Reason.AUDIO_FOCUS_DENIED);
            var n=shadowOf(c.getSystemService(NotificationManager.class)).getNotification("fsi:"+"e".repeat(64),103);
            assertNotNull(n);assertNotNull(n.fullScreenIntent);assertNull(shadowOf((Application)c).getNextStartedActivity());
            service.get().onMessageReceived(message("e".repeat(64),0));assertNull(shadowOf((Application)c).getNextStartedService());
            assertNull(new PendingAlarmStore(c).offerFsi("e".repeat(64)));
        } finally {service.destroy();}
    }
    @Test public void rebootClockSkewDoesNotSilentlyLoseBackgroundAlarmRegistration() throws Exception {
        Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,2);
        var service=Robolectric.buildService(WorkNoticeFirebaseMessagingService.class).create();try {
            service.get().onMessageReceived(message("f".repeat(64),1000));
            assertNotNull(shadowOf((Application)c).getNextStartedService());
            assertTrue(new PendingAlarmStore(c).autoEligible("f".repeat(64)));
            assertEquals(100000,new MonitoringStore(c).starts());assertEquals(1,new MonitoringStore(c).revision());
        } finally {service.destroy();}
    }
}
