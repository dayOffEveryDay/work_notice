package com.worknotice.alarm;
/** Safe categories only; never log exception messages, URLs, tokens or headers. */
public final class AckFailure {
    public enum Kind { DNS, TLS, TIMEOUT, NETWORK_IO, RESPONSE_JSON, LOCAL_SECURITY, LOCAL_UNEXPECTED }
    private AckFailure() { }
    public static Kind classify(Exception e){
        if(e instanceof java.net.UnknownHostException)return Kind.DNS;
        if(e instanceof javax.net.ssl.SSLException)return Kind.TLS;
        if(e instanceof java.net.SocketTimeoutException)return Kind.TIMEOUT;
        if(e instanceof org.json.JSONException)return Kind.RESPONSE_JSON;
        if(e instanceof java.security.GeneralSecurityException||e instanceof SecurityException)return Kind.LOCAL_SECURITY;
        if(e instanceof java.io.IOException)return Kind.NETWORK_IO;
        return Kind.LOCAL_UNEXPECTED;
    }
}
