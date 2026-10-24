import webpush from 'web-push';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Notificaciones push reales (Web Push + VAPID).
 *
 * Las claves VAPID identifican a este servidor ante los servicios push de los navegadores
 * (FCM en Chrome/Edge, Mozilla autopush en Firefox, APNs en Safari). Se toman de
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY o, si no existen, se generan una vez y se guardan en
 * `archivoClaves` para que las suscripciones sigan siendo válidas tras reiniciar.
 */
export function crearPush(db, { archivoClaves, contacto = 'mailto:admin@lapistock.local' } = {}) {
  let claves;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    claves = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else if (archivoClaves && existsSync(archivoClaves)) {
    claves = JSON.parse(readFileSync(archivoClaves, 'utf8'));
  } else {
    claves = webpush.generateVAPIDKeys();
    if (archivoClaves) {
      mkdirSync(dirname(archivoClaves), { recursive: true });
      writeFileSync(archivoClaves, JSON.stringify(claves, null, 2));
    }
  }
  webpush.setVapidDetails(contacto, claves.publicKey, claves.privateKey);

  db.exec(`
    CREATE TABLE IF NOT EXISTS push_suscripciones (
      endpoint  TEXT PRIMARY KEY,             -- URL única del servicio push para ese navegador
      p256dh    TEXT NOT NULL,                -- clave pública del navegador (cifrado del mensaje)
      auth      TEXT NOT NULL,                -- secreto de autenticación
      creado_en TEXT NOT NULL
    );
  `);

  const q = {
    guardar: db.prepare(`
      INSERT INTO push_suscripciones (endpoint, p256dh, auth, creado_en) VALUES (:endpoint, :p256dh, :auth, :creado_en)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`),
    borrar: db.prepare('DELETE FROM push_suscripciones WHERE endpoint = ?'),
    todas: db.prepare('SELECT * FROM push_suscripciones'),
    contar: db.prepare('SELECT COUNT(*) AS total FROM push_suscripciones'),
  };

  return {
    clavePublica: claves.publicKey,
    suscribir: (s) => q.guardar.run({ ...s, creado_en: new Date().toISOString() }),
    desuscribir: (endpoint) => q.borrar.run(endpoint),
    total: () => q.contar.get().total,

    /** Envía `mensaje` a todas las suscripciones; borra las que el servicio push da por caducadas. */
    async enviar(mensaje) {
      const subs = q.todas.all();
      const r = await Promise.allSettled(
        subs.map((s) =>
          webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(mensaje), { TTL: 3600 }),
        ),
      );
      let enviadas = 0;
      r.forEach((res, i) => {
        if (res.status === 'fulfilled') enviadas++;
        else if ([404, 410].includes(res.reason?.statusCode)) q.borrar.run(subs[i].endpoint);
        else console.warn('[push] fallo al enviar:', res.reason?.statusCode ?? res.reason?.message);
      });
      return { enviadas, fallidas: subs.length - enviadas };
    },
  };
}
