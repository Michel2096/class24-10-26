// Pruebas funcionales y de compatibilidad de LapiStock (Actividad 14).
//
// Recorre la interfaz real en un navegador Chromium (Chrome o Edge) con el Chrome DevTools
// Protocol: validación de formularios, alta / consulta / edición / eliminación (CRUD),
// navegación entre las 5 pantallas, vista de escritorio y criterios de instalación.
//
// Uso (desde la raíz, con `npm run build` hecho):
//   node pruebas/funcionales.mjs            → Google Chrome
//   NAVEGADOR=edge node pruebas/funcionales.mjs → Microsoft Edge
// Resultado: pruebas/resultados-funcionales-<navegador>.json y capturas en docs/capturas/funcionales/.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAVEGADOR = (process.env.NAVEGADOR ?? 'chrome').toLowerCase();
const RUTAS = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
};
const EJECUTABLE = process.env.CHROME ?? RUTAS[NAVEGADOR]?.find(existsSync);
const PUERTO = 3300;
const PUERTO_CDP = 9444;
const URL_APP = `http://localhost:${PUERTO}/`;
const CAPTURAS = join(RAIZ, 'docs', 'capturas', 'funcionales');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'lapistock-func-'));
const resultados = [];
function registrar(id, prueba, ok, detalle = '') {
  resultados.push({ id, prueba, resultado: ok ? 'APROBADO' : 'NO APROBADO', detalle });
  console.log(`${ok ? '✔' : '✖'} [${id}] ${prueba}${detalle ? ` — ${detalle}` : ''}`);
}

if (!EJECUTABLE) {
  console.error(`No se encontró el navegador "${NAVEGADOR}". Define CHROME=<ruta>.`);
  process.exit(1);
}

