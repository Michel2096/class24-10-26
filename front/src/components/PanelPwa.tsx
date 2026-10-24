import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { EstadoSW } from '../lib/sw';
import { useEstadoSW } from '../hooks/useEstadoSW';
import {
  desuscribirPush,
  notificarLocal,
  pedirPermiso,
  permisoActual,
  soportaPush,
  suscribirPush,
  suscripcionPush,
  type Permiso,
} from '../lib/notificaciones';

const TEXTO_SW: Record<EstadoSW, string> = {
  'no-soportado': 'No soportado por este navegador',
  desactivado: 'Desactivado en modo desarrollo (usa npm run build && npm start)',
  registrando: 'Registrando…',
  activo: 'Activo y controlando la app',
  actualizacion: 'Hay una versión nueva en espera',
  error: 'Error al registrar',
};

const TEXTO_PERMISO: Record<Permiso, string> = {
  granted: 'Concedido',
  denied: 'Bloqueado (cámbialo en la configuración del sitio)',
  default: 'Sin decidir',
  'no-soportado': 'No soportado',
};

/** Aviso estándar para funciones que dependen del servidor. */
export function RequiereConexion({ online, texto }: { online: boolean; texto: string }) {
  if (online) return null;
  return (
    <p className="alerta alerta--aviso" role="status">
      📡 {texto}
    </p>
  );
}

/** Estado del Service Worker, permisos y controles de notificaciones (locales y push). */
export function PanelPwa({ online }: { online: boolean }) {
  const sw = useEstadoSW();
  const [permiso, setPermiso] = useState<Permiso>(permisoActual);
  const [push, setPush] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);

  useEffect(() => {
    suscripcionPush().then((s) => setPush(!!s));
  }, [sw.estado]);

  async function accion(fn: () => Promise<string>) {
    setOcupado(true);
    setMensaje(null);
    try {
      setMensaje({ ok: true, texto: await fn() });
    } catch (e) {
      setMensaje({ ok: false, texto: e instanceof Error ? e.message : String(e) });
    } finally {
      setPermiso(permisoActual());
      setOcupado(false);
    }
  }

  const activarLocales = () =>
    accion(async () => {
      const p = await pedirPermiso();
      if (p !== 'granted') throw new Error(p === 'denied' ? 'Permiso denegado: no se mostrarán avisos' : 'Permiso no concedido');
      await notificarLocal('Notificaciones activadas', 'Te avisaremos cuando un lápiz quede en bajo stock.', { etiqueta: 'prueba' });
      return 'Permiso concedido. Se mostró una notificación de prueba.';
    });

  const probarLocal = () =>
    accion(async () => {
      if (!(await notificarLocal('Prueba local', 'Esta notificación la generó la app, sin servidor.', { etiqueta: 'prueba' })))
        throw new Error('No se pudo mostrar: revisa el permiso');
      return 'Notificación local mostrada.';
    });

  const alternarPush = () =>
    accion(async () => {
      if (push) {
        await desuscribirPush();
        setPush(false);
        return 'Suscripción push eliminada.';
      }
      await suscribirPush();
      setPush(true);
      return 'Suscrito: el servidor avisará de bajo stock aunque la app esté cerrada.';
    });

  const probarPush = () =>
    accion(async () => {
      const r = await api.pushPrueba();
      if (!r.enviadas) throw new Error('El servidor no pudo entregar ninguna notificación');
      return `El servidor envió ${r.enviadas} notificación(es) push.`;
    });

  return (
    <div className="panel panel-pwa">
      <h3>App y notificaciones</h3>
      <dl className="estado-pwa">
        <dt>Service Worker</dt>
        <dd className={sw.estado === 'activo' ? 'ok' : sw.estado === 'error' ? 'mal' : ''}>
          {TEXTO_SW[sw.estado]}
          {sw.error ? ` · ${sw.error}` : ''}
        </dd>
        <dt>Permiso de notificaciones</dt>
        <dd className={permiso === 'granted' ? 'ok' : permiso === 'denied' ? 'mal' : ''}>{TEXTO_PERMISO[permiso]}</dd>
        <dt>Push del servidor</dt>
        <dd className={push ? 'ok' : ''}>{!soportaPush() ? 'No soportado' : push ? 'Suscrito' : 'No suscrito'}</dd>
      </dl>
      <p className="nota">
        Avisos locales: bajo stock tras una salida (también sin conexión) y cuando se sincronizan los cambios hechos offline.
      </p>
      <div className="acciones acciones--izq">
        {permiso !== 'granted' ? (
          <button className="btn btn--chico" onClick={activarLocales} disabled={ocupado || permiso === 'no-soportado' || permiso === 'denied'}>
            Activar notificaciones
          </button>
        ) : (
          <button className="btn btn--chico btn--fantasma" onClick={probarLocal} disabled={ocupado}>
            Probar notificación local
          </button>
        )}
        {soportaPush() && (
          <button className="btn btn--chico btn--fantasma" onClick={alternarPush} disabled={ocupado || !online || sw.estado !== 'activo'}>
            {push ? 'Desactivar push' : 'Activar push'}
          </button>
        )}
        {push && (
          <button className="btn btn--chico btn--fantasma" onClick={probarPush} disabled={ocupado || !online}>
            Enviar push de prueba
          </button>
        )}
      </div>
      <RequiereConexion online={online} texto="Activar push y enviar pruebas requiere conexión con el servidor. Los avisos locales sí funcionan offline." />
      {mensaje && <p className={`alerta ${mensaje.ok ? 'alerta--ok' : 'alerta--error'}`}>{mensaje.texto}</p>}
    </div>
  );
}
