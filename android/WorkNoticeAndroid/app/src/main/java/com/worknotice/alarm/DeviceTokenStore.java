package com.worknotice.alarm;
import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** No plaintext bearer or FCM token on disk; backup excluded by manifest. */
public final class DeviceTokenStore {
    private static final String ALIAS = "work-notice-device-v1";
    private final SharedPreferences prefs;
    public DeviceTokenStore(Context c) { prefs = c.getSharedPreferences("protected-tokens", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    public synchronized void put(String name, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] data = cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (!prefs.edit().putString(name, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(data, Base64.NO_WRAP)).commit()) throw new IllegalStateException("安全儲存失敗");
    }
    public synchronized String get(String name) {
        try {
            String value = prefs.getString(name, ""); if (value.isEmpty()) return "";
            String[] pieces = value.split(":");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(pieces[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(pieces[1], Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception ignored) { return ""; } // Fail closed; never plaintext fallback.
    }
    public void clear() { prefs.edit().clear().commit(); }
}
