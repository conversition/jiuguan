(() => {
  'use strict';
  const cap = globalThis.Capacitor;
  const plugin = cap && cap.Plugins && cap.Plugins.JiuguanNative;
  if (!plugin) {
    Object.defineProperty(globalThis, '__JG_PLATFORM_BRIDGE_ERROR__', {
      value: 'JiuguanNative plugin unavailable', configurable: false, writable: false,
    });
    return;
  }

  const cleanHeaders = (headers) => {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(headers || {})) out[String(key)] = String(value);
    return out;
  };
  const assetDownloadListeners = new Set();
  let assetDownloadSubscription;
  const ensureAssetDownloadSubscription = () => {
    if (assetDownloadSubscription) return;
    assetDownloadSubscription = Promise.resolve(plugin.addListener('assetDownloadEvent', (event) => {
      for (const listener of assetDownloadListeners) listener(event);
    }));
  };
  const bridge = Object.freeze({
    profile: 'android-bundled',
    request: (input) => plugin.request({
      path: String(input.path || ''),
      method: String(input.method || 'GET'),
      headers: cleanHeaders(input.headers),
      body: typeof input.body === 'string' ? input.body : undefined,
      authenticated: input.authenticated === true,
      responseType: input.responseType === 'base64' ? 'base64' : 'text',
    }),
    pair: (request) => plugin.pair({ request }),
    clearCredential: () => plugin.clearCredential(),
    shareText: (input) => plugin.shareText(input),
    pickFile: (input) => plugin.pickFile(input),
    saveFile: (input) => plugin.saveFile(input),
    startAssetDownload: (input) => plugin.startAssetDownload(input).then(() => undefined),
    cancelAssetDownload: (operationId) => plugin.cancelAssetDownload({ operationId }).then(() => undefined),
    subscribeAssetDownload: (listener) => {
      assetDownloadListeners.add(listener);
      ensureAssetDownloadSubscription();
      return () => { assetDownloadListeners.delete(listener); };
    },
    networkState: () => plugin.networkState(),
    exitToBackground: () => plugin.exitToBackground(),
    addListener: (eventName, listener) => plugin.addListener(eventName, listener),
  });
  Object.defineProperty(globalThis, '__JG_PLATFORM_BRIDGE__', {
    value: bridge, configurable: false, writable: false,
  });
})();
