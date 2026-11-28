package app.musike.android;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves YouTube's audio streams at the app's own address (https://localhost/_musike_stream?u=…), for the equalizer:
 * Web Audio silences sound that comes from another site, and YouTube's stream servers don't allow the app's origin.
 * Requests, Range included, are passed through as they are; only googlevideo.com streams are fetched.
 */
final class MusikeStreamProxy {

    static final String PATH = "/_musike_stream";

    private MusikeStreamProxy() {}

    /** The response for `request` if it is a stream request, or null to let the app's usual handling take it. */
    static WebResourceResponse intercept(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!PATH.equals(uri.getPath()) || !"localhost".equals(uri.getHost())) return null;
        String target = uri.getQueryParameter("u");
        if (!allowed(target)) return error(400, "Bad Request");

        return fetch(target, request.getRequestHeaders());
    }

    /** Fetches `target` with the request's Range and User-Agent and hands the answer back as it came. */
    static WebResourceResponse fetch(String target, Map<String, String> asked) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            String range = header(asked, "Range");
            if (range != null) connection.setRequestProperty("Range", range);
            String agent = header(asked, "User-Agent");
            if (agent != null) connection.setRequestProperty("User-Agent", agent);

            int status = connection.getResponseCode();
            Map<String, String> headers = new HashMap<>();
            for (String name : new String[] { "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified" }) {
                String value = connection.getHeaderField(name);
                if (value != null) headers.put(name, value);
            }
            headers.put("Cache-Control", "no-store");
            String mime = connection.getContentType();
            if (mime == null) mime = "audio/mp4";
            int semicolon = mime.indexOf(';');
            if (semicolon >= 0) mime = mime.substring(0, semicolon).trim();
            InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            // The connection closes with the stream, once the web view has read it.
            return new WebResourceResponse(mime, null, status, reason(status, connection.getResponseMessage()), headers, body);
        } catch (IOException | RuntimeException e) {
            if (connection != null) connection.disconnect();
            return error(502, "Bad Gateway");
        }
    }

    /** Only YouTube's stream servers, over HTTPS. */
    static boolean allowed(String target) {
        if (target == null) return false;
        try {
            URL url = new URL(target);
            String host = url.getHost();
            return "https".equals(url.getProtocol()) && host != null && (host.endsWith(".googlevideo.com") || host.equals("googlevideo.com"));
        } catch (IOException e) {
            return false;
        }
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    /** WebResourceResponse refuses an empty reason phrase. */
    static String reason(int status, String given) {
        if (given != null && !given.trim().isEmpty()) return given;
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 416: return "Range Not Satisfiable";
            default: return status >= 500 ? "Server Error" : "Status " + status;
        }
    }

    private static WebResourceResponse error(int status, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }
}