const api = spawn(process.execPath, [join(RAIZ, 'api', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PUERTO), DB_FILE: join(tmp, 'func.db'), VAPID_FILE: join(tmp, 'vapid.json') },
  stdio: 'ignore',
});
const navegador = spawn(EJECUTABLE, [
  '--headless=new',
  `--remote-debugging-port=${PUERTO_CDP}`,
  `--user-data-dir=${join(tmp, 'perfil')}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

/* ───── CDP mínimo ───── */
let ws;
let sec = 0;
const pendientes = new Map();
const oyentes = new Set();
const cdp = (method, params = {}) =>
  new Promise((ok, ko) => {
    const id = ++sec;
    pendientes.set(id, { ok, ko });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evento = (nombre) =>
  new Promise((ok) => {
    const f = (m) => m.method === nombre && (oyentes.delete(f), ok(m.params));
    oyentes.add(f);
  });
async function evaluar(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function hasta(expr, ms = 8000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    try {
      if (await evaluar(expr)) return true;
    } catch {
      /* recargando */
    }
    await espera(150);
  }
  return false;
}
async function captura(nombre) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(CAPTURAS, `${NAVEGADOR}-${nombre}.png`), Buffer.from(data, 'base64'));
}
const servidor = async (ruta) => (await fetch(`${URL_APP}api${ruta}`)).json();
const ayudas = () =>
  evaluar(`window.__t = {
    set(el, val) {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    },
    campo(etiqueta) {
      const l = [...document.querySelectorAll('.modal label')].find((l) => l.textContent.trim().startsWith(etiqueta));
      return l?.querySelector('input,select');
    },
    click(texto, sel = 'button') {
      const b = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === texto)
        ?? [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(texto));
      if (!b) throw new Error('No hay botón: ' + texto);
      b.click();
    },
    tarjeta(texto) { return [...document.querySelectorAll('.tarjeta')].find((t) => t.textContent.includes(texto)); },
  }; window.confirm = () => true; true`);

async function main() {
  mkdirSync(CAPTURAS, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${URL_APP}api/health`)).ok) break;
    } catch {
      /* arrancando */
    }
    await espera(250);
  }
  let url;
  for (let i = 0; i < 40 && !url; i++) {
    try {
      url = (await (await fetch(`http://localhost:${PUERTO_CDP}/json/list`)).json()).find((o) => o.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      /* arrancando */
    }
    if (!url) await espera(250);
  }
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pendientes.has(m.id)) {
      const { ok, ko } = pendientes.get(m.id);
      pendientes.delete(m.id);
      m.error ? ko(new Error(m.error.message)) : ok(m.result);
    } else oyentes.forEach((f) => f(m));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const version = (await cdp('Browser.getVersion')).product;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });

  const cargado = evento('Page.loadEventFired');
  await cdp('Page.navigate', { url: URL_APP });
  await cargado;
  await ayudas();
  await hasta(`!!document.querySelector('.home') && !document.querySelector('.splash')`);
  await hasta(`document.querySelectorAll('.kpi__valor')[0]?.textContent === '5'`);

  /* F1 · Navegación entre pantallas */
  const titulos = { Inicio: 'Panel principal', Inventario: 'Inventario', Movimientos: 'Entradas y salidas', Resumen: 'Resumen del servidor', Sync: 'Sincronización' };
  const vistos = [];
  for (const [boton, titulo] of Object.entries(titulos)) {
    await evaluar(`__t.click('${boton}', '.nav button'); true`);
    const ok = await hasta(`document.querySelector('.cabecera small')?.textContent === '${titulo}' && document.querySelector('.nav button.activo')?.textContent.includes('${boton}')`, 4000);
    vistos.push(`${boton}=${ok ? 'ok' : 'falla'}`);
    await espera(250);
    await captura(`nav-${boton.toLowerCase()}`);
  }
  registrar('F1', 'Navegación entre las 5 pantallas (barra inferior)', vistos.every((v) => v.endsWith('ok')), vistos.join(', '));

  /* F2 · Validación: campos obligatorios */
  await evaluar(`__t.click('Inicio', '.nav button'); true`);
  await espera(200);
  await evaluar(`__t.click('Registrar nuevo lápiz'); true`);
  await hasta(`!!document.querySelector('.modal form')`, 5000);
  await ayudas();
  await evaluar(`document.querySelector('.modal form').requestSubmit(); true`);
  const errObl = await hasta(`document.querySelector('.alerta--error')?.textContent.includes('obligatorios')`, 3000);
  await captura('form-validacion');
  registrar('F2', 'El formulario rechaza marca y modelo vacíos', errObl, await evaluar(`document.querySelector('.alerta--error')?.textContent ?? ''`));

  /* F3 · Validación: valores numéricos */
  await evaluar(`__t.set(__t.campo('Marca'), 'Staedtler'); __t.set(__t.campo('Modelo'), 'Noris QA'); __t.set(__t.campo('Cantidad'), '-3'); true`);
  await evaluar(`document.querySelector('.modal form').requestSubmit(); true`);
  const errNum = await hasta(`document.querySelector('.alerta--error')?.textContent.includes('cantidad')`, 3000);
  registrar('F3', 'El formulario rechaza una cantidad negativa', errNum, await evaluar(`document.querySelector('.alerta--error')?.textContent ?? ''`));

  /* F4 · Registro (Create) */
  await evaluar(`__t.set(__t.campo('Cantidad'), '12'); __t.set(__t.campo('Dureza'), 'HB'); __t.set(__t.campo('Precio'), '1.5'); __t.set(__t.campo('Stock mínimo'), '4'); true`);
  await captura('form-alta');
  await evaluar(`document.querySelector('.modal form').requestSubmit(); true`);
  await hasta(`!document.querySelector('.modal')`, 4000);
  await hasta(`document.querySelectorAll('.kpi__valor')[0]?.textContent === '6'`, 6000);
  const enServidor = (await servidor('/lapices')).find((l) => l.modelo === 'Noris QA');
  registrar('F4', 'Registro de un lápiz nuevo (local + servidor)', !!enServidor && enServidor.cantidad === 12, `referencias=6, servidor: ${enServidor ? `${enServidor.marca} ${enServidor.modelo} stock=${enServidor.cantidad}` : 'no llegó'}`);

  /* F5 · Consulta (Read): búsqueda y filtro */
  await evaluar(`__t.click('Inventario', '.nav button'); true`);
  await hasta(`document.querySelectorAll('.tarjeta').length >= 6`, 4000);
  await evaluar(`__t.set(document.querySelector('.filtros input[type=search]'), 'noris qa'); true`);
  const filtrado = await hasta(`document.querySelectorAll('.tarjeta').length === 1 && !!__t.tarjeta('Noris QA')`, 3000);
  await captura('consulta-busqueda');
  registrar('F5', 'Consulta: la búsqueda filtra el inventario', filtrado, `tarjetas visibles=${await evaluar(`document.querySelectorAll('.tarjeta').length`)}`);

  /* F6 · Edición (Update) */
  await evaluar(`[...__t.tarjeta('Noris QA').querySelectorAll('button')].find((b) => b.textContent.includes('Editar')).click(); true`);
  await hasta(`document.querySelector('#form-titulo')?.textContent === 'Editar lápiz'`, 4000);
  await ayudas();
  await evaluar(`__t.set(__t.campo('Modelo'), 'Noris QA Editado'); __t.set(__t.campo('Precio'), '2.25'); true`);
  await captura('form-edicion');
  await evaluar(`document.querySelector('.modal form').requestSubmit(); true`);
  await hasta(`!document.querySelector('.modal')`, 4000);
  await evaluar(`__t.set(document.querySelector('.filtros input[type=search]'), ''); true`);
  let editado;
  for (let i = 0; i < 20 && !editado; i++) {
    editado = (await servidor('/lapices')).find((l) => l.modelo === 'Noris QA Editado' && l.precio === 2.25);
    if (!editado) await espera(250);
  }
  const editadoUi = await hasta(`!!__t.tarjeta('Noris QA Editado')`, 3000);
  registrar('F6', 'Edición de un lápiz (local + servidor)', !!editado && editadoUi, `servidor: ${editado ? `${editado.modelo} $${editado.precio}` : 'sin cambio'}`);

  /* F7 · Eliminación (Delete) */
  await evaluar(`[...__t.tarjeta('Noris QA Editado').querySelectorAll('button')].find((b) => b.textContent.includes('Eliminar')).click(); true`);
  const fueraUi = await hasta(`!__t.tarjeta('Noris QA Editado')`, 4000);
  let borrado = false;
  for (let i = 0; i < 20 && !borrado; i++) {
    borrado = !(await servidor('/lapices')).some((l) => l.modelo.startsWith('Noris QA'));
    if (!borrado) await espera(250);
  }
  await captura('eliminacion');
  const cola = await evaluar(`new Promise((ok) => { const r = indexedDB.open('lapistock'); r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').getAll(); q.onsuccess = () => ok(JSON.stringify(q.result.map((o) => [o.tipo, o.estado, o.ultimo_error]))); }; })`);
  registrar('F7', 'Eliminación de un lápiz (local + servidor)', fueraUi && borrado, `referencias en servidor=${(await servidor('/lapices')).length}, cola local=${cola}`);

  /* F8 · Movimiento de salida mayor al stock: el servidor lo rechaza (409) */
  const lapiz = (await servidor('/lapices'))[0];
  const r409 = await fetch(`${URL_APP}api/movimientos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID(), lapiz_id: lapiz.id, tipo: 'salida', cantidad: lapiz.cantidad + 100 }),
  });
  registrar('F8', 'Validación del servidor: salida sin stock suficiente', r409.status === 409, `HTTP ${r409.status}: ${(await r409.json()).error}`);

  /* C1 · Vista de escritorio (diseño adaptable) */
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluar(`__t.click('Inicio', '.nav button'); true`);
  await espera(500);
  const escritorio = await evaluar(`(() => { const n = document.querySelector('.nav').getBoundingClientRect(); return n.top < 200 && document.documentElement.scrollWidth <= innerWidth; })()`);
  await captura('escritorio');
  registrar('C1', 'Diseño adaptable: en ≥ 900 px la navegación pasa a pestañas superiores sin scroll horizontal', escritorio);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });

  /* I1 · Criterios de instalación */
  await hasta(`navigator.serviceWorker?.controller !== null`, 8000);
  const manifiesto = await (await fetch(`${URL_APP}manifest.webmanifest`)).json();
  const { installabilityErrors } = await cdp('Page.getInstallabilityErrors');
  const icono512 = manifiesto.icons.some((i) => i.sizes === '512x512');
  registrar(
    'I1',
    'La PWA cumple los criterios de instalación (manifest + iconos + SW)',
    installabilityErrors.length === 0 && icono512 && manifiesto.display === 'standalone',
    `name="${manifiesto.short_name}", display=${manifiesto.display}, iconos=${manifiesto.icons.length}, errores de instalación=${installabilityErrors.map((e) => e.errorId).join(',') || 'ninguno'}`,
  );
  return version;
}

let version = '';
let codigo = 0;
try {
  version = await main();
} catch (e) {
  codigo = 1;
  registrar('ERR', 'Ejecución del escenario', false, e.message);
} finally {
  writeFileSync(
    join(RAIZ, 'pruebas', `resultados-funcionales-${NAVEGADOR}.json`),
    JSON.stringify({ fecha: new Date().toISOString(), navegador: version || EJECUTABLE, resultados }, null, 2),
  );
  ws?.close();
  navegador.kill();
  api.kill();
  await espera(600);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows puede retener archivos */
  }
  const fallas = resultados.filter((r) => r.resultado !== 'APROBADO').length;
  console.log(`\n${NAVEGADOR} (${version}): ${resultados.length - fallas}/${resultados.length} aprobadas`);
  process.exit(codigo || (fallas ? 1 : 0));
}
