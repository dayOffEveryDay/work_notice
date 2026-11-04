package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;

public final class EventStore {
    private static final Object LOCK = new Object();
    private final SharedPreferences prefs;
    public EventStore(Context c) { prefs = c.getSharedPreferences("seen-events", Context.MODE_PRIVATE); }
    public boolean claim(String id, long expires, long now) {
        synchronized (LOCK) {
            java.util.Map<String, Long> entries = new java.util.HashMap<>();
            for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                if (entry.getValue() instanceof Long) entries.put(entry.getKey(), (Long) entry.getValue());
            }
            if (!EventLedger.claim(entries, id, expires, now)) return false;
            SharedPreferences.Editor edit = prefs.edit().clear();
            for (Map.Entry<String, Long> entry : entries.entrySet()) edit.putLong(entry.getKey(), entry.getValue());
            return edit.commit();
        }
    }
}
