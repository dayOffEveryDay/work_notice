package com.worknotice.alarm;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;

public class AlarmLifecycleTests {
    private static class Effects implements AlarmLifecycle.Effects {
        final List<String> calls = new ArrayList<>();
        public void releasePlayback() { calls.add("release"); }
        public void removePlaybackService() { calls.add("remove-playback"); }
        public void cancelWorkNotification(String event) { calls.add("cancel:" + event); }
        public void fallback(String event) { calls.add("fallback:" + event); }
        public void ack(String event,String status) { calls.add(status+":"+event); }
    }
    @Test public void failureKeepsFallbackAndNeverPretendsUserStopped() {
        Effects e=new Effects(); AlarmLifecycle a=new AlarmLifecycle(e); a.add("a"); String old=a.id(); a.failed();
        assertEquals(List.of("release","remove-playback","fallback:a"),e.calls);
        assertNull(a.id()); assertFalse(a.userStop(old)); assertFalse(e.calls.stream().anyMatch(s->s.startsWith("STOPPED")||s.startsWith("cancel:")));
    }
    @Test public void genuineQuickStopBeforePrepareSendsStoppedOnceWithoutRinging() {
        Effects e=new Effects(); AlarmLifecycle a=new AlarmLifecycle(e); a.add("a"); String id=a.id();
        assertTrue(a.userStop(id)); assertFalse(a.userStop(id)); a.playing();
        assertEquals(List.of("release","remove-playback","cancel:a","STOPPED:a"),e.calls);
    }
    @Test public void failureOfMergedEventsPreservesBothNotificationsWithoutStoppedAck() {
        Effects e=new Effects(); AlarmLifecycle a=new AlarmLifecycle(e); a.add("a");a.add("b");a.failed();
        assertEquals(List.of("release","remove-playback","fallback:a","fallback:b"),e.calls);
    }
    @Test public void preparedAfterOldSessionStopCannotReviveNewSession() {
        Effects e=new Effects(); AlarmLifecycle a=new AlarmLifecycle(e);a.add("a");String old=a.id();a.userStop(old);a.add("b");
        assertFalse(a.current(old)); assertFalse(a.userStop(old)); assertEquals(1,a.count());
        a.playing();a.playing();assertEquals(1,e.calls.stream().filter(s->s.equals("RINGING:b")).count());
    }
    @Test public void ringingThenFailureDoesNotGenerateStoppedAndNewEventCanRingAgain() {
        Effects e=new Effects();AlarmLifecycle a=new AlarmLifecycle(e);a.add("a");a.playing();a.failed();a.add("b");a.playing();
        assertEquals(1,e.calls.stream().filter(s->s.equals("RINGING:a")).count());assertTrue(e.calls.contains("RINGING:b"));
        assertFalse(e.calls.stream().anyMatch(s->s.startsWith("STOPPED"))); assertTrue(AlarmPolicy.enabled(true,true,false,0,1000));
    }
    @Test public void unpairCleanupIsNotManualAlarmStop() {
        Effects e=new Effects();AlarmLifecycle a=new AlarmLifecycle(e);a.add("a");a.cancelForUnpair();
        assertEquals(List.of("release","remove-playback","cancel:a"),e.calls);
    }
    @Test public void lockedBackgroundDowngradeFallsBackWithoutStartingService() {
        List<AlarmDelivery.Failure> failures=new ArrayList<>();
        assertFalse(AlarmDelivery.attempt(true,false,false,()->fail(),failures::add));
        assertEquals(List.of(AlarmDelivery.Failure.PRIORITY_DOWNGRADED),failures);
    }
    @Test public void highPriorityLockedBackgroundAttemptsFgsAndClassifiesSecurityDenial() {
        List<AlarmDelivery.Failure> failures=new ArrayList<>();
        assertFalse(AlarmDelivery.attempt(true,false,true,()->{throw new SecurityException("private canary");},failures::add));
        assertEquals(List.of(AlarmDelivery.Failure.SECURITY_DENIED),failures);
    }
}
