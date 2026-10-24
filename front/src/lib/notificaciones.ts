import { api } from './api';

/**
 * Notificaciones.
 *  - Locales: las genera la propia app (no necesitan red). Se muestran con
 *    `registration.showNotification` para que funcionen también en Android, donde
 *    `new Notification()` no está permitido; si no hay Service Worker se usa el constructor.
 *  - Push (ampliación): el servidor las envía a través del servicio push del navegador,
 *    aunque la app esté cerrada. Requieren conexión para suscribirse y HTTPS (o localhost).
 */
export const soportaNotificaciones = () => 'Notification' in window;
export const soportaPush = () => 'serviceWorker' in navigator && 'PushManager' in window && soportaNotificaciones();

export type Permiso = NotificationPermission | 'no-soportado';
export const permisoActual = (): Permiso => (soportaNotificaciones() ? Notification.permission : 'no-soportado');

/** Debe llamarse desde un gesto del usuario (clic): los navegadores bloquean la petición automática. */
export async function pedirPermiso(): Promise<Permiso> {
  if (!soportaNotificaciones()) return 'no-soportado';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export interface OpcionesAviso {
  etiqueta?: string;
  url?: string;
}

/** Muestra una notificación local si hay permiso. Devuelve false si no se pudo mostrar. */
export async function notificarLocal(titulo: string, cuerpo: string, { etiqueta, url = '/' }: OpcionesAviso = {}): Promise<boolean> {
  if (permisoActual() !== 'granted') return false;
  const opciones: NotificationOptions = { body: cuerpo, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: etiqueta, data: { url } };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg?.active) {
      await reg.showNotification(titulo, opciones);
    } else {
      new Notification(titulo, opciones);
    }
    return true;
  } catch (e) {
    console.warn('[notificaciones] no se pudo mostrar', e);
    return false;
  }
}

/* ───── Push ───── */

/** La clave VAPID llega en base64url; PushManager la necesita como bytes. */
function base64UrlABytes(b64: string) {
  const relleno = '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob((b64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function registro() {
  if (!soportaPush()) throw new Error('Este navegador no soporta notificaciones push');
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.active) throw new Error('El Service Worker no está activo (usa el build de producción)');
  return reg;
}

export async function suscripcionPush(): Promise<PushSubscription | null> {
  if (!soportaPush()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function suscribirPush() {
  if (!navigator.onLine) throw new Error('Necesitas conexión para activar las notificaciones push');
  if ((await pedirPermiso()) !== 'granted') throw new Error('Permiso de notificaciones denegado');
  const reg = await registro();
  const { clave } = await api.clavePush();
  let sub = await reg.pushManager.getSubscription();
  // Si el servidor cambió de claves VAPID, la suscripción vieja ya no sirve.
  const actual = sub?.options.applicationServerKey;
  if (sub && actual && btoa(String.fromCharCode(...new Uint8Array(actual))) !== btoa(String.fromCharCode(...base64UrlABytes(clave)))) {
    await sub.unsubscribe();
    sub = null;
  }
  // subscribe() contacta al servicio push del navegador (FCM, autopush…); si está bloqueado
  // (red corporativa, navegador sin servicios de Google, modo headless) nunca responde.
  sub ??= await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlABytes(clave) }),
    new Promise<never>((_, falla) => setTimeout(() => falla(new Error('El servicio push del navegador no respondió (¿bloqueado por la red?)')), 15000)),
  ]);
  await api.suscribirPush(sub.toJSON());
  return sub;
}

export async function desuscribirPush() {
  const sub = await suscripcionPush();
  if (!sub) return;
  await sub.unsubscribe();
  await api.desuscribirPush(sub.endpoint).catch(() => {
    /* sin red: el servidor la borrará cuando el servicio push responda 410 */
  });
}
