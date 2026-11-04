package com.worknotice.alarm;
import android.content.*;
import android.view.View;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,manifest=Config.NONE,application=android.app.Application.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class Ui041Tests {
    Context c;
    @Before public void setup(){c=RuntimeEnvironment.getApplication();}
    @Test public void homeHidesPairingAndDiagnostics(){
        var ctl=Robolectric.buildActivity(MainActivity.class).create();try{
            var a=ctl.get();assertEquals(View.GONE,a.findViewById(R.id.panel_device).getVisibility());
            assertEquals(View.GONE,a.findViewById(R.id.panel_diagnostics).getVisibility());
            assertEquals(View.VISIBLE,a.findViewById(R.id.panel_home).getVisibility());
            a.findViewById(R.id.settings_entry).performClick();
            assertEquals(SettingsActivity.class.getName(),org.robolectric.Shadows.shadowOf(a).getNextStartedActivity().getComponent().getClassName());
        }finally{ctl.destroy();}
    }
    @Test public void settingsShowsOnlySelectedCategory(){
        var ctl=Robolectric.buildActivity(SettingsActivity.class,new Intent(c,SettingsActivity.class).putExtra("section","device")).create();
        try{assertEquals(View.VISIBLE,ctl.get().findViewById(R.id.panel_device).getVisibility());assertEquals(View.GONE,ctl.get().findViewById(R.id.panel_home).getVisibility());assertEquals(View.GONE,ctl.get().findViewById(R.id.panel_diagnostics).getVisibility());}finally{ctl.destroy();}
    }
    @Test public void preferencePersistsButDoesNotAuthorizeNewPeriod() throws Exception {
        assertTrue(FsiPreference.set(c,true));assertTrue(FsiPreference.enabled(c));
        MonitoringStore s=new MonitoringStore(c);s.update(MonitoringTests.root("IMMEDIATE",1,"a".repeat(64),100000,"old"),0);
        assertFalse(FsiSettings.enabled(c));
        var cmd=s.command("SCHEDULED",1,true,1000);
        s.update(MonitoringTests.root("SCHEDULED",2,"b".repeat(64),160000,cmd.getString("commandId")),0);
        assertTrue(FsiSettings.enabled(c));assertTrue(new MonitoringStore(c).fsiSessionMatches());
        s.update(MonitoringTests.root("IMMEDIATE",3,"c".repeat(64),100000,"unknown"),0);assertFalse(FsiSettings.enabled(c));assertTrue(FsiPreference.enabled(c));
    }
    @Test public void disablingPreferenceBlocksDelayedConsentWithoutEndingMonitoring() throws Exception {
        MonitoringStore s=new MonitoringStore(c);s.update(MonitoringTests.root("IMMEDIATE",1,"a".repeat(64),100000,"old"),0);
        FsiSettings.consent(c);assertTrue(FsiPreference.set(c,false));assertFalse(FsiSettings.enabled(c));assertTrue(s.active());
        FsiSettings.consent(c);assertFalse(FsiSettings.enabled(c));
    }
    @Test public void preferenceDoesNotInventSystemPermission(){boolean before=FsiSettings.permission(c);assertTrue(FsiPreference.set(c,true));assertEquals(before,FsiSettings.permission(c));}
    @Test @Config(qualifiers="w320dp-h480dp-night") public void compactNightHomeInflatesWithSettingsReachable(){
        var ctl=Robolectric.buildActivity(MainActivity.class);ctl.get().setTheme(R.style.WorkNoticeTheme);ctl.create();
        try{assertEquals(View.VISIBLE,ctl.get().findViewById(R.id.settings_entry).getVisibility());assertEquals(View.GONE,ctl.get().findViewById(R.id.panel_alerts).getVisibility());}finally{ctl.destroy();}
    }
    @Test public void unpairRequiresExplicitConfirmation(){
        var ctl=Robolectric.buildActivity(SettingsActivity.class,new Intent(c,SettingsActivity.class).putExtra("section","device")).create();
        try{ctl.get().findViewById(R.id.unpair).performClick();var dialog=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();assertTrue(dialog.isShowing());dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertFalse(dialog.isShowing());}finally{ctl.destroy();}
    }
}
