package com.worknotice.alarm;
import android.content.Context;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.nio.charset.StandardCharsets;

public final class ApiClient {
    public static final class ApiException extends Exception {
        public final int status;
        ApiException(int status) { super("API HTTP " + status); this.status = status; }
    }
    private final Context context;
    public ApiClient(Context c) { context = c.getApplicationContext(); }
    public JSONObject call(String method, String path, JSONObject body, boolean authenticated) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BuildConfig.API_BASE + path).openConnection();
        try {
            connection.setConnectTimeout(8000); connection.setReadTimeout(8000); connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(method); connection.setRequestProperty("Accept", "application/json");
            if (authenticated) {
                String token = new DeviceTokenStore(context).get("bearer");
                if (token.isEmpty()) throw new ApiException(401);
                connection.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (body != null) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
                try (var stream = connection.getOutputStream()) { stream.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new ApiException(status);
            try (InputStream input = connection.getInputStream(); var output = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[2048]; int count;
                while ((count = input.read(buffer)) != -1) { if (output.size() + count > 32768) throw new java.io.IOException("Response too large"); output.write(buffer, 0, count); }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { connection.disconnect(); }
    }
}
