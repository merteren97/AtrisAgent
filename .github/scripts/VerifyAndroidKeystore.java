import java.io.File;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.util.Arrays;

/** Reads existing credentials only. Never prints secrets or rewrites a key. */
public class VerifyAndroidKeystore {
    private static void fail(String code, String message) {
        System.err.println("ANDROID_SIGNING_" + code + ": " + message);
        System.exit(2);
    }

    public static void main(String[] args) {
        String file = System.getenv("ANDROID_KEYSTORE_FILE");
        String alias = System.getenv("ANDROID_KEY_ALIAS");
        String storeSecret = System.getenv("ANDROID_KEYSTORE_PASSWORD");
        String keySecret = System.getenv("ANDROID_KEY_PASSWORD");
        if (file == null || alias == null || storeSecret == null || keySecret == null) {
            fail("CONFIG_MISSING", "Keystore file, alias and both passwords are required.");
            return;
        }
        char[] storePassword = storeSecret.toCharArray();
        char[] keyPassword = keySecret.toCharArray();
        try {
            KeyStore store;
            try {
                store = KeyStore.getInstance(new File(file), storePassword);
            } catch (Exception error) {
                fail("STORE_UNREADABLE", "Cannot open the keystore with this JDK. Check that ANDROID_KEY_BASE64 encodes the original JKS/PKCS12 file and ANDROID_KEYSTORE_PASSWORD is correct.");
                return;
            }
            if (!store.containsAlias(alias)) {
                fail("ALIAS_NOT_FOUND", "ANDROID_KEY_ALIAS does not identify an entry in this keystore.");
                return;
            }
            if (!store.isKeyEntry(alias)) {
                fail("NOT_PRIVATE_KEY", "The configured alias is not a private-key entry.");
                return;
            }
            Key key;
            try {
                key = store.getKey(alias, keyPassword);
            } catch (Exception error) {
                fail("KEY_UNREADABLE", "Cannot decrypt the private key. Check ANDROID_KEY_PASSWORD and JDK compatibility. For a PKCS12 file created with default keytool settings, the key password usually matches the store password.");
                return;
            }
            if (!(key instanceof PrivateKey) || store.getCertificate(alias) == null) {
                fail("NOT_PRIVATE_KEY", "The alias must contain a private key and its certificate.");
                return;
            }
            System.out.println("Android signing credentials verified: keystore opened and private key recovered.");
        } catch (Exception error) {
            fail("VALIDATION_FAILED", "Keystore validation failed. Check the original keystore locally; do not paste credentials into build logs or issues.");
        } finally {
            Arrays.fill(storePassword, '\0');
            Arrays.fill(keyPassword, '\0');
        }
    }
}
