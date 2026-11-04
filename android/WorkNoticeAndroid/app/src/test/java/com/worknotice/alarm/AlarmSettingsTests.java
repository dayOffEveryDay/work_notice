package com.worknotice.alarm;
import android.app.*;
import android.content.*;
import android.os.*;
import android.provider.Settings;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class AlarmSettingsTests {
    Context c;AlarmPreferencesRepository repo;
    static JSONObject snapshot(String mode,boolean enabled,long expiry,long revision) throws Exception {
        return new JSONObject().put("pairedAt",1000).put("serverNow",100000).put("alertSetting",new JSONObject().put("enabled",enabled?1:0).put("effectiveEnabled",enabled).put("mode",mode).put("expires_at_ms",expiry).put("updated_at_ms",revision));
    }
    @Before public void setup(){c=RuntimeEnvironment.getApplication();Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,1);repo=new AlarmPreferencesRepository(c,()->true);}
    @Test public void blankHoursReproducesLegacyFailureButNowMeansZero(){try{Integer.parseInt("");fail();}catch(NumberFormatException expected){}assertEquals(5,AlarmModeUi.parse("","5"));}
    @Test public void blankMinutesAndWhitespaceAccepted(){assertEquals(60,AlarmModeUi.parse(" 1 ",""));assertEquals(1440,AlarmModeUi.parse("24","0"));}
    @Test public void zeroAndMalformedAndOverflowRejected(){for(String[] v:new String[][]{{"",""},{"0","0"},{"24","1"},{"-1","2"},{"0","60"},{"999999999999999999","1"},{"x","1"}}){try{AlarmModeUi.parse(v[0],v[1]);fail(Arrays.toString(v));}catch(AlarmModeUi.InputError expected){}}}
    @Test public void formattedRemainingUsesHoursMinutesSeconds(){assertEquals("01:01:01",AlarmModeUi.remaining(3661000));assertEquals("00:00:01",AlarmModeUi.remaining(1));assertEquals("00:00:00",AlarmModeUi.remaining(0));}
    @Test public void putThenReadBackBeforeApplying() throws Exception {
        var save=new AlarmSettingsSave();assertTrue(save.begin());List<String> calls=new ArrayList<>();
        save.perform((method,path,body)->{calls.add(method+path);if("PUT".equals(method)){assertFalse(repo.enabled());assertEquals(5,body.getInt("durationMinutes"));assertEquals("TIMED",body.getString("mode"));return new JSONObject();}return snapshot("TIMED",true,400000,2);},repo::update,()->0,true,"TIMED",5,true);
        assertEquals(Arrays.asList("PUT/api/mobile/alert-settings","GET/api/mobile/status"),calls);assertTrue(repo.enabled());assertTrue(repo.timed());
    }
    @Test public void networkFailureDoesNotEnableLocalAlarm() throws Exception {var save=new AlarmSettingsSave();assertTrue(save.begin());try{save.perform((m,p,b)->{throw new java.net.SocketTimeoutException();},repo::update,()->0,true,"TIMED",5,true);fail();}catch(java.net.SocketTimeoutException expected){}assertFalse(repo.enabled());assertFalse(AlarmSettingsSave.busy());}
    @Test public void putSuccessReadFailureIsUnconfirmedNotSuccess() throws Exception {var save=new AlarmSettingsSave();assertTrue(save.begin());try{save.perform((m,p,b)->{if("GET".equals(m))throw new java.io.IOException();return new JSONObject();},repo::update,()->0,true,"TIMED",5,true);fail();}catch(AlarmSettingsSave.Unconfirmed expected){assertTrue(AlarmModeUi.failure(expected).contains("勿重複延長"));}assertFalse(repo.enabled());}
    @Test public void malformedReadBackCannotEnable() throws Exception {var save=new AlarmSettingsSave();assertTrue(save.begin());try{save.perform((m,p,b)->new JSONObject(),repo::update,()->0,true,"TIMED",5,true);fail();}catch(AlarmSettingsSave.Unconfirmed expected){}assertFalse(repo.enabled());}
    @Test public void busyGateBlocksAnotherActivityAndRepeatedClick(){var one=new AlarmSettingsSave();assertTrue(one.begin());try{assertFalse(one.begin());assertFalse(new AlarmSettingsSave().begin());}finally{one.cancel();}assertFalse(AlarmSettingsSave.busy());}
    @Test public void expiryReallyDisablesAndRepositoryReopensWithoutReset() throws Exception {repo.update(snapshot("TIMED",true,160000,1),0);shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(30));var reopened=new AlarmPreferencesRepository(c,()->true);assertTrue(reopened.enabled());assertEquals(30000,reopened.remainingMillis());shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(30));assertFalse(reopened.enabled());assertEquals(0,reopened.remainingMillis());}
    @Test public void countdownUsesPersistedMonotonicDeadline() throws Exception {repo.update(snapshot("TIMED",true,160000,1),0);c.getSharedPreferences("settings",0).edit().putLong("server",900000000).commit();assertEquals(60000,repo.remainingMillis());assertTrue(repo.enabled());}
    @Test public void roundTripDoesNotExtendServerExpiry() throws Exception {repo.update(snapshot("TIMED",true,160000,1),2000);assertEquals(58000,repo.remainingMillis());}
    @Test public void modeSwitchAndFsiRevisionInvalidation() throws Exception {repo.update(snapshot("UNTIL_MANUALLY_DISABLED",true,0,1),0);FsiSettings.consent(c);repo.update(snapshot("TIMED",true,160000,2),0);assertTrue(repo.timed());assertTrue(repo.enabled());assertNotEquals(FsiSettings.period(c),c.getSharedPreferences("fsi-v1",0).getLong("period",-1));repo.update(snapshot("UNTIL_MANUALLY_DISABLED",true,0,3),0);assertFalse(repo.timed());assertTrue(repo.enabled());}
    @Test public void disableAndRebootFailClosed() throws Exception {repo.update(snapshot("TIMED",true,160000,1),0);repo.disableLocal();assertFalse(repo.enabled());repo.update(snapshot("TIMED",true,160000,2),0);Settings.Global.putInt(c.getContentResolver(),Settings.Global.BOOT_COUNT,2);assertFalse(repo.enabled());assertEquals(0,repo.remainingMillis());}
    @Test public void authErrorAndTimeoutGiveSpecificFeedback(){assertTrue(AlarmModeUi.failure(new ApiClient.ApiException(401)).contains("配對授權"));assertTrue(AlarmModeUi.failure(new java.net.SocketTimeoutException()).contains("逾時"));}

    public static class Screen extends MainActivity {
        static List<JSONObject> sent;static CountDownLatch entered,release,finished;
        @Override protected boolean monitoringPaired(){return true;}
        @Override protected boolean fsiGranted(){return true;}
        @Override protected AlarmPreferencesRepository alarmRepository(){return new AlarmPreferencesRepository(this,()->true);}
        @Override protected JSONObject monitoringCall(String method,JSONObject body) throws Exception {
            if("PUT".equals(method)){sent.add(body);entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new java.net.SocketTimeoutException();finished.countDown();return MonitoringTests.root("SCHEDULED",1,"a".repeat(64),400000,body.getString("commandId"));}
            finished.countDown();return snapshot("TIMED",true,400000,2);
        }
    }
    @Test public void actualButtonShowsSavingAndPreventsDuplicateThenRendersConfirmedCountdown() throws Exception {
        Screen.sent=Collections.synchronizedList(new ArrayList<>());Screen.entered=new CountDownLatch(1);Screen.release=new CountDownLatch(1);Screen.finished=new CountDownLatch(1);
        new MonitoringStore(c).update(MonitoringTests.root("OFF",0,"",0,""),0);
        var ctrl=Robolectric.buildActivity(Screen.class).create().start().resume().visible();
        try {
            var screen=ctrl.get();((android.widget.EditText)screen.findViewById(R.id.hours)).setText("");((android.widget.EditText)screen.findViewById(R.id.minutes)).setText("5");screen.findViewById(R.id.timed).performClick();
            org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog().getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();
            shadowOf(Looper.getMainLooper()).idle();
            assertTrue(Screen.entered.await(3,TimeUnit.SECONDS));assertTrue(((android.widget.TextView)screen.findViewById(R.id.setting_feedback)).getText().toString().contains("同步中"));assertFalse(screen.findViewById(R.id.timed).isEnabled());screen.findViewById(R.id.timed).performClick();assertEquals(1,Screen.sent.size());
            Screen.release.countDown();assertTrue(Screen.finished.await(3,TimeUnit.SECONDS));
            for(int i=0;i<200&&new MonitoringStore(c).revision()<1;i++)Thread.sleep(10);
            shadowOf(Looper.getMainLooper()).idle();
            assertEquals("預約等待中",((android.widget.TextView)screen.findViewById(R.id.mode_title)).getText().toString());assertTrue(((android.widget.TextView)screen.findViewById(R.id.setting_status)).getText().toString().contains("00:05:00"));assertEquals(5,Screen.sent.get(0).getInt("delayMinutes"));
        } finally {Screen.release.countDown();ctrl.pause().stop().destroy();}
    }
}
