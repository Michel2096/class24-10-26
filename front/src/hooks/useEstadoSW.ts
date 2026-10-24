import { useSyncExternalStore } from 'react';
import { swStore } from '../lib/sw';

/** Estado del Service Worker (registrando, activo, actualización en espera…). */
export const useEstadoSW = () => useSyncExternalStore(swStore.suscribir, swStore.leer);
