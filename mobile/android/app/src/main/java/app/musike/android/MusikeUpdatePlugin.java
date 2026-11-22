package app.musike.android;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Updates from the app (web/src/native/update.ts): downloads the new APK from this fork's GitHub releases and hands
 * it to Android's installer. Android always asks before installing; the first time it also asks to let Musike+
 * install apps, and the update carries on once that is allowed.
 */
@CapacitorPlugin(name = "MusikeUpdate")
public class MusikeUpdatePlugin extends Plugin {

    /** Only files from this fork's releases are downloaded and installed. */
    private static final String RELEASES = "https://github.com/Safoueenmarcoo/musike/releases/download/";
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final long PROGRESS_EVERY_MS = 250;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    /** An install waiting for the "install unknown apps" permission, picked up when the user comes back. */
    private PluginCall waiting;
    private File waitingFile;

    /**
     * Downloads `url` (`size` bytes, `sha256` when GitHub gives it) and opens the installer. Resolves with
     * { status: "started" } once the installer is up, or "permission" if the user came back without allowing it.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        String version = call.getString("version");
        long size = call.getData().optLong("size", -1);
        String sha256 = call.getString("sha256");
        if (url == null || !url.startsWith(RELEASES) || version == null || !VERSION.matcher(version).matches() || size <= 0
            || (sha256 != null && !SHA256.matcher(sha256).matches())) {
            call.reject("Invalid update", "invalid");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("Already updating", "busy");
            return;
        }
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.isDirectory()) dir.mkdirs();
        File apk = new File(dir, "Musike-" + version + ".apk");

        worker.execute(() -> {
            try {
                // A file from an earlier try (say, before the permission was given) is used again if it's whole.
                if (!(apk.length() == size && matches(apk, sha256))) {
                    long[] lastEvent = { 0 };
                    RangedDownload.fetch(url, Collections.emptyMap(), apk, new AtomicBoolean(false), (received, total) -> {
                        long now = System.currentTimeMillis();
                        if (now - lastEvent[0] < PROGRESS_EVERY_MS) return;
                        lastEvent[0] = now;
                        JSObject progress = new JSObject();
                        progress.put("received", received);
                        progress.put("total", total > 0 ? total : size);
                        notifyListeners("progress", progress);
                    });
                    if (apk.length() != size || !matches(apk, sha256)) {
                        apk.delete();
                        throw new IOException("The downloaded file doesn't match the release");
                    }
                }
                // Old versions left behind.
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (!f.equals(apk)) f.delete();

                if (canInstall()) {
                    openInstaller(apk);
                    resolve(call, "started");
                } else {
                    // Ask once, in Android's settings; handleOnResume finishes the job when the user comes back.
                    synchronized (this) {
                        waiting = call;
                        waitingFile = apk;
                    }
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settings);
                }
            } catch (IOException | RuntimeException e) {
                busy.set(false);
                call.reject(e.getMessage() == null ? "Update failed" : e.getMessage(), "io", e);
            }
        });
    }

    @Override
    protected void handleOnResume() {
        PluginCall call;
        File apk;
        synchronized (this) {
            call = waiting;
            apk = waitingFile;
            waiting = null;
            waitingFile = null;
        }
        if (call == null) return;
        if (canInstall()) {
            try {
                openInstaller(apk);
                resolve(call, "started");
            } catch (RuntimeException e) {
                busy.set(false);
                call.reject(e.getMessage() == null ? "Update failed" : e.getMessage(), "io", e);
            }
        } else {
            resolve(call, "permission");
        }
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void openInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
    }

    private void resolve(PluginCall call, String status) {
        busy.set(false);
        JSObject result = new JSObject();
        result.put("status", status);
        call.resolve(result);
    }

    /** True when there is no checksum to compare with, or the file's SHA-256 is the one given. */
    static boolean matches(File file, String sha256) {
        if (!file.isFile()) return false;
        if (sha256 == null) return true;
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) digest.update(buffer, 0, n);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format("%02x", b));
            return hex.toString().equals(sha256);
        } catch (IOException | NoSuchAlgorithmException e) {
            return false;
        }
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
    }
}
