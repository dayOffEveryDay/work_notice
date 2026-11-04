package com.worknotice.alarm;

import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, manifest=Config.NONE, application=Application.class,instrumentedPackages={"com.worknotice.alarm"},
    shadows={FsiRestartTests.Notifications.class,FsiRestartTests.Tokens.class})
@LooperMode(LooperMode.Mode.PAUSED)
public class FsiRestartTests {
    @Implements(value=DeviceTokenStore.class,isInAndroidSdk=false)
    public static class Tokens {
        static boolean available;
        @Implementation protected String get(String name){return available?"test-paired":"";}
    }
    @Implements(NotificationManager.class)
    public static class Notifications extends org.robolectric.shadows.ShadowNotificationManager {
        static boolean fsiAllowed;
        @Implementation protected boolean canUseFullScreenIntent(){return fsiAllowed;}
    }
    Context c;
    @Before public void setup() {
        c=RuntimeEnvironment.getApplication();
        Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,1);
        Notices.channels(c);
        shadowOf((Application)c).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        Notifications.fsiAllowed=true;
        Tokens.available=true;
    }
    MonitoringStore establish(String mode,long starts) throws Exception {
        MonitoringStore m=new MonitoringStore(c);
        m.update(MonitoringTests.root(mode,1,MonitoringTests.SESSION,starts,"cmd"),0);
        assertTrue(FsiPreference.set(c,true));assertTrue(FsiSettings.consent(c));return m;
    }
    // Drop Android's process-local preferences cache. The subsequent instance reads
    // committed XML again; this models process death, not a physical device reboot.
    void reloadPreferences() throws Exception {
        Class<?> cls=Class.forName("android.app.ContextImpl");
        var field=cls.getDeclaredField("sSharedPrefsCache");field.setAccessible(true);
        synchronized(cls){((java.util.Map<?,?>)field.get(null)).clear();}
    }
    void assertOffer(String id) {
        PendingAlarmStore ledger=new PendingAlarmStore(c);
        assertTrue(ledger.register(id,SystemClock.elapsedRealtime()+10000,1000,FsiSettings.enabled(c)));
        assertNotNull(ledger.offer(id));assertNotNull(ledger.offerFsi(id));
    }
    @Test public void acceptedFutureClockSkewMustNotLoseFsiRegistration() throws Exception {
        MonitoringStore m=new MonitoringStore(c);
        m.update(MonitoringTests.root("IMMEDIATE",1,MonitoringTests.SESSION,100000,"cmd"),0);
        assertTrue(FsiSettings.consent(c));
        // Existing freshness contract permits an issued time 1 second ahead.
        long now=m.serverNow(), issued=now+1000, expires=issued+120000;
        assertTrue(AlarmPolicy.freshForPairing(issued,expires,now,m.pairedAt()));
        long elapsed=SystemClock.elapsedRealtime();
        long deadline=AlarmPolicy.deliveryDeadline(expires,now,elapsed);
        assertTrue(new PendingAlarmStore(c).register("e".repeat(64),deadline,m.pairedAt(),true));
        assertTrue(deadline<=elapsed+120000);
        assertTrue(deadline<=elapsed+expires-now);
    }
    @Test public void immediateSurvivesPreferencesReloadWithoutMainActivity() throws Exception {
        establish("IMMEDIATE",100000);reloadPreferences();
        assertTrue(FsiSettings.enabled(c));assertEquals(FsiRecovery.Reason.READY,FsiRecovery.restore(c,"e".repeat(64)));
        assertOffer("e".repeat(64));
    }
    @Test public void scheduledSurvivesReloadWithoutMovingStart() throws Exception {
        establish("SCHEDULED",160000);reloadPreferences();
        assertEquals(160000,new MonitoringStore(c).starts());assertTrue(FsiSettings.enabled(c));
        assertEquals(FsiRecovery.Reason.WAITING_FOR_START,FsiRecovery.restore(c,null));
    }
    @Test public void rebootBeforeScheduledStartPreservesAbsoluteStart() throws Exception {
        establish("SCHEDULED",160000);reloadPreferences();
        Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,2);
        assertFalse(new MonitoringStore(c).active());assertEquals(160000,new MonitoringStore(c).starts());
        assertEquals(FsiRecovery.Reason.WAITING_FOR_START,FsiRecovery.restore(c,null));
    }
    @Test public void scheduledOnlyAcceptsNewEventAfterOriginalStart() throws Exception {
        establish("SCHEDULED",160000);reloadPreferences();
        MonitoringTests fixture=new MonitoringTests();fixture.c=c;fixture.store=new MonitoringStore(c);
        var data=fixture.event(159999,160000,280000);data.put("monitoringMode","SCHEDULED");data.put("monitoringStartsAtMs","160000");
        assertFalse(new MonitoringStore(c).accept(data));
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(60));
        data.put("serverNowMs","160000");assertFalse(new MonitoringStore(c).accept(data));
        data.put("occurredAt",java.time.Instant.ofEpochMilli(160000).toString());
        assertTrue(new MonitoringStore(c).accept(data));assertOffer("e".repeat(64));
    }
    @Test public void sameSessionRevisionRefreshPreservesBinding() throws Exception {
        MonitoringStore m=establish("IMMEDIATE",100000);reloadPreferences();
        m=new MonitoringStore(c);m.update(MonitoringTests.root("IMMEDIATE",1,MonitoringTests.SESSION,100000,"cmd"),0);
        assertTrue(FsiSettings.enabled(c));assertOffer("e".repeat(64));
    }
    @Test public void differentRevisionDoesNotReuseConsent() throws Exception {
        MonitoringStore m=establish("IMMEDIATE",100000);
        m.update(MonitoringTests.root("IMMEDIATE",2,"b".repeat(64),100000,"other"),0);reloadPreferences();
        FsiRecovery.restore(c,null);assertFalse(FsiSettings.enabled(c));
        assertEquals(FsiRecovery.Reason.REVISION_MISMATCH,FsiRecovery.reason(c));
    }
    @Test public void corruptedSessionBindingFailsClosed() throws Exception {
        establish("IMMEDIATE",100000);
        c.getSharedPreferences("monitoring-v1",0).edit().putString("fsiSession","b".repeat(64)).commit();reloadPreferences();
        assertEquals(FsiRecovery.Reason.SESSION_MISMATCH,FsiRecovery.restore(c,null));assertFalse(FsiSettings.enabled(c));
    }
    @Test public void explicitOffSurvivesReloadDespiteStoredConsent() throws Exception {
        establish("IMMEDIATE",100000);FsiPreference.set(c,false);reloadPreferences();
        assertEquals(FsiRecovery.Reason.PREFERENCE_OFF,FsiRecovery.restore(c,null));assertFalse(FsiSettings.enabled(c));
        assertFalse(FsiPreference.enabled(c));assertTrue(new MonitoringStore(c).active());
    }
    @Test public void upgradeRecoveryDoesNotMutateExistingSettingsOrTokens() throws Exception {
        establish("SCHEDULED",160000);
        c.getSharedPreferences("protected-tokens",0).edit().putString("bearer","opaque-test-ciphertext").commit();
        var before=new java.util.HashMap<>(c.getSharedPreferences("monitoring-v1",0).getAll());
        reloadPreferences();FsiRecovery.restore(c,null);
        assertEquals(before,c.getSharedPreferences("monitoring-v1",0).getAll());
        assertEquals("opaque-test-ciphertext",c.getSharedPreferences("protected-tokens",0).getString("bearer",""));
        assertTrue(FsiPreference.enabled(c));
    }
    @Test public void refreshAndRecoveryRaceDoesNotRejectSameBinding() throws Exception {
        establish("IMMEDIATE",100000);reloadPreferences();
        var executor=java.util.concurrent.Executors.newFixedThreadPool(2);
        var start=new java.util.concurrent.CountDownLatch(1);
        try {
            var writer=executor.submit(()->{start.await();for(int i=0;i<100;i++)new MonitoringStore(c).update(MonitoringTests.root("IMMEDIATE",1,MonitoringTests.SESSION,100000,"cmd"),0);return true;});
            var reader=executor.submit(()->{start.await();for(int i=0;i<100;i++)if(!FsiSettings.enabled(c))return false;return true;});
            start.countDown();assertTrue(writer.get(15,java.util.concurrent.TimeUnit.SECONDS));assertTrue(reader.get(15,java.util.concurrent.TimeUnit.SECONDS));
        } finally {executor.shutdownNow();}
    }
    @Test public void recoveryDoesNotResetDeduplicationOrFsiOffered() throws Exception {
        establish("IMMEDIATE",100000);String id="e".repeat(64);
        assertTrue(new EventStore(c).claim(id,220000,100000));assertOffer(id);reloadPreferences();FsiRecovery.restore(c,id);
        assertFalse(new EventStore(c).claim(id,220000,100000));assertNull(new PendingAlarmStore(c).offerFsi(id));
        assertOffer("f".repeat(64));
    }
    @Test public void monitoringEndCannotBeUndoneByRecovery() throws Exception {
        MonitoringStore m=establish("IMMEDIATE",100000);m.command("OFF",0,false,1000);reloadPreferences();FsiRecovery.restore(c,null);
        assertTrue(new MonitoringStore(c).ended());assertFalse(new MonitoringStore(c).active());assertFalse(FsiSettings.enabled(c));
        assertEquals("OFF",new MonitoringStore(c).pending().getString("mode"));
    }
    @Test public void missingConsentIsNotInventedFromWorkerUrgency() throws Exception {
        establish("IMMEDIATE",100000);new MonitoringStore(c).clearFsi();reloadPreferences();
        assertEquals(FsiRecovery.Reason.CONSENT_MISSING,FsiRecovery.restore(c,null));assertFalse(new MonitoringStore(c).fsiDeclared());
    }
    @Test public void noSystemPermissionRemainsNotReadyAfterRecovery() throws Exception {
        establish("IMMEDIATE",100000);Notifications.fsiAllowed=false;
        assertEquals(FsiRecovery.Reason.SYSTEM_PERMISSION_DENIED,FsiRecovery.restore(c,null));assertFalse(FsiSettings.ready(c));
    }
    @Test public void downgradedUrgentChannelIsVisibleInSharedGate() throws Exception {
        establish("IMMEDIATE",100000);var nm=c.getSystemService(NotificationManager.class);
        var channel=nm.getNotificationChannel(Notices.URGENT);channel.setImportance(NotificationManager.IMPORTANCE_LOW);nm.createNotificationChannel(channel);
        assertEquals(FsiRecovery.Reason.URGENT_CHANNEL_BLOCKED,FsiRecovery.restore(c,null));assertFalse(FsiSettings.ready(c));
    }
    @Test public void unreadableCredentialIsNotDisplayedAsReady() throws Exception {
        establish("IMMEDIATE",100000);Tokens.available=false;
        assertEquals(FsiRecovery.Reason.CREDENTIAL_UNAVAILABLE,FsiRecovery.restore(c,null));assertFalse(FsiSettings.ready(c));
        assertTrue(new MonitoringStore(c).fsiDeclared());assertTrue(new MonitoringStore(c).active());
    }
}
