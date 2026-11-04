package com.worknotice.alarm;
import android.content.Context;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=android.app.Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class FsiMigrationTests {
    Context c;MonitoringStore s;
    @Before public void setup(){c=RuntimeEnvironment.getApplication();s=new MonitoringStore(c);}
    private void oldPeriod() throws Exception {s.update(MonitoringTests.root("IMMEDIATE",1,"a".repeat(64),100000,"old"),0);assertTrue(FsiSettings.consent(c));}
    @Test public void migrateBeforeEndingOldPeriodPreservesIntentAcrossNewSession() throws Exception {
        oldPeriod();s.command("OFF",0,false,1000);assertTrue(FsiPreference.enabled(c));assertEquals("LEGACY_CONSENT",FsiPreference.origin(c));
        var off=s.pending();s.update(MonitoringTests.root("OFF",2,"b".repeat(64),0,off.getString("commandId")),0);
        var on=s.command("IMMEDIATE",0,true,1000);s.update(MonitoringTests.root("IMMEDIATE",3,"c".repeat(64),100000,on.getString("commandId")),0);
        assertTrue(FsiSettings.enabled(c));assertEquals(3,s.fsiRevision());assertTrue(s.fsiSessionMatches());
    }
    @Test public void scheduledTransitionDoesNotEraseMigratedIntent() throws Exception {
        oldPeriod();assertTrue(FsiPreference.enabled(c));var cmd=s.command("SCHEDULED",1,true,1000);
        s.update(MonitoringTests.root("SCHEDULED",2,"b".repeat(64),160000,cmd.getString("commandId")),0);
        assertTrue(FsiSettings.enabled(c));org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMinutes(1));
        assertTrue(FsiSettings.enabled(c));assertEquals(2,s.revision());
    }
    @Test public void explicitOffNeverAutomaticallyMigratesBackOn() throws Exception {oldPeriod();FsiPreference.set(c,false);FsiSettings.clear(c);FsiSettings.consent(c);assertFalse(FsiSettings.enabled(c));assertEquals("USER",FsiPreference.origin(c));}
    @Test public void ambiguous041FalseRequiresReviewNotSilentOverride() throws Exception {oldPeriod();c.getSharedPreferences("fsi-preference",0).edit().putBoolean("enabled",false).commit();assertFalse(FsiPreference.enabled(c));assertEquals("LEGACY_CHOICE_REVIEW",FsiPreference.origin(c));FsiPreference.set(c,true);assertTrue(FsiSettings.enabled(c));}
    @Test public void noPriorConsentNeverClaimsReady(){assertFalse(FsiPreference.enabled(c));assertFalse(FsiSettings.enabled(c));assertEquals("UNCONFIRMED",FsiPreference.origin(c));}
    @Test public void migratedPreferenceDoesNotAuthorizeUnknownNewRevision() throws Exception {oldPeriod();FsiPreference.enabled(c);s.update(MonitoringTests.root("IMMEDIATE",2,"b".repeat(64),100000,"remote"),0);assertTrue(FsiPreference.enabled(c));assertFalse(FsiSettings.enabled(c));}
}
