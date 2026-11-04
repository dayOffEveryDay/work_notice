package com.worknotice.alarm;
import java.util.Map;

/** Durable adapter supplies the map; never evict recent IDs to admit a duplicate. */
public final class EventLedger {
    private EventLedger() { }
    public static boolean claim(Map<String, Long> entries, String event, long expires, long now) {
        if (entries.containsKey(event)) return false;
        entries.entrySet().removeIf(entry -> entry.getValue() < now - 86400000);
        if (entries.size() >= 4096) return false;
        entries.put(event, expires); return true;
    }
}
