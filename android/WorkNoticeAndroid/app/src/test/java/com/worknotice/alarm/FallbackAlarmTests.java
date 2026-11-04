package com.worknotice.alarm;
import org.junit.Test;
import static org.junit.Assert.*;

public class FallbackAlarmTests {
    private FallbackAlarm alarm(){FallbackAlarm a=new FallbackAlarm("event",10000,1000,1,FallbackAlarm.State.AUTO,null);a.offer("nonce");return a;}
    @Test public void availableActionCanBeClaimedAndStartedExactlyOnce(){
        FallbackAlarm a=alarm();assertEquals(FallbackAlarm.Decision.ALLOWED,a.claim("nonce",2000,1000,1,true,true));
        assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,a.claim("nonce",2000,1000,1,true,true));
        assertEquals(FallbackAlarm.Decision.ALLOWED,a.start("nonce",2000,1000,1,true,true));
        assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,a.start("nonce",2000,1000,1,true,true));
    }
    @Test public void wrongActionCannotConsumeTheRealAction(){FallbackAlarm a=alarm();assertEquals(FallbackAlarm.Decision.INVALID_ACTION,a.claim("wrong",2000,1000,1,true,true));assertEquals(FallbackAlarm.State.AVAILABLE,a.state);}
    @Test public void deadlineBoundaryRejects(){assertEquals(FallbackAlarm.Decision.EXPIRED,alarm().claim("nonce",10000,1000,1,true,true));}
    @Test public void disabledReceptionRejects(){assertEquals(FallbackAlarm.Decision.DISABLED,alarm().claim("nonce",2000,1000,1,true,false));}
    @Test public void unpairedRejects(){assertEquals(FallbackAlarm.Decision.UNPAIRED,alarm().claim("nonce",2000,1000,1,false,true));}
    @Test public void newPairingRejectsOldNotification(){assertEquals(FallbackAlarm.Decision.OLD_PAIRING,alarm().claim("nonce",2000,2000,1,true,true));}
    @Test public void rebootRejectsMonotonicDeadlineFromPriorBoot(){assertEquals(FallbackAlarm.Decision.REBOOTED,alarm().claim("nonce",2000,1000,2,true,true));}
    @Test public void settingsAreRecheckedAtServiceStart(){FallbackAlarm a=alarm();a.claim("nonce",2000,1000,1,true,true);assertEquals(FallbackAlarm.Decision.DISABLED,a.start("nonce",2001,1000,1,true,false));}
    @Test public void expiryBetweenActivityAndServiceRejects(){FallbackAlarm a=alarm();a.claim("nonce",9999,1000,1,true,true);assertEquals(FallbackAlarm.Decision.EXPIRED,a.start("nonce",10000,1000,1,true,true));}
    @Test public void genuineStopMakesActionTerminal(){FallbackAlarm a=alarm();a.stopped();a.offer("new");assertEquals(FallbackAlarm.Decision.ALREADY_HANDLED,a.claim("nonce",2000,1000,1,true,true));}
    @Test public void alreadyRangNeverRingsAgainFromFallback(){FallbackAlarm a=alarm();a.ringing();a.offer("new");assertEquals(FallbackAlarm.State.RANG,a.state);assertNull(a.action);}
    @Test public void failedUserRetryDoesNotMintAnotherAction(){FallbackAlarm a=alarm();a.claim("nonce",2000,1000,1,true,true);a.start("nonce",2000,1000,1,true,true);a.offer("new");assertEquals(FallbackAlarm.State.FAILED,a.state);}
}
