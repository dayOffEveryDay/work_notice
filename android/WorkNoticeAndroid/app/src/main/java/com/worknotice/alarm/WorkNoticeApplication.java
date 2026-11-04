package com.worknotice.alarm;
import android.app.Application;
import android.app.Activity;
import android.os.Bundle;

public final class WorkNoticeApplication extends Application implements Application.ActivityLifecycleCallbacks {
    private static volatile int visible;
    private static WorkNoticeApplication instance;
    public static boolean foreground() {
        return visible > 0 && instance != null && instance.getSystemService(android.os.PowerManager.class).isInteractive()
            && !instance.getSystemService(android.app.KeyguardManager.class).isKeyguardLocked();
    }
    @Override public void onCreate() { super.onCreate(); instance = this; visible=0;
        android.util.Log.i(AlarmDiagnostics.TAG,"stage=PROCESS_START pid="+android.os.Process.myPid());
        Notices.channels(this); FsiRecovery.restore(this,null); registerActivityLifecycleCallbacks(this); }
    @Override public void onActivityStarted(Activity a) { visible++; }
    @Override public void onActivityStopped(Activity a) { visible = Math.max(0, visible - 1); }
    public void onActivityCreated(Activity a, Bundle b) { }
    public void onActivityResumed(Activity a) { }
    public void onActivityPaused(Activity a) { }
    public void onActivitySaveInstanceState(Activity a, Bundle b) { }
    public void onActivityDestroyed(Activity a) { }
}
