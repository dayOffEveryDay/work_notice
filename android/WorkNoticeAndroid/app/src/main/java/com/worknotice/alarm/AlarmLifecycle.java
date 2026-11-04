package com.worknotice.alarm;

import java.util.HashSet;
import java.util.Set;

/** Shared orchestration for the real service and deterministic failure/stop tests. */
public final class AlarmLifecycle {
    public interface Effects {
        void releasePlayback();
        void removePlaybackService();
        void cancelWorkNotification(String event);
        void fallback(String event);
        void ack(String event, String status);
    }
    private final AlarmSession session = new AlarmSession();
    private final Set<String> ringing = new HashSet<>();
    private final Effects effects;
    public AlarmLifecycle(Effects effects) { this.effects = effects; }
    public void add(String event) { session.add(event); }
    public String id() { return session.id(); }
    public int count() { return session.count(); }
    public boolean current(String expected) { return expected != null && expected.equals(id()); }
    public void playing() {
        for (String event : session.events()) if (ringing.add(event)) effects.ack(event, "RINGING");
    }
    private Set<String> clear() {
        Set<String> events = session.events(); session.stop(id()); ringing.clear(); return events;
    }
    public boolean userStop(String expected) {
        if (!current(expected)) return false;
        Set<String> events = clear(); // Invalidate asynchronous prepared/focus callbacks first.
        effects.releasePlayback(); effects.removePlaybackService();
        for (String event : events) { effects.cancelWorkNotification(event); effects.ack(event, "STOPPED"); }
        return true;
    }
    public void failed() {
        Set<String> events = clear();
        effects.releasePlayback(); effects.removePlaybackService();
        // Only the ongoing playback notification is removed. Never cancel fallback or send STOPPED.
        for (String event : events) effects.fallback(event);
    }
    public void cancelForUnpair() {
        Set<String> events = clear(); effects.releasePlayback(); effects.removePlaybackService();
        for (String event : events) effects.cancelWorkNotification(event);
    }
}
