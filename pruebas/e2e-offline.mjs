// Prueba E2E de LapiStock con Chrome headless + Chrome DevTools Protocol (sin dependencias).
//
// Requisitos: `npm run build` en front/ y Chrome instalado (o CHROME=<ruta al ejecutable>).
// Uso (desde la raíz del repo):  node pruebas/e2e-offline.mjs
//
// Levanta su propia API en el puerto 3100 con una BD temporal, abre la PWA en un perfil
// limpio de Chrome y recorre: splash → home → offline (servidor apagado) → registros sin
// conexión → recarga → reconexión → sincronización → reintento duplicado.
// También prueba las funciones de dispositivo: permiso + notificación local, push, captura de
// foto con la cámara falsa de Chrome, avisos de «requiere conexión» y actualización del SW.
// Guarda capturas en docs/capturas/ y el resultado en pruebas/resultados-e2e.json.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUERTO = 3100;
const URL_APP = `http://localhost:${PUERTO}/`;
const CAPTURAS = join(RAIZ, 'docs', 'capturas');
const CHROME =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'lapistock-e2e-'));
const resultados = [];
/** ok === null: el entorno de prueba no permite la función (se documenta como limitación). */
function registrar(prueba, ok, detalle = '') {
  const resultado = ok === null ? 'LIMITACIÓN' : ok ? 'OK' : 'FALLA';
  resultados.push({ prueba, resultado, detalle });
  console.log(`${ok === null ? '⚠' : ok ? '✔' : '✖'} ${prueba}${detalle ? ` — ${detalle}` : ''}`);
}

