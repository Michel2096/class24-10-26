// Prueba del proceso de actualización y reversión de la PWA (liberación v1.0.0 → v1.1.0).
//
// Simula dos publicaciones: sirve el build anterior, el usuario registra datos (IndexedDB +
// localStorage), se «publica» el build nuevo en el mismo origen y se comprueba que el Service
// Worker detecta la versión, muestra el aviso, se activa al pulsar «Actualizar» y que los datos
// locales del usuario siguen ahí. Al final se «revierte» publicando de nuevo el build anterior
// (procedimiento de rollback) y se comprueba que también se actualiza sin perder datos.
//
// Uso:  node pruebas/actualizacion.mjs <dist-anterior> <dist-nueva>
//       (cada carpeta es una copia de front/dist generada con `npm run build`)
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const [ANTERIOR, NUEVA] = process.argv.slice(2).map((p) => resolve(p));
if (!ANTERIOR || !NUEVA || !existsSync(ANTERIOR) || !existsSync(NUEVA)) {
  console.error('Uso: node pruebas/actualizacion.mjs <dist-anterior> <dist-nueva>');
  process.exit(1);
}
const CHROME =
  process.env.CHROME ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const PUERTO = 3400;
const URL_APP = `http://localhost:${PUERTO}/`;
const CAPTURAS = join(RAIZ, 'docs', 'capturas');
const tmp = mkdtempSync(join(tmpdir(), 'lapistock-upd-'));
const sitio = join(tmp, 'sitio'); // carpeta «publicada»: se reemplaza su contenido en cada deploy
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
const registrar = (id, prueba, ok, detalle = '') => {
  resultados.push({ id, prueba, resultado: ok ? 'APROBADO' : 'NO APROBADO', detalle });
  console.log(`${ok ? '✔' : '✖'} [${id}] ${prueba}${detalle ? ` — ${detalle}` : ''}`);
};
function publicar(dist) {
  rmSync(sitio, { recursive: true, force: true });
  cpSync(dist, sitio, { recursive: true });
}

publicar(ANTERIOR);
// Servidor con la API real, sirviendo la carpeta «publicada».
const servidorJs = `
  import { openDb } from ${JSON.stringify('file:///' + join(RAIZ, 'api/src/db.js').replaceAll('\\', '/'))};
  import { createApp } from ${JSON.stringify('file:///' + join(RAIZ, 'api/src/app.js').replaceAll('\\', '/'))};
  import { sembrar } from ${JSON.stringify('file:///' + join(RAIZ, 'api/src/seed.js').replaceAll('\\', '/'))};
  const db = openDb(${JSON.stringify(join(tmp, 'upd.db'))}); sembrar(db);
  createApp(db, { staticDir: ${JSON.stringify(sitio)} }).listen(${PUERTO});`;
