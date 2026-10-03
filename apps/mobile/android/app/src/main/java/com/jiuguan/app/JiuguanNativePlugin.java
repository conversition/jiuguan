package com.jiuguan.app;

import android.content.Intent;
import android.app.Activity;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.Collections;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

@CapacitorPlugin(name = "JiuguanNative")
public final class JiuguanNativePlugin extends Plugin {
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final Pattern TOKEN = Pattern.compile("^jg1_[a-f0-9]{24}_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$");
    private static final Set<String> FORBIDDEN_HEADERS = new HashSet<>(Arrays.asList(
        "authorization", "cookie", "origin", "host", "x-forwarded-host", "x-forwarded-proto"));
    private CredentialVault vault;
    private URI endpoint;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Set<String> activeDownloads = Collections.synchronizedSet(new HashSet<>());
    private static final Pattern DOWNLOAD_OPERATION = Pattern.compile("^fdl_[A-Za-z0-9_-]{16,80}$");
    private static final Pattern ASSET_ID = Pattern.compile("^[a-f0-9]{24}$");
    private static final Pattern SAFE_FILENAME = Pattern.compile("^[^\\\\/\\x00-\\x1f\\x7f]{1,240}$");

    @Override public void load() {
        vault = new CredentialVault(getContext());
        endpoint = exactHttpsOrigin(BuildConfig.JG_PINNED_ENDPOINT);
        connectivityManager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager != null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(android.net.Network network) { emitNetworkState(); }
                @Override public void onLost(android.net.Network network) { emitNetworkState(); }
                @Override public void onCapabilitiesChanged(android.net.Network network, NetworkCapabilities caps) { emitNetworkState(); }
            };
            connectivityManager.registerNetworkCallback(
                new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                networkCallback);
        }
    }

    @PluginMethod public void request(PluginCall call) {
        try {
            String path = safePath(call.getString("path", ""));
            String method = safeMethod(call.getString("method", "GET"));
            JSObject headers = call.getObject("headers", new JSObject());
            String body = call.getString("body", null);
            boolean authenticated = Boolean.TRUE.equals(call.getBoolean("authenticated", false));
            boolean base64 = "base64".equals(call.getString("responseType", "text"));
            call.resolve(execute(path, method, headers, body, authenticated, base64));
        } catch (Exception error) {
            call.reject("native-request-failed: " + publicMessage(error));
        }
    }

    /** 配对响应中的 accessToken 在原生层消费并立即移除，永不返回 WebView。 */
    @PluginMethod public void pair(PluginCall call) {
        try {
            JSObject input = call.getObject("request");
            if (input == null) throw new SecurityException("pair-request-missing");
            JSONObject payload = new JSONObject(input.toString());
            payload.put("transport", "bearer");
            JSONObject device = payload.optJSONObject("device");
            if (device == null) throw new SecurityException("pair-device-missing");
            device.put("platform", "android");
            JSObject headers = new JSObject();
            headers.put("content-type", "application/json");
            JSObject response = execute("/api/auth/pair", "POST", headers, payload.toString(), false, false);
            int status = response.getInteger("status", 500);
            if (status < 200 || status >= 300) {
                JSObject out = new JSObject();
                out.put("status", status);
                out.put("body", response.getString("body", ""));
                call.reject("pair-rejected", (String) null, out);
                return;
            }
            JSONObject result = new JSONObject(response.getString("body", ""));
            String token = result.optString("accessToken", "");
            if (!"bearer".equals(result.optString("transport")) || !TOKEN.matcher(token).matches()) {
                throw new SecurityException("pair-response-invalid");
            }
            vault.put(token);
            result.remove("accessToken");
            JSObject out = new JSObject();
            out.put("paired", true);
            out.put("session", result.optJSONObject("session"));
            call.resolve(out);
        } catch (Exception error) {
            call.reject("native-pair-failed: " + publicMessage(error));
        }
    }

    @PluginMethod public void clearCredential(PluginCall call) {
        vault.clear();
        call.resolve();
    }

    @PluginMethod public void securityState(PluginCall call) {
        JSObject out = new JSObject();
        out.put("appOrigin", BuildConfig.JG_CAPACITOR_APP_ORIGIN);
        out.put("endpoint", BuildConfig.JG_PINNED_ENDPOINT);
        out.put("mainFrameBridgeRequired", true);
        call.resolve(out);
    }

    @PluginMethod public void shareText(PluginCall call) {
        String text = call.getString("text", "");
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, text);
        getActivity().startActivity(Intent.createChooser(intent, call.getString("title", "分享")));
        call.resolve();
    }

    @PluginMethod public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "*/*"));
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) { call.resolve(); return; }
        try {
            Uri uri = result.getData().getData();
            byte[] bytes;
            try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
                bytes = readBoundedBytes(stream, 32 * 1024 * 1024);
            }
            JSObject out = new JSObject();
            out.put("name", displayName(uri));
            out.put("mime", getContext().getContentResolver().getType(uri));
            out.put("size", bytes.length);
            out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(out);
        } catch (Exception error) { call.reject("file-pick-failed: " + publicMessage(error)); }
    }

    @PluginMethod public void saveFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "jiuguan-export.bin"));
        startActivityForResult(call, intent, "saveFileResult");
    }

    @ActivityCallback private void saveFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) { call.resolve(); return; }
        try {
            byte[] bytes = Base64.decode(call.getString("base64", ""), Base64.DEFAULT);
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) {
                if (stream == null) throw new IllegalStateException("output-stream-unavailable");
                stream.write(bytes);
            }
            JSObject out = new JSObject(); out.put("saved", true); call.resolve(out);
        } catch (Exception error) { call.reject("file-save-failed: " + publicMessage(error)); }
    }

    /** P8-06/P10-04：JS 只提交稳定资产身份；capability、Bearer 和文件字节始终留在原生层。 */
    @PluginMethod public void startAssetDownload(PluginCall call) {
        String operationId = call.getString("operationId", "");
        String assetId = call.getString("assetId", "");
        String format = call.getString("format", "");
        String destination = call.getString("destination", "");
        if (!DOWNLOAD_OPERATION.matcher(operationId).matches() || !ASSET_ID.matcher(assetId).matches()
            || !("json".equals(format) || "png".equals(format)) || !"save".equals(destination)
            || !activeDownloads.add(operationId)) {
            call.reject("native-download-request-invalid");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("png".equals(format) ? "image/png" : "application/json");
        intent.putExtra(Intent.EXTRA_TITLE, "jiuguan-" + assetId + "." + format);
        startActivityForResult(call, intent, "assetDownloadDestinationResult");
    }

    @PluginMethod public void cancelAssetDownload(PluginCall call) {
        String operationId = call.getString("operationId", "");
        if (activeDownloads.remove(operationId)) emitDownloadTerminal(operationId, "cancelled", null, 0);
        call.resolve();
    }

    @ActivityCallback private void assetDownloadDestinationResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        String operationId = call.getString("operationId", "");
        if (!activeDownloads.contains(operationId)) { call.resolve(); return; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            activeDownloads.remove(operationId);
            emitDownloadTerminal(operationId, "cancelled", null, 0);
            call.resolve();
            return;
        }
        Uri destination = result.getData().getData();
        try {
            String assetId = call.getString("assetId", "");
            String format = call.getString("format", "");
            JSObject headers = new JSObject(); headers.put("content-type", "application/json");
            JSONObject request = new JSONObject(); request.put("assetId", assetId); request.put("format", format);
            JSObject issued = execute("/api/assets/download-capabilities", "POST", headers, request.toString(), true, false);
            if (issued.getInteger("status", 500) == 401) throw new SecurityException("credential-unavailable");
            if (issued.getInteger("status", 500) < 200 || issued.getInteger("status", 500) >= 300) {
                throw new SecurityException("response-invalid");
            }
            JSONObject grant = new JSONObject(issued.getString("body", "{}")).optJSONObject("download");
            if (grant == null || !assetId.equals(grant.optString("assetId")) || !format.equals(grant.optString("format"))) {
                throw new SecurityException("response-invalid");
            }
            String capability = grant.optString("capability", "");
            String filename = grant.optString("filename", "");
            String mediaType = grant.optString("mediaType", "");
            long expectedBytes = grant.optLong("bytes", -1);
            String expectedMedia = "png".equals(format) ? "image/png" : "application/json";
            if (capability.isEmpty() || !SAFE_FILENAME.matcher(filename).matches()
                || !expectedMedia.equals(mediaType) || expectedBytes < 1) throw new SecurityException("response-invalid");
            String path = "/api/assets/download/" + assetId + "/" + format + "?cap="
                + URLEncoder.encode(capability, "UTF-8");
            emitDownloadProgress(operationId, "issuing", 0, expectedBytes);
            emitDownloadProgress(operationId, "downloading", 0, expectedBytes);
            long written = streamDownloadToUri(operationId, path, destination, expectedBytes, mediaType);
            if (!activeDownloads.remove(operationId)) { call.resolve(); return; }
            JSObject event = new JSObject();
            event.put("type", "completed"); event.put("operationId", operationId);
            event.put("filename", filename); event.put("mediaType", mediaType); event.put("bytes", written);
            notifyListeners("assetDownloadEvent", event, true);
            call.resolve();
        } catch (Exception error) {
            boolean wasActive = activeDownloads.remove(operationId);
            try { getContext().getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
            if (wasActive) {
                String code = "credential-unavailable".equals(error.getMessage())
                    ? "credential-unavailable"
                    : (error instanceof SecurityException ? "response-invalid" : "network-error");
                emitDownloadTerminal(operationId, "failed", code, 0);
            }
            call.resolve();
        }
    }

    @PluginMethod public void networkState(PluginCall call) { call.resolve(currentNetworkState()); }

    @PluginMethod public void exitToBackground(PluginCall call) {
        getActivity().moveTaskToBack(true);
        call.resolve();
    }

    @Override protected void handleOnResume() {
        JSObject out = new JSObject(); out.put("isActive", true); notifyListeners("appStateChange", out, true);
        notifyListeners("networkStatusChange", currentNetworkState(), true);
    }

    @Override protected void handleOnPause() {
        JSObject out = new JSObject(); out.put("isActive", false); notifyListeners("appStateChange", out, true);
    }

    @Override protected void handleOnDestroy() {
        if (connectivityManager != null && networkCallback != null) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
        activeDownloads.clear();
    }

    void emitBack(boolean canGoBack) {
        JSObject out = new JSObject(); out.put("canGoBack", canGoBack); notifyListeners("backButton", out);
    }

    /** 仅 bundled origin 留在 WebView；HTTP(S) 外链交给系统浏览器，其它 scheme 拒绝。 */
    @Override public Boolean shouldOverrideLoad(Uri uri) {
        String origin = uri.getScheme() + "://" + uri.getHost()
            + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        if (BuildConfig.JG_CAPACITOR_APP_ORIGIN.equals(origin)) return false;
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
        }
        return true;
    }

    private JSObject execute(String path, String method, JSObject headers, String body, boolean authenticated, boolean base64) throws Exception {
        URL target = endpoint.resolve(path).toURL();
        if (!target.getProtocol().equals("https") || !target.getHost().equalsIgnoreCase(endpoint.getHost())
            || target.getPort() != endpoint.toURL().getPort()) throw new SecurityException("endpoint-mismatch");
        HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestMethod(method);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (FORBIDDEN_HEADERS.contains(key.toLowerCase(Locale.ROOT))) throw new SecurityException("forbidden-header");
            connection.setRequestProperty(key, headers.optString(key, ""));
        }
        if (authenticated) {
            String token = vault.get();
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (body != null) {
            connection.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream stream = connection.getOutputStream()) { stream.write(bytes); }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] responseBytes = stream == null ? new byte[0]
            : readBoundedBytes(stream, base64 ? 32 * 1024 * 1024 : MAX_RESPONSE_BYTES);
        String responseBody = base64
            ? Base64.encodeToString(responseBytes, Base64.NO_WRAP)
            : new String(responseBytes, StandardCharsets.UTF_8);
        JSObject responseHeaders = new JSObject();
        copyHeader(connection, responseHeaders, "Content-Type");
        copyHeader(connection, responseHeaders, "Retry-After");
        copyHeader(connection, responseHeaders, "X-Request-Id");
        JSObject out = new JSObject();
        out.put("status", status);
        out.put("body", responseBody);
        out.put("bodyEncoding", base64 ? "base64" : "utf8");
        out.put("headers", responseHeaders);
        connection.disconnect();
        return out;
    }

    private long streamDownloadToUri(String operationId, String path, Uri destination, long expectedBytes, String mediaType) throws Exception {
        URL target = endpoint.resolve(safePath(path)).toURL();
        if (!target.getProtocol().equals("https") || !target.getHost().equalsIgnoreCase(endpoint.getHost())
            || target.getPort() != endpoint.toURL().getPort()) throw new SecurityException("endpoint-mismatch");
        HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", mediaType);
        try {
            if (connection.getResponseCode() != 200) throw new SecurityException("response-invalid");
            long declared = connection.getContentLengthLong();
            String actualMedia = connection.getContentType();
            if (declared != expectedBytes || actualMedia == null
                || !mediaType.equals(actualMedia.split(";", 2)[0].trim().toLowerCase(Locale.ROOT))) {
                throw new SecurityException("response-invalid");
            }
            try (InputStream input = connection.getInputStream();
                 OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("output-stream-unavailable");
                byte[] buffer = new byte[32 * 1024]; long written = 0; long lastReported = 0;
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (!activeDownloads.contains(operationId)) throw new SecurityException("download-cancelled");
                    written += count;
                    if (written > expectedBytes) throw new SecurityException("response-invalid");
                    output.write(buffer, 0, count);
                    if (written - lastReported >= 256 * 1024 || written == expectedBytes) {
                        emitDownloadProgress(operationId, "downloading", written, expectedBytes);
                        lastReported = written;
                    }
                }
                if (written != expectedBytes) throw new SecurityException("response-invalid");
                emitDownloadProgress(operationId, "saving", written, expectedBytes);
                return written;
            }
        } finally { connection.disconnect(); }
    }

    private void emitDownloadProgress(String operationId, String phase, long received, long total) {
        JSObject event = new JSObject(); event.put("type", "progress"); event.put("operationId", operationId);
        event.put("phase", phase); event.put("receivedBytes", received); event.put("totalBytes", total);
        notifyListeners("assetDownloadEvent", event, true);
    }

    private void emitDownloadTerminal(String operationId, String type, String code, long ignoredBytes) {
        JSObject event = new JSObject(); event.put("type", type); event.put("operationId", operationId);
        if (code != null) event.put("code", code);
        notifyListeners("assetDownloadEvent", event, true);
    }

    private void emitNetworkState() { notifyListeners("networkStatusChange", currentNetworkState(), true); }

    private static URI exactHttpsOrigin(String raw) {
        try {
            URI uri = URI.create(raw);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
                throw new SecurityException("endpoint-invalid");
            }
            return URI.create(uri.getScheme() + "://" + uri.getRawAuthority() + "/");
        } catch (Exception error) { throw new SecurityException("endpoint-invalid", error); }
    }

    private static String safePath(String path) {
        if (!(path.startsWith("/api/") || path.equals("/api") || path.startsWith("/ext/"))
            || path.startsWith("//") || path.contains("#")) throw new SecurityException("path-denied");
        return path;
    }

    private static String safeMethod(String raw) {
        String method = raw.toUpperCase(Locale.ROOT);
        if (!(method.equals("GET") || method.equals("HEAD") || method.equals("POST")
            || method.equals("PUT") || method.equals("PATCH") || method.equals("DELETE"))) {
            throw new SecurityException("method-denied");
        }
        return method;
    }

    private static byte[] readBoundedBytes(InputStream input, int limit) throws Exception {
        if (input == null) throw new IllegalStateException("input-stream-unavailable");
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int total = 0;
            for (int n; (n = stream.read(buffer)) != -1;) {
                total += n; if (total > limit) throw new SecurityException("file-too-large");
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        return "selected-file";
    }

    private JSObject currentNetworkState() {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities caps = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
        boolean connected = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        JSObject out = new JSObject(); out.put("connected", connected); return out;
    }

    private static void copyHeader(HttpURLConnection from, JSObject to, String name) {
        String value = from.getHeaderField(name);
        if (value != null) to.put(name, value);
    }

    private static String publicMessage(Exception error) {
        return error instanceof SecurityException ? error.getMessage() : error.getClass().getSimpleName();
    }
}
