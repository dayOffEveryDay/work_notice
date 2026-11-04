package com.worknotice.alarm;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class AlarmStopReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) { if ("STOP".equals(i.getAction())) AlarmPlaybackService.stopCurrent(c, i.getStringExtra("session")); }
}
