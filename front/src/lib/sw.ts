/**
 * Registro y ciclo de vida del Service Worker.
 *
 *  instalando → activo                       (primera visita)
 *  activo → actualización disponible → recarga (cuando se publica un build nuevo)
 *
 * Una versión nueva queda «en espera» (sw.js ya no llama a skipWaiting por su cuenta). La app
 * avisa al usuario y, si acepta, envía SKIP_WAITING; al cambiar el controlador se recarga.
 */
export type EstadoSW = 'no-soportado' | 'desactivado' | 'registrando' | 'activo' | 'actualizacion' | 'error';

interface Snapshot {
  estado: EstadoSW;
  alcance?: string;
  error?: string;
}

let snapshot: Snapshot = { estado: !('serviceWorker' in navigator) ? 'no-soportado' : import.meta.env.PROD ? 'registrando' : 'desactivado' };
let enEspera: ServiceWorker | null = null;
const oyentes = new Set<() => void>();

function fijar(s: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...s };
  oyentes.forEach((f) => f());
}

export const swStore = {
  suscribir(cb: () => void) {
    oyentes.add(cb);
    return () => oyentes.delete(cb);
  },
  leer: () => snapshot,
};

/** Activa la versión en espera; la página se recarga sola al recibir el nuevo controlador. */
export function aplicarActualizacion() {
  enEspera?.postMessage({ tipo: 'SKIP_WAITING' });
}

function vigilar(reg: ServiceWorkerRegistration) {
  // Ya había una versión esperando (p. ej. el usuario cerró el aviso y recargó).
  if (reg.waiting && navigator.serviceWorker.controller) {
    enEspera = reg.waiting;
    fijar({ estado: 'actualizacion' });
  }
  reg.addEventListener('updatefound', () => {
    const nuevo = reg.installing;
    nuevo?.addEventListener('statechange', () => {
      if (nuevo.state !== 'installed') return;
      if (navigator.serviceWorker.controller) {
        enEspera = nuevo;
        fijar({ estado: 'actualizacion' });
      } else {
        fijar({ estado: 'activo' }); // primera instalación: no hay nada que reemplazar
      }
    });
  });
}

export function registrarServiceWorker() {
  // Solo en el build de producción: en `npm run dev` Vite sirve módulos sin empaquetar y
  // cachearlos rompería el recargado en caliente.
  if (snapshot.estado !== 'registrando') return;

  let recargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recargando || !enEspera) return;
    recargando = true;
    location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.info('[SW] registrado con alcance', reg.scope);
      vigilar(reg);
      await navigator.serviceWorker.ready;
      if (snapshot.estado === 'registrando') fijar({ estado: 'activo', alcance: reg.scope });
      else fijar({ alcance: reg.scope });
      // Buscar versiones nuevas al volver a la app y cada hora.
      const comprobar = () => navigator.onLine && reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && comprobar());
      setInterval(comprobar, 60 * 60 * 1000);
    } catch (err) {
      console.error('[SW] error al registrar', err);
      fijar({ estado: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  });
}
