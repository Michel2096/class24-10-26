import { lazy, Suspense, useEffect, useState } from 'react';
import { Logo } from './Logo';
import { VistaInicio, VistaInventario, VistaMovimientos, VistaResumen, VistaSync } from './vistas';
import { escribir, leer } from '../lib/preferencias';
import { aplicarActualizacion } from '../lib/sw';
import { useEstadoSW } from '../hooks/useEstadoSW';
import type { Inventario } from '../hooks/useInventario';
import type { Lapiz } from '../types';

export type Vista = 'inicio' | 'inventario' | 'movimientos' | 'resumen' | 'sync';
type Tema = 'sistema' | 'claro' | 'oscuro';

const NAV: { id: Vista; texto: string; icono: string }[] = [
  { id: 'inicio', texto: 'Inicio', icono: '⌂' },
  { id: 'inventario', texto: 'Inventario', icono: '✎' },
  { id: 'movimientos', texto: 'Movimientos', icono: '⇅' },
  { id: 'resumen', texto: 'Resumen', icono: '▤' },
  { id: 'sync', texto: 'Sync', icono: '⟳' },
];

// Carga diferida (mejora Lighthouse): el formulario y la cámara solo se descargan al abrirlos.
const LapizForm = lazy(() => import('./LapizForm').then((m) => ({ default: m.LapizForm })));

const VISTAS = NAV.map((n) => n.id);

/** Las notificaciones abren la app con `?vista=…`; se respeta y se limpia la URL. */
function vistaInicial(): Vista {
  const pedida = new URLSearchParams(location.search).get('vista') as Vista | null;
  if (pedida && VISTAS.includes(pedida)) {
    history.replaceState(null, '', location.pathname);
    escribir('vista', pedida);
    return pedida;
  }
  return leer('vista', 'inicio');
}

const TITULOS: Record<Vista, string> = {
  inicio: 'Panel principal',
  inventario: 'Inventario',
  movimientos: 'Entradas y salidas',
  resumen: 'Resumen del servidor',
  sync: 'Sincronización',
};

/** Home Screen: cabecera con estado de conexión, navegación por pestañas y acceso a todas las funciones. */
export function Home({ inv }: { inv: Inventario }) {
  const [vista, setVista] = useState<Vista>(vistaInicial);
  const sw = useEstadoSW();
  const [tema, setTema] = useState<Tema>(() => leer('tema', 'sistema'));
  const [form, setForm] = useState<{ abierto: boolean; lapiz?: Lapiz }>({ abierto: false });

  const ir = (v: Vista) => {
    setVista(v);
    escribir('vista', v);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (tema === 'sistema') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = tema === 'oscuro' ? 'dark' : 'light';
    escribir('tema', tema);
  }, [tema]);

  const siguienteTema: Record<Tema, Tema> = { sistema: 'claro', claro: 'oscuro', oscuro: 'sistema' };
  const pendientes = inv.cola.length;

  return (
    <div className="home">
      <header className="cabecera">
        <div className="cabecera__marca">
          <Logo size={36} />
          <div>
            <strong>LapiStock</strong>
            <small>{TITULOS[vista]}</small>
          </div>
        </div>
        <div className="cabecera__estado">
          <span className={`conexion ${inv.online ? 'conexion--on' : 'conexion--off'}`}>
            {inv.online ? 'En línea' : 'Sin conexión'}
          </span>
          {pendientes > 0 && (
            <button className="chip chip--pendiente" onClick={() => ir('sync')} title="Operaciones sin sincronizar">
              {pendientes} pendiente{pendientes > 1 ? 's' : ''}
            </button>
          )}
          <button className="btn-icono" onClick={() => setTema(siguienteTema[tema])} title={`Tema: ${tema}`} aria-label={`Cambiar tema (actual: ${tema})`}>
            {tema === 'oscuro' ? '☾' : tema === 'claro' ? '☀' : '◐'}
          </button>
        </div>
      </header>

      {!inv.online && (
        <div className="banda-offline" role="status">
          Modo sin conexión: puedes seguir registrando; los cambios se enviarán al recuperar la red.
        </div>
      )}

      {sw.estado === 'actualizacion' && (
        <div className="banda-actualizacion" role="status">
          <span>Hay una nueva versión de LapiStock.</span>
          <button className="btn btn--chico" onClick={aplicarActualizacion}>
            Actualizar
          </button>
        </div>
      )}

      <main className="contenido">
        {vista === 'inicio' && <VistaInicio inv={inv} ir={ir} onNuevo={() => setForm({ abierto: true })} />}
        {vista === 'inventario' && (
          <VistaInventario inv={inv} onNuevo={() => setForm({ abierto: true })} onEditar={(l) => setForm({ abierto: true, lapiz: l })} />
        )}
        {vista === 'movimientos' && <VistaMovimientos inv={inv} />}
        {vista === 'resumen' && <VistaResumen inv={inv} />}
        {vista === 'sync' && <VistaSync inv={inv} />}
      </main>

      <nav className="nav" aria-label="Secciones">
        {NAV.map((n) => (
          <button key={n.id} className={vista === n.id ? 'activo' : ''} aria-current={vista === n.id ? 'page' : undefined} onClick={() => ir(n.id)}>
            <span aria-hidden="true">{n.icono}</span>
            {n.texto}
            {n.id === 'sync' && pendientes > 0 && <i className="nav__punto" />}
          </button>
        ))}
      </nav>

      {form.abierto && (
        <Suspense fallback={null}>
          <LapizForm
            inicial={form.lapiz}
            fotoInicial={form.lapiz && inv.fotos[form.lapiz.id]}
            onCerrar={() => setForm({ abierto: false })}
            onGuardar={(datos, foto) => (form.lapiz ? inv.editarLapiz(form.lapiz.id, datos, foto) : inv.crearLapiz(datos, foto))}
          />
        </Suspense>
      )}
    </div>
  );
}
