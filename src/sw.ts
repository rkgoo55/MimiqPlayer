/// <reference lib="webworker" />
/**
 * Custom Service Worker — precaching + COOP/COEP header injection
 *
 * GitHub Pages does not support custom HTTP response headers, so COOP/COEP
 * (required for SharedArrayBuffer / ONNX Runtime Web) must be injected here.
 *
 * Uses the standard Cache API instead of Workbox runtime helpers to avoid
 * API-version mismatches. vite-plugin-pwa still injects self.__WB_MANIFEST
 * at build time — we just read the URL list from it.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

const MANIFEST = self.__WB_MANIFEST ?? [];
const CACHE_NAME = 'precache';

function toUrl(entry: (typeof MANIFEST)[number]): string {
  return typeof entry === 'string' ? entry : entry.url;
}

// ─── Install: populate precache ──────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Build a set of URLs that belong to the new manifest
      const urls = MANIFEST.map(toUrl);
      await cache.addAll(urls);
      await self.skipWaiting();
    }),
  );
});

// ─── Activate: clean old caches & claim clients ─────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete every cache that isn't ours (old precache revisions, etc.)
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && !k.startsWith('demucs-'))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ─── COOP/COEP header injection ──────────────────────────────────────────────

function withHeaders(response: Response): Response {
  // Can't modify opaque responses
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── Fetch: cache-first for app shell, network for the rest ─────────────────

self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return withHeaders(cached);

      try {
        return withHeaders(await fetch(event.request));
      } catch {
        return new Response('Offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })(),
  );
});
