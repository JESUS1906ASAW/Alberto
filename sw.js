const CN       = 'alberto-v1';       // versión de caché de datos/red
const SHELL_CN = 'alberto-shell-v1'; // versión de caché del app shell

// Assets del app shell que se pre-cachean en el install
const SHELL_ASSETS = [
  '/Alberto/',
  '/Alberto/index.html',
  '/Alberto/icon-192.png',
  '/Alberto/icon-512.png',
  '/Alberto/icon-192-maskable.png',
  '/Alberto/icon-512-maskable.png',
  '/Alberto/logo-splash.png',
  '/Alberto/manifest.json',
];

// ── Install: pre-cachear app shell ──
// Usamos fetch con {cache:'reload'} en vez de cache.add() para forzar que
// cada asset (sobre todo index.html) se traiga de red de verdad, sin colarse
// una copia vieja desde la caché HTTP del navegador. Así cada vez que se
// instala una versión nueva del SW, el HTML/JS del app shell queda realmente
// al día — evita servir una versión anterior offline.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CN).then(cache =>
      Promise.allSettled(
        SHELL_ASSETS.map(url =>
          fetch(url, { cache: 'reload' })
            .then(res => { if (res.ok) return cache.put(url, res); })
            .catch(err => console.warn('SW cache miss:', url, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: limpiar cachés viejas ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CN && k !== SHELL_CN)
          .map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});

// ── Fetch: estrategia según tipo de recurso ──
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo interceptar GET
  if (req.method !== 'GET') return;

  // Nunca interceptar requests de Firestore/Auth (tienen su propia caché IndexedDB)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com')
  ) return;

  // Firebase SDK / CDNs externos (gstatic, cdnjs, fonts): Cache-first
  if (
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) caches.open(CN).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Navegación HTML (index.html): Network-first con fallback a caché
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(SHELL_CN).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() =>
          caches.match(req).then(r => r || caches.match('/Alberto/index.html'))
        )
    );
    return;
  }

  // Imágenes externas (Cloudinary, etc.): Cache-first
  if (req.destination === 'image') {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) caches.open(CN).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => cached || new Response('', { status: 404 }));
      })
    );
    return;
  }

  // Resto (mismo origen): Network-first con fallback a caché
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) caches.open(CN).then(c => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ── Control externo: SKIP_WAITING (para actualizaciones desde la app) ──
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
