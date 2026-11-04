package com.worknotice.alarm;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

/** One player session; deduplication is additionally durable in EventStore. */
public final class AlarmSession {
    private String id;
    private final Set<String> events = new LinkedHashSet<>();
    public synchronized boolean add(String event) {
        if (events.contains(event)) return false;
        if (id == null) id = UUID.randomUUID().toString();
        events.add(event); return true;
    }
    public synchronized String id() { return id; }
    public synchronized int count() { return events.size(); }
    public synchronized Set<String> events() { return new LinkedHashSet<>(events); }
    public synchronized boolean stop(String expected) {
        if (id == null || !id.equals(expected)) return false;
        id = null; events.clear(); return true;
    }
}
