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
public class FsiTests {
    Context c;PendingAlarmStore store;String event="d".repeat(64);
    public static class VisibleAlarm extends FsiAlarmActivity {
        static boolean allowed=true;
        @Override protected boolean eligible(){return allowed;}
        @Override protected boolean paired(){return true;}
        @Override protected boolean enabled(){return true;}
        @Override protected long pairing(){return 1000;}
    }
    @Before public void setup(){c=RuntimeEnvironment.getApplication();store=new PendingAlarmStore(c);Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,1);Notices.channels(c);shadowOf((Application)c).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);VisibleAlarm.allowed=true;}
    String seed(){assertTrue(store.register(event,SystemClock.elapsedRealtime()+100000,1000,true));String nonce=store.offer(event);assertEquals(nonce,store.offerFsi(event));return nonce;}
    Intent intent(String nonce){return new Intent(c,VisibleAlarm.class).setAction(FsiAlarmActivity.AUTO).putExtra("event",event).putExtra("actionNonce",nonce);}
    @Test public void featureDefaultsOff(){assertFalse(FsiSettings.enabled(c));assertFalse(c.getSharedPreferences("fsi-v1",0).getBoolean("urgent",false));}
    @Test public void uiAndDiagnosticGateShareSnapshot(){FsiStatus s=FsiSettings.status(c);assertEquals(s.enabled,FsiSettings.enabled(c));assertTrue(s.display().startsWith("FSI 實驗：未啟用"));}
    @Test public void mainScreenShowsExplicitDisabledAndInactiveButton(){var ctrl=Robolectric.buildActivity(MainActivity.class).create().start().resume().visible();try{shadowOf(Looper.getMainLooper()).idle();assertTrue(((android.widget.TextView)ctrl.get().findViewById(R.id.fsi_status)).getText().toString().contains("FSI 實驗：未啟用"));assertFalse(ctrl.get().findViewById(R.id.fsi_disable).isEnabled());}finally{ctrl.pause().stop().destroy();}}
    @Test public void resettingEnablePeriodInvalidatesPriorFsiEvent(){String nonce=seed();c.getSharedPreferences("settings",0).edit().putString("status","{\"alertSetting\":{\"updated_at_ms\":9999}}").commit();assertEquals(FallbackAlarm.Decision.DISABLED,store.claimFsi(event,nonce,1000,true,true));}
    @Test public void consentIsBoundToSettingsRevision(){c.getSharedPreferences("settings",0).edit().putString("status","{\"pairedAt\":1000,\"alertSetting\":{\"updated_at_ms\":1234}}").commit();FsiSettings.consent(c);assertEquals(1234,c.getSharedPreferences("fsi-v1",0).getLong("period",-1));c.getSharedPreferences("settings",0).edit().putString("status","{\"pairedAt\":1000,\"alertSetting\":{\"updated_at_ms\":5678}}").commit();assertEquals(5678,FsiSettings.period(c));assertNotEquals(FsiSettings.period(c),c.getSharedPreferences("fsi-v1",0).getLong("period",-1));}
    @Test public void explicitNotificationUsesImmutableDistinctIntents(){String nonce=seed();var n=Notices.buildFsi(c,event,nonce,store.deadline(event));assertTrue(n.fullScreenIntent.isImmutable());assertTrue(n.contentIntent.isImmutable());assertNotEquals(n.fullScreenIntent,n.contentIntent);assertEquals(FsiAlarmActivity.AUTO,shadowOf(n.fullScreenIntent).getSavedIntent().getAction());assertEquals(FsiAlarmActivity.CLICK,shadowOf(n.contentIntent).getSavedIntent().getAction());assertEquals(Notices.URGENT,n.getChannelId());assertTrue(n.getTimeoutAfter()>0);}
    @Test public void noAutomaticActivityFromDeniedOrDisabledPosting(){seed();assertFalse(Notices.postFsi(c,event));assertNull(shadowOf((Application)c).getNextStartedActivity());}
    @Test public void fsiCannotReplayAfterRinging(){String n=seed();store.ringing(event);assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claimFsi(event,n,1000,true,true));}
    @Test public void stopDoesNotChangeFuturePreferences(){String n=seed();c.getSharedPreferences("fsi-v1",0).edit().putBoolean("urgent",true).commit();assertTrue(store.cancelPending(event,n));assertTrue(c.getSharedPreferences("fsi-v1",0).getBoolean("urgent",false));}
    @Test public void eventNotMarkedUrgentCannotOfferFsi(){store.register(event,SystemClock.elapsedRealtime()+10000,1000,false);store.offer(event);assertNull(store.offerFsi(event));}
    @Test public void oneFsiOfferPerEvent(){seed();assertNull(store.offerFsi(event));}
    @Test public void fsiClaimExcludesManualClaim(){String n=seed();assertEquals(FallbackAlarm.Decision.ALLOWED,store.claimFsi(event,n,1000,true,true));assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claim(event,n,1000,true,true));}
    @Test public void manualClaimExcludesFsiClaim(){String n=seed();assertEquals(FallbackAlarm.Decision.ALLOWED,store.claim(event,n,1000,true,true));assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claimFsi(event,n,1000,true,true));}
    @Test public void stopBetweenClaimAndServiceIsTerminal(){String n=seed();store.claimFsi(event,n,1000,true,true);assertTrue(store.cancelPending(event,n));assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.startFsi(event,n,1000,true,true));assertNull(store.offerFsi(event));}
    @Test public void duplicateServiceStartCannotReplay(){String n=seed();store.claimFsi(event,n,1000,true,true);assertEquals(FallbackAlarm.Decision.ALLOWED,store.startFsi(event,n,1000,true,true));assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.startFsi(event,n,1000,true,true));}
    @Test public void expiredFsiCannotClaim(){String n=seed();shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(101));assertEquals(FallbackAlarm.Decision.EXPIRED,store.claimFsi(event,n,1000,true,true));}
    @Test public void newPairingRejectsOldFsi(){String n=seed();assertEquals(FallbackAlarm.Decision.OLD_PAIRING,store.claimFsi(event,n,2000,true,true));}
    @Test public void disableBetweenClaimAndStartRejects(){String n=seed();store.claimFsi(event,n,1000,true,true);assertEquals(FallbackAlarm.Decision.DISABLED,store.startFsi(event,n,1000,true,false));}
    @Test public void focusFailureOffersManualButNeverSecondFsi(){String n=seed();store.claimFsi(event,n,1000,true,true);store.startFsi(event,n,1000,true,true);String manual=store.offer(event);assertNotNull(manual);assertNotEquals(n,manual);assertNull(store.offerFsi(event));assertEquals(FallbackAlarm.Decision.ALLOWED,store.claim(event,manual,1000,true,true));}
    @Test public void noStartUntilVisibleWindowFocusEvenWhenLocked(){String n=seed();shadowOf(c.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);var ctrl=Robolectric.buildActivity(VisibleAlarm.class,intent(n)).create().start().resume();try{assertNull(shadowOf((Application)c).getNextStartedService());ctrl.visible().windowFocusChanged(true);Intent started=shadowOf((Application)c).getNextStartedService();assertNotNull(started);assertTrue(started.getBooleanExtra("fsiAttempt",false));assertTrue(c.getSystemService(KeyguardManager.class).isKeyguardLocked());ctrl.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());}finally{ctrl.pause().stop().destroy();}}
    @Test public void revokedPermissionPreventsActivityStart(){String n=seed();VisibleAlarm.allowed=false;var ctrl=Robolectric.buildActivity(VisibleAlarm.class,intent(n)).create().start().resume().visible();try{ctrl.windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());assertEquals(FallbackAlarm.Decision.ALLOWED,store.claim(event,n,1000,true,true));}finally{ctrl.pause().stop().destroy();}}
    @Test public void stoppedBeforeVisibleNeverStarts(){String n=seed();var ctrl=Robolectric.buildActivity(VisibleAlarm.class,intent(n)).create().start().resume();try{ctrl.get().findViewById(R.id.recovery_stop).performClick();ctrl.visible().windowFocusChanged(true);assertNull(shadowOf((Application)c).getNextStartedService());assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,store.claimFsi(event,n,1000,true,true));}finally{ctrl.pause().stop().destroy();}}
    @Test public void urgentChannelDoesNotOverwriteUserImportance(){var manager=c.getSystemService(NotificationManager.class);var channel=manager.getNotificationChannel(Notices.URGENT);channel.setImportance(NotificationManager.IMPORTANCE_NONE);manager.createNotificationChannel(channel);Notices.channels(c);assertEquals(NotificationManager.IMPORTANCE_NONE,manager.getNotificationChannel(Notices.URGENT).getImportance());}
    @Test public void ackFailureCategoriesDoNotExposeMessages(){assertEquals(AckFailure.Kind.DNS,AckFailure.classify(new java.net.UnknownHostException("secret")));assertEquals(AckFailure.Kind.TLS,AckFailure.classify(new javax.net.ssl.SSLException("secret")));assertEquals(AckFailure.Kind.TIMEOUT,AckFailure.classify(new java.net.SocketTimeoutException("secret")));assertEquals(AckFailure.Kind.RESPONSE_JSON,AckFailure.classify(new org.json.JSONException("secret")));assertEquals(AckFailure.Kind.LOCAL_UNEXPECTED,AckFailure.classify(new IllegalStateException("secret")));}
}
