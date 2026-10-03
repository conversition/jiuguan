package com.jiuguan.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.widget.TextView;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(JiuguanNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** Capacitor 的 fallback 会使用 addJavascriptInterface；不支持主 frame 判定就拒绝启动。 */
    @Override protected void load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView blocked = new TextView(this);
            blocked.setText("系统 WebView 过旧，缺少安全主 frame 消息桥；请更新 Android System WebView。 ");
            blocked.setPadding(32, 64, 32, 32);
            setContentView(blocked);
            return;
        }
        super.load();
        String actual = bridge.getServerUrl();
        if (actual != null && actual.endsWith("/")) actual = actual.substring(0, actual.length() - 1);
        if (!BuildConfig.JG_CAPACITOR_APP_ORIGIN.equals(actual)) {
            throw new SecurityException("Capacitor app origin mismatch");
        }
        WebSettings settings = bridge.getWebView().getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    }

    @Override public void onBackPressed() {
        if (bridge == null || bridge.getWebView() == null) { super.onBackPressed(); return; }
        boolean canGoBack = bridge.getWebView().canGoBack();
        PluginHandle handle = bridge.getPlugin("JiuguanNative");
        if (handle != null && handle.getInstance() instanceof JiuguanNativePlugin) {
            ((JiuguanNativePlugin) handle.getInstance()).emitBack(canGoBack);
        }
        if (canGoBack) bridge.getWebView().goBack();
        else moveTaskToBack(true);
    }
}
