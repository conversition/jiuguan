package com.jiuguan.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** P10-12 真机门禁：opaque srcdoc 子 frame 调用唯一注册插件必须失败。 */
@RunWith(AndroidJUnit4.class)
public class BridgeIsolationInstrumentedTest {
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
            script, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView evaluateJavascript timed out", latch.await(5, TimeUnit.SECONDS));
        return result.get();
    }

    private String awaitValue(
        ActivityScenario<MainActivity> scenario,
        String script,
        String... accepted
    ) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 10_000;
        String latest = null;
        while (SystemClock.uptimeMillis() < deadline) {
            latest = evaluate(scenario, script);
            for (String expected : accepted) {
                if (expected.equals(latest)) return latest;
            }
            SystemClock.sleep(100);
        }
        return latest;
    }

    @Test public void opaqueSubframeCannotInvokeNativePlugin() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals("true", awaitValue(scenario,
                "Boolean(document.body&&window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.JiuguanNative)",
                "true"));

            evaluate(scenario,
                "window.__p10MainFrameBridge='pending';"
                + "Capacitor.Plugins.JiuguanNative.securityState()"
                + ".then(()=>window.__p10MainFrameBridge='ready')"
                + ".catch(()=>window.__p10MainFrameBridge='failed')");
            assertEquals("\"ready\"", awaitValue(scenario,
                "window.__p10MainFrameBridge", "\"ready\"", "\"failed\""));

            evaluate(scenario,
                "window.__p10SubframeBridge='pending';"
                + "addEventListener('message',e=>{if(e.data==='native-success')window.__p10SubframeBridge='breach';"
                + "else if(e.data==='native-denied')window.__p10SubframeBridge='denied'});"
                + "const f=document.createElement('iframe');"
                + "f.setAttribute('sandbox','allow-scripts');"
                + "f.srcdoc=`<script>const names=['JiuguanNative'];"
                + "Promise.all(names.map(name=>{const p=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins[name];"
                + "if(!p||typeof p.securityState!=='function')return false;"
                + "return p.securityState().then(()=>true,()=>false)}))"
                + ".then(results=>parent.postMessage(results.some(Boolean)?'native-success':'native-denied','*'));<\\/script>`;"
                + "document.body.appendChild(f);"
                + "setTimeout(()=>{if(window.__p10SubframeBridge==='pending')window.__p10SubframeBridge='blocked'},1500);");
            String result = awaitValue(scenario, "window.__p10SubframeBridge",
                "\"blocked\"", "\"denied\"", "\"breach\"");
            assertTrue("opaque child frame unexpectedly reached JiuguanNative",
                "\"blocked\"".equals(result) || "\"denied\"".equals(result));
        }
    }
}
