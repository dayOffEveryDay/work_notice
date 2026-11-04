package com.worknotice.alarm;

/** One request per session. A rejected request is never retried to bypass platform policy. */
public final class AudioFocusStartup {
    public enum State { CREATED, FOREGROUND, REQUESTED, WAITING, GRANTED, CLOSED }
    private State state = State.CREATED;
    public State state() { return state; }
    public void foreground() { if (state == State.CREATED) state = State.FOREGROUND; }
    public boolean request() { if (state != State.FOREGROUND) return false; state = State.REQUESTED; return true; }
    public boolean result(boolean granted, boolean delayed) {
        if (state != State.REQUESTED) return false;
        state = granted ? State.GRANTED : delayed ? State.WAITING : State.CLOSED;
        return granted;
    }
    public boolean gained() { if (state != State.WAITING && state != State.GRANTED) return false; state = State.GRANTED; return true; }
    public boolean timeout() { if (state != State.WAITING) return false; state = State.CLOSED; return true; }
    public void close() { state = State.CLOSED; }
}
