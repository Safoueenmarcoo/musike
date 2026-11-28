package app.musike.android;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MusikePlaybackPlugin.class);
        registerPlugin(MusikeDevicePlugin.class);
        registerPlugin(MusikeDownloadsPlugin.class);
        registerPlugin(MusikeUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // YouTube streams at the app's own address, for the equalizer (MusikeStreamProxy); everything else as before.
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse stream = MusikeStreamProxy.intercept(request);
                return stream != null ? stream : super.shouldInterceptRequest(view, request);
            }
        });
        // Draw behind the status and navigation bars on every Android version; the page pads itself
        // (env(safe-area-inset-*)) and the SystemBars plugin keeps the icons readable for the theme.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
    }
}
