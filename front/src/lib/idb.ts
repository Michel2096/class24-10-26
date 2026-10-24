import type { FotoLapiz, Lapiz, Movimiento, Operacion } from '../types';

/**
 * Envoltorio mínimo de IndexedDB (sin dependencias).
 *  - lapices:     copia local del inventario (incluye cambios aún no sincronizados)
 *  - movimientos: historial de entradas/salidas
 *  - outbox:      cola de operaciones pendientes de enviar al servidor
 *  - fotos:       fotos tomadas con la cámara (Blob JPEG), solo en este dispositivo (v2)
 */
const NOMBRE = 'lapistock';
const VERSION = 2;

interface Stores {
  lapices: Lapiz;
  movimientos: Movimiento;
  outbox: Operacion;
  fotos: FotoLapiz;
}
type Store = keyof Stores;

let conexion: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  conexion ??= new Promise((ok, falla) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Migración incremental: quien ya tenía la v1 conserva sus datos y solo recibe el store nuevo.
      if (e.oldVersion < 1) {
        db.createObjectStore('lapices', { keyPath: 'id' });
        const movs = db.createObjectStore('movimientos', { keyPath: 'id' });
        movs.createIndex('creado_en', 'creado_en');
        const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        outbox.createIndex('op_id', 'op_id', { unique: true });
      }
      if (e.oldVersion < 2) db.createObjectStore('fotos', { keyPath: 'lapiz_id' });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => falla(req.error);
  });
  return conexion;
}

const promesa = <T>(req: IDBRequest<T>) =>
  new Promise<T>((ok, falla) => {
    req.onsuccess = () => ok(req.result);
    req.onerror = () => falla(req.error);
  });

async function tx<S extends Store, T>(
  store: S,
  modo: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await abrir();
  return new Promise((ok, falla) => {
    const t = db.transaction(store, modo);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req ? req.result : undefined);
    t.onerror = () => falla(t.error);
    t.onabort = () => falla(t.error);
  });
}

export const idb = {
  abrir,
  async todos<S extends Store>(store: S): Promise<Stores[S][]> {
    const db = await abrir();
    return promesa(db.transaction(store).objectStore(store).getAll());
  },
  async obtener<S extends Store>(store: S, clave: IDBValidKey): Promise<Stores[S] | undefined> {
    const db = await abrir();
    return promesa(db.transaction(store).objectStore(store).get(clave));
  },
  guardar<S extends Store>(store: S, valor: Stores[S]) {
    return tx(store, 'readwrite', (s) => s.put(valor));
  },
  borrar(store: Store, clave: IDBValidKey) {
    return tx(store, 'readwrite', (s) => s.delete(clave));
  },
  /** Reemplaza todo el contenido de un store (usado al descargar datos frescos del servidor). */
  reemplazar<S extends Store>(store: S, valores: Stores[S][]) {
    return tx(store, 'readwrite', (s) => {
      s.clear();
      for (const v of valores) s.put(v);
    });
  },
};
