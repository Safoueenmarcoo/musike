package app.musike.android;

import android.content.Context;
import android.os.PowerManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.json.JSONException;

/**
 * Songs saved for offline listening (web/src/native/downloads.ts): downloads a stream or a cover into the app's own
 * storage and reports the progress. The files live in the app's no-backup folder: they can always be downloaded
 * again, and would otherwise use up the little space Android's automatic backup gives the library.
 */
@CapacitorPlugin(name = "MusikeDownloads")
public class MusikeDownloadsPlugin extends Plugin {

    /** The only names accepted: `<video id>.m4a` or `.webm` (audio) and `.jpg` (cover). Nothing reaches outside the folder. */
    private static final Pattern OWN_FILE = Pattern.compile("^[A-Za-z0-9_-]{11}\\.(m4a|webm|jpg)$");
    private static final long PROGRESS_EVERY_MS = 200;
    private static final long AWAKE_MS = 15 * 60 * 1000L;

    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    /** Downloads under way, by the id the app gave them, each with its cancel flag. */
    private final Map<String, AtomicBoolean> running = new ConcurrentHashMap<>();
    private PowerManager.WakeLock wakeLock;

    @Override
    public void load() {
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Musike:downloads");
        wakeLock.setReferenceCounted(false);
    }

    private File folder() {
        File dir = new File(getContext().getNoBackupFilesDir(), "downloads");
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    /** Where the files are, so the app can play them through the web view's local file addresses. */
    @PluginMethod
    public void folder(PluginCall call) {
        JSObject result = new JSObject();
        result.put("path", folder().getAbsolutePath());
        call.resolve(result);
    }

    /** The files kept, with their sizes. What an interrupted download left behind is cleared on the way. */
    @PluginMethod
    public void files(PluginCall call) {
        JSArray list = new JSArray();
        File[] found = folder().listFiles();
        if (found != null) {
            for (File file : found) {
                String name = file.getName();
                if (name.endsWith(".part")) {
                    if (running.isEmpty()) file.delete();
                } else if (file.isFile() && OWN_FILE.matcher(name).matches()) {
                    JSObject entry = new JSObject();
                    entry.put("name", name);
                    entry.put("size", file.length());
                    list.put(entry);
                }
            }
        }
        JSObject result = new JSObject();
        result.put("files", list);
        call.resolve(result);
    }

    /**
     * Downloads `url` into the folder as `name` and resolves with its size. Progress comes as "progress" events
     * carrying the same `id`; cancel({ id }) stops it (the call then rejects with the code "cancelled").
     */
    @PluginMethod
    public void save(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String name = call.getString("name");
        if (id == null || url == null || name == null || !url.startsWith("https://") || !OWN_FILE.matcher(name).matches()) {
            call.reject("Invalid download request", "invalid");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        JSObject given = call.getObject("headers");
        if (given != null) {
            for (Iterator<String> keys = given.keys(); keys.hasNext();) {
                String key = keys.next();
                String value = given.getString(key);
                if (value != null) headers.put(key, value);
            }
        }
        AtomicBoolean cancelled = new AtomicBoolean(false);
        if (running.putIfAbsent(id, cancelled) != null) {
            call.reject("Already downloading", "busy");
            return;
        }
        File target = new File(folder(), name);
        stayAwake();

        // Plugin calls share one thread: the download runs on its own so playback updates aren't held up.
        pool.execute(() -> {
            long[] lastEvent = { 0 };
            try {
                long size = RangedDownload.fetch(url, headers, target, cancelled, (received, total) -> {
                    long now = System.currentTimeMillis();
                    if (now - lastEvent[0] < PROGRESS_EVERY_MS && received != total) return;
                    lastEvent[0] = now;
                    JSObject progress = new JSObject();
                    progress.put("id", id);
                    progress.put("received", received);
                    progress.put("total", total);
                    notifyListeners("progress", progress);
                });
                JSObject result = new JSObject();
                result.put("size", size);
                call.resolve(result);
            } catch (RangedDownload.CancelledException e) {
                call.reject("Cancelled", "cancelled");
            } catch (RangedDownload.HttpStatusException e) {
                call.reject(e.getMessage(), "http_" + e.status);
            } catch (IOException | RuntimeException e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage(), "io", e);
            } finally {
                running.remove(id);
                sleepIfIdle();
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        AtomicBoolean flag = id == null ? null : running.get(id);
        if (flag != null) flag.set(true);
        call.resolve();
    }

    /** Deletes the files named in `names`. */
    @PluginMethod
    public void discard(PluginCall call) {
        JSArray names = call.getArray("names");
        File dir = folder();
        for (int i = 0; names != null && i < names.length(); i++) {
            try {
                String name = names.getString(i);
                if (OWN_FILE.matcher(name).matches()) new File(dir, name).delete();
            } catch (JSONException e) {
                // not a name: nothing to delete
            }
        }
        call.resolve();
    }

    // The phone may doze off with the screen dark; downloads keep the processor awake until the last one ends.

    private synchronized void stayAwake() {
        // Each new download pushes the limit back, so a long list is covered song by song.
        wakeLock.acquire(AWAKE_MS);
    }

    private synchronized void sleepIfIdle() {
        if (running.isEmpty() && wakeLock.isHeld()) wakeLock.release();
    }

    @Override
    protected void handleOnDestroy() {
        for (AtomicBoolean flag : running.values()) flag.set(true);
        pool.shutdownNow();
        synchronized (this) {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
    }
}