writeFileSync(join(tmp, 'servidor.mjs'), servidorJs);
const api = spawn(process.execPath, [join(tmp, 'servidor.mjs')], { stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9555', `--user-data-dir=${join(tmp, 'perfil')}`, '--no-first-run', 'about:blank']);

let ws;
let sec = 0;
const pend = new Map();
const oyentes = new Set();
const cdp = (method, params = {}) =>
  new Promise((ok, ko) => {
    const id = ++sec;
    pend.set(id, { ok, ko });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evento = (n) => new Promise((ok) => { const f = (m) => m.method === n && (oyentes.delete(f), ok(m.params)); oyentes.add(f); });
async function evaluar(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function hasta(expr, ms = 10000) {
  for (const fin = Date.now() + ms; Date.now() < fin; await espera(150)) {
    try {
      if (await evaluar(expr)) return true;
    } catch {
      /* recargando */
    }
  }
  return false;
}
const captura = async (n) => writeFileSync(join(CAPTURAS, n), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const setInput = (sel, val) =>
  `(() => { const el = ${sel}; const p = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`;
const campo = (etq) => `[...document.querySelectorAll('.modal label')].find((l) => l.textContent.trim().startsWith('${etq}')).querySelector('input,select')`;
const boton = (txt, sel = 'button') => `([...document.querySelectorAll('${sel}')].find((b) => b.textContent.includes('${txt}')).click(), true)`;
const versionVisible = () => evaluar(`document.querySelector('.version')?.textContent ?? ''`);
const lapicesIdb = () =>
  evaluar(`new Promise((ok) => { const r = indexedDB.open('lapistock'); r.onsuccess = () => { const q = r.result.transaction('lapices').objectStore('lapices').getAll(); q.onsuccess = () => ok(q.result.map((l) => l.modelo)); }; })`);
const esperarHome = () => hasta(`!!document.querySelector('.home') && !document.querySelector('.splash')`, 10000);

async function main() {
  mkdirSync(CAPTURAS, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${URL_APP}api/health`)).ok) break;
    } catch { /* arrancando */ }
    await espera(250);
  }
  let url;
  for (let i = 0; i < 40 && !url; i++) {
    try {
      url = (await (await fetch('http://localhost:9555/json/list')).json()).find((o) => o.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* arrancando */ }
    if (!url) await espera(250);
  }
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { ok, ko } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? ko(new Error(m.error.message)) : ok(m.result);
    } else oyentes.forEach((f) => f(m));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });

  // 1. Primera publicación: la app se abre, el SW se instala y el usuario registra datos.
  let cargado = evento('Page.loadEventFired');
  await cdp('Page.navigate', { url: URL_APP });
  await cargado;
  await esperarHome();
  await hasta(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`, 10000);
  const vAnterior = await versionVisible();
  await evaluar(boton('Registrar nuevo lápiz'));
  await hasta(`!!document.querySelector('.modal form')`, 5000);
  await evaluar(setInput(campo('Marca'), 'Prismacolor'));
  await evaluar(setInput(campo('Modelo'), 'Dato del usuario'));
  await evaluar(setInput(campo('Cantidad'), '7'));
  await evaluar(`document.querySelector('.modal form').requestSubmit(), true`);
  await hasta(`!document.querySelector('.modal')`, 5000);
  await evaluar(`localStorage.setItem('lapistock:tema', JSON.stringify('oscuro')), true`).catch(() => {});
  await hasta(`document.querySelectorAll('.kpi__valor')[0]?.textContent === '6'`, 6000);
  await espera(600);
  await captura('17-version-anterior.png');
  const prefsAntes = await evaluar(`JSON.stringify(Object.keys(localStorage).sort())`);
  registrar('U1', 'Versión anterior publicada, SW activo y datos del usuario registrados', vAnterior !== '' && (await lapicesIdb()).includes('Dato del usuario'), `${vAnterior}`);

  // 2. Segunda publicación (nuevo build en el mismo origen).
  publicar(NUEVA);
  await evaluar(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
  const aviso = await hasta(`!!document.querySelector('.banda-actualizacion')`, 15000);
  const enEspera = await evaluar(`navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)`);
  await captura('18-aviso-actualizacion.png');
  registrar('U2', 'El Service Worker detecta la nueva versión y muestra «Actualizar»', aviso && enEspera, `aviso=${aviso}, SW nuevo en espera=${enEspera}`);

  // 3. El usuario pulsa «Actualizar» → SKIP_WAITING → controllerchange → recarga.
  cargado = evento('Page.loadEventFired');
  await evaluar(boton('Actualizar', '.banda-actualizacion button'));
  await cargado;
  await esperarHome();
  const vNueva = await versionVisible();
  const cachesActuales = await evaluar(`caches.keys()`);
  await hasta(`!document.querySelector('.banda-actualizacion')`, 5000);
  await captura('19-version-nueva.png');
  registrar('U3', 'Tras «Actualizar» se ejecuta la versión nueva y se borra la caché anterior', vNueva !== vAnterior && cachesActuales.filter((c) => c.startsWith('lapistock-app-')).length === 1, `${vAnterior} → ${vNueva}; cachés=${cachesActuales.join(', ')}`);

  // 4. Los datos locales se conservan.
  const modelos = await lapicesIdb();
  const prefsDespues = await evaluar(`JSON.stringify(Object.keys(localStorage).sort())`);
  registrar('U4', 'La versión actualizada conserva los datos locales (IndexedDB y localStorage)', modelos.includes('Dato del usuario') && prefsAntes === prefsDespues, `lápices en IndexedDB=${modelos.length} (incluye «Dato del usuario»), claves localStorage=${prefsDespues}`);

  // 5. La nueva funcionalidad está disponible.
  await evaluar(boton('Inventario', '.nav button'));
  const csv = await hasta(`[...document.querySelectorAll('.filtros button')].some((b) => b.textContent.includes('Exportar CSV'))`, 4000);
  await espera(300);
  await captura('20-nueva-funcion-csv.png');
  registrar('U5', 'La nueva funcionalidad (Exportar CSV) aparece en la versión nueva', csv);

  // 5b. La exportación genera un CSV válido (cabecera + una fila por lápiz, BOM UTF-8).
  const descargas = join(tmp, 'descargas');
  mkdirSync(descargas, { recursive: true });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: descargas });
  await evaluar(boton('Exportar CSV', '.filtros button'));
  let csvTexto = '';
  for (let i = 0; i < 40 && !csvTexto; i++) {
    await espera(150);
    const f = readdirSync(descargas).find((n) => n.endsWith('.csv'));
    if (f) csvTexto = readFileSync(join(descargas, f), 'utf8');
  }
  const conBom = csvTexto.charCodeAt(0) === 0xfeff;
  const lineas = csvTexto.slice(conBom ? 1 : 0).trim().split(/\r?\n/);
  const csvOk = conBom && lineas[0] === 'marca,modelo,tipo,dureza,color,cantidad,stock_minimo,precio' && lineas.length === 7 && csvTexto.includes('"Dato del usuario"');
  registrar('U5b', 'Exportar CSV descarga el inventario completo y correcto', csvOk, `${lineas.length - 1} filas; cabecera=${lineas[0]}`);

  // 6. Funciones anteriores en la versión nueva: búsqueda/filtro sobre los datos existentes + contador nuevo.
  await evaluar(setInput(`document.querySelector('.filtros input[type=search]')`, 'Dato del usuario'));
  const filtro = await hasta(`document.querySelectorAll('.tarjeta').length === 1 && document.querySelector('.conteo')?.textContent.includes('1 de 6')`, 4000);
  const conteo = await evaluar(`document.querySelector('.conteo')?.textContent ?? ''`);
  await captura('21-filtro-contador.png');
  registrar('U6', 'Funciones anteriores (búsqueda y filtros) siguen operando con los datos previos', filtro, conteo);
  await evaluar(setInput(`document.querySelector('.filtros input[type=search]')`, ''));

  // 7. Reversión: se vuelve a publicar el build anterior (rollback) y el SW lo trata como versión nueva.
  publicar(ANTERIOR);
  await evaluar(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
  const avisoR = await hasta(`!!document.querySelector('.banda-actualizacion')`, 15000);
  cargado = evento('Page.loadEventFired');
  await evaluar(boton('Actualizar', '.banda-actualizacion button'));
  await cargado;
  await esperarHome();
  // La app reabre en la última pestaña usada (Inventario); la versión se muestra en Inicio.
  await evaluar(boton('Inicio', '.nav button'));
  await hasta(`!!document.querySelector('.version')`, 4000);
  const vRevertida = await versionVisible();
  const modelosR = await lapicesIdb();
  const sinCsv = !(await evaluar(`document.body.textContent.includes('Exportar CSV')`));
  await captura('22-reversion.png');
  registrar('R1', 'Reversión: al republicar v1.0.0 el SW la detecta y la app vuelve a la versión anterior', avisoR && vRevertida === vAnterior && sinCsv, `${vNueva} → ${vRevertida}`);
  registrar('R2', 'Reversión: los datos locales se conservan', modelosR.includes('Dato del usuario'), `lápices en IndexedDB=${modelosR.length}`);
}

let codigo = 0;
try {
  await main();
} catch (e) {
  codigo = 1;
  registrar('ERR', 'Ejecución del escenario', false, e.message);
} finally {
  writeFileSync(join(RAIZ, 'pruebas', 'resultados-actualizacion.json'), JSON.stringify({ fecha: new Date().toISOString(), resultados }, null, 2));
  ws?.close();
  chrome.kill();
  api.kill();
  await espera(600);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch { /* Windows puede retener archivos */ }
  const fallas = resultados.filter((r) => r.resultado !== 'APROBADO').length;
  console.log(`\n${resultados.length - fallas}/${resultados.length} aprobadas`);
  process.exit(codigo || (fallas ? 1 : 0));
}
