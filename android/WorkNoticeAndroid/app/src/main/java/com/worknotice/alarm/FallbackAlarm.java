package com.worknotice.alarm;

/** Metadata only. One explicit foreground retry per failed event; never a new work event. */
public final class FallbackAlarm {
    public enum State { AUTO, AVAILABLE, USER_CLAIMED, USER_STARTED, FSI_CLAIMED, FSI_STARTED, RANG, STOPPED, FAILED }
    public boolean fsiEligible, fsiOffered;
    public long fsiPeriod=-1;
    public enum Decision { ALLOWED, EXPIRED, DISABLED, UNPAIRED, OLD_PAIRING, REBOOTED, INVALID_ACTION, ALREADY_HANDLED }
    public final String event;
    public final long deadline, pairing;
    public final int boot;
    public State state;
    public String action;
    public FallbackAlarm(String event,long deadline,long pairing,int boot,State state,String action) {
        this.event=event;this.deadline=deadline;this.pairing=pairing;this.boot=boot;this.state=state;this.action=action;
    }
    public void offer(String nonce) { if(state==State.AUTO){state=State.AVAILABLE;action=nonce;} else if(state==State.USER_CLAIMED || state==State.USER_STARTED) state=State.FAILED; }
    public Decision claimFsi(String nonce,long now,long currentPairing,int currentBoot,boolean paired,boolean enabled) {
        if(!fsiEligible||!fsiOffered)return Decision.INVALID_ACTION;
        Decision result=claim(nonce,now,currentPairing,currentBoot,paired,enabled);
        if(result==Decision.ALLOWED)state=State.FSI_CLAIMED;
        return result;
    }
    public Decision startFsi(String nonce,long now,long currentPairing,int currentBoot,boolean paired,boolean enabled) {
        if(state!=State.FSI_CLAIMED)return Decision.ALREADY_HANDLED;
        if(action==null||!action.equals(nonce))return Decision.INVALID_ACTION;
        state=State.USER_CLAIMED;
        Decision result=start(nonce,now,currentPairing,currentBoot,paired,enabled);
        if(result==Decision.ALLOWED)state=State.FSI_STARTED;
        return result;
    }
    public Decision claim(String nonce,long now,long currentPairing,int currentBoot,boolean paired,boolean enabled) {
        if(state!=State.AVAILABLE)return Decision.ALREADY_HANDLED;
        if(action==null || !action.equals(nonce))return Decision.INVALID_ACTION;
        Decision decision=eligible(now,currentPairing,currentBoot,paired,enabled);
        state=decision==Decision.ALLOWED?State.USER_CLAIMED:State.FAILED;return decision;
    }
    public Decision start(String nonce,long now,long currentPairing,int currentBoot,boolean paired,boolean enabled) {
        if(state!=State.USER_CLAIMED)return Decision.ALREADY_HANDLED;
        if(action==null || !action.equals(nonce))return Decision.INVALID_ACTION;
        Decision decision=eligible(now,currentPairing,currentBoot,paired,enabled);
        state=decision==Decision.ALLOWED?State.USER_STARTED:State.FAILED;return decision;
    }
    private Decision eligible(long now,long currentPairing,int currentBoot,boolean paired,boolean enabled) {
        if(!paired)return Decision.UNPAIRED;
        if(currentPairing!=pairing)return Decision.OLD_PAIRING;
        if(currentBoot!=boot)return Decision.REBOOTED;
        if(now>=deadline)return Decision.EXPIRED;
        if(!enabled)return Decision.DISABLED;
        return Decision.ALLOWED;
    }
    public void ringing() { state=State.RANG;action=null; }
    public void stopped() { state=State.STOPPED;action=null; }
}
