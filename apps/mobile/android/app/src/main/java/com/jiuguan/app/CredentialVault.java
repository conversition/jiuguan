package com.jiuguan.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AndroidKeyStore AES-GCM；SharedPreferences 中只保存 iv+ciphertext。 */
final class CredentialVault {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "jiuguan.device.credential.v1";
    private static final String PREFS = "jiuguan_secure_v1";
    private static final String TOKEN = "device_credential";
    private static final byte[] AAD = "jiuguan:device-credential:v1".getBytes(StandardCharsets.UTF_8);
    private final Context context;

    CredentialVault(Context context) { this.context = context.getApplicationContext(); }

    synchronized void put(String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
            + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        prefs().edit().putString(TOKEN, packed).commit();
    }

    synchronized String get() throws Exception {
        String packed = prefs().getString(TOKEN, null);
        if (packed == null) return null;
        String[] parts = packed.split("\\.", -1);
        if (parts.length != 2) { clear(); throw new SecurityException("credential-ciphertext-invalid"); }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(AAD);
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) {
            clear();
            throw error;
        }
    }

    synchronized void clear() { prefs().edit().remove(TOKEN).commit(); }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        java.security.Key existing = store.getKey(ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
