// Service Worker de LapiStock.
//  - install:  precachea el «app shell» (HTML, JS, CSS, íconos) para abrir sin conexión.
//  - activate: borra cachés de versiones anteriores y toma control de las pestañas abiertas.
//  - update:   la versión nueva queda «en espera» hasta que el usuario pulse «Actualizar»
//              (mensaje SKIP_WAITING), así no se cambia el código en mitad de un registro.
//  - push / notificationclick: notificaciones push reales enviadas por el servidor.
const VERSION = '__VERSION__';
const CACHE_APP = `lapistock-app-${VERSION}`;
const CACHE_API = 'lapistock-api';
const PRECACHE = ['__PRECACHE__'];
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  const recursos = [...new Set([...SHELL, ...PRECACHE.filter((r) => r !== '__PRECACHE__')])];
  event.waitUntil(
    caches
      .open(CACHE_APP)
      .then((cache) => cache.addAll(recursos)),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.tipo === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((claves) => Promise.all(claves.filter((c) => c.startsWith('lapistock-app-') && c !== CACHE_APP).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(redPrimeroApi(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(navegacion(request));
  } else {
    event.respondWith(cachePrimero(request));
  }
});

async function redPrimeroApi(request) {
  const cache = await caches.open(CACHE_API);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const guardada = await cache.match(request);
    if (guardada) return guardada;
    return new Response(JSON.stringify({ error: 'Sin conexión y sin copia en caché' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function navegacion(request) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_APP);
    cache.put('/index.html', res.clone());
    return res;
  } catch {
    return (await caches.match('/index.html')) ?? (await caches.match('/')) ?? Response.error();
  }
}

async function cachePrimero(request) {
  const guardada = await caches.match(request);
  if (guardada) return guardada;
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(CACHE_APP)).put(request, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

/* ───── Notificaciones push ───── */

self.addEventListener('push', (event) => {
  let datos = {};
  try {
    datos = event.data?.json() ?? {};
  } catch {
    datos = { cuerpo: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(datos.titulo ?? 'LapiStock', {
      body: datos.cuerpo ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: datos.etiqueta,
      data: { url: datos.url ?? '/' },
    }),
  );
});

// Al tocar la notificación: enfoca una pestaña abierta de la app o abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      const abierta = ventanas.find((v) => new URL(v.url).origin === self.location.origin);
      if (abierta) return abierta.focus().then((v) => v.navigate?.(destino) ?? v);
      return self.clients.openWindow(destino);
    }),
  );
});
