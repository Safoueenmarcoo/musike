package app.musike.android;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Saves a URL to a file, asking for it a few megabytes at a time (HTTP Range): YouTube slows down requests for a
 * whole stream at once, and a dropped connection then costs one piece instead of the whole song. Plain Java, no
 * Android classes, so it can be tested on any JVM.
 */
final class RangedDownload {

    /** How far the download is. `total` is 0 until the server says how big the file is. */
    interface Listener {
        void onProgress(long received, long total);
    }

    /** The server answered with something other than the bytes asked for. */
    static final class HttpStatusException extends IOException {

        final int status;

        HttpStatusException(int status) {
            super("HTTP " + status);
            this.status = status;
        }
    }

    /** The download was cancelled through its flag. */
    static final class CancelledException extends IOException {

        CancelledException() {
            super("Cancelled");
        }
    }

    /** yt-dlp reads YouTube streams in chunks of about this size too. */
    static final int CHUNK = 8 * 1024 * 1024;

    /** How many times in a row a broken connection is tried again without having gained a single byte. */
    private static final int RETRIES = 3;

    private static final Pattern RANGE_SIZE = Pattern.compile("/(\\d+)\\s*$");

    private RangedDownload() {}

    /**
     * Downloads `url` into `target` and returns its size. The bytes go to `target + ".part"` first and the file only
     * gets its real name once it is complete, so a half-downloaded song is never mistaken for a whole one.
     */
    static long fetch(String url, Map<String, String> headers, File target, AtomicBoolean cancelled, Listener listener) throws IOException {
        return fetch(url, headers, target, cancelled, listener, CHUNK);
    }

    static long fetch(String url, Map<String, String> headers, File target, AtomicBoolean cancelled, Listener listener, int chunk)
        throws IOException {
        File part = new File(target.getPath() + ".part");
        long received = 0;
        long total = 0;
        // A dropped connection is picked up where it stopped: the next request starts at the byte after the last one saved.
        int failures = 0;
        long failedAt = -1;
        try (RandomAccessFile out = new RandomAccessFile(part, "rw")) {
            out.setLength(0);
            byte[] buffer = new byte[64 * 1024];
            while (true) {
                if (cancelled.get()) throw new CancelledException();
                long last = (total > 0 ? Math.min(received + chunk, total) : received + chunk) - 1;
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                try {
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(30_000);
                    for (Map.Entry<String, String> header : headers.entrySet()) {
                        connection.setRequestProperty(header.getKey(), header.getValue());
                    }
                    // The bytes exactly as stored: a compressed transfer would change what a range means.
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    connection.setRequestProperty("Range", "bytes=" + received + "-" + last);

                    int status = connection.getResponseCode();
                    // Asked past the end of a file whose size wasn't known: everything is here.
                    if (status == 416 && received > 0) break;
                    if (status != 200 && status != 206) throw new HttpStatusException(status);

                    boolean whole = status == 200; // the server ignored Range and is sending the entire file
                    if (whole) {
                        out.setLength(0);
                        received = 0;
                        total = Math.max(0, connection.getContentLengthLong());
                    } else {
                        String range = connection.getHeaderField("Content-Range");
                        Matcher size = range == null ? null : RANGE_SIZE.matcher(range);
                        if (size != null && size.find()) total = Long.parseLong(size.group(1));
                    }

                    long before = received;
                    try (InputStream in = connection.getInputStream()) {
                        out.seek(received);
                        int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (cancelled.get()) throw new CancelledException();
                            out.write(buffer, 0, n);
                            received += n;
                            listener.onProgress(received, total);
                        }
                    }
                    if (whole || received == before) break;
                    if (total > 0 ? received >= total : received - before < chunk) break;
                } catch (CancelledException | HttpStatusException e) {
                    throw e;
                } catch (IOException e) {
                    if (received > failedAt) failures = 0;
                    failedAt = received;
                    if (++failures > RETRIES) throw e;
                    pause(400L * failures, cancelled);
                } finally {
                    connection.disconnect();
                }
            }
        } catch (IOException | RuntimeException e) {
            part.delete();
            throw e;
        }
        if (received == 0 || (total > 0 && received < total)) {
            part.delete();
            throw new IOException("The download stopped before the end");
        }
        if (target.exists() && !target.delete()) {
            part.delete();
            throw new IOException("Could not replace " + target.getName());
        }
        if (!part.renameTo(target)) {
            part.delete();
            throw new IOException("Could not save " + target.getName());
        }
        return received;
    }

    /** Waits before trying again, giving up at once if the download is cancelled meanwhile. */
    private static void pause(long millis, AtomicBoolean cancelled) throws CancelledException {
        long until = System.currentTimeMillis() + millis;
        while (System.currentTimeMillis() < until) {
            if (cancelled.get()) throw new CancelledException();
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new CancelledException();
            }
        }
    }
}
