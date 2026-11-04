package com.worknotice.alarm;
import org.junit.Test;
import static org.junit.Assert.*;

public class AudioFocusStartupTests {
    @Test public void focusCannotBeRequestedBeforePromotion() {
        AudioFocusStartup s=new AudioFocusStartup();assertFalse(s.request());assertEquals(AudioFocusStartup.State.CREATED,s.state());
        s.foreground();assertTrue(s.request());assertFalse(s.request());
    }
    @Test public void rejectionIsTerminalAndNeverRetried() {
        AudioFocusStartup s=new AudioFocusStartup();s.foreground();s.request();assertFalse(s.result(false,false));
        s.foreground();assertFalse(s.request());assertFalse(s.gained());assertEquals(AudioFocusStartup.State.CLOSED,s.state());
    }
    @Test public void delayedFocusDoesNotGrantPlaybackUntilGainCallback() {
        AudioFocusStartup s=new AudioFocusStartup();s.foreground();s.request();assertFalse(s.result(false,true));
        assertEquals(AudioFocusStartup.State.WAITING,s.state());assertFalse(s.request());assertTrue(s.gained());assertEquals(AudioFocusStartup.State.GRANTED,s.state());
    }
    @Test public void delayedTimeoutCannotLaterStartPlayback() {
        AudioFocusStartup s=new AudioFocusStartup();s.foreground();s.request();s.result(false,true);assertTrue(s.timeout());assertFalse(s.gained());
    }
    @Test public void quickUserStopCancelsPendingDelayedGain() {
        AudioFocusStartup s=new AudioFocusStartup();s.foreground();s.request();s.result(false,true);s.close();assertFalse(s.gained());assertFalse(s.timeout());
    }
    @Test public void grantedFocusCanResumeWithoutNewRequest() {
        AudioFocusStartup s=new AudioFocusStartup();s.foreground();s.request();assertTrue(s.result(true,false));assertTrue(s.gained());assertFalse(s.request());assertFalse(s.timeout());
    }
}
