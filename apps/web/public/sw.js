/*
 * P9-03：jiuguan PWA Service Worker——**有界缓存**，隐私边界不可回退：
 * - 绝不缓存 /api/*、/ext/*、/health（认证、会话正文、资产内容都不进 Cache Storage）；
 * - 只对同源指纹静态资产（/assets/*，文件名带 hash）做 cache-first；
 * - 导航请求 network-first，离线只返回不含业务数据的说明页；
 * - 不在 install 中主动 skipWaiting；只接受 P9-04 UI 显式确认后发来的精确消息；
 * - 缓存桶版本化，activate 时清除全部旧桶。
 */
const CACHE_NAME = 'jiuguan-shell-v1';
const OFFLINE_URL = '/offline.html';
const NEVER_CACHE_PREFIXES = ['/api/', '/ext/', '/health'];
const ASSET_CACHE_PREFIX = '/assets/';
const FINGERPRINTED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(OFFLINE_URL).catch(() => { /* 离线说明拉取失败不阻塞安装 */ });
  })());
});

self.addEventListener('message', (event) => {
  // 生成状态与用户确认由页面双重门控；SW 只接受唯一、无参数的激活指令。
  if (event.data && event.data.type === 'JG_ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isNeverCache(url) {
  return NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;       // 跨源（上游/端点）一律直接放行
  if (isNeverCache(url)) return;                          // 私有 API/插件网关绝不进 SW

  // 只有带内容 hash 的静态资产可以进入 Cache Storage。
  if (url.pathname.startsWith(ASSET_CACHE_PREFIX) && FINGERPRINTED_ASSET.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })());
    return;
  }

  // 导航只做 network-first；离线时返回独立说明，不回放可能过期的应用壳。
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(OFFLINE_URL))
        ?? new Response('电脑端酒馆当前不可达', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }));
  }
});
