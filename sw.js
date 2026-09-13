const CN       = 'alberto-v3';       // caché de datos/red
const SHELL_CN = 'alberto-shell-v3'; // caché del app shell

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

// Terceros imprescindibles para que la app se vea igual sin red. Si alguno
// falla no pasa nada: se guarda en el primer uso con conexión.
const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];

// ── Install: pre-cachear app shell ──
// fetch con {cache:'reload'} en vez de cache.add() para forzar que cada asset
// (sobre todo index.html) venga de red de verdad y no se cuele una copia vieja
// desde la caché HTTP del navegador.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CN);
    await Promise.allSettled(SHELL_ASSETS.map(url =>
      fetch(url, { cache: 'reload' })
        .then(res => { if (res.ok) return shell.put(url, res); })
        .catch(err => console.warn('SW shell miss:', url, err))
    ));
    const externos = await caches.open(CN);
    await Promise.allSettled(CDN_ASSETS.map(url =>
      fetch(url, { mode: 'cors' })
        .then(res => { if (res.ok) return externos.put(url, res); })
        .catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

// ── Activate: limpiar cachés viejas y activar navigation preload ──
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CN && k !== SHELL_CN).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (err) {}
    }
    await clients.claim();
  })());
});

// ── Fetch: estrategia según tipo de recurso ──
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Firestore/Auth tienen su propia persistencia en IndexedDB: no tocar.
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com')
  ) return;

  // CDNs (SDK de Firebase, fuentes, qrcode): stale-while-revalidate.
  // Responde al instante desde caché y refresca por detrás: offline se ve
  // igual que online, y online no se queda con versiones viejas.
  if (
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const red = fetch(req).then(res => {
        if (res.ok) caches.open(CN).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => null);
      return cached || (await red) || new Response('', { status: 504 });
    })());
    return;
  }

  // Navegación HTML: network-first con preload y caída a la caché del shell.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith((async () => {
      try {
        const preload = await e.preloadResponse;
        const res = preload || await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(SHELL_CN);
          c.put('/Alberto/index.html', res.clone());
        }
        return res;
      } catch (err) {
        return (await caches.match(req)) ||
               (await caches.match('/Alberto/index.html')) ||
               new Response('<h1>Sin conexion</h1>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Imágenes (Cloudinary y demás): cache-first, se guardan al vuelo.
  if (req.destination === 'image') {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(CN); c.put(req, res.clone()); }
        return res;
      } catch (err) {
        return cached || new Response('', { status: 404 });
      }
    })());
    return;
  }

  // Resto del mismo origen: network-first con caída a caché.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) caches.open(CN).then(c => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ══════════════════════════════════════════════════════════════
// COLA DE SUBIDA DE IMÁGENES EN SEGUNDO PLANO
// Las fotos hechas sin cobertura se guardan en IndexedDB ('alberto_cola',
// almacén 'imagenes'). Aquí se suben a Cloudinary cuando vuelve la red,
// aunque la app esté cerrada, gracias a Background Sync.
// El service worker NO toca Firestore: solo sube y anota la URL definitiva
// en el propio registro. La app la aplica al documento al abrirse.
// ══════════════════════════════════════════════════════════════
const COLA_DB = 'alberto_cola';
const COLA_STORE = 'imagenes';

const abrirColaDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(COLA_DB, 1);
  r.onupgradeneeded = () => {
    if (!r.result.objectStoreNames.contains(COLA_STORE)) {
      r.result.createObjectStore(COLA_STORE, { keyPath: 'id' });
    }
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const colaLeerPendientes = async () => {
  const db = await abrirColaDB();
  return new Promise(res => {
    const out = [];
    const tx = db.transaction(COLA_STORE, 'readonly').objectStore(COLA_STORE).openCursor();
    tx.onsuccess = ev => {
      const cur = ev.target.result;
      if (!cur) return res(out);
      if (cur.value && cur.value.estado === 'pendiente') out.push(cur.value);
      cur.continue();
    };
    tx.onerror = () => res(out);
  });
};

const colaGuardar = async (registro) => {
  const db = await abrirColaDB();
  return new Promise(res => {
    const tx = db.transaction(COLA_STORE, 'readwrite');
    tx.objectStore(COLA_STORE).put(registro);
    tx.oncomplete = () => res(true);
    tx.onerror = () => res(false);
  });
};

const procesarColaImagenes = async () => {
  const pendientes = await colaLeerPendientes();
  if (!pendientes.length) return;
  let subidas = 0;
  let ultimoError = null;
  for (const reg of pendientes) {
    if (!reg.blob || !reg.cloud || !reg.preset) continue;
    try {
      const fd = new FormData();
      fd.append('file', reg.blob, 'foto.jpg');
      fd.append('upload_preset', reg.preset);
      fd.append('folder', reg.folder || 'grupos');
      const resp = await fetch(`https://api.cloudinary.com/v1_1/${reg.cloud}/image/upload`, { method: 'POST', body: fd });
      if (!resp.ok) throw new Error('Cloudinary ' + resp.status);
      const data = await resp.json();
      // Queda 'subida': la app la aplicará al documento de Firestore al abrirse.
      await colaGuardar({ ...reg, estado: 'subida', url: data.secure_url, publicId: data.public_id, blob: null, subidoEn: Date.now() });
      subidas++;
    } catch (err) {
      const intentos = (reg.intentos || 0) + 1;
      // Tras 8 intentos se aparca; se reintenta al abrir la app.
      await colaGuardar({ ...reg, intentos, estado: intentos >= 8 ? 'fallida' : 'pendiente' });
      ultimoError = err;
    }
  }
  if (subidas) {
    const cs = await clients.matchAll({ includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'IMAGENES_SUBIDAS', n: subidas }));
  }
  // Si algo falló, propagamos para que Background Sync lo reprograme solo.
  if (ultimoError) throw ultimoError;
};

self.addEventListener('sync', e => {
  if (e.tag === 'subir-imagenes') e.waitUntil(procesarColaImagenes());
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'subir-imagenes') e.waitUntil(procesarColaImagenes().catch(() => {}));
});

// ── Control externo desde la app ──
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'PROCESAR_COLA') e.waitUntil(procesarColaImagenes().catch(() => {}));
});
