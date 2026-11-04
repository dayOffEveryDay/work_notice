package com.worknotice.alarm;

/** Retry attempts resolve the current SDK token again instead of replaying a stale token. */
public final class TokenRegistration {
    public interface Provider { String latest() throws Exception; }
    public interface Transport { void register(String value) throws Exception; }
    private final Provider provider;
    private final Transport transport;
    public TokenRegistration(Provider provider, Transport transport) { this.provider = provider; this.transport = transport; }
    public void attempt() throws Exception {
        String token = provider.latest();
        if (token == null || token.trim().isEmpty()) throw new IllegalStateException("FCM token unavailable");
        transport.register(token);
    }
}