/* ───── Servidor API propio ───── */
let api;
async function iniciarApi() {
  api = spawn(process.execPath, [join(RAIZ, 'api', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PUERTO), DB_FILE: join(tmp, 'e2e.db') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${URL_APP}api/health`)).ok) return;
    } catch {
      /* aún arrancando */
    }
    await espera(250);
  }
  throw new Error('La API no arrancó');
}
async function detenerApi() {
  const fin = new Promise((r) => api.once('exit', r));
  api.kill();
  await fin;
}

/* ───── Chrome + CDP ───── */
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9333',
  `--user-data-dir=${join(tmp, 'perfil')}`,
  // Cámara simulada (patrón de prueba) para poder probar getUserMedia sin hardware.
  '--use-fake-device-for-media-stream',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

async function conectar() {
  for (let i = 0; i < 40; i++) {
    try {
      const objetivos = await (await fetch('http://localhost:9333/json/list')).json();
      const pagina = objetivos.find((o) => o.type === 'page');
      if (pagina) return pagina.webSocketDebuggerUrl;
    } catch {
      /* Chrome aún arrancando */
    }
    await espera(250);
  }
  throw new Error('No se pudo conectar con Chrome');
}

let ws;
let sec = 0;
const pendientes = new Map();
const oyentes = new Set();
function cdp(method, params = {}) {
  return new Promise((ok, ko) => {
    const id = ++sec;
    pendientes.set(id, { ok, ko });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evento = (nombre) =>
  new Promise((ok) => {
    const f = (m) => m.method === nombre && (oyentes.delete(f), ok(m.params));
    oyentes.add(f);
  });

async function evaluar(expresion) {
  const r = await cdp('Runtime.evaluate', { expression: expresion, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function hasta(expresion, ms = 10000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    try {
      if (await evaluar(expresion)) return true;
    } catch {
      /* página recargando */
    }
    await espera(200);
  }
  return false;
}
async function captura(nombre) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(CAPTURAS, nombre), Buffer.from(data, 'base64'));
}
async function cargar(accion) {
  const cargado = evento('Page.loadEventFired');
  await accion();
  await Promise.race([cargado, espera(15000).then(() => Promise.reject(new Error('La página no terminó de cargar')))]);
  await inyectarAyudas();
}

// Utilidades dentro de la página: rellenar inputs controlados por React, pulsar botones y leer IndexedDB.
const inyectarAyudas = () =>
  evaluar(`window.__t = {
    set(el, val) {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    },
    click(texto, sel = 'button') {
      const b = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === texto)
        ?? [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(texto));
      if (!b) throw new Error('No hay botón: ' + texto);
      b.click();
    },
    store(nombre) {
      return new Promise((ok, ko) => {
        const r = indexedDB.open('lapistock');
        r.onsuccess = () => { const q = r.result.transaction(nombre).objectStore(nombre).getAll(); q.onsuccess = () => ok(q.result); q.onerror = ko; };
        r.onerror = ko;
      });
    },
    agregar(nombre, valor) {
      return new Promise((ok, ko) => {
        const r = indexedDB.open('lapistock');
        r.onsuccess = () => { const t = r.result.transaction(nombre, 'readwrite'); t.objectStore(nombre).add(valor); t.oncomplete = ok; t.onerror = ko; };
      });
    },
  }; true`);

const esperarHome = () => hasta(`!!document.querySelector('.home') && !document.querySelector('.splash')`, 8000);
const servidor = async (ruta) => (await fetch(`${URL_APP}api${ruta}`)).json();
const red = (offline) =>
  cdp('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/* ───── Escenario ───── */
async function main() {
  if (!CHROME) throw new Error('No se encontró Chrome. Define la variable CHROME.');
  mkdirSync(CAPTURAS, { recursive: true });
  await iniciarApi();

  ws = new WebSocket(await conectar());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pendientes.has(m.id)) {
      const { ok, ko } = pendientes.get(m.id);
      pendientes.delete(m.id);
      if (m.error) ko(new Error(m.error.message));
      else ok(m.result);
    } else oyentes.forEach((f) => f(m));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });

  // 1. Splash y Home
  await cargar(() => cdp('Page.navigate', { url: URL_APP }));
  await espera(350);
  const haySplash = await evaluar(`!!document.querySelector('.splash')`);
  await captura('01-splash.png');
  registrar('Se muestra la Splash Screen al iniciar', haySplash);

  const hayHome = await hasta(`!!document.querySelector('.home') && !document.querySelector('.splash')`, 6000);
  await hasta(`document.querySelectorAll('.kpi__valor')[0]?.textContent === '5'`, 5000);
  await captura('02-home.png');
  registrar('Se muestra la Home Screen con navegación tras el splash', hayHome);

  const kpis = await evaluar(`[...document.querySelectorAll('.kpi__valor')].map((e) => e.textContent)`);
  registrar('Los datos del servidor se muestran en la interfaz', kpis[0] === '5', `KPIs: ${kpis.join(' | ')}`);

  await evaluar(`__t.click('Inventario', '.nav button'); true`);
  await hasta(`document.querySelectorAll('.tarjeta').length === 5`);
  await captura('03-inventario.png');

  // 2. Service Worker activo y controlando la página
  const swListo = await hasta(`navigator.serviceWorker.ready.then(() => true)`, 10000);
  await cargar(() => cdp('Page.reload'));
  const controlado = await hasta(`!!navigator.serviceWorker.controller`, 5000);
  const caches = await evaluar(`caches.keys()`);
  registrar('Service Worker registrado y controlando la página', swListo && controlado, `cachés: ${caches.join(', ')}`);

  // 2a. Notificaciones: sin permiso no se muestra nada; tras concederlo sí.
  await esperarHome();
  await evaluar(`__t.click('Sync', '.nav button'); true`);
  await hasta(`!!document.querySelector('.panel-pwa')`);
  const swTexto = await evaluar(`document.querySelector('.estado-pwa dd').textContent`);
  const sinPermiso = await evaluar(`Notification.permission`);
  await cdp('Browser.grantPermissions', { origin: URL_APP.slice(0, -1), permissions: ['notifications', 'videoCapture'] });
  await evaluar(`__t.click('Activar notificaciones'); true`);
  await hasta(`!!document.querySelector('.panel-pwa .alerta')`, 5000);
  const msgPermiso = await evaluar(`document.querySelector('.panel-pwa .alerta')?.textContent ?? ''`);
  // Chrome headless a veces descarta la primera notificación de un perfil nuevo: se prueba también
  // el botón «Probar notificación local», que solo aparece una vez concedido el permiso.
  await evaluar(`__t.click('Probar notificación local'); true`);
  const titulos = `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.map((x) => x.title))`;
  await hasta(`${titulos}.then((t) => t.includes('Prueba local'))`, 8000);
  const vistas = await evaluar(titulos);
  await captura('11-notificaciones.png');
  registrar(
    'La notificación se muestra después de conceder el permiso',
    sinPermiso === 'default' && msgPermiso.startsWith('Permiso concedido') && vistas.includes('Prueba local'),
    `permiso inicial=${sinPermiso}, panel SW="${swTexto}", mostradas=${JSON.stringify(vistas)}`,
  );

  // 2b. Push real (ampliación): suscripción con VAPID y envío desde el servidor.
  await evaluar(`__t.click('Activar push'); true`);
  await hasta(`!!document.querySelector('.panel-pwa .alerta--ok, .panel-pwa .alerta--error')`, 20000);
  const pushMsg = await evaluar(`document.querySelector('.panel-pwa .alerta--ok, .panel-pwa .alerta--error')?.textContent ?? ''`);
  const pushOk = await evaluar(`navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => !!s)`);
  registrar(
    'Suscripción a notificaciones push del servidor',
    pushOk ? true : null,
    pushOk ? pushMsg : `Chrome headless no obtuvo suscripción del servicio push: ${pushMsg}`,
  );
  if (pushOk) {
    await evaluar(`__t.click('Enviar push de prueba'); true`);
    const recibida = await hasta(
      `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.some((x) => x.body.includes('enviada por el servidor')))`,
      20000,
    );
    const msg = await evaluar(`document.querySelector('.panel-pwa .alerta')?.textContent ?? ''`);
    registrar(
      'El servidor envía una push y el Service Worker la muestra',
      recibida ? true : null,
      recibida ? msg : `servidor: "${msg}"; la entrega depende del servicio push externo (FCM)`,
    );
  }

  // 2c. Cámara: alta de un lápiz con foto + aviso local de bajo stock tras una salida.
  await evaluar(`__t.click('Inicio', '.nav button'); true`);
  await evaluar(`__t.click('+ Registrar nuevo lápiz'); true`);
  await hasta(`!!document.querySelector('.modal')`);
  await evaluar(`(() => {
    const i = document.querySelectorAll('.modal input');
    __t.set(i[0], 'Staedtler'); __t.set(i[1], 'Mars Lumograph'); __t.set(i[2], '2B');
    __t.set(i[4], '3.10'); __t.set(i[5], '4'); __t.set(i[6], '3');
    return true; })()`);
  await evaluar(`__t.click('Tomar foto'); true`);
  await hasta(`!!document.querySelector('.camara')`);
  await evaluar(`__t.click('Permitir y abrir cámara'); true`);
  const video = await hasta(`document.querySelector('.camara__video')?.videoWidth > 0`, 8000);
  await espera(300);
  await captura('12-camara.png');
  await evaluar(`__t.click('Capturar'); true`);
  await hasta(`!!document.querySelector('.foto-campo__img')`);
  await evaluar(`__t.click('Guardar'); true`);
  await hasta(`!document.querySelector('.modal')`);
  const fotos = await evaluar(`__t.store('fotos').then((f) => f.map((x) => ({ tipo: x.imagen.type, bytes: x.imagen.size })))`);
  await evaluar(`__t.click('Inventario', '.nav button'); true`);
  await hasta(`!!document.querySelector('.tarjeta .miniatura')`);
  await evaluar(`document.querySelector('.tarjeta .miniatura').scrollIntoView({ block: 'center' }); true`);
  await espera(200);
  await captura('13-foto-inventario.png');
  registrar(
    'La cámara captura una foto con el permiso autorizado',
    video && fotos.length === 1 && fotos[0].tipo === 'image/jpeg',
    `video=${video}, fotos en IndexedDB=${JSON.stringify(fotos)}`,
  );

  await evaluar(`__t.click('Movimientos', '.nav button'); true`);
  await hasta(`!!document.querySelector('.form-mov')`);
  await evaluar(`(() => {
    const sel = document.querySelector('.form-mov select');
    __t.set(sel, [...sel.options].find((o) => o.textContent.includes('Staedtler')).value);
    return true; })()`);
  await evaluar(`__t.click('↑ Salida'); true`);
  await evaluar(`__t.set(document.querySelectorAll('.form-mov input')[0], '2'); true`);
  await evaluar(`__t.click('Registrar', '.form-mov button'); true`);
  const avisoStock = await hasta(
    `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((n) => n.some((x) => x.title === 'Bajo stock'))`,
    5000,
  );
  registrar('Notificación local de bajo stock tras una salida', avisoStock);
  await hasta(`__t.store('outbox').then((c) => c.length === 0)`, 8000);

  // 3. Sin conexión: se apaga el servidor y se emula red caída
  await detenerApi();
  await red(true);
  await cargar(() => cdp('Page.reload'));
  const abreOffline = await esperarHome();
  const offlineUi = await hasta(`document.querySelector('.conexion')?.textContent === 'Sin conexión'`, 3000);
  await captura('04-offline-home.png');
  registrar('La app abre sin conexión desde la caché del Service Worker', abreOffline && offlineUi);

  // 3·. Las funciones que necesitan servidor avisan al usuario
  await evaluar(`__t.click('Resumen', '.nav button'); true`);
  await hasta(`!!document.querySelector('.alerta--aviso')`, 3000);
  const avisoResumen = await evaluar(`document.querySelector('.alerta--aviso')?.textContent ?? ''`);
  const botonDesactivado = await evaluar(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Actualizar')?.disabled`);
  await captura('14-offline-requiere-conexion.png');
  await evaluar(`__t.click('Sync', '.nav button'); true`);
  const avisosSync = await evaluar(`document.querySelectorAll('.alerta--aviso').length`);
  registrar(
    'La app informa cuando una función necesita conexión',
    avisoResumen.includes('necesita conexión') && botonDesactivado === true && avisosSync >= 2,
    `Resumen: "${avisoResumen.trim()}", botón deshabilitado=${botonDesactivado}, avisos en Sync=${avisosSync}`,
  );

  // 3a. Alta de un lápiz sin conexión
  await evaluar(`__t.click('Inicio', '.nav button'); true`);
  await evaluar(`__t.click('+ Registrar nuevo lápiz'); true`);
  await hasta(`!!document.querySelector('.modal')`);
  await evaluar(`(() => {
    const i = document.querySelectorAll('.modal input');
    __t.set(i[0], 'Tombow'); __t.set(i[1], 'Mono 100'); __t.set(i[2], '4B');
    __t.set(i[4], '2.75'); __t.set(i[5], '10'); __t.set(i[6], '3');
    __t.set(document.querySelector('.modal select'), 'grafito');
    return true; })()`);
  await captura('05-offline-formulario.png');
  await evaluar(`__t.click('Guardar'); true`);
  await hasta(`!document.querySelector('.modal')`);

  // 3b. Salida de stock sin conexión
  await evaluar(`__t.click('Movimientos', '.nav button'); true`);
  await hasta(`!!document.querySelector('.form-mov')`);
  await evaluar(`(() => {
    const sel = document.querySelector('.form-mov select');
    const op = [...sel.options].find((o) => o.textContent.includes('Tombow'));
    __t.set(sel, op.value);
    return true; })()`);
  await evaluar(`__t.click('↑ Salida'); true`);
  await evaluar(`__t.set(document.querySelectorAll('.form-mov input')[0], '2'); __t.set(document.querySelectorAll('.form-mov input')[1], 'Prueba offline'); true`);
  await evaluar(`__t.click('Registrar', '.form-mov button'); true`);
  await hasta(`document.querySelector('.alerta--ok') !== null`);
  await captura('06-offline-movimiento.png');

  let cola = await evaluar(`__t.store('outbox')`);
  registrar('Los registros sin conexión quedan en la cola de IndexedDB', cola.length === 2, `${cola.length} operaciones en cola`);

  // 3c. Persistencia tras recargar (sigue offline)
  await cargar(() => cdp('Page.reload'));
  await esperarHome();
  cola = await evaluar(`__t.store('outbox')`);
  const lapices = await evaluar(`__t.store('lapices')`);
  const tombow = lapices.find((l) => l.marca === 'Tombow');
  const vistaGuardada = await evaluar(`localStorage.getItem('lapistock:vista')`);
  registrar(
    'Los datos locales persisten después de recargar',
    cola.length === 2 && tombow?.cantidad === 8 && vistaGuardada === '"movimientos"',
    `cola=${cola.length}, stock local Tombow=${tombow?.cantidad}, vista recordada (localStorage)=${vistaGuardada}`,
  );
  await evaluar(`__t.click('Sync', '.nav button'); true`);
  await hasta(`!!document.querySelector('.log')`);
  await captura('07-offline-cola.png');

  // 4. Reconexión: el servidor vuelve y la red se restablece → reintento automático
  await iniciarApi();
  await red(false);
  const vacia = await hasta(`__t.store('outbox').then((c) => c.length === 0)`, 15000);
  const enServidor = (await servidor('/lapices')).filter((l) => l.marca === 'Tombow');
  registrar(
    'Al reconectar, los pendientes se envían al servidor automáticamente',
    vacia && enServidor.length === 1 && enServidor[0].cantidad === 8,
    `cola vacía=${vacia}, registros en servidor=${enServidor.length}, stock servidor=${enServidor[0]?.cantidad}`,
  );
  await hasta(`document.querySelector('.vacio')?.textContent.includes('sincronizado')`, 4000);
  await captura('08-sincronizado.png');

  // 5. Reintento duplicado: se reencolan las MISMAS operaciones (simula respuesta perdida)
  const mov = (await servidor('/movimientos')).find((m) => m.nota === 'Prueba offline');
  const base = { estado: 'pendiente', intentos: 1, creado_en: new Date().toISOString() };
  const opLapiz = {
    ...base, op_id: crypto.randomUUID(), tipo: 'crear_lapiz', recurso_id: enServidor[0].id, descripcion: 'Reintento duplicado (alta)',
    datos: { id: enServidor[0].id, marca: 'Tombow', modelo: 'Mono 100', tipo: 'grafito', dureza: '4B', cantidad: 10, stock_minimo: 3, precio: 2.75 },
  };
  const opMov = {
    ...base, op_id: crypto.randomUUID(), tipo: 'crear_movimiento', recurso_id: mov.id, descripcion: 'Reintento duplicado (salida)',
    datos: { id: mov.id, lapiz_id: mov.lapiz_id, tipo: 'salida', cantidad: 2, nota: 'Prueba offline' },
  };
  await evaluar(`__t.agregar('outbox', ${JSON.stringify(opLapiz)}).then(() => __t.agregar('outbox', ${JSON.stringify(opMov)})).then(() => true)`);
  // Doble clic + sync concurrente: el candado evita envíos paralelos y el servidor ignora ids repetidos
  await cargar(() => cdp('Page.reload'));
  await esperarHome();
  await hasta(`__t.store('outbox').then((c) => c.length === 0)`, 15000);
  const trasReintento = (await servidor('/lapices')).filter((l) => l.marca === 'Tombow');
  const movs = (await servidor('/movimientos')).filter((m) => m.nota === 'Prueba offline');
  registrar(
    'Los reintentos de sincronización no duplican registros',
    trasReintento.length === 1 && trasReintento[0].cantidad === 8 && movs.length === 1,
    `lápices Tombow=${trasReintento.length}, stock=${trasReintento[0]?.cantidad}, movimientos=${movs.length}`,
  );
  await evaluar(`__t.click('Sync', '.nav button'); true`);
  await espera(400);
  await captura('09-bitacora.png');

  await evaluar(`__t.click('Resumen', '.nav button'); true`);
  await hasta(`!!document.querySelector('.barras li')`, 5000);
  await captura('10-resumen-servidor.png');

  // 6. Actualización del Service Worker: se publica un sw.js distinto → aviso → «Actualizar»
  const swArchivo = join(RAIZ, 'front', 'dist', 'sw.js');
  const swOriginal = readFileSync(swArchivo, 'utf8');
  try {
    writeFileSync(swArchivo, `${swOriginal}\n// build de prueba ${Date.now()}\n`);
    await evaluar(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
    const aviso = await hasta(`!!document.querySelector('.banda-actualizacion')`, 10000);
    await captura('15-actualizacion.png');
    await cargar(() => evaluar(`__t.click('Actualizar', '.banda-actualizacion button'); true`));
    await esperarHome();
    const aplicada = await hasta(
      `navigator.serviceWorker.getRegistration().then((r) => !r.waiting && !!r.active && !document.querySelector('.banda-actualizacion'))`,
      8000,
    );
    registrar('El Service Worker se actualiza tras confirmar el aviso', aviso && aplicada, `aviso=${aviso}, versión nueva activa=${aplicada}`);
  } finally {
    writeFileSync(swArchivo, swOriginal);
  }
}

let codigo = 0;
try {
  await main();
} catch (e) {
  codigo = 1;
  registrar('Ejecución del escenario', false, e.message);
} finally {
  writeFileSync(
    join(RAIZ, 'pruebas', 'resultados-e2e.json'),
    JSON.stringify({ fecha: new Date().toISOString(), navegador: CHROME, resultados }, null, 2),
  );
  ws?.close();
  chrome.kill();
  if (api && api.exitCode === null) api.kill();
  await espera(500);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows puede retener archivos de Chrome unos segundos */
  }
  const fallas = resultados.filter((r) => r.resultado === 'FALLA').length;
  const limitaciones = resultados.filter((r) => r.resultado === 'LIMITACIÓN').length;
  const extra = limitaciones ? `, ${limitaciones} limitación(es) del entorno` : '';
  console.log(`\n${resultados.length - fallas - limitaciones}/${resultados.length} pruebas OK${extra}`);
  process.exit(codigo || (fallas ? 1 : 0));
}
