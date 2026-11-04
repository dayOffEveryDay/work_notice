package com.worknotice.alarm;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;

public class AlarmTests {
    @Test public void countdown150Minutes() { assertEquals(150, AlarmPolicy.durationMinutes(2,30)); }
    @Test public void invalidDurations() {
        for (int[] value : new int[][]{{0,0},{-1,1},{2,60},{25,0}}) {
            try { AlarmPolicy.durationMinutes(value[0],value[1]); fail(); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void continuousRequiresPairedAndEnabled() {
        assertTrue(AlarmPolicy.enabled(true,true,false,0,999999));
        assertFalse(AlarmPolicy.enabled(false,true,false,0,0)); assertFalse(AlarmPolicy.enabled(true,false,false,0,0));
    }
    @Test public void countdownExpiresAtServerDeadline() {
        assertTrue(AlarmPolicy.enabled(true,true,true,9000000,8999999)); assertFalse(AlarmPolicy.enabled(true,true,true,9000000,9000000));
    }
    @Test public void staleFutureAndMalformedExpiryCannotRing() {
        assertTrue(AlarmPolicy.fresh(1000,121000,1001)); assertFalse(AlarmPolicy.fresh(1000,121000,121000));
        assertFalse(AlarmPolicy.fresh(100000,220000,0)); assertFalse(AlarmPolicy.fresh(1000,200000,2000)); assertFalse(AlarmPolicy.fresh(1000,0,0));
    }
    @Test public void oldPairingInFlightPushCannotRingAfterPairingAgain() {
        assertFalse(AlarmPolicy.freshForPairing(1000,121000,10000,2000));
        assertTrue(AlarmPolicy.freshForPairing(3000,123000,10000,2000));
    }
    @Test public void duplicateEventsMergeWithoutNewSession() {
        AlarmSession session=new AlarmSession(); assertTrue(session.add("a")); String id=session.id();
        assertFalse(session.add("a")); assertTrue(session.add("b")); assertEquals(id,session.id()); assertEquals(2,session.count());
    }
    @Test public void stoppingDoesNotChangeFutureEnabledPolicy() {
        AlarmSession session=new AlarmSession(); session.add("first"); assertTrue(session.stop(session.id())); assertNull(session.id());
        assertTrue(AlarmPolicy.enabled(true,true,false,0,1000)); session.add("second"); assertNotNull(session.id()); assertEquals(1,session.count());
    }
    @Test public void staleStopCannotStopNewSession() {
        AlarmSession session=new AlarmSession(); session.add("a"); String old=session.id(); session.stop(old); session.add("b");
        assertFalse(session.stop(old)); assertNotEquals(old,session.id()); assertEquals(1,session.count());
    }
    @Test public void expiryDoesNotStopAlreadyRingingSession() {
        AlarmSession session=new AlarmSession(); session.add("a");
        assertFalse(AlarmPolicy.enabled(true,true,true,1000,1001)); assertEquals(1,session.count()); assertNotNull(session.id());
    }
    @Test public void permissionPriorityAndForegroundDecisions() {
        assertFalse(AlarmPolicy.mayStart(false,true,true)); assertFalse(AlarmPolicy.mayStart(true,false,false));
        assertTrue(AlarmPolicy.mayStart(true,true,false)); assertTrue(AlarmPolicy.mayStart(true,false,true));
    }
    @Test public void transientHttpRetryOnly() {
        for(int status:new int[]{408,429,500,503}) assertTrue(AlarmPolicy.retryHttp(status));
        for(int status:new int[]{200,400,401,403,404}) assertFalse(AlarmPolicy.retryHttp(status));
    }
    @Test public void tokenRotationAndRetryResolveLatestToken() throws Exception {
        String[] latest={"first"}; List<String> attempts=new ArrayList<>();
        TokenRegistration registration=new TokenRegistration(()->latest[0],token->{attempts.add(token);if(attempts.size()==1)throw new java.io.IOException("simulated network loss");});
        try { registration.attempt(); fail(); } catch(java.io.IOException expected) { }
        latest[0]="rotated"; registration.attempt(); assertEquals(List.of("first","rotated"),attempts);
    }
    @Test public void emptyTokenNeverRegisters() {
        try { new TokenRegistration(()->"",token->fail()).attempt(); fail(); } catch(Exception expected) { }
    }
    @Test public void durableLedgerRejectsReplayAfterSessionStopAndRepositoryReload() {
        java.util.Map<String,Long> stored=new java.util.HashMap<>();
        assertTrue(EventLedger.claim(stored,"a",121000,1000)); AlarmSession session=new AlarmSession(); session.add("a"); session.stop(session.id());
        java.util.Map<String,Long> reloaded=new java.util.HashMap<>(stored);
        assertFalse(EventLedger.claim(reloaded,"a",121000,2000)); assertTrue(EventLedger.claim(reloaded,"b",122000,2000));
    }
    @Test public void oldLedgerCleanupDoesNotEvictFreshIds() {
        java.util.Map<String,Long> stored=new java.util.HashMap<>(); stored.put("old",0L); stored.put("fresh",90000000L);
        assertTrue(EventLedger.claim(stored,"new",90100000,90000000)); assertFalse(stored.containsKey("old")); assertTrue(stored.containsKey("fresh"));
    }
    @Test public void fullLedgerFailsClosed() {
        java.util.Map<String,Long> stored=new java.util.HashMap<>(); for(int i=0;i<4096;i++) stored.put("event"+i,120000L);
        assertFalse(EventLedger.claim(stored,"new",121000,1000)); assertFalse(EventLedger.claim(stored,"event0",121000,1000));
    }
    @Test public void fgsDenialUsesOneFallbackAndDoesNotPretendRinging() {
        int[] fallback={0}; assertFalse(AlarmDelivery.deliver(true,false,true,()->{throw new IllegalStateException("simulated FGS denial");},()->fallback[0]++));
        assertEquals(1,fallback[0]);
    }
    @Test public void downgradedOrDeniedNotificationDoesNotStartPlayback() {
        int[] fallbacks={0};
        assertFalse(AlarmDelivery.deliver(true,false,false,()->fail(),()->fallbacks[0]++));
        assertFalse(AlarmDelivery.deliver(false,true,true,()->fail(),()->fallbacks[0]++)); assertEquals(2,fallbacks[0]);
    }
}
