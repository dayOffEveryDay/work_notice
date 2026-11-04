package com.worknotice.alarm;

/** Platform exceptions, including FGS start denial, always take the visible fallback path. */
public final class AlarmDelivery {
    public enum Failure { NOTIFICATIONS_BLOCKED, PRIORITY_DOWNGRADED, START_DENIED, SECURITY_DENIED }
    private AlarmDelivery() { }
    public static boolean deliver(boolean notifications, boolean foreground, boolean highPriority, Runnable starter, Runnable fallback) {
        return attempt(notifications, foreground, highPriority, starter, reason -> fallback.run());
    }
    public static boolean attempt(boolean notifications, boolean foreground, boolean highPriority, Runnable starter, java.util.function.Consumer<Failure> fallback) {
        if (!notifications) { fallback.accept(Failure.NOTIFICATIONS_BLOCKED); return false; }
        if (!foreground && !highPriority) { fallback.accept(Failure.PRIORITY_DOWNGRADED); return false; }
        try { starter.run(); return true; }
        catch (SecurityException denied) { fallback.accept(Failure.SECURITY_DENIED); return false; }
        catch (IllegalStateException denied) { fallback.accept(Failure.START_DENIED); return false; }
    }
}
