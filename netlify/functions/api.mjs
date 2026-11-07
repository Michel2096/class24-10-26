// Netlify Function que ejecuta la misma API Express de api/src/app.js.
//
// Netlify sirve el front (front/dist) desde su CDN y redirige /api/* a esta función
// (ver netlify.toml). La base SQLite vive en /tmp, el único directorio escribible de la
// función: se crea y se siembra con datos de ejemplo en cada arranque en frío. Es suficiente
// para la demostración; los datos del usuario se conservan en IndexedDB del dispositivo.
import serverless from 'serverless-http';
import { openDb } from '../../api/src/db.js';
import { createApp } from '../../api/src/app.js';
import { sembrar } from '../../api/src/seed.js';
import { crearPush } from '../../api/src/push.js';

const db = openDb(process.env.DB_FILE || '/tmp/inventario.db');
sembrar(db);
// Claves VAPID: definir VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en Netlify para que sean estables.
const push = crearPush(db, { archivoClaves: '/tmp/vapid.json' });

// La CDN de Netlify ya comprime las respuestas (gzip/brotli).
const app = createApp(db, { push, comprimir: false });

export const handler = serverless(app, {
  // Según cómo llegue la petición, la ruta puede venir como /.netlify/functions/api/... o /api/...
  request(req) {
    req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
    // serverless-http entrega el cuerpo ya leído (Buffer) y express.json() lo omite: se parsea aquí.
    if (Buffer.isBuffer(req.body)) {
      const texto = req.body.toString('utf8');
      if (!texto) req.body = undefined;
      else if (/json/i.test(req.headers['content-type'] ?? '')) {
        try {
          req.body = JSON.parse(texto);
        } catch {
          req.body = undefined; // la API responderá 400 por datos inválidos
        }
      }
    }
  },
});
