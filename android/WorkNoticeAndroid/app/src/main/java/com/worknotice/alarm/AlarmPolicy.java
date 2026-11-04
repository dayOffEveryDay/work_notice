package com.worknotice.alarm;

/** Pure policy: server expiry is converted to a monotonic deadline by the repository. */
public final class AlarmPolicy {
    private AlarmPolicy() { }
    public static int durationMinutes(int hours, int minutes) {
        long total = hours * 60L + minutes;
        if (hours < 0 || minutes < 0 || minutes > 59 || total < 1 || total > 1440) throw new IllegalArgumentException("倒數需為 1～1440 分鐘");
        return (int) total;
    }
    public static boolean enabled(boolean paired, boolean enabled, boolean timed, long deadline, long now) {
        return paired && enabled && (!timed || now < deadline);
    }
    public static boolean fresh(long issued, long expires, long now) {
        return issued <= now + 30000 && expires > now && expires > issued && expires - issued <= 120000;
    }
    public static boolean freshForPairing(long issued, long expires, long now, long pairedAt) {
        return issued >= pairedAt && fresh(issued, expires, now);
    }
    static long deliveryDeadline(long expires, long serverNow, long elapsedNow) {
        // Freshness permits a future-issued event (clock skew); the local ledger
        // caps an attempt at 120s. Shorten that attempt, never extend the expiry.
        return elapsedNow + Math.min(120000, Math.max(0, expires - serverNow));
    }
    public static boolean mayStart(boolean notificationsAllowed, boolean foreground, boolean highPriority) {
        return notificationsAllowed && (foreground || highPriority);
    }
    public static boolean retryHttp(int status) { return status == 408 || status == 429 || status >= 500; }
}
