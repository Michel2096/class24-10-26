# ✏️ LapiStock — Inventario de lápices (PWA)

Aplicación web progresiva para llevar el inventario de lápices de una papelería, escuela o taller
de dibujo. Funciona **sin conexión**: los registros hechos offline se guardan en el dispositivo y se
envían al servidor cuando vuelve la red, **sin duplicarse**.

| Capa | Tecnología |
|---|---|
| Cliente | React 19 + TypeScript + Vite 8 |
| Servidor | Node.js + Express 5 |
| Base de datos | SQLite (módulo nativo `node:sqlite`, un solo archivo `api/data/inventario.db`) |
| Offline | Service Worker + Cache API, IndexedDB (datos, cola y fotos), localStorage (preferencias) |
| Dispositivo | Cámara (`getUserMedia`), notificaciones locales y **push** (Web Push + VAPID con `web-push`) |

## Resumen

- **Proyecto:** inventario de lápices.
- **Información que se muestra:** lista de lápices (marca, modelo, tipo, dureza, color, precio, stock),
  alertas de bajo stock, historial de entradas/salidas, métricas del servidor (unidades, valor total,
  unidades por tipo, movimientos del día) y el estado de sincronización.
- **Datos que se pueden registrar:** alta, edición y baja de lápices; movimientos de **entrada** y
  **salida** de stock con nota.
- **Pantallas:** *Splash Screen* (logo + nombre + barra de carga mientras se abre IndexedDB) y
  *Home Screen* (cabecera con estado de conexión, KPIs, accesos rápidos y navegación inferior a
  Inventario, Movimientos, Resumen y Sync).
- **Cliente vs servidor:** el cliente genera IDs (UUID), fechas, filtros, KPIs locales y la cola
  offline; el servidor valida, guarda en SQLite, recalcula el stock en una transacción (rechaza
  stock negativo) y calcula el resumen con SQL.
- **Funciones nativas:** Service Worker con aviso «Nueva versión → Actualizar», foto del lápiz con la
  **cámara** (guardada en el dispositivo), notificación de **bajo stock** (local, también offline, y
  push del servidor a todos los dispositivos suscritos) y avisos cuando una función necesita conexión.
- **Pruebas:** 9 pruebas de API (`npm test`) + 16 pruebas E2E en Chrome real con/sin conexión,
  permisos, notificaciones, cámara y actualización del SW (`npm run test:e2e`). **Todas pasan.**
  Ver [documento técnico](docs/DOCUMENTO-TECNICO.md) y [Service Worker, notificaciones y cámara](docs/FUNCIONES-NATIVAS.md).

## Puesta en marcha

Requisito: **Node.js 22.13 o superior** (probado con Node 24.21). No hace falta instalar ninguna base
de datos: SQLite viene incluido en Node y el archivo se crea solo con datos de ejemplo.

```bash
npm run instalar        # instala dependencias de api/ y front/

# Opción A — modo producción (PWA completa con Service Worker), una sola URL:
npm run build           # compila el front a front/dist
npm start               # API + PWA en http://localhost:3000

# Opción B — desarrollo (recarga en caliente, sin Service Worker):
npm run dev:api         # terminal 1 → http://localhost:3000/api
npm run dev:front       # terminal 2 → http://localhost:5173
```

### Pruebas

```bash
npm test                # pruebas de la API (node:test)
npm run build && npm run test:e2e   # E2E en Chrome headless: genera docs/capturas y pruebas/resultados-e2e.json
```

### Cómo probar el modo offline a mano

1. `npm run build && npm start` y abre http://localhost:3000 en Chrome.
2. DevTools → *Application* → *Service Workers*: verifica que `sw.js` está activo.
3. DevTools → *Network* → **Offline** (o detén el servidor con Ctrl+C) y recarga: la app abre igual.
4. Registra un lápiz o un movimiento: aparece como «Sin sincronizar» y en la pestaña **Sync**.
5. Quita *Offline* (o vuelve a ejecutar `npm start`): la cola se envía sola. La bitácora lo registra.

### Cómo probar notificaciones y cámara a mano

1. Pestaña **Sync → App y notificaciones**: *Activar notificaciones* (el navegador pide permiso) →
   *Activar push* → *Enviar push de prueba*.
2. **Movimientos**: registra una salida que deje un lápiz en su stock mínimo → aviso «Bajo stock».
3. **Inicio → Registrar nuevo lápiz → Tomar foto** → *Permitir y abrir cámara* → *Capturar*.
4. Para ver el aviso de actualización: `npm run build` otra vez con la app abierta y vuelve a la pestaña.

Cámara, push y Service Worker requieren **HTTPS o `localhost`**. Las claves VAPID se generan solas en
`api/data/vapid.json` (o usa `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`).

## Estructura

```
api/                      Servidor Express + SQLite
  src/db.js               Esquema (tablas lapices y movimientos)
  src/app.js              Endpoints REST, validación, transacciones e idempotencia
  src/push.js             Web Push: claves VAPID, suscripciones y envío
  src/seed.js             Datos de ejemplo
  test/api.test.js        Pruebas de la API
front/                    PWA React
  public/sw.js            Service Worker (caché, actualización, push, clic en notificación)
  public/manifest.webmanifest
  src/lib/idb.ts          IndexedDB (lapices, movimientos, outbox)
  src/lib/sync.ts         Cola offline y sincronización sin duplicados
  src/lib/preferencias.ts localStorage
  src/lib/sw.ts           Registro y actualización del Service Worker
  src/lib/notificaciones.ts  Permiso, notificaciones locales y suscripción push
  src/hooks/useInventario.ts  Estado de la app y reintentos
  src/components/         Splash, Home, vistas, Camara y PanelPwa
pruebas/e2e-offline.mjs   Prueba E2E con Chrome DevTools Protocol
docs/                     Documento técnico y capturas
```

## API REST

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/lapices` | Lista de lápices |
| GET | `/api/lapices/:id` | Un lápiz |
| POST | `/api/lapices` | Alta (idempotente por `id`) → 201 nuevo / 200 `duplicado: true` |
| PUT | `/api/lapices/:id` | Edición de datos descriptivos |
| DELETE | `/api/lapices/:id` | Baja (idempotente) |
| GET | `/api/movimientos?limite=50` | Historial |
| POST | `/api/movimientos` | Entrada/salida (idempotente por `id`; 409 si no hay stock) |
| GET | `/api/resumen` | Métricas agregadas con SQL |
| GET | `/api/push/clave-publica` | Clave pública VAPID |
| POST | `/api/push/suscripciones` | Guarda una suscripción push (`endpoint`, `keys`) |
| DELETE | `/api/push/suscripciones` | Borra una suscripción (`endpoint`) |
| POST | `/api/push/prueba` | Envía una push de prueba a todos los suscritos |
